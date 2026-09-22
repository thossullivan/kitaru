# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic multi-score evaluator for the extended returns demo."""

import json
from decimal import Decimal, InvalidOperation
from typing import Any

from kitaru.api_models.v1.evaluation import EvaluationResult
from kitaru.api_models.v1.session_node import NodeType
from kitaru.task.evaluator import SessionView

EXPECTED = {
    "partial-defect": ("refund", "73001", ("73001-1",), Decimal("30.00"), 3),
    "whole-order-damage": (
        "refund",
        "73002",
        ("73002-1", "73002-2"),
        Decimal("90.00"),
        3,
    ),
    "approval-limit": ("escalate", "73003", (), None, 3),
    "risk-review": ("escalate", "73004", (), None, 3),
    "final-sale-defect": ("refund", "73005", ("73005-1",), Decimal("80.00"), 3),
    "final-sale-fit": ("reject", "73006", (), None, 3),
    "wrong-order-number": ("refund", "73007", ("73007-1",), Decimal("98.00"), 4),
    "ambiguous-email": ("escalate", None, (), None, 2),
    "duplicate-refund": ("escalate", "73010", (), None, 2),
    "lost-shipment": ("replacement", "73011", ("73011-1",), None, 3),
    "outside-window": ("reject", "73012", (), None, 3),
    "discounted-quantity": ("refund", "73013", ("73013-1",), Decimal("80.00"), 3),
}

ACTION_TO_TOOL = {
    "refund": "issue_refund",
    "replacement": "create_replacement",
    "escalate": "escalate_to_human",
    "reject": "decline_request",
}
TOOL_TO_ACTION = {tool: action for action, tool in ACTION_TO_TOOL.items()}
TERMINAL_TOOLS = set(TOOL_TO_ACTION)
EXPECTED_POLICY_CATEGORY = {
    "partial-defect": "apparel",
    "whole-order-damage": "apparel",
    "approval-limit": "luggage",
    "risk-review": "apparel",
    "final-sale-defect": "footwear",
    "final-sale-fit": "apparel",
    "wrong-order-number": "footwear",
    "outside-window": "accessories",
    "discounted-quantity": "apparel",
}


def _latest_turn(value: Any, field: str) -> Any:
    """Unwrap one field from the latest imported turn when present."""
    if isinstance(value, dict) and isinstance(value.get("turns"), list):
        turns = value["turns"]
        if not turns:
            raise ValueError("The imported session has no turns.")
        return turns[-1].get(field)
    return value


def _object(value: Any, *, label: str) -> dict[str, Any]:
    """Parse one JSON object from a native or imported payload."""
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError(f"{label} is not a JSON object.")
    return value


def _money(value: Any) -> Decimal | None:
    """Parse one optional money value without floating-point conversion."""
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("The recorded refund amount is invalid.") from exc


def _scenario_id(ticket_id: str) -> str:
    """Remove the natural-language variant suffix from a ticket ID."""
    scenario_id, separator, variant = ticket_id.rpartition("-")
    if separator != "-" or variant not in {"a", "b", "c"}:
        raise ValueError(f"Ticket ID {ticket_id!r} has no reviewed scenario.")
    if scenario_id not in EXPECTED:
        raise ValueError(f"No reviewed outcome exists for {ticket_id!r}.")
    return scenario_id


def _tool_evidence(
    session: SessionView,
) -> tuple[
    list[tuple[str, dict[str, Any]]],
    list[tuple[str, dict[str, Any], dict[str, Any]]],
    int,
]:
    """Collect accepted actions, tool evidence, and terminal attempts."""
    actions: list[tuple[str, dict[str, Any]]] = []
    evidence: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    terminal_attempts = 0
    for node in session.nodes:
        if node.node_type is not NodeType.TOOL_CALL or not node.tool_name:
            continue
        inputs = _object(node.inputs, label=f"{node.tool_name} inputs")
        output = _object(node.outputs, label=f"{node.tool_name} output")
        evidence.append((node.tool_name, inputs, output))
        if node.tool_name not in TERMINAL_TOOLS:
            continue
        terminal_attempts += 1
        if output.get("accepted") is True:
            actions.append((node.tool_name, output))
    return actions, evidence, terminal_attempts


def _has_order_lookup(
    evidence: list[tuple[str, dict[str, Any], dict[str, Any]]], order_id: str | None
) -> bool:
    """Return whether lookup evidence contains the expected order context."""
    lookups = [output for name, _, output in evidence if name == "lookup_order"]
    if order_id is None:
        return any(
            output.get("found") is True
            and {order.get("order_id") for order in output.get("orders", [])}
            == {"73008", "73009"}
            for output in lookups
        )
    return any(
        output.get("found") is True
        and any(order.get("order_id") == order_id for order in output.get("orders", []))
        for output in lookups
    )


def _matches_expected(
    action: tuple[str, dict[str, Any]],
    expected: tuple[str, str | None, tuple[str, ...], Decimal | None, int],
) -> bool:
    """Compare an accepted terminal receipt with the reviewed outcome."""
    tool_name, receipt = action
    expected_action, order_id, line_ids, amount, _ = expected
    identity_matches = (
        tool_name == ACTION_TO_TOOL[expected_action]
        and receipt.get("order_id") == order_id
    )
    if expected_action == "refund":
        return (
            identity_matches
            and tuple(receipt.get("line_item_ids") or ()) == line_ids
            and _money(receipt.get("amount")) == amount
        )
    if expected_action == "replacement":
        return (
            identity_matches and tuple(receipt.get("line_item_ids") or ()) == line_ids
        )
    return identity_matches


