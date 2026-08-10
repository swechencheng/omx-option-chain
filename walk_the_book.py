"""Walk-the-book order execution for OMX options via IBKR.

Adapted from option_copy_trader/option_trader.py with key differences:
- No market sell: both buy and sell always walk the book
- Safety cap = bid/ask price (not the +50%/$1 formula)
- Walk step = minTick from IBKR (detected per contract)
- Walk interval = 6s default, configurable
- GTC orders with outsideRth=True and usePriceMgmtAlgo=True
- Optional bracket (TP/SL) attachment
- Async generator for progress reporting to frontend
"""

import asyncio
import logging
import re
from dataclasses import dataclass, field
from typing import AsyncGenerator

from ib_async import IB, LimitOrder, StopOrder, Option

logger = logging.getLogger("walk_the_book")

# IBKR sentinel values for uninitialized int fields
IB_UNSET_INT = 2147483647
IB_UNSET_LONG = 9223372036854775807


@dataclass
class WalkProgress:
    """Progress update sent to the frontend during walk-the-book."""

    status: str  # "walking", "repricing", "filled", "cancelled", "error", "cap_hit"
    current_price: float = 0.0
    step: int = 0
    fill_price: float | None = None
    message: str = ""


@dataclass
class OrderRequest:
    """Describes an order to be executed via walk-the-book."""

    contract: Option
    action: str  # "BUY" or "SELL"
    quantity: int = 1
    mid_price: float = 0.0
    bid_price: float = 0.0
    ask_price: float = 0.0
    walk_step: float = 0.05  # Will be overridden by minTick from IBKR
    walk_interval: int = 6
    # Optional bracket
    tp_enabled: bool = False
    tp_price: float = 0.0
    sl_enabled: bool = False
    sl_price: float = 0.0


def snap_to_valid_tick(price: float) -> float:
    """Snap price to the nearest valid OMX tick size."""
    sign = 1 if price >= 0 else -1
    abs_p = abs(price)
    if abs_p < 0.50:
        tick = 0.01
    elif abs_p < 10.00:
        tick = 0.05
    elif abs_p < 20.00:
        tick = 0.10
    else:
        tick = 0.20
    snapped = round(round(abs_p / tick) * tick, 2)
    return sign * snapped


def get_next_price(price: float, direction: int) -> float:
    """Calculate the next price step based on OMX premium tick sizes.
    direction: 1 for UP, -1 for DOWN.
    """
    sign = 1 if price >= 0 else -1
    abs_p = abs(price)
    is_increasing = (direction * sign) > 0
    if is_increasing:
        if abs_p < 0.50:
            tick = 0.01
        elif abs_p < 10.00:
            tick = 0.05
        elif abs_p < 20.00:
            tick = 0.10
        else:
            tick = 0.20
    else:
        if abs_p <= 0.50:
            tick = 0.01
        elif abs_p <= 10.00:
            tick = 0.05
        elif abs_p <= 20.00:
            tick = 0.10
        else:
            tick = 0.20
    return round(price + (direction * tick), 2)


