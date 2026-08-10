import os
import json
import logging
import argparse
from typing import List, Optional
import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from avanza_instance import get_avanza
from sse_aggregator import SSEAggregator
from ibkr_client import (
    get_ibkr_client,
    save_device_config,
    get_device_config,
)
from walk_the_book import walk_the_book, OrderRequest
from ib_async import Contract, ComboLeg

# CLI args
parser = argparse.ArgumentParser()
parser.add_argument(
    "--walk-interval", type=int, default=6, help="Walk interval in seconds"
)
args, _ = parser.parse_known_args()

WALK_INTERVAL = args.walk_interval

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global caches
OMXS30_CACHE = None

logger = logging.getLogger("backend")


def fetch_omxs30():
    global OMXS30_CACHE
    if OMXS30_CACHE is not None:
        return OMXS30_CACHE
    avanza = get_avanza()
    response = avanza._session.get(
        "https://www.avanza.se/_api/market-index/19002",
        headers={"X-SecurityToken": getattr(avanza, "_security_token", "")},
    )
    if response.status_code == 200:
        OMXS30_CACHE = response.json().get("constituents", [])
    return OMXS30_CACHE


@app.get("/api/constituents")
def get_constituents():
    data = fetch_omxs30()
    return {"constituents": data}


@app.get("/api/options")
def get_options(underlying_id: str, end_date: Optional[str] = None):
    avanza = get_avanza()
    url = "https://www.avanza.se/_api/market-option-future-forward-list/matrix"
    payload = {
        "filter": {
            "optionTypes": [],
            "yearMonths": [],
            "endDates": [end_date] if end_date else [],
            "underlyingInstruments": [underlying_id],
            "callIndicators": [],
        },
        "limit": 300,
        "offset": 0,
        "sortBy": {"field": "strikePrice", "order": "desc"},
    }

    response = avanza._session.post(
        url,
        json=payload,
        headers={
            "X-SecurityToken": getattr(avanza, "_security_token", ""),
            "Content-Type": "application/json",
        },
    )

    if response.status_code == 200:
        return response.json()
    else:
        return {"error": response.status_code, "detail": response.text}


# --- IBKR endpoints ---


@app.get("/api/ibkr/status")
def ibkr_status():
    client = get_ibkr_client()
    return {
        "connected": client.connected,
        "host": client.host,
        "port": client.port,
    }


@app.post("/api/ibkr/config")
async def ibkr_set_config(
    device_id: str = Query(...),
    host: str = Query(...),
    port: int = Query(...),
):
    save_device_config(device_id, host, port)
    return {"status": "saved", "device_id": device_id, "host": host, "port": port}


@app.get("/api/ibkr/config")
def ibkr_get_config(device_id: str = Query(...)):
    config = get_device_config(device_id)
    if config:
        return config
    return {"host": "127.0.0.1", "port": 4001}


@app.post("/api/ibkr/connect")
async def ibkr_connect(device_id: str = Query(...)):
    config = get_device_config(device_id)
    if not config:
        return {"error": "No config saved for this device. Set config first."}

    client = get_ibkr_client()
    try:
        await client.connect(config["host"], config["port"])
        return {"status": "connected", "host": config["host"], "port": config["port"]}
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/ibkr/disconnect")
async def ibkr_disconnect():
    client = get_ibkr_client()
    client.disconnect()
    return {"status": "disconnected"}


@app.post("/api/ibkr/tick-size")
async def ibkr_tick_size(
    underlying_id: str = Query(...),
    expiry: str = Query(...),
    strike: float = Query(...),
    right: str = Query(...),
):
    client = get_ibkr_client()
    if not client.connected:
        return {"error": "Not connected to IBKR"}

    contract = await client.qualify_option(underlying_id, expiry, strike, right)
    if not contract:
        return {"error": "Could not qualify contract"}

    tick = await client.get_tick_size(contract)
    return {
        "min_tick": tick,
        "local_symbol": contract.localSymbol,
        "con_id": contract.conId,
    }


# --- WebSocket endpoint (extended with order placement) ---


# Track active walk tasks per websocket so they can be cancelled
_walk_tasks: dict[int, asyncio.Task] = {}


@app.websocket("/ws/orderdepth")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    aggregator = None
    ws_id = id(websocket)

    async def flush_callback(items):
        try:
            await websocket.send_json({"type": "updates", "data": items})
        except Exception:
            pass  # client disconnected

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")

            if action == "subscribe" and "orderbookIds" in data:
                orderbook_ids = data["orderbookIds"]
                underlying_id = data.get("underlyingId")
                if aggregator:
                    await aggregator.stop()
                aggregator = SSEAggregator(callback=flush_callback, flush_interval=1.0)
                await aggregator.start(orderbook_ids, underlying_id)

            elif action == "place_order":
                await _handle_place_order(websocket, data, ws_id)

            elif action == "cancel_walk":
                task = _walk_tasks.get(ws_id)
                if task and not task.done():
                    task.cancel()
                    await websocket.send_json(
                        {
                            "type": "walk_progress",
                            "data": {
                                "status": "cancelled",
                                "message": "Walk cancelled by user",
                            },
                        }
                    )

    except WebSocketDisconnect:
        # Clean up walk task
        task = _walk_tasks.pop(ws_id, None)
        if task and not task.done():
            task.cancel()
        if aggregator:
            await aggregator.stop()


