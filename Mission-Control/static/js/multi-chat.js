// Multi-Chat — mehrere unabhängige Claude-Sessions gleichzeitig nebeneinander
// Feature-parität mit chat.js: Tools, Stats, Tokens, Time, Voice (STT+TTS), Session-Picker
MC.multiChat = (function() {

  // ── Global State ─────────────────────────────────────────────────────────────
  let panels = [];
  let nextId = 1;
  let pendingQueue = [];      // panelIds waiting for session_created (FIFO)
  let _pendingHistory = [];   // sessions waiting for WS open to send load_history
  let allSessions = [];       // latest list from chat.sessions
  let activeStreams = [];      // session IDs currently streaming on server
  let activePanelId = null;   // currently focused panel

  // Global TTS mutex: only one panel speaks at a time
  let globalTTSAudio = null;
  let globalTTSBusy = false;
  let globalTTSAbort = null;
  let globalActiveMicPanel = null; // panelId currently listening

  // ── Shared Helpers ────────────────────────────────────────────────────────────
  function escHtml(t) {
    if (!t) return '';
    const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
  }

  function renderMd(text) {
    if (!text) return '';
    const blocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<pre><code>${escHtml(code.trim())}</code></pre>`);
      return `%%CB_${blocks.length - 1}%%`;
    });
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/==(.+?)==/g, '<mark>$1</mark>');
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    text = text.replace(/^---+$/gm, '<hr>');
    text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
    text = text.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
    text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/\n{3,}/g, '<br><br>');
    text = text.replace(/\n/g, '<br>');
    blocks.forEach((b, i) => { text = text.replace(`%%CB_${i}%%`, b); });
    return text;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + (s % 60 < 10 ? '0' : '') + (s % 60) + 's';
  }

  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function shortPath(p) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
  }

  function truncate(s, max) {
    if (!s) return '';
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  const THINKING_LABELS = ['thinking', 'brewing', 'cooking', 'crunching', 'pondering', 'crafting', 'conjuring', 'assembling', 'processing'];

  // ── Tool Rendering (mirrors chat.js) ─────────────────────────────────────────
  function toolIcon(tool) {
    switch (tool) {
      case 'Read': return '▸'; case 'Bash': return '$';
      case 'Edit': case 'Write': return '✎'; case 'Grep': return '⌕';
      case 'Glob': return '⌂'; case 'Agent': return '≡';
      case 'Skill': return '✦'; case 'TodoWrite': return '☑';
      case 'WebSearch': case 'WebFetch': return '☁'; default: return '○';
    }
  }

  function toolColor(tool) {
    switch (tool) {
      case 'Read': return '#60a5fa'; case 'Bash': return '#fbbf24';
      case 'Edit': case 'Write': return '#f97316'; case 'Grep': case 'Glob': return '#a78bfa';
      case 'Agent': return '#2dd4bf'; case 'Skill': return '#4ade80';
      case 'TodoWrite': return '#f472b6'; case 'WebSearch': case 'WebFetch': return '#38bdf8';
      default: return '#94a3b8';
    }
  }

  function fmtToolLabel(tool, input) {
    if (!tool) return 'Working...';
    switch (tool) {
      case 'Read':      return 'Reading ' + (input?.file_path ? shortPath(input.file_path) : 'file') + '...';
      case 'Bash':      return '$ ' + (input?.command ? truncate(input.command, 55) : '...');
      case 'Edit':      return 'Editing ' + (input?.file_path ? shortPath(input.file_path) : 'file') + '...';
      case 'Grep':      return 'Searching "' + (input?.pattern ? truncate(input.pattern, 35) : '...') + '"...';
      case 'Write':     return 'Writing ' + (input?.file_path ? shortPath(input.file_path) : 'file') + '...';
      case 'Glob':      return 'Finding ' + (input?.pattern ? truncate(input.pattern, 35) : '...') + '...';
      case 'Agent':     return 'Agent: ' + (input?.description || input?.prompt?.slice(0,45) || 'subagent') + '...';
      case 'Skill':     return 'Skill: ' + (input?.skill || '...') + (input?.args ? ' ' + truncate(input.args, 25) : '');
      case 'TodoWrite': return 'Updating tasks...';
      case 'WebSearch': return 'Search: ' + (input?.query ? truncate(input.query, 45) : '...');
      case 'WebFetch':  return 'Fetch: ' + (input?.url ? truncate(input.url, 45) : '...');
      default:          return 'Using ' + tool + '...';
    }
  }

  function renderToolsHtml(tools) {
    if (!tools || !tools.length) return '';
    const lines = tools.map(t => {
      const cls = t.done ? 'chat-tool-use done' : 'chat-tool-use';
      const icon = toolIcon(t.tool);
      const color = toolColor(t.tool);
      const label = escHtml(fmtToolLabel(t.tool, t.input));
      return `<div class="${cls}"><span class="tool-icon" style="color:${t.done ? '#4ade80' : color}">${icon}</span><span class="tool-label">${label}</span><span class="tool-spinner" style="border-color:${color};border-top-color:transparent"></span><span class="tool-check">✓</span></div>`;
    }).join('');
    return `<div class="chat-tools-block">${lines}</div>`;
  }

  function renderStatsHtml(stats) {
    if (!stats) return '';
    const dur  = stats.duration_ms ? (stats.duration_ms / 1000).toFixed(1) + 's' : '';
    const tIn  = stats.input_tokens  ? fmtTokens(stats.input_tokens) + ' in'  : '';
    const tOut = stats.output_tokens ? fmtTokens(stats.output_tokens) + ' out' : '';
    const cost = stats.cost_usd != null ? '$' + stats.cost_usd.toFixed(4) : '';
    const parts = [dur, tIn, tOut, cost].filter(Boolean);
    if (!parts.length) return '';
    return `<div class="chat-stats">${parts.map(p => `<span>${p}</span>`).join('')}</div>`;
  }

  function renderTopbarStats(panel, stats) {
    const el = panel._statsEl;
    if (!el) return;
    const st = panel.sessionTotals;
    let html = '';
    if (stats?.model) {
      const colors = { haiku: '#22c55e', sonnet: '#3b82f6', opus: '#a855f7' };
      const c = colors[stats.model] || '#6b7280';
      html += `<span class="model-badge" style="color:${c};border-color:${c}40">${stats.model}</span>`;
    }
    const tot = st.input_tokens + st.output_tokens;
    if (tot) html += `<span>${fmtTokens(tot)} tok</span>`;
    if (st.cost_usd) html += `<span>$${st.cost_usd.toFixed(4)}</span>`;
    if (stats?.context_pct != null) {
      const pct = stats.context_pct;
      const c = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#22c55e';
      html += `<span class="ctx-meter" title="Context: ${fmtTokens(stats.context_used||0)} / ${fmtTokens(stats.context_window||0)}"><span class="ctx-bar" style="width:${Math.min(pct,100)}%;background:${c}"></span>${pct}%</span>`;
    }
    el.innerHTML = html;
  }

  // ── Thinking Timer ────────────────────────────────────────────────────────────
  function startThinkingTimer(panel) {
    panel.thinkingStart = Date.now();
    if (panel.thinkingInterval) clearInterval(panel.thinkingInterval);
    panel.thinkingInterval = setInterval(() => updateThinkingDisplay(panel), 200);
  }

  function stopThinkingTimer(panel) {
    if (panel.thinkingInterval) { clearInterval(panel.thinkingInterval); panel.thinkingInterval = null; }
    panel.thinkingStart = null;
  }

  function updateThinkingDisplay(panel) {
    if (!panel.thinkingStart) return;
    const el = panel._messagesEl?.querySelector('.mc-thinking-timer');
    if (!el) return;
    const elapsed = Date.now() - panel.thinkingStart;
    const label = THINKING_LABELS[Math.floor(elapsed / 6000) % THINKING_LABELS.length];
    el.textContent = label + '... ' + fmtDuration(elapsed);
  }

  // ── TTS (global mutex) ────────────────────────────────────────────────────────
  function getTTSRate()   { return parseFloat(localStorage.getItem('mc_tts_rate')   || '1.25'); }
  function getTTSVolume() { return parseFloat(localStorage.getItem('mc_tts_volume') || '0.8'); }

  function cleanForTTS(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' Code-Block. ')
      .replace(/`[^`]+`/g, m => m.slice(1, -1))
      .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,3}\s+/gm, '').replace(/^- /gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').trim();
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('mc-toast-container') || (() => {
      const div = document.createElement('div');
      div.id = 'mc-toast-container';
      div.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; pointer-events: none;';
      document.body.appendChild(div);
      return div;
    })();
    const toast = document.createElement('div');
    toast.className = `mc-toast mc-toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#3b82f6'};
      color: white;
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 8px;
      font-size: 14px;
      animation: slideIn 0.3s ease-out;
      pointer-events: auto;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease-out forwards';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  async function speakForPanel(panel, text) {
    if (!panel.voiceMode || !text) return;
    const clean = cleanForTTS(text);
    if (!clean) return;

    // Wait for global TTS to free up
    let waited = 0;
    while (globalTTSBusy && waited < 30000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
      if (!panel.voiceMode) return;
    }
    if (!panel.voiceMode) return;

    globalTTSBusy = true;
    const ctrl = new AbortController();
    if (globalTTSAbort) globalTTSAbort.abort();
    globalTTSAbort = ctrl;

    updateVoiceBtn(panel);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean }),
        signal: ctrl.signal,
      });
      if (!res.ok) { globalTTSBusy = false; updateVoiceBtn(panel); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      globalTTSAudio = new Audio(url);
      globalTTSAudio.playbackRate = getTTSRate();
      globalTTSAudio.volume = getTTSVolume();
      await new Promise(resolve => {
        globalTTSAudio.onended = () => { URL.revokeObjectURL(url); globalTTSAudio = null; resolve(); };
        globalTTSAudio.onerror = () => { URL.revokeObjectURL(url); globalTTSAudio = null; resolve(); };
        globalTTSAudio.play().catch(resolve);
      });
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[MultiChat] TTS error:', e);
    }
    globalTTSBusy = false;
    globalTTSAbort = null;
    updateVoiceBtn(panel);
    // After TTS ends, restart STT so user can speak again
    if (panel.voiceMode && !panel.isStreaming && !panel.isListening) {
      console.log('[MultiChat] TTS done → restarting STT');
      setTimeout(() => {
        if (panel.voiceMode && !panel.isStreaming && !panel.isListening) startSTT(panel);
      }, 200);
    }
  }

  function stopGlobalTTS() {
    if (globalTTSAudio) { globalTTSAudio.pause(); globalTTSAudio = null; }
    if (globalTTSAbort) { globalTTSAbort.abort(); globalTTSAbort = null; }
    globalTTSBusy = false;
  }

  // ── STT per panel ─────────────────────────────────────────────────────────────
  function initSTT(panel) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'de-DE';
    rec.continuous = true;   // keep running so mic stays active between phrases
    rec.interimResults = true;
    let silenceTimer = null;
    let lastFinal = '';

    rec.onresult = (e) => {
      let newFinal = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) newFinal += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (newFinal) {
        panel._sttBuffer = (panel._sttBuffer ? panel._sttBuffer + ' ' : '') + newFinal.trim();
      }
      // Show accumulated final + current interim in input field
      if (panel._inputEl) {
        panel._inputEl.value = (panel._sttBuffer || '') + (interim ? ' ' + interim : '');
        if (newFinal) panel._inputEl.dispatchEvent(new Event('input'));
        // Auto-grow and scroll to bottom so user always sees latest text
        panel._inputEl.style.height = 'auto';
        panel._inputEl.style.height = Math.min(panel._inputEl.scrollHeight, 200) + 'px';
        panel._inputEl.scrollTop = panel._inputEl.scrollHeight;
      }
      if (silenceTimer) clearTimeout(silenceTimer);
      // 4s silence before auto-send — enough time for natural pauses
      silenceTimer = setTimeout(() => {
        const buf = (panel._sttBuffer || '').trim();
        panel._sttBuffer = '';
        if (buf) { stopSTT(panel); doSend(panel.id); }
        else stopSTT(panel);
      }, 4000);
    };

    rec.onend = () => {
      panel.isListening = false;
      updateMicBtn(panel);
      // In voice mode: if not streaming, restart listening (after TTS)
    };

    rec.onerror = (e) => {
      console.warn('[MultiChat] STT error:', e.error);
      if (e.error === 'no-permission') {
        showToast('Keine Berechtigung für Mikrofon. Check Browser-Einstellungen.', 'error');
      } else if (e.error === 'not-allowed') {
        showToast('Mikrofon nicht erlaubt (Permission denied)', 'error');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[MultiChat] STT error:', e.error);
      }
      panel.isListening = false;
      updateMicBtn(panel);
    };

    panel.recognition = rec;
  }

  function setActivePanel(panelId) {
    activePanelId = panelId;
    panels.forEach(p => {
      if (p.el) p.el.classList.toggle('mc-panel-focused', p.id === panelId);
    });
  }

  function startSTT(panel) {
    // If another panel is listening, stop it first
    if (globalActiveMicPanel && globalActiveMicPanel !== panel.id) {
      const other = panels.find(p => p.id === globalActiveMicPanel);
      if (other) stopSTT(other);
    }
    if (!panel.recognition) initSTT(panel);
    if (!panel.recognition) {
      console.error('[MultiChat] No STT support or initSTT failed');
      showToast('Spracherkemmung nicht verfügbar', 'error');
      return;
    }
    // If TTS is playing in voice mode, don't interrupt it — speakForPanel will restart STT
    if (globalTTSBusy && panel.voiceMode) {
      console.log('[MultiChat] TTS is playing, waiting for it to finish before starting STT');
      return;
    }
    // Only stop TTS when NOT in voice mode (manual mic press while something speaks)
    if (!panel.voiceMode) stopGlobalTTS();
    // Pause voice-listener if it's running (it holds the only STT slot in the browser)
    let listenerWasPaused = false;
    if (MC.voiceListener && MC.voiceListener.pause) {
      MC.voiceListener.pause();
      listenerWasPaused = true;
      console.log('[MultiChat] Paused global voice listener');
    }
    // Give the browser time to fully release the microphone slot
    // voice-listener.pause() stops recognition, but the OS mic resource takes time to release
    // 400-500ms is typically needed for a clean handoff between recognition objects
    const startDelay = listenerWasPaused ? 450 : 50;
    setTimeout(() => {
      if (!panel.voiceMode || panel.isStreaming) {
        console.log('[MultiChat] Voice mode turned off or streaming, skipping STT start');
        return;
      }
      try {
        console.log('[MultiChat] Starting STT for panel', panel.id);
        panel.recognition.start();
        panel.isListening = true;
        globalActiveMicPanel = panel.id;
        updateMicBtn(panel);
        console.log('[MultiChat] STT started successfully');
      } catch (e) {
        console.error('[MultiChat] STT start error (attempt 1):', e.message);
        // Recreate the recognition object and retry once
        panel.recognition = null;
        initSTT(panel);
        if (panel.recognition) {
          try {
            console.log('[MultiChat] Retrying STT after recreation');
            panel.recognition.start();
            panel.isListening = true;
            globalActiveMicPanel = panel.id;
            updateMicBtn(panel);
            console.log('[MultiChat] STT started successfully (retry)');
          } catch (e2) {
            console.error('[MultiChat] STT start error (attempt 2):', e2.message);
            showToast('Mikrofon konnte nicht aktiviert werden: ' + e2.message, 'error');
          }
        }
      }
    }, startDelay);
  }

  function stopSTT(panel) {
    if (!panel.recognition) return;
    console.log('[MultiChat] Stopping STT for panel', panel.id);
    try { panel.recognition.abort(); } catch (e) {
      console.warn('[MultiChat] Error aborting recognition:', e.message);
    }
    panel.isListening = false;
    if (globalActiveMicPanel === panel.id) {
      globalActiveMicPanel = null;
      // Resume global voice listener after mic released
      if (MC.voiceListener && MC.voiceListener.resume) {
        console.log('[MultiChat] Resuming voice listener');
        MC.voiceListener.resume();
      }
    }
    updateMicBtn(panel);
  }

  function toggleSTT(panel) {
    if (panel.isListening) stopSTT(panel);
    else startSTT(panel);
  }

  function toggleVoiceMode(panel) {
    panel.voiceMode = !panel.voiceMode;
    if (panel.voiceMode) {
      // Disable voice on all other panels
      panels.forEach(p => { if (p.id !== panel.id && p.voiceMode) { p.voiceMode = false; updateVoiceBtn(p); } });
      updateVoiceBtn(panel);
      // Start STT immediately (independent of TTS confirmation)
      // Play confirmation async so Robin knows mode is active
      setTimeout(() => { startSTT(panel); }, 100);
      speakForPanel(panel, 'Bereit.');
    } else {
      stopSTT(panel);
      stopGlobalTTS();
      updateVoiceBtn(panel);
    }
  }

  function updateMicBtn(panel) {
    const btn = panel._micBtn;
    if (!btn) return;
    btn.classList.toggle('active', panel.isListening);
    btn.title = panel.isListening ? 'Mikrofon aus' : 'Mikrofon an';
  }

  function updateVoiceBtn(panel) {
    const btn = panel._voiceBtn;
    if (!btn) return;
    btn.classList.toggle('active', panel.voiceMode);
    btn.classList.toggle('speaking', globalTTSBusy && panel.voiceMode);
    btn.title = panel.voiceMode ? 'Voice-Modus aus' : 'Voice-Modus an';
  }

  // ── Session Picker ────────────────────────────────────────────────────────────
  function showSessionPicker(panel) {
    // Remove any existing picker
    document.querySelectorAll('.mc-session-picker').forEach(e => e.remove());

    MC.ws.send({ type: 'chat.list_sessions' });

    const picker = document.createElement('div');
    picker.className = 'mc-session-picker';
    const _mcSort = () => localStorage.getItem('mc_session_sort') || 'topic';
    picker.innerHTML = `<div class="mc-sp-header">
      <span>Session laden</span>
      <div style="display:flex;gap:2px;margin-left:auto;margin-right:6px">
        <button class="sessions-sort-btn${_mcSort()==='topic'?' active':''}" id="mcp-sort-topic" onclick="localStorage.setItem('mc_session_sort','topic');document.getElementById('mcp-sort-topic').classList.add('active');document.getElementById('mcp-sort-recent').classList.remove('active');window._mcPickerResort&&window._mcPickerResort()">Thema</button>
        <button class="sessions-sort-btn${_mcSort()==='recent'?' active':''}" id="mcp-sort-recent" onclick="localStorage.setItem('mc_session_sort','recent');document.getElementById('mcp-sort-recent').classList.add('active');document.getElementById('mcp-sort-topic').classList.remove('active');window._mcPickerResort&&window._mcPickerResort()">Zuletzt</button>
      </div>
      <button class="mc-sp-close">×</button>
    </div><div class="mc-sp-list"><div class="mc-sp-loading">Lade…</div></div>`;

    // Position relative to panel header
    const headerEl = panel.el.querySelector('.mc-panel-header');
    if (headerEl) {
      const rect = headerEl.getBoundingClientRect();
      picker.style.position = 'fixed';
      picker.style.top = (rect.bottom + 4) + 'px';
      picker.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
    }

    document.body.appendChild(picker);

    picker.querySelector('.mc-sp-close').addEventListener('click', () => picker.remove());
    document.addEventListener('click', function closeOnClick(e) {
      if (!picker.contains(e.target) && !panel.el.querySelector('.mc-session-btn')?.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', closeOnClick);
      }
    }, true);

    // One-time handler to populate picker when sessions arrive
    const renderPickerList = (sessions) => {
      const list = picker.querySelector('.mc-sp-list');
      if (!list) return;
      if (!sessions.length) { list.innerHTML = '<div class="mc-sp-empty">Keine Sessions vorhanden</div>'; return; }
      const mode = localStorage.getItem('mc_session_sort') || 'topic';
      let sorted = [...sessions];
      if (mode === 'recent') {
        sorted.sort((a, b) => {
          const ta = a.last_message || a.created_at || '';
          const tb = b.last_message || b.created_at || '';
          return tb.localeCompare(ta);
        });
      } else {
        sorted.sort((a, b) => (a.topic || 'zzz').localeCompare(b.topic || 'zzz'));
      }
      list.innerHTML = sorted.map(s => {
        const label = s.title || s.session_id.slice(0, 12);
        const count = s.message_count ? `${s.message_count} Nachrichten` : '';
        const time = s.last_message ? new Date(s.last_message).toLocaleDateString('de', { day: '2-digit', month: '2-digit' }) : '';
        const active = s.session_id === panel.sessionId ? ' active' : '';
        const dot = s.topic_color ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${s.topic_color};margin-right:5px;flex-shrink:0"></span>` : '';
        const hbAge = s.last_heartbeat ? (Date.now() - new Date(s.last_heartbeat).getTime()) / 1000 : Infinity;
        const liveDot = hbAge < 300 ? `<span title="Zuletzt aktiv: ${Math.round(hbAge)}s" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;margin-left:5px;flex-shrink:0;animation:pulse-dot 1.5s infinite;"></span>` : '';
        return `<div class="mc-sp-item${active}" data-sid="${s.session_id}" style="display:flex;align-items:center">
          ${dot}<div style="flex:1;min-width:0"><div class="mc-sp-item-label" style="display:flex;align-items:center">${escHtml(label)}${liveDot}</div>
          <div class="mc-sp-item-meta">${[count, time].filter(Boolean).join(' · ')}</div></div>
        </div>`;
      }).join('');
      list.addEventListener('click', (e) => {
        const item = e.target.closest('.mc-sp-item');
        if (!item) return;
        picker.remove();
        loadSessionIntoPanel(panel, item.dataset.sid);
      });
    };

    window._mcPickerResort = () => renderPickerList(allSessions);

    const populatePicker = (d) => {
      let raw = d.sessions;
      if (raw && !Array.isArray(raw)) raw = Object.values(raw);
      allSessions = raw || [];
      renderPickerList(allSessions);
    };

    // One-shot handler: populate then remove itself
    const wrappedHandler = (d) => {
      MC.ws.off('chat.sessions', wrappedHandler);
      populatePicker(d);
    };
    MC.ws.on('chat.sessions', wrappedHandler);
    // Safety cleanup after 10s if WS never responds
    setTimeout(() => MC.ws.off('chat.sessions', wrappedHandler), 10000);
  }

  function loadSessionIntoPanel(panel, sessionId) {
    panel.sessionId = sessionId;
    panel.messages = [];
    panel.isStreaming = false;
    panel.sessionTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0, messages: 0 };
    if (panel.el) {
      updatePanelTitle(panel);
      if (panel._statsEl) panel._statsEl.innerHTML = '';
      applyTopicColor(panel);
    }
    renderPanel(panel);
    if (activeStreams.includes(sessionId)) {
      // Session is live-streaming: subscribe_stream sends history + buffered deltas
      // Don't set isStreaming yet — wait for chat.history to arrive first (via _pendingSubscribe flag)
      panel._pendingSubscribe = true;
      MC.ws.send({ type: 'chat.subscribe_stream', session_id: sessionId });
    } else {
      MC.ws.send({ type: 'chat.load_history', session_id: sessionId });
      // activeStreams might be stale — request fresh list so auto-subscribe can kick in if needed
      MC.ws.send({ type: 'chat.list_sessions' });
    }
    savePanelState();
    renderSessionSidebar(); // refresh sidebar highlighting
  }

  // ── Panel DOM ─────────────────────────────────────────────────────────────────
  function createPanelEl(panel) {
    const el = document.createElement('div');
    el.className = 'mc-panel';
    el.dataset.panelId = panel.id;
    el.innerHTML = `
      <div class="mc-panel-header">
        <span class="mc-panel-label" contenteditable="true" spellcheck="false">${escHtml(panel.label)}</span>
        <span class="mc-panel-sid">${panel.sessionId ? panel.sessionId.slice(0,6) : '…'}</span>
        <select class="mc-model-select" title="Modell">
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
          <option value="haiku">Haiku</option>
        </select>
        <button class="mc-icon-btn mc-session-btn" title="Session laden / wechseln">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 7a5 5 0 1 0 10 0A5 5 0 0 0 2 7z" stroke="currentColor" stroke-width="1.5"/><path d="M7 4v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <button class="mc-icon-btn mc-mic-btn" title="Mikrofon an">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="4" y="1" width="6" height="8" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M2 7a5 5 0 0 0 10 0" stroke="currentColor" stroke-width="1.5"/><line x1="7" y1="12" x2="7" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <button class="mc-icon-btn mc-voice-btn" title="Voice-Modus an">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 5.5L7 1.5L11 5.5V9.5L7 13.5L3 9.5V5.5Z" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/></svg>
        </button>
        <button class="mc-close-btn" title="Panel schließen">×</button>
      </div>
      <div class="mc-panel-stats"></div>
      <div class="mc-messages" id="mc-msgs-${panel.id}">
        <div class="mc-empty">Schreib etwas…</div>
      </div>
      <div class="mc-attach-preview"></div>
      <input type="file" class="mc-file-input" multiple accept="image/*,.pdf,.txt,.md,.csv,.json" style="display:none">
      <div class="mc-input-row">
        <button type="button" class="mc-attach-btn" title="Bild/Datei anfügen" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;min-width:30px;border-radius:8px;border:1px solid #444;background:#2a2a2a;color:#aaa;cursor:pointer;flex-shrink:0;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <textarea class="mc-input" placeholder="Nachricht…" rows="1"></textarea>
        <button class="mc-send-btn" disabled>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11V3M7 3L3.5 6.5M7 3l3.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="mc-cancel-btn" style="display:none" title="Abbrechen">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>
        </button>
      </div>`;

    const labelEl    = el.querySelector('.mc-panel-label');
    const messagesEl = el.querySelector('.mc-messages');
    const inputEl    = el.querySelector('.mc-input');
    const sendBtn    = el.querySelector('.mc-send-btn');
    const cancelBtn  = el.querySelector('.mc-cancel-btn');
    const closeBtn   = el.querySelector('.mc-close-btn');
    const modelSel   = el.querySelector('.mc-model-select');
    const statsEl      = el.querySelector('.mc-panel-stats');
    const sessionBtn   = el.querySelector('.mc-session-btn');
    const micBtn       = el.querySelector('.mc-mic-btn');
    const voiceBtn     = el.querySelector('.mc-voice-btn');
    const attachInput  = el.querySelector('.mc-file-input');
    const attachPreview = el.querySelector('.mc-attach-preview');

    // Store refs on panel object
    panel.el              = el;
    panel._messagesEl     = messagesEl;
    panel._inputEl        = inputEl;
    panel._sendBtn        = sendBtn;
    panel._cancelBtn      = cancelBtn;
    panel._statsEl        = statsEl;
    panel._micBtn         = micBtn;
    panel._voiceBtn       = voiceBtn;
    panel._attachInput    = attachInput;
    panel._attachPreviewEl = attachPreview;

    // Label edit
    labelEl.addEventListener('blur', () => { panel.label = labelEl.textContent.trim() || `Panel ${panel.id}`; savePanelState(); });
    labelEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); labelEl.blur(); } });

    // Input auto-resize + send btn state
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      sendBtn.disabled = panel.isStreaming || (!inputEl.value.trim() && !panel.attachments.length);
    });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!panel.isStreaming && (inputEl.value.trim() || panel.attachments.length)) doSend(panel.id);
      }
    });

    // File attachment
    const attachBtn = el.querySelector('.mc-attach-btn');
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
      if (attachInput.files.length) { handleFiles(panel, Array.from(attachInput.files)); attachInput.value = ''; }
    });

    // Paste images into input
    inputEl.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imgs = items.filter(i => i.kind === 'file' && i.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); handleFiles(panel, imgs.map(i => i.getAsFile())); }
    });

    sendBtn.addEventListener('click', () => doSend(panel.id));
    cancelBtn.addEventListener('click', () => doCancel(panel.id));
    closeBtn.addEventListener('click', () => removePanel(panel.id));
    sessionBtn.addEventListener('click', (e) => { e.stopPropagation(); showSessionPicker(panel); });
    micBtn.addEventListener('click', () => { setActivePanel(panel.id); toggleSTT(panel); });
    voiceBtn.addEventListener('click', () => { setActivePanel(panel.id); toggleVoiceMode(panel); });

    // Track active panel on any interaction
    el.addEventListener('focusin', () => setActivePanel(panel.id));
    el.addEventListener('click', () => setActivePanel(panel.id));

    // Model select: send to server when changed
    modelSel.addEventListener('change', () => {
      MC.ws.send({ type: 'chat.set_model', model: modelSel.value, session_id: panel.sessionId });
    });

    // Init STT
    initSTT(panel);

    // Setup drag & drop
    setupPanelDrop(panel);

    return el;
  }

  // ── Message Rendering ─────────────────────────────────────────────────────────
  function renderPanel(panel) {
    const el = panel._messagesEl;
    if (!el) return;
    if (!panel.messages.length) {
      el.innerHTML = '<div class="mc-empty">Schreib etwas…</div>';
      return;
    }
    let html = '';
    for (let i = 0; i < panel.messages.length; i++) {
      const m = panel.messages[i];
      const streaming = i === panel.messages.length - 1 && m.role === 'assistant' && panel.isStreaming;
      const toolsHtml = m.role === 'assistant' ? renderToolsHtml(m.tools) : '';
      const content   = renderMd(m.content || '');
      const time      = fmtTime(m.timestamp);
      const typingHtml = streaming ? `<div class="mc-typing"><div class="mc-thinking"><span></span><span></span><span></span></div><span class="mc-thinking-timer">thinking… 0s</span></div>` : '';
      const statsHtml = (!streaming && m.role === 'assistant' && m.stats) ? renderStatsHtml(m.stats) : '';
      const attachHtml = (m.attachments && m.attachments.length) ? `<div class="mc-msg-attachments">${m.attachments.map(a => {
        if (a.type && a.type.startsWith('image/')) return `<img class="mc-msg-img" src="/api/uploads/${escHtml(a.name)}" alt="${escHtml(a.orig)}" loading="lazy">`;
        return `<span class="mc-msg-file">📄 ${escHtml(a.orig)}</span>`;
      }).join('')}</div>` : '';
      html += `<div class="mc-msg mc-msg-${m.role}">
        ${attachHtml}
        <div class="mc-msg-text">${toolsHtml}${content}${typingHtml}</div>
        ${statsHtml}
        <div class="mc-msg-time">${time}</div>
      </div>`;
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }

  function updateLastMsg(panel) {
    const el = panel._messagesEl;
    if (!el) return;
    const lastMsg = el.querySelector('.mc-msg:last-child');
    if (!lastMsg || !lastMsg.classList.contains('mc-msg-assistant')) return;
    const m = panel.messages[panel.messages.length - 1];
    const toolsHtml = renderToolsHtml(m.tools);
    const content   = renderMd(m.content || '');
    const typingHtml = panel.isStreaming ? `<div class="mc-typing"><div class="mc-thinking"><span></span><span></span><span></span></div><span class="mc-thinking-timer">thinking… 0s</span></div>` : '';
    const textEl = lastMsg.querySelector('.mc-msg-text');
    if (textEl) {
      textEl.innerHTML = toolsHtml + content + typingHtml;
      el.scrollTop = el.scrollHeight;
    }
  }

  // ── Attachment Handling ────────────────────────────────────────────────────────
  async function handleFiles(panel, files) {
    for (const file of files) {
      if (!file) continue;
      const allowed = file.type.startsWith('image/') || file.type === 'application/pdf' ||
                      file.type.startsWith('text/') || /\.(txt|md|csv|json)$/i.test(file.name);
      if (!allowed) { console.warn('mc: file type not allowed', file.type); continue; }
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('upload failed');
        const data = await res.json();
        panel.attachments.push({ name: data.filename, orig: file.name, type: file.type, url: data.url || null });
        renderAttachPreview(panel);
        panel._sendBtn.disabled = panel.isStreaming;
      } catch(e) { console.error('mc attach upload error', e); }
    }
  }

  function renderAttachPreview(panel) {
    const el = panel._attachPreviewEl;
    if (!el) return;
    if (!panel.attachments.length) { el.innerHTML = ''; return; }
    el.innerHTML = panel.attachments.map((a, i) => {
      const isImg = a.type.startsWith('image/');
      const thumb = isImg ? `<img src="/api/uploads/${a.name}" alt="${escHtml(a.orig)}">` :
                            `<span class="mc-att-icon">📄</span>`;
      return `<div class="mc-att-chip" data-idx="${i}">${thumb}<span>${escHtml(a.orig)}</span><button class="mc-att-rm" data-idx="${i}">×</button></div>`;
    }).join('');
    el.querySelectorAll('.mc-att-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        panel.attachments.splice(idx, 1);
        renderAttachPreview(panel);
        panel._sendBtn.disabled = panel.isStreaming || (!panel._inputEl?.value.trim() && !panel.attachments.length);
      });
    });
  }

  // ── Send / Cancel ─────────────────────────────────────────────────────────────
  function doSend(panelId) {
    const panel = panels.find(p => p.id === panelId);
    if (!panel || panel.isStreaming || !panel._inputEl) return;
    const text = panel._inputEl.value.trim();
    const attachments = panel.attachments.map(a => a.name);
    if (!text && !attachments.length) return;

    if (panel.voiceMode && panel.isListening) stopSTT(panel);

    panel._inputEl.value = '';
    panel._inputEl.style.height = 'auto';
    panel._sendBtn.disabled = true;
    panel._cancelBtn.style.display = 'flex';
    panel.isStreaming = true;
    const attachmentSnapshot = [...panel.attachments];
    panel.attachments = [];
    renderAttachPreview(panel);

    panel.messages.push({ role: 'user', content: text || '', attachments: attachmentSnapshot, timestamp: new Date().toISOString() });
    panel.messages.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), tools: [], stats: null, _streaming: true });
    renderPanel(panel);

    MC.ws.send({ type: 'chat.send', session_id: panel.sessionId, message: text || '(siehe Anhang)', attachments });
  }

  function doCancel(panelId) {
    const panel = panels.find(p => p.id === panelId);
    if (!panel) return;
    MC.ws.send({ type: 'chat.cancel', session_id: panel.sessionId });
    finishStreaming(panel);
  }

  function finishStreaming(panel) {
    panel.isStreaming = false;
    stopThinkingTimer(panel);
    if (panel._sendBtn) {
      panel._sendBtn.disabled = !panel._inputEl?.value.trim();
      panel._cancelBtn.style.display = 'none';
    }
    const last = panel.messages[panel.messages.length - 1];
    if (last) delete last._streaming;
    renderPanel(panel);
    // In voice mode: do NOT restart STT here — speakForPanel will restart it after TTS ends
    // If no TTS (voiceMode off), restart immediately
    if (!panel.voiceMode) return;
    // Safety fallback: if TTS doesn't start within 2s, restart STT anyway
    setTimeout(() => {
      if (panel.voiceMode && !panel.isStreaming && !panel.isListening && !globalTTSBusy) {
        console.log('[MultiChat] TTS safety fallback: starting STT');
        startSTT(panel);
      }
    }, 2000);
  }

  // ── Panel Management ──────────────────────────────────────────────────────────
  const MAX_PANELS = 4;

  function addPanel(existingSessionId) {
    if (panels.length >= MAX_PANELS) return;
    const panelId = nextId++;
    const panel = {
      id: panelId,
      sessionId: existingSessionId || null,
      label: `Panel ${panels.length + 1}`,
      messages: [],
      isStreaming: false,
      voiceMode: false,
      isListening: false,
      recognition: null,
      thinkingStart: null,
      thinkingInterval: null,
      sessionTotals: { input_tokens: 0, output_tokens: 0, cost_usd: 0, messages: 0 },
      attachments: [],
      _sttBuffer: '',
      el: null, _messagesEl: null, _inputEl: null, _sendBtn: null,
      _cancelBtn: null, _statsEl: null, _micBtn: null, _voiceBtn: null,
      _attachInput: null, _attachPreviewEl: null,
    };
    panels.push(panel);

    const grid = document.getElementById('mc-grid');
    if (!grid) return;

    // Remove "empty" placeholder
    const empty = grid.querySelector('.mc-empty-grid');
    if (empty) empty.remove();

    const el = createPanelEl(panel);
    grid.appendChild(el);
    updateAddBtn();

    if (!existingSessionId) {
      pendingQueue.push(panelId);
      MC.ws.send({ type: 'chat.new_session' });
    } else {
      el.querySelector('.mc-panel-sid').textContent = existingSessionId.slice(0, 6);
      // Always queue — drained when chat.sessions fires (on WS open or explicit request)
      _pendingHistory.push({ panelId, sessionId: existingSessionId });
    }
    savePanelState();
  }

  function renumberPanels() {
    panels.forEach((p, i) => {
      const num = i + 1;
      // Only rename if label is auto-generated (Panel N / Session N)
      if (/^(Panel|Session)\s+\d+$/.test(p.label)) {
        p.label = `Panel ${num}`;
        const lbl = p.el?.querySelector('.mc-panel-label');
        if (lbl) lbl.textContent = p.label;
      }
    });
  }

  function removePanel(panelId) {
    const idx = panels.findIndex(p => p.id === panelId);
    if (idx === -1) return;
    const panel = panels[idx];
    stopThinkingTimer(panel);
    if (panel.voiceMode) { panel.voiceMode = false; stopSTT(panel); }
    if (panel.el) panel.el.remove();
    panels.splice(idx, 1);
    renumberPanels();
    updateAddBtn();
    savePanelState();
    if (!panels.length) {
      const grid = document.getElementById('mc-grid');
      if (grid) grid.innerHTML = '<div class="mc-empty-grid">Klick "+ Panel" um zu starten.</div>';
    }
  }

  function updateAddBtn() {
    const btn = document.getElementById('mc-add-panel-btn');
    if (btn) btn.disabled = panels.length >= MAX_PANELS;
    const grid = document.getElementById('mc-grid');
    if (grid) grid.dataset.count = panels.length;
  }

  // ── WS Events ─────────────────────────────────────────────────────────────────
  function setupWS() {
    // WS reconnected — silently reload histories for active panels
    MC.ws.on('_ws_reconnect', () => {
      panels.forEach(p => {
        if (p.sessionId && !p.isStreaming) {
          MC.ws.send({ type: 'chat.load_history', session_id: p.sessionId });
        }
      });
    });

    // New session assigned to next waiting panel (FIFO)
    MC.ws.on('chat.session_created', (d) => {
      if (!pendingQueue.length) return;
      const panelId = pendingQueue.shift();
      const panel = panels.find(p => p.id === panelId);
      if (!panel) return;
      panel.sessionId = d.session_id;
      if (panel.el) panel.el.querySelector('.mc-panel-sid').textContent = d.session_id.slice(0, 6);
      savePanelState();
    });

    // Session list — render sidebar + drain pending history loads + refresh panel colors
    MC.ws.on('chat.sessions', (d) => {
      // Server sends sessions as dict {sid: data} — normalize to array
      let sess = d.sessions;
      if (sess && !Array.isArray(sess)) sess = Object.values(sess);
      allSessions = sess || [];
      activeStreams = d.active_streams || [];
      renderSessionSidebar();
      panels.forEach(p => { applyTopicColor(p); updatePanelTitle(p); });
      // Drain history loads (queued before WS open)
      if (_pendingHistory.length) {
        _pendingHistory.splice(0).forEach(({ sessionId }) => {
          MC.ws.send({ type: 'chat.load_history', session_id: sessionId });
        });
      }
      // Auto-subscribe panels that have a running stream
      if (activeStreams.length) {
        panels.forEach(p => {
          if (p.sessionId && activeStreams.includes(p.sessionId) && !p.isStreaming) {
            p.isStreaming = true;
            p.streamBuffer = '';
            // Ensure streaming placeholder exists in panel
            if (!p.messages.length || !p.messages[p.messages.length - 1]._streaming) {
              p.messages.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), tools: [], _streaming: true });
              renderPanel(p);
            }
            MC.ws.send({ type: 'chat.subscribe_stream', session_id: p.sessionId });
          }
        });
      }
    });

    // History loaded for a panel
    MC.ws.on('chat.history', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;

      if (panel._pendingSubscribe) {
        // History arrived from chat.subscribe_stream — load it, then set up streaming state
        delete panel._pendingSubscribe;
        panel.messages = (d.history || []).map(m => ({
          role: m.role,
          content: m.content || '',
          timestamp: m.timestamp || new Date().toISOString(),
          tools: m.tools || [],
        }));
        // Add streaming placeholder for the live response
        panel.messages.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), tools: [], _streaming: true });
        panel.isStreaming = true;
        panel.streamBuffer = '';
        renderPanel(panel);
        applyTopicColor(panel);
        updatePanelTitle(panel);
        startThinkingTimer(panel);
        return;
      }

      if (panel.isStreaming) return;
      if (d.history && d.history.length) {
        panel.messages = d.history.map(m => ({
          role: m.role,
          content: m.content || '',
          timestamp: m.timestamp || new Date().toISOString(),
          tools: m.tools || [],
        }));
        renderPanel(panel);
      }
      applyTopicColor(panel);
      updatePanelTitle(panel);
    });

    // Stream not found (ended between activeStreams check and subscribe) — fall back to load_history
    MC.ws.on('chat.stream_not_found', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel || !panel._pendingSubscribe) return;
      delete panel._pendingSubscribe;
      MC.ws.send({ type: 'chat.load_history', session_id: d.session_id });
    });

    // Chat started on a panel
    MC.ws.on('chat.start', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;
      startThinkingTimer(panel);
      // Narrate in voice mode
      if (panel.voiceMode) speakForPanel(panel, 'Moment.');
    });

    // Streaming text delta
    MC.ws.on('chat.delta', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;
      const last = panel.messages[panel.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content += d.text || '';
        updateLastMsg(panel);
      }
    });

    // Tool use
    MC.ws.on('chat.tool_use', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;
      const last = panel.messages[panel.messages.length - 1];
      if (last && last.role === 'assistant') {
        if (!last.tools) last.tools = [];
        last.tools.push({ tool: d.tool, input: d.input, done: false });
        updateLastMsg(panel);
      }
    });

    // Tool result
    MC.ws.on('chat.tool_result', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;
      const last = panel.messages[panel.messages.length - 1];
      if (last && last.role === 'assistant' && last.tools) {
        for (let i = last.tools.length - 1; i >= 0; i--) {
          if (last.tools[i].tool === d.tool && !last.tools[i].done) {
            last.tools[i].done = true; break;
          }
        }
        updateLastMsg(panel);
      }
    });

    // Done
    MC.ws.on('chat.done', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;
      const last = panel.messages[panel.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content = d.full_text || last.content;
        if (last.tools) last.tools.forEach(t => t.done = true);
        if (d.duration_ms || d.input_tokens || d.cost_usd) {
          last.stats = {
            duration_ms: d.duration_ms, input_tokens: d.input_tokens || 0,
            output_tokens: d.output_tokens || 0, cost_usd: d.cost_usd,
            context_window: d.context_window || 0, context_used: d.context_used || 0,
            context_pct: d.context_pct || 0, model: d.model || '',
          };
          panel.sessionTotals.input_tokens += last.stats.input_tokens;
          panel.sessionTotals.output_tokens += last.stats.output_tokens;
          panel.sessionTotals.cost_usd += (last.stats.cost_usd || 0);
          panel.sessionTotals.messages++;
          renderTopbarStats(panel, last.stats);
        }
      }
      finishStreaming(panel);
      // TTS: speak the response
      if (last && last.role === 'assistant' && last.content && panel.voiceMode) {
        speakForPanel(panel, last.content);
      }
    });

    // Error
    MC.ws.on('chat.error', (d) => {
      if (!d.session_id) return;
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;
      const last = panel.messages[panel.messages.length - 1];
      if (last && last.role === 'assistant' && !last.content) {
        last.content = `⚠️ ${d.error || 'Fehler'}`;
      }
      finishStreaming(panel);
    });

    // Cancelled
    MC.ws.on('chat.cancelled', (d) => {
      const panel = panels.find(p => p.sessionId === d.session_id);
      if (!panel) return;
      finishStreaming(panel);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  // ── Panel Title ───────────────────────────────────────────────────────────
  function updatePanelTitle(panel) {
    if (!panel.el || !panel.sessionId) return;
    const session = allSessions.find(s => s.session_id === panel.sessionId);
    const title = session?.custom_title || session?.title || null;
    const sidEl = panel.el.querySelector('.mc-panel-sid');
    if (sidEl) sidEl.textContent = title ? title : panel.sessionId.slice(0, 6);
    sidEl?.setAttribute('title', panel.sessionId);
  }

  // ── Topic Color ──────────────────────────────────────────────────────────
  function applyTopicColor(panel) {
    if (!panel.el) return;
    const session = allSessions.find(s => s.session_id === panel.sessionId);
    const color = session?.topic_color || null;
    const el = panel.el;
    if (color) {
      el.style.setProperty('--panel-accent', color);
      el.style.setProperty('--panel-accent-subtle', color + '22');
      el.style.setProperty('--panel-accent-mid', color + '55');
    } else {
      el.style.removeProperty('--panel-accent');
      el.style.removeProperty('--panel-accent-subtle');
      el.style.removeProperty('--panel-accent-mid');
    }
    const header = el.querySelector('.mc-panel-header');
    if (header) {
      header.style.borderBottom = color ? `2px solid ${color}` : '';
      header.style.background = color ? `linear-gradient(180deg, ${color}18 0%, transparent 100%)` : '';
    }
  }

  // ── Sessions Sidebar ──────────────────────────────────────────────────────
  let _sidebarSort = localStorage.getItem('mc_session_sort') || 'topic';

  function _syncSidebarSortBtns() {
    const tBtn = document.getElementById('mc-sidebar-sort-topic');
    const rBtn = document.getElementById('mc-sidebar-sort-recent');
    if (tBtn) tBtn.classList.toggle('active', _sidebarSort === 'topic');
    if (rBtn) rBtn.classList.toggle('active', _sidebarSort === 'recent');
  }

  function setSidebarSort(mode) {
    _sidebarSort = mode;
    localStorage.setItem('mc_session_sort', mode);
    _syncSidebarSortBtns();
    renderSessionSidebar();
  }

  function _buildRecentSidebarHtml(sessions) {
    const sorted = [...sessions].sort((a, b) => {
      const ta = a.last_message || a.created_at || '';
      const tb = b.last_message || b.created_at || '';
      return tb.localeCompare(ta);
    });
    return sorted.map(s => {
      const title = escHtml(s.topic || s.custom_title || s.title || s.session_id?.slice(0, 8) || 'Session');
      const color = s.topic_color || 'transparent';
      const time = s.last_message ? new Date(s.last_message).toLocaleDateString('de', { day: '2-digit', month: '2-digit' }) : '';
      const count = s.message_count ? s.message_count + ' msgs' : '';
      const meta = [count, time].filter(Boolean).join(' · ');
      const hbAge = s.last_heartbeat ? (Date.now() - new Date(s.last_heartbeat).getTime()) / 1000 : Infinity;
      const liveDot = hbAge < 300 ? ` <span title="aktiv vor ${Math.round(hbAge)}s" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;animation:pulse-dot 1.5s infinite;vertical-align:middle;"></span>` : '';
      return `<div class="session-item" data-sid="${escHtml(s.session_id)}" style="border-left-color:${color}">
        <div class="session-title" data-sid="${escHtml(s.session_id)}">${title}${liveDot}</div>
        ${meta ? `<div class="session-time">${meta}</div>` : ''}
      </div>`;
    }).join('');
  }

  function renderSessionSidebar() {
    const listEl = document.getElementById('mc-session-list');
    if (!listEl) return;
    _syncSidebarSortBtns();
    if (!allSessions.length) {
      listEl.innerHTML = '<div style="padding:10px 12px;font-size:11px;color:var(--text-faint)">Keine Sessions</div>';
      return;
    }

    if (_sidebarSort === 'recent') {
      listEl.innerHTML = _buildRecentSidebarHtml(allSessions);
    } else if (MC.chat && MC.chat.buildGroupedHtml) {
      listEl.innerHTML = MC.chat.buildGroupedHtml(allSessions, true);
    } else {
      // Fallback: simple list sorted by topic
      const sorted = [...allSessions].sort((a, b) => (a.topic || 'zzz').localeCompare(b.topic || 'zzz'));
      listEl.innerHTML = sorted.map(s => {
        const title = escHtml(s.topic || s.session_id?.slice(0, 8) || 'Session');
        const color = s.topic_color || 'transparent';
        return `<div class="session-item" draggable="true" data-sid="${escHtml(s.session_id)}" style="border-left-color:${color}">
          <div class="session-title">${title}</div>
          <div class="session-time">${s.message_count ?? 0} msgs</div>
        </div>`;
      }).join('');
    }

    // Fix highlighting: remove single-chat 'active' class, apply multi-chat's own
    const activeSids = new Set(panels.map(p => p.sessionId).filter(Boolean));
    listEl.querySelectorAll('.session-item').forEach(item => {
      const sid = item.dataset.sid;
      if (!sid) return;
      // Remove single-chat 'active' class — multi-chat uses its own highlighting
      item.classList.remove('active');
      item.setAttribute('draggable', 'true');
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', sid);
        e.dataTransfer.effectAllowed = 'copy';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));

      if (activeSids.has(sid)) {
        item.classList.add('mc-session-active');
        // Show which panel number
        const panelNums = panels.filter(p => p.sessionId === sid).map(p => panels.indexOf(p) + 1);
        let badge = item.querySelector('.mc-active-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'mc-active-badge';
          item.appendChild(badge);
        }
        badge.textContent = panelNums.map(n => `P${n}`).join(' ');
      }
    });

    // Topic-btn → shared topic menu from chat.js
    listEl.querySelectorAll('.session-topic-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (MC.chat && MC.chat.showTopicMenu) MC.chat.showTopicMenu(btn, btn.dataset.sid);
      });
    });

    // Delete btn
    listEl.querySelectorAll('.session-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        MC.ws.send({ type: 'chat.delete_session', session_id: btn.dataset.sid });
      });
    });

    // Click session → load into active panel, else first free, else first
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.session-item');
      if (!item) return;
      if (e.target.closest('.session-topic-btn,.session-delete')) return;
      const sid = item.dataset.sid;
      if (!sid) return;
      const target = panels.find(p => p.id === activePanelId)
                  || panels.find(p => !p.sessionId)
                  || panels[0];
      if (target) loadSessionIntoPanel(target, sid);
    });

    // Double-click to rename — inline input, no prompt()
    listEl.addEventListener('dblclick', (e) => {
      const titleEl = e.target.closest('.session-title');
      if (!titleEl) return;
      const sid = titleEl.dataset.sid;
      const session = allSessions.find(s => s.session_id === sid);
      if (!session) return;
      const current = session.custom_title || session.title || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'session-rename-input';
      input.value = current;
      titleEl.innerHTML = '';
      titleEl.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        const val = input.value.trim();
        if (val && val !== current) MC.ws.send({ type: 'chat.rename_session', session_id: sid, title: val });
        else renderSessionSidebar();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = current; input.blur(); }
      });
    });
  }

  function setupPanelDrop(panel) {
    const el = panel.el;
    if (!el) return;
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drag-over'); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over'); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const sid = e.dataTransfer.getData('text/plain');
      if (sid) loadSessionIntoPanel(panel, sid);
    });
  }

  // (loadSessionIntoPanel defined above — single source of truth)

  // ── Persistence ────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'mc_multichat_panels';
  let _restoring = false;  // guard: don't save while restoring

  function savePanelState() {
    if (_restoring) return;  // don't save during restore
    try {
      const state = panels.filter(p => p.sessionId).slice(0, MAX_PANELS).map(p => ({
        sessionId: p.sessionId,
        label: p.label,
        model: p.el?.querySelector('.mc-model-select')?.value || 'sonnet',
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch(e) { /* ignore */ }
  }

  function loadPanelState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Sanity: if corrupted (>4 panels or no sessionIds), wipe it
      if (!Array.isArray(parsed) || parsed.length > 4) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return parsed;
    } catch(e) { localStorage.removeItem(STORAGE_KEY); return null; }
  }

  function init() {
    setupWS();

    const addBtn = document.getElementById('mc-add-panel-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (panels.length < MAX_PANELS) addPanel();
      });
    }

    // Sidebar toggle
    const sidebarToggle = document.getElementById('mc-sidebar-toggle');
    const sidebar = document.getElementById('mc-sessions-sidebar');
    if (sidebarToggle && sidebar) {
      const collapsed = localStorage.getItem('mc_sidebar_collapsed') === '1';
      if (collapsed) sidebar.classList.add('collapsed');
      sidebarToggle.addEventListener('click', () => {
        const isNow = sidebar.classList.toggle('collapsed');
        localStorage.setItem('mc_sidebar_collapsed', isNow ? '1' : '0');
      });
    }

    const layoutBtns = document.querySelectorAll('.mc-layout-btn');
    layoutBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset.cols);
        setLayout(n);
        layoutBtns.forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    // Restore panels from last session
    const saved = loadPanelState();
    if (saved && saved.length) {
      _restoring = true;
      // Only restore up to 4, only those with a real sessionId
      const toRestore = saved.filter(s => s.sessionId).slice(0, 4);
      toRestore.forEach(s => addPanel(s.sessionId));
      // Restore model + renumber after DOM is built
      setTimeout(() => {
        panels.forEach((p, i) => {
          if (toRestore[i]?.model) {
            const sel = p.el?.querySelector('.mc-model-select');
            if (sel) sel.value = toRestore[i].model;
          }
        });
        renumberPanels();
        _restoring = false;
        savePanelState();
      }, 150);
      // Set layout buttons
      const n = toRestore.length;
      layoutBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.cols) === n));
      // Retry session list request — covers both "WS already open" and "just opened"
      const retrySessionList = () => MC.ws.send({ type: 'chat.list_sessions' });
      setTimeout(retrySessionList, 300);
      setTimeout(retrySessionList, 1500);
    }
  }

  function setLayout(n) {
    const grid = document.getElementById('mc-grid');
    if (!grid) return;

    // Remove excess panels when reducing layout
    while (panels.length > n) {
      const last = panels[panels.length - 1];
      removePanel(last.id);
    }

    // Add panels if we have fewer than the layout needs
    while (panels.length < n) {
      addPanel();
    }

    // Set grid columns (rows handled by CSS data-count)
    grid.style.gridTemplateColumns = n <= 2
      ? `repeat(${n}, 1fr)`
      : n === 3
        ? 'repeat(3, 1fr)'
        : 'repeat(2, 1fr)';

    // For 4 panels, set 2 rows explicitly
    if (n === 4) {
      grid.style.gridTemplateRows = 'repeat(2, 1fr)';
    } else {
      grid.style.gridTemplateRows = '1fr';
    }
  }

  // Voice routing: Text in den aktiven Panel werfen (nicht in den Hauptchat).
  // Fallback-Reihenfolge: aktiver Panel → erster Panel mit Session → erster Panel überhaupt.
  function sendToActivePanel(text) {
    const msg = (text || '').trim();
    if (!msg) return false;
    const target = panels.find(p => p.id === activePanelId)
                || panels.find(p => p.sessionId && !p.isStreaming)
                || panels.find(p => p.sessionId)
                || panels[0];
    if (!target || !target._inputEl) return false;
    if (target.isStreaming) return false;
    target._inputEl.value = msg;
    setActivePanel(target.id);
    doSend(target.id);
    return true;
  }

  function getActivePanelId() { return activePanelId; }

  return { init, addPanel, removePanel, setSidebarSort, sendToActivePanel, getActivePanelId,
           getStreamingSessions: () => panels.filter(p => p.isStreaming && p.sessionId).map(p => p.sessionId) };
})();
