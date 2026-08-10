import { useState, useEffect, useRef } from 'react';

const SettingsMenu = ({ apiBase, deviceId, onConnectionChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('4002');
  const [connected, setConnected] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const menuRef = useRef(null);

  // Load saved config on mount
  useEffect(() => {
    fetch(`${apiBase}/ibkr/config?device_id=${deviceId}`)
      .then(r => r.json())
      .then(data => {
        if (data.host) setHost(data.host);
        if (data.port) setPort(String(data.port));
      })
      .catch(() => {});

    // Check current connection status
    checkStatus();
  }, []);

  const checkStatus = () => {
    fetch(`${apiBase}/ibkr/status`)
      .then(r => r.json())
      .then(data => {
        setConnected(data.connected);
        onConnectionChange?.(data.connected);
      })
      .catch(() => {});
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen]);

  const saveAndConnect = async () => {
    setLoading(true);
    setStatusMsg('');
    try {
      // Save config
      await fetch(
        `${apiBase}/ibkr/config?device_id=${deviceId}&host=${encodeURIComponent(host)}&port=${port}`,
        { method: 'POST' }
      );

      // Connect
      const res = await fetch(
        `${apiBase}/ibkr/connect?device_id=${deviceId}`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (data.error) {
        setStatusMsg(`Error: ${data.error}`);
        setConnected(false);
      } else {
        setStatusMsg(`Connected to ${data.host}:${data.port}`);
        setConnected(true);
      }
      onConnectionChange?.(data.status === 'connected');
    } catch (e) {
      setStatusMsg(`Error: ${e.message}`);
    }
    setLoading(false);
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await fetch(`${apiBase}/ibkr/disconnect`, { method: 'POST' });
      setConnected(false);
      setStatusMsg('Disconnected');
      onConnectionChange?.(false);
    } catch (e) {
      setStatusMsg(`Error: ${e.message}`);
    }
    setLoading(false);
  };

  return (
    <div className="settings-wrapper" ref={menuRef}>
      <button
        className="hamburger-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Settings"
      >
        ☰
      </button>

      {isOpen && (
        <div className="settings-overlay">
          <div className="settings-header">
            <span>IBKR Connection</span>
            <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          </div>

          <div className="settings-field">
            <label>Host</label>
            <input
              type="text"
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>

          <div className="settings-field">
            <label>Port</label>
            <input
              type="number"
              value={port}
              onChange={e => setPort(e.target.value)}
              placeholder="4002"
            />
          </div>

          {statusMsg && (
            <div className="settings-status">{statusMsg}</div>
          )}

          <div className="settings-actions">
            {!connected ? (
              <button
                className="settings-btn connect"
                onClick={saveAndConnect}
                disabled={loading}
              >
                {loading ? 'Connecting...' : 'Connect'}
              </button>
            ) : (
              <button
                className="settings-btn disconnect"
                onClick={handleDisconnect}
                disabled={loading}
              >
                {loading ? 'Disconnecting...' : 'Disconnect'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsMenu;
