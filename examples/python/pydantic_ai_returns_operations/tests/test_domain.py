"""Deterministic contracts for the extended returns domain."""

from decimal import Decimal

from returns_operations_agent.agent import (
    _get_model_settings,
    build_agent,
    build_prompt,
    get_ticket_input,
)
from returns_operations_agent.fixtures import (
    CASES,
    DISCOVERY_CASES,
    EXPECTED_OUTCOMES,
    HELD_OUT_CASES,
    ORDERS,
    SCENARIOS,
)
from returns_operations_agent.models import ResolutionAction
from returns_operations_agent.store import MockCommerceStore


def test_corpus_has_twelve_scenarios_and_thirty_six_unique_episodes() -> None:
    """Keep two discovery phrasings and one held-out phrasing per scenario."""
    assert len(SCENARIOS) == 12
    assert len(CASES) == 36
    assert len(DISCOVERY_CASES) == 24
    assert len(HELD_OUT_CASES) == 12
    assert len({case.ticket_id for case in CASES}) == 36
    assert all(case.email.endswith("@example.test") for case in CASES)
    assert set(EXPECTED_OUTCOMES) == {case.ticket_id for case in CASES}


def test_corpus_preserves_interacting_policy_boundaries() -> None:
    """Keep the facts that make blanket fixes regress nearby cases."""
    assert ORDERS["73001"].amount_paid == Decimal("55.00")
    assert ORDERS["73001"].lines[0].amount_paid == Decimal("30.00")
    assert ORDERS["73002"].amount_paid == Decimal("90.00")
    assert ORDERS["73003"].amount_paid == Decimal("280.00")
    assert ORDERS["73004"].risk_flags == ["account_takeover_review"]
    assert ORDERS["73005"].lines[0].final_sale is True
    assert ORDERS["73010"].refunded_amount == Decimal("82.00")
    assert ORDERS["73013"].amount_paid == Decimal("80.00")
    assert EXPECTED_OUTCOMES["partial-defect-a"].amount == Decimal("30.00")
    assert EXPECTED_OUTCOMES["whole-order-damage-a"].amount == Decimal("90.00")
    assert EXPECTED_OUTCOMES["approval-limit-a"].action is ResolutionAction.ESCALATE
    assert EXPECTED_OUTCOMES["final-sale-defect-a"].action is ResolutionAction.REFUND


def test_store_isolates_state_and_enforces_transaction_invariants() -> None:
    """Allow policy mistakes to remain visible while protecting mock state."""
    store = MockCommerceStore()
    accepted = store.issue_refund("73001", ["73001-1"], Decimal("30.00"))
    fresh = MockCommerceStore()
    invalid_line = fresh.issue_refund("73001", ["missing"], Decimal("30.00"))
    over_refund = fresh.issue_refund("73001", ["73001-1", "73001-2"], Decimal("60.00"))

    assert accepted.accepted is True
    assert accepted.line_item_ids == ["73001-1"]
    assert store.orders["73001"].refunded_amount == Decimal("30.00")
    assert fresh.orders["73001"].refunded_amount == Decimal("0.00")
    assert invalid_line.accepted is False
    assert over_refund.accepted is False


def test_store_keeps_policy_decisions_out_of_action_tools() -> None:
    """Keep approval and risk mistakes observable in the starting agent."""
    high_value = MockCommerceStore().issue_refund(
        "73003", ["73003-1"], Decimal("280.00")
    )
    risk_flagged = MockCommerceStore().issue_refund(
        "73004", ["73004-1"], Decimal("120.00")
    )

    assert high_value.accepted is True
    assert risk_flagged.accepted is True


def test_lookup_supports_recovery_without_resolving_ambiguity() -> None:
    """Permit a unique email retry while preserving ambiguous evidence."""
    store = MockCommerceStore()

    wrong = store.lookup_order(order_id="73070")
    recovered = store.lookup_order(email="grace@example.test")
    ambiguous = store.lookup_order(email="hamid@example.test")

    assert wrong.found is False
    assert [order.order_id for order in recovered.orders] == ["73007"]
    assert [order.order_id for order in ambiguous.orders] == ["73008", "73009"]


def test_unknown_tracking_is_not_reported_as_delivered() -> None:
    """Avoid turning an invented tracking number into false evidence."""
    status = MockCommerceStore().check_shipping("TRACK-MISSING")

    assert status.status == "unknown"


def test_agent_contract_exposes_the_extended_tools_and_replay_input() -> None:
    """Keep the registered runtime aligned with the generated evidence."""
    agent = build_agent(MockCommerceStore(), "test")
    ticket = CASES[0]
    imported = {
        "schema_version": 1,
        "turns": [{"source_trace_id": "trace-1", "inputs": ticket.model_dump()}],
    }

    assert get_ticket_input(imported) == ticket
    assert ticket.body in build_prompt(ticket)
    assert set(agent._function_toolset.tools) == {
        "lookup_order",
        "get_return_policy",
        "check_shipping",
        "issue_refund",
        "create_replacement",
        "escalate_to_human",
        "decline_request",
    }
    assert agent.model_settings is None


def test_openai_agent_uses_low_reasoning_without_leaking_to_other_providers() -> None:
    """Apply provider-specific settings only to direct OpenAI models."""
    assert _get_model_settings("openai:gpt-5-nano") == {
        "openai_reasoning_effort": "low",
        "openai_reasoning_summary": "auto",
    }
    assert _get_model_settings("openrouter:openai/gpt-5-nano") is None