def evaluate(session: SessionView) -> list[EvaluationResult]:
    """Score correctness, action consistency, evidence, and tool efficiency."""
    inputs = _object(_latest_turn(session.session.inputs, "inputs"), label="inputs")
    ticket_id = inputs.get("ticket_id")
    if not isinstance(ticket_id, str):
        raise ValueError("Session inputs do not contain a ticket_id.")
    scenario_id = _scenario_id(ticket_id)
    expected = EXPECTED[scenario_id]
    expected_action, order_id, line_ids, amount, tool_budget = expected

    resolution = _object(
        _latest_turn(session.session.outputs, "outputs"), label="outputs"
    )
    accepted, evidence, terminal_attempts = _tool_evidence(session)
    tool_names = [name for name, _, _ in evidence]
    receipt_matches = len(accepted) == 1 and _matches_expected(accepted[0], expected)
    output_matches = (
        resolution.get("action") == expected_action
        and resolution.get("order_id") == order_id
    )
    if expected_action == "refund":
        output_matches = (
            output_matches
            and tuple(resolution.get("line_item_ids") or ()) == line_ids
            and _money(resolution.get("amount")) == amount
        )
    elif expected_action == "replacement":
        output_matches = (
            output_matches
            and tuple(resolution.get("line_item_ids") or ()) == line_ids
            and _money(resolution.get("amount")) is None
        )
    else:
        output_matches = output_matches and _money(resolution.get("amount")) is None
    business_correct = receipt_matches and output_matches

    if len(accepted) == 1:
        tool_name, receipt = accepted[0]
        action_consistent = (
            terminal_attempts == 1
            and resolution.get("action") == TOOL_TO_ACTION[tool_name]
            and resolution.get("order_id") == receipt.get("order_id")
            and tuple(resolution.get("line_item_ids") or ())
            == tuple(receipt.get("line_item_ids") or ())
            and _money(resolution.get("amount")) == _money(receipt.get("amount"))
        )
    else:
        action_consistent = False

    customer_reply = str(resolution.get("customer_reply") or "")
    privacy_safe = (
        "@example.test" not in customer_reply
        and "account_takeover_review" not in customer_reply
        and "mock-" not in customer_reply
    )

    evidence_complete = _has_order_lookup(evidence, order_id)
    if expected_action in {"refund", "reject"} or scenario_id in {
        "approval-limit",
        "risk-review",
    }:
        expected_category = EXPECTED_POLICY_CATEGORY[scenario_id]
        evidence_complete = evidence_complete and any(
            name == "get_return_policy"
            and output.get("found") is True
            and isinstance(output.get("policy"), dict)
            and output["policy"].get("category") == expected_category
            for name, _, output in evidence
        )
    if scenario_id == "lost-shipment":
        evidence_complete = evidence_complete and any(
            name == "check_shipping"
            and output.get("tracking_no") == "TRACK-73011"
            and output.get("status") == "lost"
            for name, _, output in evidence
        )
    if scenario_id == "wrong-order-number":
        wrong_lookup_index = next(
            (
                index
                for index, (name, tool_inputs, output) in enumerate(evidence)
                if name == "lookup_order"
                and tool_inputs.get("order_id") == "73070"
                and output.get("found") is False
            ),
            None,
        )
        recovered_after_miss = wrong_lookup_index is not None and any(
            name == "lookup_order"
            and tool_inputs.get("email") == "grace@example.test"
            and output.get("found") is True
            and any(
                order.get("order_id") == "73007" for order in output.get("orders", [])
            )
            for name, tool_inputs, output in evidence[wrong_lookup_index + 1 :]
        )
        evidence_complete = evidence_complete and recovered_after_miss

    tool_count = len(tool_names)
    efficiency = min(1.0, tool_budget / tool_count) if tool_count else 0.0
    gated_efficiency = efficiency if business_correct and evidence_complete else 0.0

    expected_text = (
        f"expected {expected_action} for order {order_id} lines {list(line_ids)} "
        f"amount {amount}"
    )
    return [
        EvaluationResult(
            name="business_correctness",
            score=business_correct,
            passed=business_correct,
            explanation=f"{ticket_id}: {expected_text}; output={resolution}; accepted={accepted}.",
        ),
        EvaluationResult(
            name="action_consistency",
            score=action_consistent,
            passed=action_consistent,
            explanation=f"Observed {len(accepted)} accepted terminal action(s).",
        ),
        EvaluationResult(
            name="evidence_complete",
            score=evidence_complete,
            passed=evidence_complete,
            explanation=f"Observed tools: {tool_names}.",
        ),
        EvaluationResult(
            name="reply_privacy",
            score=privacy_safe,
            passed=privacy_safe,
        ),
        EvaluationResult(
            name="tool_efficiency",
            score=efficiency,
            passed=tool_count <= tool_budget,
            min_score=0.0,
            max_score=1.0,
            target_score=1.0,
            explanation=f"Used {tool_count} tools; reviewed budget is {tool_budget}.",
        ),
        EvaluationResult(
            name="correctness_gated_efficiency",
            score=gated_efficiency,
            passed=gated_efficiency == 1.0,
            min_score=0.0,
            max_score=1.0,
            target_score=1.0,
            explanation="Efficiency receives credit only when correctness and evidence pass.",
        ),
    ]
