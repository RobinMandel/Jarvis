// Diss View
const DISS_PHASES = [
  { id: 'elisa', label: 'ELISA / Biomarker', pct: 15, color: 'var(--accent)', note: 'NGAL, MPO, IL-6 Daten vorhanden' },
  { id: 'klinik', label: 'Klinische Daten', pct: 40, color: 'var(--accent)', note: 'Baseline-Tabellen erstellt, KDIGO ausstehend' },
  { id: 'korr', label: 'Korrelationen', pct: 5, color: 'var(--teal)', note: 'PRISM-Hub noch nicht verzahnt' },
  { id: 'flow', label: 'Flow-Zytometrie', pct: 10, color: 'var(--info)', note: '229 .fcs Dateien, CD10/CD16 Analyse geplant' },
  { id: 'manu', label: 'Manuskript', pct: 5, color: 'var(--warn)', note: 'Gliederung steht, IMRaD-Struktur' },
];

const DISS_FIGURES = [
  { icon: '📉', title: 'Fig 1 · CD10low Verlauf', status: 'planned' },
  { icon: '📈', title: 'Fig 2 · CD16 Kinetik', status: 'planned' },
  { icon: '🔵', title: 'Fig 3 · Korrelation ELISA', status: 'idea' },
  { icon: '📋', title: 'Fig 4 · Klinische Outcomes', status: 'idea' },
  { icon: '🧫', title: 'Fig 5 · Flow-Zytometrie', status: 'idea' },
];

// ── Session Topic ──────────────────────────────────────────
async function loadDissSessionTopic() {
  try {
    const res = await fetch('/api/diss/session-topic');
    const data = await res.json();
    const display = document.getElementById('diss-topic-display');
    if (display) {
      display.textContent = data.topic
        ? (data.date ? data.date + ' — ' + data.topic : data.topic)
        : 'Kein Thema gesetzt';
    }
  } catch(e) { /* ignore */ }
}

function initDissTopicEditor() {
  const editBtn = document.getElementById('diss-topic-edit-btn');
  const saveBtn = document.getElementById('diss-topic-save-btn');
  const display = document.getElementById('diss-topic-display');
  const input   = document.getElementById('diss-topic-input');
  if (!editBtn) return;

  editBtn.addEventListener('click', function() {
    display.style.display = 'none';
    input.style.display   = 'flex';
    editBtn.style.display = 'none';
    saveBtn.style.display = '';
    const text = display.textContent;
    input.value = text.includes('—') ? text.split('—').slice(1).join('—').trim() : '';
    input.focus();
  });

  saveBtn.addEventListener('click', async function() {
    const topic = input.value.trim();
    const date  = new Date().toISOString().slice(0, 10);
    await fetch('/api/diss/session-topic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic, date: date })
    });
    display.textContent   = topic ? date + ' — ' + topic : 'Kein Thema gesetzt';
    display.style.display = '';
    input.style.display   = 'none';
    editBtn.style.display = '';
    saveBtn.style.display = 'none';
  });

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  { saveBtn.click(); }
    if (e.key === 'Escape') {
      display.style.display = '';
      input.style.display   = 'none';
      editBtn.style.display = '';
      saveBtn.style.display = 'none';
    }
  });
}

// ── Wiki Log ───────────────────────────────────────────────
async function loadWikiLog() {
  try {
    const res  = await fetch('/api/diss/wiki-log');
    const data = await res.json();
    const container = document.getElementById('diss-wiki-log');
    const countEl   = document.getElementById('diss-wiki-count');
    if (!container) return;
    if (!data.entries || !data.entries.length) {
      container.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Noch keine Einträge im Wiki-Log.</div>';
      return;
    }
    const sourceCount = data.entries.filter(function(e) { return e.header.includes('ingest'); }).length;
    if (countEl) countEl.textContent = sourceCount + ' ingestiert';
    container.innerHTML = data.entries.map(function(e) {
      var body = e.body.length > 200 ? e.body.slice(0, 200) + '…' : e.body;
      return '<div class="diss-log-entry">' +
        '<div class="diss-log-header">' + e.header + '</div>' +
        '<div class="diss-log-body">' + body + '</div>' +
        '</div>';
    }).join('');
  } catch(e) { /* ignore */ }
}

