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

  return { load };
})();
