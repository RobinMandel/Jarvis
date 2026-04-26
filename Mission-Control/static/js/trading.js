// Trading Lab — Full Dashboard with Charts, Positions, Orders, Quick Trade
async function loadTrading() {
  await Promise.all([
    loadAccount(),
    loadPositions(),
    loadSummary(),
    loadOrders(),
    loadPortfolioChart('1D'),
  ]);
}

// ── Account Stats ─────────────────────────────────────────────────────────
async function loadAccount() {
  try {
    const res = await fetch('/api/trading/account');
    const d = await res.json();
    if (d.error) throw new Error(d.error);

    const fmt = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
    document.getElementById('trading-value').textContent = fmt(d.equity);
    document.getElementById('trading-cash').textContent = fmt(d.cash);
    document.getElementById('trading-buying-power').textContent = fmt(d.buying_power);
    document.getElementById('trading-positions').textContent = d.position_count || '0';

    const pnl = Number(d.pnl || 0);
    const pnlEl = document.getElementById('trading-pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toLocaleString('en-US', { minimumFractionDigits: 2 });
    pnlEl.style.color = pnl >= 0 ? '#22c55e' : '#ef4444';
  } catch (e) {
    document.getElementById('trading-value').textContent = '--';
    document.getElementById('trading-pnl').textContent = e.message || 'Fehler';
    document.getElementById('trading-pnl').style.color = 'var(--text-muted)';
  }
}

// ── Positions + Allocation Chart ──────────────────────────────────────────
async function loadPositions() {
  try {
    const res = await fetch('/api/trading/positions');
    const positions = await res.json();
    const list = document.getElementById('trading-pos-list');

    if (!positions.length || positions.error) {
      list.innerHTML = '<div class="empty-state">Keine offenen Positionen</div>';
      drawAllocationChart([]);
      return;
    }

    list.innerHTML = positions.map(p => {
      const pnl = Number(p.unrealized_pl || 0);
      const pnlPct = Number(p.unrealized_plpc || 0) * 100;
      const mktVal = Number(p.market_value || 0);
      const cls = pnl >= 0 ? 'trading-pnl-pos' : 'trading-pnl-neg';
      return `<div class="trading-pos">
        <div style="display:flex;flex-direction:column;gap:2px">
          <span class="trading-sym">${p.symbol}</span>
          <span style="font-size:11px;color:var(--text-muted)">${p.qty} x $${Number(p.avg_entry_price || 0).toFixed(2)}</span>
        </div>
        <div style="text-align:right">
          <div class="${cls}">${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</div>
        </div>
      </div>`;
    }).join('');

    drawAllocationChart(positions);
  } catch {
    document.getElementById('trading-pos-list').innerHTML = '<div class="empty-state">API nicht erreichbar</div>';
  }
}

// ── Allocation Donut Chart (Canvas) ───────────────────────────────────────
function drawAllocationChart(positions) {
  const canvas = document.getElementById('trading-alloc-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 10;
  ctx.clearRect(0, 0, w, h);

  if (!positions.length) {
    ctx.fillStyle = 'var(--text-muted, #64748b)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Keine Positionen', cx, cy);
    return;
  }

  const colors = ['#14b8a6', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#ec4899', '#22d3ee', '#84cc16'];
  const total = positions.reduce((s, p) => s + Math.abs(Number(p.market_value || 0)), 0);
  let angle = -Math.PI / 2;

  positions.forEach((p, i) => {
    const val = Math.abs(Number(p.market_value || 0));
    const slice = (val / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();

    // Label
    const mid = angle + slice / 2;
    const lx = cx + (r * 0.65) * Math.cos(mid);
    const ly = cy + (r * 0.65) * Math.sin(mid);
    if (slice > 0.3) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.symbol, lx, ly);
    }

    angle += slice;
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#131720';
  ctx.fill();

  // Center text
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e2e8f0';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$' + (total / 1000).toFixed(1) + 'k', cx, cy);
}

// ── Portfolio History Chart ───────────────────────────────────────────────
async function loadPortfolioChart(period) {
  const canvas = document.getElementById('trading-portfolio-chart');
  if (!canvas) return;

  try {
    const res = await fetch(`/api/trading/history?period=${period}`);
    const data = await res.json();
    if (data.error || !data.equity || !data.equity.length) {
      drawEmptyChart(canvas, 'Keine Daten');
      return;
    }
    drawLineChart(canvas, data.timestamp, data.equity);
  } catch {
    drawEmptyChart(canvas, 'API nicht erreichbar');
  }
}

function drawLineChart(canvas, timestamps, values) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = { top: 10, right: 10, bottom: 25, left: 55 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  const nums = values.map(Number).filter(v => !isNaN(v));
  if (nums.length < 2) { drawEmptyChart(canvas, 'Nicht genug Daten'); return; }

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;

  // Determine color based on trend
  const isUp = nums[nums.length - 1] >= nums[0];
  const lineColor = isUp ? '#22c55e' : '#ef4444';
  const fillColor = isUp ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    const val = max - (range / 4) * i;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('$' + val.toFixed(0), pad.left - 5, y + 3);
  }

  // Line
  ctx.beginPath();
  nums.forEach((v, i) => {
    const x = pad.left + (i / (nums.length - 1)) * cw;
    const y = pad.top + ch - ((v - min) / range) * ch;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill under line
  const lastX = pad.left + cw;
  ctx.lineTo(lastX, pad.top + ch);
  ctx.lineTo(pad.left, pad.top + ch);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Time labels
  if (timestamps && timestamps.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(timestamps.length / 5));
    for (let i = 0; i < timestamps.length; i += step) {
      const x = pad.left + (i / (nums.length - 1)) * cw;
      const d = new Date(timestamps[i] * 1000);
      const label = d.getHours() !== undefined
        ? d.toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('de', { day: '2-digit', month: '2-digit' });
      ctx.fillText(label, x, h - 5);
    }
  }
}

function drawEmptyChart(canvas, msg) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(msg, w / 2, h / 2);
}

// ── Market Summary ────────────────────────────────────────────────────────
async function loadSummary() {
  try {
    const res = await fetch('/api/trading/summary');
    const data = await res.json();
    const el = document.getElementById('trading-summary');
    if (data.tldr) {
      let html = `<div style="margin-bottom:12px;font-size:13px;line-height:1.5">${data.tldr}</div>`;
      if (data.markets) {
        html += Object.entries(data.markets).map(([k, v]) =>
          `<div class="trading-pos"><span class="trading-sym">${k}</span><span>${v}</span></div>`
        ).join('');
      }
      if (data.headlines) {
        html += '<div style="margin-top:12px;font-size:11px;color:var(--text-muted)">';
        html += data.headlines.map(h => `<div style="margin-bottom:4px">• ${h}</div>`).join('');
        html += '</div>';
      }
      el.innerHTML = html;
    } else {
      el.innerHTML = '<div class="empty-state">Kein Summary. Cron: Mo-Fr 20:00.</div>';
    }
  } catch {
    document.getElementById('trading-summary').innerHTML = '<div class="empty-state">Summary nicht verfuegbar</div>';
  }
}

// ── Recent Orders ─────────────────────────────────────────────────────────
async function loadOrders() {
  try {
    const res = await fetch('/api/trading/orders');
    const orders = await res.json();
    const el = document.getElementById('trading-orders');

    if (!orders.length || orders.error) {
      el.innerHTML = '<div class="empty-state">Keine Orders</div>';
      return;
    }

    el.innerHTML = orders.slice(0, 10).map(o => {
      const side = o.side === 'buy' ? '🟢' : '🔴';
      const status = o.status === 'filled' ? '✓' : o.status === 'canceled' ? '✗' : '⏳';
      const time = new Date(o.created_at).toLocaleString('de', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      const price = o.filled_avg_price ? '$' + Number(o.filled_avg_price).toFixed(2) : '--';
      return `<div class="trading-pos" style="font-size:12px">
        <span>${side} ${o.symbol}</span>
        <span>${o.qty} @ ${price}</span>
        <span style="opacity:0.6">${status} ${time}</span>
      </div>`;
    }).join('');
  } catch {
    document.getElementById('trading-orders').innerHTML = '<div class="empty-state">Orders nicht verfuegbar</div>';
  }
}

// ── Quick Trade ───────────────────────────────────────────────────────────
function initQuickTrade() {
  const buyBtn = document.getElementById('qt-buy');
  const sellBtn = document.getElementById('qt-sell');
  const statusEl = document.getElementById('qt-status');

  if (!buyBtn || !sellBtn) return;

  async function placeOrder(side) {
    const symbol = document.getElementById('qt-symbol').value.trim().toUpperCase();
    const qty = parseInt(document.getElementById('qt-qty').value);

    if (!symbol) { statusEl.textContent = 'Symbol eingeben'; statusEl.style.color = '#f59e0b'; return; }
    if (!qty || qty < 1) { statusEl.textContent = 'Anzahl >= 1'; statusEl.style.color = '#f59e0b'; return; }

    statusEl.textContent = `${side.toUpperCase()} ${qty}x ${symbol}...`;
    statusEl.style.color = 'var(--text-muted)';

    try {
      const res = await fetch('/api/trading/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, qty, side }),
      });
      const data = await res.json();
      if (data.error) {
        statusEl.textContent = 'Fehler: ' + data.error;
        statusEl.style.color = '#ef4444';
      } else {
        statusEl.textContent = `${side.toUpperCase()} ${qty}x ${symbol} — ${data.status}`;
        statusEl.style.color = '#22c55e';
        // Refresh after order
        setTimeout(() => { loadAccount(); loadPositions(); loadOrders(); }, 2000);
      }
    } catch (e) {
      statusEl.textContent = 'Netzwerkfehler';
      statusEl.style.color = '#ef4444';
    }
  }

  buyBtn.addEventListener('click', () => placeOrder('buy'));
  sellBtn.addEventListener('click', () => placeOrder('sell'));
}

// ── Chart Range Buttons ───────────────────────────────────────────────────
function initChartRange() {
  document.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadPortfolioChart(btn.dataset.range);
    });
  });
}

