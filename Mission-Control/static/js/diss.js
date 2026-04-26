// Diss View
const DISS_PHASES = [
  { id: 'elisa', label: 'ELISA / Biomarker', pct: 15, color: 'var(--accent)', note: 'NGAL, MPO, IL-6 Daten vorhanden' },
  { id: 'klinik', label: 'Klinische Daten', pct: 40, color: 'var(--accent)', note: 'Baseline-Tabellen erstellt, KDIGO ausstehend' },
  { id: 'korr', label: 'Korrelationen', pct: 5, color: 'var(--teal)', note: 'Prism-Analyse-Panel aktiv — CSV einfügen &amp; analysieren' },
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

// ── Delta-Log ─────────────────────────────────────────────
const DELTA_CATS = { finding: '🔬', decision: '✅', todo: '📌', insight: '💡' };

async function loadDeltaLog() {
  const list = document.getElementById('diss-delta-list');
  const badge = document.getElementById('diss-delta-count');
  if (!list) return;
  try {
    const res  = await fetch('/api/diss/delta');
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">Noch keine Ergebnisse gespeichert.</div>';
      if (badge) badge.textContent = '0';
      return;
    }
    if (badge) badge.textContent = data.length;
    list.innerHTML = data.slice(0, 30).map(function(e) {
      var icon = DELTA_CATS[e.category] || '📝';
      var date = (e.ts || '').slice(0, 16).replace('T', ' ');
      var src  = e.source ? ' · <span style="color:var(--text-muted)">' + e.source.slice(0, 40) + '</span>' : '';
      return '<div style="display:flex;gap:8px;margin-bottom:8px;padding:8px 10px;background:var(--surface3,#151c2c);border-radius:6px;border-left:2px solid var(--border)">' +
        '<span style="font-size:14px;flex-shrink:0">' + icon + '</span>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;color:var(--text);line-height:1.5;white-space:pre-wrap;word-break:break-word">' + e.text + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);margin-top:4px">' + date + src + '</div>' +
        '</div>' +
        '<button onclick="deleteDeltaEntry(\'' + e.id + '\')" title="Löschen" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;flex-shrink:0;padding:0 2px">✕</button>' +
      '</div>';
    }).join('');
  } catch(e) { /* ignore */ }
}

async function deleteDeltaEntry(id) {
  try {
    await fetch('/api/diss/delta?id=' + id, { method: 'DELETE' });
    await loadDeltaLog();
  } catch(e) { /* ignore */ }
}

function initDeltaInput() {
  const saveBtn  = document.getElementById('diss-delta-save');
  const textEl   = document.getElementById('diss-delta-text');
  const catEl    = document.getElementById('diss-delta-cat');
  const srcEl    = document.getElementById('diss-delta-src');
  const statusEl = document.getElementById('diss-delta-status');
  if (!saveBtn || !textEl) return;

  saveBtn.addEventListener('click', async function() {
    var text = textEl.value.trim();
    if (!text) return;
    saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = '…';
    try {
      const res = await fetch('/api/diss/delta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text:     text,
          category: catEl ? catEl.value : 'finding',
          source:   srcEl ? srcEl.value.trim() : '',
        })
      });
      const d = await res.json();
      if (d.ok) {
        textEl.value = '';
        if (srcEl) srcEl.value = '';
        if (statusEl) statusEl.textContent = '✅ Gespeichert';
        setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 2500);
        await loadDeltaLog();
      } else {
        if (statusEl) statusEl.textContent = '❌ ' + (d.error || 'Fehler');
      }
    } catch(e) {
      if (statusEl) statusEl.textContent = '❌ Netzwerkfehler';
    }
    saveBtn.disabled = false;
  });

  textEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.ctrlKey) saveBtn.click();
  });
}

