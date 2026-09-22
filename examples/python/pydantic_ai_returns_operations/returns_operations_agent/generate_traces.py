"""Run the extended corpus with resumable state and optional Langfuse export."""

import argparse
import asyncio
import json
import os
import time
import uuid
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from filelock import FileLock
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models import infer_model
from pydantic_ai.usage import UsageLimits

from returns_operations_agent.agent import (
    DEFAULT_MODEL,
    _get_model_settings,
    build_agent,
    build_prompt,
    normalize_model_name,
)
from returns_operations_agent.fixtures import (
    CASES,
    DISCOVERY_CASES,
    HELD_OUT_CASES,
)
from returns_operations_agent.models import TicketInput
from returns_operations_agent.store import MockCommerceStore

REQUEST_OPTIONS = {"timeout_in_seconds": 30, "max_retries": 3}
REDACTED_EXPORT_FIELDS = {
    "gen_ai.agent.call.id",
    "gen_ai.conversation.id",
    "gen_ai.response.id",
    "htmlPath",
    "modelId",
    "projectId",
    "public_key",
    "service.instance.id",
    "usagePricingTierId",
    "usagePricingTierName",
}
TerminalStatus = Literal["completed", "exported", "failed", "ambiguous"]


class EpisodeEvent(BaseModel):
    """One durable state transition for a model episode."""

    schema_version: int = 1
    batch_id: str
    episode_id: str
    attempt_id: str
    ticket_id: str
    scenario_id: str
    variant: str
    split: str
    status: Literal[
        "running", "generated", "completed", "exported", "failed", "ambiguous"
    ]
    model: str
    trace_backend: Literal["none", "langfuse"] = "none"
    langfuse_session_id: str | None = None
    trace_id: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    output: dict[str, Any] | None = None
    usage: dict[str, int] | None = None
    error_type: str | None = None
    error_message: str | None = None


class BatchSummary(BaseModel):
    """Machine-readable summary emitted after one corpus run."""

    batch_id: str
    model: str
    trace_backend: str
    expected: int
    succeeded: int
    failed: int
    ambiguous: int
    skipped: int
    manifest_path: str
    export_path: str | None = None
    failures: list[str] = Field(default_factory=list)


def _utc_now() -> datetime:
    """Return an aware UTC timestamp."""
    return datetime.now(UTC)


def _sanitize_export(value: Any) -> Any:
    """Remove credential-shaped telemetry fields from an exported trace."""
    if isinstance(value, dict):
        return {
            key: _sanitize_export(item)
            for key, item in value.items()
            if key not in REDACTED_EXPORT_FIELDS
        }
    if isinstance(value, list):
        return [_sanitize_export(item) for item in value]
    return value


def _get_trace(client: Any, trace_id: str) -> Any:
    """Wait until one flushed trace has a complete observation graph."""
    deadline = time.monotonic() + 180
    previous_count: int | None = None
    while True:
        try:
            trace = client.api.trace.get(trace_id, request_options=REQUEST_OPTIONS)
            observation_ids = {item.id for item in trace.observations}
            roots = [
                item
                for item in trace.observations
                if item.parent_observation_id is None
                or item.parent_observation_id not in observation_ids
            ]
            roots_have_ended = bool(roots) and all(
                item.end_time is not None for item in roots
            )
            observations_have_ended = bool(trace.observations) and all(
                item.end_time is not None for item in trace.observations
            )
            graph_is_closed = all(
                item.parent_observation_id is None
                or item.parent_observation_id in observation_ids
                for item in trace.observations
            )
            observation_count = len(trace.observations)
            if (
                observation_count == previous_count
                and roots_have_ended
                and observations_have_ended
                and graph_is_closed
            ):
                return trace
            previous_count = observation_count
        except Exception:
            previous_count = None
            if time.monotonic() >= deadline:
                raise
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Langfuse trace {trace_id} was not queryable after 180 seconds."
            )
        time.sleep(2)


def _get_trace_id(result: Any) -> str:
    """Extract the Langfuse trace ID retained by an instrumented agent run."""
    traceparent = result._traceparent()  # noqa: SLF001
    parts = traceparent.split("-")
    if len(parts) != 4 or len(parts[1]) != 32:
        raise RuntimeError("PydanticAI returned an invalid trace context.")
    return parts[1]


def _get_usage(result: Any) -> dict[str, int]:
    """Extract stable usage counters from a PydanticAI result."""
    usage = result.usage
    if callable(usage):
        usage = usage()
    fields = (
        "requests",
        "tool_calls",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
    )
    return {
        field: value
        for field in fields
        if isinstance((value := getattr(usage, field, None)), int)
    }