// ── Refresh ───────────────────────────────────────────────────────────────
document.getElementById('btn-refresh-trading')?.addEventListener('click', loadTrading);

// Init interactive elements when trading view first loads
setTimeout(() => { initQuickTrade(); initChartRange(); }, 0);

// ═══════════════════════════════════════════════════════════════════════════
// Trading Bots Management
// ═══════════════════════════════════════════════════════════════════════════

const BOT_STATUS_COLOR = {
  running: '#22c55e', stopped: '#ef4444', crashed: '#f59e0b', error: '#f59e0b',
  starting: '#3b82f6',
};

function botDot(status) {
  const c = BOT_STATUS_COLOR[status] || '#6b7280';
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};box-shadow:0 0 5px ${c}88;flex-shrink:0"></span>`;
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Math.round((Date.now() - new Date(iso)) / 60000);
  if (diff < 2) return 'gerade eben';
  if (diff < 60) return `vor ${diff}min`;
  if (diff < 1440) return `vor ${Math.round(diff / 60)}h`;
  return `vor ${Math.round(diff / 1440)}d`;
}

function renderBotCard(bot) {
  const c = BOT_STATUS_COLOR[bot.status] || '#6b7280';
  const res = bot.last_result || {};
  const signal = res.signal || '—';
  const sigColor = signal === 'buy' ? '#22c55e' : signal === 'sell' ? '#ef4444' : 'var(--text-muted)';
  const price = res.price ? `$${Number(res.price).toFixed(2)}` : '';
  const isRunning = bot.status === 'running';

  return `<div style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px">
    <div style="display:flex;align-items:center;gap:7px">
      ${botDot(bot.status)}
      <span style="font-weight:600;font-size:13px;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${bot.name}</span>
      <span style="font-size:10px;color:${c};font-weight:600;text-transform:uppercase">${bot.status}</span>
    </div>
    <div style="display:flex;gap:8px;font-size:11px;color:var(--text-muted)">
      <span>Strategie: <b style="color:var(--text-secondary)">${bot.strategy}</b></span>
      <span style="margin-left:auto">Ticks: ${bot.tick_count || 0}</span>
    </div>
    <div style="display:flex;gap:8px;font-size:11px;align-items:center">
      <span>Signal: <b style="color:${sigColor}">${signal.toUpperCase()}</b>${price ? ` @ ${price}` : ''}</span>
      <span style="margin-left:auto;color:var(--text-dim)">${relTime(bot.last_tick)}</span>
    </div>
    ${res.short_sma ? `<div style="font-size:10px;color:var(--text-dim)">SMA5: ${res.short_sma} · SMA20: ${res.long_sma} · Δ ${res.diff > 0 ? '+' : ''}${res.diff}</div>` : ''}
    ${bot.error ? `<div style="font-size:10px;color:#f59e0b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${bot.error}">⚠ ${bot.error}</div>` : ''}
    <div style="display:flex;gap:5px;margin-top:2px">
      ${isRunning
        ? `<button onclick="botAction('${bot.id}','stop')" style="flex:1;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:5px;padding:4px;font-size:11px;cursor:pointer">■ Stop</button>
           <button onclick="botAction('${bot.id}','restart')" style="flex:1;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;border-radius:5px;padding:4px;font-size:11px;cursor:pointer">↺ Restart</button>`
        : `<button onclick="botAction('${bot.id}','start')" style="flex:1;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);color:#22c55e;border-radius:5px;padding:4px;font-size:11px;cursor:pointer">▶ Start</button>`
      }
      <button onclick="botAction('${bot.id}','delete')" style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.15);color:#ef4444;border-radius:5px;padding:4px 7px;font-size:11px;cursor:pointer" title="Löschen">✕</button>
    </div>
  </div>`;
}

