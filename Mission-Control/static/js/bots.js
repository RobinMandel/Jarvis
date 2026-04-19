// Mission Control — Bots & Cron Panel
(function () {
  let _refreshTimer = null;

  const STATUS_COLOR = {
    running:   '#22c55e',
    stopped:   '#ef4444',
    ready:     '#3b82f6',
    disabled:  '#6b7280',
    queued:    '#f59e0b',
    running_task: '#a855f7',
    scheduled: '#14b8a6',
    unknown:   '#6b7280',
  };

  function dot(color) {
    return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;flex-shrink:0;box-shadow:0 0 6px ${color}88"></span>`;
  }

  function relTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      const now = new Date();
      const diff = Math.round((now - d) / 60000);
      if (diff < 0) {
        const m = Math.abs(diff);
        if (m < 60) return `in ${m}min`;
        if (m < 1440) return `in ${Math.round(m/60)}h`;
        return `in ${Math.round(m/1440)}d`;
      }
      if (diff < 2) return 'gerade eben';
      if (diff < 60) return `vor ${diff}min`;
      if (diff < 1440) return `vor ${Math.round(diff/60)}h`;
      return `vor ${Math.round(diff/1440)}d`;
    } catch (_) { return isoStr; }
  }

  // ── Detail Modal ────────────────────────────────────────────────────────
  function openDissModal() {
    let modal = document.getElementById('bots-diss-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bots-diss-modal';
      modal.style.cssText = `position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px`;
      modal.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--border-medium);border-radius:16px;width:100%;max-width:820px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
          <div style="display:flex;align-items:center;gap:12px;padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle)">
            <span style="font-size:22px">🔬</span>
            <div>
              <div style="font-size:16px;font-weight:700;color:var(--text-primary)">Nacht-Recherche — Diss</div>
              <div style="font-size:12px;color:var(--text-muted)" id="diss-modal-meta">Lädt...</div>
            </div>
            <button onclick="document.getElementById('bots-diss-modal').remove()" style="margin-left:auto;background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;line-height:1;padding:4px">✕</button>
          </div>
          <div style="overflow-y:auto;flex:1;padding:0 24px 24px" id="diss-modal-body">
            <div style="padding:40px;text-align:center;color:var(--text-muted)">Lädt...</div>
          </div>
        </div>`;
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    loadDissDetail();
  }

  async function loadDissDetail() {
    const body = document.getElementById('diss-modal-body');
    const meta = document.getElementById('diss-modal-meta');
    try {
      const res = await fetch('/api/bots/diss-research');
      const data = await res.json();
      if (meta) meta.textContent = `${data.total_runs} Läufe · ${data.total_papers} einzigartige Papers`;

      // Latest run summary
      const latest = data.runs[0] || {};
      const allPapers = data.all_papers || [];

      let html = '';

      // ── Letzter Lauf ──
      if (latest.date) {
        html += `<div style="margin-top:20px">
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Letzter Lauf · ${latest.date}</div>
          <div style="background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:10px;padding:14px 16px;font-size:13px;color:var(--text-secondary);line-height:1.6">${latest.summary || '—'}</div>`;
        if (latest.research_gap) {
          html += `<div style="margin-top:8px;background:rgba(59,130,246,0.07);border:1px solid rgba(59,130,246,0.2);border-radius:8px;padding:10px 14px;font-size:12px;color:#93c5fd"><b>Research Gap:</b> ${latest.research_gap}</div>`;
        }
        html += `</div>`;
      }

      // ── Alle Läufe Übersicht ──
      if (data.runs.length > 1) {
        html += `<div style="margin-top:24px">
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Alle Läufe</div>
          <div style="display:flex;flex-direction:column;gap:8px">`;
        data.runs.forEach(run => {
          const count = (run.items || []).length;
          const stars5 = (run.items || []).filter(i => i.stars >= 5).length;
          html += `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:8px;cursor:pointer" onclick="toggleRunDetail('run-${run.date}')">
            <span style="font-size:12px;color:var(--text-muted);min-width:90px">${run.date}</span>
            <span style="font-size:12px;color:var(--text-secondary)">${count} Papers</span>
            ${stars5 ? `<span style="font-size:11px;color:#fbbf24">⭐ ${stars5}×5★</span>` : ''}
            <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${run.summary ? run.summary.slice(0,80)+'…' : ''}</span>
          </div>
          <div id="run-${run.date}" style="display:none;padding:0 12px 8px">
            ${renderPaperList(run.items || [], run.date)}
          </div>`;
        });
        html += `</div></div>`;
      }

      // ── Alle Papers (deduped, nach Stars) ──
      html += `<div style="margin-top:24px">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Alle Papers (${allPapers.length} · nach Relevanz)</div>
        ${renderPaperList(allPapers)}
      </div>`;

      if (body) body.innerHTML = html;
    } catch (e) {
      if (body) body.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444">Fehler: ${e.message}</div>`;
    }
  }

  function renderPaperList(papers, runDate) {
    if (!papers.length) return '<div style="color:var(--text-muted);font-size:12px;padding:8px">Keine Papers</div>';
    return papers.map(p => {
      const stars = '⭐'.repeat(Math.min(p.stars || 0, 5));
      const doiLink = p.doi ? `<a href="https://doi.org/${p.doi}" target="_blank" style="color:#3b82f6;font-size:11px;text-decoration:none">DOI ↗</a>` : '';
      const runBadge = p.run_date && !runDate ? `<span style="font-size:10px;color:var(--text-dim);margin-left:6px">${p.run_date}</span>` : '';
      return `<div style="padding:12px;margin-bottom:8px;background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:8px">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <span style="font-size:12px;min-width:60px;white-space:nowrap">${stars}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);line-height:1.4">${p.title || '—'}${runBadge}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${p.authors || ''} ${p.journal ? '· '+p.journal : ''}</div>
            ${p.summary ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:6px;line-height:1.5">${p.summary}</div>` : ''}
          </div>
          <div style="flex-shrink:0">${doiLink}</div>
        </div>
      </div>`;
    }).join('');
  }

  window.toggleRunDetail = function(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };

  function renderServices(services) {
    const el = document.getElementById('bots-services');
    if (!el) return;
    if (!services || !services.length) {
      el.innerHTML = '<div style="color:var(--text-muted);padding:12px">Keine Daten</div>';
      return;
    }
    el.innerHTML = services.map(s => {
      const color = STATUS_COLOR[s.status] || STATUS_COLOR.unknown;
      const clickable = s.name === 'Nacht-Recherche';
      const clickAttr = clickable ? 'onclick="window.openDissResearch()" style="cursor:pointer"' : '';
      return `<div ${clickAttr} style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-subtle)${clickable ? ';border-radius:6px' : ''}">
        <div style="font-size:18px;line-height:1;padding-top:2px">${s.icon || '⚙'}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px">
            ${dot(color)}
            <span style="font-weight:600;color:var(--text-primary);font-size:13px">${s.name}</span>
            ${clickable ? '<span style="font-size:10px;color:#3b82f6;margin-left:4px">→ Details</span>' : ''}
            <span style="font-size:11px;color:${color};margin-left:auto;white-space:nowrap">${s.status}</span>
          </div>
          ${s.detail ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;padding-left:14px">${s.detail}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
  window.openDissResearch = openDissModal;

  function renderCronJobs(jobs) {
    const el = document.getElementById('bots-crons');
    if (!el) return;
    if (!jobs || !jobs.length) {
      el.innerHTML = '<div style="color:var(--text-muted);padding:12px">Keine Scheduled Tasks gefunden</div>';
      return;
    }
    // Sort: running first, then ready, then disabled
    const ORDER = { running: 0, queued: 1, ready: 2, scheduled: 3, unknown: 4, disabled: 5 };
    jobs = [...jobs].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9));

    el.innerHTML = jobs.map(j => {
      const color = STATUS_COLOR[j.state] || STATUS_COLOR.unknown;
      const lastRun = j.last_run ? relTime(j.last_run) : '—';
      const nextRun = j.next_run ? relTime(j.next_run) : '—';
      const isDiss = j.name === 'Jarvis Diss-Recherche';
      const clickAttr = isDiss ? 'onclick="window.openDissResearch()" style="cursor:pointer"' : '';
      return `<div ${clickAttr} style="display:flex;align-items:flex-start;gap:8px;padding:9px 0;border-bottom:1px solid var(--border-subtle)${isDiss ? ';border-radius:6px' : ''}">
        ${dot(color)}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${j.name}</span>
            ${isDiss ? '<span style="font-size:10px;color:#3b82f6">→ Details</span>' : ''}
            <span style="font-size:11px;color:${color};margin-left:auto;white-space:nowrap">${j.state}</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
            Zuletzt: <span style="color:var(--text-secondary)">${lastRun}</span>
            &nbsp;·&nbsp;
            Nächster: <span style="color:var(--text-secondary)">${nextRun}</span>
          </div>
          ${j.description ? `<div style="font-size:11px;color:var(--text-dim);margin-top:1px">${j.description}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function renderMCSessions(sessions) {
    const el = document.getElementById('bots-sessions');
    if (!el) return;
    if (!sessions || !sessions.length) {
      el.innerHTML = '<div style="color:var(--text-muted);padding:12px">Keine aktiven Sessions</div>';
      return;
    }
    el.innerHTML = sessions.map(s => {
      const topicColor = s.topic_color || '#3b82f6';
      const label = s.title || s.session_id.slice(0, 8);
      const msgs = s.message_count || 0;
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-subtle)">
        <span style="width:10px;height:10px;border-radius:50%;background:${topicColor};flex-shrink:0;box-shadow:0 0 5px ${topicColor}88"></span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text-primary);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
          ${s.topic ? `<div style="font-size:11px;color:var(--text-muted)">${s.topic}</div>` : ''}
        </div>
        <span style="font-size:11px;color:var(--text-dim);white-space:nowrap">${msgs} Msgs</span>
      </div>`;
    }).join('');
  }

  async function loadBots() {
    const tsEl = document.getElementById('bots-refresh-ts');
    try {
      const res = await fetch('/api/bots');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      renderServices(data.services || []);
      renderCronJobs(data.cron_jobs || []);
      renderMCSessions(data.mc_sessions || []);
      if (tsEl) tsEl.textContent = 'Aktualisiert ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      console.error('[Bots] load failed:', e);
      if (tsEl) tsEl.textContent = 'Fehler beim Laden';
    }
  }

  window.initBotsView = function () {
    loadBots();
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(loadBots, 15000);
  };

  window.destroyBotsView = function () {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  };
})();
