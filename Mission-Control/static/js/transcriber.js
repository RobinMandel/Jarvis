/* ── Transcriber ────────────────────────────────────────────────── */
(function () {
  'use strict';

  let _currentMode = 'compare';
  let _rawOutput = '';

  // ── Mode selector ──────────────────────────────────────────────
  window.trSetMode = function (btn) {
    document.querySelectorAll('.tr-mode').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _currentMode = btn.dataset.mode;
    const customArea = document.getElementById('tr-custom');
    if (customArea) customArea.style.display = _currentMode === 'custom' ? 'block' : 'none';
  };

  // ── Main run ───────────────────────────────────────────────────
  window.trRun = async function () {
    const url = (document.getElementById('tr-url')?.value || '').trim();
    if (!url) {
      _setStatus('Bitte YouTube-URL eingeben.');
      return;
    }

    const customPrompt = (document.getElementById('tr-custom')?.value || '').trim();
    const runBtn = document.getElementById('tr-run-btn');
    const copyBtn = document.getElementById('tr-copy-btn');

    _setStatus('Läuft…');
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Läuft…'; }
    if (copyBtn) copyBtn.style.display = 'none';
    _hideActions();
    _rawOutput = '';

    // Reset panels
    _setTranscript('<span style="color:var(--text-muted)">Transcript wird geladen…</span>');
    _setOutput('<span style="color:var(--text-muted)">Warte auf Claude…</span>');
    document.getElementById('tr-word-count')?.setAttribute('data-text', '');

    try {
      const resp = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, mode: _currentMode, custom_prompt: customPrompt }),
      });

      if (!resp.ok) {
        const msg = await resp.text();
        _setStatus(`Fehler: ${msg}`);
        _resetBtn();
        return;
      }

      // Read SSE stream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let outputStarted = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line

        let event = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            event = line.slice(7).trim();
          } else if (line.startsWith('data: ') && event) {
            try {
              const data = JSON.parse(line.slice(6));
              _handleEvent(event, data, outputStarted);
              if (event === 'chunk') outputStarted = true;
            } catch (_) {}
            event = null;
          }
        }
      }

      if (copyBtn) copyBtn.style.display = _rawOutput ? 'inline-block' : 'none';
      if (_rawOutput) _showActions();
    } catch (err) {
      _setStatus(`Netzwerkfehler: ${err.message}`);
    }

    _resetBtn();
  };

  function _handleEvent(event, data, outputStarted) {
    switch (event) {
      case 'status':
        _setStatus(data.msg || '');
        break;

      case 'transcript':
        _setTranscript(data.preview || '');
        const wc = document.getElementById('tr-word-count');
        if (wc) wc.textContent = `${(data.words || 0).toLocaleString('de')} Wörter`;
        break;

      case 'chunk': {
        if (!outputStarted) _setOutput('');
        const box = document.getElementById('tr-output-box');
        if (box) {
          _rawOutput += data.text || '';
          box.innerHTML = _renderMarkdown(_rawOutput);
          box.scrollTop = box.scrollHeight;
        }
        break;
      }

      case 'done':
        _setStatus(`Fertig (${(data.chars || 0).toLocaleString('de')} Zeichen)`);
        break;

      case 'error':
        _setStatus(`Fehler: ${data.msg || 'Unbekannt'}`);
        break;
    }
  }

  // ── Accept / Reject recommendation ─────────────────────────────
  window.trAccept = function () {
    if (!_rawOutput) return;
    const url = (document.getElementById('tr-url')?.value || '').trim();
    const prefix = url
      ? `Setz bitte die Empfehlung aus folgender Transcriber-Analyse um (Quelle: ${url}):\n\n---\n\n`
      : `Setz bitte die Empfehlung aus folgender Transcriber-Analyse um:\n\n---\n\n`;
    const payload = prefix + _rawOutput;

    if (window.MC && typeof MC.switchView === 'function') MC.switchView('chat');
    setTimeout(() => {
      const input = document.getElementById('chat-input');
      if (input) {
        input.value = payload;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 320) + 'px';
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 120);

    const label = document.getElementById('tr-actions-label');
    if (label) { label.textContent = '→ An Jarvis weitergeleitet. Im Chat prüfen & Enter drücken.'; label.style.color = '#4ade80'; }
    const accept = document.getElementById('tr-accept-btn');
    const reject = document.getElementById('tr-reject-btn');
    if (accept) accept.disabled = true;
    if (reject) reject.disabled = true;
    if (accept) accept.style.opacity = '0.5';
    if (reject) reject.style.opacity = '0.5';
  };

  window.trReject = function () {
    _hideActions();
    _setStatus('Empfehlung abgelehnt.');
  };

  function _showActions() {
    const bar = document.getElementById('tr-actions');
    const label = document.getElementById('tr-actions-label');
    const accept = document.getElementById('tr-accept-btn');
    const reject = document.getElementById('tr-reject-btn');
    if (bar) bar.style.display = 'flex';
    if (label) { label.textContent = 'Empfehlung umsetzen?'; label.style.color = 'var(--text-muted)'; }
    if (accept) { accept.disabled = false; accept.style.opacity = '1'; }
    if (reject) { reject.disabled = false; reject.style.opacity = '1'; }
  }

  function _hideActions() {
    const bar = document.getElementById('tr-actions');
    if (bar) bar.style.display = 'none';
  }

  // ── Copy ───────────────────────────────────────────────────────
  window.trCopy = function () {
    if (!_rawOutput) return;
    navigator.clipboard.writeText(_rawOutput).catch(() => {});
    const btn = document.getElementById('tr-copy-btn');
    if (btn) { btn.textContent = 'Kopiert ✓'; setTimeout(() => { btn.textContent = 'Kopieren'; }, 1500); }
  };

  // ── Helpers ────────────────────────────────────────────────────
  function _setStatus(msg) {
    const el = document.getElementById('tr-status');
    if (el) el.textContent = msg;
  }

  function _setTranscript(html) {
    const el = document.getElementById('tr-transcript-box');
    if (el) el.innerHTML = html;
  }

  function _setOutput(html) {
    const el = document.getElementById('tr-output-box');
    if (el) el.innerHTML = html;
  }

  function _resetBtn() {
    const btn = document.getElementById('tr-run-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Analysieren'; }
  }

  // Minimal markdown renderer (headers, bold, lists)
  function _renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3 style="margin:12px 0 4px;font-size:13px;color:var(--text-primary)">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="margin:14px 0 4px;font-size:14px;color:var(--text-primary)">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="margin:16px 0 6px;font-size:15px;color:var(--text-primary)">$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:var(--code-inline-bg);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:11px">$1</code>')
      .replace(/^- (.+)$/gm, '<li style="margin:2px 0;padding-left:4px">$1</li>')
      .replace(/^(\d+)\. (.+)$/gm, '<li style="margin:2px 0;padding-left:4px"><strong>$1.</strong> $2</li>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  // ── History ────────────────────────────────────────────────────
  let _historyLoaded = false;

  window.trLoadHistory = async function () {
    const list = document.getElementById('tr-history-list');
    const countEl = document.getElementById('tr-history-count');
    if (!list) return;

    try {
      const resp = await fetch('/api/transcripts');
      if (!resp.ok) return;
      const data = await resp.json();
      const items = data.items || [];

      if (countEl) countEl.textContent = items.length ? `${items.length} gespeichert` : '';

      if (!items.length) {
        list.innerHTML = '<span style="color:var(--text-muted);font-size:12px;">Noch keine Transkriptionen gespeichert.</span>';
        return;
      }

      list.innerHTML = items.map(it => {
        const date = it.date ? new Date(it.date).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const mode = { compare: 'Vergleich', analyze: 'Analyse', summarize: 'Zusammenfassung', custom: 'Custom' }[it.mode] || it.mode || '';
        const words = it.word_count ? `${it.word_count.toLocaleString('de')} Wörter` : '';
        return `<div class="tr-history-item" data-id="${it.id}" style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--bg-elevated);border-radius:6px;cursor:pointer;transition:background 0.15s;" onmouseenter="this.style.background='var(--bg-surface)'" onmouseleave="this.style.background='var(--bg-elevated)'" onclick="window.trLoadHistoryItem('${it.id}','${(it.url||'').replace(/'/g,"\\'")}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-muted)"><rect x="2" y="2" width="20" height="14" rx="2"/><polygon points="10 7 15 10 10 13"/></svg>
          <span style="flex:1;font-size:12px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_escAttr(it.title)}">${_escHtml(it.title || it.video_id || '?')}</span>
          <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${mode}</span>
          <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${words}</span>
          <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${date}</span>
        </div>`;
      }).join('');

      _historyLoaded = true;
    } catch (e) {
      if (list) list.innerHTML = '<span style="color:var(--text-muted);font-size:12px;">Fehler beim Laden.</span>';
    }
  };

  window.trLoadHistoryItem = async function (id, url) {
    // Fill URL and load the output from history
    const urlEl = document.getElementById('tr-url');
    if (urlEl && url) urlEl.value = url;

    try {
      const resp = await fetch('/api/transcripts/' + id);
      if (!resp.ok) return;
      const data = await resp.json();

      if (data.output) {
        _rawOutput = data.output;
        const box = document.getElementById('tr-output-box');
        if (box) box.innerHTML = _renderMarkdown(_rawOutput);
        const copyBtn = document.getElementById('tr-copy-btn');
        if (copyBtn) copyBtn.style.display = 'inline-block';
        _showActions();
      } else {
        _hideActions();
      }
      if (data.transcript_preview) {
        _setTranscript('<span style="white-space:pre-wrap">' + data.transcript_preview.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>');
        const wc = document.getElementById('tr-word-count');
        if (wc) wc.textContent = data.word_count ? `${data.word_count.toLocaleString('de')} Wörter` : '';
      }
      _setStatus('Aus Verlauf geladen');
    } catch (e) {
      _setStatus('Fehler beim Laden');
    }
  };

  window.trToggleHistory = function () {
    const list = document.getElementById('tr-history-list');
    if (!list) return;
    if (!_historyLoaded) window.trLoadHistory();
  };

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function _escAttr(s) {
    return String(s).replace(/"/g,'&quot;');
  }

  // ── Analyst Chat ───────────────────────────────────────────────
  let _chatHistory = [];

  window.trChatSend = async function () {
    const input = document.getElementById('tr-chat-input');
    const message = (input?.value || '').trim();
    if (!message) return;

    if (!_rawOutput) {
      _addChatMsg('system', 'Bitte zuerst ein Video analysieren.');
      return;
    }

    input.value = '';
    input.style.height = '34px';
    _chatHistory.push({ role: 'user', content: message });
    _addChatMsg('user', message);

    const sendBtn = document.getElementById('tr-chat-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }

    const transcript = document.getElementById('tr-transcript-box')?.innerText || '';
    const msgId = Date.now();
    _addChatMsg('assistant', '', msgId);

    let replyText = '';
    try {
      const resp = await fetch('/api/transcribe/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          transcript: transcript.slice(0, 3000),
          analysis: _rawOutput.slice(0, 3000),
          history: _chatHistory.slice(-6),
        }),
      });

      if (!resp.ok) {
        _updateChatMsg(msgId, 'Fehler: ' + await resp.text());
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Senden'; }
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let event = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            event = line.slice(7).trim();
          } else if (line.startsWith('data: ') && event) {
            try {
              const data = JSON.parse(line.slice(6));
              if (event === 'chunk') {
                replyText += data.text || '';
                _updateChatMsg(msgId, replyText);
              }
            } catch (_) {}
            event = null;
          }
        }
      }

      if (replyText) _chatHistory.push({ role: 'assistant', content: replyText });
    } catch (err) {
      _updateChatMsg(msgId, 'Netzwerkfehler: ' + err.message);
    }

    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Senden'; }
  };

  window.trChatClear = function () {
    _chatHistory = [];
    const msgs = document.getElementById('tr-chat-messages');
    if (msgs) msgs.innerHTML = '<span id="tr-chat-placeholder" style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:16px;">Analysiere ein Video — dann kannst du hier Folgefragen stellen.</span>';
  };

  function _addChatMsg(role, text, id) {
    const msgs = document.getElementById('tr-chat-messages');
    if (!msgs) return;
    const placeholder = document.getElementById('tr-chat-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    if (id) div.dataset.msgId = id;

    if (role === 'user') {
      div.style.cssText = 'align-self:flex-end;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.2);border-radius:8px 8px 2px 8px;padding:6px 11px;max-width:85%;font-size:12px;color:var(--text-primary);line-height:1.5;';
    } else if (role === 'system') {
      div.style.cssText = 'align-self:center;font-size:11px;color:var(--text-muted);';
    } else {
      div.style.cssText = 'align-self:flex-start;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:8px 8px 8px 2px;padding:6px 11px;max-width:85%;font-size:12px;color:var(--text-primary);line-height:1.6;';
    }

    div.innerHTML = text ? _renderMarkdown(text) : '<span style="color:var(--text-muted)">…</span>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function _updateChatMsg(id, text) {
    const msgs = document.getElementById('tr-chat-messages');
    if (!msgs) return;
    const div = msgs.querySelector(`[data-msg-id="${id}"]`);
    if (div) {
      div.innerHTML = _renderMarkdown(text);
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  // Auto-load history when view opens
  document.addEventListener('DOMContentLoaded', function () {
    window.trLoadHistory();
  });

  // ── CSS for mode buttons ───────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .tr-mode {
      background: var(--btn-subtle-bg);
      border: 1px solid var(--btn-subtle-border);
      color: var(--text-secondary);
      border-radius: 8px;
      padding: 5px 14px;
      font-size: 12px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.15s;
    }
    .tr-mode:hover {
      background: var(--btn-subtle-hover);
      color: var(--text-primary);
    }
    .tr-mode.active {
      background: rgba(99,102,241,0.15);
      border-color: rgba(99,102,241,0.35);
      color: #818cf8;
    }
  `;
  document.head.appendChild(style);
})();
