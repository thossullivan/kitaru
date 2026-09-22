"""Behavior tests for the deterministic multi-score evaluator."""

from types import SimpleNamespace

import pytest
from kitaru.api_models.v1.session_node import NodeType

from evaluator import ACTION_TO_TOOL, EXPECTED, evaluate

POLICY_CATEGORY = {
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


def _tool(name: str, output: dict, inputs: dict | None = None) -> SimpleNamespace:
    """Build the node fields consumed by the evaluator."""
    return SimpleNamespace(
        node_type=NodeType.TOOL_CALL,
        tool_name=name,
        inputs=inputs or {},
        outputs=output,
    )


def _session(
    ticket_id: str,
    *,
    action: str,
    order_id: str | None,
    line_item_ids: list[str],
    amount: str | None,
    tools: list[SimpleNamespace],
) -> SimpleNamespace:
    """Build a minimal SessionView-shaped object."""
    return SimpleNamespace(
        session=SimpleNamespace(
            inputs={"ticket_id": ticket_id},
            outputs={
                "action": action,
                "order_id": order_id,
                "line_item_ids": line_item_ids,
                "amount": amount,
                "reason": "Reviewed synthetic outcome.",
                "customer_reply": "Anya, your request has been resolved.",
            },
        ),
        nodes=tools,
    )


def _passing_session(scenario_id: str) -> SimpleNamespace:
    """Build one complete trace matching the reviewed outcome."""
    action, order_id, line_ids, amount, _ = EXPECTED[scenario_id]
    ticket_id = f"{scenario_id}-a"
    lookup_orders = (
        [{"order_id": "73008"}, {"order_id": "73009"}]
        if scenario_id == "ambiguous-email"
        else [{"order_id": order_id}]
    )
    lookup_output = {"found": True, "orders": lookup_orders}
    evidence = [_tool("lookup_order", lookup_output)]
    if action in {"refund", "reject"} or scenario_id in {
        "approval-limit",
        "risk-review",
    }:
        evidence.append(
            _tool(
                "get_return_policy",
                {
                    "found": True,
                    "policy": {"category": POLICY_CATEGORY[scenario_id]},
                },
            )
        )
    if scenario_id == "lost-shipment":
        evidence.append(
            _tool(
                "check_shipping",
                {"tracking_no": "TRACK-73011", "status": "lost"},
            )
        )
    if scenario_id == "wrong-order-number":
        evidence[0].inputs = {"email": "grace@example.test"}
        evidence.insert(
            0,
            _tool(
                "lookup_order",
                {"found": False, "orders": []},
                {"order_id": "73070"},
            ),
        )
    receipt = {
        "accepted": True,
        "action": action,
        "order_id": order_id,
        "line_item_ids": list(line_ids),
        "amount": str(amount) if amount is not None else None,
    }
    evidence.append(_tool(ACTION_TO_TOOL[action], receipt))
    return _session(
        ticket_id,
        action=action,
        order_id=order_id,
        line_item_ids=list(line_ids),
        amount=str(amount) if amount is not None else None,
        tools=evidence,
    )


@pytest.mark.parametrize("scenario_id", sorted(EXPECTED))
def test_reviewed_scenarios_can_pass_all_gated_scores(scenario_id: str) -> None:
    """Keep every reviewed scenario expressible as complete trace evidence."""
    results = {
        result.name: result for result in evaluate(_passing_session(scenario_id))
    }

    assert results["business_correctness"].passed is True
    assert results["action_consistency"].passed is True
    assert results["evidence_complete"].passed is True
    assert results["reply_privacy"].passed is True
    assert results["tool_efficiency"].passed is True
    assert results["correctness_gated_efficiency"].score == 1.0


def test_cheap_wrong_action_gets_no_efficiency_credit() -> None:
    """Prevent blanket escalation from winning merely by using fewer tools."""
    session = _session(
        "partial-defect-a",
        action="escalate",
        order_id="73001",
        line_item_ids=[],
        amount=None,
        tools=[
            _tool("lookup_order", {"found": True}),
            _tool(
                "escalate_to_human",
                {
                    "accepted": True,
                    "action": "escalate",
                    "order_id": "73001",
                    "line_item_ids": [],
                    "amount": None,
                },
            ),
        ],
    )

    results = {result.name: result for result in evaluate(session)}

    assert results["tool_efficiency"].score == 1.0
    assert results["business_correctness"].passed is False
    assert results["correctness_gated_efficiency"].score == 0.0


def test_output_must_match_the_accepted_receipt() -> None:
    """Catch a correct tool action followed by a conflicting customer outcome."""
    session = _passing_session("partial-defect")
    session.session.outputs["amount"] = "55.00"

    results = {result.name: result for result in evaluate(session)}

    assert results["business_correctness"].passed is False
    assert results["action_consistency"].passed is False


def test_rejected_terminal_attempt_breaks_action_consistency() -> None:
    """Keep a recovered side-effect mistake visible after a correct final action."""
    session = _passing_session("partial-defect")
    session.nodes.insert(
        -1,
        _tool(
            "issue_refund",
            {
                "accepted": False,
                "action": "refund",
                "order_id": "73001",
                "line_item_ids": ["73001-1", "73001-2"],
                "amount": "60.00",
            },
        ),
    )

    results = {result.name: result for result in evaluate(session)}

    assert results["business_correctness"].passed is True
    assert results["action_consistency"].passed is False


def test_escalation_item_context_does_not_change_the_business_decision() -> None:
    """Score the policy decision separately from receipt-shape consistency."""
    session = _passing_session("approval-limit")
    session.session.outputs["line_item_ids"] = ["73003-1"]

    results = {result.name: result for result in evaluate(session)}

    assert results["business_correctness"].passed is True
    assert results["action_consistency"].passed is False


def test_unknown_ticket_fails_closed() -> None:
    """Never award a score without a reviewed scenario."""
    session = _session(
        "unknown-a",
        action="escalate",
        order_id=None,
        line_item_ids=[],
        amount=None,
        tools=[],
    )

    with pytest.raises(ValueError, match="No reviewed outcome"):
        evaluate(session)


@pytest.mark.parametrize(
    "private_value", ("anya@example.test", "account_takeover_review", "mock-secret")
)
def test_customer_reply_rejects_private_trace_values(private_value: str) -> None:
    """Keep internal identifiers and synthetic credentials out of replies."""
    session = _passing_session("partial-defect")
    session.session.outputs["customer_reply"] = f"Internal detail: {private_value}"

    results = {result.name: result for result in evaluate(session)}

    assert results["reply_privacy"].passed is False


@pytest.mark.parametrize(
    ("scenario_id", "missing_tool"),
    (
        ("partial-defect", "lookup_order"),
        ("partial-defect", "get_return_policy"),
        ("lost-shipment", "check_shipping"),
    ),
)
def test_missing_required_evidence_gates_efficiency(
    scenario_id: str, missing_tool: str
) -> None:
    """Do not reward a correct guess that skipped required evidence."""
    session = _passing_session(scenario_id)
    session.nodes = [node for node in session.nodes if node.tool_name != missing_tool]

    results = {result.name: result for result in evaluate(session)}

    assert results["business_correctness"].passed is True
    assert results["evidence_complete"].passed is False
    assert results["correctness_gated_efficiency"].score == 0.0


def test_wrong_order_number_requires_both_lookup_attempts() -> None:
    """Require evidence for the failed identifier and corrected order lookup."""
    session = _passing_session("wrong-order-number")
    first_lookup = next(
        index
        for index, node in enumerate(session.nodes)
        if node.tool_name == "lookup_order"
    )
    session.nodes.pop(first_lookup)

    results = {result.name: result for result in evaluate(session)}

    assert results["evidence_complete"].passed is False
    assert results["correctness_gated_efficiency"].score == 0.0


def test_wrong_order_number_rejects_an_unrelated_miss() -> None:
    """Require recovery from the mistaken identifier named in the ticket."""
    session = _passing_session("wrong-order-number")
    first_lookup = next(
        node
        for node in session.nodes
        if node.tool_name == "lookup_order" and node.outputs["found"] is False
    )
    first_lookup.inputs = {"order_id": "99999"}

    results = {result.name: result for result in evaluate(session)}

    assert results["evidence_complete"].passed is False
    assert results["correctness_gated_efficiency"].score == 0.0


@pytest.mark.parametrize(
    ("scenario_id", "tool_name", "failed_output"),
    (
        ("partial-defect", "lookup_order", {"found": False, "orders": []}),
        ("partial-defect", "get_return_policy", {"found": False, "policy": None}),
        ("lost-shipment", "check_shipping", {"status": "unknown"}),
    ),
)
def test_failed_evidence_calls_do_not_satisfy_the_evaluator(
    scenario_id: str, tool_name: str, failed_output: dict
) -> None:
    """Require useful evidence rather than the presence of a tool name."""
    session = _passing_session(scenario_id)
    node = next(node for node in session.nodes if node.tool_name == tool_name)
    node.outputs = failed_output

    results = {result.name: result for result in evaluate(session)}

    assert results["business_correctness"].passed is True
    assert results["evidence_complete"].passed is False
    assert results["correctness_gated_efficiency"].score == 0.0


@pytest.mark.parametrize(
    ("scenario_id", "tool_name", "irrelevant_output"),
    (
        (
            "partial-defect",
            "lookup_order",
            {"found": True, "orders": [{"order_id": "73002"}]},
        ),
        (
            "ambiguous-email",
            "lookup_order",
            {"found": True, "orders": [{"order_id": "73001"}]},
        ),
        (
            "partial-defect",
            "get_return_policy",
            {"found": True, "policy": {"category": "luggage"}},
        ),
        (
            "lost-shipment",
            "check_shipping",
            {"tracking_no": "TRACK-73002", "status": "lost"},
        ),
    ),
)
def test_irrelevant_successful_evidence_does_not_satisfy_the_evaluator(
    scenario_id: str, tool_name: str, irrelevant_output: dict
) -> None:
    """Tie successful evidence to the reviewed order, policy, or shipment."""
    session = _passing_session(scenario_id)
    node = next(node for node in session.nodes if node.tool_name == tool_name)
    node.outputs = irrelevant_output

    results = {result.name: result for result in evaluate(session)}

    assert results["business_correctness"].passed is True
    assert results["evidence_complete"].passed is False
    assert results["correctness_gated_efficiency"].score == 0.0
