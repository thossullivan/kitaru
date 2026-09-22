"""Provider-free tests for resumable corpus generation helpers."""

import argparse
import asyncio
import json
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from returns_operations_agent.fixtures import CASES
from returns_operations_agent.generate_traces import (
    REDACTED_EXPORT_FIELDS,
    EpisodeEvent,
    _append_text,
    _episode_parts,
    _get_trace,
    _get_usage,
    _load_latest_events,
    _sanitize_export,
    _select_cases,
    _write_export,
    generate,
)


def _event(ticket_id: str, status: str, attempt_id: str) -> EpisodeEvent:
    """Create one manifest event for helper tests."""
    scenario_id, variant, split = _episode_parts(
        next(case for case in CASES if case.ticket_id == ticket_id)
    )
    return EpisodeEvent(
        batch_id="batch-1",
        episode_id=f"batch-1:{ticket_id}",
        attempt_id=attempt_id,
        ticket_id=ticket_id,
        scenario_id=scenario_id,
        variant=variant,
        split=split,
        status=status,
        model="openai:gpt-5-nano",
        started_at=datetime.now(UTC),
    )


def test_splits_preserve_complete_scenarios() -> None:
    """Keep held-out phrasings separate from the discovery corpus."""
    assert len(_select_cases("all")) == 36
    assert len(_select_cases("discovery")) == 24
    assert len(_select_cases("heldout")) == 12
    assert all(case.ticket_id.endswith("-c") for case in _select_cases("heldout"))


def test_manifest_uses_last_event_and_rejects_corruption(tmp_path: Path) -> None:
    """Treat the append-only log as a checkpoint with explicit corruption."""
    path = tmp_path / "events.jsonl"
    running = _event("partial-defect-a", "running", "attempt-1")
    completed = running.model_copy(update={"status": "completed"})
    path.write_text(f"{running.model_dump_json()}\n{completed.model_dump_json()}\n")

    latest = _load_latest_events(path)

    assert latest[running.episode_id].status == "completed"
    path.write_text(path.read_text() + "not-json\n")
    with pytest.raises(ValueError, match="invalid event on line 3"):
        _load_latest_events(path)


def test_manifest_ignores_only_a_torn_final_record(tmp_path: Path) -> None:
    """Recover durable events while rejecting malformed complete records."""
    path = tmp_path / "events.jsonl"
    completed = _event("partial-defect-a", "completed", "attempt-1")
    path.write_text(completed.model_dump_json() + "\n{")

    latest = _load_latest_events(path)

    assert latest[completed.episode_id].status == "completed"

    replacement = _event("partial-defect-a", "failed", "attempt-2")
    _append_text(path, replacement.model_dump_json() + "\n")
    repaired = _load_latest_events(path)
    assert repaired[completed.episode_id].status == "failed"

    path.write_text(completed.model_dump_json() + "\n{}\n")
    with pytest.raises(ValueError, match="invalid event on line 2"):
        _load_latest_events(path)


def test_append_preserves_a_valid_unterminated_final_event(tmp_path: Path) -> None:
    """Add the missing separator rather than deleting a complete event."""
    path = tmp_path / "events.jsonl"
    completed = _event("partial-defect-a", "completed", "attempt-1")
    failed = _event("whole-order-damage-a", "failed", "attempt-2")
    path.write_text(completed.model_dump_json())

    _append_text(path, failed.model_dump_json() + "\n")

    latest = _load_latest_events(path)
    assert latest[completed.episode_id].status == "completed"
    assert latest[failed.episode_id].status == "failed"


def test_export_is_deterministic_and_ignores_missing_traces(tmp_path: Path) -> None:
    """Write cached traces in reviewed corpus order."""
    trace_dir = tmp_path / "traces"
    trace_dir.mkdir()
    selected = (CASES[1], CASES[0])
    for case in selected:
        (trace_dir / f"{case.ticket_id}.json").write_text(
            json.dumps({"name": case.ticket_id})
        )
    output = tmp_path / "export.jsonl"

    count = _write_export(output, selected, trace_dir)

    assert count == 2
    assert [json.loads(line)["name"] for line in output.read_text().splitlines()] == [
        selected[0].ticket_id,
        selected[1].ticket_id,
    ]