// ── Prism-History ─────────────────────────────────────────
async function loadPrismHistory(container) {
  if (!container) return;
  try {
    var res  = await fetch('/api/diss/prism-results');
    var data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      document.getElementById('prism-history').style.display = 'none';
      return;
    }
    document.getElementById('prism-history').style.display = '';
    container.innerHTML = data.slice(-8).reverse().map(function(r) {
      var date  = (r.ts || r.saved_at || '').slice(0, 16).replace('T', ' ');
      var label = (r.mode === 'figure' ? 'Legende' : 'Results') + ' · ' + (r.context || '').slice(0, 40);
      var text  = (r.output || '').slice(0, 160) + ((r.output || '').length > 160 ? '…' : '');
      return '<div style="margin-bottom:10px;padding:8px 10px;background:var(--surface3,#151c2c);border-radius:6px;border-left:2px solid var(--border)">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
          '<span style="font-size:11px;font-weight:600;color:var(--accent)">' + label + '</span>' +
          '<span style="font-size:10px;color:var(--text-muted)">' + date + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-muted);line-height:1.5;white-space:pre-wrap">' + text + '</div>' +
      '</div>';
    }).join('');
  } catch(e) { /* ignore */ }
}

// ── Prism-Analyse ─────────────────────────────────────────
function initPrismAnalyse() {
  const analyseBtn = document.getElementById('prism-analyse-btn');
  const figureBtn  = document.getElementById('prism-figure-btn');
  const dataEl     = document.getElementById('prism-data');
  const contextEl  = document.getElementById('prism-context');
  const customCtx  = document.getElementById('prism-custom-ctx');
  const statusEl   = document.getElementById('prism-status');
  const resultBox  = document.getElementById('prism-result');
  const resultText = document.getElementById('prism-result-text');
  const copyBtn    = document.getElementById('prism-copy-btn');
  const toWordBtn  = document.getElementById('prism-to-word-btn');
  const csvFile    = document.getElementById('prism-csv-file');
  const csvName    = document.getElementById('prism-csv-name');
  const autoCheck  = document.getElementById('prism-auto');
  const historyEl  = document.getElementById('prism-history-list');
  if (!analyseBtn) return;

  // Load history on init
  loadPrismHistory(historyEl);

  if (csvFile) {
    csvFile.addEventListener('change', function() {
      var files = Array.from(csvFile.files);
      if (!files.length) return;
      csvName.textContent = files.length === 1 ? files[0].name : files.length + ' Dateien geladen';
      // Read all files, concatenate with separator
      var contents = [];
      var done = 0;
      files.forEach(function(file, idx) {
        var reader = new FileReader();
        reader.onload = function(e) {
          contents[idx] = '=== ' + file.name + ' ===\n' + e.target.result;
          done++;
          if (done === files.length) {
            dataEl.value = contents.join('\n\n');
            // Auto-trigger analysis when checked
            if (autoCheck && autoCheck.checked) {
              setTimeout(function() { analyseBtn.click(); }, 200);
            }
          }
        };
        reader.readAsText(file, 'UTF-8');
      });
    });
  }

  contextEl.addEventListener('change', function() {
    customCtx.style.display = contextEl.value === 'custom' ? '' : 'none';
  });

  async function runAnalysis(mode) {
    var data = dataEl.value.trim();
    if (!data) { statusEl.textContent = 'Keine Daten eingegeben.'; return; }
    analyseBtn.disabled = figureBtn.disabled = true;
    statusEl.textContent = '\u23f3 Analysiere...';
    resultBox.style.display = 'none';

    var ctxLabels = {
      'correlation':      'Korrelationsanalyse (ELISA-Biomarker + klinische Parameter)',
      'group-comparison': 'Gruppenvergleich AKI vs. Non-AKI',
      'timecourse':       'Zeitverlauf-Analyse Biomarker-Kinetik',
      'flow':             'Flow-Zytometrie CD10/CD16 Neutrophilen-Analyse',
      'custom':           customCtx.value.trim() || 'Allgemeine Analyse'
    };
    var ctx = ctxLabels[contextEl.value];

    var prompt = mode === 'figure'
      ? 'Du bist Co-Autor einer kardiochirurgischen Dissertation (Neutrophile + CS-AKI, Kohorte KC_01\u2013KC_26, n=26).\n' +
        'Kontext: ' + ctx + '\n\n' +
        'Schreibe eine pr\u00e4gnante Figure-Legende (2\u20134 S\u00e4tze) auf Deutsch.\n' +
        'Format: "Abb. X \u2014 [Titel]. [Beschreibung]. [Statistik]. [Interpretation]."\n\n' +
        'DATEN:\n' + data
      : 'Du bist Co-Autor einer kardiochirurgischen Dissertation (Neutrophile + CS-AKI, Kohorte KC_01\u2013KC_26, n=26).\n' +
        'Kontext: ' + ctx + '\n\n' +
        'Analysiere die folgenden Prism-Daten und schreibe einen wissenschaftlichen Ergebnisteil auf Deutsch (IMRaD, Results-Abschnitt).\n' +
        '- Beschreibe Hauptbefunde pr\u00e4zise\n' +
        '- Nenne p-Werte und Effektgr\u00f6\u00dfen wo vorhanden\n' +
        '- Nur Deskription, keine Interpretation\n' +
        '- Ca. 80\u2013150 W\u00f6rter\n\n' +
        'DATEN:\n' + data;

    try {
      var createRes = await fetch('/api/smart-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: (mode === 'figure' ? 'Figure-Legende: ' : 'Prism-Analyse: ') + ctx.slice(0, 50),
          description: prompt,
          system_prompt: 'Dissertation-Kontext: Kardiochirurgie, Kohorte KC_01\u2013KC_26 (n=26), Thema Neutrophile Subpopulationen und CS-AKI (Cardiac-Surgery-associated Acute Kidney Injury). Studienort: Universit\u00e4tsklinikum Ulm, ITI. Doktorand: Robin Mandel, Betreuer ITI. Sprache der Arbeit: Deutsch (IMRaD-Format). Daten stammen aus GraphPad Prism \u2014 CSV-Export.'
        })
      });
      var task = await createRes.json();
      if (!task.id) throw new Error('Task-Erstellung fehlgeschlagen');
      await fetch('/api/smart-tasks/' + task.id + '/start', { method: 'POST' });
      statusEl.innerHTML = '\u23f3 L\u00e4uft \u2014 <a href="#" onclick="MC.nav&&MC.nav.go&&MC.nav.go(\'tasks\');return false" style="color:var(--accent)">Tasks ansehen</a>';

      var attempts = 0;
      var poll = setInterval(async function() {
        attempts++;
        if (attempts > 40) { clearInterval(poll); statusEl.textContent = '\u26a0\ufe0f Timeout \u2014 Ergebnis in Tasks ansehen'; return; }
        try {
          var tRes  = await fetch('/api/smart-tasks/' + task.id);
          var tData = await tRes.json();
          if (tData.status === 'done') {
            clearInterval(poll);
            var output = tData.output || '(Kein Output)';
            resultText.textContent = output;
            resultBox.style.display = '';
            statusEl.textContent = '\u2705 Fertig';
            // persist result
            fetch('/api/diss/prism-results', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ context: ctx, mode: mode, output: output })
            }).catch(function(){});
            loadPrismHistory(historyEl);
          } else if (tData.status === 'error') {
            clearInterval(poll);
            statusEl.textContent = '\u274c Fehler: ' + (tData.error || 'unbekannt');
          }
        } catch(e) { /* ignore */ }
      }, 3000);
    } catch(err) {
      statusEl.textContent = '\u274c ' + err.message;
    }
    analyseBtn.disabled = figureBtn.disabled = false;
  }

  analyseBtn.addEventListener('click', function() { runAnalysis('analyse'); });
  figureBtn.addEventListener('click',  function() { runAnalysis('figure'); });

  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(resultText.textContent).then(function() {
      copyBtn.textContent = 'Kopiert!';
      setTimeout(function() { copyBtn.textContent = 'Kopieren'; }, 2000);
    });
  });

  if (toWordBtn) {
    toWordBtn.addEventListener('click', async function() {
      var text = resultText.textContent;
      if (!text) return;
      toWordBtn.textContent = '...';
      try {
        var res = await fetch('/api/diss/word', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ section: 'results', content: text, source: 'prism-analyse' })
        });
        var data = await res.json();
        toWordBtn.textContent = data.ok ? '✅ Word' : '❌ Fehler';
      } catch(e) {
        toWordBtn.textContent = '❌ Fehler';
      }
      setTimeout(function() { toWordBtn.textContent = '→ Word'; }, 3000);
    });
  }
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
        research.innerHTML = data.results.map(function(r) {
          var zBadge = function(p) {
            if (!p.doi || p.doi === 'null') return '';
            if (p.zotero === 'ok')    return '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#0d2e1e;color:#4caf87;margin-left:6px">Zotero ✓</span>';
            if (p.zotero === 'error') return '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#2e0d0d;color:#e06c75;margin-left:6px">Zotero ✗</span>';
            return '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#1a1a2e;color:#888;margin-left:6px">' + p.doi.slice(0,20) + '</span>';
          };
          var papersHtml = '';
          if (r.papers && r.papers.length) {
            papersHtml = '<div style="margin-top:6px">' + r.papers.map(function(p) {
              return '<div style="padding:5px 0;border-top:1px solid var(--border)">' +
                '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px">' +
                  '<span style="font-size:12px;color:var(--text-strong)">' + (p.title || '').slice(0, 90) + '</span>' +
                  zBadge(p) +
                '</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;line-height:1.4">' + (p.summary || '').slice(0, 130) + '</div>' +
              '</div>';
            }).join('') + '</div>';
          }
          return '<div class="feed-item">' +
            '<span class="feed-time">' + r.date + '</span>' +
            '<div class="feed-text" style="font-weight:500">' + (r.takeaway || r.summary || 'Keine Zusammenfassung') + '</div>' +
            papersHtml +
          '</div>';
        }).join('');
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
  initPrismAnalyse();
  initWordPanel();
  initDissChat();
  await loadDeltaLog();
  initDeltaInput();
  await loadDissStructure();
  initStructurePanel();
}

