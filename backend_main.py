import os
import json
import logging
from typing import List, Optional
import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from avanza_instance import get_avanza
from sse_aggregator import SSEAggregator

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


@app.websocket("/ws/orderdepth")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    aggregator = None

    async def flush_callback(items):
        try:
            await websocket.send_json({"type": "updates", "data": items})
        except Exception:
            pass  # client disconnected

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("action") == "subscribe" and "orderbookIds" in data:
                orderbook_ids = data["orderbookIds"]
                underlying_id = data.get("underlyingId")
                if aggregator:
                    await aggregator.stop()
                aggregator = SSEAggregator(callback=flush_callback, flush_interval=1.0)
                await aggregator.start(orderbook_ids, underlying_id)
    except WebSocketDisconnect:
        if aggregator:
            await aggregator.stop()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5031)