def test_trace_sanitization_removes_private_metadata_recursively() -> None:
    """Keep generated public exports inside the disclosure boundary."""
    document = {name: "private" for name in REDACTED_EXPORT_FIELDS}
    document["nested"] = [{"public_key": "secret", "safe": "value"}]

    assert _sanitize_export(document) == {"nested": [{"safe": "value"}]}


@pytest.mark.parametrize("callable_usage", [False, True])
def test_usage_supports_current_and_legacy_pydantic_ai_results(
    callable_usage: bool,
) -> None:
    """Accept the property and method forms used across supported versions."""
    usage = SimpleNamespace(requests=3, input_tokens=120, output_tokens=40)
    result = SimpleNamespace(usage=(lambda: usage) if callable_usage else usage)

    assert _get_usage(result) == {
        "requests": 3,
        "input_tokens": 120,
        "output_tokens": 40,
    }


def test_trace_waits_for_a_stable_ended_graph(monkeypatch: pytest.MonkeyPatch) -> None:
    """Do not export the first fetch of a still-growing Langfuse trace."""
    root = SimpleNamespace(id="root", parent_observation_id=None, end_time=None)
    ended_root = SimpleNamespace(
        id="root", parent_observation_id=None, end_time=datetime.now(UTC)
    )
    child = SimpleNamespace(
        id="child", parent_observation_id="root", end_time=datetime.now(UTC)
    )
    unfinished_child = SimpleNamespace(
        id="child", parent_observation_id="root", end_time=None
    )
    traces = iter(
        [
            SimpleNamespace(observations=[root]),
            SimpleNamespace(observations=[ended_root, unfinished_child]),
            SimpleNamespace(observations=[ended_root, unfinished_child]),
            SimpleNamespace(observations=[ended_root, child]),
            SimpleNamespace(observations=[ended_root, child]),
        ]
    )
    client = SimpleNamespace(
        api=SimpleNamespace(
            trace=SimpleNamespace(get=lambda *_args, **_kwargs: next(traces))
        )
    )
    monkeypatch.setattr(
        "returns_operations_agent.generate_traces.time.sleep", lambda _: None
    )

    trace = _get_trace(client, "trace-1")

    assert len(trace.observations) == 2


def _args(tmp_path: Path, **updates: object) -> argparse.Namespace:
    """Build one bounded generation configuration for lifecycle tests."""
    values: dict[str, object] = {
        "model": "openai:gpt-5-nano",
        "trace_backend": "none",
        "split": "all",
        "case_offset": 0,
        "case_limit": 1,
        "manifest": tmp_path / "events.jsonl",
        "fresh": False,
        "batch_id": "batch-1",
        "concurrency": 1,
        "request_limit": 3,
        "episode_timeout": 5,
        "retry_failed": False,
        "retry_ambiguous": False,
        "output": tmp_path / "traces.jsonl",
    }
    values.update(updates)
    return argparse.Namespace(**values)


class _FakeRunResult:
    """Minimal successful PydanticAI run result."""

    output = SimpleNamespace(
        model_dump=lambda **_kwargs: {
            "action": "refund",
            "order_id": "73001",
            "line_item_ids": ["73001-1"],
            "amount": "30.00",
            "reason": "Reviewed.",
            "customer_reply": "Resolved.",
        }
    )
    usage = SimpleNamespace(requests=1, tool_calls=3)

    @staticmethod
    def _traceparent() -> str:
        return "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"


class _FakeAgent:
    """Minimal agent that counts provider calls."""

    def __init__(self, calls: list[str]) -> None:
        self._calls = calls

    async def run(self, prompt: str, **_kwargs: object) -> _FakeRunResult:
        self._calls.append(prompt)
        return _FakeRunResult()


class _FailingAgent(_FakeAgent):
    """Agent whose provider attempt has an uncertain outcome."""

    async def run(self, prompt: str, **_kwargs: object) -> _FakeRunResult:
        self._calls.append(prompt)
        raise TimeoutError("provider response timed out")


