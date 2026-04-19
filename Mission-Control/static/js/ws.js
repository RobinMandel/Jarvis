// WebSocket client with auto-reconnect + coordinated reload v2
MC.ws = (function() {
  let socket = null;
  let handlers = {};
  let wasConnected = false;
  let pollTimer = null;
  let _staleTimer = null;

  function _resetStaleTimer() {
    if (_staleTimer) clearTimeout(_staleTimer);
    _staleTimer = setTimeout(() => {
      var dot = document.querySelector('#connection-status .status-dot');
      var label = document.querySelector('#connection-status .status-label');
      if (dot && dot.classList.contains('online')) {
        dot.className = 'status-dot stale';
        if (label) label.textContent = 'Idle';
        if (MC.updateGatewayBadge) MC.updateGatewayBadge('stale');
      }
    }, 60000);
  }

  // Coordinated reload state
  let _knownVersion = null;
  let _reloadPending = false;
  let _reloadWaitingStreams = [];  // session_ids we're waiting on

  function connect() {
    if (MC.updateGatewayBadge) MC.updateGatewayBadge('connecting');

    try {
      socket = new WebSocket(MC.config.wsUrl);
    } catch (e) {
      startPolling();
      return;
    }

    socket.onopen = () => {
      const isReconnect = wasConnected;
      wasConnected = true;
      stopPolling();
      updateStatus(true);
      _resetStaleTimer();
      send({ type: 'chat.list_sessions' });
      if (isReconnect) {
        if (handlers['_ws_reconnect']) handlers['_ws_reconnect'].forEach(fn => fn());
      }
    };

    socket.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const type = data.type;

        // Handle server version + coordinated reload
        if (type === 'system.version') {
          if (!_knownVersion) {
            _knownVersion = data.version;
            // Fresh server restart — fire event so chat can show continuation prompt
            if (data.restarted && wasConnected) {
              if (handlers['_ws_server_restarted']) handlers['_ws_server_restarted'].forEach(fn => fn(data));
            }
          } else if (data.version !== _knownVersion) {
            console.log('[WS] Server version changed:', _knownVersion, '→', data.version);
            _initiateCoordinatedReload(data.active_streams || []);
            return;
          }
          // Auto-subscribe active streams on reconnect
          if (data.active_streams && data.active_streams.length) {
            if (handlers['system.version']) handlers['system.version'].forEach(fn => fn(data));
          }
          return;
        }

        if (type === 'system.reload_required') {
          console.log('[WS] Reload requested by server');
          _initiateCoordinatedReload(data.active_streams || []);
          return;
        }

        // If reload is pending, track when streams finish
        if (_reloadPending && type === 'chat.done') {
          _reloadWaitingStreams = _reloadWaitingStreams.filter(s => s !== data.session_id);
          _updateReloadBanner();
          if (_reloadWaitingStreams.length === 0) {
            _doReload();
          }
        }

        if (handlers[type]) handlers[type].forEach(fn => fn(data));
        _resetStaleTimer();
      } catch {}
    };

    socket.onclose = () => {
      if (_staleTimer) clearTimeout(_staleTimer);
      updateStatus(false);
      if (handlers['_ws_close']) handlers['_ws_close'].forEach(fn => fn());
      startPolling();
    };

    socket.onerror = () => {
      try { socket.close(); } catch (_) {}
    };
  }

  // ── Coordinated Reload ──────────────────────────────────────────────────
  function _initiateCoordinatedReload(activeStreams) {
    if (_reloadPending) return; // already in progress

    // Check which streams are active in THIS client (chat + multi-chat panels)
    const myStreams = [];
    // Main chat
    if (MC.chat && MC.chat.isStreaming && MC.chat.activeSession) {
      myStreams.push(MC.chat.activeSession);
    }
    // Multi-chat panels
    if (MC.multiChat && MC.multiChat.getStreamingSessions) {
      myStreams.push(...MC.multiChat.getStreamingSessions());
    }

    // Streams on server that this client cares about
    _reloadWaitingStreams = activeStreams.filter(s => myStreams.includes(s));

    if (_reloadWaitingStreams.length === 0) {
      // No active streams — mark pending immediately so send() blocks chat.send
      _reloadPending = true;
      showBanner('Update wird geladen...');
      setTimeout(_doReload, 80);
      return;
    }

    // Streams are active — wait for them to finish
    _reloadPending = true;
    _updateReloadBanner();

    // Safety timeout: force reload after 30s even if streams haven't finished
    setTimeout(() => {
      if (_reloadPending) {
        console.log('[WS] Force reload after timeout');
        _doReload();
      }
    }, 30000);

    // Fallback: if reload still hasn't happened after 45s, cancel pending state
    // so user isn't stuck unable to send messages
    setTimeout(() => {
      if (_reloadPending) {
        console.warn('[WS] Reload stuck — cancelling pending state to unblock chat');
        _reloadPending = false;
        var banner = document.getElementById('ws-reconnect-banner');
        if (banner) banner.style.display = 'none';
      }
    }, 45000);
  }

  function _updateReloadBanner() {
    const n = _reloadWaitingStreams.length;
    if (n > 0) {
      showBanner(`Update bereit — warte auf ${n} laufende${n > 1 ? ' Instanzen' : ' Instanz'}...`, 'reload');
    } else {
      showBanner('Alle Instanzen fertig — lade neu...', 'reload');
    }
  }

  function _doReload() {
    _reloadPending = false;
    showBanner('Seite wird neu geladen...', 'reload');
    setTimeout(() => location.reload(), 200);
  }

  // ── Polling ──────────────────────────────────────────────────────────────
  function startPolling() {
    if (pollTimer) return;
    if (MC.updateGatewayBadge) MC.updateGatewayBadge('connecting');

    if (wasConnected) {
      showBanner('Server neustart erkannt — reconnecte...');
    }

    pollTimer = setInterval(() => {
      fetch('/api/health', { cache: 'no-store' })
        .then(r => {
          if (r.ok) {
            r.json().then(d => {
              // Check if server version changed during reconnect
              if (_knownVersion && d.version && d.version !== _knownVersion) {
                // Version changed — will trigger reload after WS connects
                console.log('[WS] New server version detected during polling:', d.version);
              }
              stopPolling();
              connect();
            }).catch(() => { stopPolling(); connect(); });
          }
        })
        .catch(() => {});
    }, 2000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    var banner = document.getElementById('ws-reconnect-banner');
    if (banner && !_reloadPending) banner.style.display = 'none';
  }

  function send(msg) {
    // _reloadPending no longer blocks sends — only shows a banner.
    // Blocking caused stuck-chat bugs when reload failed or looped.
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function on(type, fn) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(fn);
  }

  function off(type, fn) {
    if (!handlers[type]) return;
    handlers[type] = handlers[type].filter(h => h !== fn);
  }

  function updateStatus(online) {
    var dot = document.querySelector('#connection-status .status-dot');
    var label = document.querySelector('#connection-status .status-label');
    if (dot) dot.className = 'status-dot ' + (online ? 'online' : 'offline');
    if (label) label.textContent = online ? 'Verbunden' : 'Offline';
    if (MC.updateGatewayBadge) MC.updateGatewayBadge(online ? 'connected' : 'disconnected');
  }

  function showBanner(text, type) {
    var banner = document.getElementById('ws-reconnect-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'ws-reconnect-banner';
      document.body.appendChild(banner);
    }
    const isReload = type === 'reload';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:10000;' +
      'padding:8px 16px;font-size:12px;font-family:var(--font-mono);' +
      'text-align:center;border-bottom:1px solid;' +
      (isReload
        ? 'background:rgba(234,179,8,0.12);color:#eab308;border-color:rgba(234,179,8,0.2);'
        : 'background:rgba(59,130,246,0.12);color:#60a5fa;border-color:rgba(59,130,246,0.15);');
    banner.textContent = text;
    banner.style.display = 'block';
  }

  // Force-reset stuck state (callable from console or other modules)
  function resetPendingReload() {
    if (_reloadPending) {
      console.warn('[WS] Manual reset of _reloadPending');
      _reloadPending = false;
      _reloadWaitingStreams = [];
      var banner = document.getElementById('ws-reconnect-banner');
      if (banner) banner.style.display = 'none';
    }
  }

  return { connect, send, on, off, resetPendingReload };
})();
