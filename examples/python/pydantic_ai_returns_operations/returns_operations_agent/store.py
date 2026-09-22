"""Deterministic local implementations of the commerce tools."""

from decimal import Decimal

from returns_operations_agent.fixtures import ORDERS, POLICIES, SHIPMENTS
from returns_operations_agent.models import (
    ActionReceipt,
    OrderLookup,
    PolicyLookup,
    ResolutionAction,
    ShippingStatus,
)

_CATEGORY_ALIASES = {
    "backpack": "accessories",
    "cap": "apparel",
    "carry-on": "luggage",
    "hoodie": "apparel",
    "jacket": "apparel",
    "loafers": "footwear",
    "mug": "accessories",
    "shirt": "apparel",
    "shoes": "footwear",
    "sneakers": "footwear",
    "tee": "apparel",
    "tote": "accessories",
}


class MockCommerceStore:
    """Hold synthetic commerce data and record local side effects."""

    def __init__(self) -> None:
        """Initialize an isolated copy of the fixture data."""
        self.orders = {
            key: value.model_copy(deep=True) for key, value in ORDERS.items()
        }
        self.actions: list[ActionReceipt] = []

    def lookup_order(
        self, order_id: str | None = None, email: str | None = None
    ) -> OrderLookup:
        """Look up an order by exact order number or customer email."""
        if order_id is not None and order_id in self.orders:
            return OrderLookup(
                found=True,
                orders=[self.orders[order_id]],
                message="One order matched the supplied order number.",
            )
        if email is not None:
            matches = [order for order in self.orders.values() if order.email == email]
            if matches:
                return OrderLookup(
                    found=True,
                    orders=matches,
                    message=f"{len(matches)} order(s) matched the supplied email.",
                )
        return OrderLookup(
            found=False,
            message="No order matched the supplied information.",
        )

    def get_return_policy(self, category: str) -> PolicyLookup:
        """Return a policy by canonical category or common product alias."""
        normalized = _CATEGORY_ALIASES.get(category.lower(), category.lower())
        policy = POLICIES.get(normalized)
        if policy is None:
            return PolicyLookup(
                found=False,
                message=(
                    f"No policy matched {category!r}. Use the category returned "
                    "by lookup_order."
                ),
            )
        return PolicyLookup(
            found=True,
            policy=policy,
            message=f"Policy matched canonical category {normalized!r}.",
        )

    def check_shipping(self, tracking_no: str) -> ShippingStatus:
        """Return the current synthetic carrier status."""
        status = SHIPMENTS.get(tracking_no)
        if status is not None:
            return status
        return ShippingStatus(
            tracking_no=tracking_no,
            status="unknown",
            detail="No synthetic carrier record matched this tracking number.",
        )

    def issue_refund(
        self, order_id: str, line_item_ids: list[str], amount: Decimal
    ) -> ActionReceipt:
        """Record a synthetic refund without enforcing policy approval rules."""
        order = self.orders.get(order_id)
        if order is None:
            return self._reject_action(
                ResolutionAction.REFUND,
                "Refund rejected because the order does not exist.",
                order_id=order_id,
                line_item_ids=line_item_ids,
                amount=amount,
            )
        known_line_ids = {line.line_item_id for line in order.lines}
        if not line_item_ids or not set(line_item_ids) <= known_line_ids:
            return self._reject_action(
                ResolutionAction.REFUND,
                "Refund rejected because the selected line items are invalid.",
                order_id=order_id,
                line_item_ids=line_item_ids,
                amount=amount,
            )
        remaining = order.amount_paid - order.refunded_amount
        if amount <= 0 or amount > remaining:
            return self._reject_action(
                ResolutionAction.REFUND,
                f"Refund rejected. The maximum remaining amount is {remaining}.",
                order_id=order_id,
                line_item_ids=line_item_ids,
                amount=amount,
            )
        order.refunded_amount += amount
        order.refunded_line_item_ids.extend(
            line_id
            for line_id in line_item_ids
            if line_id not in order.refunded_line_item_ids
        )
        return self._record(
            ActionReceipt(
                accepted=True,
                action=ResolutionAction.REFUND,
                order_id=order_id,
                line_item_ids=line_item_ids,
                amount=amount,
                receipt_id=f"mock-refund-{order_id}-{len(self.actions) + 1}",
                message="Synthetic refund recorded.",
            )
        )

    def create_replacement(
        self, order_id: str, line_item_ids: list[str]
    ) -> ActionReceipt:
        """Record a synthetic replacement without creating fulfillment work."""
        order = self.orders.get(order_id)
        if order is None:
            return self._reject_action(
                ResolutionAction.REPLACEMENT,
                "Replacement rejected because the order does not exist.",
                order_id=order_id,
                line_item_ids=line_item_ids,
            )
        known_line_ids = {line.line_item_id for line in order.lines}
        if not line_item_ids or not set(line_item_ids) <= known_line_ids:
            return self._reject_action(
                ResolutionAction.REPLACEMENT,
                "Replacement rejected because the selected line items are invalid.",
                order_id=order_id,
                line_item_ids=line_item_ids,
            )
        return self._record(
            ActionReceipt(
                accepted=True,
                action=ResolutionAction.REPLACEMENT,
                order_id=order_id,
                line_item_ids=line_item_ids,
                receipt_id=f"mock-replacement-{order_id}-{len(self.actions) + 1}",
                message="Synthetic replacement recorded.",
            )
        )

    def escalate_to_human(
        self, reason: str, order_id: str | None = None
    ) -> ActionReceipt:
        """Record a synthetic escalation without contacting a support queue."""
        return self._record(
            ActionReceipt(
                accepted=True,
                action=ResolutionAction.ESCALATE,
                order_id=order_id,
                receipt_id=f"mock-escalation-{len(self.actions) + 1}",
                message=f"Synthetic escalation recorded: {reason}",
            )
        )

    def decline_request(self, order_id: str, reason: str) -> ActionReceipt:
        """Record a policy-based rejection without contacting the customer."""
        if order_id not in self.orders:
            return self._reject_action(
                ResolutionAction.REJECT,
                "Rejection could not be recorded because the order does not exist.",
                order_id=order_id,
            )
        return self._record(
            ActionReceipt(
                accepted=True,
                action=ResolutionAction.REJECT,
                order_id=order_id,
                receipt_id=f"mock-rejection-{order_id}-{len(self.actions) + 1}",
                message=f"Synthetic rejection recorded: {reason}",
            )
        )

    def _reject_action(
        self,
        action: ResolutionAction,
        message: str,
        *,
        order_id: str | None = None,
        line_item_ids: list[str] | None = None,
        amount: Decimal | None = None,
    ) -> ActionReceipt:
        """Record one rejected terminal action attempt."""
        return self._record(
            ActionReceipt(
                accepted=False,
                action=action,
                order_id=order_id,
                line_item_ids=line_item_ids or [],
                amount=amount,
                message=message,
            )
        )

    def _record(self, receipt: ActionReceipt) -> ActionReceipt:
        """Append and return one synthetic side-effect receipt."""
        self.actions.append(receipt)
        return receipt