async function loadTradingBots() {
  const el = document.getElementById('trading-bots-list');
  const cnt = document.getElementById('trading-bots-count');
  if (!el) return;
  try {
    const res = await fetch('/api/trading/bots');
    const data = await res.json();
    const bots = data.bots || [];
    if (cnt) cnt.textContent = `${bots.length} Bot${bots.length !== 1 ? 's' : ''}`;
    if (!bots.length) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">Noch keine Bots. Klicke "+ Neuer Bot" um zu starten.</div>';
      return;
    }
    el.innerHTML = bots.map(renderBotCard).join('');
  } catch (e) {
    if (el) el.innerHTML = `<div style="color:#ef4444;font-size:12px">Fehler: ${e.message}</div>`;
  }
}

window.botAction = async function(botId, action) {
  if (action === 'delete' && !confirm('Bot wirklich löschen?')) return;
  try {
    const method = action === 'delete' ? 'DELETE' : 'POST';
    const url = action === 'delete'
      ? `/api/trading/bots/${botId}`
      : `/api/trading/bots/${botId}/${action}`;
    const res = await fetch(url, { method });
    const data = await res.json();
    if (data.error) { alert('Fehler: ' + data.error); return; }
    setTimeout(loadTradingBots, 800);
  } catch (e) {
    alert('Netzwerkfehler: ' + e.message);
  }
};