def _select_cases(split: str) -> tuple[TicketInput, ...]:
    """Return the requested reviewed corpus partition."""
    if split == "discovery":
        return DISCOVERY_CASES
    if split == "heldout":
        return HELD_OUT_CASES
    return CASES


def _episode_parts(ticket: TicketInput) -> tuple[str, str, str]:
    """Derive stable scenario, variant, and split labels."""
    scenario_id, _, variant = ticket.ticket_id.rpartition("-")
    split = "heldout" if variant == "c" else "discovery"
    return scenario_id, variant, split


def _load_latest_events(path: Path) -> dict[str, EpisodeEvent]:
    """Load the latest valid event for every episode."""
    try:
        stream = path.open(encoding="utf-8")
    except FileNotFoundError:
        return {}
    latest: dict[str, EpisodeEvent] = {}
    with stream:
        line_number = 0
        line = stream.readline()
        while line:
            line_number += 1
            next_line = stream.readline()
            if not line.strip():
                line = next_line
                continue
            try:
                event = EpisodeEvent.model_validate_json(line)
            except Exception as exc:
                if not next_line and not line.endswith("\n"):
                    break
                raise ValueError(
                    f"Manifest {path} has an invalid event on line {line_number}."
                ) from exc
            latest[event.episode_id] = event
            line = next_line
    return latest


def _require_environment(model: str, trace_backend: str) -> None:
    """Require only credentials used by the selected run configuration."""
    required = [
        "OPENROUTER_API_KEY" if model.startswith("openrouter:") else "OPENAI_API_KEY"
    ]
    if trace_backend == "langfuse":
        required.extend(("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"))
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"Set {', '.join(missing)} before continuing.")


async def _append_event(path: Path, event: EpisodeEvent, lock: asyncio.Lock) -> None:
    """Append one state transition while serializing concurrent writers."""
    line = event.model_dump_json() + "\n"
    async with lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(_append_text, path, line)


def _append_text(path: Path, value: str) -> None:
    """Append and flush one manifest record."""
    with path.open("a+b") as stream:
        stream.seek(0)
        content = stream.read()
        if content and not content.endswith(b"\n"):
            last_newline = content.rfind(b"\n")
            tail = content[last_newline + 1 :]
            try:
                EpisodeEvent.model_validate_json(tail)
            except Exception:
                stream.truncate(last_newline + 1)
            else:
                stream.seek(0, os.SEEK_END)
                stream.write(b"\n")
        stream.seek(0, os.SEEK_END)
        stream.write(value.encode())
        stream.flush()
        os.fsync(stream.fileno())


