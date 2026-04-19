// Knowledge Funnel View
// Drag-Drop ingest + Brain-Chat + Log

(function() {

// ── State ──────────────────────────────────────────────────
var _stagedFiles  = [];      // Files dragged in, not yet submitted
var _chatSession  = null;
var _chatReady    = false;
var _pendingMsg   = null;
var _logItems     = [];
var _searchQuery  = '';

// ── Init (called when view becomes active) ─────────────────
function initFunnel() {
  initDropZone();
  initFileInput();
  initSubmit();
  initChat();
  initSearch();
  loadLog();

  document.getElementById('funnel-refresh-btn')
    .addEventListener('click', loadLog);
}

// ── Drag & Drop ────────────────────────────────────────────
function initDropZone() {
  var zone = document.getElementById('funnel-drop-zone');
  if (!zone || zone._funnelInit) return;
  zone._funnelInit = true;

  ['dragenter', 'dragover'].forEach(function(ev) {
    zone.addEventListener(ev, function(e) {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(function(ev) {
    zone.addEventListener(ev, function() {
      zone.classList.remove('drag-over');
    });
  });
  zone.addEventListener('drop', function(e) {
    e.preventDefault();
    var files = Array.from(e.dataTransfer.files || []);
    files.forEach(stageFile);
  });
}

function initFileInput() {
  var input = document.getElementById('funnel-file-input');
  if (!input) return;
  input.addEventListener('change', function() {
    Array.from(input.files || []).forEach(stageFile);
    input.value = '';
  });
}

function stageFile(file) {
  if (_stagedFiles.find(function(f) { return f.name === file.name && f.size === file.size; })) return;
  _stagedFiles.push(file);
  renderStaged();
}

function renderStaged() {
  var el = document.getElementById('funnel-staged');
  var list = document.getElementById('funnel-staged-list');
  if (!el || !list) return;
  if (!_stagedFiles.length) { el.style.display = 'none'; list.innerHTML = ''; return; }
  el.style.display = '';
  list.innerHTML = _stagedFiles.map(function(f, i) {
    return '<div class="funnel-staged-item">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
      '<span class="funnel-staged-item-name" title="' + f.name + '">' + f.name + '</span>' +
      '<span style="font-size:10px;color:var(--text-muted)">' + _fmtSize(f.size) + '</span>' +
      '<span class="funnel-staged-remove" data-idx="' + i + '" title="Entfernen">✕</span>' +
      '</div>';
  }).join('');
  list.querySelectorAll('.funnel-staged-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.getAttribute('data-idx'));
      _stagedFiles.splice(idx, 1);
      renderStaged();
    });
  });
}

function _fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ── Submit ─────────────────────────────────────────────────
function initSubmit() {
  var btn    = document.getElementById('funnel-submit-btn');
  var status = document.getElementById('funnel-submit-status');
  if (!btn || btn._funnelInit) return;
  btn._funnelInit = true;

  btn.addEventListener('click', async function() {
    var text = (document.getElementById('funnel-text').value || '').trim();
    var tags = (document.getElementById('funnel-tags').value || '').trim();
    var type = document.getElementById('funnel-type').value;

    if (!text && !_stagedFiles.length) {
      status.textContent = 'Nichts eingegeben.';
      return;
    }

    btn.disabled = true;
    status.textContent = '⏳ Wird eingeworfen…';

    try {
      // Upload staged files first
      var fileResults = [];
      for (var i = 0; i < _stagedFiles.length; i++) {
        var file = _stagedFiles[i];
        var fd = new FormData();
        fd.append('file', file);
        var res = await fetch('/api/upload', { method: 'POST', body: fd });
        var data = await res.json();
        if (data.filename) {
          fileResults.push({ filename: data.filename, original: file.name, size: data.size });
        }
      }

      // Build ingest request
      var payload = {
        type: type,
        tags: tags ? tags.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [],
        text: text,
        files: fileResults,
      };

      var ingestRes = await fetch('/api/funnel/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var ingestData = await ingestRes.json();

      if (ingestData.error) throw new Error(ingestData.error);

      status.innerHTML = '✅ Eingeworfen — <a href="#" onclick="if(MC.nav&&MC.nav.go)MC.nav.go(\'tasks\');return false" style="color:#a78bfa">Task läuft</a>';
      document.getElementById('funnel-text').value = '';
      document.getElementById('funnel-tags').value = '';
      _stagedFiles = [];
      renderStaged();
      setTimeout(loadLog, 3000);
    } catch(err) {
      status.textContent = '❌ ' + (err.message || err);
    }
    btn.disabled = false;
  });
}

// ── Log ────────────────────────────────────────────────────
async function loadLog() {
  try {
    var res  = await fetch('/api/funnel/log');
    var data = await res.json();
    _logItems = data.items || [];
    renderLog();
    var countEl = document.getElementById('funnel-log-count');
    if (countEl) countEl.textContent = _logItems.length || '';
  } catch(e) { /* ignore */ }
}

function renderLog() {
  var list = document.getElementById('funnel-log-list');
  if (!list) return;
  var q = _searchQuery.toLowerCase();
  var filtered = q
    ? _logItems.filter(function(it) {
        return (it.title || '').toLowerCase().includes(q) ||
               (it.preview || '').toLowerCase().includes(q) ||
               (it.tags || []).some(function(t) { return t.toLowerCase().includes(q); });
      })
    : _logItems;

  if (!filtered.length) {
    list.innerHTML = '<div class="funnel-log-empty">' +
      (q ? 'Keine Ergebnisse für "' + q + '".' : 'Noch nichts eingeworfen.') +
      '</div>';
    return;
  }

  list.innerHTML = filtered.map(function(it) {
    var typeClass = it.type || 'general';
    var typeLabel = { notes: 'Notiz', paper: 'Paper', data: 'Daten', quote: 'Zitat', general: 'Allg.', file: 'Datei' }[typeClass] || typeClass;
    var tagsHtml = (it.tags || []).length
      ? '<div class="funnel-log-item-tags">' + it.tags.map(function(t) {
          return '<span class="funnel-log-item-tag">#' + t + '</span>';
        }).join('') + '</div>'
      : '';
    return '<div class="funnel-log-item" data-id="' + (it.id || '') + '">' +
      '<div class="funnel-log-item-header">' +
        '<span class="funnel-log-item-type ' + typeClass + '">' + typeLabel + '</span>' +
        '<span class="funnel-log-item-date">' + (it.date || '') + '</span>' +
      '</div>' +
      '<div class="funnel-log-item-title">' + _esc(it.title || 'Kein Titel') + '</div>' +
      (it.preview ? '<div class="funnel-log-item-preview">' + _esc(it.preview) + '</div>' : '') +
      tagsHtml +
      '</div>';
  }).join('');

  // Click to pre-fill chat
  list.querySelectorAll('.funnel-log-item').forEach(function(row) {
    row.addEventListener('click', function() {
      var title = row.querySelector('.funnel-log-item-title');
      if (title) {
        var inp = document.getElementById('funnel-chat-input');
        if (inp) { inp.value = 'Was weißt du über "' + title.textContent + '"?'; inp.focus(); }
      }
    });
  });
}

function initSearch() {
  var inp = document.getElementById('funnel-log-search');
  if (!inp || inp._funnelInit) return;
  inp._funnelInit = true;
  inp.addEventListener('input', function() {
    _searchQuery = inp.value || '';
    renderLog();
  });
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Chat ───────────────────────────────────────────────────
function initChat() {
  var sendBtn = document.getElementById('funnel-chat-send');
  var inputEl = document.getElementById('funnel-chat-input');
  if (!sendBtn || !MC.ws || sendBtn._funnelInit) return;
  sendBtn._funnelInit = true;

  // Token streaming
  MC.ws.on('chat.token', function(d) {
    if (d.session_id !== _chatSession) return;
    var msgs = document.getElementById('funnel-chat-messages');
    if (!msgs) return;
    var el = msgs.querySelector('.thinking-bubble');
    if (!el) {
      el = document.createElement('div');
      el.className = 'funnel-chat-msg assistant thinking-bubble';
      msgs.appendChild(el);
    }
    el.textContent = (el.textContent || '') + (d.token || '');
    msgs.scrollTop = msgs.scrollHeight;
  });

  MC.ws.on('chat.response', function(d) {
    if (d.session_id !== _chatSession) return;
    var msgs = document.getElementById('funnel-chat-messages');
    if (msgs) {
      var el = msgs.querySelector('.thinking-bubble');
      if (el) el.classList.remove('thinking-bubble', 'thinking');
      msgs.scrollTop = msgs.scrollHeight;
    }
    if (sendBtn) sendBtn.disabled = false;
    var badge = document.getElementById('funnel-chat-badge');
    if (badge) badge.style.display = 'none';
  });

  MC.ws.on('chat.new_session', function(d) {
    if (_chatSession) return;
    _chatSession = d.session_id;
    // Tag session as funnel/brain topic
    fetch('/api/sessions/' + _chatSession + '/topic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Brain-Funnel', color: '#8b5cf6' })
    }).catch(function() {});
    // Seed
    MC.ws.send({
      type: 'chat.send',
      session_id: _chatSession,
      message: '[Brain-Funnel init] Du bist im Brain-Funnel-Modus. Zugriff auf alle Wissensbasis-Notes in E:\\OneDrive\\AI\\Obsidian-Vault\\Jarvis-Brain\\Jarvis-Knowledge\\. Antworte kurz auf Deutsch. Bestätige nur kurz.'
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
    _appendMsg('user', msg);
    inputEl.value = '';
    inputEl.style.height = '';

    var msgs = document.getElementById('funnel-chat-messages');
    var thinkEl = document.createElement('div');
    thinkEl.className = 'funnel-chat-msg assistant thinking thinking-bubble';
    thinkEl.textContent = '…';
    msgs.appendChild(thinkEl);
    msgs.scrollTop = msgs.scrollHeight;
    sendBtn.disabled = true;
    var badge = document.getElementById('funnel-chat-badge');
    if (badge) badge.style.display = '';

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
  // Auto-grow textarea
  inputEl.addEventListener('input', function() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
}

function _appendMsg(role, text) {
  var msgs = document.getElementById('funnel-chat-messages');
  if (!msgs) return;
  var welcome = msgs.querySelector('.funnel-chat-welcome');
  if (welcome) welcome.remove();
  var el = document.createElement('div');
  el.className = 'funnel-chat-msg ' + role;
  el.textContent = text;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Register with MC nav ───────────────────────────────────
if (window.MC) {
  var _origNav = MC.nav && MC.nav.go;
  // Hook into view activation
  document.addEventListener('mc:view:funnel', initFunnel);
}

// Export for app.js navigation hook
window.FunnelView = { init: initFunnel };

})();
