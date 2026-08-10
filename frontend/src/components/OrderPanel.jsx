import { useState, useRef, useEffect } from 'react';

const OrderPanel = ({ selectedLegs, onClearLegs, wsRef, apiBase, ibkrConnected, ibkrSupportsExpiry, underlyingId, selectedDate, walkState, onWalkStateChange: setWalkState }) => {
  const [expanded, setExpanded] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [tpEnabled, setTpEnabled] = useState(false);
  const [tpPrice, setTpPrice] = useState('');
  const [slEnabled, setSlEnabled] = useState(false);
  const [slPrice, setSlPrice] = useState('');
  const [showConfirmation, setShowConfirmation] = useState(false);
  const panelRef = useRef(null);
  const dragStartY = useRef(null);

  const handleClose = () => {
    setWalkState(null);
    setShowConfirmation(false);
    setExpanded(false);
    onClearLegs();
  };

  // Listen for walk_progress messages from the websocket
  useEffect(() => {
    if (!wsRef?.current) return;
    const ws = wsRef.current;

    const originalOnMessage = ws.onmessage;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'walk_progress') {
        setWalkState(msg.data);
        if (msg.data.status === 'filled') {
          setShowConfirmation(true);
        } else if (msg.data.status === 'cancelled') {
          handleClose();
        } else if (msg.data.status === 'error') {
          alert(`Order Error: ${msg.data.message}`);
          handleClose();
        }
      }
      // Call original handler for other message types
      if (originalOnMessage && msg.type !== 'walk_progress') {
        originalOnMessage(event);
      }
    };

    return () => {
      if (ws && ws.onmessage) {
        ws.onmessage = originalOnMessage;
      }
    };
  }, [wsRef?.current]);

  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (selectedLegs && selectedLegs.length > 0) {
      setIsVisible(true);
    } else {
      setIsVisible(false);
      setExpanded(false);
      setWalkState(null);
      setShowConfirmation(false);
    }
  }, [selectedLegs]);

  // Keep it rendered to allow exit animation, but handle empty array cases safely
  const safeLegs = selectedLegs || [];

  // Calculate prices from selected legs
  const legsSummary = safeLegs.map(leg => {
    const mid = leg.bidPrice && leg.askPrice
      ? ((leg.bidPrice + leg.askPrice) / 2).toFixed(2)
      : '-';
    return { ...leg, mid };
  });

  const totalBid = selectedLegs.reduce((sum, l) => {
    const sign = l.action === 'BUY' ? 1 : -1;
    // For a BUY order we usually pay the ASK price, but totalBid means the bid of the spread:
    // To sell the spread (bid of the spread), you sell the BUY legs at their bid, and buy back the SELL legs at their ask.
    // Wait, let's just make it simple: cost of the leg at bid/ask.
    // Cost to buy leg = askPrice. Cost to sell leg = -bidPrice.
    // "Bid" of the spread = what you get if you SELL the spread.
    // Selling the spread = Sell the BUY legs (at bid), Buy the SELL legs (at ask).
    // Let's just calculate it as:
    const price = l.action === 'BUY' ? l.bidPrice : l.askPrice;
    return sum + sign * (price || 0);
  }, 0);

  const totalAsk = selectedLegs.reduce((sum, l) => {
    const sign = l.action === 'BUY' ? 1 : -1;
    // Ask of the spread = what you pay if you BUY the spread.
    // Buying the spread = Buy the BUY legs (at ask), Sell the SELL legs (at bid).
    const price = l.action === 'BUY' ? l.askPrice : l.bidPrice;
    return sum + sign * (price || 0);
  }, 0);

  const totalMid = selectedLegs.reduce((sum, l) => {
    const sign = l.action === 'BUY' ? 1 : -1;
    if (l.bidPrice && l.askPrice) {
      return sum + sign * ((l.bidPrice + l.askPrice) / 2);
    }
    return sum;
  }, 0);

  // Determine overall action (if all legs same direction)
  const isBuy = safeLegs.length > 0 && safeLegs.every(l => l.action === 'BUY');
  const isSell = safeLegs.length > 0 && safeLegs.every(l => l.action === 'SELL');
  const actionLabel = isBuy ? 'BUY' : isSell ? 'SELL' : 'MIXED';
  const actionColor = isBuy ? 'buy' : 'sell';

  const toggleExpanded = () => {
    if (!walkState) {
      setExpanded(!expanded);
    }
  };

  const handleDragStart = (e) => {
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartY.current = clientY;
  };

  const handleDragEnd = (e) => {
    if (dragStartY.current === null) return;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const diff = dragStartY.current - clientY;
    if (diff > 50 && !walkState) {
      setExpanded(true);
    } else if (diff < -50) {
      setExpanded(false);
    }
    dragStartY.current = null;
  };

  const placeOrder = () => {
    if (!wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!ibkrConnected) return;

    // Place order for all legs in a single payload
    const msg = {
      action: 'place_order',
      underlyingId: underlyingId,
      expiry: selectedDate,
      legs: selectedLegs.map(leg => ({
        strike: leg.strike,
        right: leg.right,
        action: leg.action,
        bidPrice: leg.bidPrice || 0,
        askPrice: leg.askPrice || 0,
      })),
      quantity: quantity,
      midPrice: totalMid,
      bidPrice: totalBid,
      askPrice: totalAsk,
      tpEnabled: tpEnabled,
      tpPrice: parseFloat(tpPrice) || 0,
      slEnabled: slEnabled,
      slPrice: parseFloat(slPrice) || 0,
    };
    wsRef.current.send(JSON.stringify(msg));

    setWalkState({ status: 'walking', currentPrice: 0, step: 0, message: 'Order submitted...' });
  };

  const cancelWalk = () => {
    if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'cancel_walk' }));
    }
  };

  const legsLabel = selectedLegs.length === 1
    ? `${selectedLegs[0].name || ''} ${selectedLegs[0].right} ${selectedLegs[0].strike}`
    : `${selectedLegs.length} legs`;

  // Confirmation view
  if (showConfirmation) {
    return (
      <div className={`order-panel expanded ${isVisible ? 'visible' : ''}`}>
        <div className="order-confirmation">
          <div className="confirmation-icon">✅</div>
          <div className="confirmation-title">Order Filled</div>
          <div className="confirmation-detail">
            <span>Fill Price:</span>
            <strong>{walkState?.fillPrice?.toFixed(2) || '-'}</strong>
          </div>
          <div className="confirmation-detail">
            <span>Contract:</span>
            <strong>{legsLabel}</strong>
          </div>
          <div className="confirmation-detail">
            <span>Quantity:</span>
            <strong>{quantity}</strong>
          </div>
          <button className="settings-btn connect" onClick={handleClose}>Close</button>
        </div>
      </div>
    );
  }

  // Expanded view (bracket order form)
  if (expanded) {
    return (
      <div className={`order-panel expanded ${isVisible ? 'visible' : ''}`}>
        <div
          className="order-panel-handle"
          onClick={toggleExpanded}
          onMouseDown={handleDragStart}
          onMouseUp={handleDragEnd}
          onTouchStart={handleDragStart}
          onTouchEnd={handleDragEnd}
        >
          <div className="handle-bar" />
        </div>

        <div className="order-expanded-content">
          <div className="order-legs-table">
            <div className="order-legs-header">Selected Legs</div>
            {selectedLegs.map((leg, i) => (
              <div key={i} className="order-leg-row">
                <span className={`leg-action ${leg.action === 'BUY' ? 'buy' : 'sell'}`}>
                  {leg.action}
                </span>
                <span className="leg-detail">{leg.right === 'C' ? 'Call' : 'Put'} {leg.strike}</span>
                <span className="leg-price">
                  Bid {leg.bidPrice || '-'} / Ask {leg.askPrice || '-'}
                </span>
              </div>
            ))}
          </div>

          <div className="order-field">
            <label>Quantity</label>
            <input
              type="number"
              min="1"
              value={quantity}
              onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
            />
          </div>

          <div className="order-bracket-section">
            <div className="bracket-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={tpEnabled}
                  onChange={e => setTpEnabled(e.target.checked)}
                />
                Take Profit (TP)
              </label>
              {tpEnabled && (
                <input
                  type="number"
                  step="0.05"
                  value={tpPrice}
                  onChange={e => setTpPrice(e.target.value)}
                  placeholder="TP limit price"
                  className="bracket-price-input"
                />
              )}
            </div>

            <div className="bracket-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={slEnabled}
                  onChange={e => setSlEnabled(e.target.checked)}
                />
                Stop Loss (SL)
              </label>
              {slEnabled && (
                <input
                  type="number"
                  step="0.05"
                  value={slPrice}
                  onChange={e => setSlPrice(e.target.value)}
                  placeholder="SL stop price"
                  className="bracket-price-input"
                />
              )}
            </div>
          </div>

          {!ibkrSupportsExpiry && ibkrConnected && (
            <div className="expiry-warning" style={{color: '#f44336', fontSize: '0.85rem', marginBottom: '8px', textAlign: 'center'}}>
              ⚠️ IBKR does not support options for this expiry date.
            </div>
          )}

          <button
            className={`order-submit-btn ${actionColor}`}
            onClick={placeOrder}
            disabled={!ibkrConnected || !ibkrSupportsExpiry || !!walkState}
          >
            {walkState
              ? `Walking... ${walkState.currentPrice?.toFixed(2) || ''} (step ${walkState.step})`
              : `${actionLabel} @ Mid ${totalMid.toFixed(2)}`
            }
          </button>

          {walkState && walkState.status === 'walking' && (
            <button className="order-cancel-btn" onClick={cancelWalk}>Cancel Walk</button>
          )}
        </div>
      </div>
    );
  }

  // Collapsed peek bar
  return (
    <div
      className={`order-panel peek ${isVisible ? 'visible' : ''}`}
      ref={panelRef}
      onMouseDown={handleDragStart}
      onMouseUp={handleDragEnd}
      onTouchStart={handleDragStart}
      onTouchEnd={handleDragEnd}
    >
      <div
        className="order-panel-handle"
        onClick={toggleExpanded}
      >
        <div className="handle-bar" />
      </div>

      <div className="order-peek-content">
        <div className="order-peek-info" onClick={toggleExpanded}>
          <span className={`peek-action ${actionColor}`}>{actionLabel}</span>
          <span className="peek-legs">{legsLabel}</span>
          <span className="peek-qty">×{quantity}</span>
        </div>

        {walkState ? (
          <button 
            className={`order-progress-btn ${actionColor}`}
            onClick={(e) => {
              e.stopPropagation();
              if (walkState.status === 'walking') {
                cancelWalk();
              } else {
                setWalkState(null);
              }
            }}
            title={walkState.status === 'walking' ? "Click to cancel walk" : "Click to dismiss"}
          >
            <div className="progress-text">
              {walkState.status === 'walking' && `Cancel: ${walkState.currentPrice?.toFixed(2)} (step ${walkState.step})`}
              {walkState.status === 'cap_hit' && 'Cap hit'}
              {walkState.status === 'cancelled' && `Cancelled${walkState.message ? ': ' + walkState.message : ''}`}
              {walkState.status === 'error' && `Error: ${walkState.message || 'Unknown'}`}
            </div>
          </button>
        ) : (
          <button
            className={`order-place-btn ${actionColor}`}
            onClick={(e) => { e.stopPropagation(); placeOrder(); }}
            disabled={!ibkrConnected || !ibkrSupportsExpiry}
          >
            <div className="btn-prices">
              <span className="btn-price-label">Bid</span>
              <span className="btn-price-label">Mid</span>
              <span className="btn-price-label">Ask</span>
            </div>
            <div className="btn-prices">
              <span>{totalBid.toFixed(2)}</span>
              <span>{totalMid.toFixed(2)}</span>
              <span>{totalAsk.toFixed(2)}</span>
            </div>
          </button>
        )}
      </div>
    </div>
  );
};

export default OrderPanel;