def _write_trace_cache(path: Path, document: dict[str, Any]) -> None:
    """Atomically write one sanitized trace document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(document), encoding="utf-8")
    os.replace(temporary, path)


def _write_export(
    export_path: Path, cases: tuple[TicketInput, ...], trace_dir: Path
) -> int:
    """Rebuild a deterministic JSONL export from episode trace files."""
    export_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = export_path.with_suffix(".tmp")
    count = 0
    with temporary.open("w", encoding="utf-8") as stream:
        for ticket in cases:
            path = trace_dir / f"{ticket.ticket_id}.json"
            try:
                document = json.loads(path.read_text())
            except FileNotFoundError:
                continue
            stream.write(json.dumps(document))
            stream.write("\n")
            count += 1
    os.replace(temporary, export_path)
    return count


async def generate(args: argparse.Namespace) -> BatchSummary:
    """Run or resume a bounded corpus generation batch."""
    model_name = args.model or os.environ.get("RETURNS_MODEL", str(DEFAULT_MODEL))
    model = normalize_model_name(model_name)
    resolved_model = infer_model(model)
    model_settings = _get_model_settings(model)
    _require_environment(model_name, args.trace_backend)
    cases = _select_cases(args.split)
    if args.case_offset:
        cases = cases[args.case_offset :]
    if args.case_limit is not None:
        cases = cases[: args.case_limit]
    if not cases:
        raise ValueError("The selected corpus is empty.")

    manifest_path: Path = args.manifest
    if args.fresh and manifest_path.exists():
        raise ValueError(f"Fresh run refused to overwrite {manifest_path}.")
    latest = _load_latest_events(manifest_path)
    for event in latest.values():
        if (
            event.batch_id != args.batch_id
            or event.model != model_name
            or event.trace_backend != args.trace_backend
        ):
            raise ValueError(
                "Existing manifest batch, model, or trace backend does not match this run."
            )

    langfuse = None
    propagate_attributes: Any = None
    if args.trace_backend == "langfuse":
        from langfuse import Langfuse
        from langfuse import propagate_attributes as propagate

        Agent.instrument_all()
        langfuse = Langfuse()
        propagate_attributes = propagate

    write_lock = asyncio.Lock()
    trace_lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(args.concurrency)
    trace_dir = manifest_path.parent / f"{manifest_path.stem}-traces"
    skipped = 0

    async def export_generated(ticket: TicketInput, event: EpisodeEvent) -> None:
        if langfuse is None or event.trace_id is None:
            raise RuntimeError("Generated event is missing Langfuse trace context.")
        async with trace_lock:
            await asyncio.to_thread(langfuse.flush)
        trace = await asyncio.to_thread(_get_trace, langfuse, event.trace_id)
        document = trace.model_dump(mode="json", by_alias=True)
        document["input"] = ticket.model_dump(mode="json")
        document["output"] = event.output
        await asyncio.to_thread(
            _write_trace_cache,
            trace_dir / f"{ticket.ticket_id}.json",
            _sanitize_export(document),
        )
        await _append_event(
            manifest_path,
            event.model_copy(update={"status": "exported", "finished_at": _utc_now()}),
            write_lock,
        )

    async def try_export_generated(ticket: TicketInput, event: EpisodeEvent) -> None:
        """Export a generated episode while preserving its resumable checkpoint."""
        try:
            await export_generated(ticket, event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await _append_event(
                manifest_path,
                event.model_copy(
                    update={
                        "error_type": type(exc).__name__,
                        "error_message": str(exc)[:500],
                    }
                ),
                write_lock,
            )

    async def run_episode(ticket: TicketInput) -> None:
        nonlocal skipped
        scenario_id, variant, split = _episode_parts(ticket)
        episode_id = f"{args.batch_id}:{ticket.ticket_id}"
        previous = latest.get(episode_id)
        if previous is not None:
            if previous.status in {"completed", "exported"}:
                skipped += 1
                return
            if previous.status == "generated" and args.trace_backend == "langfuse":
                await try_export_generated(ticket, previous)
                return
            if previous.status == "running":
                await _append_event(
                    manifest_path,
                    previous.model_copy(
                        update={
                            "status": "ambiguous",
                            "finished_at": _utc_now(),
                            "error_type": "InterruptedAttempt",
                            "error_message": "A prior provider call may have completed.",
                        }
                    ),
                    write_lock,
                )
                if not args.retry_ambiguous:
                    return
            if previous.status == "failed" and not args.retry_failed:
                return
            if previous.status == "ambiguous" and not args.retry_ambiguous:
                return

        async with semaphore:
            attempt_id = uuid.uuid4().hex
            started_at = _utc_now()
            session_id = f"extended-returns:{episode_id}:{attempt_id}"
            running = EpisodeEvent(
                batch_id=args.batch_id,
                episode_id=episode_id,
                attempt_id=attempt_id,
                ticket_id=ticket.ticket_id,
                scenario_id=scenario_id,
                variant=variant,
                split=split,
                status="running",
                model=model_name,
                trace_backend=args.trace_backend,
                langfuse_session_id=(
                    session_id if args.trace_backend == "langfuse" else None
                ),
                started_at=started_at,
            )
            await _append_event(manifest_path, running, write_lock)
            provider_started = False
            try:
                context = (
                    propagate_attributes(
                        session_id=session_id,
                        trace_name=f"Extended returns: {ticket.ticket_id}",
                        environment="extended-returns-demo",
                        version="baseline-v1",
                        tags=["extended-returns", split],
                        metadata={
                            "batch_id": args.batch_id,
                            "episode_id": episode_id,
                            "attempt_id": attempt_id,
                            "ticket_id": ticket.ticket_id,
                            "scenario_id": scenario_id,
                            "variant": variant,
                            "model": model_name,
                        },
                    )
                    if propagate_attributes is not None
                    else nullcontext()
                )
                with context:
                    provider_call = build_agent(
                        MockCommerceStore(),
                        resolved_model,
                        model_settings=model_settings,
                    ).run(
                        build_prompt(ticket),
                        usage_limits=UsageLimits(request_limit=args.request_limit),
                    )
                    provider_started = True
                    result = await asyncio.wait_for(
                        provider_call,
                        timeout=args.episode_timeout,
                    )
                generated = running.model_copy(
                    update={
                        "status": (
                            "generated"
                            if args.trace_backend == "langfuse"
                            else "completed"
                        ),
                        "trace_id": (
                            _get_trace_id(result)
                            if args.trace_backend == "langfuse"
                            else None
                        ),
                        "finished_at": _utc_now(),
                        "output": result.output.model_dump(mode="json"),
                        "usage": _get_usage(result),
                    }
                )
                await _append_event(manifest_path, generated, write_lock)
                if args.trace_backend == "langfuse":
                    await try_export_generated(ticket, generated)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failure = running.model_copy(
                    update={
                        "status": "ambiguous" if provider_started else "failed",
                        "finished_at": _utc_now(),
                        "error_type": type(exc).__name__,
                        "error_message": str(exc)[:500],
                    }
                )
                await _append_event(manifest_path, failure, write_lock)

    await asyncio.gather(*(run_episode(ticket) for ticket in cases))
    if langfuse is not None:
        await asyncio.to_thread(langfuse.flush)

    latest = _load_latest_events(manifest_path)
    selected = [latest.get(f"{args.batch_id}:{ticket.ticket_id}") for ticket in cases]
    success_statuses: set[TerminalStatus] = (
        {"exported"} if args.trace_backend == "langfuse" else {"completed"}
    )
    succeeded = sum(
        event is not None and event.status in success_statuses for event in selected
    )
    failed_statuses = {"failed"}
    if args.trace_backend == "langfuse":
        failed_statuses.add("generated")
    failed_count = sum(
        event is None or event.status in failed_statuses for event in selected
    )
    ambiguous_count = sum(
        event is not None and event.status == "ambiguous" for event in selected
    )
    failure_ids = [
        (
            event.episode_id
            if event is not None
            else f"{args.batch_id}:{ticket.ticket_id}"
        )
        for ticket, event in zip(cases, selected, strict=True)
        if event is None or event.status in failed_statuses | {"ambiguous"}
    ]
    export_path = args.output if args.trace_backend == "langfuse" else None
    if export_path is not None:
        exported = _write_export(export_path, cases, trace_dir)
        if exported != succeeded:
            raise RuntimeError(
                f"Export contains {exported} traces but manifest has {succeeded} successes."
            )
    return BatchSummary(
        batch_id=args.batch_id,
        model=model_name,
        trace_backend=args.trace_backend,
        expected=len(cases),
        succeeded=succeeded,
        failed=failed_count,
        ambiguous=ambiguous_count,
        skipped=skipped,
        manifest_path=str(manifest_path),
        export_path=str(export_path) if export_path is not None else None,
        failures=failure_ids,
    )


def _get_args() -> argparse.Namespace:
    """Parse corpus generation options."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("traces/generated-langfuse-traces.jsonl"),
        help="Langfuse JSONL export destination.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("runs/extended-returns-events.jsonl"),
        help="Append-only episode state used for checkpoint and resume.",
    )
    parser.add_argument(
        "--batch-id",
        default="extended-returns-v1",
        help="Stable logical batch ID; change it for a new corpus run.",
    )
    parser.add_argument("--model", help="PydanticAI model string.")
    parser.add_argument("--trace-backend", choices=("none", "langfuse"), default="none")
    parser.add_argument(
        "--split", choices=("all", "discovery", "heldout"), default="all"
    )
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--case-offset", type=int, default=0)
    parser.add_argument("--case-limit", type=int)
    parser.add_argument("--request-limit", type=int, default=8)
    parser.add_argument("--episode-timeout", type=float, default=180)
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument(
        "--retry-ambiguous",
        action="store_true",
        help="Repeat provider attempts that may already have completed and incur cost.",
    )
    parser.add_argument("--fresh", action="store_true")
    args = parser.parse_args()
    if args.concurrency < 1 or args.request_limit < 1 or args.episode_timeout <= 0:
        parser.error(
            "Concurrency, request limit, and episode timeout must be positive."
        )
    if args.case_offset < 0:
        parser.error("Case offset must not be negative.")
    if args.case_limit is not None and args.case_limit < 1:
        parser.error("Case limit must be positive.")
    return args


def _main() -> int:
    """Run generation and return a process exit code."""
    args = _get_args()
    lock_path = args.manifest.with_suffix(f"{args.manifest.suffix}.lock")
    with FileLock(lock_path, timeout=0):
        summary = asyncio.run(generate(args))
    print(summary.model_dump_json())
    return 0 if summary.failed == 0 and summary.ambiguous == 0 else 1


if __name__ == "__main__":
    raise SystemExit(_main())
