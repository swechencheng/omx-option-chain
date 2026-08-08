import asyncio
import logging
from typing import List, Callable, Dict, Any
from avanza_sse_client import AvanzaSSEClient
from avanza_instance import get_avanza

LOGGER = logging.getLogger("sse_aggregator")


class SSEAggregator:
    def __init__(
        self,
        callback: Callable[[List[Dict[str, Any]]], None],
        flush_interval: float = 1.0,
    ):
        self.callback = callback
        self.flush_interval = flush_interval
        self.client = None
        self.quote_client = None
        self.buffer = {}  # event_id/orderbookId -> message data
        self.running = False
        self.flush_task = None

    async def start(self, orderbook_ids: List[str], underlying_id: str = None):
        if self.running:
            await self.stop()

        self.running = True
        avanza = get_avanza()

        url = "https://www.avanza.se/_push/order-depth-web-push/"
        payload = {"orderbookIds": orderbook_ids}

        self.client = AvanzaSSEClient(
            avanza=avanza, sse_url=url, method="POST", json_payload=payload
        )
        self.client.add_listener(self.on_message)

        if underlying_id:
            quote_url = f"https://www.avanza.se/_push/quote-web-push/{underlying_id}"
            self.quote_client = AvanzaSSEClient(
                avanza=avanza, sse_url=quote_url, method="GET"
            )
            self.quote_client.add_listener(self.on_quote_message)

        # Start flush task
        self.flush_task = asyncio.create_task(self._flush_loop())

        # Start client listening
        asyncio.create_task(self.client.start())
        if self.quote_client:
            asyncio.create_task(self.quote_client.start())

    async def stop(self):
        self.running = False
        if self.client:
            await self.client.stop()
        if self.quote_client:
            await self.quote_client.stop()
        if self.flush_task:
            self.flush_task.cancel()
        self.buffer.clear()

    async def on_message(self, id: str, event: str, data: Any):
        if isinstance(data, dict) and "orderbookId" in data:
            self.buffer[data["orderbookId"]] = data
        else:
            self.buffer[id] = data

    async def on_quote_message(self, id: str, event: str, data: Any):
        if isinstance(data, dict) and "orderbookId" in data:
            # We prefix it so frontend knows it's a quote
            data["_type"] = "quote"
            self.buffer[f"quote_{data['orderbookId']}"] = data

    async def _flush_loop(self):
        while self.running:
            await asyncio.sleep(self.flush_interval)
            if self.buffer:
                # Copy and clear buffer
                items = list(self.buffer.values())
                self.buffer.clear()
                try:
                    if asyncio.iscoroutinefunction(self.callback):
                        await self.callback(items)
                    else:
                        self.callback(items)
                except Exception as e:
                    LOGGER.error(f"Error in SSE flush callback: {e}")
