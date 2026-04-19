// Server-Restart Banner — zeigt oben einen Hinweis, damit unterbrochene Tasks sofort auffallen.
(function () {
  if (!window.MC || !MC.ws) return;

  const BANNER_ID = 'mc-restart-banner';
  let hideTimer = null;

  function ensureStyles() {
    if (document.getElementById('mc-restart-banner-style')) return;
    const s = document.createElement('style');
    s.id = 'mc-restart-banner-style';
    s.textContent = `
      #${BANNER_ID} {
        position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
        background: linear-gradient(90deg, #f59e0b, #ef4444);
        color: #111; font-weight: 600; padding: 10px 16px;
        display: flex; align-items: center; gap: 14px; justify-content: center;
        box-shadow: 0 2px 10px rgba(0,0,0,0.35);
        font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px;
        animation: mcRestartSlide 0.25s ease-out;
      }
      #${BANNER_ID} .mc-rb-pill {
        background: rgba(0,0,0,0.25); color: #fff; padding: 2px 8px;
        border-radius: 10px; font-size: 11px;
      }
      #${BANNER_ID} a, #${BANNER_ID} button {
        color: #111; text-decoration: underline; background: none;
        border: 1px solid rgba(0,0,0,0.35); border-radius: 6px;
        padding: 3px 10px; cursor: pointer; font-size: 12px; font-weight: 600;
      }
      #${BANNER_ID} button.mc-rb-close { border: none; font-size: 18px; padding: 0 4px; }
      @keyframes mcRestartSlide { from { transform: translateY(-100%); } to { transform: translateY(0); } }
    `;
    document.head.appendChild(s);
  }

  function dismiss() {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  async function fetchInterruptedCount() {
    try {
      const r = await fetch('/api/smart-tasks');
      if (!r.ok) return 0;
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.tasks || []);
      return list.filter(t => t.status === 'interrupted' && t.interrupted_by === 'server_restart').length;
    } catch { return 0; }
  }

  async function show(meta) {
    ensureStyles();
    dismiss();
    const interrupted = await fetchInterruptedCount();
    const ts = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const version = meta && meta.version ? String(meta.version).slice(0, 7) : '';
    const el = document.createElement('div');
    el.id = BANNER_ID;
    el.innerHTML = `
      <span>⚠️ Server neu gestartet (${ts})</span>
      ${interrupted ? `<span class="mc-rb-pill">${interrupted} Task${interrupted > 1 ? 's' : ''} unterbrochen</span>` : ''}
      ${version ? `<span class="mc-rb-pill">v ${version}</span>` : ''}
      ${interrupted ? `<a href="#" data-mc-goto-tasks>Smart Tasks öffnen</a>` : ''}
      <button class="mc-rb-close" title="Ausblenden">×</button>
    `;
    el.querySelector('.mc-rb-close').addEventListener('click', dismiss);
    const goto = el.querySelector('[data-mc-goto-tasks]');
    if (goto) goto.addEventListener('click', (e) => {
      e.preventDefault();
      const btn = document.querySelector('[data-view="smart-tasks"], [data-tab="smart-tasks"]');
      if (btn) btn.click();
      dismiss();
    });
    document.body.appendChild(el);
    // auto-hide nach 45s, falls keine Tasks betroffen; sonst bleibt er bis zum Klick
    if (!interrupted) {
      hideTimer = setTimeout(dismiss, 45000);
    }
  }

  MC.ws.on('_ws_server_restarted', (data) => show(data || {}));
  MC.ws.on('smart_tasks.server_restart', () => show({}));
})();
