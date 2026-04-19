// Rückgängig-Hinweis — zeigt nach jeder Aktion 5s lang einen Toast mit "Rückgängig"-Button.
// Verwendung:
//   MC.undoHint.show('Task gelöscht', async () => { await fetch('/api/tasks/123/restore'); });
//   MC.undoHint.show('Order platziert', undoFn, { seconds: 5, variant: 'warn' });
//
// Pattern "delay-then-execute" (Aktion passiert erst nach 5s, Abbrechen möglich):
//   MC.undoHint.delay('Trading-Order wird gesendet', 5000, async () => { await placeOrder(); });
(function () {
  const WRAP_ID = 'mc-undo-hint-wrap';
  const STYLE_ID = 'mc-undo-hint-style';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${WRAP_ID} {
        position: fixed; right: 20px; bottom: 20px; z-index: 9998;
        display: flex; flex-direction: column; gap: 8px;
        font-family: -apple-system, Segoe UI, sans-serif;
        pointer-events: none;
      }
      .mc-undo-toast {
        pointer-events: auto;
        background: #1f2937; color: #f3f4f6;
        border: 1px solid #374151; border-left: 4px solid #60a5fa;
        border-radius: 8px; padding: 10px 12px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35);
        display: flex; align-items: center; gap: 12px;
        font-size: 13px; min-width: 260px; max-width: 420px;
        animation: mcUndoIn 0.18s ease-out;
      }
      .mc-undo-toast.warn { border-left-color: #f59e0b; }
      .mc-undo-toast.danger { border-left-color: #ef4444; }
      .mc-undo-toast .mc-undo-msg { flex: 1; line-height: 1.3; }
      .mc-undo-toast .mc-undo-count {
        font-variant-numeric: tabular-nums;
        color: #9ca3af; font-size: 11px; margin-left: 4px;
      }
      .mc-undo-toast button {
        background: #374151; color: #f3f4f6; border: 1px solid #4b5563;
        border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px;
        font-weight: 600;
      }
      .mc-undo-toast button.mc-undo-primary { background: #dc2626; border-color: #b91c1c; }
      .mc-undo-toast button:hover { filter: brightness(1.2); }
      .mc-undo-toast .mc-undo-close {
        background: transparent; border: none; color: #9ca3af;
        font-size: 16px; padding: 0 2px; cursor: pointer;
      }
      .mc-undo-toast.leaving { animation: mcUndoOut 0.2s ease-in forwards; }
      @keyframes mcUndoIn { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      @keyframes mcUndoOut { to { transform: translateY(10px); opacity: 0; } }
    `;
    document.head.appendChild(s);
  }

  function ensureWrap() {
    let wrap = document.getElementById(WRAP_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = WRAP_ID;
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add('leaving');
    setTimeout(() => { toast.remove(); }, 200);
  }

  // Passive Notification: Aktion ist schon passiert, User kann 5s lang "Rückgängig" klicken.
  function show(message, onUndo, opts) {
    ensureStyles();
    const wrap = ensureWrap();
    const seconds = (opts && opts.seconds) || 5;
    const variant = (opts && opts.variant) || '';
    const toast = document.createElement('div');
    toast.className = 'mc-undo-toast' + (variant ? ' ' + variant : '');
    toast.innerHTML = `
      <span class="mc-undo-msg">${escapeHtml(message)}</span>
      <span class="mc-undo-count">${seconds}s</span>
      ${onUndo ? '<button class="mc-undo-primary" type="button">Rückgängig</button>' : ''}
      <button class="mc-undo-close" type="button" title="Schließen">×</button>
    `;
    const countEl = toast.querySelector('.mc-undo-count');
    const undoBtn = toast.querySelector('.mc-undo-primary');
    const closeBtn = toast.querySelector('.mc-undo-close');

    let remaining = seconds;
    const tick = setInterval(() => {
      remaining -= 1;
      if (countEl) countEl.textContent = remaining + 's';
      if (remaining <= 0) { clearInterval(tick); removeToast(toast); }
    }, 1000);

    closeBtn.addEventListener('click', () => { clearInterval(tick); removeToast(toast); });
    if (undoBtn) {
      undoBtn.addEventListener('click', async () => {
        clearInterval(tick);
        undoBtn.disabled = true;
        undoBtn.textContent = '…';
        try { await onUndo(); } catch (e) { console.error('[undoHint] undo error:', e); }
        removeToast(toast);
      });
    }
    wrap.appendChild(toast);
    return { dismiss: () => { clearInterval(tick); removeToast(toast); } };
  }

  // Delay-then-execute: Aktion wird erst nach N ms ausgeführt, 5s Zeit zum Abbrechen.
  function delay(message, ms, doFn, opts) {
    ensureStyles();
    const wrap = ensureWrap();
    const seconds = Math.round(ms / 1000);
    const variant = (opts && opts.variant) || 'warn';
    const toast = document.createElement('div');
    toast.className = 'mc-undo-toast ' + variant;
    toast.innerHTML = `
      <span class="mc-undo-msg">${escapeHtml(message)}</span>
      <span class="mc-undo-count">${seconds}s</span>
      <button class="mc-undo-primary" type="button">Abbrechen</button>
    `;
    const countEl = toast.querySelector('.mc-undo-count');
    const cancelBtn = toast.querySelector('.mc-undo-primary');

    let cancelled = false;
    let remaining = seconds;
    const tick = setInterval(() => {
      remaining -= 1;
      if (countEl) countEl.textContent = remaining + 's';
      if (remaining <= 0) clearInterval(tick);
    }, 1000);

    const timer = setTimeout(async () => {
      clearInterval(tick);
      if (cancelled) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = '…';
      try { await doFn(); } catch (e) { console.error('[undoHint] action error:', e); }
      removeToast(toast);
    }, ms);

    cancelBtn.addEventListener('click', () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(tick);
      removeToast(toast);
    });
    wrap.appendChild(toast);
    return { cancel: () => { cancelled = true; clearTimeout(timer); clearInterval(tick); removeToast(toast); } };
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.MC = window.MC || {};
  MC.undoHint = { show, delay };
})();
