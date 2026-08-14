import React, { useEffect, useRef, useState, useMemo } from 'react';

const AnimatedCell = ({ value, className = "", onClick, selected, selectedPos, disabled }) => {
  const [flash, setFlash] = useState("");
  const prevValue = useRef(value);

  useEffect(() => {
    if (value !== prevValue.current && value !== undefined && prevValue.current !== undefined) {
      if (value > prevValue.current) {
        setFlash("update-up");
      } else {
        setFlash("update-down");
      }
      const timer = setTimeout(() => setFlash(""), 1000);
      prevValue.current = value;
      return () => clearTimeout(timer);
    }
    prevValue.current = value;
  }, [value]);

  const selClass = selected 
    ? ` leg-selected-${selected}${selectedPos ? ` leg-selected-${selectedPos}` : ''}`
    : '';

  return (
    <td
      className={`${className} ${flash}${selClass}${disabled ? ' disabled-cell' : ''}`}
      onClick={disabled ? undefined : onClick}
      style={disabled ? { cursor: 'not-allowed', opacity: 0.5 } : (onClick ? { cursor: 'pointer' } : {})}
    >
      {value !== null && value !== undefined ? value : "-"}
    </td>
  );
};

const StraddleTable = ({ optionsData, realtimeData, underlyingPrice, autoFocus, containerRef, selectedLegs, onLegToggle, ibkrConnected, ibkrSupportsExpiry }) => {
  const rowRefs = useRef({});
  const hasFocusedOnce = useRef(false);

  // find closest strike
  const closestStrike = useMemo(() => {
    if (!underlyingPrice || !optionsData || optionsData.length === 0) return null;
    let minDiff = Infinity;
    let closest = null;
    optionsData.forEach(row => {
      const strike = row.call?.strikePrice || row.put?.strikePrice;
      if (strike !== undefined) {
        const diff = Math.abs(strike - underlyingPrice);
        if (diff < minDiff) {
          minDiff = diff;
          closest = strike;
        }
      }
    });
    return closest;
  }, [optionsData, underlyingPrice]);

  useEffect(() => {
    if (autoFocus && closestStrike && containerRef?.current && rowRefs.current[closestStrike]) {
      const container = containerRef.current;
      const row = rowRefs.current[closestStrike];
      
      const offset = row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2;
      container.scrollTo({ top: offset, behavior: hasFocusedOnce.current ? 'smooth' : 'auto' });
      hasFocusedOnce.current = true;
    }
  }, [autoFocus, closestStrike, containerRef]);

  if (!optionsData || optionsData.length === 0) {
    return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>No options data available for this selection.</div>;
  }

  const getRealtime = (orderbookId, defaultData) => {
    const rt = realtimeData[orderbookId];
    if (rt && rt.levels && rt.levels.length > 0) {
      const level = rt.levels[0];
      return {
        buyVolume: level.buyVolume,
        buyPrice: level.buyPrice,
        sellPrice: level.sellPrice,
        sellVolume: level.sellVolume,
      };
    }
    return defaultData || {};
  };

  // Check if a specific leg is selected
  const isLegSelected = (strike, right, action) => {
    if (!selectedLegs) return false;
    return selectedLegs.some(
      l => l.strike === strike && l.right === right && l.action === action
    );
  };

  const handleCellClick = (strike, right, action, bidPrice, askPrice, name, orderbookId) => {
    if (onLegToggle) {
      onLegToggle({ strike, right, action, bidPrice, askPrice, name, orderbookId });
    }
  };

  return (
    <table>
      <thead>
        <tr>
          <th colSpan="4" className="center call-col">Calls</th>
          <th className="center">Strike</th>
          <th colSpan="4" className="center put-col">Puts</th>
        </tr>
        <tr>
          <th>Bid Size</th>
          <th>Bid</th>
          <th>Ask</th>
          <th>Ask Size</th>
          
          <th className="strike-col">Price</th>
          
          <th>Bid Size</th>
          <th>Bid</th>
          <th>Ask</th>
          <th>Ask Size</th>
        </tr>
      </thead>
      <tbody>
        {optionsData.map((row, idx) => {
          const call = row.call || {};
          const put = row.put || {};
          const strike = call.strikePrice || put.strikePrice;
          
          const rtCall = getRealtime(call.orderbookId, call);
          const rtPut = getRealtime(put.orderbookId, put);
          
          const isClosest = strike === closestStrike;

          // Selection state for each clickable cell
          const callBidSelected = isLegSelected(strike, 'C', 'SELL') ? 'sell' : null;
          const callAskSelected = isLegSelected(strike, 'C', 'BUY') ? 'buy' : null;
          const putBidSelected = isLegSelected(strike, 'P', 'SELL') ? 'sell' : null;
          const putAskSelected = isLegSelected(strike, 'P', 'BUY') ? 'buy' : null;
          
          const globallyDisabled = !ibkrConnected || !ibkrSupportsExpiry;
          
          const callBidDisabled = globallyDisabled || rtCall.buyPrice === undefined || rtCall.buyPrice === null || rtCall.buyPrice === 0;
          const callAskDisabled = globallyDisabled || rtCall.sellPrice === undefined || rtCall.sellPrice === null || rtCall.sellPrice === 0;
          const putBidDisabled = globallyDisabled || rtPut.buyPrice === undefined || rtPut.buyPrice === null || rtPut.buyPrice === 0;
          const putAskDisabled = globallyDisabled || rtPut.sellPrice === undefined || rtPut.sellPrice === null || rtPut.sellPrice === 0;

          const isCallItm = underlyingPrice && strike < underlyingPrice;
          const isPutItm = underlyingPrice && strike > underlyingPrice;


          return (
            <tr 
              key={`${strike}-${idx}`}
              ref={el => rowRefs.current[strike] = el}
            >
              <AnimatedCell
                value={rtCall.buyVolume}
                className={`call-col ${isCallItm ? 'itm' : 'otm'}`}
                selected={callBidSelected}
                selectedPos="left"
                disabled={callBidDisabled}
                onClick={() => handleCellClick(strike, 'C', 'SELL', rtCall.buyPrice, rtCall.sellPrice, call.name, call.orderbookId)}
              />
              <AnimatedCell
                value={rtCall.buyPrice}
                className={`call-col ${isCallItm ? 'itm' : 'otm'}`}
                selected={callBidSelected}
                selectedPos="right"
                disabled={callBidDisabled}
                onClick={() => handleCellClick(strike, 'C', 'SELL', rtCall.buyPrice, rtCall.sellPrice, call.name, call.orderbookId)}
              />
              <AnimatedCell
                value={rtCall.sellPrice}
                className={`call-col ${isCallItm ? 'itm' : 'otm'}`}
                selected={callAskSelected}
                selectedPos="left"
                disabled={callAskDisabled}
                onClick={() => handleCellClick(strike, 'C', 'BUY', rtCall.buyPrice, rtCall.sellPrice, call.name, call.orderbookId)}
              />
              <AnimatedCell
                value={rtCall.sellVolume}
                className={`call-col ${isCallItm ? 'itm' : 'otm'}`}
                selected={callAskSelected}
                selectedPos="right"
                disabled={callAskDisabled}
                onClick={() => handleCellClick(strike, 'C', 'BUY', rtCall.buyPrice, rtCall.sellPrice, call.name, call.orderbookId)}
              />
              
              <td className="strike-col" style={isClosest ? { color: '#38bdf8', background: 'rgba(255, 255, 255, 0.08)' } : {}}>{strike}</td>
              
              <AnimatedCell
                value={rtPut.buyVolume}
                className={`put-col ${isPutItm ? 'itm' : 'otm'}`}
                selected={putBidSelected}
                selectedPos="left"
                disabled={putBidDisabled}
                onClick={() => handleCellClick(strike, 'P', 'SELL', rtPut.buyPrice, rtPut.sellPrice, put.name, put.orderbookId)}
              />
              <AnimatedCell
                value={rtPut.buyPrice}
                className={`put-col ${isPutItm ? 'itm' : 'otm'}`}
                selected={putBidSelected}
                selectedPos="right"
                disabled={putBidDisabled}
                onClick={() => handleCellClick(strike, 'P', 'SELL', rtPut.buyPrice, rtPut.sellPrice, put.name, put.orderbookId)}
              />
              <AnimatedCell
                value={rtPut.sellPrice}
                className={`put-col ${isPutItm ? 'itm' : 'otm'}`}
                selected={putAskSelected}
                selectedPos="left"
                disabled={putAskDisabled}
                onClick={() => handleCellClick(strike, 'P', 'BUY', rtPut.buyPrice, rtPut.sellPrice, put.name, put.orderbookId)}
              />
              <AnimatedCell
                value={rtPut.sellVolume}
                className={`put-col ${isPutItm ? 'itm' : 'otm'}`}
                selected={putAskSelected}
                selectedPos="right"
                disabled={putAskDisabled}
                onClick={() => handleCellClick(strike, 'P', 'BUY', rtPut.buyPrice, rtPut.sellPrice, put.name, put.orderbookId)}
              />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export default StraddleTable;