def _patch_generation(monkeypatch: pytest.MonkeyPatch, calls: list[str]) -> None:
    """Replace provider-facing generation dependencies with deterministic fakes."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(
        "returns_operations_agent.generate_traces.infer_model", lambda model: model
    )
    monkeypatch.setattr(
        "returns_operations_agent.generate_traces.build_agent",
        lambda *_args, **_kwargs: _FakeAgent(calls),
    )


def test_retry_ambiguous_retries_an_interrupted_episode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Record interruption evidence and start a new attempt when authorized."""
    calls: list[str] = []
    _patch_generation(monkeypatch, calls)
    running = _event("partial-defect-a", "running", "attempt-1")
    manifest = tmp_path / "events.jsonl"
    manifest.write_text(running.model_dump_json() + "\n")

    summary = asyncio.run(
        generate(_args(tmp_path, manifest=manifest, retry_ambiguous=True))
    )

    events = [
        EpisodeEvent.model_validate_json(line)
        for line in manifest.read_text().splitlines()
    ]
    assert [event.status for event in events] == [
        "running",
        "ambiguous",
        "running",
        "completed",
    ]
    assert events[-1].attempt_id != "attempt-1"
    assert len(calls) == 1
    assert summary.succeeded == 1


def test_langfuse_export_failure_preserves_generated_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Resume export without paying for a second model call after API failure."""
    calls: list[str] = []
    _patch_generation(monkeypatch, calls)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "test-public")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "test-secret")
    fake_client = SimpleNamespace(flush=lambda: None)
    monkeypatch.setattr("langfuse.Langfuse", lambda: fake_client)
    monkeypatch.setattr(
        "langfuse.propagate_attributes", lambda **_kwargs: nullcontext()
    )
    monkeypatch.setattr(
        "returns_operations_agent.generate_traces.Agent.instrument_all", lambda: None
    )
    monkeypatch.setattr(
        "returns_operations_agent.generate_traces._get_trace",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("not ready")),
    )

    summary = asyncio.run(generate(_args(tmp_path, trace_backend="langfuse")))

    latest = _load_latest_events(tmp_path / "events.jsonl")
    event = latest["batch-1:partial-defect-a"]
    assert event.status == "generated"
    assert event.trace_id == "0123456789abcdef0123456789abcdef"
    assert event.error_type == "RuntimeError"
    assert summary.failed == 1
    assert len(calls) == 1

    monkeypatch.setattr(
        "returns_operations_agent.generate_traces._get_trace",
        lambda *_args, **_kwargs: SimpleNamespace(
            model_dump=lambda **_dump_kwargs: {"id": "trace-1", "observations": []}
        ),
    )

    resumed = asyncio.run(generate(_args(tmp_path, trace_backend="langfuse")))

    assert resumed.succeeded == 1
    assert resumed.failed == 0
    assert len(calls) == 1


def test_uncertain_provider_failure_requires_ambiguous_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Do not repeat a possibly completed paid call through the failure flag."""
    calls: list[str] = []
    _patch_generation(monkeypatch, calls)
    monkeypatch.setattr(
        "returns_operations_agent.generate_traces.build_agent",
        lambda *_args, **_kwargs: _FailingAgent(calls),
    )

    first = asyncio.run(generate(_args(tmp_path)))
    failed_retry = asyncio.run(generate(_args(tmp_path, retry_failed=True)))
    ambiguous_retry = asyncio.run(generate(_args(tmp_path, retry_ambiguous=True)))

    assert first.ambiguous == 1
    assert failed_retry.ambiguous == 1
    assert ambiguous_retry.ambiguous == 1
    assert len(calls) == 2


def test_pre_provider_failure_uses_failed_retry_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Retry setup failures without requiring paid-call authorization."""
    calls: list[str] = []
    _patch_generation(monkeypatch, calls)

    def fail_to_build(*_args: object, **_kwargs: object) -> _FakeAgent:
        calls.append("build")
        raise ValueError("invalid local agent configuration")

    monkeypatch.setattr(
        "returns_operations_agent.generate_traces.build_agent", fail_to_build
    )

    first = asyncio.run(generate(_args(tmp_path)))
    ambiguous_retry = asyncio.run(generate(_args(tmp_path, retry_ambiguous=True)))
    failed_retry = asyncio.run(generate(_args(tmp_path, retry_failed=True)))

    assert first.failed == 1
    assert first.ambiguous == 0
    assert ambiguous_retry.failed == 1
    assert failed_retry.failed == 1
    assert calls == ["build", "build"]
