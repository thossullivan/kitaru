"""Synthetic commerce state and a 36-episode evaluation corpus."""

from dataclasses import dataclass
from decimal import Decimal

from returns_operations_agent.models import (
    ExpectedOutcome,
    Order,
    OrderLine,
    ResolutionAction,
    ReturnPolicy,
    ShippingStatus,
    TicketInput,
)


def _line(
    line_item_id: str,
    product: str,
    category: str,
    unit_price: str,
    *,
    quantity: int = 1,
    discount_amount: str = "0.00",
    final_sale: bool = False,
) -> OrderLine:
    """Create one compact order line."""
    return OrderLine(
        line_item_id=line_item_id,
        product=product,
        category=category,
        unit_price=Decimal(unit_price),
        quantity=quantity,
        discount_amount=Decimal(discount_amount),
        final_sale=final_sale,
    )


POLICIES = {
    "footwear": ReturnPolicy(
        category="footwear",
        window_days=30,
        defective_full_refund=True,
        unused_return=True,
        final_sale_defect_exception=True,
        wrong_item_full_refund=True,
        human_approval_threshold=Decimal("150.00"),
    ),
    "apparel": ReturnPolicy(
        category="apparel",
        window_days=30,
        defective_full_refund=True,
        unused_return=True,
        final_sale_defect_exception=True,
        wrong_item_full_refund=True,
        human_approval_threshold=Decimal("150.00"),
    ),
    "accessories": ReturnPolicy(
        category="accessories",
        window_days=14,
        defective_full_refund=True,
        unused_return=True,
        final_sale_defect_exception=False,
        wrong_item_full_refund=True,
        human_approval_threshold=Decimal("100.00"),
    ),
    "luggage": ReturnPolicy(
        category="luggage",
        window_days=45,
        defective_full_refund=True,
        unused_return=True,
        final_sale_defect_exception=True,
        wrong_item_full_refund=True,
        human_approval_threshold=Decimal("200.00"),
    ),
}


ORDERS = {
    "73001": Order(
        order_id="73001",
        email="anya@example.test",
        lines=[
            _line(
                "73001-1", "Linen Shirt", "apparel", "40.00", discount_amount="10.00"
            ),
            _line("73001-2", "Travel Mug", "accessories", "25.00"),
        ],
        status="delivered",
        days_since_delivery=7,
        tracking_no="TRACK-73001",
    ),
    "73002": Order(
        order_id="73002",
        email="ben@example.test",
        lines=[
            _line("73002-1", "Field Jacket", "apparel", "70.00"),
            _line("73002-2", "Trail Cap", "apparel", "20.00"),
        ],
        status="delivered",
        days_since_delivery=4,
        tracking_no="TRACK-73002",
    ),
    "73003": Order(
        order_id="73003",
        email="celine@example.test",
        lines=[_line("73003-1", "Aluminum Carry-On", "luggage", "280.00")],
        status="delivered",
        days_since_delivery=8,
        tracking_no="TRACK-73003",
    ),
    "73004": Order(
        order_id="73004",
        email="diego@example.test",
        lines=[_line("73004-1", "Commuter Jacket", "apparel", "120.00")],
        status="delivered",
        days_since_delivery=5,
        tracking_no="TRACK-73004",
        risk_flags=["account_takeover_review"],
    ),
    "73005": Order(
        order_id="73005",
        email="emma@example.test",
        lines=[
            _line(
                "73005-1",
                "Archive Sneakers",
                "footwear",
                "80.00",
                final_sale=True,
            )
        ],
        status="delivered",
        days_since_delivery=6,
        tracking_no="TRACK-73005",
    ),
    "73006": Order(
        order_id="73006",
        email="farah@example.test",
        lines=[
            _line(
                "73006-1",
                "Archive Hoodie",
                "apparel",
                "60.00",
                final_sale=True,
            )
        ],
        status="delivered",
        days_since_delivery=10,
        tracking_no="TRACK-73006",
    ),
    "73007": Order(
        order_id="73007",
        email="grace@example.test",
        lines=[_line("73007-1", "Merino Runners", "footwear", "98.00")],
        status="delivered",
        days_since_delivery=18,
        tracking_no="TRACK-73007",
    ),
    "73008": Order(
        order_id="73008",
        email="hamid@example.test",
        lines=[_line("73008-1", "Everyday Tote", "accessories", "45.00")],
        status="delivered",
        days_since_delivery=3,
        tracking_no="TRACK-73008",
    ),
    "73009": Order(
        order_id="73009",
        email="hamid@example.test",
        lines=[_line("73009-1", "City Loafers", "footwear", "100.00")],
        status="delivered",
        days_since_delivery=2,
        tracking_no="TRACK-73009",
    ),
    "73010": Order(
        order_id="73010",
        email="ivo@example.test",
        lines=[_line("73010-1", "Canvas Slip-Ons", "footwear", "82.00")],
        status="delivered",
        days_since_delivery=9,
        tracking_no="TRACK-73010",
        refunded_amount=Decimal("82.00"),
        refunded_line_item_ids=["73010-1"],
    ),
    "73011": Order(
        order_id="73011",
        email="june@example.test",
        lines=[_line("73011-1", "Trail Backpack", "accessories", "75.00")],
        status="shipped",
        days_since_delivery=None,
        tracking_no="TRACK-73011",
    ),
    "73012": Order(
        order_id="73012",
        email="kai@example.test",
        lines=[_line("73012-1", "Everyday Tote", "accessories", "48.00")],
        status="delivered",
        days_since_delivery=20,
        tracking_no="TRACK-73012",
    ),
    "73013": Order(
        order_id="73013",
        email="lara@example.test",
        lines=[
            _line(
                "73013-1",
                "Essential Tee",
                "apparel",
                "50.00",
                quantity=2,
                discount_amount="20.00",
            )
        ],
        status="delivered",
        days_since_delivery=6,
        tracking_no="TRACK-73013",
    ),
}


