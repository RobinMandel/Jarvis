// Mission Control V4 — World Monitor :: CRUCIX Intelligence Terminal
// Full-screen 3D Globe · OSINT Feed · Threat Gauges · Market Ticker
(function () {
  'use strict';

  let wmRefreshTimer = null;
  let wmGlobeInstance = null;
  let wmData = null;
  let wmActiveLayers = { conflicts: true, earthquakes: true, flights: true, satellites: false, weather: false };
  let wmTimeFilter = '24H';

  // ── Dynamic Script Loader ─────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── CSS injection ─────────────────────────────────────────────────────────
  const WM_STYLE_ID = 'wm-styles-v4';
  function injectStyles() {
    if (document.getElementById(WM_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = WM_STYLE_ID;
    s.textContent = `
/* ══════════════════════════════════════════════════════════════════
   CRUCIX INTELLIGENCE TERMINAL — World Monitor V4
   ══════════════════════════════════════════════════════════════════ */
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');

:root {
  --wm-void: #020408;
  --wm-panel: rgba(6,14,22,0.85);
  --wm-accent: #64f0c8;
  --wm-blue: #44ccff;
  --wm-red: #ff5f63;
  --wm-amber: #f59e0b;
  --wm-text: #e8f4f0;
  --wm-muted: #4a6670;
}

#view-world {
  display: none;
  position: relative;
  width: 100%; height: 100%;
  background: var(--wm-void);
  overflow: hidden;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  color: var(--wm-text);
}
#view-world.active { display: block; }

/* ── Layout Grid ─────────────────────────────────────────── */
.wm-layout {
  display: grid;
  grid-template-columns: 220px 1fr 280px;
  grid-template-rows: 1fr 38px;
  height: 100%;
  width: 100%;
}
.wm-left-rail {
  grid-column: 1; grid-row: 1;
  background: var(--wm-panel);
  backdrop-filter: blur(20px);
  border-right: 1px solid rgba(100,240,200,0.08);
  padding: 16px 14px;
  overflow-y: auto;
  z-index: 10;
  display: flex; flex-direction: column; gap: 12px;
}
.wm-globe-area {
  grid-column: 2; grid-row: 1;
  position: relative;
  overflow: hidden;
  background: var(--wm-void);
}
.wm-right-rail {
  grid-column: 3; grid-row: 1;
  background: var(--wm-panel);
  backdrop-filter: blur(20px);
  border-left: 1px solid rgba(100,240,200,0.08);
  padding: 16px 14px;
  overflow-y: auto;
  z-index: 10;
  display: flex; flex-direction: column; gap: 12px;
}
.wm-bottom-ticker {
  grid-column: 1 / -1; grid-row: 2;
  background: rgba(6,14,22,0.92);
  border-top: 1px solid rgba(100,240,200,0.12);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px;
  z-index: 10;
  height: 38px;
  font-size: 11px;
}

/* ── Panel Header ─────────────────────────────────────────── */
.wm-panel-header {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--wm-accent);
  margin-bottom: 4px;
  position: relative;
  padding-bottom: 6px;
}
.wm-panel-header::after {
  content: '';
  position: absolute; bottom: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(100,240,200,0.12), transparent);
}

/* ── Separator ─────────────────────────────────────────── */
.wm-sep {
  height: 1px; width: 100%;
  background: linear-gradient(90deg, transparent, rgba(100,240,200,0.1), transparent);
  margin: 4px 0;
}

/* ── Toggle Switches ─────────────────────────────────────── */
.wm-toggle-row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0; cursor: pointer; user-select: none;
}
.wm-toggle-row:hover { opacity: 0.85; }
.wm-toggle-switch {
  width: 28px; height: 14px;
  border-radius: 7px;
  background: rgba(74,102,112,0.4);
  position: relative;
  transition: background 0.2s;
  flex-shrink: 0;
}
.wm-toggle-switch.active {
  background: rgba(100,240,200,0.25);
  box-shadow: 0 0 6px rgba(100,240,200,0.3);
}
.wm-toggle-switch::after {
  content: '';
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--wm-muted);
  transition: all 0.2s;
}
.wm-toggle-switch.active::after {
  left: 16px;
  background: var(--wm-accent);
  box-shadow: 0 0 4px var(--wm-accent);
}
.wm-toggle-label {
  font-size: 11px; color: var(--wm-text); opacity: 0.8;
}
.wm-toggle-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
}

/* ── Risk Gauge SVG ─────────────────────────────────────── */
.wm-gauge-wrap {
  display: flex; flex-direction: column; align-items: center;
  padding: 8px 0;
}
.wm-gauge-value {
  font-size: 22px; font-weight: 700;
  margin-top: -18px;
}

/* ── Stats ─────────────────────────────────────────── */
.wm-stat {
  display: flex; flex-direction: column; gap: 2px; padding: 4px 0;
}
.wm-stat-label {
  font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--wm-muted);
}
.wm-stat-value {
  font-size: 20px; font-weight: 600;
  text-shadow: 0 0 8px currentColor;
}

/* ── OSINT Feed ─────────────────────────────────────── */
.wm-feed-list {
  display: flex; flex-direction: column; gap: 8px;
  max-height: 320px; overflow-y: auto;
}
.wm-feed-list::-webkit-scrollbar { width: 3px; }
.wm-feed-list::-webkit-scrollbar-thumb { background: var(--wm-muted); border-radius: 2px; }
.wm-feed-item {
  border-left: 2px solid rgba(100,240,200,0.3);
  padding: 6px 8px;
  transition: all 0.2s;
  cursor: default;
}
.wm-feed-item:hover {
  border-left-color: var(--wm-accent);
  box-shadow: -2px 0 8px rgba(100,240,200,0.15);
  background: rgba(100,240,200,0.03);
}
.wm-feed-title {
  font-size: 12px; line-height: 1.3;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; color: var(--wm-text);
}
.wm-feed-meta {
  font-size: 10px; color: var(--wm-muted); margin-top: 3px;
  display: flex; align-items: center; gap: 6px;
}
.wm-feed-score {
  background: rgba(100,240,200,0.12);
  color: var(--wm-accent);
  padding: 1px 5px; border-radius: 3px;
  font-size: 9px; font-weight: 600;
}

/* ── Alerts ─────────────────────────────────────────── */
.wm-alert-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 0; font-size: 11px;
}
.wm-alert-dot {
  width: 6px; height: 6px; border-radius: 50%;
  animation: wmPulse 2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes wmPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

/* ── Markets mini ─────────────────────────────────── */
.wm-market-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 3px 0; font-size: 11px;
}
.wm-market-symbol { color: var(--wm-muted); }
.wm-market-price { color: var(--wm-text); }
.wm-market-change { font-size: 10px; }
.wm-market-change.up { color: var(--wm-accent); }
.wm-market-change.down { color: var(--wm-red); }

/* ── Time Filter ─────────────────────────────────── */
.wm-time-filter {
  position: absolute; top: 14px; right: 14px; z-index: 20;
  display: flex; gap: 2px;
  background: rgba(6,14,22,0.7);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(100,240,200,0.1);
  border-radius: 6px; padding: 3px;
}
.wm-time-btn {
  padding: 4px 10px; border-radius: 4px;
  font-size: 10px; font-weight: 500;
  color: var(--wm-muted); cursor: pointer;
  border: none; background: transparent;
  font-family: inherit; transition: all 0.2s;
}
.wm-time-btn:hover { color: var(--wm-text); }
.wm-time-btn.active {
  background: var(--wm-accent);
  color: var(--wm-void);
  box-shadow: 0 0 8px rgba(100,240,200,0.3);
}

/* ── CRT Scanlines ─────────────────────────────────── */
.wm-scanlines {
  position: absolute; inset: 0; pointer-events: none; z-index: 5;
  background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
  animation: wmScan 4s linear infinite;
}
@keyframes wmScan { 0%{background-position:0 0} 100%{background-position:0 100vh} }

/* ── Ticker ─────────────────────────────────────── */
.wm-ticker-left { display: flex; gap: 18px; align-items: center; }
.wm-ticker-item { display: flex; gap: 5px; align-items: center; }
.wm-ticker-symbol { color: var(--wm-muted); font-size: 10px; }
.wm-ticker-price { color: var(--wm-text); }
.wm-ticker-change { font-size: 10px; }
.wm-ticker-change.up { color: var(--wm-accent); }
.wm-ticker-change.down { color: var(--wm-red); }
.wm-ticker-center { color: var(--wm-muted); font-size: 10px; letter-spacing: 0.08em; }
.wm-ticker-right { display: flex; align-items: center; gap: 8px; }
.wm-alert-badge {
  background: rgba(255,95,99,0.15);
  color: var(--wm-red);
  padding: 2px 8px; border-radius: 4px;
  font-size: 10px; font-weight: 600;
  animation: wmAlertPulse 2s ease-in-out infinite;
}
@keyframes wmAlertPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,95,99,0.3); }
  50% { box-shadow: 0 0 8px 2px rgba(255,95,99,0.2); }
}

/* ── Globe Fallback ─────────────────────────────────── */
.wm-globe-fallback {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(100,240,200,0.03) 0%, transparent 70%);
}
.wm-globe-fallback-sphere {
  width: 360px; height: 360px; border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, rgba(100,240,200,0.08), rgba(2,4,8,0.9) 70%);
  border: 1px solid rgba(100,240,200,0.15);
  box-shadow: 0 0 60px rgba(100,240,200,0.08), inset 0 0 60px rgba(100,240,200,0.03);
  animation: wmGlobeRotate 20s linear infinite;
  position: relative; overflow: hidden;
}
@keyframes wmGlobeRotate {
  0% { box-shadow: 0 0 60px rgba(100,240,200,0.08), inset -20px 0 60px rgba(100,240,200,0.03); }
  50% { box-shadow: 0 0 60px rgba(100,240,200,0.12), inset 20px 0 60px rgba(100,240,200,0.05); }
  100% { box-shadow: 0 0 60px rgba(100,240,200,0.08), inset -20px 0 60px rgba(100,240,200,0.03); }
}
.wm-globe-fallback-grid {
  position: absolute; inset: 0;
  background:
    repeating-linear-gradient(0deg, transparent, transparent 30px, rgba(100,240,200,0.04) 30px, rgba(100,240,200,0.04) 31px),
    repeating-linear-gradient(90deg, transparent, transparent 30px, rgba(100,240,200,0.04) 30px, rgba(100,240,200,0.04) 31px);
  border-radius: 50%;
  animation: wmGridShift 15s linear infinite;
}
@keyframes wmGridShift { 0%{transform:translateX(0)} 100%{transform:translateX(-30px)} }

/* ── Scrollbar ─────────────────────────────────────── */
.wm-left-rail::-webkit-scrollbar, .wm-right-rail::-webkit-scrollbar { width: 3px; }
.wm-left-rail::-webkit-scrollbar-thumb, .wm-right-rail::-webkit-scrollbar-thumb { background: var(--wm-muted); border-radius: 2px; }
`;
    document.head.appendChild(s);
  }

  // ── Utility ────────────────────────────────────────────────────────────
  function relTime(ts) {
    if (!ts) return '';
    const diff = (Date.now() - new Date(ts).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function fmtPrice(v) {
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (v >= 1) return v.toFixed(0);
    return v.toFixed(4);
  }

  // ── Build HTML ─────────────────────────────────────────────────────────
  function buildHTML(container) {
    container.innerHTML = `
      <div class="wm-scanlines"></div>
      <div class="wm-layout">
        <aside class="wm-left-rail" id="wm-left-rail">
          <div class="wm-panel-header">Sensor Layers</div>
          <div id="wm-layer-toggles"></div>
          <div class="wm-sep"></div>
          <div class="wm-panel-header">Threat Assessment</div>
          <div class="wm-gauge-wrap" id="wm-gauge"></div>
          <div class="wm-sep"></div>
          <div class="wm-panel-header">System Stats</div>
          <div id="wm-stats"></div>
        </aside>
        <main class="wm-globe-area" id="wm-globe-area">
          <div class="wm-time-filter" id="wm-time-filter"></div>
          <div id="wm-globe-container" style="width:100%;height:100%;"></div>
        </main>
        <aside class="wm-right-rail" id="wm-right-rail">
          <div class="wm-panel-header">OSINT Feed</div>
          <div class="wm-feed-list" id="wm-feed"></div>
          <div class="wm-sep"></div>
          <div class="wm-panel-header">Active Alerts</div>
          <div id="wm-alerts"></div>
          <div class="wm-sep"></div>
          <div class="wm-panel-header">Markets</div>
          <div id="wm-markets"></div>
        </aside>
        <footer class="wm-bottom-ticker" id="wm-ticker"></footer>
      </div>
    `;
  }

  // ── Layer Toggles ──────────────────────────────────────────────────────
  function buildToggles() {
    const layers = [
      { key: 'conflicts', label: 'Conflicts', color: 'var(--wm-red)' },
      { key: 'earthquakes', label: 'Earthquakes', color: 'var(--wm-amber)' },
      { key: 'flights', label: 'Flight Routes', color: 'var(--wm-blue)' },
      { key: 'satellites', label: 'Satellites', color: 'var(--wm-muted)' },
      { key: 'weather', label: 'Weather', color: 'var(--wm-muted)' },
    ];
    const wrap = document.getElementById('wm-layer-toggles');
    if (!wrap) return;
    wrap.innerHTML = layers.map(l => `
      <div class="wm-toggle-row" data-layer="${l.key}">
        <div class="wm-toggle-switch ${wmActiveLayers[l.key] ? 'active' : ''}" data-layer="${l.key}"></div>
        <div class="wm-toggle-dot" style="background:${l.color}"></div>
        <span class="wm-toggle-label">${l.label}</span>
      </div>
    `).join('');
    wrap.querySelectorAll('.wm-toggle-row').forEach(row => {
      row.addEventListener('click', () => {
        const key = row.dataset.layer;
        wmActiveLayers[key] = !wmActiveLayers[key];
        row.querySelector('.wm-toggle-switch').classList.toggle('active', wmActiveLayers[key]);
        updateGlobeLayers();
      });
    });
  }

  // ── Time Filter ────────────────────────────────────────────────────────
  function buildTimeFilter() {
    const times = ['1H', '6H', '24H', '7D', '30D'];
    const wrap = document.getElementById('wm-time-filter');
    if (!wrap) return;
    wrap.innerHTML = times.map(t =>
      `<button class="wm-time-btn ${t === wmTimeFilter ? 'active' : ''}" data-time="${t}">${t}</button>`
    ).join('');
    wrap.querySelectorAll('.wm-time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        wmTimeFilter = btn.dataset.time;
        wrap.querySelectorAll('.wm-time-btn').forEach(b => b.classList.toggle('active', b.dataset.time === wmTimeFilter));
        fetchData();
      });
    });
  }

  // ── Threat Gauge (SVG) ─────────────────────────────────────────────────
  function renderGauge(score) {
    const wrap = document.getElementById('wm-gauge');
    if (!wrap) return;
    const clamped = Math.min(100, Math.max(0, score));
    const angle = (clamped / 100) * 180;
    const rad = (angle - 180) * Math.PI / 180;
    const r = 50;
    const cx = 60, cy = 58;
    const x = cx + r * Math.cos(rad);
    const y = cy + r * Math.sin(rad);
    const largeArc = angle > 180 ? 1 : 0;

    // color based on score
    let color = '#64f0c8';
    if (clamped > 30) color = '#f59e0b';
    if (clamped > 60) color = '#ff5f63';

    wrap.innerHTML = `
      <svg width="120" height="70" viewBox="0 0 120 70">
        <path d="M 10 58 A 50 50 0 0 1 110 58" fill="none" stroke="rgba(74,102,112,0.3)" stroke-width="6" stroke-linecap="round"/>
        <path d="M 10 58 A 50 50 0 ${largeArc} 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" style="filter: drop-shadow(0 0 4px ${color})"/>
      </svg>
      <div class="wm-gauge-value" style="color:${color}">${clamped}</div>
    `;
  }

  // ── Stats ──────────────────────────────────────────────────────────────
  function renderStats(data) {
    const wrap = document.getElementById('wm-stats');
    if (!wrap) return;
    const flightCount = data.flights ? data.flights.count || 0 : 0;
    const quakeCount = data.earthquakes ? data.earthquakes.count || 0 : 0;
    const newsCount = data.news ? data.news.length : 0;
    const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    wrap.innerHTML = `
      <div class="wm-stat"><span class="wm-stat-label">Flights DACH</span><span class="wm-stat-value" style="color:var(--wm-accent)">${flightCount}</span></div>
      <div class="wm-stat"><span class="wm-stat-label">Seismic Events</span><span class="wm-stat-value" style="color:var(--wm-amber)">${quakeCount}</span></div>
      <div class="wm-stat"><span class="wm-stat-label">Intel Reports</span><span class="wm-stat-value" style="color:var(--wm-text)">${newsCount}</span></div>
      <div class="wm-stat"><span class="wm-stat-label">Last Sweep</span><span class="wm-stat-value" style="color:var(--wm-muted);font-size:14px">${now}</span></div>
    `;
  }

  // ── OSINT Feed ─────────────────────────────────────────────────────────
  function renderFeed(news) {
    const wrap = document.getElementById('wm-feed');
    if (!wrap) return;
    const items = (news || []).slice(0, 8);
    wrap.innerHTML = items.map(n => `
      <div class="wm-feed-item">
        <div class="wm-feed-title">${n.title || 'No title'}</div>
        <div class="wm-feed-meta">
          <span>${n.source || 'Unknown'}</span>
          <span>${relTime(n.published || n.timestamp)}</span>
          ${n.score ? `<span class="wm-feed-score">${n.score}</span>` : ''}
        </div>
      </div>
    `).join('') || '<div style="color:var(--wm-muted);font-size:11px">No intel available</div>';
  }

  // ── Alerts ─────────────────────────────────────────────────────────────
  function renderAlerts(data) {
    const wrap = document.getElementById('wm-alerts');
    if (!wrap) return;
    const quakes = (data.earthquakes && data.earthquakes.quakes || [])
      .filter(q => q.mag >= 4.5).slice(0, 5);
    const alerts = quakes.map(q => ({
      text: `M${q.mag.toFixed(1)} — ${q.place || 'Unknown'}`,
      color: q.mag >= 6 ? 'var(--wm-red)' : q.mag >= 5 ? 'var(--wm-amber)' : 'var(--wm-muted)'
    }));
    // Add conflict alerts
    if (data.conflicts && data.conflicts.length) {
      data.conflicts.slice(0, 3).forEach(c => {
        alerts.push({ text: c.name || c.location || 'Active Conflict', color: 'var(--wm-red)' });
      });
    }
    wrap.innerHTML = alerts.length ? alerts.map(a => `
      <div class="wm-alert-item">
        <div class="wm-alert-dot" style="background:${a.color}"></div>
        <span>${a.text}</span>
      </div>
    `).join('') : '<div style="color:var(--wm-muted);font-size:11px">No active alerts</div>';
  }

  // ── Markets ────────────────────────────────────────────────────────────
  function renderMarkets(crypto, indices) {
    const wrap = document.getElementById('wm-markets');
    if (!wrap) return;
    const items = [];
    if (crypto) crypto.slice(0, 4).forEach(c => {
      items.push({ symbol: c.symbol || c.name, price: c.price, change: c.change_24h || c.change });
    });
    if (indices) indices.slice(0, 3).forEach(i => {
      items.push({ symbol: i.symbol || i.name, price: i.price || i.value, change: i.change });
    });
    wrap.innerHTML = items.map(m => {
      const ch = parseFloat(m.change) || 0;
      const cls = ch >= 0 ? 'up' : 'down';
      const arrow = ch >= 0 ? '▲' : '▼';
      return `<div class="wm-market-row">
        <span class="wm-market-symbol">${m.symbol || '?'}</span>
        <span class="wm-market-price">$${fmtPrice(m.price || 0)}</span>
        <span class="wm-market-change ${cls}">${arrow}${Math.abs(ch).toFixed(1)}%</span>
      </div>`;
    }).join('') || '<div style="color:var(--wm-muted);font-size:11px">No data</div>';
  }

  // ── Bottom Ticker ──────────────────────────────────────────────────────
  function renderTicker(data) {
    const wrap = document.getElementById('wm-ticker');
    if (!wrap) return;
    // Left: market items
    let tickerItems = [];
    if (data.crypto) data.crypto.slice(0, 3).forEach(c => {
      const ch = parseFloat(c.change_24h || c.change) || 0;
      const cls = ch >= 0 ? 'up' : 'down';
      const arrow = ch >= 0 ? '▲' : '▼';
      tickerItems.push(`<span class="wm-ticker-item"><span class="wm-ticker-symbol">${c.symbol || c.name}</span> <span class="wm-ticker-price">$${fmtPrice(c.price || 0)}</span> <span class="wm-ticker-change ${cls}">${arrow}${Math.abs(ch).toFixed(1)}%</span></span>`);
    });
    if (data.market_indices) data.market_indices.slice(0, 2).forEach(i => {
      const ch = parseFloat(i.change) || 0;
      const cls = ch >= 0 ? 'up' : 'down';
      const arrow = ch >= 0 ? '▲' : '▼';
      tickerItems.push(`<span class="wm-ticker-item"><span class="wm-ticker-symbol">${i.symbol || i.name}</span> <span class="wm-ticker-price">${fmtPrice(i.price || i.value || 0)}</span> <span class="wm-ticker-change ${cls}">${arrow}${Math.abs(ch).toFixed(1)}%</span></span>`);
    });

    const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const alertCount = (data.earthquakes && data.earthquakes.quakes || []).filter(q => q.mag >= 5).length +
                       (data.conflicts || []).length;

    wrap.innerHTML = `
      <div class="wm-ticker-left">${tickerItems.join('')}</div>
      <div class="wm-ticker-center">SWEEP ${now}</div>
      <div class="wm-ticker-right">${alertCount > 0 ? `<span class="wm-alert-badge">${alertCount} ALERT${alertCount > 1 ? 'S' : ''}</span>` : '<span style="color:var(--wm-muted)">ALL CLEAR</span>'}</div>
    `;
  }

  // ── Globe (globe.gl) ───────────────────────────────────────────────────
  const FLIGHT_ROUTES = [
    { start: { lat: 51.5, lng: -0.12 }, end: { lat: 40.7, lng: -74.0 }, label: 'LHR-JFK' },
    { start: { lat: 48.1, lng: 11.6 }, end: { lat: 35.7, lng: 139.7 }, label: 'MUC-NRT' },
    { start: { lat: 48.1, lng: 11.6 }, end: { lat: 25.3, lng: 55.3 }, label: 'MUC-DXB' },
    { start: { lat: 47.4, lng: 8.5 }, end: { lat: 1.35, lng: 103.8 }, label: 'ZRH-SIN' },
    { start: { lat: 49.0, lng: 2.5 }, end: { lat: 22.3, lng: 114.2 }, label: 'CDG-HKG' },
    { start: { lat: 52.5, lng: 13.4 }, end: { lat: 34.0, lng: -118.2 }, label: 'BER-LAX' },
    { start: { lat: 50.0, lng: 8.6 }, end: { lat: 31.2, lng: 121.5 }, label: 'FRA-PVG' },
    { start: { lat: 52.3, lng: 4.8 }, end: { lat: 37.6, lng: 127.0 }, label: 'AMS-ICN' },
  ];

  const CONFLICT_ZONES = [
    { lat: 48.5, lng: 35.0, name: 'Ukraine', size: 0.7 },
    { lat: 31.5, lng: 34.5, name: 'Israel/Gaza', size: 0.6 },
    { lat: 33.3, lng: 44.4, name: 'Iraq', size: 0.4 },
    { lat: 15.5, lng: 48.5, name: 'Yemen', size: 0.5 },
    { lat: 9.0, lng: 38.7, name: 'Ethiopia', size: 0.4 },
    { lat: 15.6, lng: 32.5, name: 'Sudan', size: 0.5 },
    { lat: 19.8, lng: 96.2, name: 'Myanmar', size: 0.4 },
  ];

  let globeLoaded = false;

  async function initGlobe() {
    const container = document.getElementById('wm-globe-container');
    if (!container) return;

    try {
      await loadScript('https://unpkg.com/three@0.160.0/build/three.min.js');
      await loadScript('https://unpkg.com/globe.gl@2.32.0/dist/globe.gl.min.js');

      if (typeof Globe === 'undefined') throw new Error('Globe not available');

      const rect = container.getBoundingClientRect();
      wmGlobeInstance = Globe()
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
        .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
        .atmosphereColor('#64f0c8')
        .atmosphereAltitude(0.15)
        .width(rect.width)
        .height(rect.height)
        (container);

      wmGlobeInstance.pointOfView({ lat: 48, lng: 12, altitude: 2.2 }, 0);
      wmGlobeInstance.controls().autoRotate = true;
      wmGlobeInstance.controls().autoRotateSpeed = 0.4;
      wmGlobeInstance.controls().enableZoom = true;

      globeLoaded = true;
      updateGlobeLayers();

      // ResizeObserver
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (wmGlobeInstance && width > 0 && height > 0) {
            wmGlobeInstance.width(width).height(height);
          }
        }
      });
      ro.observe(container);

    } catch (e) {
      console.warn('[WorldMonitor] Globe.gl failed, using CSS fallback:', e);
      container.innerHTML = `
        <div class="wm-globe-fallback">
          <div class="wm-globe-fallback-sphere">
            <div class="wm-globe-fallback-grid"></div>
          </div>
        </div>
      `;
    }
  }

  function updateGlobeLayers() {
    if (!wmGlobeInstance || !globeLoaded) return;

    // Flight arcs
    const arcsData = wmActiveLayers.flights ? FLIGHT_ROUTES.map(r => ({
      startLat: r.start.lat, startLng: r.start.lng,
      endLat: r.end.lat, endLng: r.end.lng,
    })) : [];
    wmGlobeInstance
      .arcsData(arcsData)
      .arcColor(() => '#44ccff33')
      .arcDashLength(0.4)
      .arcDashGap(0.2)
      .arcDashAnimateTime(3000)
      .arcStroke(0.5);

    // Earthquake points
    const quakes = wmActiveLayers.earthquakes && wmData && wmData.earthquakes && wmData.earthquakes.quakes
      ? wmData.earthquakes.quakes : [];
    wmGlobeInstance
      .pointsData(quakes.map(q => ({ lat: q.lat, lng: q.lng || q.lon, size: (q.mag || 3) / 8, color: '#ff5f63' })))
      .pointAltitude(0.01)
      .pointRadius('size')
      .pointColor('color');

    // Earthquake rings (M5+)
    const bigQuakes = quakes.filter(q => q.mag >= 5);
    wmGlobeInstance
      .ringsData(wmActiveLayers.earthquakes ? bigQuakes.map(q => ({ lat: q.lat, lng: q.lng || q.lon })) : [])
      .ringColor(() => '#ff5f6366')
      .ringMaxRadius(4)
      .ringPropagationSpeed(1.5)
      .ringRepeatPeriod(1500);

    // Conflict labels
    const conflictsData = wmActiveLayers.conflicts ? CONFLICT_ZONES : [];
    wmGlobeInstance
      .labelsData(conflictsData)
      .labelLat('lat')
      .labelLng('lng')
      .labelText('name')
      .labelColor(() => '#ff5f63')
      .labelSize('size')
      .labelDotRadius(0.3)
      .labelAltitude(0.01);
  }

  // ── Data Fetching ──────────────────────────────────────────────────────
  async function fetchData() {
    try {
      const resp = await fetch('/api/world-monitor');
      if (!resp.ok) throw new Error(resp.statusText);
      wmData = await resp.json();
      renderAll(wmData);
    } catch (e) {
      console.warn('[WorldMonitor] Fetch error:', e);
    }
  }

  function renderAll(data) {
    if (!data) return;
    const quakeCount = data.earthquakes ? data.earthquakes.count || (data.earthquakes.quakes || []).length : 0;
    const conflictCount = (data.conflicts || []).length || CONFLICT_ZONES.length;
    const score = Math.min(100, quakeCount * 2 + conflictCount * 3);

    renderGauge(score);
    renderStats(data);
    renderFeed(data.news);
    renderAlerts(data);
    renderMarkets(data.crypto, data.market_indices);
    renderTicker(data);
    updateGlobeLayers();
  }

  // ── Main Entry ─────────────────────────────────────────────────────────
  window.loadWorldMonitor = async function () {
    const container = document.getElementById('view-world');
    if (!container) return;

    injectStyles();
    buildHTML(container);
    buildToggles();
    buildTimeFilter();

    // Init globe
    initGlobe();

    // Fetch data immediately
    await fetchData();

    // Auto-refresh every 60s
    if (wmRefreshTimer) clearInterval(wmRefreshTimer);
    wmRefreshTimer = setInterval(fetchData, 60000);
  };

  // Cleanup on view switch
  window.unloadWorldMonitor = function () {
    if (wmRefreshTimer) { clearInterval(wmRefreshTimer); wmRefreshTimer = null; }
    if (wmGlobeInstance) {
      const container = document.getElementById('wm-globe-container');
      if (container) container.innerHTML = '';
      wmGlobeInstance = null;
      globeLoaded = false;
    }
  };

})();
