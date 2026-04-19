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

  // ── Ingest ────────────────────────────────────────────────
  function initIngest() {
    var btn    = document.getElementById('med-ingest-btn');
    var status = document.getElementById('med-ingest-status');
    var textEl = document.getElementById('med-ingest-text');
    var typeEl = document.getElementById('med-ingest-type');
    var titleEl = document.getElementById('med-ingest-title');
    var dropzone = document.getElementById('med-dropzone');
    if (!btn) return;

    // Drag & Drop
    if (dropzone) {
      dropzone.addEventListener('dragover', function(e) {
        e.preventDefault();
        dropzone.classList.add('drag-over');
      });
      dropzone.addEventListener('dragleave', function() {
        dropzone.classList.remove('drag-over');
      });
      dropzone.addEventListener('drop', function(e) {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
        var files = e.dataTransfer.files;
        if (!files.length) return;
        var names = Array.from(files).map(function(f) { return f.name; }).join(', ');
        status.innerHTML = '📎 Dateien: <b>' + names + '</b><br><small style="color:var(--text-muted)">Hinweis: Datei-Pfad im Text-Feld eingeben, dann ingestieren.</small>';
        if (textEl && !textEl.value) {
          textEl.value = 'Datei(en): ' + names + '\nBitte analysiere und fasse die wichtigsten Inhalte zusammen.';
        }
        if (titleEl && !titleEl.value) {
          titleEl.value = Array.from(files)[0].name.replace(/\.[^.]+$/, '');
        }
      });
    }

    // Submit
    btn.addEventListener('click', async function() {
      var content = textEl.value.trim();
      if (!content) { status.textContent = 'Kein Text eingegeben.'; return; }
      btn.disabled = true;
      status.textContent = '⏳ Wird ingestiert...';

      var typeLabels = {
        vorlesung:  'Vorlesung/Folie',
        goodnotes:  'GoodNotes PDF',
        notizen:    'Eigene Notizen',
        kommilitone:'Notizen Kommilitone',
        skript:     'Skript',
        paper:      'Paper/Abstract',
        sonstiges:  'Sonstiges'
      };
      var contentType  = typeEl ? typeEl.value : 'notizen';
      var typeLabel    = typeLabels[contentType] || contentType;
      var ingestTitle  = titleEl ? (titleEl.value.trim() || typeLabel) : typeLabel;

      // Save to log first
      try {
        await fetch('/api/medizin/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title:   ingestTitle,
            type:    contentType,
            preview: content.slice(0, 300),
            ts:      new Date().toISOString()
          })
        });
      } catch(e) { /* ignore — continue with task */ }

      var prompt = 'Ingestiere den folgenden Medizin-Inhalt (Typ: ' + typeLabel + ', Titel: ' + ingestTitle + ') in das Medizinstudium-Wissensarchiv.\n\n' +
        'Robin studiert Medizin im klinischen Abschnitt (Semester 8, Uni Ulm, M2/M3-Phase).\n\n' +
        'Aufgabe: Analysiere den Inhalt, extrahiere Kernaussagen, erstelle falls passend Lernpunkte oder Merksätze, ' +
        'und speichere eine strukturierte Zusammenfassung in:\n' +
        'E:\\\\OneDrive\\\\AI\\\\Obsidian-Vault\\\\Jarvis-Brain\\\\Medizin\\\\ (passenden Unterordner anlegen falls nötig)\n\n' +
        'INHALT:\n' + content;

      try {
        var createRes = await fetch('/api/smart-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: 'Medizin-Ingest: ' + typeLabel + ' — ' + ingestTitle,
            prompt: prompt
          })
        });
        var task = await createRes.json();
        if (!task.id) throw new Error('Task-Erstellung fehlgeschlagen');
        await fetch('/api/smart-tasks/' + task.id + '/start', { method: 'POST' });
        status.innerHTML = '✅ Ingest gestartet — <a href="#" onclick="MC.nav&&MC.nav.go&&MC.nav.go(\'smart-tasks\');return false" style="color:var(--accent)">Build-Queue ansehen</a>';
        textEl.value  = '';
        if (titleEl) titleEl.value = '';
        setTimeout(loadLog, 3000);
      } catch(err) {
        status.textContent = '❌ Fehler: ' + err.message;
      }
      btn.disabled = false;
    });
  }

  // ── Anki aus Text (1-Klick) ───────────────────────────────
  function initAnki() {
    var btn    = document.getElementById('med-anki-btn');
    var status = document.getElementById('med-ingest-status');
    var textEl = document.getElementById('med-ingest-text');
    var titleEl= document.getElementById('med-ingest-title');
    var deckEl = document.getElementById('med-anki-deck');
    var typeEl = document.getElementById('med-ingest-type');
    if (!btn) return;

    btn.addEventListener('click', async function() {
      var text = (textEl && textEl.value || '').trim();
      if (!text) { status.textContent = '⚠️ Kein Text im Textfeld.'; return; }
      var deck  = (deckEl && deckEl.value.trim()) || 'Medizin::Sem8::Auto';
      var title = (titleEl && titleEl.value.trim()) || '';
      var ctype = (typeEl && typeEl.value) || 'vorlesung';

      btn.disabled = true;
      status.innerHTML = '🎴 Claude generiert Anki-Karten... <small style="color:var(--text-muted)">(bis 90s, Anki muss laufen)</small>';

      try {
        var res = await fetch('/api/anki/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text,
            deck: deck,
            title: title,
            tags: ['medizin', 'sem8', ctype]
          })
        });
        var data = await res.json();
        if (data.ok) {
          var errInfo = (data.errors && data.errors.length)
            ? ' <small style="color:var(--warn)">(' + data.errors.length + ' Fehler)</small>' : '';
          status.innerHTML = '✅ <b>' + data.created + '</b>/' + data.attempted +
            ' Karten erstellt in Deck <b>' + data.deck + '</b>' + errInfo;
        } else {
          status.innerHTML = '❌ Fehler: ' + (data.error || 'unbekannt') +
            (data.raw ? '<br><small style="color:var(--text-muted)">' + (data.raw||'').replace(/</g,'&lt;').slice(0,200) + '</small>' : '');
        }
      } catch(err) {
        status.textContent = '❌ Netzwerkfehler: ' + err.message;
      }
      btn.disabled = false;
    });
  }

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

    MC.ws.on('chat.new_session', function(d) {
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

  // ── Lernplan-Generator ────────────────────────────────────
  function initLernplan() {
    var previewBtn = document.getElementById('lp-preview-btn');
    var createBtn  = document.getElementById('lp-create-btn');
    var statusEl   = document.getElementById('lp-status');
    var previewEl  = document.getElementById('lp-preview');
    if (!previewBtn || !createBtn) return;

    function collectBody(dryRun) {
      var topic = (document.getElementById('lp-topic') || {}).value || '';
      var exam  = (document.getElementById('lp-exam') || {}).value || '';
      var time  = (document.getElementById('lp-time') || {}).value || '18:00';
      var dur   = parseInt((document.getElementById('lp-duration') || {}).value || '45', 10);
      var cal   = (document.getElementById('lp-calendar') || {}).value || 'Kalender';
      var subs  = (document.getElementById('lp-subtopics') || {}).value || '';
      return {
        topic: topic.trim(),
        exam_date: exam,
        time: time,
        duration: dur,
        calendar: cal.trim() || 'Kalender',
        subtopics: subs.trim(),
        dry_run: !!dryRun,
      };
    }

    function renderPreview(events) {
      if (!events || !events.length) {
        previewEl.style.display = 'none';
        return;
      }
      var lines = [];
      var current = null;
      events.forEach(function(e) {
        var d = new Date(e.date + 'T00:00:00');
        var day = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
        if (day !== current) {
          current = day;
          lines.push('');
          lines.push(day);
          lines.push('—'.repeat(day.length));
        }
        lines.push('  ' + e.time + '  (' + e.duration + 'm)  ' + e.title);
      });
      previewEl.textContent = lines.join('\n').trim();
      previewEl.style.display = 'block';
    }

    async function run(dryRun) {
      var body = collectBody(dryRun);
      if (!body.topic || !body.exam_date) {
        statusEl.innerHTML = '<span style="color:var(--warn,#f59e0b)">⚠️ Thema + Prüfungsdatum erforderlich.</span>';
        return;
      }
      statusEl.innerHTML = dryRun ? '⏳ Plan wird berechnet...' : '⏳ Termine werden in iCloud geschrieben...';
      previewBtn.disabled = true; createBtn.disabled = true;
      try {
        var res = await fetch('/api/medizin/lernplan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var data = await res.json();
        if (!data.ok) {
          statusEl.innerHTML = '<span style="color:var(--warn,#f59e0b)">❌ ' + (data.error || 'Fehler') + '</span>';
        } else if (dryRun) {
          statusEl.innerHTML = '<span style="color:var(--ok,#10b981)">✅ ' + data.count + ' geplante Sessions (Vorschau, noch nicht in Kalender).</span>';
          renderPreview(data.events || []);
        } else {
          statusEl.innerHTML = '<span style="color:var(--ok,#10b981)">✅ ' + data.created + '/' + data.total + ' Events in „' + (body.calendar) + '" angelegt.</span>';
          previewEl.style.display = 'none';
        }
      } catch(err) {
        statusEl.innerHTML = '<span style="color:var(--warn,#f59e0b)">❌ Netzwerkfehler: ' + err.message + '</span>';
      }
      previewBtn.disabled = false; createBtn.disabled = false;
    }

    previewBtn.addEventListener('click', function() { run(true); });
    createBtn.addEventListener('click', function() {
      if (!confirm('Termine jetzt wirklich in iCloud schreiben?')) return;
      run(false);
    });
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    loadLog();
    initIngest();
    initAnki();
    initSearch();
    initChat();
    initLernplan();
  }

  return { init: init, reload: loadLog };
})();