async def walk_the_book(
    ib: IB,
    req: OrderRequest,
) -> AsyncGenerator[WalkProgress, None]:
    """Execute a walk-the-book order and yield progress updates.

    For BUY: starts at mid_price, walks UP by walk_step toward ask_price (safety cap).
    For SELL: starts at mid_price, walks DOWN by walk_step toward bid_price (safety cap).

    All orders are GTC with outsideRth=True and usePriceMgmtAlgo=True.
    """
    if req.bid_price == 0 and req.ask_price == 0:
        logger.error(
            f"Invalid prices for {req.contract.localSymbol or req.contract.secType}: mid={req.mid_price}, bid={req.bid_price}, ask={req.ask_price}"
        )
        yield WalkProgress(
            status="error",
            message=f"Invalid price (Bid {req.bid_price}, Mid {req.mid_price}, Ask {req.ask_price})",
        )
        return
    contract = req.contract
    action = req.action.upper()
    tick = req.walk_step

    if action == "BUY":
        start_price = snap_to_valid_tick(req.mid_price)
        safety_cap = req.ask_price
        # If we start with a net credit (negative mid price), cap the walk at -tick to avoid 0
        if req.mid_price < 0 and safety_cap >= 0:
            safety_cap = snap_to_valid_tick(-0.01)

        walk_direction = 1  # Walk UP (1 unit of tick)
        cap_desc = "ask price (or < 0 for credit)"
    else:
        start_price = snap_to_valid_tick(req.mid_price)
        safety_cap = req.ask_price
        walk_direction = -1  # Walk DOWN (-1 unit of tick)
        cap_desc = "worst execution price (ask_price from UI)"

    current_price = start_price
    step_count = 0
    logger.info(f"Walk-the-book {action} {contract.localSymbol or contract.secType}")
    logger.info(f"  Start: {current_price}, Cap: {safety_cap} ({cap_desc})")
    logger.info(f"  Step: {tick}, Interval: {req.walk_interval}s")

    # Build parent order
    parent_order = LimitOrder(
        action=action,
        totalQuantity=req.quantity,
        lmtPrice=current_price,
        tif="GTC",
    )
    parent_order.overridePercentageConstraints = True

    # Pre-assign order IDs
    parent_id = ib.client.getReqId()
    parent_order.orderId = parent_id

    # Bracket orders if requested
    tp_order = None
    tp_trade = None
    sl_order = None
    sl_trade = None

    if req.tp_enabled or req.sl_enabled:
        parent_order.transmit = False

        if req.tp_enabled and req.tp_price > 0:
            tp_id = ib.client.getReqId()
            sell_action = "SELL" if action == "BUY" else "BUY"
            tp_order = LimitOrder(
                action=sell_action,
                totalQuantity=req.quantity,
                lmtPrice=req.tp_price,
                tif="GTC",
            )
            tp_order.overridePercentageConstraints = True
            tp_order.orderId = tp_id
            tp_order.parentId = parent_id
            tp_order.transmit = False if req.sl_enabled else True

        if req.sl_enabled and req.sl_price > 0:
            sl_id = ib.client.getReqId()
            sell_action = "SELL" if action == "BUY" else "BUY"
            sl_order = StopOrder(
                action=sell_action,
                totalQuantity=req.quantity,
                stopPrice=req.sl_price,
                tif="GTC",
                outsideRth=True,
            )
            sl_order.overridePercentageConstraints = True
            sl_order.orderId = sl_id
            sl_order.parentId = parent_id
            sl_order.transmit = True  # Last child transmits the whole bracket
    else:
        parent_order.transmit = True

    # Error handler for price rejections
    rejected_price = None

    def _on_error(reqId, errorCode, errorString, err_contract):
        nonlocal rejected_price
        if errorCode == 202 and reqId == getattr(parent_order, "orderId", None):
            if "closer to the current market price of" in errorString:
                m = re.search(r"current market price of ([0-9.]+)", errorString)
                if m:
                    rejected_price = float(m.group(1).rstrip("."))

    ib.errorEvent += _on_error

    try:
        # Place orders
        parent_trade = ib.placeOrder(contract, parent_order)
        if tp_order:
            tp_trade = ib.placeOrder(contract, tp_order)
        if sl_order:
            sl_trade = ib.placeOrder(contract, sl_order)

        yield WalkProgress(
            status="walking",
            current_price=current_price,
            step=step_count,
            message=f"Order placed at {current_price:.2f}",
        )

        # Walk-the-book loop
        while True:
            await asyncio.sleep(req.walk_interval)
            await asyncio.sleep(0.1)  # Extra tick for status propagation

            status = parent_trade.orderStatus.status
            logger.info(f"  Step {step_count}: status={status}, price={current_price}")

            if status == "Filled":
                fill_price = parent_trade.orderStatus.avgFillPrice
                logger.info(f"  Filled at {fill_price}")
                yield WalkProgress(
                    status="filled",
                    current_price=current_price,
                    step=step_count,
                    fill_price=fill_price,
                    message=f"Filled at {fill_price:.2f}",
                )
                return

            if status in ("Cancelled", "ApiCancelled", "Inactive", "ValidationError"):
                # If it's a validation error, we must abort immediately.
                if status == "ValidationError":
                    logger.error("  Validation Error from IBKR! Aborting walk.")
                    cancel_msg = "ValidationError"
                    if hasattr(parent_trade, "log") and parent_trade.log:
                        for log_entry in reversed(parent_trade.log):
                            if log_entry.message:
                                cancel_msg = f"{status}: {log_entry.message}"
                                break
                    yield WalkProgress(
                        status="error",
                        current_price=current_price,
                        step=step_count,
                        message=cancel_msg,
                    )
                    return

                # Handle price rejection
                if rejected_price is not None:
                    adjustment = 0.97 if action == "BUY" else 1.03
                    current_price = _round_to_tick(rejected_price * adjustment, tick)
                    logger.warning(
                        f"  Rejected at {rejected_price}. Restarting from {current_price}"
                    )
                    rejected_price = None

                    # Re-create orders with new IDs
                    parent_id = ib.client.getReqId()
                    parent_order.orderId = parent_id
                    parent_order.lmtPrice = current_price

                    if tp_order:
                        tp_order.orderId = ib.client.getReqId()
                        tp_order.parentId = parent_id
                    if sl_order:
                        sl_order.orderId = ib.client.getReqId()
                        sl_order.parentId = parent_id

                    parent_trade = ib.placeOrder(contract, parent_order)
                    if tp_order:
                        tp_trade = ib.placeOrder(contract, tp_order)
                    if sl_order:
                        sl_trade = ib.placeOrder(contract, sl_order)

                    yield WalkProgress(
                        status="repricing",
                        current_price=current_price,
                        step=step_count,
                        message=f"Price rejected, restarting at {current_price:.2f}",
                    )
                    continue

                logger.error(f"  Order cancelled/inactive: {status}")

                cancel_msg = status
                if hasattr(parent_trade, "log") and parent_trade.log:
                    for log_entry in reversed(parent_trade.log):
                        if log_entry.message:
                            cancel_msg = log_entry.message
                            break

                yield WalkProgress(
                    status="cancelled",
                    current_price=current_price,
                    step=step_count,
                    message=f"{cancel_msg}",
                )
                return

            # Not filled → walk the price
            step_count += 1
            prev_price = current_price
            current_price = get_next_price(current_price, walk_direction)

            # Strict sign change / zero check
            # Do not allow crossing 0 or reaching exactly 0
            if (prev_price < 0 and current_price >= 0) or (
                prev_price > 0 and current_price <= 0
            ):
                logger.info(
                    f"  Cap hit: Cannot cross or reach 0 (tried to walk from {prev_price} to {current_price})"
                )
                ib.cancelOrder(parent_order)
                await asyncio.sleep(1)
                yield WalkProgress(
                    status="cap_hit",
                    current_price=prev_price,
                    step=step_count,
                    message="Safety cap reached: prevented from crossing zero (credit to debit or vice versa)",
                )
                return

            # Safety cap check
            if action == "BUY" and current_price > safety_cap:
                logger.info(f"  Cap hit: {current_price} > {safety_cap}")
                ib.cancelOrder(parent_order)
                await asyncio.sleep(1)
                yield WalkProgress(
                    status="cap_hit",
                    current_price=current_price,
                    step=step_count,
                    message=f"Safety cap ({cap_desc}) reached at {safety_cap:.2f}",
                )
                return
            elif action == "SELL" and current_price < safety_cap:
                logger.info(f"  Cap hit: {current_price} < {safety_cap}")
                ib.cancelOrder(parent_order)
                await asyncio.sleep(1)
                yield WalkProgress(
                    status="cap_hit",
                    current_price=current_price,
                    step=step_count,
                    message=f"Safety cap ({cap_desc}) reached at {safety_cap:.2f}",
                )
                return

            # Cancel old order, wait 3s, submit NEW order (avoids "fleeing order" effect)
            logger.info(f"  Cancelling old order and waiting 3s before walking...")
            ib.cancelOrder(parent_order)
            yield WalkProgress(
                status="walking",
                current_price=prev_price,
                step=step_count,
                message=f"Cancelling order, waiting 3s before step...",
            )

            await asyncio.sleep(3)

            if parent_trade.orderStatus.status == "Filled":
                fill_price = parent_trade.orderStatus.avgFillPrice
                logger.info(f"  Filled at {fill_price} during cancellation!")
                yield WalkProgress(
                    status="filled",
                    current_price=prev_price,
                    step=step_count,
                    fill_price=fill_price,
                    message=f"Filled at {fill_price:.2f}",
                )
                return

            # Generate new IDs for the new order chain
            parent_id = ib.client.getReqId()
            parent_order.orderId = parent_id
            parent_order.lmtPrice = current_price

            if req.tp_enabled or req.sl_enabled:
                parent_order.transmit = False
            else:
                parent_order.transmit = True

            if tp_order:
                tp_order.orderId = ib.client.getReqId()
                tp_order.parentId = parent_id
            if sl_order:
                sl_order.orderId = ib.client.getReqId()
                sl_order.parentId = parent_id

            parent_trade = ib.placeOrder(contract, parent_order)
            if tp_order:
                tp_trade = ib.placeOrder(contract, tp_order)
            if sl_order:
                sl_trade = ib.placeOrder(contract, sl_order)

            logger.info(f"  Placed NEW order at {current_price}")
            yield WalkProgress(
                status="walking",
                current_price=current_price,
                step=step_count,
                message=f"Placed new order at {current_price:.2f}",
            )

    except asyncio.CancelledError:
        logger.info("Walk task cancelled by user, cancelling active orders.")
        if parent_order:
            ib.cancelOrder(parent_order)
        if tp_order:
            ib.cancelOrder(tp_order)
        if sl_order:
            ib.cancelOrder(sl_order)
        raise
    finally:
        ib.errorEvent -= _on_error
