import { useState, useEffect, useRef } from 'react';
import StraddleTable from './components/StraddleTable';
import './index.css';

const API_BASE = `http://${window.location.hostname}:5031/api`;
const WS_URL = `ws://${window.location.hostname}:5031/ws/orderdepth`;

function App() {
  const [constituents, setConstituents] = useState([]);
  const [selectedUnderlying, setSelectedUnderlying] = useState("");
  const [endDates, setEndDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [optionsData, setOptionsData] = useState([]);
  const [realtimeData, setRealtimeData] = useState({});
  const [underlyingQuote, setUnderlyingQuote] = useState(null);
  const [autoFocus, setAutoFocus] = useState(true);
  
  const wsRef = useRef(null);
  const tableContainerRef = useRef(null);

  // Fetch underlying instruments on mount
  useEffect(() => {
    fetch(`${API_BASE}/constituents`)
      .then(res => res.json())
      .then(data => {
        if (data.constituents) {
          setConstituents(data.constituents);
          if (data.constituents.length > 0) {
            setSelectedUnderlying(data.constituents[0].orderbookId);
          }
        }
      })
      .catch(err => console.error("Error fetching constituents", err));
  }, []);

  // Fetch available dates when underlying changes
  useEffect(() => {
    if (!selectedUnderlying) return;
    
    fetch(`${API_BASE}/options?underlying_id=${selectedUnderlying}`)
      .then(res => res.json())
      .then(data => {
        if (data.filterOptions && data.filterOptions.endDates) {
          const dates = [];
          data.filterOptions.endDates.forEach(month => {
             if (month.children) {
               month.children.forEach(day => dates.push(day.value));
             } else {
               dates.push(month.value);
             }
          });
          setEndDates(dates);
          if (dates.length > 0) {
             setSelectedDate(dates[0]);
          } else {
             setOptionsData([]);
          }
        }
      })
      .catch(err => console.error("Error fetching dates", err));
  }, [selectedUnderlying]);

  // Fetch options matrix when date or underlying changes
  useEffect(() => {
    if (!selectedUnderlying || !selectedDate || endDates.length === 0 || !endDates.includes(selectedDate)) return;
    
    fetch(`${API_BASE}/options?underlying_id=${selectedUnderlying}&end_date=${selectedDate}`)
      .then(res => res.json())
      .then(data => {
        if (data.matchedOptions) {
          setOptionsData(data.matchedOptions);
          // Subscribe to WS
          const orderbookIds = [];
          data.matchedOptions.forEach(opt => {
            if (opt.call) orderbookIds.push(opt.call.orderbookId);
            if (opt.put) orderbookIds.push(opt.put.orderbookId);
          });
          subscribeWs(orderbookIds, selectedUnderlying);
        }
      })
      .catch(err => console.error("Error fetching options", err));
  }, [selectedUnderlying, selectedDate, endDates]);

  const subscribeWs = (orderbookIds, underlyingId) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      const ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        ws.send(JSON.stringify({ action: "subscribe", orderbookIds, underlyingId }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "updates" && Array.isArray(msg.data)) {
          let hasQuote = false;
          let quoteData = null;
          let hasOrders = false;
          const orderUpdates = {};
          
          msg.data.forEach(item => {
            if (item._type === "quote") {
              hasQuote = true;
              quoteData = item;
            } else if (item.orderbookId) {
              hasOrders = true;
              orderUpdates[item.orderbookId] = item;
            }
          });
          
          if (hasQuote) setUnderlyingQuote(quoteData);
          if (hasOrders) {
            setRealtimeData(prev => ({...prev, ...orderUpdates}));
          }
        }
      };
      ws.onclose = () => {
         wsRef.current = null;
      };
      wsRef.current = ws;
    } else {
      wsRef.current.send(JSON.stringify({ action: "subscribe", orderbookIds, underlyingId }));
    }
  };

  const handleScroll = () => {
    if (autoFocus) {
      setAutoFocus(false);
    }
  };

  return (
    <div className="App">
      <div className="header-row">
        <h1>OMXS30 Option Chain</h1>
        
        {underlyingQuote && (
          <div 
            className="quote-display" 
            onClick={() => !autoFocus && setAutoFocus(true)}
            style={{ 
              background: autoFocus ? 'rgba(255,255,255,0.05)' : 'rgba(59, 130, 246, 0.2)', 
              cursor: autoFocus ? 'default' : 'pointer',
              padding: '8px 16px', 
              borderRadius: '8px', 
              flexGrow: 1, 
              textAlign: 'center',
              transition: 'background 0.2s',
              border: autoFocus ? '1px solid transparent' : '1px solid rgba(59, 130, 246, 0.5)'
            }}
            title={!autoFocus ? "Click to resume auto-focus" : ""}
          >
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {autoFocus ? "Underlying Price: " : "Resume Auto-Focus: "}
            </span>
            <strong style={{ fontSize: '1.25rem', color: underlyingQuote.changePercent > 0 ? '#4ade80' : underlyingQuote.changePercent < 0 ? '#f87171' : 'white' }}>
              {underlyingQuote.lastPrice || underlyingQuote.buyPrice || '-'}
            </strong>
            <span style={{ marginLeft: '8px', fontSize: '0.85rem', color: underlyingQuote.changePercent > 0 ? '#4ade80' : underlyingQuote.changePercent < 0 ? '#f87171' : 'white' }}>
              {underlyingQuote.changePercent ? (underlyingQuote.changePercent * 100).toFixed(2) + '%' : ''}
            </span>
          </div>
        )}

        <div className="controls">
          <select 
            className="dropdown" 
            value={selectedUnderlying} 
            onChange={e => setSelectedUnderlying(e.target.value)}
          >
            {constituents.map(c => (
              <option key={c.orderbookId} value={c.orderbookId}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>
      
      {endDates.length > 0 && (
        <div className="tabs-container">
          {(() => {
            const getDTE = (dateStr) => {
              const target = new Date(dateStr);
              const today = new Date();
              target.setHours(0, 0, 0, 0);
              today.setHours(0, 0, 0, 0);
              const diffTime = target - today;
              return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            };
            
            const formatTabDate = (dateStr) => {
              const [year, month, day] = dateStr.split('-');
              const dte = getDTE(dateStr);
              return `${month}${day} ${dte}DTE`;
            };

            return endDates.map(date => (
              <div 
                key={date} 
                className={`tab ${selectedDate === date ? 'active' : ''}`}
                onClick={() => setSelectedDate(date)}
              >
                {formatTabDate(date)}
              </div>
            ));
          })()}
        </div>
      )}
      
      <div 
        className="glass-panel table-container" 
        ref={tableContainerRef}
        onWheel={handleScroll}
        onTouchMove={handleScroll}
      >
        <StraddleTable 
          optionsData={optionsData} 
          realtimeData={realtimeData} 
          underlyingPrice={underlyingQuote ? (underlyingQuote.lastPrice || underlyingQuote.buyPrice) : null}
          autoFocus={autoFocus}
          containerRef={tableContainerRef}
        />
      </div>
    </div>
  );
}

export default App;
