// Tasks panel — kanban board + dashboard widget
MC.tasks = (function() {
  let data = { urgent: [], pending: [], done: [] };

  let _retryTimer = null;
  async function load() {
    try {
      const res = await fetch(MC.config.apiBase + '/tasks', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      data = await res.json();
      renderBoard();
      renderDashboardWidget();
      renderStaleHeader();
      if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    } catch {
      // Fehlgeschlagen (z.B. Server startet noch) – einmaliger Retry nach 2s
      if (!_retryTimer) {
        _retryTimer = setTimeout(() => { _retryTimer = null; load(); }, 2000);
      }
    }
  }

  function renderBoard() {
    renderColumn('tasks-urgent', data.urgent || []);
    renderColumn('tasks-pending', data.pending || []);
    renderColumn('tasks-done', data.done || []);
  }

  function renderColumn(elId, tasks) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!tasks.length) {
      el.innerHTML = '<div class="empty-state">Keine Tasks</div>';
      return;
    }
    el.innerHTML = tasks.map(t => `
      <div class="task-card">
        <div>${t.text}</div>
        ${t.tags ? '<div class="task-tags">' + t.tags.map(tag => `<span class="task-tag">${tag}</span>`).join('') + '</div>' : ''}
        ${t.created ? '<div class="task-date">' + t.created + '</div>' : ''}
      </div>
    `).join('');
  }

  function renderDashboardWidget() {
    const el = document.getElementById('dashboard-tasks');
    if (!el) return;
    const all = [...(data.urgent || []), ...(data.pending || [])];
    const count = document.getElementById('task-count');
    if (count) count.textContent = all.length;

    if (!all.length) {
      el.innerHTML = '<div class="empty-state">Keine offenen Tasks</div>';
      return;
    }
    el.innerHTML = all.slice(0, 5).map(t => `
      <div class="task-card">
        <div>${t.text}</div>
        ${t.tags ? '<div class="task-tags">' + t.tags.map(tag => `<span class="task-tag">${tag}</span>`).join('') + '</div>' : ''}
      </div>
    `).join('');
  }

  // Tasks older than STALE_DAYS days in urgent/pending = "aufgegeben"
  const STALE_DAYS = 7;

  function _daysSince(dateStr) {
    if (!dateStr) return 0;
    const d = new Date(dateStr);
    if (isNaN(d)) return 0;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function renderStaleHeader() {
    const badge = document.getElementById('staleBadge');
    const countEl = document.getElementById('staleCount');
    const listEl = document.getElementById('staleList');
    if (!badge || !countEl || !listEl) return;

    const all = [...(data.urgent || []).map(t => ({...t, _col:'urgent'})),
                 ...(data.pending || []).map(t => ({...t, _col:'pending'}))];
    const stale = all.filter(t => _daysSince(t.created) >= STALE_DAYS);

    if (!stale.length) {
      badge.classList.add('hidden');
      return;
    }
    badge.classList.remove('hidden');
    countEl.textContent = stale.length;

    listEl.innerHTML = stale.slice(0, 8).map(t => {
      const age = _daysSince(t.created);
      const text = t.text.length > 60 ? t.text.slice(0, 57) + '…' : t.text;
      return `<div class="stale-item">
        <div>${text}</div>
        <div class="stale-item-age">seit ${age} Tagen offen${t._col === 'urgent' ? ' · DRINGEND' : ''}</div>
      </div>`;
    }).join('');
  }

  // Toggle dropdown on badge click
  document.addEventListener('DOMContentLoaded', () => {
    const badge = document.getElementById('staleBadge');
    const dropdown = document.getElementById('staleDropdown');
    const footer = document.getElementById('staleFooter');
    if (!badge || !dropdown) return;

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdown.classList.remove('open'));
    if (footer) footer.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      if (typeof MC !== 'undefined' && MC.switchView) MC.switchView('tasks');
    });
  });

  return { load };
})();