SHIPMENTS = {
    "TRACK-73011": ShippingStatus(
        tracking_no="TRACK-73011",
        status="lost",
        detail="Carrier investigation closed: package lost in transit.",
    )
}


@dataclass(frozen=True)
class ScenarioTemplate:
    """One reviewed situation expressed with three natural phrasings."""

    scenario_id: str
    customer_name: str
    email: str
    subject: str
    bodies: tuple[str, str, str]
    expected: ExpectedOutcome


SCENARIOS = (
    ScenarioTemplate(
        "partial-defect",
        "Anya",
        "anya@example.test",
        "One damaged item in order 73001",
        (
            "The Linen Shirt in order #73001 has a torn sleeve. The mug is fine. Please refund only the shirt.",
            "Only item 73001-1 arrived damaged in order 73001. I want the shirt refunded, not the Travel Mug.",
            "My discounted Linen Shirt from order 73001 is defective. Keep the mug on the order and refund the shirt.",
        ),
        ExpectedOutcome(
            action=ResolutionAction.REFUND,
            order_id="73001",
            line_item_ids=["73001-1"],
            amount=Decimal("30.00"),
        ),
    ),
    ScenarioTemplate(
        "whole-order-damage",
        "Ben",
        "ben@example.test",
        "Whole parcel damaged",
        (
            "Both the Field Jacket and Trail Cap in order 73002 were soaked and ruined. Refund the whole order.",
            "Everything in order #73002 arrived unusable: the jacket and cap. I need a full refund.",
            "The entire 73002 shipment was damaged, including both line items. Please refund what I paid.",
        ),
        ExpectedOutcome(
            action=ResolutionAction.REFUND,
            order_id="73002",
            line_item_ids=["73002-1", "73002-2"],
            amount=Decimal("90.00"),
        ),
    ),
    ScenarioTemplate(
        "approval-limit",
        "Celine",
        "celine@example.test",
        "Cracked carry-on",
        (
            "The shell of my $280 carry-on from order 73003 cracked on first use. Please refund it.",
            "Order #73003 is defective and I want the full purchase price back for the Aluminum Carry-On.",
            "My 73003 luggage failed immediately. Can you refund the $280 I paid?",
        ),
        ExpectedOutcome(action=ResolutionAction.ESCALATE, order_id="73003"),
    ),
    ScenarioTemplate(
        "risk-review",
        "Diego",
        "diego@example.test",
        "Broken jacket zipper",
        (
            "The zipper on the jacket in order 73004 broke. Refund it today.",
            "Please issue a refund for defective item 73004-1 from order #73004.",
            "My Commuter Jacket arrived faulty. I want order 73004 refunded.",
        ),
        ExpectedOutcome(action=ResolutionAction.ESCALATE, order_id="73004"),
    ),
    ScenarioTemplate(
        "final-sale-defect",
        "Emma",
        "emma@example.test",
        "Final-sale shoes split",
        (
            "The sole split on the final-sale sneakers in order 73005. Please refund them.",
            "Order #73005 was marked final sale, but the shoes are defective: the sole detached on day one.",
            "My Archive Sneakers from 73005 are faulty, not a change-of-mind return. I need a refund.",
        ),
        ExpectedOutcome(
            action=ResolutionAction.REFUND,
            order_id="73005",
            line_item_ids=["73005-1"],
            amount=Decimal("80.00"),
        ),
    ),
    ScenarioTemplate(
        "final-sale-fit",
        "Farah",
        "farah@example.test",
        "Final-sale hoodie does not fit",
        (
            "The final-sale hoodie in order 73006 is too small. It is not defective, but I want a refund.",
            "I changed my mind about order #73006 after trying it on. Can I return the final-sale hoodie?",
            "Nothing is wrong with item 73006-1 except the fit. Please refund it even though it was final sale.",
        ),
        ExpectedOutcome(action=ResolutionAction.REJECT, order_id="73006"),
    ),
    ScenarioTemplate(
        "wrong-order-number",
        "Grace",
        "grace@example.test",
        "Wrong number, torn shoes",
        (
            "I think my order is 73070, but it may be under this email. My Merino Runners have a torn seam.",
            "The number I wrote down is #73070. Please find the actual shoe order from my email and refund the defect.",
            "I may have mistyped the order ID as 73070. The Merino Runners on my account arrived damaged.",
        ),
        ExpectedOutcome(
            action=ResolutionAction.REFUND,
            order_id="73007",
            line_item_ids=["73007-1"],
            amount=Decimal("98.00"),
        ),
    ),
    ScenarioTemplate(
        "ambiguous-email",
        "Hamid",
        "hamid@example.test",
        "Refund my recent order",
        (
            "Please refund the defective item from my recent order. I cannot find the order number.",
            "One of my two latest purchases is damaged, but I do not know which order ID it was.",
            "Can you refund the broken product on this email? I have two orders and no receipt handy.",
        ),
        ExpectedOutcome(action=ResolutionAction.ESCALATE),
    ),
    ScenarioTemplate(
        "duplicate-refund",
        "Ivo",
        "ivo@example.test",
        "Refund not visible yet",
        (
            "Please refund order 73010 again. I cannot see the earlier refund on my card.",
            "The refund for #73010 has not appeared, so can you issue another one?",
            "I was told item 73010-1 was refunded. It is missing from my statement and I need help.",
        ),
        ExpectedOutcome(action=ResolutionAction.ESCALATE, order_id="73010"),
    ),
    ScenarioTemplate(
        "lost-shipment",
        "June",
        "june@example.test",
        "Backpack never arrived",
        (
            "Order 73011 has not arrived and tracking stopped. Please send a replacement.",
            "My Trail Backpack from #73011 appears lost in transit. I would like it replaced.",
            "The carrier never delivered item 73011-1. Can you replace the backpack?",
        ),
        ExpectedOutcome(
            action=ResolutionAction.REPLACEMENT,
            order_id="73011",
            line_item_ids=["73011-1"],
        ),
    ),
    ScenarioTemplate(
        "outside-window",
        "Kai",
        "kai@example.test",
        "Unused tote return",
        (
            "The unused tote from order 73012 is not for me. It arrived 20 days ago and I want a refund.",
            "Can I return untouched item 73012-1 after twenty days? Please refund it.",
            "Order #73012 is unused, but I waited 20 days before asking to send it back.",
        ),
        ExpectedOutcome(action=ResolutionAction.REJECT, order_id="73012"),
    ),
    ScenarioTemplate(
        "discounted-quantity",
        "Lara",
        "lara@example.test",
        "Wrong-color tees",
        (
            "Both tees in order 73013 arrived in the wrong color. Refund the $120 list price for the inconvenience.",
            "Order #73013 has two incorrect shirts. I paid after a discount, but I want $120 back.",
            "You sent the wrong color for both units of item 73013-1. Please refund the order.",
        ),
        ExpectedOutcome(
            action=ResolutionAction.REFUND,
            order_id="73013",
            line_item_ids=["73013-1"],
            amount=Decimal("80.00"),
        ),
    ),
)


def build_cases() -> tuple[TicketInput, ...]:
    """Expand each scenario into two discovery and one held-out phrasing."""
    cases: list[TicketInput] = []
    for scenario in SCENARIOS:
        for index, body in enumerate(scenario.bodies):
            variant = chr(ord("a") + index)
            cases.append(
                TicketInput(
                    ticket_id=f"{scenario.scenario_id}-{variant}",
                    customer_name=scenario.customer_name,
                    email=scenario.email,
                    subject=scenario.subject,
                    body=body,
                )
            )
    return tuple(cases)


CASES = build_cases()
DISCOVERY_CASES = tuple(case for case in CASES if not case.ticket_id.endswith("-c"))
HELD_OUT_CASES = tuple(case for case in CASES if case.ticket_id.endswith("-c"))
EXPECTED_OUTCOMES = {
    f"{scenario.scenario_id}-{variant}": scenario.expected
    for scenario in SCENARIOS
    for variant in ("a", "b", "c")
}
