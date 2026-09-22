"""Typed inputs, outputs, and deterministic commerce records."""

from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, Field


class ResolutionAction(StrEnum):
    """Terminal outcome selected for one support ticket."""

    REFUND = "refund"
    REPLACEMENT = "replacement"
    ESCALATE = "escalate"
    REJECT = "reject"


class TicketInput(BaseModel):
    """One synthetic customer request resolved in a single invocation."""

    ticket_id: str
    customer_name: str
    email: str
    subject: str
    body: str


class Resolution(BaseModel):
    """Structured resolution and customer reply returned by the agent."""

    action: ResolutionAction
    order_id: str | None = None
    line_item_ids: list[str] = Field(default_factory=list)
    amount: Decimal | None = None
    reason: str
    customer_reply: str


class OrderLine(BaseModel):
    """One priced line in a synthetic order."""

    line_item_id: str
    product: str
    category: str
    quantity: int = 1
    unit_price: Decimal
    discount_amount: Decimal = Decimal("0.00")
    final_sale: bool = False

    @property
    def amount_paid(self) -> Decimal:
        """Calculate the amount paid for this line after discounts."""
        return self.unit_price * self.quantity - self.discount_amount


class Order(BaseModel):
    """Synthetic order returned by the commerce system."""

    order_id: str
    email: str
    lines: list[OrderLine]
    status: str
    days_since_delivery: int | None
    tracking_no: str | None = None
    risk_flags: list[str] = Field(default_factory=list)
    refunded_amount: Decimal = Decimal("0.00")
    refunded_line_item_ids: list[str] = Field(default_factory=list)

    @property
    def amount_paid(self) -> Decimal:
        """Calculate the total paid for the order."""
        return sum((line.amount_paid for line in self.lines), Decimal("0.00"))


class ReturnPolicy(BaseModel):
    """Category policy used to decide return and refund eligibility."""

    category: str
    window_days: int
    defective_full_refund: bool
    unused_return: bool
    final_sale_defect_exception: bool
    wrong_item_full_refund: bool
    human_approval_threshold: Decimal


class PolicyLookup(BaseModel):
    """Return-policy lookup result with a recoverable miss."""

    found: bool
    policy: ReturnPolicy | None = None
    message: str


class ShippingStatus(BaseModel):
    """Synthetic carrier result."""

    tracking_no: str
    status: str
    detail: str


class OrderLookup(BaseModel):
    """Order lookup result supporting exact and email searches."""

    found: bool
    orders: list[Order] = Field(default_factory=list)
    message: str


class ActionReceipt(BaseModel):
    """Recorded result of one synthetic terminal action."""

    accepted: bool
    action: ResolutionAction
    order_id: str | None = None
    line_item_ids: list[str] = Field(default_factory=list)
    amount: Decimal | None = None
    receipt_id: str | None = None
    message: str


class ExpectedOutcome(BaseModel):
    """Reviewed outcome used by deterministic demo evaluators."""

    action: ResolutionAction
    order_id: str | None = None
    line_item_ids: list[str] = Field(default_factory=list)
    amount: Decimal | None = None