async def _handle_place_order(websocket: WebSocket, data: dict, ws_id: int):
    """Handle a place_order message from the WebSocket."""
    client = get_ibkr_client()
    if not client.connected:
        await websocket.send_json(
            {
                "type": "walk_progress",
                "data": {"status": "error", "message": "Not connected to IBKR"},
            }
        )
        return

    # Extract order params
    underlying_id = data.get("underlyingId", "")
    expiry = data.get("expiry", "")
    legs_data = data.get("legs", [])
    if not legs_data:
        # Fallback for old UI format if needed
        legs_data = [
            {
                "strike": float(data.get("strike", 0)),
                "right": data.get("right", "C"),
                "action": data.get("orderAction", "BUY"),
            }
        ]

    quantity = int(data.get("quantity", 1))
    mid_price = float(data.get("midPrice", 0))
    bid_price = float(data.get("bidPrice", 0))
    ask_price = float(data.get("askPrice", 0))
    walk_interval = int(data.get("walkInterval", WALK_INTERVAL))

    # Bracket
    tp_enabled = data.get("tpEnabled", False)
    tp_price = float(data.get("tpPrice", 0))
    sl_enabled = data.get("slEnabled", False)
    sl_price = float(data.get("slPrice", 0))

    # Qualify the contracts
    qualified_legs = []
    max_tick = 0.01
    for leg in legs_data:
        strike = float(leg.get("strike", 0))
        right = leg.get("right", "C")
        c = await client.qualify_option(underlying_id, expiry, strike, right)
        if not c:
            await websocket.send_json(
                {
                    "type": "walk_progress",
                    "data": {
                        "status": "error",
                        "message": f"Could not qualify contract for {underlying_id} {expiry} {strike} {right}",
                    },
                }
            )
            return
        qualified_legs.append(c)
        tick = await client.get_tick_size(c)
        if tick > max_tick:
            max_tick = tick

    if len(qualified_legs) == 1:
        contract = qualified_legs[0]
        action = legs_data[0].get("action", "BUY")

        # Single leg prices must be strictly positive.
        # The frontend computes negative prices for SELL actions for consistency with spreads.
        mid_price = abs(mid_price)
        bid_price = abs(bid_price)
        ask_price = abs(ask_price)
    else:
        # Build BAG contract
        contract = Contract(
            secType="BAG",
            symbol=qualified_legs[0].symbol,
            exchange=qualified_legs[0].exchange,
            currency=qualified_legs[0].currency,
        )
        contract.comboLegs = []
        for q_leg, req_leg in zip(qualified_legs, legs_data):
            combo_leg = ComboLeg(
                conId=q_leg.conId,
                ratio=1,
                action=req_leg.get("action", "BUY"),
                exchange=q_leg.exchange,
            )
            contract.comboLegs.append(combo_leg)
        action = "BUY"

    req = OrderRequest(
        contract=contract,
        action=action,
        quantity=quantity,
        mid_price=mid_price,
        bid_price=bid_price,
        ask_price=ask_price,
        walk_step=max_tick,
        walk_interval=walk_interval,
        tp_enabled=tp_enabled,
        tp_price=tp_price,
        sl_enabled=sl_enabled,
        sl_price=sl_price,
    )

    # Cancel any existing walk for this websocket
    old_task = _walk_tasks.pop(ws_id, None)
    if old_task and not old_task.done():
        old_task.cancel()

    # Run walk in background task
    async def _run_walk():
        try:
            async for progress in walk_the_book(client.ib, req):
                try:
                    await websocket.send_json(
                        {
                            "type": "walk_progress",
                            "data": {
                                "status": progress.status,
                                "currentPrice": progress.current_price,
                                "step": progress.step,
                                "fillPrice": progress.fill_price,
                                "message": progress.message,
                            },
                        }
                    )
                except Exception:
                    break
        except asyncio.CancelledError:
            logger.info("Walk task cancelled")
        except Exception as e:
            logger.error(f"Walk task error: {e}")
            try:
                await websocket.send_json(
                    {
                        "type": "walk_progress",
                        "data": {"status": "error", "message": str(e)},
                    }
                )
            except Exception:
                pass

    task = asyncio.create_task(_run_walk())
    _walk_tasks[ws_id] = task


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5031)
