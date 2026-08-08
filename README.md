# OMXS30 Real-Time Option Chain

This project provides a real-time "straddle-style" option chain table for the constituents of the OMX Stockholm 30 (OMXS30) index, fetching live data directly from the Avanza API.

## Functionality

- **Live Market Data**: Displays real-time bid, ask, and volume data for call and put options.
- **Dynamic Selection**: Users can choose any of the 30 OMXS30 constituent stocks and filter options by their specific expiry dates (including both weekly and monthly options).
- **Live Underlying Quote**: The current price of the underlying stock is displayed at the top of the application, showing dynamic changes and percent movements.
- **Auto-Focus and Highlight**: The application automatically scrolls the table to center the strike price that is closest to the current underlying stock price, highlighting the center strike column. If the user scrolls manually, auto-focus pauses and can be resumed with a single click.
- **Visual Price Movements**: Table cells flash green (for price/volume up) and red (for down) as live updates stream in.
- **Mobile Friendly**: The UI is optimized to fit on small mobile screens with compact styling.

## Architecture

The system is separated into a Python backend and a React frontend to efficiently process rapid market data streams without overwhelming the user interface.

### Backend (Python / FastAPI)

- **REST Endpoints**: Serves static and semi-static data, such as retrieving the list of OMXS30 constituent stocks and the available option series/expiries from the Avanza API.
- **Real-Time Data Aggregator**: Maintains a connection to the Avanza Server-Sent Events (SSE) web push service for both option order depths and the underlying stock quote.
- **WebSocket Multiplexer**: Rapidly incoming SSE messages are buffered and pushed to the frontend via a WebSocket connection at 1-second intervals. This throttling prevents UI lockups while maintaining real-time responsiveness.

### Frontend (React / Vite)

- Built with Vite and React for fast performance.
- Establishes a single WebSocket connection to the backend to receive multiplexed market data and quotes.
- Uses performant CSS animations for cell updates and manages its own viewport scrolling to provide a seamless user experience.

## Prerequisites

- Node.js (for the frontend)
- Python 3.10+ (for the backend)
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

**Note on `totpSecret`:** This is the Time-based One-Time Password secret used for Two-Factor Authentication. For instructions on how to extract this secret from your Avanza account, please refer to the [avanza-api documentation on getting a TOTP secret](https://github.com/Qluxzz/avanza#getting-a-totp-secret).

## How to Build and Run

### 1. Backend Setup

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

### 2. Frontend Setup

Open a new terminal window, navigate to the `frontend` directory, and install the Node dependencies:

```bash
cd frontend
npm install
```

Start the Vite development server:

```bash
npm run dev -- --host --port 5175
```

### 3. Usage

Open `http://localhost:5175` (or your machine's local IP on your mobile device) in your browser to view the real-time option chain.