window.showCreateBotModal = function() {
  const existing = document.getElementById('create-bot-modal');
  if (existing) { existing.remove(); return; }
  const modal = document.createElement('div');
  modal.id = 'create-bot-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border-medium);border-radius:14px;width:100%;max-width:420px;padding:24px">
      <div style="display:flex;align-items:center;margin-bottom:18px">
        <span style="font-size:16px;font-weight:700;color:var(--text-primary)">Neuer Trading Bot</span>
        <button onclick="document.getElementById('create-bot-modal').remove()" style="margin-left:auto;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <input id="cbot-name" placeholder="Name (z.B. SPY Momentum)" style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px;width:100%;box-sizing:border-box">
        <select id="cbot-strategy" style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px">
          <option value="sma_crossover">SMA Crossover (Momentum)</option>
          <option value="demo">Demo (dry-run)</option>
        </select>
        <input id="cbot-symbol" placeholder="Symbol (z.B. SPY)" value="SPY" style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px;width:100%;box-sizing:border-box;text-transform:uppercase">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <input id="cbot-short" type="number" placeholder="Short window" value="5" style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px">
          <input id="cbot-long" type="number" placeholder="Long window" value="20" style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px">
        </div>
        <select id="cbot-tf" style="background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:6px;padding:8px 10px;color:var(--text-primary);font-size:13px">
          <option value="5Min">5 Min</option>
          <option value="15Min">15 Min</option>
          <option value="1Hour">1 Stunde</option>
          <option value="1Day">1 Tag</option>
        </select>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer">
          <input type="checkbox" id="cbot-live"> Live Orders senden (Paper Trading)
        </label>
        <button onclick="window._submitCreateBot()" style="background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);color:#22c55e;border-radius:8px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;margin-top:4px">
          Bot erstellen
        </button>
        <div id="cbot-status" style="font-size:11px;color:var(--text-muted);text-align:center"></div>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
};

window._submitCreateBot = async function() {
  const name = document.getElementById('cbot-name')?.value.trim();
  if (!name) { document.getElementById('cbot-status').textContent = 'Name erforderlich'; return; }
  const strategy = document.getElementById('cbot-strategy')?.value || 'sma_crossover';
  const symbol = (document.getElementById('cbot-symbol')?.value || 'SPY').toUpperCase().trim();
  const short_window = parseInt(document.getElementById('cbot-short')?.value || '5');
  const long_window = parseInt(document.getElementById('cbot-long')?.value || '20');
  const timeframe = document.getElementById('cbot-tf')?.value || '5Min';
  const live = document.getElementById('cbot-live')?.checked || false;
  const tfToInterval = { '5Min': 300, '15Min': 900, '1Hour': 3600, '1Day': 86400 };
  const interval_sec = tfToInterval[timeframe] || 300;

  document.getElementById('cbot-status').textContent = 'Erstelle...';
  try {
    const res = await fetch('/api/trading/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, strategy, params: { symbol, short_window, long_window, timeframe, live, qty: 1 }, interval_sec }),
    });
    const data = await res.json();
    if (data.error) { document.getElementById('cbot-status').textContent = 'Fehler: ' + data.error; return; }
    document.getElementById('create-bot-modal')?.remove();
    await loadTradingBots();
  } catch (e) {
    document.getElementById('cbot-status').textContent = 'Netzwerkfehler';
  }
};

window.loadTradingBots = loadTradingBots;

// Auto-refresh bots every 30s when trading view is active
let _botsRefreshTimer = null;
const _origLoadTrading = loadTrading;
window.loadTrading = async function() {
  await _origLoadTrading();
  await loadTradingBots();
  if (!_botsRefreshTimer) {
    _botsRefreshTimer = setInterval(loadTradingBots, 30000);
  }
};

loadTradingBots();
