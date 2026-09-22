"""PydanticAI returns-operations resolver run directly or by Kitaru."""

import asyncio
from decimal import Decimal
from typing import Any, cast

from kitaru.task import get_task_inputs
from kitaru_pydantic_ai import KitaruAgent
from pydantic_ai import Agent
from pydantic_ai.models import KnownModelName, Model

from returns_operations_agent.models import Resolution, TicketInput
from returns_operations_agent.store import MockCommerceStore

DEFAULT_MODEL: KnownModelName = "openai:gpt-5-nano"

_TASK_INSTRUCTIONS = (
    "You autonomously resolve one synthetic customer return or delivery ticket.\n\n"
    "Investigate with the available tools, choose exactly one terminal outcome, "
    "execute it, confirm that the receipt was accepted, and then return the "
    "structured resolution. Use lookup_order before making claims about an order. "
    "If a supplied order number is wrong, retry by customer email. Never choose "
    "between multiple email matches. Use get_return_policy for every return or "
    "refund decision. Use check_shipping for every delivery problem.\n\n"
)

_BASELINE_POLICY = (
    "Prioritize a fast, generous resolution. Customer-reported defects usually "
    "receive a full refund. Assume the action tools enforce monetary approval "
    "limits, risk holds, and duplicate-action safeguards. After reaching a likely "
    "decision, re-read the relevant order and policy once to confirm the facts "
    "before acting. Escalate when the order cannot be identified or no supported "
    "resolution is available.\n\n"
)

_REPLY_INSTRUCTIONS = (
    "The customer reply must accurately describe the one accepted terminal tool "
    "action. Address the customer by first name. Do not expose email addresses, "
    "internal risk flags, or synthetic receipt identifiers. All records and "
    "actions in this example are synthetic."
)

INSTRUCTIONS = _TASK_INSTRUCTIONS + _BASELINE_POLICY + _REPLY_INSTRUCTIONS


def get_instructions() -> str:
    """Build the intentionally imperfect baseline instructions."""
    return INSTRUCTIONS


def get_ticket_input(value: Any) -> TicketInput:
    """Unwrap the latest imported turn into one ticket input."""
    if isinstance(value, dict) and isinstance(value.get("turns"), list):
        turns = value["turns"]
        if not turns:
            raise ValueError("The imported session has no turns.")
        value = turns[-1].get("inputs")
    return TicketInput.model_validate(value)


def build_prompt(ticket: TicketInput) -> str:
    """Render one incoming request without adding reviewed outcome labels."""
    return (
        f"Ticket: {ticket.ticket_id}\n"
        f"From: {ticket.customer_name} <{ticket.email}>\n"
        f"Subject: {ticket.subject}\n\n"
        f"{ticket.body}"
    )


def _get_model_settings(model: Model | KnownModelName) -> dict[str, Any] | None:
    """Return provider-specific settings only for direct OpenAI models."""
    if isinstance(model, str) and model.startswith("openai:"):
        return {
            "openai_reasoning_effort": "low",
            "openai_reasoning_summary": "auto",
        }
    return None


def normalize_model_name(model_name: str) -> KnownModelName:
    """Validate the provider prefix and narrow a configured model name."""
    if not model_name.startswith(("openai:", "openrouter:")):
        raise ValueError("Model must use the openai: or openrouter: prefix.")
    return cast(KnownModelName, model_name)


def build_agent(
    store: MockCommerceStore,
    model: Model | KnownModelName = DEFAULT_MODEL,
    *,
    model_settings: dict[str, Any] | None = None,
) -> Agent[None, Resolution]:
    """Build the baseline resolver around one isolated synthetic store."""
    agent = Agent[None, Resolution](
        model,
        output_type=Resolution,
        instructions=get_instructions(),
        retries=2,
        model_settings=model_settings or _get_model_settings(model),
    )

    @agent.tool_plain
    def lookup_order(
        order_id: str | None = None, email: str | None = None
    ) -> dict[str, Any]:
        """Look up an order by exact order number or customer email."""
        return store.lookup_order(order_id, email).model_dump(mode="json")

    @agent.tool_plain
    def get_return_policy(category: str) -> dict[str, Any]:
        """Get return, final-sale, merchant-error, and approval rules."""
        return store.get_return_policy(category).model_dump(mode="json")

    @agent.tool_plain
    def check_shipping(tracking_no: str) -> dict[str, Any]:
        """Check carrier status for a shipped or missing order."""
        return store.check_shipping(tracking_no).model_dump(mode="json")

    @agent.tool_plain
    def issue_refund(
        order_id: str, line_item_ids: list[str], amount: Decimal
    ) -> dict[str, Any]:
        """Record a synthetic refund for selected lines."""
        return store.issue_refund(order_id, line_item_ids, amount).model_dump(
            mode="json"
        )

    @agent.tool_plain
    def create_replacement(order_id: str, line_item_ids: list[str]) -> dict[str, Any]:
        """Record a synthetic replacement for selected lines."""
        return store.create_replacement(order_id, line_item_ids).model_dump(mode="json")

    @agent.tool_plain
    def escalate_to_human(reason: str, order_id: str | None = None) -> dict[str, Any]:
        """Record a synthetic escalation with a concise internal reason."""
        return store.escalate_to_human(reason, order_id).model_dump(mode="json")

    @agent.tool_plain
    def decline_request(order_id: str, reason: str) -> dict[str, Any]:
        """Record a policy-based rejection for an identified order."""
        return store.decline_request(order_id, reason).model_dump(mode="json")

    return agent


async def main() -> None:
    """Resolve one replayed ticket and record its session in Kitaru."""
    ticket = get_ticket_input(get_task_inputs())
    pydantic_agent = build_agent(MockCommerceStore())
    agent = KitaruAgent(
        pydantic_agent,
        session_name=f"Extended returns: {ticket.ticket_id}",
    )
    result = await agent.run(build_prompt(ticket))
    print(result.output.model_dump_json())


if __name__ == "__main__":
    asyncio.run(main())
