# OMXS30 Real-Time Option Chain & IBKR Auto-Trader

This project provides a real-time "straddle-style" option chain table for the constituents of the OMX Stockholm 30 (OMXS30) index, fetching live data directly from the Avanza API. It is also deeply integrated with Interactive Brokers (IBKR) to automatically execute trades using an advanced algorithmic "Walk-The-Book" pricing engine.

## Functionality

- **Live Market Data**: Displays real-time bid, ask, and volume data for call and put options via Avanza.
- **Dynamic Selection**: Users can choose any of the 30 OMXS30 constituent stocks and filter options by specific expiry dates (weekly and monthly).
- **Auto-Focus and Highlight**: The application automatically scrolls the table to center the strike price closest to the current underlying stock price.
- **IBKR Trade Integration**: Click on bids/asks to build order tickets (single legs, straddles, spreads) in a mobile-friendly "Order Panel" bottom sheet.
- **Walk-The-Book Algorithm**: When you place an order, the system doesn't just submit a market order. It places a limit order at a favorable price (the "Mid" or better) and slowly walks the price down to the absolute boundary every few seconds until it gets filled.
  - Dynamically calculates valid Nasdaq OMX tick increments (0.01, 0.05, 0.10, 0.20 SEK).
  - Avoids market maker "fleeing order" defenses by explicitly cancelling and placing fresh orders instead of modifying existing ones.
  - Provides a real-time, cancellable progress tracker in the UI.
- **Take Profit / Stop Loss**: Automatically attach GTC Bracket orders to your option trades.
- **Mobile Friendly**: The UI is optimized to fit on small mobile screens with compact styling, slide-up order panels, and responsive touch targets.

## Architecture

The system is separated into a Python backend and a React frontend to efficiently process rapid market data streams and manage IBKR orders without overwhelming the user interface.

### Backend (Python / FastAPI)

- **REST Endpoints**: Serves static data, Avanza lists, and IBKR configuration.
- **Real-Time Data Aggregator**: Connects to the Avanza Server-Sent Events (SSE) web push service for option order depths and underlying quotes.
- **WebSocket Multiplexer**: Rapidly incoming SSE messages are buffered and pushed to the frontend via a WebSocket connection at 1-second intervals.
- **IBKR Gateway Integration**: Uses `ib_async` to connect to IB Gateway/TWS, qualify contracts, map Avanza symbols to IBKR format (`symbol_map.json`), and run asynchronous order execution tasks.

### Frontend (React / Vite)

- Built with Vite and React for fast performance.
- Establishes a single WebSocket connection to the backend to receive multiplexed market data and walk-the-book progress updates.
- Features a slide-up `OrderPanel` to review multi-leg combos, verify net-credit/debit limits, and track order execution.
- Includes a Hamburger `SettingsMenu` to dynamically configure the IBKR IP/Port connection directly from the browser.

## Prerequisites

- Node.js (for the frontend)
- Python 3.10+ (for the backend)
- Interactive Brokers TWS or IB Gateway running locally or on your network.
- A valid Avanza session. You must provide a `secret.json` file in the root folder to handle authentication tokens.

### Avanza Authentication Setup (`secret.json`)

To authenticate with the Avanza API, copy the provided `secret.json.sample` to `secret.json` and fill in your details:

```json
{
  "username": "your_avanza_username",
  "password": "your_avanza_password",
  "totpSecret": "YOUR_TOTP_SECRET_STRING",
  "accountId": "your_avanza_account_id"
}
```

**Note on `totpSecret`:** This is the Time-based One-Time Password secret used for Two-Factor Authentication. Refer to the [avanza-api documentation](https://github.com/Qluxzz/avanza#getting-a-totp-secret).

## How to Build and Run

### 1. IB Gateway / TWS Setup

Ensure IB Gateway or TWS is running and API access is enabled. By default, the frontend will attempt to connect to `127.0.0.1:4002` (Paper Trading), but this can be adjusted in the UI Settings Menu.

### 2. Backend Setup

First, navigate to the project directory and create a Python virtual environment:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Start the FastAPI backend server (runs on `http://0.0.0.0:5031`):

```bash
python backend_main.py
```

### 3. Frontend Setup

Open a new terminal window, navigate to the `frontend` directory, and install the Node dependencies:

```bash
cd frontend
npm install
```

Start the Vite development server:

```bash
npm run dev -- --host --port 5175
```

### 4. Usage

Open `http://localhost:5175` (or your machine's local IP on your mobile device) in your browser.
Use the top-left menu to configure and connect to IBKR, then select any OMXS30 constituent to view live quotes and start trading!
