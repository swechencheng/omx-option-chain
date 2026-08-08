import React, { useEffect, useRef, useState, useMemo } from 'react';

const AnimatedCell = ({ value, className = "" }) => {
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

  return <td className={`${className} ${flash}`}>{value !== null && value !== undefined ? value : "-"}</td>;
};

const StraddleTable = ({ optionsData, realtimeData, underlyingPrice, autoFocus, containerRef }) => {
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

          return (
            <tr 
              key={`${strike}-${idx}`}
              ref={el => rowRefs.current[strike] = el}
            >
              <AnimatedCell value={rtCall.buyVolume} className="call-col" />
              <AnimatedCell value={rtCall.buyPrice} className="call-col" />
              <AnimatedCell value={rtCall.sellPrice} className="call-col" />
              <AnimatedCell value={rtCall.sellVolume} className="call-col" />
              
              <td className="strike-col" style={isClosest ? { color: '#38bdf8', background: 'rgba(255, 255, 255, 0.08)' } : {}}>{strike}</td>
              
              <AnimatedCell value={rtPut.buyVolume} className="put-col" />
              <AnimatedCell value={rtPut.buyPrice} className="put-col" />
              <AnimatedCell value={rtPut.sellPrice} className="put-col" />
              <AnimatedCell value={rtPut.sellVolume} className="put-col" />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export default StraddleTable;
