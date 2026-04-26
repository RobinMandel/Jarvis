// System Panel
async function loadSystem() {
  const svcPanel = document.getElementById('system-services');
  const hbPanel = document.getElementById('system-heartbeat');
  try {
    const res = await fetch('/api/system');
    const data = await res.json();

    // Services
    const bridge = data.bridge?.running;
    const tgMsgs = data.telegram?.messages_handled || 0;
    const lastSync = data.memory_sync?.last_sync || 'Nie';

    svcPanel.innerHTML = `
      <div class="system-item">
        <span class="system-dot ${bridge ? 'online' : 'offline'}"></span>
        <span>Telegram Bridge</span>
        <span class="system-val">${bridge ? 'Running' : 'Stopped'} (${tgMsgs} msgs)</span>
      </div>
      <div class="system-item">
        <span class="system-dot online"></span>
        <span>Mission Control</span>
        <span class="system-val">Running</span>
      </div>
      <div class="system-item">
        <span class="system-dot ${lastSync !== 'Nie' ? 'online' : 'offline'}"></span>
        <span>Memory Sync</span>
        <span class="system-val">Letzter: ${lastSync}</span>
      </div>
      <div class="system-item">
        <span class="system-dot online"></span>
        <span>Scheduled Tasks</span>
        <span class="system-val">Auto-Dream, Diss, Trading</span>
      </div>
    `;

    // Heartbeat
    const hb = data.heartbeat || {};
    hbPanel.innerHTML = `
      <div class="system-item">
        <span class="system-dot online"></span>
        <span>Letzter Check</span>
        <span class="system-val">${hb.last_check_time || 'Nie'}</span>
      </div>
      <div class="system-item">
        <span class="system-dot ${(hb.unread_outlook || 0) > 5 ? 'offline' : 'online'}"></span>
        <span>Ungelesen Outlook</span>
        <span class="system-val">${hb.unread_outlook ?? '?'}</span>
      </div>
      <div class="system-item">
        <span class="system-dot ${(hb.unread_uni || 0) > 5 ? 'offline' : 'online'}"></span>
        <span>Ungelesen Uni</span>
        <span class="system-val">${hb.unread_uni ?? '?'}</span>
      </div>
      <div class="system-item">
        <span class="system-dot online"></span>
        <span>Events</span>
        <span class="system-val">${hb.upcoming_events ?? '?'}</span>
      </div>
    `;
    // Restart button
    const restartPanel = document.getElementById('system-restart');
    if (restartPanel) {
      restartPanel.innerHTML = `
        <button id="btn-mc-restart" class="btn-restart" onclick="triggerMCRestart()">
          ⟳ Mission Control Neustarten
        </button>
        <span id="restart-status" style="font-size:0.8rem;color:var(--muted);margin-left:8px;"></span>
      `;
    }
  } catch (e) {
    svcPanel.innerHTML = `<div class="empty-state">Fehler: ${e.message}</div>`;
  }
}

async function triggerMCRestart() {
  const btn = document.getElementById('btn-mc-restart');
  const status = document.getElementById('restart-status');
  btn.disabled = true;
  btn.textContent = '⏳ Restart wird ausgeführt...';
  status.textContent = '';
  try {
    const res = await fetch('/api/system/restart', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      status.textContent = data.message || 'Restart ausgelöst — MC startet in ~3s neu';
      status.style.color = '#4ade80';
    } else {
      status.textContent = 'Fehler: ' + (data.error || 'Unbekannt');
      status.style.color = '#f87171';
      btn.disabled = false;
      btn.textContent = '⟳ Mission Control Neustarten';
    }
  } catch (e) {
    status.textContent = 'Verbindungsfehler: ' + e.message;
    status.style.color = '#f87171';
    btn.disabled = false;
    btn.textContent = '⟳ Mission Control Neustarten';
  }
}
