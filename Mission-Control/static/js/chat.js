// Chat panel — sessions, messaging, voice conversation (STT + TTS)
MC.chat = (function() {
  let activeSession = null;
  let messages = [];
  let isStreaming = false;
  let pendingAttachments = [];
  let pendingTools = [];
  let _activeServerStreams = []; // session IDs currently streaming on server
  let _pendingSubscribeHistory = false; // true when we're expecting chat.history from our own subscribe_stream
  let _ownResubscribe = false;          // true when we sent subscribe_stream ourselves (buffer replay should reset content)
  let _initialHistoryLoaded = false;    // true after first chat.sessions load — prevents repeated load_history on session-list updates
  let _lastMsgStats = null;             // cached for topbar updates

  // ── STT ───────────────────────────────────────────────────────────────────
  let recognition = null;
  let isListening = false;
  let sttSupported = false;
  let silenceTimer = null;
  let finalTranscript = '';
  const SILENCE_TIMEOUT = 2000;

  // ── Voice Conversation Mode ────────────────────────────────────────────────
  let voiceMode = false;

  // ── TTS (ElevenLabs + queue for streaming) ─────────────────────────────────
  let isSpeaking = false;
  let currentAudio = null;
  let ttsAbort = null;
  let ttsQueue = [];
  let ttsQueueActive = false;
  let ttsStreamBuffer = '';

  let _voiceQueue = null;  // queued voice message while session is busy

  let userScrolledUp = false;
  let sessionTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0, messages: 0 };
  let thinkingStartTime = null;
  let thinkingTimerInterval = null;
  const THINKING_LABELS = [
    'thinking', 'brewing', 'cooking', 'crunching', 'pondering',
    'crafting', 'conjuring', 'assembling', 'processing', 'scheming',
  ];

  const STORAGE_KEY = 'mc_chat_state';
  const STORAGE_KEY_SESSIONS = 'mc_sessions_list';
  const STORAGE_KEY_SIDEBAR = 'mc_sidebar_open';

  // --- Provider+Model-Picker Helpers (Chat-Refactor 2026-04-23) ---
  // Value-Encoding im <option>-Tag: "provider||model"
  //   "claude-cli||"        → claude-cli mit Account-Default (Server: model="")
  //   "claude-cli||sonnet"  → claude-cli mit Model "sonnet"
  //   "codex-cli||"         → codex-cli mit ChatGPT-Account-Default
  // Getrennt an den Server senden — kombiniert nur für die Bedienung.

  function _parsePickerValue(raw) {
    const str = String(raw || 'claude-cli||');
    const idx = str.indexOf('||');
    if (idx === -1) return { provider: 'claude-cli', model: str };
    return { provider: str.slice(0, idx), model: str.slice(idx + 2) };
  }

  function _encodePickerValue(provider, model) {
    return (provider || 'claude-cli') + '||' + (model || '');
  }

  // Hart kodierte Modell-Kandidaten pro Provider. /api/llm/providers liefert
  // nur Capability-Flags, nicht die Modell-Liste. Keine Live-Abfrage möglich
  // ohne provider-spezifischen Endpoint — also hier best-effort defaults.
  // "" = "Account-Default" (Provider wählt selbst — nützlich für CLI-Provider).
  // Verifiziert 2026-04-25: codex-cli mit ChatGPT-Login akzeptiert nur `gpt-5.5`
  // oder den Account-Default (""). gpt-5, gpt-5-codex, o3, o4-mini etc. liefern
  // "model not supported when using Codex with a ChatGPT account".
  // gemini-cli: gemini-3.0-pro existiert noch nicht in der API.
  const _MODEL_CANDIDATES = {
    'claude-cli':  ['', 'sonnet', 'opus', 'haiku'],
    'claude-api':  ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    'codex-cli':   ['', 'gpt-5.5'],
    'gemini-cli':  ['', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    'openai':      ['gpt-5.5', 'gpt-5', 'gpt-4o', 'gpt-4o-mini'],
  };

  const _PROVIDER_LABELS = {
    'claude-cli':  'Claude (CLI)',
    'claude-api':  'Claude (API)',
    'codex-cli':   'GPT via Codex (ChatGPT-Login)',
    'gemini-cli':  'Gemini (CLI, Google-Login)',
    'openai':      'OpenAI API',
  };

  // Kurzform für die Inline-Anzeige im geschlossenen Picker.
  // Wichtig: der geschlossene <select> zeigt nur option.textContent — nicht
  // das optgroup.label. Wenn das Option-Label nur "Opus" ist, sieht man nicht
  // welcher Provider aktiv ist. Darum prefixen wir mit kurzem Provider-Token.
  const _PROVIDER_SHORT = {
    'claude-cli':  'Claude',
    'claude-api':  'Claude API',
    'codex-cli':   'Codex',
    'gemini-cli':  'Gemini',
    'openai':      'OpenAI',
  };

  // Lockt den Provider-Picker auf claude-cli wenn die aktive Session eine
  // Jarvis-Orchestrator-Session ist. Sonst: Auswahl frei.
  function _applyPickerLock() {
    const sel = document.getElementById('chat-model-select');
    if (!sel) return;
    const locked = activeSession === 'jarvis-main' || activeSession === 'jarvis-heartbeat';
    if (locked) {
      const want = _encodePickerValue('claude-cli', 'sonnet');
      if (Array.from(sel.options).some(o => o.value === want)) sel.value = want;
      sel.disabled = true;
      sel.title = 'Jarvis laeuft fest auf Claude (CLI) — kein Provider-Wechsel hier.';
    } else {
      sel.disabled = false;
      sel.title = '';
    }
  }

  function _getCurrentProviderModel() {
    // Einzige Wahrheitsquelle für den aktuellen Provider+Model: der Picker.
    // Bei fehlendem Picker → localStorage → Default claude-cli.
    const sel = document.getElementById('chat-model-select');
    if (sel && sel.value) return _parsePickerValue(sel.value);
    const p = localStorage.getItem('mc_chat_provider') || 'claude-cli';
    const m = localStorage.getItem('mc_chat_model') || localStorage.getItem('mc_claude_model') || '';
    return { provider: p, model: m };
  }


  async function _populateProviderPicker(sel) {
    let providers = [];
    try {
      const res = await fetch('/api/llm/providers');
      const data = await res.json();
      providers = Array.isArray(data.providers) ? data.providers : [];
    } catch (e) {
      console.warn('[Chat] /api/llm/providers unreachable — using fallback picker');
      return;
    }
    if (!providers.length) return;

    // Options neu aufbauen pro Provider als optgroup
    sel.innerHTML = '';
    for (const p of providers) {
      const og = document.createElement('optgroup');
      og.label = _PROVIDER_LABELS[p.name] || p.name;
      // Capability-Hints im Label (kompakt)
      const badges = [];
      if (!p.streams_incremental_text) badges.push('⏸ blockweise');
      if (!p.supports_native_tools) badges.push('⚠ keine tools');
      if (badges.length) og.label += ' · ' + badges.join(' · ');

      const models = _MODEL_CANDIDATES[p.name] || [''];
      const shortName = _PROVIDER_SHORT[p.name] || p.name;
      for (const m of models) {
        // Bei requires_model=true ist "" nicht erlaubt — überspringen
        if (!m && p.requires_model) continue;
        const opt = document.createElement('option');
        opt.value = _encodePickerValue(p.name, m);
        // Inline-Label mit Provider-Kurzform damit der geschlossene Picker
        // eindeutig anzeigt, welcher Provider aktiv ist.
        opt.textContent = shortName + ' · ' + (m || 'Auto');
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }

    // Gewünschten Wert setzen (aus pending oder localStorage)
    const pending = window._pendingModelSelection;
    if (pending) {
      const want = _encodePickerValue(pending.provider, pending.model);
      if (Array.from(sel.options).some(o => o.value === want)) {
        sel.value = want;
      } else {
        // Fallback: selben Provider nehmen mit leerem Model, sonst erste Option
        const fbk = _encodePickerValue(pending.provider, '');
        sel.value = Array.from(sel.options).some(o => o.value === fbk) ? fbk : sel.options[0].value;
      }
      window._pendingModelSelection = null;
    }
    console.log('[Chat] provider picker populated:', providers.map(p => p.name).join(', '));
  }

  // ── TTS Rate & Volume ──────────────────────────────────────────────────────
  function getTTSRate() {
    return parseFloat(localStorage.getItem('mc_tts_rate') || '1.25');
  }
  function getTTSVolume() {
    return parseFloat(localStorage.getItem('mc_tts_volume') || '0.8');
  }

  // ── Session Persistence ────────────────────────────────────────────────────
  function saveToStorage() {
    try {
      // Don't save localURL (blob: URLs die on reload) — strip them from attachments
      const safeMessages = messages.slice(-60).map(m => {
        if (!m.attachments) return m;
        return { ...m, attachments: m.attachments.map(a => ({ ...a, localURL: null })) };
      });
      const payload = {
        sessionId: activeSession,
        messages: safeMessages,
        savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      // Also save per-session state for session-switch restoration
      if (activeSession) {
        localStorage.setItem('mc_chat_session_' + activeSession, JSON.stringify(payload));
      }
    } catch (e) { /* quota exceeded — ignore */ }
  }

  function loadSessionMessages(sessionId) {
    // Restore messages from per-session localStorage (for session-switch)
    try {
      const raw = localStorage.getItem('mc_chat_session_' + sessionId);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.savedAt && (Date.now() - data.savedAt) > 86400000) return null;
      return Array.isArray(data.messages) ? data.messages : null;
    } catch (e) { return null; }
  }

  function saveSessionsToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(_sessionList));
    } catch (e) { /* ignore */ }
  }

  function loadFromStorage() {
    try {
      // Restore sessions list (instant render before WS connects)
      const sessionsRaw = localStorage.getItem(STORAGE_KEY_SESSIONS);
      if (sessionsRaw) {
        const savedSessions = JSON.parse(sessionsRaw);
        if (Array.isArray(savedSessions) && savedSessions.length) {
          _sessionList = savedSessions;
          renderSessions(_sessionList);
        }
      }
      // Restore provider+model selection (Chat-Refactor 2026-04-23).
      // Getrennt persistiert: mc_chat_provider + mc_chat_model. Legacy-Key
      // mc_claude_model wird als model-fallback genutzt wenn kein provider gespeichert ist.
      const savedProvider = localStorage.getItem('mc_chat_provider');
      const savedModel = localStorage.getItem('mc_chat_model') || localStorage.getItem('mc_claude_model') || '';
      // Picker-Befüllung erfolgt async via /api/llm/providers — Wert-Setzung wartet,
      // bis Picker populated ist. _pendingModelSelection merkt sich den Wunsch.
      window._pendingModelSelection = { provider: savedProvider || 'claude-cli', model: savedModel };
      // Restore sidebar state
      const sidebarOpen = localStorage.getItem(STORAGE_KEY_SIDEBAR);
      const layout = document.querySelector('.chat-layout');
      if (layout && sidebarOpen === '0') layout.classList.add('sessions-collapsed');
      _updateSidebarToggleBtn();
    } catch (e) { console.error('[Chat] loadFromStorage sessions error:', e); }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      console.log('[Chat] loadFromStorage: raw length =', raw ? raw.length : 0);
      if (!raw) return;
      const data = JSON.parse(raw);
      // Discard if older than 24h
      if (data.savedAt && (Date.now() - data.savedAt) > 86400000) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      if (data.sessionId) activeSession = data.sessionId;
      if (Array.isArray(data.messages) && data.messages.length) {
        messages = data.messages;
        // Fix stale streaming state — if last message was mid-stream, mark it as done
        const last = messages[messages.length - 1];
        if (last && last._streaming) {
          delete last._streaming;
          if (last.tools) last.tools.forEach(t => t.done = true);
          if (!last.content) {
            messages.pop(); // empty — remove
          }
          // cli_session_id is preserved across restarts, so no auto-continuation needed
        }
        console.log('[Chat] Restored', messages.length, 'messages from localStorage');
        isStreaming = false;
        renderMessages();
        updateSessionBadge();
        // Rebuild session totals + restore last stats to topbar
        sessionTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0, messages: 0 };
        let lastStats = null;
        for (const m of messages) {
          if (m.stats) {
            sessionTotals.input_tokens += m.stats.input_tokens || 0;
            sessionTotals.output_tokens += m.stats.output_tokens || 0;
            sessionTotals.cost_usd += m.stats.cost_usd || 0;
            sessionTotals.messages++;
            lastStats = m.stats;
          }
        }
        if (lastStats) updateTopbarStats(lastStats);
      }
    } catch (e) { console.error('[Chat] loadFromStorage error:', e); }
  }

  // ── Sidebar Toggle ─────────────────────────────────────────────────────────
  function _updateSidebarToggleBtn() {
    const layout = document.querySelector('.chat-layout');
    const btn = document.getElementById('btn-sidebar-toggle');
    if (!btn) return;
    const hasSessions = layout && layout.classList.contains('has-sessions');
    const collapsed = layout && layout.classList.contains('sessions-collapsed');
    btn.style.display = hasSessions ? 'flex' : 'none';
    btn.title = collapsed ? 'Sessions anzeigen' : 'Sessions ausblenden';
    // Active state when open
    btn.style.color = (!collapsed && hasSessions) ? 'var(--text-primary)' : 'var(--text-muted)';
  }

  function toggleSidebar() {
    const layout = document.querySelector('.chat-layout');
    if (!layout) return;
    const isCollapsed = layout.classList.toggle('sessions-collapsed');
    localStorage.setItem(STORAGE_KEY_SIDEBAR, isCollapsed ? '0' : '1');
    _updateSidebarToggleBtn();
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  let _initialized = false;

  function init() {
    // Guard gegen Doppel-Aufruf — sonst doppeln sich MC.ws.on()-Handler
    // (z.B. chat.system → zwei System-Messages pro Event).
    if (_initialized) {
      console.log('[Chat] init() bereits gelaufen, skip');
      return;
    }
    _initialized = true;

    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send');
    const cancelBtn = document.getElementById('btn-cancel');
    const newBtn = document.getElementById('btn-new-session');
    const fileInput = document.getElementById('chat-file-input');
    const voiceBtn = document.getElementById('btn-voice');
    const voiceModeBtn = document.getElementById('btn-tts-toggle');
    const messagesEl = document.getElementById('chat-messages');
    const voiceSelect = document.getElementById('chat-voice-select');
    const rateSlider = document.getElementById('tts-rate-slider');
    const rateLabel = document.getElementById('tts-rate-label');
    const volumeSlider = document.getElementById('tts-volume-slider');
    const volumeLabel = document.getElementById('tts-volume-label');

    // Restore persisted session + sessions list + sidebar state
    loadFromStorage();

    // Sidebar toggle button
    const sidebarToggleBtn = document.getElementById('btn-sidebar-toggle');
    if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', toggleSidebar);

    // Provider+Model-Picker: dynamisch aus /api/llm/providers befüllen
    // und bei Change getrennte provider/model-Keys persistieren.
    const modelSelectEl = document.getElementById('chat-model-select');
    if (modelSelectEl) {
      _populateProviderPicker(modelSelectEl)
        .then(() => _applyPickerLock())
        .catch(e => console.warn('[Chat] provider picker:', e));
      modelSelectEl.addEventListener('change', () => {
        const parsed = _parsePickerValue(modelSelectEl.value);
        localStorage.setItem('mc_chat_provider', parsed.provider);
        localStorage.setItem('mc_chat_model', parsed.model);
        // Legacy-Key aktuell halten für alte Code-Pfade
        localStorage.setItem('mc_claude_model', parsed.model);
        console.log('[Chat] picker change →', parsed);
      });
    }

    // chat.system → Als System-Message im Chat anzeigen (Provider-Switch-Hinweise etc.)
    if (window.MC && MC.ws) {
      MC.ws.on('chat.system', (d) => {
        if (!d.message) return;
        messages.push({
          role: 'system',
          content: d.message,
          timestamp: new Date().toISOString(),
          _system: true,
        });
        renderMessages();
        saveToStorage();
      });

      // chat.image_generated → Bot oder Button hat ein Bild erzeugt und in die
      // Session-History gepusht. Wir refreshen die History vom Server damit die
      // neue Bild-Message inline im Chat erscheint.
      // chat.compressed → Session wurde komprimiert, History neu laden
      MC.ws.on('chat.compressed', (d) => {
        if (!d.session_id || d.session_id !== activeSession) return;
        // Reset local state and reload from server
        messages = [];
        sessionTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0, messages: 0 };
        _lastMsgStats = null;
        try { localStorage.removeItem('mc_chat_session_' + activeSession); } catch (_) {}
        // Show the summary as seed message
        if (d.summary) {
          messages.push({
            role: 'assistant',
            content: d.summary,
            timestamp: new Date().toISOformat ? new Date().toISOString() : '',
            _compressed: true,
          });
        }
        renderMessages();
        updateTopbarStats(null, true);
      });

      MC.ws.on('chat.image_generated', (d) => {
        if (!d.session_id || d.session_id !== activeSession) return;
        // Direkt als Assistant-Message mit Bild-Markdown einfügen — server hat
        // das bereits in history gepusht, aber wir wollen es sofort sichtbar.
        const url = d.url;
        const prompt = d.prompt || '';
        const md = `![${prompt.slice(0, 80)}](${url})\n\n*Generiert via ${d.provider}${d.model ? ' (' + d.model + ')' : ''}*`;
        // Nur pushen wenn Message nicht schon da ist (Dedup via URL)
        const exists = messages.some(m => (m.content || '').includes(url));
        if (!exists) {
          messages.push({
            role: 'assistant',
            content: md,
            timestamp: new Date().toISOString(),
            _image_url: url,
          });
          renderMessages();
          saveToStorage();
        }
      });
    }

    // Safety net: save before page unloads (reload, tab close, navigation)
    window.addEventListener('beforeunload', () => {
      if (messages.length) saveToStorage();
    });

    // ── Smart Scroll: detect if user scrolled up ──────────────────────────
    const scrollFab = document.getElementById('btn-scroll-bottom');
    messagesEl.addEventListener('scroll', () => {
      const threshold = 120;
      const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
      userScrolledUp = !atBottom;
      if (scrollFab) scrollFab.classList.toggle('visible', userScrolledUp && messages.length > 0);
    });
    if (scrollFab) {
      scrollFab.addEventListener('click', () => {
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
        userScrolledUp = false;
        scrollFab.classList.remove('visible');
      });
    }
    // End-key shortcut to jump to bottom
    document.addEventListener('keydown', (e) => {
      if (e.key === 'End' && document.getElementById('view-chat')?.style.display !== 'none') {
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
        userScrolledUp = false;
        if (scrollFab) scrollFab.classList.remove('visible');
      }
    });

    // Init rate slider from localStorage
    if (rateSlider) {
      rateSlider.value = getTTSRate();
      if (rateLabel) rateLabel.textContent = getTTSRate().toFixed(2).replace(/\.?0+$/, '') + '×';
      rateSlider.addEventListener('input', () => {
        const v = parseFloat(rateSlider.value);
        localStorage.setItem('mc_tts_rate', v);
        if (rateLabel) rateLabel.textContent = v.toFixed(2).replace(/\.?0+$/, '') + '×';
        if (currentAudio) currentAudio.playbackRate = v;
      });
    }

    // Init volume slider from localStorage
    if (volumeSlider) {
      volumeSlider.value = getTTSVolume();
      if (volumeLabel) volumeLabel.textContent = Math.round(getTTSVolume() * 100) + '%';
      volumeSlider.addEventListener('input', () => {
        const v = parseFloat(volumeSlider.value);
        localStorage.setItem('mc_tts_volume', v);
        if (volumeLabel) volumeLabel.textContent = Math.round(v * 100) + '%';
        if (currentAudio) currentAudio.volume = v;
      });
    }

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      updateSendButton();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isStreaming && (input.value.trim() || pendingAttachments.length)) sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);
    cancelBtn.addEventListener('click', cancelMessage);
    newBtn.addEventListener('click', newSession);

    // Mobile Session Drawer
    const sessBtn = document.getElementById('btn-sessions-drawer');
    const sessDrawer = document.getElementById('session-drawer');
    const sessBackdrop = document.getElementById('session-drawer-backdrop');
    if (sessBtn && sessDrawer) {
      sessBtn.addEventListener('click', () => {
        renderSessionDrawer(_sessionList);
        sessDrawer.classList.add('open');
      });
    }
    if (sessBackdrop) sessBackdrop.addEventListener('click', () => sessDrawer.classList.remove('open'));

    fileInput.addEventListener('change', () => {
      handleFiles(Array.from(fileInput.files));
      fileInput.value = '';
    });

    initSTT();
    voiceBtn.addEventListener('click', toggleSTT);
    voiceModeBtn.addEventListener('click', toggleVoiceMode);

    if (voiceSelect) {
      voiceSelect.addEventListener('change', () => {
        const voiceId = voiceSelect.value;
        fetch('/api/tts/voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice_id: voiceId })
        }).catch(e => console.error('Voice switch error:', e));
      });
    }

    // Drag & Drop
    messagesEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      messagesEl.classList.add('chat-drag-active');
    });
    messagesEl.addEventListener('dragleave', (e) => {
      if (!messagesEl.contains(e.relatedTarget)) messagesEl.classList.remove('chat-drag-active');
    });
    messagesEl.addEventListener('drop', (e) => {
      e.preventDefault();
      messagesEl.classList.remove('chat-drag-active');
      if (e.dataTransfer.files.length) handleFiles(Array.from(e.dataTransfer.files));
    });

    // Paste support
    const pasteHandler = (e) => {
      const files = Array.from(e.clipboardData?.items || [])
        .filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); handleFiles(files); }
    };
    input.addEventListener('paste', pasteHandler);
    messagesEl.addEventListener('paste', pasteHandler);

    // ── WebSocket handlers ────────────────────────────────────────────────
    // Emergency save on WS disconnect (server crash mid-stream)
    MC.ws.on('_ws_close', () => {
      if (isStreaming) {
        stopAutoSave();
        isStreaming = false;
        stopThinkingTimer();
        pendingTools = [];
        ttsStreamBuffer = '';
        updateButtons();
        saveToStorage();
        console.log('[Chat] Emergency save on WS close —', messages.length, 'messages saved');
      }
    });

    // Safety: reset stuck streaming state on reconnect
    MC.ws.on('_ws_reconnect', () => {
      console.warn('[Chat] WS reconnected — refreshing session state');
      // Clear all streaming state — server will send authoritative active_streams in chat.sessions
      _activeServerStreams = [];
      _sessionReadyIndicators.clear();
      if (isStreaming) {
        isStreaming = false;
        stopThinkingTimer();
        stopAutoSave();
        pendingTools = [];
        ttsStreamBuffer = '';
        updateButtons();
        // Clean up streaming placeholder if empty
        const last = messages[messages.length - 1];
        if (last && last._streaming && !last.content) messages.pop();
        renderMessages();
      }
      // Re-fetch session list and history after reconnect
      _initialHistoryLoaded = false;  // allow load_history on next chat.sessions
      MC.ws.send({ type: 'chat.list_sessions' });
    });

    // Server-restart auto-continuation: send nudge automatically after short delay
    MC.ws.on('_ws_server_restarted', () => {
      if (document.getElementById('restart-nudge-sent')) return; // don't send twice
      const sentinel = document.createElement('div');
      sentinel.id = 'restart-nudge-sent';
      sentinel.style.display = 'none';
      document.body.appendChild(sentinel);

      // Wait 1.5s for session list to load, then auto-send continuation prompt
      // But only if session was active within the last 5 minutes
      setTimeout(() => {
        const REVIVAL_TIMEOUT_MS = 5 * 60 * 1000;
        const lastMsg = messages[messages.length - 1];
        const lastTs = lastMsg && lastMsg.timestamp ? new Date(lastMsg.timestamp).getTime() : 0;
        const age = Date.now() - lastTs;
        if (!activeSession || age > REVIVAL_TIMEOUT_MS) {
          console.log('[Chat] Server restart — skipping auto-continuation (session silent for', Math.round(age / 1000), 's)');
          return;
        }
        const msg = 'Server wurde gerade neu gestartet. Bitte fasse kurz zusammen womit du zuletzt beschäftigt warst und führe den Task zu Ende, falls noch offen.';
        appendMessage({ role: 'user', content: msg });
        const pm = _getCurrentProviderModel();
        MC.ws.send({ type: 'chat.send', session_id: activeSession, message: msg,
                     provider: pm.provider, model: pm.model });
      }, 1500);
    });

    MC.ws.on('chat.session_created', (d) => {
      activeSession = d.session_id;
      _newSessionId = d.session_id;
      updateSessionBadge();
      saveToStorage();
      MC.ws.send({ type: 'chat.list_sessions' });
    });

    MC.ws.on('chat.sessions', (d) => {
      // Server sends sessions as dict {sid: data} — normalize to array
      let sessionArr = d.sessions;
      if (sessionArr && !Array.isArray(sessionArr)) {
        sessionArr = Object.values(sessionArr);
      }
      _activeServerStreams = d.active_streams || [];
      // Extract topic colors from session data
      (sessionArr || []).forEach(s => { if (s.topic && s.topic_color) _topicColors[s.topic] = s.topic_color; });
      renderSessions(sessionArr);
      // Auto-subscribe if our active session has a running stream (e.g. after reload/reconnect)
      const activeRunning = activeSession && d.active_streams && d.active_streams.includes(activeSession);
      if (activeRunning && !isStreaming) {
        console.log('[Chat] Active stream detected for session', activeSession.slice(0,8), '— subscribing');
        isStreaming = true;
        _pendingSubscribeHistory = true;
        _ownResubscribe = true;
        pendingTools = [];
        ttsStreamBuffer = '';
        startThinkingTimer();
        // Ensure streaming message placeholder exists
        if (!messages.length || !messages[messages.length - 1]._streaming) {
          messages.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), tools: [], stats: null, _streaming: true });
          updateButtons();
          renderMessages();
        }
        MC.ws.send({ type: 'chat.subscribe_stream', session_id: activeSession });
      } else if (activeSession && !activeRunning && (isStreaming || (messages.length && messages[messages.length-1]._streaming))) {
        // Server sagt: keine aktive Stream fuer uns. Frontend zeigt aber noch
        // einen Spinner — passiert nach Server-Neustart wenn wir den Stuck-Stream
        // weggepatcht haben. UI sauber zuruecksetzen + History neu laden.
        console.log('[Chat] Stale streaming UI for', activeSession.slice(0,8), '— clearing');
        isStreaming = false;
        stopThinkingTimer();
        pendingTools = [];
        // Streaming-Platzhalter raus
        if (messages.length && messages[messages.length-1]._streaming) {
          messages.pop();
        }
        updateButtons();
        renderMessages();
        _initialHistoryLoaded = true;
        MC.ws.send({ type: 'chat.load_history', session_id: activeSession });
      } else if (activeSession && !_initialHistoryLoaded) {
        // First load after page reload or reconnect — sync with server once
        _initialHistoryLoaded = true;
        MC.ws.send({ type: 'chat.load_history', session_id: activeSession });
      }
      // cli_session_id is preserved — no auto-continuation on reload/restart
    });

    MC.ws.on('chat.topics', (d) => {
      if (d.colors) _topicColors = d.colors;
    });

    MC.ws.on('chat.topic_classified', (d) => {
      console.log('[Chat] Topic classified:', d.session_id?.slice(0,8), '→', d.topic);
      _updateActiveTopicColor();
      // Update session in local list so sidebar reflects the new topic immediately
      const s = _sessionList.find(x => x.session_id === d.session_id);
      if (s) {
        s.topic = d.topic;
        s.topic_color = d.color;
        if (d.title) s.title = d.title;
        if (d.title) s.auto_title = d.title;
        if (d.topic) _topicColors[d.topic] = d.color;
        renderSessions(_sessionList);
      }
    });

    let _classifyAllTimer = null;
    function _stopClassifySpinner() {
      const btn = document.getElementById('btn-classify-all');
      if (btn) { btn.classList.remove('spinning'); btn.title = 'Alle Sessions neu klassifizieren'; }
      if (_classifyAllTimer) { clearTimeout(_classifyAllTimer); _classifyAllTimer = null; }
    }

    MC.ws.on('chat.classify_all_started', (d) => {
      const btn = document.getElementById('btn-classify-all');
      if (btn) { btn.classList.add('spinning'); btn.title = `Klassifiziere ${d.count} Sessions…`; }
      // Fallback: stop after 90s no matter what
      if (_classifyAllTimer) clearTimeout(_classifyAllTimer);
      _classifyAllTimer = setTimeout(_stopClassifySpinner, 90000);
    });

    MC.ws.on('chat.classify_all_progress', (d) => {
      const btn = document.getElementById('btn-classify-all');
      if (btn) btn.title = `${d.done}/${d.total} klassifiziert…`;
    });

    MC.ws.on('chat.classify_all_done', () => { _stopClassifySpinner(); });

    MC.ws.on('chat.history', (d) => {
      if (d.session_id === activeSession) {
        // Ignore stray history events while streaming (e.g. from multichat subscribe_stream on same session)
        // Exception: we're expecting it because we just sent our own subscribe_stream
        if (isStreaming && !_pendingSubscribeHistory) return;
        _pendingSubscribeHistory = false;
        const serverHistory = d.history || [];
        // Don't downgrade: if client has more messages than server (e.g. server hasn't persisted yet),
        // keep the client state which includes the streamed response
        if (messages.length > serverHistory.length && messages.length > 0) {
          console.log('[Chat] Skipping history downgrade:', messages.length, '>', serverHistory.length);
          return;
        }
        messages = serverHistory.map(m => ({ ...m, timestamp: new Date().toISOString(), tools: [], stats: null }));
        renderMessages();
      }
    });

    MC.ws.on('chat.start', (d) => {
      // Track all active streams for sidebar indicator
      if (d.session_id && !_activeServerStreams.includes(d.session_id)) {
        _activeServerStreams.push(d.session_id);
        if (d.session_id !== activeSession) { renderSessions(_sessionList); return; }
      }
      if (d.session_id && d.session_id !== activeSession) return; // ignore other sessions
      isStreaming = true;
      resetStuckTimer();
      pendingTools = [];
      ttsStreamBuffer = '';
      startThinkingTimer();
      // Only add placeholder if not already there (e.g. from subscribe_stream replay)
      const last = messages[messages.length - 1];
      if (!last || !last._streaming) {
        messages.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), tools: [], stats: null, _streaming: true });
      } else if (last._streaming && _ownResubscribe) {
        // Reset content for our own subscribe_stream replay — buffer replays ALL deltas from start,
        // so we must clear cached content to avoid duplication.
        // Do NOT reset if this chat.start came from multichat's buffer replay (same WS, different module).
        last.content = '';
        last.tools = [];
        _ownResubscribe = false;
      }
      updateButtons();
      renderMessages();
      if (voiceMode && !isSpeaking && !ttsQueueActive) {
        enqueueTTS('Moment.');
      }
    });

    // Periodic auto-save every 5s during streaming
    let _autoSaveTimer = null;
    function startAutoSave() {
      if (_autoSaveTimer) return;
      _autoSaveTimer = setInterval(saveToStorage, 5000);
    }
    function stopAutoSave() {
      if (_autoSaveTimer) { clearInterval(_autoSaveTimer); _autoSaveTimer = null; }
    }

    // ── Stuck detection: if no delta/tool_use for 240s during streaming, show unstick button ──
    let _lastActivityTime = 0;
    let _stuckCheckTimer = null;
    function resetStuckTimer() {
      _lastActivityTime = Date.now();
      // Remove any existing stuck banner
      const banner = document.getElementById('chat-stuck-banner');
      if (banner) banner.remove();
      if (_stuckCheckTimer) clearInterval(_stuckCheckTimer);
      if (isStreaming) {
        _stuckCheckTimer = setInterval(() => {
          if (!isStreaming) { clearInterval(_stuckCheckTimer); _stuckCheckTimer = null; return; }
          if (Date.now() - _lastActivityTime > 240000) {
            clearInterval(_stuckCheckTimer); _stuckCheckTimer = null;
            showStuckBanner();
          }
        }, 10000);
      }
    }
    function showStuckBanner() {
      if (document.getElementById('chat-stuck-banner')) return;
      const container = document.getElementById('chat-messages');
      if (!container) return;
      const banner = document.createElement('div');
      banner.id = 'chat-stuck-banner';
      banner.style.cssText = 'padding:10px 16px;margin:8px 0;background:rgba(255,160,0,0.15);border:1px solid rgba(255,160,0,0.4);border-radius:8px;display:flex;align-items:center;gap:12px;color:#ffa000;font-size:13px;';
      banner.innerHTML = `<span>Session scheint zu hängen (keine Aktivität seit 4 Min) — komplexe Tasks brauchen bis zu 5 Min</span><button onclick="MC.chat.cancelStream()" style="background:#ff5252;color:#fff;border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;">Abbrechen & Freigeben</button>`;
      container.appendChild(banner);
      container.scrollTop = container.scrollHeight;
    }

    MC.ws.on('chat.delta', (d) => {
      if (d.session_id && d.session_id !== activeSession) return; // ignore other sessions
      resetStuckTimer();
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content += d.text;
        updateLastMessage();
      }
      startAutoSave();
      // Streaming TTS: accumulate and speak sentence-by-sentence
      if (voiceMode) {
        ttsStreamBuffer += d.text;
        flushTTSSentences(false);
      }
    });

    MC.ws.on('chat.ping', (d) => {
      if (d.session_id && d.session_id !== activeSession) return;
      resetStuckTimer(); // keep alive during long tool executions
    });

    let lastNarrationTime = 0;
    MC.ws.on('chat.tool_use', (d) => {
      if (d.session_id && d.session_id !== activeSession) return;
      resetStuckTimer();
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        const toolEntry = { tool: d.tool, input: d.input, done: false };
        if (!last.tools) last.tools = [];
        last.tools.push(toolEntry);
        pendingTools.push(toolEntry);
        updateLastMessage();
      }
      // Narrate tool use (max once every 8s to avoid spam)
      const now = Date.now();
      if (voiceMode && !last?.content?.trim() && (now - lastNarrationTime > 8000)) {
        lastNarrationTime = now;
        const narr = toolNarration(d.tool, d.input);
        if (narr) enqueueTTS(narr);
      }
    });

    MC.ws.on('chat.tool_result', (d) => {
      if (d.session_id && d.session_id !== activeSession) return;
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.tools) {
        for (let i = last.tools.length - 1; i >= 0; i--) {
          if (last.tools[i].tool === d.tool && !last.tools[i].done) {
            last.tools[i].done = true;
            break;
          }
        }
        updateLastMessage();
      }
    });

    MC.ws.on('chat.done', (d) => {
      // Dedup: server broadcasts chat.done to both session subscribers and all clients;
      // ignore if we already processed done for this session+message combination.
      const _doneKey = (d.session_id || '') + '|' + (d.message_id || '') + '|' + (d.full_text || '').slice(-32);
      if (_processedDoneKeys.has(_doneKey)) return;
      _processedDoneKeys.add(_doneKey);
      setTimeout(() => _processedDoneKeys.delete(_doneKey), 5000);
      // Clear stuck detection
      if (_stuckCheckTimer) { clearInterval(_stuckCheckTimer); _stuckCheckTimer = null; }
      const stuckBanner = document.getElementById('chat-stuck-banner');
      if (stuckBanner) stuckBanner.remove();
      if (d.session_id && d.session_id !== activeSession) {
        // Stream finished for a session we're not viewing — show indicator + toast
        _activeServerStreams = _activeServerStreams.filter(s => s !== d.session_id);
        _sessionReadyIndicators.add(d.session_id);
        // Auto-expire ready indicator after 10 seconds
        if (_readyIndicatorTimers[d.session_id]) clearTimeout(_readyIndicatorTimers[d.session_id]);
        _readyIndicatorTimers[d.session_id] = setTimeout(() => {
          _sessionReadyIndicators.delete(d.session_id);
          delete _readyIndicatorTimers[d.session_id];
          renderSessions(_sessionList);
        }, 10000);
        renderSessions(_sessionList); // re-render sidebar to show ready dot
        // Toast notification
        const sess = _sessionList.find(s => s.session_id === d.session_id);
        const sessTitle = sess?.custom_title || sess?.title || null;
        // Build a short summary preview from the response text
        let preview = '';
        if (d.full_text) {
          // Strip markdown formatting for a clean preview
          preview = d.full_text.replace(/[#*_`~>\[\]()!|]/g, '').replace(/\n+/g, ' ').trim();
          if (preview.length > 120) preview = preview.slice(0, 117) + '…';
        }
        showSessionToast(d.session_id, sessTitle, preview);
        // Invalidate the stale per-session localStorage cache so switching back
        // triggers a fresh server fetch instead of showing the partial cached state
        try { localStorage.removeItem('mc_chat_session_' + d.session_id); } catch (_) {}
        return;
      }
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content = d.full_text || last.content;
        delete last._streaming;
        if (last.tools) last.tools.forEach(t => t.done = true);
        if (d.duration_ms || d.input_tokens || d.cost_usd || d.context_pct != null || d.context_used) {
          last.stats = Object.assign(last.stats || {}, {
            duration_ms: d.duration_ms,
            input_tokens: d.input_tokens || (last.stats?.input_tokens) || 0,
            output_tokens: d.output_tokens || (last.stats?.output_tokens) || 0,
            cost_usd: d.cost_usd != null ? d.cost_usd : (last.stats?.cost_usd),
            context_window: d.context_window || (last.stats?.context_window) || 0,
            context_used: d.context_used || (last.stats?.context_used) || 0,
            context_pct: d.context_pct != null ? d.context_pct : (last.stats?.context_pct ?? 0),
            model: d.model || (last.stats?.model) || '',
            provider: d.provider || (last.stats?.provider) || '',
          });
        }
      }
      if (last && last.stats) {
        sessionTotals.input_tokens += last.stats.input_tokens || 0;
        sessionTotals.output_tokens += last.stats.output_tokens || 0;
        sessionTotals.cost_usd += last.stats.cost_usd || 0;
        sessionTotals.messages++;
      }
      isStreaming = false;
      _activeServerStreams = _activeServerStreams.filter(s => s !== d.session_id);
      stopThinkingTimer();
      stopAutoSave();
      pendingTools = [];
      updateButtons();
      renderMessages();
      renderSessions(_sessionList); // update sidebar streaming indicator
      saveToStorage();
      if (last && last.stats) updateTopbarStats(last.stats);
      // Hide fallback banner if Claude answered
      if (!d.fallback) { const b = document.getElementById('fallback-banner'); if (b) b.style.display = 'none'; }
      setTimeout(() => document.getElementById('chat-input').focus(), 50);

      // Send queued voice message if any
      if (_voiceQueue) {
        const queued = _voiceQueue;
        _voiceQueue = null;
        console.log('[Chat] Sending queued voice message:', queued);
        setTimeout(() => sendVoiceMessage(queued), 300);
      }

      // TTS: flush remaining buffer, or fall back to full text if nothing was queued yet
      if (voiceMode && last && last.role === 'assistant' && last.content) {
        if (ttsStreamBuffer.trim()) {
          flushTTSSentences(true);
        } else if (!ttsQueueActive && !isSpeaking) {
          // Nothing was queued during streaming (short response) — speak it now
          const queued = last.content
            .replace(/```[\s\S]*?```/g, ' Code-Block. ')
            .replace(/`[^`]+`/g, m => m.slice(1, -1))
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/^#{1,3}\s+/gm, '')
            .replace(/^- /gm, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .trim();
          if (queued) enqueueTTS(queued);
        }
      }
      ttsStreamBuffer = '';
    });

    MC.ws.on('chat.cancelled', () => {
      isStreaming = false;
      stopThinkingTimer();
      stopAutoSave();
      if (_stuckCheckTimer) { clearInterval(_stuckCheckTimer); _stuckCheckTimer = null; }
      const stuckBanner = document.getElementById('chat-stuck-banner');
      if (stuckBanner) stuckBanner.remove();
      pendingTools = [];
      ttsStreamBuffer = '';
      // Clean up streaming flag from last message
      const last = messages[messages.length - 1];
      if (last && last._streaming) delete last._streaming;
      updateButtons();
      renderMessages();
      saveToStorage();
    });

    MC.ws.on('chat.stream_not_found', (d) => {
      // Stream already ended before we could subscribe — reset streaming state
      // The completed message is already persisted; load history to show it
      if (isStreaming) {
        isStreaming = false;
        stopThinkingTimer();
        stopAutoSave();
        updateButtons();
        if (activeSession) {
          MC.ws.send({ type: 'chat.load_history', session_id: activeSession });
        }
      }
    });

    MC.ws.on('chat.metadata', (d) => {
      if (d.session_id && d.session_id !== activeSession) return;
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        if (!last.stats) last.stats = {};
        last.stats.model = d.model;
        last.stats.provider = d.provider;
      }
      updateTopbarStats({ model: d.model, provider: d.provider });
    });

    // chat.usage — server feuert das fuer jeden UsageEvent waehrend des Streams.
    // Enthaelt Token-Counts + context_pct/window/used. Die Topbar bekommt das hier
    // live mit, sonst stehen die Stats erst beim chat.done — und beim neuen
    // _run_chat-Pfad standen sie gar nicht in chat.done drin (deswegen 0%).
    MC.ws.on('chat.usage', (d) => {
      if (d.session_id && d.session_id !== activeSession) return;
      const stats = {
        input_tokens: d.input_tokens || 0,
        output_tokens: d.output_tokens || 0,
        cache_creation_tokens: d.cache_creation_tokens || 0,
        cache_read_tokens: d.cache_read_tokens || 0,
        context_window: d.context_window || 0,
        context_used: d.context_used || 0,
        context_pct: d.context_pct || 0,
      };
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.stats = Object.assign(last.stats || {}, stats);
      }
      updateTopbarStats(stats);
    });

    // Direct context update — broadcast to all clients, no session filter needed.
    MC.ws.on('context.update', (d) => {
      if (d.context_pct != null) {
        updateTopbarStats({ context_pct: d.context_pct, context_used: d.context_used, context_window: d.context_window });
      }
    });

    MC.ws.on('chat.error', (d) => {
      isStreaming = false;
      stopThinkingTimer();
      stopAutoSave();
      pendingTools = [];
      ttsStreamBuffer = '';
      // Session aus dem "streaming"-Tracker entfernen, sonst bleibt serverBusy=true
      // und sendMessage() wird stumm abgelehnt (Send-Button visuell klickbar, macht aber nichts).
      const errSid = d && d.session_id;
      if (errSid) {
        _activeServerStreams = _activeServerStreams.filter(s => s !== errSid);
      }
      updateButtons();
      messages.push({ role: 'assistant', content: `**Error:** ${d.error}`, timestamp: new Date().toISOString() });
      renderMessages();
      renderSessions(_sessionList); // sidebar-streaming-indicator abnehmen
      saveToStorage();
    });

    MC.ws.on('chat.fallback_active', (d) => {
      const banner = document.getElementById('fallback-banner');
      if (banner) {
        banner.textContent = `⚡ Fallback aktiv: ${d.model}`;
        banner.style.display = 'block';
      }
    });

  }

  // ── File Handling ──────────────────────────────────────────────────────────
  function handleFiles(files) {
    const allowed = ['image/', 'application/pdf', 'text/', 'audio/'];
    files.forEach(file => {
      const ok = allowed.some(t => file.type.startsWith(t)) ||
                 /\.(pdf|txt|md|csv|json|webm|mp3|wav|m4a)$/i.test(file.name);
      if (!ok) { alert(`Dateiformat nicht unterstuetzt: ${file.name}`); return; }
      uploadFile(file);
    });
  }

  async function uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); alert(`Upload fehlgeschlagen: ${err.error}`); return; }
      const data = await res.json();
      pendingAttachments.push({ filename: data.filename, originalName: file.name, type: file.type, localURL: URL.createObjectURL(file) });
      renderAttachmentPreviews();
      updateSendButton();
    } catch (e) { alert(`Upload Fehler: ${e.message}`); }
  }

  function renderAttachmentPreviews() {
    const el = document.getElementById('chat-attachments');
    el.innerHTML = '';
    pendingAttachments.forEach((att, i) => {
      const div = document.createElement('div');
      div.className = 'chat-attachment-preview';
      if (att.type.startsWith('image/')) {
        const img = document.createElement('img'); img.src = att.localURL; div.appendChild(img);
      } else {
        const icon = document.createElement('div'); icon.className = 'att-icon';
        icon.textContent = att.type.startsWith('audio/') ? '\u{1F3B5}' : att.type === 'application/pdf' ? '\u{1F4C4}' : '\u{1F4DD}';
        const label = document.createElement('div'); label.className = 'att-label'; label.textContent = att.originalName;
        div.appendChild(icon); div.appendChild(label);
      }
      const removeBtn = document.createElement('button'); removeBtn.className = 'att-remove'; removeBtn.textContent = '\u00D7';
      removeBtn.addEventListener('click', () => { URL.revokeObjectURL(att.localURL); pendingAttachments.splice(i, 1); renderAttachmentPreviews(); updateSendButton(); });
      div.appendChild(removeBtn); el.appendChild(div);
    });
  }

  // ── STT (Speech-to-Text) ───────────────────────────────────────────────────
  function initSTT() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    sttSupported = true;
    recognition = new SR();
    recognition.lang = 'de-DE';
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.addEventListener('result', (e) => {
      const input = document.getElementById('chat-input');
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { finalTranscript += t; } else { interim += t; }
      }
      input.value = finalTranscript + interim;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      updateSendButton();

      if (isSpeaking) stopSpeaking();

      if (voiceMode) {
        clearSilenceTimer();
        if (input.value.trim()) startSilenceTimer();
      }
    });

    recognition.addEventListener('end', () => {
      if (!isListening) return;
      try { recognition.start(); } catch (_) { stopListening(); }
    });

    recognition.addEventListener('error', (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') {
        if (isListening) { try { recognition.start(); } catch (_) { stopListening(); } }
        return;
      }
      console.error('STT error:', e.error);
      stopListening();
    });
  }

  function startSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (!isStreaming && document.getElementById('chat-input').value.trim()) {
        doVoiceSend();
      }
    }, SILENCE_TIMEOUT);
  }

  function clearSilenceTimer() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  function doVoiceSend() {
    stopListening();
    finalTranscript = '';
    sendMessage();
  }

  function startListening() {
    if (!sttSupported || isListening) return;
    // Pause voice listener to avoid Web Speech API conflict
    if (MC.voiceListener) MC.voiceListener.pause();
    finalTranscript = '';
    document.getElementById('chat-input').value = '';
    try { recognition.start(); } catch (_) {
      try { recognition.stop(); } catch (__) {}
      setTimeout(() => {
        try { recognition.start(); setListeningUI(true); } catch (_) {}
      }, 250);
      return;
    }
    setListeningUI(true);
  }

  function stopListening() {
    clearSilenceTimer();
    isListening = false;
    try { recognition.stop(); } catch (_) {}
    setListeningUI(false);
    // Resume voice listener after chat STT is done
    setTimeout(() => { if (MC.voiceListener) MC.voiceListener.resume(); }, 500);
  }

  function setListeningUI(on) {
    isListening = on;
    const btn = document.getElementById('btn-voice');
    btn.classList.toggle('listening', on);
    btn.title = on ? 'Mikrofon aus' : 'Mikrofon an';
  }

  function toggleSTT() {
    if (!sttSupported) { alert('Speech Recognition nicht verfuegbar.\n\niPhone/iPad: Bitte Safari nutzen — Chrome auf iOS unterstuetzt kein Speech API.\nDesktop: Chrome oder Edge.'); return; }
    if (isSpeaking) stopSpeaking();
    if (isListening) {
      stopListening();
      const input = document.getElementById('chat-input');
      if (input.value.trim() && !isStreaming) setTimeout(() => sendMessage(), 100);
    } else {
      startListening();
    }
  }

  // ── Voice Conversation Mode ────────────────────────────────────────────────
  function toggleVoiceMode() {
    voiceMode = !voiceMode;
    updateVoiceModeButton();
    updateVoiceSelectVisibility();
    if (voiceMode) {
      if (!isListening) startListening();
    } else {
      if (isSpeaking) stopSpeaking();
    }
  }

  function updateVoiceModeButton() {
    const btn = document.getElementById('btn-tts-toggle');
    const iconOn = document.getElementById('tts-icon-on');
    const iconOff = document.getElementById('tts-icon-off');
    btn.classList.toggle('active', voiceMode);
    iconOn.style.display = voiceMode ? '' : 'none';
    iconOff.style.display = voiceMode ? 'none' : '';
    btn.title = voiceMode ? 'Voice-Modus aus' : 'Voice-Modus an';
  }

  function updateVoiceSelectVisibility() {
    const voiceSelect = document.getElementById('chat-voice-select');
    const rateControl = document.getElementById('chat-rate-control');
    const volumeControl = document.getElementById('chat-volume-control');
    if (voiceSelect) voiceSelect.style.display = voiceMode ? '' : 'none';
    if (rateControl) rateControl.style.display = voiceMode ? '' : 'none';
    if (volumeControl) volumeControl.style.display = voiceMode ? '' : 'none';
  }

  // ── TTS Queue ──────────────────────────────────────────────────────────────

  // Enqueue a text snippet for sequential TTS playback
  function enqueueTTS(text) {
    if (!text || !text.trim()) return;
    ttsQueue.push(text.trim());
    if (!ttsQueueActive) drainTTSQueue();
  }

  let prefetchedBlob = null;

  async function drainTTSQueue() {
    if (ttsQueueActive) return;
    ttsQueueActive = true;
    while (ttsQueue.length && voiceMode) {
      const text = ttsQueue.shift();
      // Pre-fetch next audio while current plays
      const nextFetch = ttsQueue.length ? fetchTTSBlob(ttsQueue[0]) : null;
      if (prefetchedBlob) {
        await playBlob(prefetchedBlob);
        prefetchedBlob = null;
      } else {
        await speakTextDirect(text);
      }
      if (nextFetch) { try { prefetchedBlob = await nextFetch; } catch (_) { prefetchedBlob = null; } }
    }
    prefetchedBlob = null;
    ttsQueueActive = false;
    if (voiceMode && !isSpeaking && !isStreaming && !isListening) {
      setTimeout(() => startListening(), 300);
    }
  }

  async function fetchTTSBlob(text) {
    const clean = cleanForTTS(text);
    if (!clean) return null;
    try {
      const res = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean }),
      });
      return res.ok ? await res.blob() : null;
    } catch (_) { return null; }
  }

  function playBlob(blob) {
    const ttsBtn = document.getElementById('btn-tts-toggle');
    if (ttsBtn) ttsBtn.classList.add('speaking');
    isSpeaking = true;
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      currentAudio.playbackRate = getTTSRate();
      currentAudio.volume = getTTSVolume();
      currentAudio.onended = () => { if (!ttsQueue.length) { isSpeaking = false; if (ttsBtn) ttsBtn.classList.remove('speaking'); } URL.revokeObjectURL(url); currentAudio = null; resolve(); };
      currentAudio.onerror = () => { isSpeaking = false; if (ttsBtn) ttsBtn.classList.remove('speaking'); URL.revokeObjectURL(url); currentAudio = null; resolve(); };
      currentAudio.play().catch(() => resolve());
    });
  }

  // Speak a single text snippet — returns a Promise that resolves when done
  async function speakTextDirect(text) {
    if (!text) return;
    const clean = cleanForTTS(text);
    if (!clean) return;

    const ctrl = new AbortController();
    if (ttsAbort) ttsAbort.abort();
    ttsAbort = ctrl;

    const ttsBtn = document.getElementById('btn-tts-toggle');
    if (ttsBtn) ttsBtn.classList.add('speaking');
    isSpeaking = true;

    return new Promise(async (resolve) => {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean }),
          signal: ctrl.signal,
        });
        if (!res.ok) { resolve(); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        currentAudio.playbackRate = getTTSRate();
      currentAudio.volume = getTTSVolume();

        currentAudio.addEventListener('ended', () => {
          // Only mark not-speaking if queue is empty
          if (!ttsQueue.length) {
            isSpeaking = false;
            if (ttsBtn) ttsBtn.classList.remove('speaking');
          }
          URL.revokeObjectURL(url);
          currentAudio = null;
          resolve();
        });
        currentAudio.addEventListener('error', () => {
          isSpeaking = false;
          if (ttsBtn) ttsBtn.classList.remove('speaking');
          URL.revokeObjectURL(url);
          currentAudio = null;
          resolve();
        });
        await currentAudio.play();
      } catch (e) {
        if (e.name !== 'AbortError') console.error('TTS error:', e);
        isSpeaking = false;
        if (ttsBtn) ttsBtn.classList.remove('speaking');
        resolve();
      }
    });
  }

  // Clean text for TTS
  function cleanForTTS(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' Code-Block. ')
      .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,3}\s+/gm, '')
      .replace(/^- /gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .trim();
  }

  // Extract complete sentences from the stream buffer and enqueue them
  // Batches multiple sentences together to avoid pauses between TTS requests
  const TTS_MIN_CHUNK = 120; // minimum chars before flushing (≈2-3 sentences)

  function flushTTSSentences(forceAll) {
    if (!voiceMode) return;
    const buf = ttsStreamBuffer;
    if (!buf) return;

    if (forceAll) {
      const text = cleanForTTS(buf.trim());
      ttsStreamBuffer = '';
      if (text.length > 2) enqueueTTS(text);
      return;
    }

    // Find last sentence-ending boundary followed by whitespace
    let lastBoundary = -1;
    for (let i = buf.length - 2; i >= 0; i--) {
      if ((buf[i] === '.' || buf[i] === '!' || buf[i] === '?') && (buf[i + 1] === ' ' || buf[i + 1] === '\n')) {
        lastBoundary = i;
        break;
      }
    }
    if (lastBoundary === -1) return;

    const complete = buf.slice(0, lastBoundary + 1);

    // Wait for enough text to batch (reduces pauses between chunks)
    if (complete.length < TTS_MIN_CHUNK && !ttsQueueActive && !isSpeaking) return;

    ttsStreamBuffer = buf.slice(lastBoundary + 2);

    // Send the whole chunk as one TTS request instead of splitting per sentence
    const text = cleanForTTS(complete);
    if (text.length > 2) enqueueTTS(text);
  }

  // Legacy speakText (kept for backward compat — now wraps enqueueTTS)
  function speakText(text) {
    if (!text) return;
    const clean = cleanForTTS(text);
    if (!clean) return;
    stopSpeaking(); // clear any previous
    enqueueTTS(clean);
  }

  function stopSpeaking() {
    ttsQueue = [];
    ttsQueueActive = false;
    ttsStreamBuffer = '';
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if (ttsAbort) { ttsAbort.abort(); ttsAbort = null; }
    isSpeaking = false;
    const btn = document.getElementById('btn-tts-toggle');
    if (btn) btn.classList.remove('speaking');
  }

  // ── Send Message ───────────────────────────────────────────────────────────
  async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const serverBusy = activeSession && _activeServerStreams.includes(activeSession);
    if (isStreaming || serverBusy || (!text && !pendingAttachments.length)) return;

    const attachmentsCopy = [...pendingAttachments];
    const filenames = attachmentsCopy.map(a => a.filename);

    input.value = '';
    input.style.height = 'auto';
    pendingAttachments = [];
    renderAttachmentPreviews();
    document.getElementById('btn-send').disabled = true;

    updateTopbarStats(null, true);
    messages.push({ role: 'user', content: text, timestamp: new Date().toISOString(), attachments: attachmentsCopy });
    userScrolledUp = false; // Snap to bottom on send
    const scrollFab = document.getElementById('btn-scroll-bottom');
    if (scrollFab) scrollFab.classList.remove('visible');
    renderMessages();
    saveToStorage();

    const doSend = () => {
      // Track that this session is now streaming (so session-switch knows)
      if (activeSession && !_activeServerStreams.includes(activeSession)) {
        _activeServerStreams.push(activeSession);
        renderSessions(_sessionList); // show streaming indicator immediately
      }
      const pm = _getCurrentProviderModel();
      MC.ws.send({ type: 'chat.send', session_id: activeSession,
                   message: text || '(siehe Anhang)', attachments: filenames,
                   provider: pm.provider, model: pm.model });
    };

    if (!activeSession) {
      MC.ws.send({ type: 'chat.new_session' });
      const waitForSession = () => {
        if (activeSession) { doSend(); return; }
        setTimeout(waitForSession, 50);
      };
      setTimeout(waitForSession, 50);
      return;
    }

    doSend();
  }

  function cancelMessage() {
    if (activeSession) MC.ws.send({ type: 'chat.cancel', session_id: activeSession });
  }

  function newSession() {
    activeSession = null;
    messages = [];
    ttsQueue = [];
    ttsQueueActive = false;
    ttsStreamBuffer = '';
    sessionTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0, messages: 0 };
    stopSpeaking();
    localStorage.removeItem(STORAGE_KEY);
    renderMessages();
    updateTopbarStats(null, true);
    updateSessionBadge();
    // Open sidebar so the new session appears immediately
    const layout = document.querySelector('.chat-layout');
    if (layout) layout.classList.remove('sessions-collapsed');
    localStorage.setItem(STORAGE_KEY_SIDEBAR, '1');
    _updateSidebarToggleBtn();
    MC.ws.send({ type: 'chat.new_session' });
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  function updateSendButton() {
    const input = document.getElementById('chat-input');
    const has = input.value.trim() || pendingAttachments.length > 0;
    document.getElementById('btn-send').disabled = !has || isStreaming;
  }

  function updateButtons() {
    updateSendButton();
    document.getElementById('btn-cancel').style.display = isStreaming ? '' : 'none';
    document.getElementById('btn-send').style.display = isStreaming ? 'none' : '';
  }

  function updateSessionBadge() {
    const badge = document.getElementById('chat-session-badge');
    if (!badge) return;
    if (!activeSession) { badge.textContent = ''; return; }
    const session = _sessionList.find(s => s.session_id === activeSession);
    const title = session?.custom_title || session?.title || activeSession.slice(0, 8) + '…';
    badge.textContent = title;
  }

  let _sessionList = [];
  let _sessionSortMode = localStorage.getItem('mc_session_sort') || 'topic'; // 'topic' | 'recent'
  let _topicColors = {};
  let _activeTopicColor = null; // current session's topic color for bubble tinting
  let _newSessionId = null;     // set on session_created → triggers flash in renderSessions
  const _sessionReadyIndicators = new Set(); // sessions with finished responses while not active
  const _readyIndicatorTimers = {};           // auto-expire timers for ready indicators
  const _processedDoneKeys = new Set(); // dedup: prevent double-processing chat.done (server broadcasts to subs + all clients)

  function _escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // Generic completion toast — used by Chat, Arena, Funnel, etc.
  // opts: { icon, label, title, preview, onClick, duration, dedupKey }
  const _toastDedup = new Map(); // dedupKey -> toast element
  function showCompletionToast(opts) {
    const container = document.getElementById('toast-container');
    if (!container) return null;
    const {
      icon = '💬',
      label = 'Neue Antwort',
      title = '',
      preview = '',
      onClick = null,
      duration = 120000, // 2 min default; Robin wants 1-3 min lifetime
      dedupKey = null,
    } = opts || {};

    // Dedup: if a toast with same key exists, refresh it instead of stacking duplicates
    if (dedupKey && _toastDedup.has(dedupKey)) {
      const existing = _toastDedup.get(dedupKey);
      if (existing && existing.isConnected) {
        // Update preview + reset timer
        const titleEl = existing.querySelector('.mc-toast-title');
        const prevEl = existing.querySelector('.mc-toast-preview');
        if (titleEl && title) titleEl.textContent = title;
        if (prevEl && preview) prevEl.textContent = preview;
        if (existing._timer) clearTimeout(existing._timer);
        existing._timer = setTimeout(() => existing._dismiss && existing._dismiss(), duration);
        // Move to bottom (newest position)
        container.appendChild(existing);
        return existing;
      }
    }

    const previewHtml = preview ? `<div class="mc-toast-preview">${escapeHtml(preview)}</div>` : '';
    const toast = document.createElement('div');
    toast.className = 'mc-toast';
    toast.innerHTML = `
      <div class="mc-toast-icon">${escapeHtml(icon)}</div>
      <div class="mc-toast-body">
        <div class="mc-toast-label">${escapeHtml(label)}</div>
        <div class="mc-toast-title">${escapeHtml(title)}</div>
        ${previewHtml}
      </div>
      <button class="mc-toast-close" title="Schließen">×</button>
    `;
    const dismiss = () => {
      if (toast._timer) { clearTimeout(toast._timer); toast._timer = null; }
      if (dedupKey) _toastDedup.delete(dedupKey);
      toast.classList.add('removing');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    };
    toast._dismiss = dismiss;
    toast.querySelector('.mc-toast-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });
    if (typeof onClick === 'function') {
      toast.addEventListener('click', () => {
        dismiss();
        try { onClick(); } catch (err) { console.error('[Toast] onClick error:', err); }
      });
    } else {
      toast.style.cursor = 'default';
    }
    container.appendChild(toast);
    if (dedupKey) _toastDedup.set(dedupKey, toast);
    toast._timer = setTimeout(dismiss, duration);
    return toast;
  }

  function showSessionToast(sessionId, sessionTitle, preview) {
    const label = sessionTitle || sessionId.slice(0, 8) + '…';
    return showCompletionToast({
      icon: '💬',
      label: 'Neue Antwort',
      title: label,
      preview,
      dedupKey: 'chat:' + sessionId,
      onClick: () => {
        if (MC.switchView) MC.switchView('chat');
        setTimeout(() => {
          const item = document.querySelector(`.session-item[data-sid="${CSS.escape(sessionId)}"]`);
          if (item) {
            item.click();
            setTimeout(() => {
              const msgs = document.getElementById('chat-messages');
              if (msgs) msgs.scrollTop = msgs.scrollHeight;
            }, 300);
          }
        }, 80);
      },
    });
  }

  // Expose for other views (arena, funnel, etc.)
  window.MC = window.MC || {};
  MC.completionToast = showCompletionToast;

  function _groupByTopic(list) {
    const groups = {};
    for (const s of list) {
      const topic = s.topic || '__none__';
      if (!groups[topic]) groups[topic] = { color: s.topic_color || null, sessions: [] };
      groups[topic].sessions.push(s);
      if (s.topic_color) groups[topic].color = s.topic_color;
    }
    // Sort: named topics first (alphabetically), then uncategorized
    const sorted = Object.entries(groups).sort((a, b) => {
      if (a[0] === '__none__') return 1;
      if (b[0] === '__none__') return -1;
      return a[0].localeCompare(b[0]);
    });
    return sorted;
  }

  // Per-Session Modell-Badge — gleiche Farb-/Label-Logik wie der Topbar-Badge.
  function _sessionModelBadge(provider, model) {
    if (!provider && !model) return '';
    const pShort = {
      'claude-cli': 'Claude', 'claude-api': 'Claude API',
      'codex-cli': 'Codex', 'gemini-cli': 'Gemini', 'openai': 'OpenAI',
    };
    const m = (model || '').toLowerCase();
    const c = m.includes('opus') ? '#a855f7'
      : m.includes('sonnet') ? '#3b82f6'
      : m.includes('haiku') ? '#22c55e'
      : m.includes('gemini') ? '#3b82f6'
      : (m.includes('gpt') || m.includes('codex') || m.startsWith('o3') || m.startsWith('o4')) ? '#10b981'
      : '#6b7280';
    const providerName = pShort[provider] || provider || '';
    const isAuto = !model;
    const label = isAuto ? (providerName + ' · Auto') : (providerName ? providerName + ' · ' + model : model);
    return `<span class="session-model-badge" style="color:${c};border-color:${c}55;background:${c}14">${escapeHtml(label)}</span>`;
  }

  function _sessionItemHtml(s, showTopicDot) {
    const isMain = s.session_id === 'jarvis-main';
    const isHeartbeat = s.session_id === 'jarvis-heartbeat';
    const isPinned = isMain || isHeartbeat;
    const active = s.session_id === activeSession ? 'active' : '';
    const mainCls = isMain ? 'session-main' : (isHeartbeat ? 'session-heartbeat' : '');
    const rawLabel = isMain ? 'Jarvis · Main'
      : isHeartbeat ? 'Jarvis · Heartbeat'
      : (s.title || s.session_id.slice(0, 8));
    const label = escapeHtml(rawLabel);
    const time = s.last_message ? new Date(s.last_message).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' }) : '';
    const borderColor = isMain ? '#f59e0b'
      : isHeartbeat ? '#a78bfa'
      : (s.topic_color || 'transparent');
    const topicDot = !isPinned && showTopicDot && s.topic_color ? `<span class="session-topic-dot" style="background:${s.topic_color}"></span>` : '';
    const mainBadge = isMain ? '<span class="session-main-badge" title="Interaktive Jarvis-Session — immer aktiv, kann nicht gelöscht werden">ORCHESTRATOR</span>'
      : isHeartbeat ? '<span class="session-main-badge session-hb-badge" title="Autonome Heartbeat-Ticks — alle 30 Min, kann nicht gelöscht werden">HEARTBEAT</span>'
      : '';
    const isStreamingNow = _activeServerStreams.includes(s.session_id);
    const isReady = _sessionReadyIndicators.has(s.session_id);
    const _lastActive = s.last_heartbeat || s.last_message;
    const isDead = !isPinned && _lastActive && !isStreamingNow && (Date.now() - new Date(_lastActive).getTime()) > 300000;
    const _deadAge = isDead ? Math.round((Date.now() - new Date(_lastActive).getTime()) / 60000) : 0;
    const statusIndicator = isStreamingNow
      ? '<span class="session-streaming-dot" title="Jarvis arbeitet…"></span>'
      : isReady
        ? '<span class="session-ready-dot" title="Antwort fertig"></span>'
        : isDead
          ? `<span class="session-dead-dot" title="Inaktiv seit ${_deadAge} Min">&#x25CF;</span>`
          : '';
    const preview = s.last_preview ? `<div class="session-preview">${escapeHtml(s.last_preview)}</div>` : '';
    const draggable = isPinned ? 'false' : 'true';
    const titleAttr = isMain ? 'Jarvis Orchestrator (immer aktiv)'
      : isHeartbeat ? 'Heartbeat-Tick-Log (immer aktiv)'
      : 'Doppelklick zum Umbenennen';
    const topicBtn = isPinned ? '' : `<button class="session-topic-btn" data-sid="${s.session_id}" title="Thema \u00e4ndern">\u2630</button>`;
    const deleteBtn = isPinned ? '' : `<button class="session-delete" data-sid="${s.session_id}" title="Session loeschen">&times;</button>`;
    const modelBadge = _sessionModelBadge(s.provider, s.model);
    return `<div class="session-item ${active} ${mainCls}" data-sid="${s.session_id}" draggable="${draggable}" style="border-left-color:${borderColor}">
      <div class="session-title" data-sid="${s.session_id}" title="${titleAttr}">${topicDot}${label}${statusIndicator}${mainBadge}</div>
      ${modelBadge}
      ${preview}
      <div class="session-time">${s.message_count} msg${s.message_count !== 1 ? 's' : ''}${time ? ' \u00B7 ' + time : ''}</div>
      ${topicBtn}
      ${deleteBtn}
    </div>`;
  }

  function _buildGroupedHtml(list, showTopicDot) {
    const main = list.find(s => s.session_id === 'jarvis-main');
    const heartbeat = list.find(s => s.session_id === 'jarvis-heartbeat');
    const rest = list.filter(s => s.session_id !== 'jarvis-main' && s.session_id !== 'jarvis-heartbeat');
    const pinnedHtml = (main ? _sessionItemHtml(main, false) : '') + (heartbeat ? _sessionItemHtml(heartbeat, false) : '');
    const groups = _groupByTopic(rest);
    if (groups.length === 1 && groups[0][0] === '__none__') {
      return pinnedHtml + rest.map(s => _sessionItemHtml(s, showTopicDot)).join('');
    }
    let html = pinnedHtml;
    for (const [topic, data] of groups) {
      const name = topic === '__none__' ? 'Unkategorisiert' : escapeHtml(topic);
      const color = data.color || '#64748b';
      html += `<div class="session-group">
        <div class="session-group-header" style="color:${color}">
          <span class="session-group-dot" style="background:${color}"></span>
          <span class="session-group-name">${name}</span>
          <span class="session-group-count">${data.sessions.length}</span>
        </div>
        ${data.sessions.map(s => _sessionItemHtml(s, false)).join('')}
      </div>`;
    }
    return html;
  }

  function _handleSessionListEvents(container, closeDrawer) {
    // Event delegation
    container.onclick = function(e) {
      const delBtn = e.target.closest('.session-delete');
      if (delBtn) {
        e.stopPropagation(); e.preventDefault();
        const sid = delBtn.dataset.sid;
        if (sid === 'jarvis-main' || sid === 'jarvis-heartbeat') return;
        if (sid === activeSession) { activeSession = null; messages = []; renderMessages(); updateSessionBadge(); }
        try { localStorage.removeItem('mc_chat_session_' + sid); } catch (_) {}
        MC.ws.send({ type: 'chat.delete_session', session_id: sid });
        if (closeDrawer) { const d = document.getElementById('session-drawer'); if (d) d.classList.remove('open'); }
        return;
      }
      const topicBtn = e.target.closest('.session-topic-btn');
      if (topicBtn) {
        e.stopPropagation(); e.preventDefault();
        _showTopicMenu(topicBtn, topicBtn.dataset.sid);
        return;
      }
      const item = e.target.closest('.session-item');
      if (item) {
        // Save current session state (including partial streaming) before switching
        if (messages.length) saveToStorage();
        const prevStreaming = isStreaming;
        // Stop streaming UI for the session we're leaving (stream continues on server)
        if (isStreaming) {
          isStreaming = false;
          stopThinkingTimer();
          stopAutoSave();
          updateButtons();
        }
        activeSession = item.dataset.sid;
        _applyPickerLock();
        // Clear ready indicator when switching to this session
        _sessionReadyIndicators.delete(activeSession);
        if (_readyIndicatorTimers[activeSession]) { clearTimeout(_readyIndicatorTimers[activeSession]); delete _readyIndicatorTimers[activeSession]; }
        const readyDot = item.querySelector('.session-ready-dot');
        if (readyDot) readyDot.remove();
        messages = [];
        isStreaming = false;
        // Restore cached messages from per-session localStorage (instant render)
        const cachedMessages = loadSessionMessages(activeSession);
        if (cachedMessages && cachedMessages.length) {
          messages = cachedMessages.map(m => {
            // Clear stale streaming flag from cached state
            const cleaned = { ...m };
            delete cleaned._streaming;
            return cleaned;
          });
        }
        renderMessages();
        updateSessionBadge();
        _updateActiveTopicColor();
        renderSessions(_sessionList);
        if (_activeServerStreams.includes(activeSession)) {
          // subscribe_stream sends history first then stream events — no separate load_history needed
          isStreaming = true;
          _pendingSubscribeHistory = true;
          _ownResubscribe = true;
          pendingTools = [];
          ttsStreamBuffer = '';
          startThinkingTimer();
          updateButtons();
          MC.ws.send({ type: 'chat.subscribe_stream', session_id: activeSession });
        } else {
          // Normal session switch — load history from server
          MC.ws.send({ type: 'chat.load_history', session_id: activeSession });
        }
        if (closeDrawer) { const d = document.getElementById('session-drawer'); if (d) d.classList.remove('open'); }
      }
    };
    // Double-click to rename
    container.ondblclick = function(e) {
      const titleEl = e.target.closest('.session-title');
      if (!titleEl) return;
      e.preventDefault();
      const sid = titleEl.dataset.sid;
      const session = _sessionList.find(s => s.session_id === sid);
      if (!session) return;
      const currentTitle = session.custom_title || session.title || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'session-rename-input';
      input.value = currentTitle;
      titleEl.innerHTML = '';
      titleEl.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== currentTitle) {
          MC.ws.send({ type: 'chat.rename_session', session_id: sid, title: newTitle });
        } else {
          renderSessions(_sessionList); // revert
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = currentTitle; input.blur(); }
      });
    };

    // ── Drag to reorder ────────────────────────────────────────────────────
    let _dragSid = null;
    container.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.session-item');
      if (!item) return;
      _dragSid = item.dataset.sid;
      e.dataTransfer.effectAllowed = 'move';
      // Delay adding class so drag image renders first
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const item = e.target.closest('.session-item');
      if (item && item.dataset.sid !== _dragSid) {
        container.querySelectorAll('.session-item').forEach(el => el.classList.remove('drag-over'));
        item.classList.add('drag-over');
      }
    });
    container.addEventListener('dragleave', (e) => {
      if (!container.contains(e.relatedTarget)) {
        container.querySelectorAll('.session-item').forEach(el => el.classList.remove('drag-over'));
      }
    });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.querySelectorAll('.session-item').forEach(el => { el.classList.remove('drag-over'); el.classList.remove('dragging'); });
      const targetItem = e.target.closest('.session-item');
      if (!targetItem || !_dragSid || targetItem.dataset.sid === _dragSid) { _dragSid = null; return; }
      const fromIdx = _sessionList.findIndex(s => s.session_id === _dragSid);
      const toIdx = _sessionList.findIndex(s => s.session_id === targetItem.dataset.sid);
      if (fromIdx !== -1 && toIdx !== -1) {
        const [moved] = _sessionList.splice(fromIdx, 1);
        _sessionList.splice(toIdx, 0, moved);
        renderSessions(_sessionList);
      }
      _dragSid = null;
    });
    container.addEventListener('dragend', () => {
      container.querySelectorAll('.session-item').forEach(el => { el.classList.remove('drag-over'); el.classList.remove('dragging'); });
      _dragSid = null;
    });
  }

  function _showTopicMenu(anchor, sessionId) {
    // Remove any existing menu
    document.querySelectorAll('.topic-menu').forEach(m => m.remove());
    const session = _sessionList.find(s => s.session_id === sessionId);
    const existingTopics = {};
    _sessionList.forEach(s => { if (s.topic) existingTopics[s.topic] = s.topic_color; });
    Object.assign(existingTopics, _topicColors);

    const menu = document.createElement('div');
    menu.className = 'topic-menu';
    let items = '';
    // Existing topics
    for (const [name, color] of Object.entries(existingTopics)) {
      const isActive = session && session.topic === name ? ' active' : '';
      items += `<div class="topic-menu-item${isActive}" data-topic="${_escAttr(name)}">
        <span class="topic-menu-dot" style="background:${color || '#64748b'}"></span>${escapeHtml(name)}
      </div>`;
    }
    // Auto-classify option
    items += `<div class="topic-menu-divider"></div>`;
    items += `<div class="topic-menu-item topic-auto" data-action="auto-classify">
      <span class="topic-menu-dot" style="background:#3b82f6"></span>Auto-Erkennung
    </div>`;
    // New topic
    items += `<div class="topic-menu-item topic-new" data-action="new-topic">
      <span class="topic-menu-dot" style="background:#64748b">+</span>Neues Thema...
    </div>`;
    // Remove topic
    if (session && session.topic) {
      items += `<div class="topic-menu-item topic-remove" data-action="remove-topic">
        <span class="topic-menu-dot" style="background:#ef4444">&times;</span>Thema entfernen
      </div>`;
    }
    menu.innerHTML = items;
    document.body.appendChild(menu);

    // Position near anchor
    const rect = anchor.getBoundingClientRect();
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';

    menu.onclick = function(e) {
      const item = e.target.closest('.topic-menu-item');
      if (!item) return;
      const action = item.dataset.action;
      if (action === 'auto-classify') {
        MC.ws.send({ type: 'chat.classify_session', session_id: sessionId });
      } else if (action === 'new-topic') {
        const name = prompt('Neues Thema:');
        if (name && name.trim()) {
          MC.ws.send({ type: 'chat.set_topic', session_id: sessionId, topic: name.trim() });
        }
      } else if (action === 'remove-topic') {
        MC.ws.send({ type: 'chat.set_topic', session_id: sessionId, topic: '__remove__' });
      } else if (item.dataset.topic) {
        MC.ws.send({ type: 'chat.set_topic', session_id: sessionId, topic: item.dataset.topic });
      }
      menu.remove();
    };
    // Close on outside click
    setTimeout(() => {
      const closeMenu = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu); } };
      document.addEventListener('click', closeMenu);
    }, 10);
  }

  function _updateActiveTopicColor() {
    const s = _sessionList.find(s => s.session_id === activeSession);
    _activeTopicColor = s ? s.topic_color : null;
  }

  let _sessionFilter = '';
  let _searchInputAttached = false;

  function _ensureSessionSearch() {
    if (_searchInputAttached) return;
    const header = document.querySelector('.chat-sessions-header');
    if (!header) return;
    if (header.querySelector('.session-search-input')) { _searchInputAttached = true; return; }
    const wrap = document.createElement('div');
    wrap.className = 'session-search-wrap';
    wrap.innerHTML = '<input type="search" class="session-search-input" placeholder="Suchen…" autocomplete="off">';
    header.insertAdjacentElement('afterend', wrap);
    wrap.querySelector('input').addEventListener('input', (e) => {
      _applySessionFilter(e.target.value);
    });
    _searchInputAttached = true;
  }

  function _applySessionFilter(query) {
    _sessionFilter = (query || '').toLowerCase().trim();
    const filtered = _sessionFilter
      ? _sessionList.filter(s => {
          const title = (s.custom_title || s.title || s.session_id || '').toLowerCase();
          const topic = (s.topic || '').toLowerCase();
          const preview = (s.last_preview || '').toLowerCase();
          return title.includes(_sessionFilter) || topic.includes(_sessionFilter) || preview.includes(_sessionFilter);
        })
      : _sessionList;
    const el = document.getElementById('session-list');
    if (!el) return;
    el.innerHTML = _sessionSortMode === 'recent' ? _buildRecentHtml(filtered, false) : _buildGroupedHtml(filtered, false);
    _handleSessionListEvents(el, false);
    el.querySelectorAll('.session-group').forEach(g => {
      g.classList.toggle('has-active', !!g.querySelector('.session-item.active'));
    });
  }

  function renderSessions(list) {
    _sessionList = list || [];
    // Jarvis-Main-Orchestrator-Session IMMER ganz oben (Pin) — unabhängig
    // von Sort-Modus. Sie ist die „Haupt-Bewusstseins"-Session und soll
    // visuell als Signature-Session erkennbar sein.
    const _pinRank = sid => sid === 'jarvis-main' ? 0 : sid === 'jarvis-heartbeat' ? 1 : 2;
    _sessionList.sort((a, b) => _pinRank(a.session_id) - _pinRank(b.session_id));
    // Prune stale entries from _activeServerStreams — remove IDs not in the session list
    if (_sessionList.length) {
      const knownIds = new Set(_sessionList.map(s => s.session_id));
      _activeServerStreams = _activeServerStreams.filter(id => knownIds.has(id));
    }
    const el = document.getElementById('session-list');
    const layout = document.querySelector('.chat-layout');
    if (!list || list.length === 0) {
      if (layout) layout.classList.remove('has-sessions');
      if (el) el.innerHTML = '';
      _updateSidebarToggleBtn();
      // Ensure search input exists but shows empty state
      _ensureSessionSearch();
      return;
    }
    if (layout) layout.classList.add('has-sessions');
    saveSessionsToStorage();
    _updateSidebarToggleBtn();
    _ensureSessionSearch();

    if (el) {
      const filtered = _sessionFilter
        ? _sessionList.filter(s => {
            const title = (s.custom_title || s.title || s.session_id || '').toLowerCase();
            const topic = (s.topic || '').toLowerCase();
            const preview = (s.last_preview || '').toLowerCase();
            return title.includes(_sessionFilter) || topic.includes(_sessionFilter) || preview.includes(_sessionFilter);
          })
        : _sessionList;
      el.innerHTML = _sessionSortMode === 'recent' ? _buildRecentHtml(filtered, false) : _buildGroupedHtml(filtered, false);
      _handleSessionListEvents(el, false);
      // Mark groups that contain the active session
      el.querySelectorAll('.session-group').forEach(g => {
        g.classList.toggle('has-active', !!g.querySelector('.session-item.active'));
      });
      // Scroll active item into view
      const activeItem = el.querySelector('.session-item.active');
      if (activeItem) activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      // Flash newly created session
      if (_newSessionId) {
        const newItem = el.querySelector(`.session-item[data-sid="${CSS.escape(_newSessionId)}"]`);
        if (newItem) {
          newItem.classList.add('session-new-flash');
          setTimeout(() => newItem.classList.remove('session-new-flash'), 2800);
        }
        _newSessionId = null;
      }
    }
    _updateActiveTopicColor();
    updateSessionBadge();
    renderSessionDrawer(list);
    _syncSortBtns();
  }

  function _buildRecentHtml(list, showTopicDot) {
    const main = list.find(s => s.session_id === 'jarvis-main');
    const heartbeat = list.find(s => s.session_id === 'jarvis-heartbeat');
    const rest = list.filter(s => s.session_id !== 'jarvis-main' && s.session_id !== 'jarvis-heartbeat');
    const sorted = rest.sort((a, b) => {
      const ta = a.last_message || a.created_at || '';
      const tb = b.last_message || b.created_at || '';
      return tb.localeCompare(ta);
    });
    const pinned = (main ? _sessionItemHtml(main, false) : '') + (heartbeat ? _sessionItemHtml(heartbeat, false) : '');
    return pinned + sorted.map(s => _sessionItemHtml(s, showTopicDot)).join('');
  }

  function _syncSortBtns() {
    const tBtn = document.getElementById('sessions-sort-topic');
    const rBtn = document.getElementById('sessions-sort-recent');
    if (tBtn) tBtn.classList.toggle('active', _sessionSortMode === 'topic');
    if (rBtn) rBtn.classList.toggle('active', _sessionSortMode === 'recent');
  }

  // ── Mobile Session Drawer ──────────────────────────────────────────────
  function renderSessionDrawer(list) {
    const drawerList = document.getElementById('session-drawer-list');
    if (!drawerList || !list) return;
    const html = _sessionSortMode === 'recent' ? _buildRecentHtml(list, true) : _buildGroupedHtml(list, true);
    drawerList.innerHTML = html;
    _handleSessionListEvents(drawerList, true);
  }

  function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m + 'm ' + (rem < 10 ? '0' : '') + rem + 's';
  }

  function getThinkingLabel(elapsed) {
    // Switch label every 6 seconds for variety
    const idx = Math.floor(elapsed / 6000) % THINKING_LABELS.length;
    return THINKING_LABELS[idx];
  }

  function startThinkingTimer() {
    thinkingStartTime = Date.now();
    if (thinkingTimerInterval) clearInterval(thinkingTimerInterval);
    thinkingTimerInterval = setInterval(updateThinkingDisplay, 200);
  }

  function stopThinkingTimer() {
    if (thinkingTimerInterval) { clearInterval(thinkingTimerInterval); thinkingTimerInterval = null; }
    thinkingStartTime = null;
  }

  function updateThinkingDisplay() {
    if (!thinkingStartTime) return;
    const el = document.querySelector('.chat-thinking-timer');
    if (!el) return;
    const elapsed = Date.now() - thinkingStartTime;
    const label = getThinkingLabel(elapsed);
    el.textContent = label + '... ' + formatDuration(elapsed);
  }

  // ── Tool Use Formatting ────────────────────────────────────────────────────
  function formatToolLabel(tool, input) {
    if (!tool) return 'Working...';
    switch (tool) {
      case 'Read':   return 'Reading ' + (input?.file_path ? shortPath(input.file_path) : 'file') + '...';
      case 'Bash':   return '$ ' + (input?.command ? truncate(input.command, 60) : '...');
      case 'Edit':   return 'Editing ' + (input?.file_path ? shortPath(input.file_path) : 'file') + '...';
      case 'Grep':   return 'Searching for "' + (input?.pattern ? truncate(input.pattern, 40) : '...') + '"...';
      case 'Write':  return 'Writing ' + (input?.file_path ? shortPath(input.file_path) : 'file') + '...';
      case 'Glob':   return 'Finding files ' + (input?.pattern ? truncate(input.pattern, 40) : '...') + '...';
      case 'Agent':  return 'Agent: ' + (input?.description || input?.prompt?.slice(0,50) || 'subagent') + '...';
      case 'Skill':  return 'Skill: ' + (input?.skill || '...') + (input?.args ? ' ' + truncate(input.args, 30) : '');
      case 'TodoWrite': return 'Updating tasks...';
      case 'WebSearch': return 'Searching web: ' + (input?.query ? truncate(input.query, 50) : '...');
      case 'WebFetch':  return 'Fetching ' + (input?.url ? truncate(input.url, 50) : '...');
      default:       return 'Using ' + tool + '...';
    }
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

  function renderToolsHtml(tools) {
    if (!tools || !tools.length) return '';
    const lines = tools.map(t => {
      const cls = t.done ? 'chat-tool-use done' : 'chat-tool-use';
      const icon = toolIcon(t.tool);
      const color = toolColor(t.tool);
      const doneColor = '#4ade80';
      const label = escapeHtml(formatToolLabel(t.tool, t.input));
      return `<div class="${cls}"><span class="tool-icon" style="color:${t.done ? doneColor : color}">${icon}</span><span class="tool-label">${label}</span><span class="tool-spinner" style="border-color:${color};border-top-color:transparent"></span><span class="tool-check">\u2713</span></div>`;
    }).join('');
    return `<div class="chat-tools-block">${lines}</div>`;
  }

  function toolNarration(tool, input) {
    switch (tool) {
      case 'Read': return 'Ich schau mir mal eine Datei an.';
      case 'Bash': return 'Ich fuehre kurz was aus.';
      case 'Edit': case 'Write': return 'Ich aendere gerade Code.';
      case 'Grep': return 'Ich suche kurz was.';
      case 'Glob': return 'Ich schaue welche Dateien es gibt.';
      case 'Agent': return 'Ich starte einen Subagent.';
      default: return null;
    }
  }

  function toolIcon(tool) {
    switch (tool) {
      case 'Read': return '\u25B8';
      case 'Bash': return '$';
      case 'Edit': case 'Write': return '\u270E';
      case 'Grep': return '\u2315';
      case 'Glob': return '\u2302';
      case 'Agent': return '\u2261';
      case 'Skill': return '\u2726';
      case 'TodoWrite': return '\u2611';
      case 'WebSearch': case 'WebFetch': return '\u2601';
      default: return '\u25CB';
    }
  }

  function toolColor(tool) {
    switch (tool) {
      case 'Read': return '#60a5fa';        // blue
      case 'Bash': return '#fbbf24';        // yellow
      case 'Edit': case 'Write': return '#f97316';  // orange
      case 'Grep': case 'Glob': return '#a78bfa';   // purple
      case 'Agent': return '#2dd4bf';       // teal
      case 'Skill': return '#4ade80';       // green
      case 'TodoWrite': return '#f472b6';   // pink
      case 'WebSearch': case 'WebFetch': return '#38bdf8'; // sky
      default: return '#94a3b8';            // gray
    }
  }

  // Per-message stats (duration, tokens, cost — no context)
  function renderMsgStatsHtml(stats) {
    if (!stats) return '';
    const dur = stats.duration_ms ? (stats.duration_ms / 1000).toFixed(1) + 's' : '';
    const tIn = stats.input_tokens ? formatTokens(stats.input_tokens) + ' in' : '';
    const tOut = stats.output_tokens ? formatTokens(stats.output_tokens) + ' out' : '';
    const cost = stats.cost_usd != null ? '$' + stats.cost_usd.toFixed(4) : '';
    const parts = [dur, tIn, tOut, cost].filter(Boolean);
    if (!parts.length) return '';
    return `<div class="chat-stats">${parts.map(p => `<span>${p}</span>`).join('')}</div>`;
  }

  // Topbar: session totals + context meter
  function updateTopbarStats(lastMsgStats, reset = false) {
    const el = document.getElementById('chat-topbar-stats');
    if (!el) return;
    
    if (reset) _lastMsgStats = null;

    // Merge with cached stats if it's a partial update
    if (lastMsgStats) {
      if (!_lastMsgStats) _lastMsgStats = {};
      Object.assign(_lastMsgStats, lastMsgStats);
    }
    const st = sessionTotals;
    const stats = _lastMsgStats;
    
    const totalTokens = st.input_tokens + st.output_tokens;
    const tTotal = totalTokens ? formatTokens(totalTokens) + ' tokens' : '';
    const cost = st.cost_usd ? '$' + st.cost_usd.toFixed(4) : '';
    const parts = [tTotal, cost].filter(Boolean);
    let html = '';
    
    // Show model badge
    if (stats?.model) {
      const m = stats.model;
      const p = stats.provider || '';
      let display = m;
      const pShort = { 
        'claude-cli': 'Claude', 
        'codex-cli': 'Codex', 
        'gemini-cli': 'Gemini', 
        'claude-api': 'Claude API', 
        'openai': 'OpenAI' 
      };
      
      const isGeneric = (m === '(Auto)' || m === 'default' || !m || m.toLowerCase() === 'auto');
      const providerName = pShort[p] || p;

      if (isGeneric && providerName) {
        display = providerName + ' (Auto)';
      } else if (providerName && !m.toLowerCase().includes(providerName.toLowerCase())) {
        display = providerName + ' · ' + m;
      }
      
      const colors = { haiku: '#22c55e', sonnet: '#3b82f6', opus: '#a855f7', gemini: '#3b82f6', codex: '#10b981' };
      const c = colors[m.toLowerCase()] || 
                (m.toLowerCase().includes('sonnet') ? '#3b82f6' : 
                 m.toLowerCase().includes('opus') ? '#a855f7' : 
                 m.toLowerCase().includes('haiku') ? '#22c55e' : 
                 m.toLowerCase().includes('gemini') ? '#3b82f6' :
                 m.toLowerCase().includes('gpt-4') ? '#10b981' :
                 m.toLowerCase().includes('gpt-5') ? '#10b981' :
                 '#6b7280');
      html += `<span class="model-badge" style="color:${c};border-color:${c}40">${display}</span>`;
    }
    html += parts.map(p => `<span>${p}</span>`).join('');
    if (stats?.context_pct != null) {
      const pct = stats.context_pct;
      const color = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#22c55e';
      html += `<span class="ctx-meter" title="Context: ${formatTokens(stats.context_used || 0)} / ${formatTokens(stats.context_window || 0)}"><span class="ctx-bar" style="width:${Math.min(pct, 100)}%;background:${color}"></span>${pct}%</span>`;
      if (pct > 90) {
        html += `<span class="ctx-warn">Neue Session empfohlen</span>`;
      }
      _updateContextBanner(pct);
    }

    // Message count — always visible
    const msgCount = sessionTotals.messages;
    if (msgCount > 0) {
      const msgColor = msgCount >= 100 ? '#ef4444' : msgCount >= 80 ? '#f59e0b' : '#94a3b8';
      html += `<span class="ctx-msg-count" style="color:${msgColor}" title="${msgCount} Nachrichten in dieser Session">${msgCount} msg</span>`;
    }

    // Compress button: >= 80 messages or context >= 75%
    const ctxHigh = stats?.context_pct != null && stats.context_pct >= 75;
    if (msgCount >= 80 || ctxHigh) {
      const urgent = msgCount >= 100 || (stats?.context_pct ?? 0) >= 90;
      html += `<button class="ctx-compress-btn${urgent ? ' ctx-compress-urgent' : ''}" onclick="MC.chat.compressSession()" title="Kontext komprimieren">⚡ Komprimieren</button>`;
    }

    el.innerHTML = html;
  }

  async function compressSession() {
    if (!activeSession) return;
    if (isStreaming) return;
    const btn = document.querySelector('.ctx-compress-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Komprimiere...'; }
    try {
      const res = await fetch(`/api/chat/session/${activeSession}/compress`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        console.error('[Compress] Fehler:', data.error);
        if (btn) { btn.disabled = false; btn.textContent = '⚡ Komprimieren'; }
      }
      // UI-Reload kommt via chat.compressed WS event
    } catch (e) {
      console.error('[Compress] Netzwerkfehler:', e);
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Komprimieren'; }
    }
  }

  function sendCompact() {
    _dismissCtxBanner();
    const input = document.getElementById('chat-input');
    if (!input || isStreaming) return;
    input.value = '/compact';
    sendMessage();
  }

  let _bannerDismissedAt = 0;
  function _updateContextBanner(pct) {
    const banner = document.getElementById('ctx-banner');
    if (!banner) return;
    // Don't re-show if dismissed within last 5 messages
    if (_bannerDismissedAt && (sessionTotals.messages - _bannerDismissedAt) < 5) return;
    if (pct >= 80) {
      const isCrit = pct >= 90;
      banner.className = isCrit ? 'ctx-banner-crit' : 'ctx-banner-warn';
      const icon = isCrit ? '🔴' : '🟡';
      const msg = isCrit
        ? `${icon} Kontext ${pct}% voll — Session läuft bald über.`
        : `${icon} Kontext ${pct}% voll — /compact empfohlen.`;
      banner.innerHTML = `
        <span class="ctx-banner-msg">${msg}</span>
        <button onclick="MC.chat.sendCompact()">Jetzt komprimieren</button>
        <button class="ctx-banner-dismiss" onclick="MC.chat._dismissCtxBanner()" title="Schließen">✕</button>
      `;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  function _dismissCtxBanner() {
    _bannerDismissedAt = sessionTotals.messages;
    const b = document.getElementById('ctx-banner');
    if (b) b.style.display = 'none';
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // ── Render Messages ────────────────────────────────────────────────────────
  function renderMessages() {
    const el = document.getElementById('chat-messages');
    if (!messages.length) {
      el.innerHTML = `<div class="chat-empty-state">
        <div class="chat-empty-icon">J</div>
        <div class="chat-empty-text">Starte eine Unterhaltung mit Jarvis.</div>
      </div>`;
      return;
    }

    let html = '<div class="chat-spacer"></div>';
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const prev = i > 0 ? messages[i - 1] : null;
      const sameSender = prev && prev.role === m.role;
      const streaming = (i === messages.length - 1 && m.role === 'assistant' && isStreaming);

      // System-Message (Provider-Switch-Hinweis etc.): dezent, mittig, kein Avatar.
      // Zeigt Timestamp damit historische Banner nicht wie aktuelle Events wirken.
      if (m.role === 'system') {
        const sysText = (m.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const ts = m.timestamp ? new Date(m.timestamp) : null;
        const nowMs = Date.now();
        const age = ts ? nowMs - ts.getTime() : 0;
        // Jüngster Banner (< 10 s) markanter, ältere dezenter
        const isRecent = ts && age < 10000;
        const tsLabel = ts
          ? (isRecent ? 'jetzt' : ts.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }))
          : '';
        const bg = isRecent ? 'rgba(52,211,153,0.10)' : 'rgba(148,163,184,0.06)';
        const border = isRecent ? 'rgba(52,211,153,0.35)' : 'rgba(148,163,184,0.15)';
        const color = isRecent ? '#34d399' : '#64748b';
        html += `<div class="chat-system-line" style="margin:10px auto;max-width:80%;padding:5px 12px;background:${bg};border:1px solid ${border};border-radius:14px;color:${color};font-size:11px;text-align:center;font-style:italic;display:flex;align-items:center;justify-content:center;gap:8px">`
              + `<span>${sysText}</span>`
              + (tsLabel ? `<span style="opacity:0.6;font-size:10px;font-style:normal">· ${tsLabel}</span>` : '')
              + `</div>`;
        continue;
      }

      // sameSender-Lookup: system-Messages überspringen, damit assistant→system→assistant
      // visuell als zusammenhängender Block gerendert wird (Bubble-Clustering erhalten).
      let prevReal = prev;
      let j = i - 1;
      while (prevReal && prevReal.role === 'system' && j > 0) {
        j--;
        prevReal = messages[j];
      }
      const sameSenderReal = prevReal && prevReal.role === m.role && prevReal.role !== 'system';

      const avatarLetter = m.role === 'assistant' ? 'J' : 'R';
      const senderName = m.role === 'assistant' ? 'Jarvis' : 'Robin';
      const time = formatTime(m.timestamp);
      const toolsHtml = m.role === 'assistant' ? renderToolsHtml(m.tools) : '';
      const content = renderMarkdown(m.content || '');
      const attHtml = renderMessageAttachments(m.attachments);
      const hasContent = (m.content || '').trim().length > 0;
      const typingHtml = streaming ? `<div class="chat-thinking"><div class="chat-thinking-dots"><span></span><span></span><span></span></div><span class="chat-thinking-timer">thinking... 0s</span><button class="chat-thinking-cancel" onclick="MC.chat.cancelStream()" title="Abbrechen">Abbrechen</button></div>` : '';
      const statsHtml = (!streaming && m.role === 'assistant' && m.stats) ? renderMsgStatsHtml(m.stats) : '';
      const showMeta = !sameSenderReal;

      html += `<div class="chat-msg-row ${m.role}${sameSender ? '' : ' gap-top'}">
        ${showMeta ? `<div class="chat-avatar ${m.role}">${avatarLetter}</div>` : '<div class="chat-avatar-spacer"></div>'}
        <div class="chat-msg-content">
          ${showMeta ? `<div class="chat-msg-meta"><span class="chat-msg-name">${senderName}</span><span class="chat-msg-time">${time}</span></div>` : ''}
          <div class="chat-bubble ${m.role}${streaming ? ' streaming' : ''}" ${_activeTopicColor && m.role === 'user' ? `style="--topic-color:${_activeTopicColor}"` : ''}>${toolsHtml}${content}${attHtml}${typingHtml}</div>${statsHtml}
        </div>
      </div>`;
    }

    el.innerHTML = html;

    el.querySelectorAll('.chat-bubble pre').forEach(pre => {
      if (!pre.querySelector('.copy-btn')) {
        const btn = document.createElement('button'); btn.className = 'copy-btn'; btn.textContent = 'Copy';
        btn.addEventListener('click', () => {
          const code = pre.querySelector('code');
          navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
          btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500);
        });
        pre.appendChild(btn);
      }
    });

    if (!userScrolledUp) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }

  function renderMessageAttachments(attachments) {
    if (!attachments || !attachments.length) return '';
    const items = attachments.map(att => {
      if (att.type && att.type.startsWith('image/') && att.localURL)
        return `<img class="msg-att-img" src="${escapeHtml(att.localURL)}" alt="${escapeHtml(att.originalName)}">`;
      const icon = att.type?.startsWith('audio/') ? '\u{1F3B5}' : att.type === 'application/pdf' ? '\u{1F4C4}' : '\u{1F4DD}';
      return `<span class="msg-att-chip">${icon} ${escapeHtml(att.originalName)}</span>`;
    }).join('');
    return `<div class="msg-attachments">${items}</div>`;
  }

  function updateLastMessage() {
    const el = document.getElementById('chat-messages');
    const lastRow = el.querySelector('.chat-msg-row:last-child');
    if (lastRow && lastRow.classList.contains('assistant')) {
      const bubble = lastRow.querySelector('.chat-bubble');
      if (bubble) {
        const last = messages[messages.length - 1];
        const toolsHtml = renderToolsHtml(last.tools);
        const content = renderMarkdown(last.content);
        const typingHtml = `<div class="chat-thinking"><div class="chat-thinking-dots"><span></span><span></span><span></span></div><span class="chat-thinking-timer">thinking... 0s</span><button class="chat-thinking-cancel" onclick="MC.chat.cancelStream()" title="Abbrechen">Abbrechen</button></div>`;
        bubble.innerHTML = toolsHtml + content + typingHtml;
        if (!userScrolledUp) {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
      }
    }
  }

  // ── Markdown / HTML ────────────────────────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';
    const codeBlocks = [];
    // Fenced code blocks
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      codeBlocks.push(`<pre><code${cls}>${escapeHtml(code.trim())}</code></pre>`);
      return `%%CB_${codeBlocks.length - 1}%%`;
    });
    // Inline code (before other inline formatting)
    text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
    // Strikethrough ~~text~~
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Bold + italic (order matters: bold before italic)
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Highlight ==text==
    text = text.replace(/==(.+?)==/g, '<mark>$1</mark>');
    // Headings
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Blockquote (> text) — group consecutive lines
    text = text.replace(/((?:^> .+\n?)+)/gm, (block) => {
      const inner = block.replace(/^> /gm, '').trim();
      return `<blockquote>${inner}</blockquote>\n`;
    });
    // Horizontal rule
    text = text.replace(/^(?:---+|===+|\*\*\*+)$/gm, '<hr>');
    // Simple Markdown tables (| col | col |)
    text = text.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
      const rows = block.trim().split('\n').filter(r => r.trim());
      if (rows.length < 2) return block;
      const isSep = (r) => /^\|[\s\-:|]+\|/.test(r);
      let html = '<table class="md-table"><thead><tr>';
      const headers = rows[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
      headers.forEach(h => { html += `<th>${h.trim()}</th>`; });
      html += '</tr></thead><tbody>';
      for (let i = 1; i < rows.length; i++) {
        if (isSep(rows[i])) continue;
        const cells = rows[i].split('|').filter((_, j, a) => j > 0 && j < a.length - 1);
        html += '<tr>' + cells.map(c => `<td>${c.trim()}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      return html;
    });
    // Lists (unordered and ordered) — wrap consecutive items
    text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
    text = text.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
    text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    // Links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Images (standalone)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:6px;margin:4px 0">');
    // Newlines — avoid double-br after block elements
    text = text.replace(/\n{3,}/g, '<br><br>');
    text = text.replace(/\n/g, '<br>');
    // Restore code blocks
    codeBlocks.forEach((b, i) => { text = text.replace(`%%CB_${i}%%`, b); });
    return text;
  }

  function escapeHtml(t) {
    if (!t) return '';
    const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
  }

  // Public API for voice listener to send messages programmatically
  function sendVoiceMessage(text) {
    if (!text) return;
    if (isStreaming) {
      // Queue the message — will be sent when current response finishes
      _voiceQueue = text;
      console.log('[Chat] Session busy — voice message queued:', text);
      return 'queued';
    }
    // Switch to chat view
    const chatNav = document.querySelector('.nav-item[data-view="chat"]');
    if (chatNav) chatNav.click();
    // Inject text and send
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    }
    sendMessage();
    return 'sent';
  }

  function _setVoiceQueue(text) {
    if (isStreaming) {
      _voiceQueue = text;
    } else {
      // Not streaming — navigate to chat and fill input for manual review/send
      const chatNav = document.querySelector('.nav-item[data-view="chat"]');
      if (chatNav) chatNav.click();
      const input = document.getElementById('chat-input');
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event('input'));
        setTimeout(() => input.focus(), 100);
      }
    }
  }

  let _currentModel = 'claude';

  function toggleModel() {
    _currentModel = _currentModel === 'claude' ? 'gemini' : 'claude';
    MC.ws.send({ type: 'chat.set_model', model: _currentModel });
    const btn = document.getElementById('btn-model-toggle');
    const banner = document.getElementById('fallback-banner');
    if (_currentModel === 'gemini') {
      if (btn) { btn.textContent = '🤖 Claude'; btn.style.color = '#34d399'; btn.style.borderColor = '#34d399'; }
      if (banner) { banner.textContent = '⚡ Gemini-Modus aktiv'; banner.style.display = 'block'; }
    } else {
      if (btn) { btn.textContent = '⚡ Gemini'; btn.style.color = '#a78bfa'; btn.style.borderColor = '#444'; }
      if (banner) banner.style.display = 'none';
    }
  }

  function setSortMode(mode) {
    _sessionSortMode = mode;
    try { localStorage.setItem('mc_session_sort', mode); } catch(_) {}
    renderSessions(_sessionList);
    // Sync multi-chat picker if open
    if (window._mcPickerResort) window._mcPickerResort();
  }

  return { init, sendVoiceMessage, _setVoiceQueue, toggleModel, toggleSidebar,
           setSortMode, cancelStream: cancelMessage,
           buildGroupedHtml: _buildGroupedHtml, buildRecentHtml: _buildRecentHtml,
           showTopicMenu: _showTopicMenu,
           sendCompact, _dismissCtxBanner,
           getSessionList: () => _sessionList,
           get isStreaming() { return isStreaming; },
           get activeSession() { return activeSession; } };
})();