// ── Wissens-Trichter (Ingest Funnel) ──────────────────────
function initDissFunnel() {
  const btn    = document.getElementById('diss-ingest-btn');
  const status = document.getElementById('diss-ingest-status');
  const textEl = document.getElementById('diss-ingest-text');
  const typeEl = document.getElementById('diss-ingest-type');
  if (!btn) return;

  btn.addEventListener('click', async function() {
    const content = textEl.value.trim();
    if (!content) { status.textContent = 'Kein Text eingegeben.'; return; }
    btn.disabled = true;
    status.textContent = '⏳ Wird ingestiert...';

    const typeLabels = { paper: 'Paper/Abstract', notes: 'Eigene Notizen', data: 'Daten/Ergebnisse', quote: 'Zitat/Beobachtung' };
    const contentType = typeEl ? typeEl.value : 'notes';
    const typeLabel   = typeLabels[contentType] || contentType;

    const prompt = 'Ingestiere den folgenden Inhalt (Typ: ' + typeLabel + ') in die ITI-Dissertation-Wiki.\n\n' +
      'Wiki-Pfad: E:\\\\OneDrive\\\\Dokumente\\\\Studium\\\\!!Medizin\\\\03 Doktorarbeit\\\\ITI\\\\Jarvis Workspace\\\\wiki\\\\\n\n' +
      'Führe den vollständigen Ingest-Workflow aus (SCHEMA.md lesen, dann Source-Page oder Notiz-Page anlegen, ' +
      'relevante Entity-Pages aktualisieren, index.md und log.md updaten).\n\n' +
      'INHALT:\n' + content;

    try {
      const createRes = await fetch('/api/smart-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Wiki-Ingest: ' + typeLabel + ' — ' + content.slice(0, 60) + '...',
          prompt: prompt
        })
      });
      const task = await createRes.json();
      if (!task.id) throw new Error('Task-Erstellung fehlgeschlagen');
      await fetch('/api/smart-tasks/' + task.id + '/start', { method: 'POST' });
      status.innerHTML = '✅ Ingest gestartet — <a href="#" onclick="MC.nav&&MC.nav.go&&MC.nav.go(\'tasks\');return false" style="color:var(--accent)">Tasks ansehen</a>';
      textEl.value = '';
      setTimeout(loadWikiLog, 4000);
    } catch(err) {
      status.textContent = '❌ Fehler: ' + err.message;
    }
    btn.disabled = false;
  });
}

// ── Diss Chat ──────────────────────────────────────────────
var _dissChatSession = null;
var _dissChatReady   = false;
var _pendingDissMsg  = null;

function dissAppendMsg(role, text) {
  var msgsEl = document.getElementById('diss-chat-messages');
  if (!msgsEl) return;
  var el = document.createElement('div');
  el.className = 'diss-chat-msg ' + role;
  el.textContent = text;
  msgsEl.appendChild(el);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return el;
}