// ── Diss-Gliederung (Struktur) ────────────────────────────
var _structureChapters = [];
var DISS_DEFAULT_CHAPTERS = [
  { id: 'ch1', title: 'Einleitung' },
  { id: 'ch2', title: 'Material & Methoden' },
  { id: 'ch3', title: 'Ergebnisse' },
  { id: 'ch4', title: 'Diskussion' },
  { id: 'ch5', title: 'Schlussfolgerung' },
];

async function loadDissStructure() {
  try {
    var res  = await fetch('/api/diss/structure');
    var data = await res.json();
    _structureChapters = (data.chapters && data.chapters.length)
      ? data.chapters
      : JSON.parse(JSON.stringify(DISS_DEFAULT_CHAPTERS));
  } catch(e) {
    _structureChapters = JSON.parse(JSON.stringify(DISS_DEFAULT_CHAPTERS));
  }
  renderStructureChapters();
}

function renderStructureChapters() {
  var list = document.getElementById('structure-chapter-list');
  if (!list) return;
  list.innerHTML = _structureChapters.map(function(ch, idx) {
    return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
      '<span style="font-size:11px;color:var(--text-muted);width:18px;flex-shrink:0">' + (idx + 1) + '.</span>' +
      '<input type="text" value="' + (ch.title || '').replace(/"/g, '&quot;') + '" ' +
        'style="flex:1;background:var(--surface2,#1e2535);border:1px solid var(--border,#1e2535);border-radius:4px;padding:5px 8px;color:var(--text,#e2e8f0);font-size:13px" ' +
        'onchange="structureUpdateTitle(' + idx + ', this.value)">' +
      '<button onclick="structureRemoveChapter(' + idx + ')" title="Entfernen" ' +
        'style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 4px;flex-shrink:0">✕</button>' +
    '</div>';
  }).join('');
}

function structureUpdateTitle(idx, val) {
  if (_structureChapters[idx]) _structureChapters[idx].title = val;
}

function structureRemoveChapter(idx) {
  _structureChapters.splice(idx, 1);
  renderStructureChapters();
}

async function saveStructure() {
  var status = document.getElementById('structure-save-status');
  try {
    var res = await fetch('/api/diss/structure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapters: _structureChapters })
    });
    var d = await res.json();
    if (status) {
      status.textContent = d.ok ? '✅ Gespeichert' : '❌ Fehler';
      setTimeout(function() { status.textContent = ''; }, 2500);
    }
  } catch(e) {
    if (status) {
      status.textContent = '❌ Netzwerkfehler';
      setTimeout(function() { status.textContent = ''; }, 2500);
    }
  }
}

