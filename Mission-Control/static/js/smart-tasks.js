// Mission Control V4 — Build View (Roadmap Checklist)
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _refreshTimer = null;
  let _activeBuildIds = new Set(); // roadmap item IDs mit laufendem Build

  // ── Helpers ───────────────────────────────────────────────────────────────

  function fmt(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Fetch helpers ─────────────────────────────────────────────────────────

  async function fetchRoadmap() {
    try {
      const res = await fetch('/api/roadmap');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function fetchBuilds() {
    try {
      const res = await fetch('/api/smart-tasks');
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      return [];
    }
  }

  // ── Render Progress Bar ───────────────────────────────────────────────────

  function renderProgress(stats) {
    const container = document.getElementById('rm-progress-bar');
    if (!container) return;
    const pct = stats.percent || 0;
    container.innerHTML = `
      <div class="rm-progress-header">
        <span class="rm-progress-label">Fortschritt</span>
        <span class="rm-progress-nums">${stats.done} / ${stats.total} Items &mdash; ${pct}%</span>
      </div>
      <div class="rm-progress-track">
        <div class="rm-progress-fill" style="width:${pct}%"></div>
      </div>
    `;
  }

  // ── Render Roadmap Checklist ──────────────────────────────────────────────

  function renderRoadmap(data, activeBuilds) {
    const container = document.getElementById('rm-checklist');
    if (!container) return;

    // Map: roadmap_id → build task
    const buildByRmId = {};
    activeBuilds.forEach(t => {
      if (t.roadmap_id) buildByRmId[t.roadmap_id] = t;
    });

    container.innerHTML = data.categories.map(cat => {
      const doneCount = cat.items.filter(i => i.done).length;
      const totalCount = cat.items.length;
      const catPct = totalCount ? Math.round(doneCount / totalCount * 100) : 0;

      const itemsHtml = cat.items.map(item => {
        const build = buildByRmId[item.id];
        const isBuilding = build && build.status === 'running';
        const buildDone  = build && build.status === 'done';
        const buildError = build && build.status === 'error';

        let statusHtml = '';
        if (isBuilding) {
          statusHtml = `<span class="rm-building-badge"><span class="rm-spinner"></span> Claude baut...</span>`;
        } else if (buildDone) {
          statusHtml = `<span class="rm-build-done-badge">&#10003; Build fertig</span>`;
        } else if (buildError) {
          statusHtml = `<span class="rm-build-error-badge">&#10005; Build-Fehler</span>`;
        }

        const buildBtn = (!item.done && !isBuilding)
          ? `<button class="rm-build-btn" data-id="${item.id}" title="Claude baut dieses Feature">Build</button>`
          : '';

        return `
          <div class="rm-item ${item.done ? 'rm-item-done' : ''} ${isBuilding ? 'rm-item-building' : ''}" data-item-id="${item.id}">
            <label class="rm-item-check-wrap">
              <input type="checkbox" class="rm-checkbox" data-id="${item.id}" ${item.done ? 'checked' : ''}>
              <span class="rm-check-box ${item.done ? 'rm-check-done' : ''}"></span>
            </label>
            <span class="rm-item-text">${escHtml(item.text)}</span>
            ${statusHtml}
            ${buildBtn}
          </div>
        `;
      }).join('');

      return `
        <details class="rm-category" open>
          <summary class="rm-cat-summary">
            <span class="rm-cat-name">${escHtml(cat.name)}</span>
            <span class="rm-cat-stats">${doneCount}/${totalCount}</span>
            <div class="rm-cat-mini-bar">
              <div class="rm-cat-mini-fill" style="width:${catPct}%"></div>
            </div>
          </summary>
          <div class="rm-items">
            ${itemsHtml}
          </div>
        </details>
      `;
    }).join('');

    // Bind checkboxes
    container.querySelectorAll('.rm-checkbox').forEach(cb => {
      cb.addEventListener('change', () => toggleItem(cb.dataset.id));
    });

    // Bind build buttons
    container.querySelectorAll('.rm-build-btn').forEach(btn => {
      btn.addEventListener('click', () => buildItem(btn.dataset.id, btn));
    });
  }

  // ── Render Builds Panel (kompakt, unten) ──────────────────────────────────

  function renderBuildsPanel(builds) {
    const container = document.getElementById('rm-builds-list');
    if (!container) return;

    // Nur relevante: running, pending, done (neueste), error
    const relevant = builds
      .filter(t => t.roadmap_id || t.status === 'running' || t.status === 'pending')
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 20);

    if (!relevant.length) {
      container.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px">Noch keine Builds gestartet.</div>';
      return;
    }

    const statusMap = {
      pending: { label: 'Pending', bg: '#92400e', color: '#fbbf24' },
      running: { label: 'Running', bg: '#1e3a5f', color: '#38bdf8' },
      done:    { label: 'Done',    bg: '#14532d', color: '#4ade80' },
      error:   { label: 'Error',   bg: '#450a0a', color: '#f87171' },
    };

    container.innerHTML = relevant.map(t => {
      const s = statusMap[t.status] || statusMap.pending;
      const pulse = t.status === 'running' ? 'animation:pulse-dot 1.2s ease-in-out infinite;' : '';
      const hasOutput = t.output && t.output.trim().length > 0;
      const hasError  = t.error  && t.error.trim().length  > 0;

      return `
        <div class="rm-build-row">
          <span class="rm-build-badge" style="background:${s.bg};color:${s.color};${pulse}">${s.label}</span>
          <span class="rm-build-title">${escHtml(t.title)}</span>
          <span class="rm-build-time">${fmt(t.created)}</span>
          ${t.status === 'running' ? `<span class="rm-spinner" style="margin-left:6px"></span>` : ''}
          ${hasError ? `<details class="rm-build-detail"><summary style="color:#f87171;font-size:11px;cursor:pointer">Fehler</summary><pre class="rm-build-pre rm-build-pre-error">${escHtml(t.error)}</pre></details>` : ''}
          ${hasOutput && t.status !== 'running' ? `<details class="rm-build-detail"><summary style="color:var(--text-muted,#64748b);font-size:11px;cursor:pointer">Output (${t.output.length} Zeichen)</summary><pre class="rm-build-pre">${escHtml(t.output)}</pre></details>` : ''}
          <button class="rm-build-delete" data-id="${t.id}" title="Löschen">&#10005;</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.rm-build-delete').forEach(btn => {
      btn.addEventListener('click', () => deleteBuild(btn.dataset.id));
    });
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function toggleItem(id) {
    try {
      const res = await fetch(`/api/roadmap/${id}/toggle`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        console.error('[Roadmap] toggle error:', e);
      }
      await loadSmartTasks();
    } catch (e) {
      console.error('[Roadmap] toggle error:', e);
    }
  }

  async function buildItem(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const res = await fetch(`/api/roadmap/${id}/build`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(`Build-Fehler: ${e.error || res.status}`);
        if (btn) { btn.disabled = false; btn.textContent = 'Build'; }
        return;
      }
      const data = await res.json();
      _activeBuildIds.add(id);
      scheduleRefresh();
      await loadSmartTasks();
    } catch (e) {
      console.error('[Roadmap] build error:', e);
      if (btn) { btn.disabled = false; btn.textContent = 'Build'; }
    }
  }

  async function deleteBuild(id) {
    try {
      await fetch(`/api/smart-tasks/${id}`, { method: 'DELETE' });
      await loadSmartTasks();
      if (window.MC && MC.undoHint) {
        MC.undoHint.show(`Smart Task #${id} gelöscht`, null, { variant: 'warn' });
      }
    } catch (e) {
      console.error('[Roadmap] delete build error:', e);
    }
  }

  // ── Auto-Refresh ──────────────────────────────────────────────────────────

  function scheduleRefresh() {
    if (_refreshTimer) return;
    _refreshTimer = setInterval(async () => {
      const builds = await fetchBuilds();
      const anyRunning = builds.some(t => t.status === 'running');
      if (!anyRunning) {
        clearInterval(_refreshTimer);
        _refreshTimer = null;
        _activeBuildIds.clear();
      }
      await loadSmartTasks();
    }, 5000);
  }

  // ── Roadmap Suggest ───────────────────────────────────────────────────────

  function renderSuggestBox() {
    const container = document.getElementById('rm-suggest-container');
    if (!container || container.dataset.initialized) return;
    container.dataset.initialized = 'true';

    container.innerHTML = `
      <div class="rm-suggest-box">
        <span class="rm-suggest-label">Was soll Jarvis als nächstes können?</span>
        <div class="rm-suggest-row">
          <textarea
            class="rm-suggest-textarea"
            id="rm-suggest-input"
            placeholder="z.B. Ich will jeden Morgen eine Zusammenfassung meiner E-Mails..."
            rows="2"
          ></textarea>
          <button class="rm-suggest-btn" id="rm-suggest-send">Vorschlagen</button>
        </div>
        <div class="rm-suggest-status" id="rm-suggest-status"></div>
      </div>
    `;

    const textarea = container.querySelector('#rm-suggest-input');
    const btn      = container.querySelector('#rm-suggest-send');
    const status   = container.querySelector('#rm-suggest-status');

    async function submitSuggest() {
      const msg = textarea.value.trim();
      if (!msg) return;

      btn.disabled = true;
      textarea.disabled = true;
      status.className = 'rm-suggest-status thinking';
      status.innerHTML = `<span class="rm-spinner"></span> Jarvis denkt nach...`;

      try {
        const res = await fetch('/api/roadmap/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });

        const data = await res.json();

        if (!res.ok) {
          status.className = 'rm-suggest-status error';
          status.textContent = `Fehler: ${data.reason || res.status}`;
          return;
        }

        const inserted = data.inserted || [];
        status.className = 'rm-suggest-status success';
        if (inserted.length === 0) {
          status.textContent = 'Jarvis hat nichts eingefügt.';
        } else {
          status.innerHTML = `${inserted.length} Item${inserted.length > 1 ? 's' : ''} hinzugefügt:
            <div class="rm-suggest-inserted">
              ${inserted.map(i => `<div class="rm-suggest-inserted-item">⬜ ${escHtml(i.text)} <span style="color:#64748b;font-size:11px">(${escHtml(i.category)})</span></div>`).join('')}
            </div>`;
        }

        textarea.value = '';
        // Refresh checklist and highlight new items
        const newIds = inserted.map(i => i.id).filter(Boolean);
        setTimeout(() => {
          loadSmartTasks().then(() => {
            // Highlight new items
            newIds.forEach(id => {
              const el = document.querySelector(`[data-item-id="${id}"]`);
              if (el) {
                el.style.background = 'rgba(34,197,94,0.15)';
                el.style.borderLeft = '3px solid #22c55e';
                el.style.transition = 'background 3s, border-left 3s';
                // Open parent details
                const details = el.closest('details');
                if (details) details.open = true;
                // Scroll into view
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Fade out highlight after 5s
                setTimeout(() => {
                  el.style.background = '';
                  el.style.borderLeft = '';
                }, 5000);
              }
            });
          });
        }, 800);

      } catch (e) {
        status.className = 'rm-suggest-status error';
        status.textContent = `Netzwerkfehler: ${e.message}`;
      } finally {
        btn.disabled = false;
        textarea.disabled = false;
      }
    }

    btn.addEventListener('click', submitSuggest);
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitSuggest();
      }
    });
  }

  // ── Main load ─────────────────────────────────────────────────────────────

  async function loadSmartTasks() {
    const [roadmap, builds] = await Promise.all([fetchRoadmap(), fetchBuilds()]);

    if (!roadmap) {
      const c = document.getElementById('rm-checklist');
      if (c) c.innerHTML = '<div class="empty-state">projects.md nicht gefunden.</div>';
      return;
    }

    renderProgress(roadmap.stats);
    renderRoadmap(roadmap, builds);
    renderSuggestBox();
    renderBuildsPanel(builds);

    // Running-Badge im Header
    const runningCount = document.getElementById('st-running-count');
    if (runningCount) {
      const n = builds.filter(t => t.status === 'running').length;
      runningCount.textContent = n > 0 ? `${n} laufend` : `${roadmap.stats.percent}% erledigt`;
    }

    const anyRunning = builds.some(t => t.status === 'running');
    if (anyRunning) scheduleRefresh();
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  const CSS = `
    /* ── Layout ─────────────────────────────────────────────────────── */
    #view-smart-tasks .rm-layout {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* ── Progress Bar ─────────────────────────────────────────────── */
    .rm-progress-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-size: 13px;
      color: var(--text-muted, #64748b);
    }
    .rm-progress-label {
      font-weight: 600;
      color: var(--text, #e2e8f0);
    }
    .rm-progress-nums {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }
    .rm-progress-track {
      height: 10px;
      background: var(--surface, #131720);
      border: 1px solid var(--border, #1e2535);
      border-radius: 99px;
      overflow: hidden;
    }
    .rm-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #ef4444 0%, #f59e0b 40%, #22c55e 100%);
      border-radius: 99px;
      transition: width 0.6s ease;
      min-width: 4px;
    }

    /* ── Category cards ───────────────────────────────────────────── */
    .rm-category {
      background: var(--surface, #131720);
      border: 1px solid var(--border, #1e2535);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .rm-cat-summary {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      cursor: pointer;
      user-select: none;
      list-style: none;
      font-size: 13px;
      font-weight: 600;
      color: var(--text, #e2e8f0);
      border-bottom: 1px solid transparent;
    }
    .rm-category[open] .rm-cat-summary {
      border-bottom-color: var(--border, #1e2535);
    }
    .rm-cat-summary::-webkit-details-marker { display: none; }
    .rm-cat-name { flex: 1; }
    .rm-cat-stats {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-muted, #64748b);
      flex-shrink: 0;
    }
    .rm-cat-mini-bar {
      width: 60px;
      height: 5px;
      background: var(--surface-2, #1a2030);
      border-radius: 99px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .rm-cat-mini-fill {
      height: 100%;
      background: linear-gradient(90deg, #ef4444 0%, #22c55e 100%);
      border-radius: 99px;
    }
    .rm-items {
      padding: 6px 0;
    }

    /* ── Checklist Items ──────────────────────────────────────────── */
    .rm-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      border-radius: 0;
      transition: background 0.15s;
    }
    .rm-item:hover { background: var(--surface-hover, #1a2030); }
    .rm-item-done .rm-item-text {
      color: var(--text-muted, #64748b);
      text-decoration: line-through;
    }
    .rm-item-building {
      background: rgba(59, 130, 246, 0.06);
    }

    .rm-item-check-wrap {
      display: flex;
      align-items: center;
      cursor: pointer;
      flex-shrink: 0;
    }
    .rm-item-check-wrap input[type=checkbox] {
      display: none;
    }
    .rm-check-box {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border, #1e2535);
      border-radius: 4px;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, border-color 0.15s;
    }
    .rm-check-done {
      background: #22c55e;
      border-color: #22c55e;
    }
    .rm-check-done::after {
      content: '✓';
      color: #fff;
      font-size: 11px;
      line-height: 1;
    }

    .rm-item-text {
      flex: 1;
      font-size: 13px;
      color: var(--text, #e2e8f0);
      line-height: 1.4;
    }

    .rm-build-btn {
      flex-shrink: 0;
      background: var(--accent, #3b82f6);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 3px 12px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .rm-build-btn:hover:not(:disabled) { opacity: 0.8; }
    .rm-build-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Status badges inline */
    .rm-building-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #38bdf8;
      background: rgba(56,189,248,0.1);
      border: 1px solid rgba(56,189,248,0.2);
      border-radius: 12px;
      padding: 2px 9px;
      animation: pulse-dot 1.4s ease-in-out infinite;
      flex-shrink: 0;
    }
    .rm-build-done-badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      color: #4ade80;
      background: rgba(74,222,128,0.1);
      border: 1px solid rgba(74,222,128,0.2);
      border-radius: 12px;
      padding: 2px 9px;
      flex-shrink: 0;
    }
    .rm-build-error-badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      color: #f87171;
      background: rgba(248,113,113,0.1);
      border: 1px solid rgba(248,113,113,0.2);
      border-radius: 12px;
      padding: 2px 9px;
      flex-shrink: 0;
    }

    /* ── Spinner ──────────────────────────────────────────────────── */
    .rm-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 2px solid rgba(56,189,248,0.2);
      border-top-color: #38bdf8;
      border-radius: 50%;
      animation: rm-spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes rm-spin { to { transform: rotate(360deg); } }

    /* ── Builds Panel (unten) ─────────────────────────────────────── */
    .rm-builds-panel {
      background: var(--surface, #131720);
      border: 1px solid var(--border, #1e2535);
      border-radius: 12px;
      overflow: hidden;
    }
    .rm-builds-panel-header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border, #1e2535);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted, #64748b);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .rm-build-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--border, #1e2535);
      font-size: 12.5px;
      flex-wrap: wrap;
    }
    .rm-build-row:last-child { border-bottom: none; }
    .rm-build-badge {
      flex-shrink: 0;
      font-size: 10.5px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      padding: 2px 8px;
      border-radius: 10px;
    }
    .rm-build-title {
      flex: 1;
      color: var(--text, #e2e8f0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rm-build-time {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-muted, #64748b);
      flex-shrink: 0;
    }
    .rm-build-delete {
      background: transparent;
      border: none;
      color: var(--text-muted, #64748b);
      cursor: pointer;
      font-size: 13px;
      padding: 0 2px;
      flex-shrink: 0;
    }
    .rm-build-delete:hover { color: #f87171; }
    .rm-build-detail {
      width: 100%;
      padding: 0 4px;
    }
    .rm-build-pre {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text, #e2e8f0);
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--surface-2, #1a2030);
      border-radius: 6px;
      padding: 8px 10px;
      margin-top: 6px;
      max-height: 200px;
      overflow-y: auto;
    }
    .rm-build-pre-error { color: #f87171; }

    /* ── Roadmap Suggest Chat Input ──────────────────────────────── */
    .rm-suggest-box {
      background: var(--surface, #131720);
      border: 1px solid var(--border, #1e2535);
      border-radius: 12px;
      padding: 16px;
    }
    .rm-suggest-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted, #64748b);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 10px;
    }
    .rm-suggest-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .rm-suggest-textarea {
      flex: 1;
      background: var(--surface-2, #1a2030);
      border: 1px solid var(--border, #1e2535);
      border-radius: 8px;
      color: var(--text, #e2e8f0);
      font-size: 13px;
      font-family: inherit;
      padding: 8px 12px;
      resize: none;
      min-height: 40px;
      max-height: 120px;
      line-height: 1.5;
      outline: none;
      transition: border-color 0.15s;
    }
    .rm-suggest-textarea:focus {
      border-color: var(--accent, #3b82f6);
    }
    .rm-suggest-textarea::placeholder {
      color: var(--text-muted, #64748b);
    }
    .rm-suggest-btn {
      flex-shrink: 0;
      background: var(--accent, #3b82f6);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      white-space: nowrap;
    }
    .rm-suggest-btn:hover:not(:disabled) { opacity: 0.8; }
    .rm-suggest-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .rm-suggest-status {
      margin-top: 10px;
      font-size: 12.5px;
      min-height: 20px;
      color: var(--text-muted, #64748b);
    }
    .rm-suggest-status.thinking {
      color: #38bdf8;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .rm-suggest-status.success {
      color: #4ade80;
    }
    .rm-suggest-status.error {
      color: #f87171;
    }
    .rm-suggest-inserted {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .rm-suggest-inserted-item {
      font-size: 12px;
      color: #4ade80;
      background: rgba(74,222,128,0.07);
      border: 1px solid rgba(74,222,128,0.18);
      border-radius: 6px;
      padding: 4px 10px;
    }

    /* ── Header row ───────────────────────────────────────────────── */
    .st-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .st-header-row h2 {
      font-size: 16px;
      font-weight: 700;
      color: var(--text, #e2e8f0);
    }
    .st-count-badge {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted, #64748b);
      background: var(--surface, #131720);
      border: 1px solid var(--border, #1e2535);
      border-radius: 12px;
      padding: 2px 10px;
    }
  `;

  if (!document.getElementById('st-styles')) {
    const style = document.createElement('style');
    style.id = 'st-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ── Expose globally ───────────────────────────────────────────────────────
  window.loadSmartTasks = loadSmartTasks;

})();
