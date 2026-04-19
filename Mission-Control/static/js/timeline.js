// Timeline panel
MC.timeline = (function() {

  async function load() {
    try {
      const res = await fetch(MC.config.apiBase + '/timeline');
      const data = await res.json();
      render(data);
    } catch {}
  }

  function render(items) {
    const el = document.getElementById('timeline-panel');
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = '<div class="empty-state">Keine Events</div>';
      return;
    }
    el.innerHTML = items.slice().reverse().map(item => {
      const time = new Date(item.timestamp).toLocaleString('de', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<div class="timeline-item">
        <span class="timeline-dot ${item.type || 'system'}"></span>
        <span class="timeline-text">${item.event}</span>
        <span class="timeline-time">${time}</span>
      </div>`;
    }).join('');
  }

  return { load };
})();