function initStructurePanel() {
  var addBtn          = document.getElementById('structure-add-btn');
  var saveBtn         = document.getElementById('structure-save-btn');
  var inputEl         = document.getElementById('structure-new-chapter');
  var suggestDissBtn  = document.getElementById('structure-suggest-diss-btn');
  var suggestPaperBtn = document.getElementById('structure-suggest-paper-btn');
  if (!addBtn) return;

  addBtn.addEventListener('click', function() {
    var title = (inputEl.value || '').trim();
    if (!title) return;
    _structureChapters.push({ id: 'ch' + Date.now(), title: title });
    inputEl.value = '';
    renderStructureChapters();
  });
  inputEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') addBtn.click(); });
  saveBtn.addEventListener('click', saveStructure);

  async function runStructureSuggest(mode) {
    var statusEl = document.getElementById('structure-suggest-status');
    var resultEl = document.getElementById('structure-suggest-result');
    if (statusEl) statusEl.textContent = '⏳ Generiere Vorschlag...';
    if (resultEl) resultEl.style.display = 'none';
    suggestDissBtn.disabled = suggestPaperBtn.disabled = true;

    var currentChapters = _structureChapters.map(function(c, i) { return (i + 1) + '. ' + c.title; }).join('\n');

    var prompt = mode === 'paper'
      ? 'You are a scientific writing expert. Robin is writing a paper on neutrophil subpopulations and cardiac-surgery-associated acute kidney injury (CS-AKI). Cohort KC_01–KC_26 (n=26), University Hospital Ulm.\n\nSuggest an optimal IMRaD structure for an English research paper. List sections and key subsections with one-line descriptions.\n\nCurrent outline:\n' + currentChapters
      : 'Du bist Co-Autor einer kardiochirurgischen Dissertation. Robin schreibt über Neutrophile Subpopulationen und CS-AKI (Kohorte KC_01–KC_26, n=26, Uni Ulm, ITI).\n\nSchlage eine optimale Gliederung für seine Dissertation vor (deutschsprachig, medizinische Promotionsordnung). Kapitel + Unterkapitel mit je einer Zeile Beschreibung. Konkret und praxisnah.\n\nAktuelle Gliederung:\n' + currentChapters;

    try {
      var createRes = await fetch('/api/smart-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: mode === 'paper' ? 'Paper structure' : 'Diss-Gliederung', description: prompt })
      });
      var task = await createRes.json();
      if (!task.id) throw new Error('Task-Erstellung fehlgeschlagen');
      await fetch('/api/smart-tasks/' + task.id + '/start', { method: 'POST' });
      if (statusEl) statusEl.innerHTML = '⏳ Läuft — <a href="#" onclick="MC.nav&&MC.nav.go&&MC.nav.go(\'tasks\');return false" style="color:var(--accent)">Tasks</a>';

      var attempts = 0;
      var poll = setInterval(async function() {
        attempts++;
        if (attempts > 40) { clearInterval(poll); if (statusEl) statusEl.textContent = '⚠️ Timeout'; return; }
        try {
          var tRes  = await fetch('/api/smart-tasks/' + task.id);
          var tData = await tRes.json();
          if (tData.status === 'done') {
            clearInterval(poll);
            if (statusEl) statusEl.textContent = '✅ Fertig';
            if (resultEl) { resultEl.textContent = tData.output || '(kein Output)'; resultEl.style.display = ''; }
          } else if (tData.status === 'error') {
            clearInterval(poll);
            if (statusEl) statusEl.textContent = '❌ ' + (tData.error || 'unbekannt');
          }
        } catch(e) { /* ignore */ }
      }, 3000);
    } catch(err) {
      if (statusEl) statusEl.textContent = '❌ ' + err.message;
    }
    suggestDissBtn.disabled = suggestPaperBtn.disabled = false;
  }

  if (suggestDissBtn)  suggestDissBtn.addEventListener('click',  function() { runStructureSuggest('diss'); });
  if (suggestPaperBtn) suggestPaperBtn.addEventListener('click', function() { runStructureSuggest('paper'); });
}

