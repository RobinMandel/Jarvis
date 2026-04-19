// Mission Control V4 — Home View
// esc() is defined here once; email.js and calendar.js rely on it being global.
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ── Count-Up animation ────────────────────────────────────────────────────
function countUp(el, target, duration = 800) {
  if (typeof target !== 'number' || isNaN(target)) {
    el.textContent = target;
    return;
  }
  const start     = performance.now();
  const startVal  = 0;
  function frame(now) {
    const progress = Math.min((now - start) / duration, 1);
    // ease-out cubic
    const eased    = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(startVal + eased * (target - startVal));
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ── Skeleton helpers ──────────────────────────────────────────────────────
function skeletonRows(n, height = 18) {
  return Array.from({ length: n }, () =>
    `<div class="skeleton" style="height:${height}px;border-radius:4px;margin-bottom:8px"></div>`
  ).join('');
}

function showSkeletons() {
  const ids = ['home-metrics', 'home-calendar', 'home-email', 'home-feed'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = skeletonRows(id === 'home-metrics' ? 4 : 5, id === 'home-metrics' ? 64 : 20);
  });
}

// ── Main loader ───────────────────────────────────────────────────────────
async function loadHome() {
  // ── Greeting & date ──────────────────────────────────────────────────────
  const h      = new Date().getHours();
  const greet  = h < 12 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';

  const greetEl = document.getElementById('home-greeting');
  const dateEl  = document.getElementById('home-date');
  if (greetEl) greetEl.textContent = `${greet}, Robin`;
  if (dateEl)  dateEl.textContent  = new Date().toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // ── Show skeletons while fetching ────────────────────────────────────────
  showSkeletons();

  // ── Parallel API calls ───────────────────────────────────────────────────
  let sysRes = {}, calRes = { events: [] }, mailRes = { total_unread: 0 }, tasksRes = {};
  try {
    [sysRes, calRes, mailRes, tasksRes] = await Promise.all([
      fetch('/api/system').then(r => r.json()),
      fetch('/api/calendar?days=7').then(r => r.json()),
      fetch('/api/email').then(r => r.json()),
      fetch('/api/tasks').then(r => r.json()).catch(() => ({})),
    ]);
  } catch (e) {
    console.error('[home] API error:', e);
  }

  // ── Task hint banner ─────────────────────────────────────────────────────
  try {
    const urgent  = Array.isArray(tasksRes?.urgent)  ? tasksRes.urgent.length  : 0;
    const pending = Array.isArray(tasksRes?.pending) ? tasksRes.pending.length : 0;
    const total   = urgent + pending;
    const hintEl  = document.getElementById('home-task-hint');
    const textEl  = document.getElementById('home-task-hint-text');
    if (hintEl && textEl) {
      if (total > 0) {
        const parts = [];
        if (urgent)  parts.push(`<b style="color:#ef4444">${urgent} dringend</b>`);
        if (pending) parts.push(`<b>${pending} offen</b>`);
        textEl.innerHTML = `Du hast ${parts.join(' &middot; ')} &ndash; jetzt nachschauen?`;
        hintEl.style.display = 'flex';
      } else {
        hintEl.style.display = 'none';
      }
    }
  } catch (e) { console.error('[home] task hint error:', e); }

  const tgMsgs = sysRes.telegram?.messages_handled ?? 0;
  const events  = calRes.events?.length             ?? 0;
  const unread  = mailRes.total_unread              ?? 0;
  const bridge  = sysRes.bridge?.running ? 'Online' : 'Offline';

  // ── KPI Metrics ──────────────────────────────────────────────────────────
  const metricsEl = document.getElementById('home-metrics');
  if (metricsEl) {
    const defs = [
      { label: 'Ungelesen',   value: unread,  numeric: true,  color: unread > 0 ? 'var(--accent)' : 'var(--ok)' },
      { label: 'Events (7d)', value: events,  numeric: true  },
      { label: 'Telegram',    value: tgMsgs,  numeric: true  },
      { label: 'Bridge',      value: bridge,  numeric: false, color: bridge === 'Online' ? 'var(--ok)' : 'var(--error)' },
    ];

    metricsEl.innerHTML = defs.map((m, i) =>
      `<div class="metric-card">
         <div class="metric-value" id="kpi-${i}" style="${m.color ? 'color:' + m.color : ''}">0</div>
         <div class="metric-label">${m.label}</div>
       </div>`
    ).join('');

    // Trigger count-up for numeric KPIs, static text for string ones
    defs.forEach((m, i) => {
      const el = document.getElementById(`kpi-${i}`);
      if (!el) return;
      if (m.numeric) countUp(el, m.value);
      else el.textContent = m.value;
    });
  }

  // ── Calendar widget ───────────────────────────────────────────────────────
  const calCountEl = document.getElementById('home-cal-count');
  const calBodyEl  = document.getElementById('home-calendar');
  if (calCountEl) calCountEl.textContent = events;
  if (calBodyEl) {
    if (!calRes.events?.length) {
      calBodyEl.innerHTML = '<div class="empty-state">Keine Termine</div>';
    } else {
      calBodyEl.innerHTML = calRes.events.slice(0, 5).map(e => {
        const isAllDay = !e.start?.includes('T');
        const time     = isAllDay ? 'Ganztägig' : e.start.slice(11, 16);
        const day      = (e.start || '').slice(5, 10).replace('-', '.');
        return `<div class="feed-item">
                  <span class="feed-time">${day} ${time}</span>
                  <div class="feed-text">${esc(e.summary)}</div>
                </div>`;
      }).join('');
    }
  }

  // ── Email widget ──────────────────────────────────────────────────────────
  const emailCountEl = document.getElementById('home-email-count');
  const emailBodyEl  = document.getElementById('home-email');
  if (emailCountEl) emailCountEl.textContent = unread;
  if (emailBodyEl) {
    const allMail = [...(mailRes.outlook || []), ...(mailRes.uni || [])];
    if (!allMail.length) {
      emailBodyEl.innerHTML = '<div class="empty-state">Keine ungelesenen Mails</div>';
    } else {
      emailBodyEl.innerHTML = allMail.slice(0, 6).map(m => {
        const badge = m.account === 'Uni'
          ? '<span class="email-badge uni">UNI</span>'
          : '<span class="email-badge outlook">OL</span>';
        return `<div class="feed-item" style="display:flex;gap:8px;align-items:center">
                  ${badge}
                  <div style="flex:1;min-width:0">
                    <div style="font-size:12px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.from)}</div>
                    <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.subject)}</div>
                  </div>
                </div>`;
      }).join('');
    }
  }

  // ── Activity feed ─────────────────────────────────────────────────────────
  const feedEl = document.getElementById('home-feed');
  if (feedEl) {
    const lastCheck = sysRes.heartbeat?.last_check_time || 'Nie';
    const lastSync  = sysRes.memory_sync?.last_sync     || 'Nie';
    const outlookN  = sysRes.heartbeat?.unread_outlook  ?? 0;
    const uniN      = sysRes.heartbeat?.unread_uni      ?? 0;

    feedEl.innerHTML = `
      <div class="feed-item">
        <span class="feed-time">${esc(lastCheck)}</span>
        <div class="feed-text">Heartbeat — ${outlookN} Outlook, ${uniN} Uni ungelesen</div>
      </div>
      <div class="feed-item">
        <span class="feed-time">${esc(lastSync)}</span>
        <div class="feed-text">Memory Sync — Tageslog aktualisiert</div>
      </div>
      <div class="feed-item">
        <span class="feed-time">Startup</span>
        <div class="feed-text">Telegram Bridge — ${tgMsgs} Nachrichten verarbeitet</div>
      </div>
    `;
  }
}