function initDissChat() {
  var sendBtn = document.getElementById('diss-chat-send');
  var inputEl = document.getElementById('diss-chat-input');
  var msgsEl  = document.getElementById('diss-chat-messages');
  if (!sendBtn || !MC.ws) return;

  // Token streaming for diss session
  MC.ws.on('chat.token', function(d) {
    if (d.session_id !== _dissChatSession) return;
    var el = msgsEl.querySelector('.thinking-bubble');
    if (!el) {
      el = document.createElement('div');
      el.className = 'diss-chat-msg assistant thinking-bubble';
      msgsEl.appendChild(el);
    }
    el.textContent = (el.textContent || '') + (d.token || '');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });

  MC.ws.on('chat.response', function(d) {
    if (d.session_id !== _dissChatSession) return;
    var el = msgsEl.querySelector('.thinking-bubble');
    if (el) el.className = 'diss-chat-msg assistant';
    sendBtn.disabled = false;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });

  MC.ws.on('chat.new_session', function(d) {
    if (_dissChatSession) return; // already have one
    _dissChatSession = d.session_id;
    var label = document.getElementById('diss-chat-session-label');
    if (label) label.textContent = d.session_id.slice(0, 8);
    // Seed with minimal context
    MC.ws.send({
      type: 'chat.send',
      session_id: _dissChatSession,
      message: '[Diss-Chat init] Du bist im Diss-Modus. Kontext: Dissertation Neutrophile + CS-AKI, Kohorte KC_01-KC_26. Wiki unter ITI/Jarvis Workspace/wiki/. Antworte auf Deutsch, präzise. Bestätige kurz.'
    });
    _dissChatReady = true;
    // Send any pending message
    if (_pendingDissMsg) {
      setTimeout(function() {
        MC.ws.send({ type: 'chat.send', session_id: _dissChatSession, message: _pendingDissMsg });
        _pendingDissMsg = null;
      }, 600);
    }
  });

  function sendDissMsg() {
    var msg = inputEl.value.trim();
    if (!msg) return;
    dissAppendMsg('user', msg);
    inputEl.value = '';

    var thinkEl = document.createElement('div');
    thinkEl.className = 'diss-chat-msg thinking thinking-bubble';
    thinkEl.textContent = '...';
    msgsEl.appendChild(thinkEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    sendBtn.disabled = true;

    if (_dissChatSession && _dissChatReady) {
      MC.ws.send({ type: 'chat.send', session_id: _dissChatSession, message: msg });
    } else {
      _pendingDissMsg = msg;
      if (!_dissChatSession) MC.ws.send({ type: 'chat.new_session' });
    }
  }

  sendBtn.addEventListener('click', sendDissMsg);
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDissMsg(); }
  });

  // Init session
  if (!_dissChatSession) MC.ws.send({ type: 'chat.new_session' });
}

// ── Main load ─────────────────────────────────────────────
async function loadDiss() {
  // Progress bars
  const progress = document.getElementById('diss-progress');
  if (progress) progress.innerHTML = DISS_PHASES.map(p =>
    '<div style="margin-bottom:16px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span class="diss-progress-label">' + p.label + '</span>' +
        '<span class="diss-progress-pct">' + p.pct + '%</span>' +
      '</div>' +
      '<div class="diss-bar-wrap">' +
        '<div class="diss-bar-fill" style="width:' + p.pct + '%;background:' + p.color + '"></div>' +
      '</div>' +
      '<div class="diss-note">' + p.note + '</div>' +
    '</div>'
  ).join('');

  // Figures
  const figures = document.getElementById('diss-figures');
  if (figures) figures.innerHTML = '<div class="diss-figure-grid">' +
    DISS_FIGURES.map(f =>
      '<div class="diss-figure-card">' +
        '<div class="diss-figure-icon">' + f.icon + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:600;color:var(--text-strong);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + f.title + '</div>' +
          '<div style="margin-top:4px"><span class="diss-badge diss-badge-' + f.status + '">' + f.status + '</span></div>' +
        '</div>' +
      '</div>'
    ).join('') + '</div>';

  // Night research
  const research = document.getElementById('diss-research');
  if (research) {
    try {
      const res  = await fetch('/api/diss/research');
      const data = await res.json();
      if (data.results && data.results.length) {
        research.innerHTML = data.results.map(r =>
          '<div class="feed-item">' +
            '<span class="feed-time">' + r.date + '</span>' +
            '<div class="feed-text">' + (r.takeaway || r.summary || 'Keine Zusammenfassung') + '</div>' +
          '</div>'
        ).join('');
      } else {
        research.innerHTML = '<div class="empty-state">Keine Recherche-Ergebnisse. Cron läuft täglich um 02:00.</div>';
      }
    } catch(e) {
      research.innerHTML = '<div class="empty-state">Recherche-API nicht verfügbar</div>';
    }
  }

  // New features
  await loadDissSessionTopic();
  initDissTopicEditor();
  await loadWikiLog();
  initDissFunnel();
  initDissChat();
}