// ── Word Online Panel ──────────────────────────────────────
function _wordToEmbedUrl(raw) {
  // Convert OneDrive edit/view URLs to embed URLs where possible
  var url = raw.trim();
  if (!url) return url;
  // Already an embed URL
  if (url.includes('embed') || url.includes('embedview')) return url;
  // onedrive.live.com/edit.aspx → embed
  if (url.includes('onedrive.live.com/edit.aspx')) {
    return url.replace('/edit.aspx', '/embed').replace('action=editnew', 'app=Word').replace('action=default', 'app=Word');
  }
  // SharePoint /:w:/ links → append ?action=embedview
  if (url.includes('sharepoint.com') && url.includes(':w:')) {
    var sep = url.includes('?') ? '&' : '?';
    return url + sep + 'action=embedview';
  }
  // Fallback: use Office Online viewer (needs public download URL — may not work for auth'd files)
  return url;
}

async function initWordPanel() {
  var input    = document.getElementById('word-url-input');
  var loadBtn  = document.getElementById('word-url-load-btn');
  var actions  = document.getElementById('word-url-actions');
  var copyBtn  = document.getElementById('word-share-copy-btn');
  var openLink = document.getElementById('word-open-link');
  var iframeW  = document.getElementById('word-iframe-wrap');
  var iframe   = document.getElementById('word-iframe');
  var placeholder = document.getElementById('word-placeholder');
  var statusEl = document.getElementById('word-url-status');
  if (!input) return;

  // Load saved URL
  try {
    var r = await fetch('/api/diss/word-url');
    var d = await r.json();
    if (d.url) {
      input.value = d.url;
      _applyWordUrl(d.url, d.shareUrl || d.url);
    }
  } catch(e) { /* ignore */ }

  function _applyWordUrl(url, shareUrl) {
    var embedUrl = _wordToEmbedUrl(url);
    iframe.src = embedUrl;
    iframeW.style.display = '';
    placeholder.style.display = 'none';
    actions.style.display = 'flex';
    openLink.href = url;
    openLink._shareUrl = shareUrl || url;
  }

  loadBtn.addEventListener('click', async function() {
    var url = input.value.trim();
    if (!url) return;
    loadBtn.disabled = true;
    _applyWordUrl(url, url);
    try {
      await fetch('/api/diss/word-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, shareUrl: url })
      });
      if (statusEl) statusEl.textContent = 'Gespeichert.';
    } catch(e) { /* ignore */ }
    loadBtn.disabled = false;
  });

  input.addEventListener('keydown', function(e) { if (e.key === 'Enter') loadBtn.click(); });

  copyBtn.addEventListener('click', function() {
    var su = (openLink && openLink._shareUrl) || input.value.trim();
    if (!su) return;
    navigator.clipboard.writeText(su).then(function() {
      copyBtn.textContent = 'Kopiert!';
      setTimeout(function() { copyBtn.textContent = 'Betreuer-Link kopieren'; }, 2000);
    });
  });
}
