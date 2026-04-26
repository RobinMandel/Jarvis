// Medizin View — Knowledge Funnel für das Medizinstudium
// Sem 8 / M2-M3, Uni Ulm

var MedizinView = (function () {

  // ── Chat State ────────────────────────────────────────────
  var _chatSession = null;
  var _chatReady   = false;
  var _pendingMsg  = null;

  // ── Helpers ───────────────────────────────────────────────
  function appendMsg(role, text) {
    var msgsEl = document.getElementById('med-chat-messages');
    if (!msgsEl) return null;
    var el = document.createElement('div');
    el.className = 'med-chat-msg ' + role;
    el.textContent = text;
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return el;
  }

  // ── Log laden ─────────────────────────────────────────────
  async function loadLog() {
    var container = document.getElementById('med-log');
    var countEl   = document.getElementById('med-log-count');
    if (!container) return;
    try {
      var res  = await fetch('/api/medizin/log');
      var data = await res.json();
      if (!data.entries || !data.entries.length) {
        container.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Noch keine Inhalte ingestiert.</div>';
        return;
      }
      if (countEl) countEl.textContent = data.entries.length + ' Einträge';
      var search = (document.getElementById('med-log-search') || {}).value || '';
      var entries = data.entries;
      if (search) {
        var q = search.toLowerCase();
        entries = entries.filter(function(e) {
          return (e.title || '').toLowerCase().includes(q) || (e.preview || '').toLowerCase().includes(q);
        });
      }
      container.innerHTML = entries.map(function(e) {
        var ts = e.ts ? new Date(e.ts).toLocaleString('de-DE', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        var typeColors = { vorlesung: '#3b82f6', goodnotes: '#14b8a6', notizen: '#a78bfa', skript: '#f59e0b', paper: '#f472b6', sonstiges: '#64748b' };
        var color = typeColors[e.type] || '#64748b';
        return '<div class="med-log-entry">' +
          '<div class="med-log-header">' +
            '<span class="med-log-type" style="background:' + color + '20;color:' + color + ';border:1px solid ' + color + '40">' + (e.type || 'sonstiges') + '</span>' +
            '<span style="flex:1;margin-left:8px;font-weight:600;color:var(--text-strong);font-size:13px">' + (e.title || 'Unbenannt') + '</span>' +
            '<span style="font-size:11px;color:var(--text-muted);white-space:nowrap">' + ts + '</span>' +
          '</div>' +
          '<div class="med-log-body">' + ((e.preview || '').slice(0, 180) || '—') + '</div>' +
        '</div>';
      }).join('');
    } catch(err) {
      container.innerHTML = '<div style="font-size:12px;color:var(--warn)">Fehler beim Laden des Logs.</div>';
    }
  }

  // Ex-Wissens-Trichter (initIngest + initAnki) gelöscht: Upload+Karten laufen jetzt über DeltaLearnView.

  // ── Search ────────────────────────────────────────────────
  function initSearch() {
    var searchEl = document.getElementById('med-log-search');
    if (!searchEl) return;
    searchEl.addEventListener('input', function() { loadLog(); });
  }

  // ── Chat ──────────────────────────────────────────────────
  function initChat() {
    var sendBtn = document.getElementById('med-chat-send');
    var inputEl = document.getElementById('med-chat-input');
    var msgsEl  = document.getElementById('med-chat-messages');
    if (!sendBtn || !MC.ws) return;

    MC.ws.on('chat.token', function(d) {
      if (d.session_id !== _chatSession) return;
      var el = msgsEl.querySelector('.thinking-bubble');
      if (!el) {
        el = document.createElement('div');
        el.className = 'med-chat-msg assistant thinking-bubble';
        msgsEl.appendChild(el);
      }
      el.textContent = (el.textContent || '') + (d.token || '');
      msgsEl.scrollTop = msgsEl.scrollHeight;
    });

    MC.ws.on('chat.response', function(d) {
      if (d.session_id !== _chatSession) return;
      var el = msgsEl.querySelector('.thinking-bubble');
      if (el) el.className = 'med-chat-msg assistant';
      sendBtn.disabled = false;
      msgsEl.scrollTop = msgsEl.scrollHeight;
    });

    // Server antwortet auf `chat.new_session` mit `chat.session_created` — hier lauschen.
    MC.ws.on('chat.session_created', function(d) {
      if (_chatSession) return;
      _chatSession = d.session_id;
      var label = document.getElementById('med-chat-session-label');
      if (label) label.textContent = d.session_id.slice(0, 8);
      MC.ws.send({
        type: 'chat.send',
        session_id: _chatSession,
        message: '[Medizin-Chat init] Du bist im Medizin-Modus. Robin studiert Medizin im klinischen Abschnitt (Sem 8, Uni Ulm, M2/M3). Hilf ihm mit Lernfragen, Anki-Karten erstellen, Zusammenfassungen, OSCE-Vorbereitung und allem rund ums Studium. Antworte auf Deutsch, präzise und lernförderlich. Bestätige kurz.'
      });
      _chatReady = true;
      if (_pendingMsg) {
        setTimeout(function() {
          MC.ws.send({ type: 'chat.send', session_id: _chatSession, message: _pendingMsg });
          _pendingMsg = null;
        }, 600);
      }
    });

    function sendMsg() {
      var msg = inputEl.value.trim();
      if (!msg) return;
      appendMsg('user', msg);
      inputEl.value = '';

      // Nachricht als Feedback für aktives Fach puffern (wird bei nächster Karten-Generierung genutzt)
      var activeSubject = (document.getElementById('dlr-gen-subject') || {}).value || '';
      if (activeSubject) {
        try {
          var fb = JSON.parse(localStorage.getItem('dlr_chat_feedback') || '{}');
          if (!fb[activeSubject]) fb[activeSubject] = [];
          fb[activeSubject].push(msg);
          if (fb[activeSubject].length > 10) fb[activeSubject] = fb[activeSubject].slice(-10);
          localStorage.setItem('dlr_chat_feedback', JSON.stringify(fb));
          var badge = document.getElementById('dlr-feedback-badge');
          if (badge) badge.textContent = fb[activeSubject].length + ' Chat-Feedback';
        } catch(e) { /* ignore */ }
      }

      var thinkEl = document.createElement('div');
      thinkEl.className = 'med-chat-msg thinking thinking-bubble';
      thinkEl.textContent = '...';
      msgsEl.appendChild(thinkEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      sendBtn.disabled = true;

      if (_chatSession && _chatReady) {
        MC.ws.send({ type: 'chat.send', session_id: _chatSession, message: msg });
      } else {
        _pendingMsg = msg;
        if (!_chatSession) MC.ws.send({ type: 'chat.new_session' });
      }
    }

    sendBtn.addEventListener('click', sendMsg);
    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });

    if (!_chatSession) MC.ws.send({ type: 'chat.new_session' });
  }

  // ── Frühere Anki-Decks ────────────────────────────────────
  // Liest /api/learn/history und rendert eine Liste mit Vorschau-Link + Re-Download-Button.
  // Ist global, damit medizin.js (DeltaLearnView) sie nach jedem Generate-Run aufrufen kann.
  window.refreshDeckHistory = async function () {
    var el = document.getElementById('dlr-deck-history');
    if (!el) return;
    el.innerHTML = '<span style="color:var(--text-muted)">Lade…</span>';
    try {
      var res = await fetch('/api/learn/history');
      var data = await res.json();
      var hist = (data && data.history) || [];
      if (!hist.length) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:14px 0;text-align:center;font-size:12px">Noch keine Decks generiert.</div>';
        return;
      }
      el.innerHTML = hist.map(function (h) {
        var ts = h.ts || '';
        var subj = (h.subject || 'Karten');
        var topics = (h.topics && h.topics.length) ? h.topics.join(', ') : '—';
        var n = h.card_count || 0;
        var did = h.deck_id ? encodeURIComponent(h.deck_id) : null;
        var actions = did
          ? (
              '<a href="/api/learn/decks/' + did + '/preview" target="_blank" rel="noopener" ' +
                'style="padding:5px 11px;background:#0a0c12;color:#94a3b8;border:1px solid #334155;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none">🔍 Vorschau</a>' +
              '<a href="/api/learn/decks/' + did + '/apkg" ' +
                'style="padding:5px 11px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:700;text-decoration:none">⬇ .apkg</a>'
            )
          : '<span style="font-size:10px;color:#64748b;font-style:italic;padding:0 6px">Pre-Update — nicht abrufbar</span>';
        return (
          '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid #1e293b">' +
            '<div>' +
              '<div style="color:#e2e8f0;font-weight:600">' + _escHtml(subj) + ' <span style="color:#475569;font-weight:400;font-size:11px">· ' + n + ' Karten</span></div>' +
              '<div style="font-size:11px;color:#64748b;margin-top:2px">' + _escHtml(ts) + ' · ' + _escHtml(topics) + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;align-items:center">' + actions + '</div>' +
          '</div>'
        );
      }).join('');
    } catch (e) {
      el.innerHTML = '<span style="color:#ef4444">Fehler: ' + e.message + '</span>';
    }
  };
  function _escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // (Lernplan-Generator entfernt — UI raus, kein Init mehr.)


  // ── Init ──────────────────────────────────────────────────
  function init() {
    loadLog();
    initSearch();
    (function waitForWS(attempts) {
      if (MC.ws && MC.ws.send) { initChat(); return; }
      if (attempts <= 0) return;
      setTimeout(function() { waitForWS(attempts - 1); }, 200);
    })(25); // max 5s
    // Upload-Zone + Karten-Generator (Ex-DeltaLernraum, jetzt inline)
    if (window.DeltaLearnView && window.DeltaLearnView.init) window.DeltaLearnView.init();
    // Anki-Deck-History initial laden
    if (window.refreshDeckHistory) window.refreshDeckHistory();
  }

  return { init: init, reload: loadLog };
})();

