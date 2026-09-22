# Extended returns operations demo

This example is a larger sibling of Kitaru's maintained returns quickstart. It is designed to give Kaizen a realistic body of agent evidence to investigate before the AIE Paris demo. The original quickstart remains small and unchanged.

The corpus contains 12 reviewed situations, each expressed three ways. The first two phrasings form a 24-episode discovery set and the third phrasing forms a 12-episode held-out paraphrase set. This split measures robustness to wording changes within known scenarios; it does not claim generalization to unseen orders or policies. Orders contain multiple line items, discounts, quantities, policy exceptions, approval thresholds, risk flags, ambiguous identity, duplicate refunds, and shipment state. All customers, commerce records, and actions are synthetic. Tools modify a fresh in-memory store for each run.

The baseline is intentionally plausible but imperfect. Its prompt favors generous full refunds, assumes action tools enforce policy approval and risk rules, and asks the model to repeat evidence lookups. These choices create useful, interacting opportunities for Kaizen to find correctness and efficiency improvements. The action tools still enforce transaction invariants such as valid order and line IDs, positive amounts, and the remaining refundable total.

## Prepare and test

```bash
cd examples/python/pydantic_ai_returns_operations
uv sync --frozen
uv run pytest -q
uv run ruff check .
```

Create `.env` in this directory for local provider credentials. Use `OPENAI_API_KEY` for direct OpenAI models. OpenRouter is wired through PydanticAI and uses `OPENROUTER_API_KEY`, but this demo does not select an OpenRouter model by default.

## Run a small provider pilot

This records structured outcomes, errors, token counts, and checkpoint state without requiring Langfuse:

```bash
./generate.sh \
  --trace-backend none \
  --model openai:gpt-5-nano \
  --batch-id nano-pilot-v1 \
  --manifest runs/nano-pilot-v1.jsonl \
  --case-limit 6 \
  --concurrency 2 \
  --fresh
```

Omit `--case-limit` to run all 36 episodes. Use `--case-offset 6 --case-limit 6` to target the approval-limit and risk-review scenarios in a second small pilot. Use `--model openai:gpt-5-mini` for a comparison batch. Direct OpenAI models run with low reasoning effort. Every episode has a request limit and wall-clock timeout, and each invocation receives a fresh store.

The manifest is append-only. Repeating the same command without `--fresh` resumes the batch and skips completed episodes. A process interrupted during a provider call is marked ambiguous on resume instead of silently paying for the same episode again. Use `--retry-failed` for definite failures. Use `--retry-ambiguous` separately when you accept that an uncertain provider attempt may already have completed and incurred cost.

## Generate importable Langfuse traces

Once `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are present in `.env`, run:

```bash
./generate.sh \
  --trace-backend langfuse \
  --model openai:gpt-5-nano \
  --batch-id aie-paris-baseline-v1 \
  --manifest runs/aie-paris-baseline-v1.jsonl \
  --output traces/generated-aie-paris-baseline-v1.jsonl \
  --concurrency 4 \
  --fresh
```

Every model attempt receives a unique Langfuse session ID. The generator fetches complete observation graphs, strips private source metadata, caches each sanitized trace, and rebuilds the JSONL export in corpus order. Failures remain in the manifest and do not disappear from the attempted denominator. Result-only batches from `--trace-backend none` are useful for pilots but are not Kitaru-importable trace evidence.

## Register and import in Kitaru

From this directory, register the native PydanticAI agent and start a worker:

```bash
uv run kitaru agent register \
  extended-returns-resolver \
  --command "python -m returns_operations_agent.agent" \
  --description "Resolve synthetic multi-item returns and delivery requests." \
  --display-version baseline-v1 \
  --working-dir . \
  --timeout-seconds 180 \
  --tool lookup_order \
  --tool get_return_policy \
  --tool check_shipping \
  --tool issue_refund \
  --tool create_replacement \
  --tool escalate_to_human \
  --tool decline_request

uv run kitaru worker start --name extended-returns-worker --concurrency 10
```

Import a complete generated trace file in another terminal:

```bash
uv run kitaru session import \
  traces/generated-aie-paris-baseline-v1.jsonl \
  --importer kitaru/langfuse@latest \
  --agent extended-returns-resolver@1 \
  --tag extended-returns-baseline \
  --params '{"source_instance":"kitaru-extended-returns-demo"}' \
  --media-type application/x-ndjson \
  --wait
```

The complete import should create 36 independent one-turn sessions. Reimporting the same file is expected to skip the same 36 external identities.

## Score the baseline

The evaluator returns separate results for business correctness, accepted-action consistency, evidence completeness, reply privacy, raw tool efficiency, and correctness-gated efficiency. A cheap but incorrect run therefore cannot win the optimization comparison.

```bash
uv run kitaru evaluator test evaluator.py --entrypoint evaluate
uv run kitaru evaluator register \
  extended-returns-contract \
  --script evaluator.py \
  --entrypoint evaluate \
  --description "Score correctness and efficiency for the extended returns corpus." \
  --display-version demo-v1

uv run kitaru session evaluate \
  --tag extended-returns-baseline \
  --evaluator extended-returns-contract@1 \
  --evaluator kitaru/cost@latest \
  --evaluator kitaru/latency@latest \
  --evaluator kitaru/tool-call-patterns@latest \
  --wait
```

For an agent change, keep the model fixed first and register a new agent version from a pinned checkout. Compare correctness before cost. For a model comparison, keep the corrected code and corpus fixed, then run a separate batch with the replacement model. Replays should use a fresh in-memory store and the passthrough tool policy `{"default":{"type":"passthrough"},"tools":{}}`; history tool outputs would preserve the old behavior and hide tool-code fixes.

The intended Kaizen demo journey is: import evidence, surface a proactive finding, open the affected and comparison traces, propose one bounded prompt or code change, replay the reviewed cohort, and show the correctness, latency, tool-count, and cost difference.
