"""Singleton IBKR connection manager using ib_async.

Provides connect/disconnect, contract qualification, and tick size detection.
"""

import asyncio
import json
import logging
import os

from ib_async import IB, Option, Stock, Index

logger = logging.getLogger("ibkr_client")

# Path to the symbol map (Avanza orderbookId → IBKR symbol)
_SYMBOL_MAP_PATH = os.path.join(os.path.dirname(__file__), "symbol_map.json")

# Per-device IBKR config persistence
_CONFIGS_PATH = os.path.join(os.path.dirname(__file__), "ibkr_configs.json")


def _load_symbol_map() -> dict:
    if os.path.exists(_SYMBOL_MAP_PATH):
        with open(_SYMBOL_MAP_PATH, "r") as f:
            return json.load(f)
    return {}


class IBKRClient:
    """Manages a single ib_async connection to IBKR TWS/GW."""

    def __init__(self):
        self.ib = IB()
        self._host = "127.0.0.1"
        self._port = 4002
        self._client_id = 50
        self._tick_cache: dict[str, float] = {}  # conId → minTick

    @property
    def connected(self) -> bool:
        return self.ib.isConnected()

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        return self._port

    async def connect(self, host: str, port: int):
        """Connect to IBKR TWS/GW."""
        if self.connected:
            self.ib.disconnect()

        self._host = host
        self._port = port
        try:
            await self.ib.connectAsync(host, port, clientId=self._client_id)
            logger.info(f"Connected to IBKR at {host}:{port}")
        except Exception as e:
            logger.error(f"Failed to connect to IBKR at {host}:{port}: {e}")
            raise

    def disconnect(self):
        """Disconnect from IBKR."""
        if self.connected:
            self.ib.disconnect()
            logger.info("Disconnected from IBKR")

    async def qualify_option(
        self,
        avanza_underlying_id: str,
        expiry: str,
        strike: float,
        right: str,
    ) -> Option | None:
        """Build and qualify an IBKR Option contract from Avanza option data.

        Args:
            avanza_underlying_id: The Avanza orderbookId of the underlying stock.
            expiry: Expiration date in YYYY-MM-DD format.
            strike: Strike price.
            right: "C" for call, "P" for put.

        Returns:
            Qualified Option contract, or None if qualification fails.
        """
        # Reload dynamically to pick up any changes without restart
        symbol_map = _load_symbol_map()
        mapping = symbol_map.get(str(avanza_underlying_id))
        if not mapping:
            logger.error(
                f"No IBKR symbol mapping for Avanza orderbookId {avanza_underlying_id}"
            )
            return None

        ibkr_expiry = expiry.replace("-", "")
        contract = Option(
            symbol=mapping["ibkr_symbol"],
            lastTradeDateOrContractMonth=ibkr_expiry,
            strike=strike,
            right=right,
            exchange=mapping.get("exchange", "OMS"),
            currency=mapping.get("currency", "SEK"),
        )

        try:
            qualified = await self.ib.qualifyContractsAsync(contract)
            if qualified and contract.conId > 0:
                logger.info(f"Qualified: {contract.localSymbol} conId={contract.conId}")
                return contract
            else:
                logger.error(f"Could not qualify contract: {contract}")
                return None
        except Exception as e:
            logger.error(f"Error qualifying contract: {e}")
            return None

    async def get_tick_size(self, contract: Option) -> float:
        """Get the minimum tick size for a contract via reqContractDetails.

        Caches results by conId to avoid repeated API calls.

        Returns:
            minTick value (e.g. 0.05 for most OMX stock options).
        """
        con_id = str(contract.conId)
        if con_id in self._tick_cache:
            return self._tick_cache[con_id]

        try:
            details_list = await self.ib.reqContractDetailsAsync(contract)
            if details_list:
                min_tick = details_list[0].minTick
                self._tick_cache[con_id] = min_tick
                logger.info(f"Tick size for {contract.localSymbol}: {min_tick}")
                return min_tick
        except Exception as e:
            logger.error(f"Error fetching tick size: {e}")

        # Fallback default for OMX stock options
        default_tick = 0.05
        logger.warning(
            f"Using default tick size {default_tick} for {contract.localSymbol}"
        )
        return round(float(default_tick), 2)

    async def get_valid_expiries(self, avanza_underlying_id: str) -> list[str]:
        """Get all valid Option expirations (YYYYMMDD) for an underlying."""
        if not self.connected:
            return []

        sym_map = _load_symbol_map()
        map_info = sym_map.get(str(avanza_underlying_id))
        if not map_info:
            return []

        ibkr_symbol = map_info["ibkr_symbol"]
        exchange = map_info.get("exchange", "OMS")
        currency = map_info.get("currency", "SEK")
        sec_type = map_info.get("secType", "STK")

        if sec_type == "IND":
            stk = Index(ibkr_symbol, "OMS", currency)
        else:
            stk = Stock(ibkr_symbol, "SFB", currency)

        try:
            await self.ib.qualifyContractsAsync(stk)
        except Exception as e:
            logger.error(f"Failed to qualify stock {ibkr_symbol} to get expiries: {e}")
            return []

        try:
            chains = await self.ib.reqSecDefOptParamsAsync(
                stk.symbol, "", stk.secType, stk.conId
            )
        except Exception as e:
            logger.error(f"Failed to get option params for {ibkr_symbol}: {e}")
            return []

        expiries = set()
        for chain in chains:
            if chain.exchange == exchange:
                expiries.update(chain.expirations)

        return sorted(list(expiries))


# --- Per-device config persistence ---


def load_device_configs() -> dict:
    if os.path.exists(_CONFIGS_PATH):
        try:
            with open(_CONFIGS_PATH, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_device_config(device_id: str, host: str, port: int):
    configs = load_device_configs()
    configs[device_id] = {"host": host, "port": port}
    with open(_CONFIGS_PATH, "w") as f:
        json.dump(configs, f, indent=2)


def get_device_config(device_id: str) -> dict | None:
    configs = load_device_configs()
    return configs.get(device_id)


# Singleton instance
_ibkr_client: IBKRClient | None = None


def get_ibkr_client() -> IBKRClient:
    global _ibkr_client
    if _ibkr_client is None:
        _ibkr_client = IBKRClient()
    return _ibkr_client