// ─────────────────────────────────────────────────────────────────────────────
// DeltaLearnView — Ex-DeltaLernraum, jetzt als Sub-Modul des Medizin-Tabs.
// Upload-Zone (PDF/PPT/GoodNotes/Anki/Bilder + Bild-Extraktion),
// Karten-Generator (amkiphil-Style), Design-Vorschläge.
// IDs: dlr-* (im Medizin-View gerendert).
// ─────────────────────────────────────────────────────────────────────────────
var DeltaLearnView = (function () {

  var _pendingFiles = [];
  var _lastCards    = [];
  var _lastDeckId   = null;
  var _stats        = { files: 0, cards: 0, images: 0 };

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function setStatus(msg) {
    var el = document.getElementById('dlr-status');
    if (el) el.innerHTML = msg;
  }

  function setGenStatus(msg) {
    var el = document.getElementById('dlr-gen-status');
    if (el) el.innerHTML = msg;
  }

  function updateStats() {
    var f = document.getElementById('dlr-stat-files');
    var c = document.getElementById('dlr-stat-cards');
    var i = document.getElementById('dlr-stat-images');
    if (f) f.textContent = _stats.files || '—';
    if (c) c.textContent = _stats.cards || '—';
    if (i) i.textContent = _stats.images || '—';
  }

  function renderFileList() {
    var el = document.getElementById('dlr-file-list');
    if (!el) return;
    if (!_pendingFiles.length) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Noch keine Dateien ausgewählt.</div>';
      return;
    }
    el.innerHTML = _pendingFiles.map(function (f, i) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.04))">' +
        '<span style="font-size:12px;flex:1;color:var(--text-primary)">' + f.name +
          ' <span style="color:var(--text-muted)">(' + formatSize(f.size) + ')</span></span>' +
        '<button onclick="DeltaLearnView.removeFile(' + i + ')" ' +
          'style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:13px;padding:0 4px">✕</button>' +
      '</div>';
    }).join('');
  }

  function addFiles(fileList) {
    Array.from(fileList).forEach(function (f) {
      var dup = _pendingFiles.some(function (p) { return p.name === f.name && p.size === f.size; });
      if (!dup) _pendingFiles.push(f);
    });
    renderFileList();
  }

  function removeFile(idx) {
    _pendingFiles.splice(idx, 1);
    renderFileList();
  }

  function initDropzone() {
    var zone  = document.getElementById('dlr-dropzone');
    var input = document.getElementById('dlr-file-input');
    if (!zone) return;

    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.style.borderColor = '#a78bfa';
      zone.style.background  = 'rgba(167,139,250,.06)';
    });
    zone.addEventListener('dragleave', function () {
      zone.style.borderColor = '';
      zone.style.background  = '';
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.style.borderColor = '';
      zone.style.background  = '';
      addFiles(e.dataTransfer.files);
    });
    zone.addEventListener('click', function () { if (input) input.click(); });

    if (input) {
      input.addEventListener('change', function () {
        addFiles(input.files);
        input.value = '';
      });
    }

    // Wenn Provider auf Amboss/Thieme wechselt und pending Files nur Bilder → type auf screenshot
    var providerEl = document.getElementById('dlr-provider');
    if (providerEl) {
      providerEl.addEventListener('change', function () {
        var isSource = providerEl.value === 'amboss' || providerEl.value === 'thieme';
        var typeEl = document.getElementById('dlr-type');
        if (!isSource || !typeEl || !_pendingFiles.length) return;
        var hasImages = _pendingFiles.some(function (f) { return /\.(png|jpg|jpeg|gif|webp)$/i.test(f.name); });
        if (hasImages) typeEl.value = 'screenshot';
      });
    }

    // Dedizierter Amboss-Screenshot-Dropbereich
    var ambossZone  = document.getElementById('dlr-amboss-dropzone');
    var ambossInput = document.getElementById('dlr-amboss-file-input');
    if (ambossZone) {
      ambossZone.addEventListener('dragover', function (e) {
        e.preventDefault();
        ambossZone.style.borderColor = '#22c55e';
        ambossZone.style.background  = 'rgba(34,197,94,.07)';
      });
      ambossZone.addEventListener('dragleave', function () {
        ambossZone.style.borderColor = '';
        ambossZone.style.background  = '';
      });
      ambossZone.addEventListener('drop', function (e) {
        e.preventDefault();
        ambossZone.style.borderColor = '';
        ambossZone.style.background  = '';
        _setAmbossMode();
        addFiles(e.dataTransfer.files);
      });
      ambossZone.addEventListener('click', function () { if (ambossInput) ambossInput.click(); });
      if (ambossInput) {
        ambossInput.addEventListener('change', function () {
          _setAmbossMode();
          addFiles(ambossInput.files);
          ambossInput.value = '';
        });
      }
    }

    function _setAmbossMode() {
      var p = document.getElementById('dlr-provider');
      var t = document.getElementById('dlr-type');
      if (p) p.value = 'amboss';
      if (t) t.value = 'screenshot';
    }
  }

  async function _waitForSubjectIndexed(subjectKey, expectedFiles) {
    // Pollt /api/learn/meta bis das Fach indexiert ist (Stems > 0 ODER irgendwelche Bilder).
    // file_count ist im Server unzuverlässig (Substring-Match auf Filename) — deshalb loose check.
    var deadline = Date.now() + 30000;
    var lastInfo = null;
    while (Date.now() < deadline) {
      try {
        var r = await fetch('/api/learn/meta');
        var m = await r.json();
        var info = (m.subjects || {})[subjectKey];
        var indexed = info && (
          (info.stems && info.stems.length > 0) ||
          (info.file_count || 0) >= 1 ||
          (info.image_count || 0) > 0
        );
        if (indexed) return { ok: true, info: info };
        lastInfo = info;
      } catch (e) { /* retry */ }
      await new Promise(function (res) { setTimeout(res, 1500); });
    }
    return { ok: false, info: lastInfo };
  }

  async function doUpload() {
    var btn     = document.getElementById('dlr-upload-btn');
    var subject = (document.getElementById('dlr-subject') || {}).value || '';
    var type    = (document.getElementById('dlr-type')    || {}).value || 'vorlesung';
    var topics  = (document.getElementById('dlr-topics')  || {}).value || '';

    if (!_pendingFiles.length) {
      setStatus('<span style="color:#f59e0b">Keine Dateien ausgewählt.</span>');
      return;
    }
    if (!subject.trim()) {
      setStatus('<span style="color:#f59e0b">Fach angeben — sonst kann der Generator später kein Material zuordnen.</span>');
      return;
    }

    var uploadedCount = _pendingFiles.length;

    if (btn) btn.disabled = true;
    setStatus('<span style="color:var(--text-muted)">⏳ Schritt 1/3: Dateien werden hochgeladen…</span>');

    var provider = (document.getElementById('dlr-provider') || {}).value || 'folie';

    // Amboss/Thieme-Screenshots: wenn Provider externe Quelle und alle Files Bilder → type auto auf screenshot
    var isSourceProvider = provider === 'amboss' || provider === 'thieme';
    var allImages = _pendingFiles.every(function (f) { return /\.(png|jpg|jpeg|gif|webp)$/i.test(f.name); });
    if (isSourceProvider && allImages && type !== 'screenshot') {
      type = 'screenshot';
      var typeEl = document.getElementById('dlr-type');
      if (typeEl) typeEl.value = 'screenshot';
    }

    var fd = new FormData();
    fd.append('subject', subject);
    fd.append('type', type);
    fd.append('provider', provider);
    if (topics) fd.append('topics', topics);
    fd.append('source', 'medizin-upload');
    _pendingFiles.forEach(function (f) { fd.append('files[]', f, f.name); });

    try {
      var res  = await fetch('/api/learn/ingest', { method: 'POST', body: fd });
      var data = await res.json();

      if (!res.ok || !data.ok) {
        setStatus('<span style="color:#ef4444">Fehler beim Upload: ' + (data.error || res.status) + '</span>');
        return;
      }

      _stats.files  += data.files || 0;
      _stats.images += data.images_extracted || 0;
      updateStats();
      _pendingFiles = [];
      renderFileList();

      var imgNote = data.images_extracted > 0
        ? ' · ' + data.images_extracted + ' Bilder extrahiert'
        : ' · keine Bilder extrahiert (EMF-Folien? dann bleibt nur der Text)';
      setStatus('<span style="color:var(--text-muted)">✓ Schritt 2/3: ' + data.files + ' Datei(en) gespeichert' + imgNote + '. ⏳ RAG-Index wird aktualisiert…</span>');

      setTimeout(loadLog, 1500);

      // Polling: warte bis Fach im Meta auftaucht mit >=uploadedCount Files
      var subjKey = subject.toLowerCase();
      var wait = await _waitForSubjectIndexed(subjKey, uploadedCount);

      if (wait.ok) {
        setStatus(
          '<span style="color:#34d399">✓ Schritt 3/3: Fertig. Fach <b>' + subject + '</b> hat jetzt ' +
          wait.info.file_count + ' Datei(en) und ' + wait.info.image_count + ' Bild(er). ' +
          'Unten im Karten-Generator ist es auswählbar.</span>'
        );
      } else {
        setStatus(
          '<span style="color:#f59e0b">⚠ Upload erfolgreich, aber der RAG-Index hat in 30 s nicht bestätigt. ' +
          'Wahrscheinlich läuft der Reindex noch — gib ihm eine Minute, dann Karten-Generator neu laden.</span>'
        );
      }

      // Generate-Section neu rendern, damit das neue Fach im Dropdown erscheint
      renderGenerateSection();

    } catch (e) {
      setStatus('<span style="color:#ef4444">Netzwerkfehler: ' + e.message + '</span>');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadLog() {
    var el = document.getElementById('dlr-log');
    if (!el) return;
    try {
      var res  = await fetch('/api/funnel/log');
      var data = await res.json();
      var entries = (data.items || []).filter(function (e) {
        return (e.tags || []).includes('lernraum') || (e.tags || []).includes('delta-lernraum');
      });
      if (!entries.length) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">Noch nichts ingestiert.</div>';
        return;
      }
      var colors = {
        vorlesung: '#3b82f6', seminar: '#14b8a6',
        goodnotes: '#a78bfa', anki: '#f59e0b',
        screenshot: '#f472b6', sonstiges: '#64748b',
      };
      _stats.files = entries.length;
      updateStats();
      el.innerHTML = entries.slice(0, 40).map(function (e) {
        var col = colors[e.type] || '#64748b';
        var st  = e.status === 'done' ? '✓' : e.status === 'running' ? '⏳' : e.status === 'error' ? '✗' : '…';
        return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.04))">' +
          '<span style="padding:2px 7px;border-radius:4px;font-size:10px;background:' + col + '20;color:' + col + ';border:1px solid ' + col + '40">' + (e.type || '?') + '</span>' +
          '<span style="flex:1;font-size:13px;color:var(--text-primary)">' + (e.title || 'Unbenannt') + '</span>' +
          '<span style="font-size:11px;color:var(--text-muted);margin-right:6px">' + (e.date || '') + '</span>' +
          '<span style="font-size:12px">' + st + '</span>' +
        '</div>';
      }).join('');
    } catch (e) {
      if (el) el.innerHTML = '<div style="color:#ef4444;font-size:12px">Log-Ladefehler</div>';
    }
  }

  function loadProposals() {
    var container = document.getElementById('dlr-proposals');
    if (!container) return;
    try {
      var raw = localStorage.getItem('dlr_design_proposals');
      if (!raw) return;
      var proposals = JSON.parse(raw);
      if (!proposals || !proposals.length) return;
      container.innerHTML = proposals.map(function (p) {
        var imgHtml = p.image
          ? '<img src="' + p.image + '" alt="Design" style="max-width:100%;border-radius:6px;margin-top:8px;display:block">'
          : '';
        return '<div style="padding:12px 14px;background:var(--bg-secondary,#0a0c12);border:1px solid #a78bfa40;border-radius:8px;max-width:320px">' +
          '<div style="font-size:13px;font-weight:600;color:#a78bfa;margin-bottom:4px">' + (p.title || 'Vorschlag') + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted)">' + (p.description || '') + '</div>' +
          imgHtml +
        '</div>';
      }).join('');
    } catch (e) { /* ignore parse errors */ }
  }

  async function renderGenerateSection() {
    var container = document.getElementById('dlr-generate-section');
    if (!container) return;

    // Meta laden um Fächer-Dropdown zu befüllen
    var meta = { subjects: {} };
    try {
      var res = await fetch('/api/learn/meta');
      meta = await res.json();
    } catch (e) { /* leer lassen → Empty-State */ }

    var subjectEntries = Object.entries(meta.subjects || {});

    // Empty-State: noch kein Material
    if (!subjectEntries.length) {
      container.innerHTML = [
        '<div class="panel" style="border-color:#f59e0b30">',
          '<div class="panel-header">',
            '<h2>✦ Karten generieren</h2>',
            '<span style="font-size:12px;color:var(--text-muted)">noch inaktiv</span>',
          '</div>',
          '<div class="panel-body" style="text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px">',
            '<div style="font-size:28px;margin-bottom:10px">📭</div>',
            '<div>Noch kein Material ingestiert.</div>',
            '<div style="margin-top:6px;font-size:12px">Lade oben eine PDF, PPT oder GoodNotes-Datei hoch — der Generator schaltet sich automatisch frei, sobald der Index fertig ist.</div>',
          '</div>',
        '</div>',
      ].join('');
      return;
    }

    // Dropdown-Options mit Bild- + Datei-Counts; Fächer ohne Bilder als disabled
    var options = subjectEntries.map(function (kv) {
      var name = kv[0];
      var info = kv[1] || {};
      var imgs = info.image_count || 0;
      var files = info.file_count || 0;
      var hasData = imgs > 0 || files > 0;
      var statusIcon = imgs > 0 ? '✓' : (files > 0 ? '⏳' : '○');
      var label = statusIcon + ' ' + name + ' — ' + imgs + ' Bild' + (imgs === 1 ? '' : 'er');
      if (files > 0) label += ' · ' + files + ' Datei' + (files === 1 ? '' : 'en');
      if (!hasData) label += ' (leer)';
      return '<option value="' + name.replace(/"/g, '&quot;') + '"' + (!hasData ? ' disabled style="color:#64748b"' : '') + '>' + label + '</option>';
    }).join('');

    // Legende für Dropdown-Icons
    var legend = '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">' +
      '<span style="color:#34d399">✓</span> bereit&ensp;' +
      '<span style="color:#f59e0b">⏳</span> Bilder fehlen noch&ensp;' +
      '<span style="color:#64748b">â—‹</span> leer' +
      '</div>';

    container.innerHTML = [
      '<div class="panel" style="border-color:#a78bfa30">',
        '<div class="panel-header">',
          '<h2>✦ Karten generieren</h2>',
          '<div style="display:flex;align-items:center;gap:8px">',
            '<span style="font-size:12px;color:var(--text-muted)">Amboss-Style · Bilder · Fun Facts · Merkhilfen</span>',
            '<a href="/static/card-mockup.html" target="_blank" ',
              'style="padding:4px 10px;background:#a78bfa18;color:#a78bfa;border:1px solid #a78bfa44;',
              'border-radius:6px;font-size:11px;font-weight:700;text-decoration:none;letter-spacing:.04em">',
              '🎨 Design',
            '</a>',
          '</div>',
        '</div>',
        '<div class="panel-body">',
          // Source-Mode-Toggle: bestimmt woraus die Karten gebaut werden
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;padding:8px 10px;background:#0a0c12;border:1px solid #1f2937;border-radius:7px">',
            '<span style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin-right:4px">Quelle:</span>',
            '<button class="dlr-source-btn" data-source="lernraum" title="Karten aus deinen hochgeladenen Folien/Skripten + Amboss/Thieme als Ergaenzung" ',
              'style="padding:6px 12px;background:#a78bfa;color:#0f172a;border:1px solid #a78bfa;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">',
              '📚 Lernraum',
            '</button>',
            '<button class="dlr-source-btn" data-source="amboss" title="Karten rein aus Amboss-Artikeln zum Thema (kein Lernraum noetig)" ',
              'style="padding:6px 12px;background:#0a0c12;color:#86efac;border:1px solid #16a34a55;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">',
              '🟢 Amboss',
            '</button>',
            '<button class="dlr-source-btn" data-source="thieme" title="Karten rein aus ViaMedici/Thieme-Lernmodulen" ',
              'style="padding:6px 12px;background:#0a0c12;color:#7dd3fc;border:1px solid #0ea5e955;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">',
              '🔵 Thieme',
            '</button>',
            '<button class="dlr-source-btn" data-source="mix" title="Amboss + Thieme zusammen (kein Lernraum)" ',
              'style="padding:6px 12px;background:#0a0c12;color:#e2e8f0;border:1px solid #475569;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">',
              '⚡ Mix',
            '</button>',
            '<span id="dlr-source-hint" style="font-size:11px;color:#64748b;margin-left:auto"></span>',
          '</div>',
          legend,
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">',
            '<select id="dlr-gen-subject" ',
              'style="flex:1;min-width:180px;padding:8px 12px;border:1px solid var(--border-subtle,rgba(255,255,255,.04));',
              'border-radius:6px;background:var(--bg-secondary,#0a0c12);color:var(--text-primary,#e2e8f0);font-size:13px">',
              options,
            '</select>',
            '<input id="dlr-gen-topics" placeholder="Unter-Themen (optional, z.B. Herzinsuffizienz, Arrhythmie)" ',
              'style="flex:2;min-width:220px;padding:8px 12px;border:1px solid var(--border-subtle,rgba(255,255,255,.04));',
              'border-radius:6px;background:var(--bg-secondary,#0a0c12);color:var(--text-primary,#e2e8f0);font-size:13px">',
          '</div>',
          '<div id="dlr-subject-status" style="font-size:11px;color:var(--text-muted);margin:0 0 8px 2px"></div>',
          '<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">',
            '<input id="dlr-preview-topic" placeholder="Thema testen (z.B. Aortenstenose) →" ',
              'style="flex:1;padding:7px 12px;border:1px solid #34d39940;',
              'border-radius:6px;background:#0a0c12;color:#e2e8f0;font-size:12px" />',
            '<button id="dlr-preview-btn" ',
              'style="padding:7px 14px;background:#34d39918;color:#34d399;border:1px solid #34d39940;',
              'border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">',
              'â–¶ Probe-Karte',
            '</button>',
            '<span id="dlr-preview-status" style="font-size:11px;color:var(--text-muted)"></span>',
          '</div>',
          '<div id="dlr-preview-result" style="margin-bottom:10px"></div>',
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">',
            '<span id="dlr-feedback-badge" style="font-size:11px;color:#a78bfa;background:#a78bfa15;border:1px solid #a78bfa30;border-radius:12px;padding:2px 8px;display:inline-block"></span>',
            '<span style="font-size:12px;color:var(--text-muted);font-weight:600;margin-right:2px">✦ Karten:</span>',
            '<button class="dlr-density-btn" data-density="low" ',
              'title="5-10 Karten — nur die wichtigsten Konzepte. Claude wählt selbst basierend auf Stoffumfang." ',
              'style="padding:7px 14px;background:#0a0c12;color:#94a3b8;border:1px solid #334155;border-radius:7px;',
              'font-size:12px;font-weight:600;cursor:pointer">',
              'wenig',
            '</button>',
            '<button class="dlr-density-btn" data-density="medium" ',
              'title="12-20 Karten — solide Coverage der Hauptthemen. Claude wählt selbst." ',
              'style="padding:7px 14px;background:#a78bfa;color:#0f172a;border:1px solid #a78bfa;border-radius:7px;',
              'font-size:12px;font-weight:700;cursor:pointer">',
              'mittel',
            '</button>',
            '<button class="dlr-density-btn" data-density="high" ',
              'title="22-40 Karten — tiefe Abdeckung inkl. Edge-Cases und IMPP-Fallen. Claude wählt selbst." ',
              'style="padding:7px 14px;background:#0a0c12;color:#94a3b8;border:1px solid #334155;border-radius:7px;',
              'font-size:12px;font-weight:600;cursor:pointer">',
              'viel',
            '</button>',
            '<span style="font-size:11px;color:var(--text-muted);margin-left:6px">oder fix:</span>',
            '<input id="dlr-gen-count" type="number" min="3" max="60" step="1" placeholder="auto" ',
              'title="Optional: feste Karten-Anzahl. Leer = Claude entscheidet basierend auf Density-Modus oben." ',
              'style="width:60px;padding:6px 7px;border:1px solid var(--border-subtle,rgba(255,255,255,.04));',
              'border-radius:5px;background:var(--bg-secondary,#0a0c12);color:var(--text-primary,#e2e8f0);',
              'font-size:12px;text-align:center">',
            '<span id="dlr-gen-status" style="font-size:12px;color:var(--text-muted)"></span>',
          '</div>',
          '<div id="dlr-gen-result" style="margin-top:12px"></div>',
        '</div>',
      '</div>',
    ].join('');

    // Density-Buttons: jeder triggert Generation mit eigenem Modus
    var _densBtnsInit = document.querySelectorAll('.dlr-density-btn');
    _densBtnsInit.forEach(function (b) {
      b.addEventListener('click', function () {
        var d = b.getAttribute('data-density') || 'medium';
        // Visuell aktiv markieren — aktiver Button voll-Akzent, andere outline
        _densBtnsInit.forEach(function (x) {
          var isActive = x === b;
          x.style.background = isActive ? '#a78bfa' : '#0a0c12';
          x.style.color = isActive ? '#0f172a' : '#94a3b8';
          x.style.borderColor = isActive ? '#a78bfa' : '#334155';
          x.style.fontWeight = isActive ? '700' : '600';
        });
        doGenerateCards(undefined, d);
      });
    });

    // Source-Mode: Toggle-Buttons → State in localStorage, beeinflusst /api/learn/generate-Body
    function _getSourceMode() {
      try { return localStorage.getItem('dlr_source_mode') || 'lernraum'; } catch(e) { return 'lernraum'; }
    }
    function _setSourceMode(mode) {
      try { localStorage.setItem('dlr_source_mode', mode); } catch(e) {}
    }
    function _refreshSourceButtons() {
      var current = _getSourceMode();
      var btns = document.querySelectorAll('.dlr-source-btn');
      btns.forEach(function(b) {
        var mode = b.getAttribute('data-source');
        var active = mode === current;
        if (active) {
          var bgMap = { lernraum:'#a78bfa', amboss:'#16a34a', thieme:'#0ea5e9', mix:'#94a3b8' };
          b.style.background = bgMap[mode] || '#a78bfa';
          b.style.color = '#0f172a';
          b.style.fontWeight = '700';
          b.style.borderColor = bgMap[mode] || '#a78bfa';
        } else {
          b.style.background = '#0a0c12';
          var fgMap = { lernraum:'#a78bfa', amboss:'#86efac', thieme:'#7dd3fc', mix:'#e2e8f0' };
          var bdMap = { lernraum:'#a78bfa55', amboss:'#16a34a55', thieme:'#0ea5e955', mix:'#475569' };
          b.style.color = fgMap[mode] || '#e2e8f0';
          b.style.borderColor = bdMap[mode] || '#475569';
          b.style.fontWeight = '600';
        }
      });
      // Subject-Dropdown bei externalen Quellen optional kennzeichnen
      var subj = document.getElementById('dlr-gen-subject');
      var hint = document.getElementById('dlr-source-hint');
      if (current === 'lernraum') {
        if (subj) subj.style.opacity = '1';
        if (hint) hint.textContent = '';
      } else {
        if (subj) subj.style.opacity = '0.55';
        var labels = { amboss:'rein aus Amboss-Artikeln', thieme:'rein aus Thieme/ViaMedici', mix:'aus Amboss + Thieme' };
        if (hint) hint.textContent = (labels[current] || '') + ' — Subject ist nur Suchbegriff';
      }
    }
    _refreshSourceButtons();
    document.querySelectorAll('.dlr-source-btn').forEach(function(b) {
      b.addEventListener('click', function() {
        _setSourceMode(b.getAttribute('data-source'));
        _refreshSourceButtons();
      });
    });

    // Probe-Karte: leichtgewichtig (Haiku, 1 Karte, ~8s), öffnet card-mockup.html mit echtem Content
    var previewBtn = document.getElementById('dlr-preview-btn');
    if (previewBtn) previewBtn.addEventListener('click', async function () {
      var topicInput = document.getElementById('dlr-preview-topic');
      var statusEl   = document.getElementById('dlr-preview-status');
      var topic = (topicInput ? topicInput.value : '').trim();
      if (!topic) { if (statusEl) statusEl.textContent = 'âš  Thema eingeben'; return; }
      var subjSel = document.getElementById('dlr-gen-subject');
      var subject = subjSel ? subjSel.value : topic;
      previewBtn.disabled = true;
      previewBtn.textContent = '⏳ …';
      if (statusEl) statusEl.textContent = '';
      try {
        var r = await fetch('/api/learn/preview-card', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ topic: topic, subject: subject })
        });
        var data = await r.json();
        if (data.ok && data.card) {
          localStorage.setItem('dlr_preview_card', JSON.stringify({ card: data.card, subject: subject }));
          var ck = data.cookie_status || {};
          var cookieNote = '';
          if (!ck.has_cookie) cookieNote = '<span style="color:#f59e0b">⚠ Kein Amboss-Cookie — Bild fehlt</span>';
          else if (ck.warning) cookieNote = '<span style="color:#f59e0b">⚠ Cookie ' + ck.age_hours + 'h alt — evtl. abgelaufen</span>';
          else cookieNote = '<span style="color:#34d399">✓ Amboss-Cookie OK</span>';
          if (statusEl) {
            statusEl.innerHTML = cookieNote +
              ' · <a href="/static/card-mockup.html" target="_blank" style="color:#a78bfa;text-decoration:underline">🎨 im Mockup öffnen</a>';
          }
          // Inline-Preview im Medizin-Tab rendern (kein Popup, kein Tab-Blocker)
          var resultEl = document.getElementById('dlr-preview-result');
          if (resultEl) renderCardPreview(resultEl, [data.card], subject, [topic]);
        } else {
          if (statusEl) statusEl.textContent = '✗ ' + (data.error || 'Fehler');
        }
      } catch(e) {
        if (statusEl) statusEl.textContent = '✗ ' + e.message;
      }
      previewBtn.disabled = false;
      previewBtn.textContent = 'â–¶ Probe-Karte';
    });

    // Status-Badge: zeigt Bild-Count für das gewählte Fach — live bei Wechsel
    var _metaSubjects = meta.subjects || {};
    function _updateSubjBadge() {
      var el  = document.getElementById('dlr-subject-status');
      var sel = document.getElementById('dlr-gen-subject');
      if (!el || !sel) return;
      var info  = _metaSubjects[sel.value] || {};
      var imgs  = info.image_count || 0;
      var files = info.file_count  || 0;
      el.innerHTML = imgs > 0
        ? '<span style="color:#34d399">✓ ' + imgs + ' Bild' + (imgs === 1 ? '' : 'er') + ' indexiert</span>' +
          (files > 0 ? ' · ' + files + ' Datei' + (files === 1 ? '' : 'en') : '')
        : '<span style="color:#f59e0b">⚠ Noch keine Bilder für dieses Fach — erst Dateien hochladen</span>';
    }
    var _subjSel = document.getElementById('dlr-gen-subject');
    if (_subjSel) { _subjSel.addEventListener('change', _updateSubjBadge); _updateSubjBadge(); }

    // Feedback-Badge initial befüllen
    function _updateFeedbackBadge() {
      var badge = document.getElementById('dlr-feedback-badge');
      var sel   = document.getElementById('dlr-gen-subject');
      if (!badge || !sel) return;
      try {
        var fb   = JSON.parse(localStorage.getItem('dlr_chat_feedback') || '{}');
        var msgs = (fb[sel.value] || []).length;
        badge.textContent = msgs > 0 ? msgs + ' Chat-Feedback' : '';
      } catch(e) { badge.textContent = ''; }
    }
    _updateFeedbackBadge();
    if (_subjSel) _subjSel.addEventListener('change', _updateFeedbackBadge);
  }

  var _generatingCards = false;
  var _lastDensity = 'medium';

  async function doGenerateCards(nChunks, density) {
    if (density) _lastDensity = density;
    else if (typeof nChunks !== 'number') density = _lastDensity; // Regenerate behält Modus
    if (_generatingCards) return;
    _generatingCards = true;

    var btn     = document.getElementById('dlr-gen-btn');
    var result  = document.getElementById('dlr-gen-result');
    var subject = (document.getElementById('dlr-gen-subject') || {}).value || '';
    var topics  = (document.getElementById('dlr-gen-topics')  || {}).value || '';

    if (!subject && !topics) {
      _generatingCards = false;
      setGenStatus('<span style="color:#f59e0b">Fach oder Themen angeben.</span>');
      return;
    }

    var isProbe = typeof nChunks === 'number';
    // Density-Buttons während Generation deaktivieren
    var _densBtns = document.querySelectorAll('.dlr-density-btn');
    if (btn) btn.disabled = true;
    _densBtns.forEach(function (b) { b.disabled = true; });
    var _densLabel = density ? ({low:'wenig', medium:'mittel', high:'viel'}[density] || density) : '';
    setGenStatus(isProbe
      ? '⏳ Probe-Karte wird generiert…'
      : '⏳ Claude generiert Karten' + (_densLabel ? ' (' + _densLabel + ')' : '') + '… kann 1-3 Min dauern. Nicht wegklicken.');
    if (result) result.innerHTML = '';

    var topicArr = topics
      ? topics.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
      : [];

    // Chat-Feedback des aktiven Fachs einmergen und Buffer leeren
    try {
      var fb = JSON.parse(localStorage.getItem('dlr_chat_feedback') || '{}');
      var chatMsgs = fb[subject] || [];
      if (chatMsgs.length) {
        topicArr = topicArr.concat(chatMsgs);
        fb[subject] = [];
        localStorage.setItem('dlr_chat_feedback', JSON.stringify(fb));
        var badge = document.getElementById('dlr-feedback-badge');
        if (badge) badge.textContent = '';
      }
    } catch(e) { /* ignore */ }

    var customRules = _loadCustomRules();
    var nCardsEl = document.getElementById('dlr-gen-count');
    var nCardsRaw = nCardsEl ? parseInt(nCardsEl.value, 10) : NaN;
    var nCards = (nCardsRaw && nCardsRaw >= 3) ? nCardsRaw : null; // null → Backend nutzt density

    var reqBody = {
      subject: subject,
      topics: topicArr,
      rules: customRules,
      n_chunks: nChunks || 12,
      source_mode: (function(){ try { return localStorage.getItem('dlr_source_mode') || 'lernraum'; } catch(e) { return 'lernraum'; } })(),
    };
    if (nCards !== null) reqBody.n_cards = nCards;
    if (density) reqBody.density = density;

    try {
      var res  = await fetch('/api/learn/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(reqBody),
      });
      var data = await res.json();

      if (!res.ok || !data.ok) {
        setGenStatus('<span style="color:#ef4444">Fehler: ' + (data.error || res.status) + '</span>');
        return;
      }

      var cards = data.cards || [];
      _lastCards = cards;
      _lastDeckId = data.deck_id || null;
      _stats.cards += cards.length;
      updateStats();
      setGenStatus('<span style="color:#34d399">✓ ' + cards.length + ' Karten erstellt</span>');
      renderCardPreview(result, cards, subject, topicArr);

      // Bei Probe-Karte: erste Karte in localStorage → card-mockup.html liest sie live
      if (isProbe && cards.length > 0) {
        try {
          localStorage.setItem('dlr_preview_card', JSON.stringify({ card: cards[0], subject: subject }));
        } catch(e) { /* quota */ }
      }
      // History neu laden, damit das Deck im "Frühere Decks"-Panel auftaucht
      if (typeof refreshDeckHistory === 'function') refreshDeckHistory();

    } catch (e) {
      setGenStatus('<span style="color:#ef4444">Netzwerkfehler: ' + e.message + '</span>');
    } finally {
      if (btn) btn.disabled = false;
      _densBtns.forEach(function (b) { b.disabled = false; });
      _generatingCards = false;
    }
  }

  // Fach-Farb-Palette — vollständig für alle klinischen Semester
  var _subjectColors = {
    // ── Vorklinik / Basiswissen ──
    'Anatomie':           { bg: '#1a1000', accent: '#fbbf24', border: '#b45309' },
    'Biochemie':          { bg: '#0a1a0f', accent: '#4ade80', border: '#166534' },
    'Physiologie':        { bg: '#0f172a', accent: '#60a5fa', border: '#1d4ed8' },
    'Pharmakologie':      { bg: '#0d1a1a', accent: '#2dd4bf', border: '#0f766e' },
    'Pathologie':         { bg: '#1a0a1a', accent: '#c084fc', border: '#7e22ce' },
    'Mikrobiologie':      { bg: '#0f1f1f', accent: '#22d3ee', border: '#0e7490' },
    'Immunologie':        { bg: '#1a0f00', accent: '#fdba74', border: '#ea580c' },
    'Virologie':          { bg: '#0f1a1f', accent: '#06b6d4', border: '#0e7490' },
    'Humangenetik':       { bg: '#130d1f', accent: '#d8b4fe', border: '#7c3aed' },
    // ── Innere & Spezialgebiete ──
    'Innere Medizin':     { bg: '#0f2027', accent: '#34d399', border: '#065f46' },
    'Kardiologie':        { bg: '#1a1422', accent: '#f472b6', border: '#9d174d' },
    'Pulmonologie':       { bg: '#07111f', accent: '#93c5fd', border: '#2563eb' },
    'Gastroenterologie':  { bg: '#0d180a', accent: '#a3e635', border: '#4d7c0f' },
    'Nephrologie':        { bg: '#061a18', accent: '#2dd4bf', border: '#0f766e' },
    'Endokrinologie':     { bg: '#1a1500', accent: '#fde047', border: '#ca8a04' },
    'Hämatologie':        { bg: '#1a0808', accent: '#fc8181', border: '#991b1b' },
    'Onkologie':          { bg: '#160a0a', accent: '#fca5a5', border: '#dc2626' },
    'Rheumatologie':      { bg: '#1a0d1a', accent: '#e879f9', border: '#a21caf' },
    'Infektiologie':      { bg: '#0a1a0a', accent: '#6ee7b7', border: '#065f46' },
    'Neurologie':         { bg: '#1e1b4b', accent: '#818cf8', border: '#4338ca' },
    // ── Chirurgie ──
    'Chirurgie':          { bg: '#1c1209', accent: '#f59e0b', border: '#92400e' },
    'Unfallchirurgie':    { bg: '#1a1005', accent: '#fb923c', border: '#9a3412' },
    'Neurochirurgie':     { bg: '#1a1035', accent: '#a78bfa', border: '#5b21b6' },
    'Orthopädie':         { bg: '#111827', accent: '#94a3b8', border: '#475569' },
    'Urologie':           { bg: '#141009', accent: '#fcd34d', border: '#b45309' },
    // ── Klinische Fächer ──
    'Dermatologie':       { bg: '#1f0f0a', accent: '#fb923c', border: '#c2410c' },
    'Pädiatrie':          { bg: '#0e1a10', accent: '#86efac', border: '#15803d' },
    'Gynäkologie':        { bg: '#1f0f18', accent: '#f9a8d4', border: '#be185d' },
    'Psychiatrie':        { bg: '#0d0f1e', accent: '#7dd3fc', border: '#0369a1' },
    'Ophthalmologie':     { bg: '#091528', accent: '#38bdf8', border: '#0284c7' },
    'HNO':                { bg: '#0e1c1c', accent: '#5eead4', border: '#0d9488' },
    'Radiologie':         { bg: '#0a0f1a', accent: '#a0aec0', border: '#4a5568' },
    'Notfallmedizin':     { bg: '#1f0909', accent: '#f87171', border: '#b91c1c' },
    'Intensivmedizin':    { bg: '#1f0808', accent: '#ff6b6b', border: '#dc2626' },
    'Anästhesie':         { bg: '#0a1520', accent: '#67e8f9', border: '#0891b2' },
    'Allgemeinmedizin':   { bg: '#0d1a12', accent: '#4ade80', border: '#16a34a' },
    'Rechtsmedizin':      { bg: '#0f0f0f', accent: '#9ca3af', border: '#374151' },
    'Klinische Chemie':   { bg: '#0f1a10', accent: '#86efac', border: '#166534' },
    'default':            { bg: '#0f1629', accent: '#a78bfa', border: '#6d28d9' },
  };

  function _getColors(subject) {
    return _subjectColors[subject] || _subjectColors['default'];
  }

  // Cloze-Syntax {{c1::Antwort}} → rot-fett sichtbar (im Preview/Mockup)
  // RAW bleibt für Anki-Export erhalten (wir transformieren nur in der DOM-Anzeige).
  function _renderClozeSyntax(text) {
    if (!text) return '';
    return text.replace(
      /\{\{c\d+::(.+?)(?:::.+?)?\}\}/g,
      '<span style="color:#ef4444;font-weight:800;background:#ef444410;padding:1px 5px;border-radius:3px">$1</span>'
    );
  }

  // Image Occlusion: SVG-Overlay mit klickbaren Rechtecken über dem Bild
  function _buildOcclusionSvg(occs) {
    if (!occs || !occs.length) return '';
    var rects = occs.map(function (o) {
      var lbl = String(o.label || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      var cx = (Number(o.x) + Number(o.w) / 2).toFixed(2);
      var cy = (Number(o.y) + Number(o.h) / 2 + 1).toFixed(2);
      return (
        '<g class="occ-group">' +
          '<rect x="' + o.x + '" y="' + o.y + '" width="' + o.w + '" height="' + o.h + '" ' +
            'fill="#0a0c12" fill-opacity="0.88" stroke="#a78bfa" stroke-width="0.3" rx="0.5" ry="0.5" ' +
            'style="cursor:pointer;transition:fill-opacity 0.2s" ' +
            'onclick="var r=this,t=r.nextElementSibling;if(r.getAttribute(\'fill-opacity\')===\'0.88\'){r.setAttribute(\'fill-opacity\',\'0.12\');t.style.display=\'\'}else{r.setAttribute(\'fill-opacity\',\'0.88\');t.style.display=\'none\'}">' +
            '<title>' + lbl + '</title>' +
          '</rect>' +
          '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" ' +
            'fill="#ef4444" font-weight="800" font-size="3.5" paint-order="stroke" ' +
            'stroke="#0a0c12" stroke-width="0.5" style="display:none;pointer-events:none;user-select:none">' +
            lbl + '</text>' +
        '</g>'
      );
    }).join('');
    return (
      '<svg viewBox="0 0 100 100" preserveAspectRatio="none" ' +
      'style="position:absolute;inset:0;width:100%;height:100%;display:block">' + rects + '</svg>'
    );
  }

  // Mermaid-Lib dynamisch laden wenn ein .mermaid-Element im DOM ist
  var _mermaidLoading = null;
  function _runMermaidIfNeeded(rootEl) {
    var nodes = rootEl ? rootEl.querySelectorAll('.mermaid') : [];
    if (!nodes.length) return;
    function _runIt() {
      try { window.mermaid && window.mermaid.run({ nodes: nodes }); } catch(e) {}
    }
    if (window.mermaid) return _runIt();
    if (_mermaidLoading) return _mermaidLoading.then(_runIt);
    _mermaidLoading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
      s.onload = function () {
        try { window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }); } catch(e) {}
        resolve();
      };
      s.onerror = function () { resolve(); };
      document.head.appendChild(s);
    });
    _mermaidLoading.then(_runIt);
  }

  function renderCardPreview(container, cards, subject, topicArr) {
    if (!container || !cards.length) return;
    var col = _getColors(subject);
    var withImg = cards.filter(function (c) { return c.image && c.image.trim(); }).length;
    var imgBadge = withImg === cards.length
      ? '<span style="color:#34d399;font-size:11px;font-weight:700" title="Alle Karten haben Bilder">&#x2713; ' + withImg + '/' + cards.length + ' mit Bild</span>'
      : '<span style="color:' + (withImg > 0 ? '#fbbf24' : '#94a3b8') + ';font-size:11px;font-weight:700" title="Karten mit Bild">' + withImg + '/' + cards.length + ' mit Bild</span>';

    container.innerHTML = [
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">',
        '<span style="background:' + col.accent + '22;color:' + col.accent + ';border:1px solid ' + col.accent + '55;',
        'border-radius:20px;padding:3px 12px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase">' + (subject || 'Karten') + '</span>',
        '<span style="color:var(--text-muted,#64748b);font-size:12px">' + cards.length + ' Karten erstellt</span>',
        imgBadge,
      '</div>',
    ].join('');

    // Vorschau-Button: öffnet die volle Deck-Vorschau in neuem Tab — kein Inline-Scrollen mehr.
    var previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.textContent = '🔍 Vorschau in neuem Tab';
    previewBtn.title = 'Alle Karten als HTML-Vorschau im neuen Tab öffnen';
    previewBtn.style.cssText = 'margin-bottom:12px;padding:7px 14px;background:#0a0c12;color:#e2e8f0;' +
      'border:1px solid #334155;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer';
    previewBtn.onclick = function () {
      if (_lastDeckId) {
        window.open('/api/learn/decks/' + encodeURIComponent(_lastDeckId) + '/preview', '_blank', 'noopener');
      } else {
        alert('Deck-ID fehlt — generiere die Karten neu.');
      }
    };
    container.appendChild(previewBtn);

    var fbWrap = document.createElement('div');
    fbWrap.style.cssText = 'margin-top:10px;display:flex;gap:8px;align-items:flex-end';
    var textarea = document.createElement('textarea');
    textarea.placeholder = 'Feedback zum Stil (z.B. "mehr Bilder", "Amboss Fun Facts", "andere Farben") …';
    textarea.style.cssText = 'flex:1;min-height:56px;background:var(--bg-secondary,#0a0c12);color:var(--text-primary,#e2e8f0);' +
      'border:1px solid var(--border-subtle,rgba(255,255,255,.04));border-radius:6px;padding:8px 10px;font-size:12px;resize:vertical';
    var regenBtn = document.createElement('button');
    regenBtn.textContent = '↺ Nochmal';
    regenBtn.style.cssText = 'padding:8px 14px;background:#a78bfa;color:#0f172a;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap';
    regenBtn.onclick = function () {
      var feedback = textarea.value.trim();
      if (!feedback) { textarea.focus(); return; }
      var topicsEl = document.getElementById('dlr-gen-topics');
      if (topicsEl) topicsEl.value = (topicsEl.value ? topicsEl.value + ', ' : '') + feedback;
      textarea.value = '';
      doGenerateCards();
    };
    fbWrap.appendChild(textarea);
    fbWrap.appendChild(regenBtn);
    container.appendChild(fbWrap);

    var dlBtn = document.createElement('button');
    dlBtn.textContent = '⬇ Anki-Paket (.apkg) herunterladen';
    dlBtn.style.cssText = 'margin-top:10px;padding:7px 16px;background:#16a34a;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer';
    dlBtn.onclick = async function () {
      if (dlBtn.disabled) return;
      var subjectEl = document.getElementById('dlr-gen-subject');
      var subject = (subjectEl && subjectEl.value) || 'karten';
      dlBtn.disabled = true;
      dlBtn.textContent = '⏳ Baue .apkg…';
      try {
        var res = await fetch('/api/learn/export-zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: subject, cards: _lastCards }),
        });
        if (!res.ok) {
          var errTxt = await res.text().catch(function () { return ''; });
          alert('apkg-Export fehlgeschlagen: ' + res.status + (errTxt ? '\n' + errTxt.slice(0, 400) : ''));
          return;
        }
        var blob = await res.blob();
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = subject.toLowerCase().replace(/\s+/g, '_') + '_anki.apkg';
        a.click();
        URL.revokeObjectURL(a.href);
        // Bild-Check: Zeige kurzen Report nach Export
        var withImg  = (_lastCards || []).filter(function (c) { return c.image && c.image.trim(); }).length;
        var total    = (_lastCards || []).length;
        var noImg    = total - withImg;
        // Inhaltlicher Plausibilitätscheck: Bildname gegen Kartenvorderseite
        var mismatch = (_lastCards || []).filter(function (c) {
          if (!c.image) return false;
          var fname = (c.image.split('/').pop() || '').toLowerCase();
          // Amboss-Screenshots (uuid-Namen) gelten immer als passend
          if (/amboss_[0-9a-f]+\./.test(fname)) return false;
          var front = (c.front || '').toLowerCase();
          // Als Mismatch gilt: kein einziges Wort aus dem Bildnamen kommt in der Frage vor
          var nameParts = fname.replace(/\.[^.]+$/, '').replace(/[_\-]/g, ' ').split(' ').filter(function (p) { return p.length > 3; });
          return nameParts.length > 0 && !nameParts.some(function (p) { return front.indexOf(p) !== -1; });
        }).length;
        var color   = mismatch > 0 ? '#f59e0b' : '#34d399';
        var note    = mismatch > 0 ? ' · ⚠ ' + mismatch + ' Bild-Thema-Mismatch' : '';
        setGenStatus('<span style="color:' + color + '">.apkg ✓ · ' + withImg + '/' + total + ' Bilder' + (noImg ? ' · ' + noImg + ' ohne Bild' : '') + note + '</span>');
      } catch (e) {
        alert('Netzwerkfehler: ' + e.message);
      } finally {
        dlBtn.disabled = false;
        dlBtn.textContent = '⬇ Anki-Paket (.apkg) herunterladen';
      }
    };
    container.appendChild(dlBtn);

    // ── Direkt-Sync in Anki via AnkiConnect ──
    var syncWrap = document.createElement('div');
    syncWrap.style.cssText = 'margin-top:10px;padding:10px;background:#0a0c12;border:1px solid #16a34a30;border-radius:7px';
    var syncSubject = (document.getElementById('dlr-gen-subject') || {}).value || 'Medizin';
    var defaultDeck = 'Medizin::' + syncSubject;
    syncWrap.innerHTML = [
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">',
        '<span style="font-size:12px;color:#94a3b8;white-space:nowrap">Deck:</span>',
        '<input id="dlr-anki-deck" list="dlr-anki-decks-list" ',
          'value="' + defaultDeck.replace(/"/g, '&quot;') + '" ',
          'placeholder="Medizin::Kardio" autocomplete="off" spellcheck="false" ',
          'style="flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--border-subtle,rgba(255,255,255,.04));border-radius:6px;background:#070a13;color:#e2e8f0;font-size:12px;font-family:var(--font-mono,ui-monospace,monospace)">',
        '<datalist id="dlr-anki-decks-list"></datalist>',
        '<button id="dlr-anki-sync-btn" ',
          'style="padding:7px 16px;background:#16a34a;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">',
          '→ In Anki speichern',
        '</button>',
      '</div>',
      '<div id="dlr-anki-sync-status" style="font-size:11px;color:#64748b;min-height:14px"></div>',
    ].join('');
    container.appendChild(syncWrap);

    var deckInput = syncWrap.querySelector('#dlr-anki-deck');
    var deckList  = syncWrap.querySelector('#dlr-anki-decks-list');
    var syncBtn   = syncWrap.querySelector('#dlr-anki-sync-btn');
    var syncStat  = syncWrap.querySelector('#dlr-anki-sync-status');

    // Deck-Liste asynchron befüllen (Anki evtl. nicht offen → graceful fail)
    fetch('/api/anki/decks').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok || !Array.isArray(d.decks)) {
        syncStat.innerHTML = '<span style="color:#f59e0b">âš  Anki nicht erreichbar (AnkiConnect auf :8765?). Deck wird trotzdem angelegt beim Sync.</span>';
        return;
      }
      deckList.innerHTML = d.decks.map(function (name) {
        return '<option value="' + name.replace(/"/g, '&quot;') + '">';
      }).join('');
      // Wenn defaultDeck schon in der Liste ist oder ein Parent existiert, ist alles fine
    }).catch(function () { /* silent */ });

    syncBtn.onclick = async function () {
      if (syncBtn.disabled) return;
      var deck = (deckInput.value || '').trim() || 'Default';
      if (!_lastCards || !_lastCards.length) {
        syncStat.innerHTML = '<span style="color:#ef4444">âš  Keine Karten zum Sync</span>';
        return;
      }
      syncBtn.disabled = true;
      syncBtn.textContent = '⏳ Sync…';
      syncStat.innerHTML = '<span style="color:#94a3b8">Lade ' + _lastCards.length + ' Karten + Bilder nach Anki…</span>';
      try {
        var res = await fetch('/api/anki/bulk-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: syncSubject, deck: deck, cards: _lastCards }),
        });
        var d = await res.json();
        if (!d.ok) {
          syncStat.innerHTML = '<span style="color:#ef4444">✗ ' + _escHtml(d.error || 'Fehler') + '</span>';
          return;
        }
        var parts = [];
        parts.push('<span style="color:#34d399">✓ ' + d.added + ' neu</span>');
        if (d.duplicates) parts.push('<span style="color:#64748b">' + d.duplicates + ' Duplikat' + (d.duplicates === 1 ? '' : 'e') + '</span>');
        if (d.errors)     parts.push('<span style="color:#ef4444">' + d.errors + ' Fehler</span>');
        parts.push('<span style="color:#94a3b8">' + d.media + ' Bild' + (d.media === 1 ? '' : 'er') + '</span>');
        parts.push('<span style="color:#64748b">→ Deck "' + _escHtml(d.deck) + '"</span>');
        syncStat.innerHTML = parts.join(' · ');
        // Pro-Karte-Badges im Container setzen (falls data-card-index existiert)
        (d.cards || []).forEach(function (cr) {
          var cardEl = container.querySelector('[data-card-index="' + cr.index + '"]');
          if (!cardEl) return;
          var badge = cardEl.querySelector('.dlr-anki-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'dlr-anki-badge';
            badge.style.cssText = 'display:inline-block;margin-left:6px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700';
            var target = cardEl.querySelector('.dlr-card-head') || cardEl.firstElementChild || cardEl;
            target.appendChild(badge);
          }
          if (cr.ok) {
            badge.style.background = '#16a34a25'; badge.style.color = '#34d399';
            badge.textContent = '✓ in Anki';
          } else if (cr.is_duplicate) {
            badge.style.background = '#64748b25'; badge.style.color = '#94a3b8';
            badge.textContent = '↺ Duplikat';
          } else {
            badge.style.background = '#ef444425'; badge.style.color = '#f87171';
            badge.textContent = '✗ Fehler';
          }
        });
      } catch (e) {
        syncStat.innerHTML = '<span style="color:#ef4444">✗ Netzwerkfehler: ' + _escHtml(e.message) + '</span>';
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = '→ In Anki speichern';
      }
    };

    // ── PNG-Vorschau-Export ──
    var pngBtn = document.createElement('button');
    pngBtn.textContent = '🖼 Karte als PNG exportieren';
    pngBtn.style.cssText = 'margin-top:6px;padding:7px 16px;background:#6366f1;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;display:block';
    pngBtn.onclick = async function () {
      var firstCard = container.querySelector('[data-card-preview]');
      if (!firstCard) { alert('Keine Karte zum Exportieren gefunden.'); return; }
      if (typeof html2canvas === 'undefined') { alert('html2canvas nicht geladen.'); return; }
      pngBtn.disabled = true;
      pngBtn.textContent = '⏳ Rendere…';
      try {
        var canvas = await html2canvas(firstCard, {
          backgroundColor: null,
          scale: 2,
          useCORS: true,
          logging: false,
        });
        var a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        var subjectSlug = (subject || 'karte').toLowerCase().replace(/\s+/g, '_');
        a.download = subjectSlug + '_card_preview.png';
        a.click();
      } catch (e) {
        alert('PNG-Export fehlgeschlagen: ' + e.message);
      } finally {
        pngBtn.disabled = false;
        pngBtn.textContent = '🖼 Karte als PNG exportieren';
      }
    };
    container.appendChild(pngBtn);
  }

  function _relTimeDe(unixTs) {
    if (!unixTs) return 'nie';
    var delta = Math.floor(Date.now()/1000) - unixTs;
    if (delta < 60) return 'gerade eben';
    if (delta < 3600) return 'vor ' + Math.floor(delta/60) + ' min';
    if (delta < 86400) return 'vor ' + Math.floor(delta/3600) + ' Std';
    if (delta < 86400*7) return 'vor ' + Math.floor(delta/86400) + ' Tg';
    return 'vor ' + Math.floor(delta/86400/7) + ' Wochen';
  }

  function _expiryBadge(savedAt, ttlDays) {
    if (!savedAt || !ttlDays) return '';
    var nowSec = Math.floor(Date.now()/1000);
    var daysLeft = Math.floor((savedAt + ttlDays*86400 - nowSec) / 86400);
    var color, text;
    if (daysLeft < 0)       { color = '#ef4444'; text = 'wahrscheinlich abgelaufen'; }
    else if (daysLeft < 3)  { color = '#f59e0b'; text = 'läuft in ' + daysLeft + ' Tag' + (daysLeft===1?'':'en') + ' ab'; }
    else                    { color = '#64748b'; text = 'Schätzung: noch ~' + daysLeft + ' Tage'; }
    return '<span style="color:' + color + '">' + text + '</span>';
  }

  // Ehrliche Expiry-Anzeige aus echten JWT-Timestamps (Thieme/ViaMedici).
  // Offline-Session = Refresh-Token ohne harte Ablaufzeit, hält wochenlang.
  // Nicht-Offline: refresh_exp ist bindend (danach ist Silent-Refresh tot).
  function _sessionExpiryBadge(data) {
    if (!data) return '';
    var nowSec = Math.floor(Date.now()/1000);
    var offline = !!data.is_offline;

    // Offline-Session: Refresh-Token hat typischerweise kein exp → wochenlang gültig
    if (offline) {
      var tagOff = '<span style="color:#34d399">Offline-Session aktiv · hält wochenlang</span>';
      if (data.refresh_exp) {
        var daysLeftR = Math.floor((data.refresh_exp - nowSec) / 86400);
        if (daysLeftR > 0) {
          tagOff = '<span style="color:#34d399">Offline-Session · noch ' +
            daysLeftR + ' Tage gültig</span>';
        }
      }
      return tagOff;
    }

    // Nicht-Offline: refresh_exp bindend (oder KC_IDENTITY-Cookie als Fallback)
    var limit = data.refresh_exp || data.session_exp;
    if (!limit) return '';
    var secsLeft = limit - nowSec;
    var color, text;
    if (secsLeft < 0) {
      color = '#ef4444'; text = 'Session abgelaufen';
    } else if (secsLeft < 3600) {
      color = '#ef4444'; text = 'läuft in ' + Math.max(1, Math.floor(secsLeft/60)) + ' min ab';
    } else if (secsLeft < 86400) {
      color = '#f59e0b'; text = 'läuft in ' + Math.floor(secsLeft/3600) + ' Std ab';
    } else if (secsLeft < 86400*7) {
      color = '#f59e0b'; text = 'läuft in ' + Math.floor(secsLeft/86400) + ' Tagen ab';
    } else {
      color = '#34d399'; text = 'noch ' + Math.floor(secsLeft/86400) + ' Tage gültig';
    }
    return '<span style="color:' + color + '">' + text + '</span>';
  }

  function _chipHtml(state, label) {
    // state: "ok" | "bad" | "unknown"
    var c = state === 'ok'  ? { bg:'#34d39920', bd:'#34d39940', fg:'#34d399', dot:'#34d399' }
          : state === 'bad' ? { bg:'#ef444420', bd:'#ef444440', fg:'#f87171', dot:'#ef4444' }
          :                    { bg:'#64748b20', bd:'#64748b40', fg:'#94a3b8', dot:'#94a3b8' };
    return '<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;' +
      'background:' + c.bg + ';border:1px solid ' + c.bd + ';border-radius:12px;' +
      'font-size:11px;color:' + c.fg + ';white-space:nowrap">' +
      '<span style="width:6px;height:6px;border-radius:50%;background:' + c.dot + ';flex-shrink:0"></span>' +
      label + '</div>';
  }

  // Generic Cookie-Login-Panel — gleiches Muster für Amboss + Thieme
  function _renderCookiePanel(opts) {
    // opts: { container, chip, providerKey, brandColor, heading, brandLabel,
    //         placeholder, instructions (array), loginPath, testData, ttlDays, onRerender }
    var c = opts.container;
    if (!c) return;

    var data = opts.testData || {};
    var state, headline;
    if (data.ok && (data.has_token || data.has_cookies)) {
      state = 'ok';
      headline = '✓ ' + opts.brandLabel + ' verbunden';
    } else if (data.source && data.saved_at) {
      state = 'bad';
      headline = '⚠️ Cookie da, aber ' + opts.brandLabel + ' antwortet nicht — wahrscheinlich abgelaufen';
    } else {
      state = 'unknown';
      headline = 'â—‹ Kein ' + opts.brandLabel + '-Cookie hinterlegt';
    }

    if (opts.chip) {
      var chipLabel = state === 'ok'  ? opts.brandLabel + ' verbunden'
                    : state === 'bad' ? opts.brandLabel + ' abgelaufen'
                    :                    opts.brandLabel + ' —';
      opts.chip.innerHTML = _chipHtml(state, chipLabel);
    }

    var stateColor = state === 'ok' ? '#34d399' : state === 'bad' ? '#ef4444' : '#94a3b8';
    // Echte Session-Expiry hat Vorrang (Thieme: session_exp/refresh_exp aus JWTs).
    // Nur wenn das fehlt und ttlDays da ist, nutzen wir die grobe Heuristik.
    var expiryHtml = _sessionExpiryBadge(data);
    if (!expiryHtml && opts.ttlDays) {
      expiryHtml = _expiryBadge(data.saved_at, opts.ttlDays);
    }
    var savedLine = data.saved_at
      ? 'Cookie gespeichert: <span style="color:#cbd5e1">' + _relTimeDe(data.saved_at) + '</span>' +
        (data.source === 'config' ? ' <span style="color:#64748b">(aus config.json)</span>' : '') +
        (expiryHtml ? ' · ' + expiryHtml : '')
      : '<span style="color:#64748b">Noch kein Cookie — bitte unten einfügen</span>';
    var errorLine = data.error ? '<div style="font-size:10px;color:#ef4444;margin-top:3px">Fehler: ' + _escHtml(data.error) + '</div>' : '';
    var okMessage = data.message ? '<div style="font-size:10px;color:#64748b;margin-top:3px">' + _escHtml(data.message) + '</div>' : '';

    var instructionsHtml = '<ol style="margin:6px 0 0;padding-left:18px;color:#94a3b8;font-size:11px;line-height:1.6">' +
      opts.instructions.map(function(li){ return '<li>' + li + '</li>'; }).join('') +
      '</ol>';

    c.innerHTML = [
      '<div class="panel" style="border-color:' + opts.brandColor + '30;margin-top:8px">',
        '<div class="panel-header">',
          '<h2>🔑 ' + opts.heading + '</h2>',
          '<span style="font-size:11px;color:var(--text-muted)">Cookie wird lokal gecacht</span>',
        '</div>',
        '<div class="panel-body">',
          '<div style="padding:8px 10px;background:var(--bg-secondary,#0a0c12);border:1px solid ' + stateColor + '40;border-radius:6px;margin-bottom:10px">',
            '<div style="font-size:13px;font-weight:600;color:' + stateColor + '">' + headline + '</div>',
            '<div style="font-size:11px;color:#94a3b8;margin-top:3px">' + savedLine + '</div>',
            errorLine,
            okMessage,
          '</div>',
          '<details' + (state === 'ok' ? '' : ' open') + ' style="margin-bottom:8px">',
            '<summary style="cursor:pointer;color:#94a3b8;font-size:12px;font-weight:600;user-select:none;padding:4px 0">',
              (state === 'ok' ? '🔄 Cookie ersetzen (z.B. nach Ablauf)' : '✏️ Cookie eingeben'),
            '</summary>',
            '<div style="margin-top:8px;padding:10px;background:var(--bg,#070a13);border:1px solid var(--border-subtle,rgba(255,255,255,.04));border-radius:6px">',
              '<details style="margin-bottom:10px">',
                '<summary style="cursor:pointer;color:#94a3b8;font-size:11px;user-select:none">',
                  'ℹ️ Wie komm ich an den Cookie? (Anleitung)',
                '</summary>',
                instructionsHtml,
              '</details>',
              '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">',
                '<input id="' + opts.providerKey + '-cookie-input" type="password" ',
                  'placeholder="' + opts.placeholder + '" ',
                  'autocomplete="off" spellcheck="false" ',
                  'style="flex:1;min-width:260px;padding:7px 10px;border:1px solid var(--border-subtle,rgba(255,255,255,.04));',
                  'border-radius:6px;background:var(--bg-secondary,#0a0c12);color:var(--text-primary,#e2e8f0);font-size:13px;font-family:var(--font-mono,ui-monospace,monospace)">',
                '<button id="' + opts.providerKey + '-cookie-btn" ',
                  'style="padding:7px 14px;background:' + opts.brandColor + ';color:#0f172a;border:none;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer">',
                  'Speichern',
                '</button>',
              '</div>',
              '<div id="' + opts.providerKey + '-cookie-msg" style="font-size:11px;margin-top:6px;color:var(--text-muted)"></div>',
            '</div>',
          '</details>',
        '</div>',
      '</div>',
    ].join('');

    var btn   = document.getElementById(opts.providerKey + '-cookie-btn');
    var input = document.getElementById(opts.providerKey + '-cookie-input');
    var msg   = document.getElementById(opts.providerKey + '-cookie-msg');
    if (!btn || !input) return;

    async function submit() {
      var cookie = (input.value || '').trim();
      if (!cookie) {
        msg.innerHTML = '<span style="color:#f59e0b">Cookie erforderlich</span>';
        return;
      }
      btn.disabled = true;
      btn.textContent = '⏳';
      msg.innerHTML = 'Teste Cookie…';
      try {
        var res = await fetch(opts.loginPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie: cookie }),
        });
        var d = await res.json();
        if (d.ok) {
          msg.innerHTML = '<span style="color:' + (d.warning ? '#f59e0b' : '#34d399') + '">' +
            (d.warning ? '⚠️ ' : '✓ ') + _escHtml(d.message || 'Cookie gespeichert') + '</span>';
          input.value = '';
          setTimeout(opts.onRerender, 1000);
        } else {
          msg.innerHTML = '<span style="color:#ef4444">❌ ' + _escHtml(d.error || 'Fehler') + '</span>';
          btn.disabled = false;
          btn.textContent = 'Speichern';
        }
      } catch (err) {
        msg.innerHTML = '<span style="color:#ef4444">❌ Netzwerkfehler: ' + _escHtml(err.message) + '</span>';
        btn.disabled = false;
        btn.textContent = 'Speichern';
      }
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }

  async function renderAmbossLoginPanel() {
    var container = document.getElementById('dlr-amboss-login-panel');
    var chip      = document.getElementById('dlr-amboss-status-chip');
    if (!container) return;

    var data = {};
    try {
      var res = await fetch('/api/learn/amboss-test');
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: 'Netzwerkfehler: ' + e.message };
    }

    _renderCookiePanel({
      container: container,
      chip: chip,
      providerKey: 'dlr-amboss',
      brandColor: '#38bdf8',
      brandLabel: 'Amboss',
      heading: 'Amboss-Zugang (Session-Cookie)',
      placeholder: 'next_auth_amboss_de Wert (Hex-Hash, ~32 Zeichen)',
      instructions: [
        'In Chrome/Edge auf <b style="color:#cbd5e1">next.amboss.com</b> einloggen',
        'F12 → Tab <b style="color:#cbd5e1">Application</b> (bei schmalem Fenster unter »)',
        'Links: Storage → Cookies → <b style="color:#cbd5e1">https://next.amboss.com</b>',
        'Zeile <b style="color:#cbd5e1">next_auth_amboss_de</b> suchen, Wert kopieren',
        'Hier einfügen und "Speichern"',
      ],
      loginPath: '/api/learn/amboss-login',
      testData: data,
      ttlDays: 30,
      onRerender: renderAmbossLoginPanel,
    });
  }

  function renderBetaPrototype() {
    var container = document.getElementById('dlr-proposals');
    if (!container) return;

    var demoBanner = document.createElement('div');
    demoBanner.style.cssText = 'margin-bottom:16px';
    demoBanner.innerHTML = [
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">',
        '<span style="background:#a78bfa22;color:#a78bfa;border:1px solid #a78bfa44;border-radius:20px;',
        'padding:3px 12px;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Beta-Design v1</span>',
        '<span style="color:var(--text-muted,#64748b);font-size:12px">Musterkarten · amkiphil-Style mit Claude Touch</span>',
        '<button id="dlr-proto-png-btn" style="margin-left:auto;padding:4px 12px;background:#a78bfa;color:#0f172a;',
        'border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">⬇ SVG Export</button>',
      '</div>',
    ].join('');
    container.insertBefore(demoBanner, container.firstChild);

    var previewWrap = document.createElement('div');
    previewWrap.id = 'dlr-beta-proto-wrap';
    container.insertBefore(previewWrap, demoBanner.nextSibling);

    var demoCards = [{
      front: 'Welche 4 Klassen von Antiarrhythmika gibt es nach Vaughan-Williams und was ist ihr jeweiliger Wirkmechanismus?',
      back: 'I: Na-Kanalblocker (Ia/Ib/Ic) — verlängern/verkürzen/keine ÄP-Dauer\nII: Betablocker — reduzieren sympathische Stimulation des SA-Knotens\nIII: K-Kanalblocker (z.B. Amiodaron) — verlängern Repolarisation\nIV: Ca-Kanalblocker — Verapamil, Diltiazem, verlängern AV-Überleitung',
      funfact: 'Amiodaron (Klasse III) enthält 37% Jod nach Gewicht — deswegen TFT-Kontrollen alle 6 Monate!',
      merkhilfe: 'SINKEN: Sinus-Inhibition, Na-Block, Kalium-Block, Einschränkung Ca²⁺',
    }, {
      front: 'EKG-Kriterien: Wie erkennst du einen kompletten Linksschenkelblock (LBBB)?',
      back: 'QRS ≥ 120 ms · Keine Septal-Q-Zacken in I, aVL, V5-V6 · Breites, gekerbtes R in V5-V6 (M-Form) · Tiefes S in V1 (W-Form) · Diskordante ST-T-Veränderungen',
      funfact: 'Neu aufgetretener LBBB bei Brustschmerz = STEMI-Äquivalent! Sgarbossa-Kriterien immer checken.',
      merkhilfe: 'WiLLiaM: W in V1, M in V5/V6 → Links-Schenkelblock',
    }];

    renderCardPreview(previewWrap, demoCards, 'Kardiologie', ['Antiarrhythmika', 'EKG']);

    var pngBtn = document.getElementById('dlr-proto-png-btn');
    if (pngBtn) pngBtn.addEventListener('click', function () {
      var btn = this;
      btn.textContent = '⏳';
      btn.disabled = true;
      var col = _subjectColors['Kardiologie'];
      var svgContent = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="340">',
        '<style>text{font-family:system-ui,ui-sans-serif,sans-serif}</style>',
        '<rect width="560" height="340" rx="12" fill="' + col.bg + '"/>',
        '<defs><linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">',
        '<stop offset="0" stop-color="' + col.bg + '"/>',
        '<stop offset="1" stop-color="' + col.accent + '" stop-opacity="0.16"/>',
        '</linearGradient></defs>',
        '<rect width="560" height="34" rx="12" fill="url(#hdr)"/>',
        '<rect y="22" width="560" height="12" fill="url(#hdr)"/>',
        '<rect y="33" width="560" height="1" fill="' + col.border + '55"/>',
        '<text x="14" y="22" font-size="9" font-weight="800" fill="' + col.accent + '" letter-spacing="2">KARDIOLOGIE</text>',
        '<rect x="496" y="8" width="52" height="18" rx="9" fill="' + col.accent + '22"/>',
        '<text x="522" y="21" font-size="10" font-weight="700" fill="' + col.accent + 'cc" text-anchor="middle">#1</text>',
        '<text x="14" y="59" font-size="8" fill="' + col.accent + '88" letter-spacing="2" font-weight="700">— FRAGE</text>',
        '<text x="14" y="78" font-size="12" font-weight="600" fill="#f1f5f9">Vaughan-Williams Antiarrhythmika: 4 Klassen und Wirkmechanismen?</text>',
        '<rect y="96" width="560" height="1" fill="' + col.border + '33"/>',
        '<rect y="96" width="560" height="194" fill="#070a13"/>',
        '<text x="14" y="115" font-size="8" fill="#475569" letter-spacing="2" font-weight="700">— ANTWORT</text>',
        '<text x="14" y="134" font-size="11" fill="#cbd5e1">I: Na-Kanalblocker (Ia/b/c)  ·  II: Betablocker</text>',
        '<text x="14" y="152" font-size="11" fill="#cbd5e1">III: K-Kanalblocker (Amiodaron)  ·  IV: Ca-Kanalblocker</text>',
        '<rect x="8" y="168" width="3" height="56" rx="1.5" fill="#f59e0b"/>',
        '<rect x="11" y="168" width="541" height="56" rx="0 8 8 0" fill="#f59e0b0d"/>',
        '<text x="22" y="183" font-size="8" fill="#f59e0b" font-weight="800" letter-spacing="1">💡 FUN FACT</text>',
        '<text x="22" y="200" font-size="11" fill="#fde68a">Amiodaron enthält 37% Jod → TFT alle 6 Monate!</text>',
        '<text x="22" y="216" font-size="10" fill="#fde68acc">NW: Hypo-/Hyperthyreose, Lungenfibrose, Photosensibilität</text>',
        '<rect x="8" y="232" width="3" height="46" rx="1.5" fill="' + col.accent + '"/>',
        '<rect x="11" y="232" width="541" height="46" rx="0 8 8 0" fill="' + col.accent + '0c"/>',
        '<text x="22" y="247" font-size="8" fill="' + col.accent + '" font-weight="800" letter-spacing="1">🧠 MERKHILFE</text>',
        '<text x="22" y="264" font-size="11" fill="#e2d9f3">SINKEN: Sinus-Inh., Na-Block, Kalium-Block, Ca²⁺-Einschr.</text>',
        '<rect y="290" width="560" height="50" fill="#0a0c14"/>',
        '<text x="14" y="312" font-size="9" fill="#334155">Jarvis · Lernraum · Beta-Design v1 · Kardiologie</text>',
        '<text x="546" y="312" font-size="9" fill="' + col.accent + '88" text-anchor="end">amkiphil-Style · Claude Touch</text>',
        '</svg>',
      ].join('');
      var blob = new Blob([svgContent], { type: 'image/svg+xml' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'anki-card-beta-design-v1.svg';
      a.click();
      btn.textContent = '⬇ SVG Export';
      btn.disabled = false;
    });
  }

  async function renderThiemeLoginPanel() {
    // Container/Chip sind historisch als dlr-thieme-* benannt, aber zeigen jetzt ViaMedici.
    var container = document.getElementById('dlr-thieme-login-panel');
    var chip      = document.getElementById('dlr-thieme-status-chip');
    if (!container) return;

    var data = {};
    try {
      var res = await fetch('/api/learn/viamedici-test');
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: 'Netzwerkfehler: ' + e.message };
    }

    _renderCookiePanel({
      container: container,
      chip: chip,
      providerKey: 'dlr-viamedici',
      brandColor: '#0ea5e9',
      brandLabel: 'ViaMedici',
      heading: 'Thieme/ViaMedici-Zugang (Keycloak-Session)',
      placeholder: 'document.cookie aus authentication.thieme.de',
      instructions: [
        'In Chrome/Edge auf <b style="color:#cbd5e1">viamedici.thieme.de</b> einloggen (am besten "Angemeldet bleiben" anhaken)',
        'F12 → Tab <b style="color:#cbd5e1">Application</b> (bei schmalem Fenster unter »)',
        'Links: Storage → Cookies → <b style="color:#cbd5e1">https://authentication.thieme.de</b> anklicken <span style="color:#f59e0b">(NICHT viamedici!)</span>',
        'In der Tabelle siehst du Zeilen wie <code style="color:#cbd5e1">KEYCLOAK_IDENTITY</code>, <code style="color:#cbd5e1">KEYCLOAK_SESSION</code>, <code style="color:#cbd5e1">AUTH_SESSION_ID</code>',
        'Tipp: Alle Zeilen markieren (Strg+A in der Tabelle) → Strg+C → hier einfügen (MC extrahiert automatisch die richtigen Cookies)',
        'Alternative: einzeln die Values von KEYCLOAK_IDENTITY, KEYCLOAK_SESSION und AUTH_SESSION_ID kopieren und im Format <code>KEYCLOAK_IDENTITY=…; KEYCLOAK_SESSION=…; AUTH_SESSION_ID=…</code> einfügen',
        '"Speichern" drücken — MC testet sofort via Silent-Refresh und holt sich dann automatisch alle ~10 Min einen neuen Access-Token (läuft wochenlang solange du nicht ausloggst)',
      ],
      loginPath: '/api/learn/viamedici-login',
      testData: data,
      // TTL kommt ehrlich aus data.session_exp/refresh_exp/is_offline (viamedici-test).
      // Offline-Session (offline_access Scope) hält Wochen, sonst ~19-24h.
      onRerender: renderThiemeLoginPanel,
    });
  }

  var _DEFAULT_CARD_RULES = [
    'Front: Präzise Frage oder Lückentext, max 120 Zeichen',
    'Back: Kernpunkte, HTML erlaubt (<br>, <b>), Bullet-Points OK',
    'Tags: Komma-getrennt (z.B. Kardiologie, EKG, sem8)',
    'ImagePath: exakt einen Pfad aus Bilderliste kopieren, Match via Thema-Label',
    'FunFact: Klinisch relevanter Merksatz oder Amboss-Perle (1 Satz)',
    'Merkhilfe: Eselsbrücke oder Mnemonic (1 Satz, kreativ)',
    'Source: Thema-Label aus Bilderliste oder Quelldatei',
    'Anzahl: 10-15 Karten pro Generate-Run',
    'Bild-Priorität: Amboss-Artikel → Amboss-Atlas → Folien-Screenshots',
  ];

  function _loadCustomRules() {
    try {
      var raw = localStorage.getItem('dlr_card_rules');
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function (r) { return r && typeof r === 'string'; }) : [];
    } catch (e) { return []; }
  }

  function _saveCustomRules(rules) {
    try { localStorage.setItem('dlr_card_rules', JSON.stringify(rules)); } catch (e) { /* quota */ }
  }

  function renderCardRules() {
    var container = document.getElementById('dlr-card-rules');
    if (!container) return;

    var custom = _loadCustomRules();
    var defaultsHtml = _DEFAULT_CARD_RULES.map(function (r) {
      return '<li style="margin:3px 0;line-height:1.4">' + _escHtml(r) + '</li>';
    }).join('');

    var customHtml = custom.length
      ? custom.map(function (r, i) {
          return '<li data-rule-idx="' + i + '" style="margin:4px 0;line-height:1.4;display:flex;align-items:flex-start;gap:6px">' +
            '<span style="flex:1;color:#e2e8f0">' + _escHtml(r) + '</span>' +
            '<button class="dlr-rule-del" data-idx="' + i + '" ' +
              'title="Regel entfernen" ' +
              'style="background:transparent;border:none;color:#64748b;cursor:pointer;font-size:14px;line-height:1;padding:0 4px">×</button>' +
          '</li>';
        }).join('')
      : '<li style="color:#64748b;font-style:italic;margin:4px 0">Noch keine eigenen Regeln</li>';

    container.innerHTML = [
      '<div style="background:var(--bg-secondary,#0a0c12);border:1px solid #a78bfa30;border-radius:8px;padding:12px 14px;font-size:12px">',
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">',
          '<div style="font-size:13px;font-weight:700;color:#a78bfa">📏 Karten-Regeln</div>',
          '<span style="font-size:10px;color:#64748b">an Claude beim Generieren</span>',
        '</div>',
        '<details style="margin-bottom:10px">',
          '<summary style="cursor:pointer;color:#94a3b8;font-size:11px;font-weight:600;user-select:none">',
            'Default-Regeln (' + _DEFAULT_CARD_RULES.length + ') — klicken zum Ausklappen',
          '</summary>',
          '<ul style="margin:6px 0 0;padding-left:18px;color:#94a3b8;font-size:11px">',
            defaultsHtml,
          '</ul>',
        '</details>',
        '<div style="color:#cbd5e1;font-size:11px;font-weight:600;margin-bottom:4px">',
          'Eigene Maßvorgaben <span style="color:#64748b;font-weight:400">(' + custom.length + ')</span>',
        '</div>',
        '<ul style="margin:0 0 10px;padding-left:18px;font-size:11px">',
          customHtml,
        '</ul>',
        '<div style="display:flex;gap:4px">',
          '<input id="dlr-rule-input" type="text" placeholder="z.B. Keine Negationen in Front" ',
            'style="flex:1;padding:5px 8px;border:1px solid var(--border-subtle,rgba(255,255,255,.06));',
            'border-radius:4px;background:var(--bg,#070a13);color:var(--text-primary,#e2e8f0);font-size:11px">',
          '<button id="dlr-rule-add" ',
            'style="padding:5px 10px;background:#a78bfa;color:#0f172a;border:none;border-radius:4px;',
            'font-size:11px;font-weight:700;cursor:pointer">+</button>',
        '</div>',
      '</div>',
    ].join('');

    var addBtn = document.getElementById('dlr-rule-add');
    var input  = document.getElementById('dlr-rule-input');
    function addRule() {
      var v = (input && input.value || '').trim();
      if (!v) return;
      var all = _loadCustomRules();
      all.push(v);
      _saveCustomRules(all);
      renderCardRules();
    }
    if (addBtn) addBtn.addEventListener('click', addRule);
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addRule(); } });

    Array.prototype.forEach.call(container.querySelectorAll('.dlr-rule-del'), function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        if (isNaN(idx)) return;
        var all = _loadCustomRules();
        all.splice(idx, 1);
        _saveCustomRules(all);
        renderCardRules();
      });
    });
  }

  function _escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function init() {
    initDropzone();
    renderFileList();
    renderGenerateSection();
    renderAmbossLoginPanel();
    renderThiemeLoginPanel();
    renderCardRules();
    loadLog();
    loadProposals();
    renderBetaPrototype();

    var uploadBtn = document.getElementById('dlr-upload-btn');
    if (uploadBtn) uploadBtn.addEventListener('click', doUpload);

    // Token-Ablauf sichtbar machen: bei Tab-Fokus Login-Panel neu prüfen
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) { renderAmbossLoginPanel(); renderThiemeLoginPanel(); }
    });
    window.addEventListener('focus', function() { renderAmbossLoginPanel(); renderThiemeLoginPanel(); });
  }

  return {
    init:        init,
    removeFile:  removeFile,
    reload:      loadLog,
    addProposal: function (proposal) {
      try {
        var existing = JSON.parse(localStorage.getItem('dlr_design_proposals') || '[]');
        existing.push(proposal);
        localStorage.setItem('dlr_design_proposals', JSON.stringify(existing));
        loadProposals();
      } catch (e) { /* ignore */ }
    },
  };
})();


