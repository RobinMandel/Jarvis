// Voice Listener — "Jarvis" Wake Word → Chat-Nachricht
// Auto-Send nach ~10s Stille: busy = Queue, idle = Send
MC.voiceListener = (function () {
  'use strict';

  const WAKE_WORDS = ['jarvis', 'jervis', 'javis', 'jarwis'];
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const AUTO_SEND_DELAY = 10000; // ms Stille bis Auto-Aktion

  let recognition = null;
  let isListening = false;
  let isPaused = false;
  let isCapturing = false;
  let skipCurrentUtterance = false;
  let captureBuffer = [];
  let safetyTimeout = null;
  let autoSendTimer = null;
  let history = [];

  // DOM refs
  let btn, dot, label, dropdown, statusEl, liveEl, historyEl, closeBtn, sendBtn, queueBtn, actionBtns;

  function init() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      console.warn('[VoiceListener] Speech Recognition not supported');
      const wrap = document.getElementById('vl-topbar-wrap');
      if (wrap) wrap.style.display = 'none';
      return;
    }

    btn      = document.getElementById('vl-topbar-btn');
    dot      = document.getElementById('vl-dot');
    label    = document.getElementById('vl-btn-label');
    dropdown = document.getElementById('vl-dropdown');
    statusEl = document.getElementById('vl-status');
    liveEl   = document.getElementById('vl-live');
    historyEl = document.getElementById('vl-history');
    closeBtn  = document.getElementById('vl-dropdown-close');
    sendBtn    = document.getElementById('vl-send-btn');
    queueBtn   = document.getElementById('vl-queue-btn');
    actionBtns = document.getElementById('vl-action-btns');

    if (!btn) return;

    try {
      const saved = JSON.parse(localStorage.getItem('vl_history') || '[]');
      history = saved.slice(-20);
    } catch (_) {}
    renderHistory();

    btn.addEventListener('click', handleBtnClick);

    if (closeBtn) closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDropdown();
    });

    if (sendBtn) sendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('[VL] Send clicked — buf:', captureBuffer.length);
      if (captureBuffer.length > 0) {
        isCapturing = true;
        finishCapture();
      } else if (isCapturing) {
        skipCurrentUtterance = false;
        finishCapture();
      } else {
        updateUI('listening', 'Noch kein Text aufgenommen');
        setTimeout(() => updateUI('listening', 'Warte auf "Jarvis"...'), 2000);
      }
    });

    if (queueBtn) queueBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('[VL] Queue clicked — buf:', captureBuffer.length);
      if (captureBuffer.length > 0) {
        isCapturing = true;
        finishCapture(true);  // true = queue mode
      } else {
        updateUI('listening', 'Noch kein Text aufgenommen');
        setTimeout(() => updateUI('listening', 'Warte auf "Jarvis"...'), 2000);
      }
    });

    document.addEventListener('click', (e) => {
      if (dropdown && dropdown.classList.contains('open') && !e.target.closest('.vl-topbar-wrap')) {
        closeDropdown();
      }
    });

    setupRecognition();
    if (isIOS) {
      // iOS requires a user gesture before recognition.start() — don't auto-start
      updateUI('off', 'Tippen zum Aktivieren');
    } else {
      startListener();
    }
  }

  function handleBtnClick(e) {
    e.stopPropagation();
    if (isCapturing) {
      // Click during capture = send immediately
      finishCapture();
    } else if (!isListening) {
      // On iOS (or if stopped): tap to start listener with user gesture
      startListener();
    } else {
      // Toggle dropdown
      if (dropdown.classList.contains('open')) {
        closeDropdown();
      } else {
        dropdown.classList.add('open');
      }
    }
  }

  function openDropdown() {
    if (!dropdown || !btn) return;
    const r = btn.getBoundingClientRect();
    const dropW = 280;
    let left = r.right - dropW;
    if (left < 8) left = 8;
    if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8;
    dropdown.style.top  = (r.bottom + 8) + 'px';
    dropdown.style.left = left + 'px';
    dropdown.style.right = 'auto';
    dropdown.classList.add('open');
  }
  function closeDropdown() { if (dropdown) dropdown.classList.remove('open'); }

  function setupRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.continuous     = !isIOS; // iOS Safari doesn't support continuous reliably
    recognition.interimResults = true;
    recognition.lang           = 'de-DE';
    recognition.maxAlternatives = 1;
    recognition.onresult = handleResult;
    recognition.onend    = handleEnd;
    recognition.onerror  = handleError;
  }

  function resetAutoSendTimer() {
    if (autoSendTimer) clearTimeout(autoSendTimer);
    autoSendTimer = setTimeout(() => {
      autoSendTimer = null;
      if (!isCapturing || captureBuffer.length === 0) return;
      const queueMode = !!(MC.chat && MC.chat.isStreaming);
      console.log('[VL] Auto-send after silence — queueMode:', queueMode);
      updateUI('sending', queueMode ? 'Auto-Queue...' : 'Auto-Sende...');
      finishCapture(queueMode);
    }, AUTO_SEND_DELAY);
  }

  function clearAutoSendTimer() {
    if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
  }

  function handleResult(event) {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result     = event.results[i];
      const transcript = result[0].transcript.toLowerCase().trim();

      if (!isCapturing) {
        // Passive: listen for wake word
        if (WAKE_WORDS.some(w => transcript.includes(w))) {
          console.log('[VL] Wake word in:', transcript);
          startCapture();
        }

      } else if (skipCurrentUtterance) {
        // This is the utterance that triggered the wake word — skip it
        if (result.isFinal) {
          skipCurrentUtterance = false;
          console.log('[VL] Wake utterance done:', result[0].transcript.trim());
          // Extract anything said AFTER "Jarvis" in the same breath
          const m = result[0].transcript.match(/(?:hey\s+)?(?:jarvis|jervis|javis|jarwis)[,\s.]*([\s\S]+)/i);
          if (m && m[1].trim().length > 1) {
            captureBuffer.push(m[1].trim());
            showLive(m[1].trim());
            resetAutoSendTimer();
          }
          updateUI('capturing', captureBuffer.length + ' Saetze — Auto-Sende nach ~10s Stille');
        }

      } else {
        // Active capture — reset silence timer on any speech activity
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          console.log('[VL] Final:', text, '| buf:', captureBuffer.length);
          if (text.length > 0) {
            captureBuffer.push(text);
            showLive(text);
            updateUI('capturing', captureBuffer.length + ' Saetze — Auto-Sende nach ~10s Stille');
            resetAutoSendTimer();
          }
        } else {
          showLive(result[0].transcript.trim(), true);
          // Interim = Robin spricht noch → Timer zurücksetzen
          if (captureBuffer.length > 0) resetAutoSendTimer();
        }
      }
    }
  }

  function startCapture() {
    isCapturing = true;
    skipCurrentUtterance = true;
    captureBuffer = [];
    if (safetyTimeout) clearTimeout(safetyTimeout);
    // Safety: auto-send after 10 minutes
    safetyTimeout = setTimeout(() => {
      if (isCapturing) { console.log('[VL] 10min safety timeout'); finishCapture(); }
    }, 600000);
    // Failsafe: if wake word utterance never finalizes, exit skip mode after 3s
    setTimeout(() => {
      if (isCapturing && skipCurrentUtterance) {
        console.log('[VL] skipCurrentUtterance stuck — force-reset after 3s');
        skipCurrentUtterance = false;
        updateUI('capturing', '0 Saetze — Auto-Sende nach ~10s Stille');
      }
    }, 3000);
    updateUI('capturing', 'Hoere zu...');
    openDropdown();
    showSendBtn(true);
    playTone(880, 0.08, 0.15);
    console.log('[VL] Capture started');
  }

  async function finishCapture(queueMode) {
    console.log('[VL] finishCapture — queue:', !!queueMode, 'buffer:', captureBuffer.length, captureBuffer);
    clearAutoSendTimer();
    isCapturing = false;
    skipCurrentUtterance = false;
    if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
    showSendBtn(false);
    showLive('');

    if (captureBuffer.length === 0) {
      updateUI('listening', 'Nichts aufgenommen');
      setTimeout(() => updateUI('listening', 'Warte auf "Jarvis"...'), 2000);
      return;
    }

    const fullText = captureBuffer.join(' ').trim();

    // Routing: Text landet im aktiven Raum/Panel, nicht im Hauptchat.
    const view = (MC.getCurrentView && MC.getCurrentView()) || null;
    const arenaRoom = (MC.arena && MC.arena.getActiveRoomId && MC.arena.getActiveRoomId()) || null;
    if (view === 'arena' && arenaRoom && MC.arena && MC.arena.injectText) {
      console.log('[VL] Routing to arena room:', arenaRoom);
      updateUI('sending', 'Arena: ' + arenaRoom.slice(0, 8) + '...');
      try {
        const ok = await MC.arena.injectText(arenaRoom, fullText);
        if (ok) {
          addToHistory('[Arena] ' + fullText);
          updateUI('sent', 'An Arena gesendet');
          playTone(660, 0.06, 0.15, 880);
        } else {
          updateUI('error', 'Arena-Send fehlgeschlagen');
        }
      } catch (e) {
        updateUI('error', 'Fehler: ' + e.message);
      }
      captureBuffer = [];
      setTimeout(() => { if (isListening && !isCapturing) updateUI('listening', 'Warte auf "Jarvis"...'); }, 3000);
      return;
    }

    // Multi-Chat: in den fokussierten Panel schicken, nicht in den Hauptchat.
    if (view === 'multichat' && MC.multiChat && MC.multiChat.sendToActivePanel) {
      console.log('[VL] Routing to multichat active panel');
      updateUI('sending', 'Multi-Chat Panel...');
      try {
        const ok = MC.multiChat.sendToActivePanel(fullText);
        if (ok) {
          addToHistory('[Panel] ' + fullText);
          updateUI('sent', 'An Panel gesendet');
          playTone(660, 0.06, 0.15, 880);
        } else {
          updateUI('error', 'Kein Panel bereit');
        }
      } catch (e) {
        updateUI('error', 'Fehler: ' + e.message);
      }
      captureBuffer = [];
      setTimeout(() => { if (isListening && !isCapturing) updateUI('listening', 'Warte auf "Jarvis"...'); }, 3000);
      return;
    }

    if (queueMode) {
      // Queue mode: bewusst in den Hauptchat-Queue legen.
      // Warnen wenn Robin eigentlich in einem Raum steht — Queue gehoert dort nicht hin.
      if (view === 'arena' || view === 'multichat') {
        console.warn('[VL] Queue-Mode im Raum (' + view + ') — geht trotzdem in Hauptchat-Queue');
      }
      updateUI('sent', 'In Warteschlange');
      addToHistory('[Q] ' + fullText);
      if (MC.chat && MC.chat.sendVoiceMessage) {
        // Force into queue by setting _voiceQueue directly
        MC.chat._setVoiceQueue(fullText);
      }
      playTone(440, 0.06, 0.2);
      captureBuffer = [];
      setTimeout(() => { if (isListening && !isCapturing) updateUI('listening', 'Warte auf "Jarvis"...'); }, 3000);
      return;
    }

    updateUI('sending', 'Sende...');

    try {
      if (MC.chat && MC.chat.sendVoiceMessage) {
        const res = MC.chat.sendVoiceMessage(fullText);
        addToHistory(fullText);
        if (res === 'queued') {
          updateUI('sent', 'In Warteschlange');
          playTone(440, 0.06, 0.2);
        } else {
          updateUI('sent', 'Gesendet!');
          playTone(660, 0.06, 0.15, 880);
        }
      } else {
        // Fallback: queue the message instead of blindly clicking send
        if (MC.chat && MC.chat._setVoiceQueue) {
          MC.chat._setVoiceQueue(fullText);
          addToHistory('[Q] ' + fullText);
          updateUI('sent', 'In Warteschlange (Fallback)');
          playTone(440, 0.06, 0.2);
        } else {
          updateUI('error', 'Chat nicht verfügbar');
        }
      }
    } catch (e) {
      updateUI('error', 'Fehler: ' + e.message);
    }

    captureBuffer = [];
    setTimeout(() => {
      if (isListening && !isCapturing) updateUI('listening', 'Warte auf "Jarvis"...');
    }, 3000);
  }

  function showSendBtn(visible) {
    if (actionBtns) actionBtns.style.display = visible ? 'flex' : 'none';
  }

  function addToHistory(text) {
    const now = new Date();
    const t = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    history.push({ text, time: t });
    if (history.length > 20) history.shift();
    try { localStorage.setItem('vl_history', JSON.stringify(history)); } catch (_) {}
    renderHistory();
  }

  function handleEnd() {
    console.log('[VL] onend — isCapturing:', isCapturing, 'buf:', captureBuffer.length);
    if (isListening && !isPaused) {
      setTimeout(() => {
        try {
          recognition.start();
          console.log('[VL] restarted');
        } catch (_) {
          setTimeout(() => { try { recognition.start(); } catch (_) {} }, 1000);
        }
      }, 300);
    }
  }

  function handleError(e) {
    console.log('[VL] error:', e.error);
    if (e.error === 'not-allowed') {
      updateUI('error', 'Mikro blockiert');
      isListening = false;
      return;
    }
    if (isListening) {
      setTimeout(() => {
        if (!isPaused) { try { recognition.start(); } catch (_) {} }
      }, e.error === 'aborted' ? 200 : 500);
    }
  }

  function startListener() {
    if (!recognition) return;
    isListening = true;
    isCapturing = false;
    skipCurrentUtterance = false;
    captureBuffer = [];
    updateUI('listening', 'Warte auf "Jarvis"...');
    try { recognition.start(); } catch (_) {}
  }

  function stopListener() {
    isListening = false;
    isCapturing = false;
    clearAutoSendTimer();
    if (safetyTimeout) clearTimeout(safetyTimeout);
    try { recognition.stop(); } catch (_) {}
    updateUI('off', 'Aus');
    showLive('');
    showSendBtn(false);
  }

  function toggleListener() {
    if (!recognition) return;
    isListening ? stopListener() : startListener();
  }

  // ── UI ───────────────────────────────────────────────────
  function updateUI(state, text) {
    if (btn) {
      btn.classList.toggle('vl-active', state === 'listening' || state === 'sent');
      btn.classList.toggle('vl-capturing-state', state === 'capturing' || state === 'sending');
      // Show stop icon on button while capturing
      const icon = btn.querySelector('.vl-btn-icon');
      if (icon) icon.textContent = isCapturing ? '⏹' : '🎙';
    }
    if (dot) {
      dot.className = 'vl-dot';
      if (state === 'listening')                             dot.classList.add('vl-dot-listening');
      else if (state === 'capturing' || state === 'sending') dot.classList.add('vl-dot-capturing');
      else if (state === 'error')                           dot.classList.add('vl-dot-error');
    }
    if (label) {
      const labels = { off: 'Listener', listening: 'Listening...', capturing: 'Aufnahme', sending: 'Sendet...', sent: 'Gesendet', error: 'Fehler' };
      label.textContent = labels[state] || 'Listener';
    }
    if (statusEl) {
      statusEl.textContent = text || '';
      statusEl.className = 'vl-status';
      if (state === 'listening')                             statusEl.classList.add('vl-status-listening');
      else if (state === 'capturing' || state === 'sending') statusEl.classList.add('vl-status-capturing');
    }
  }

  function showLive(text, interim) {
    // Dropdown live line: italic while interim, upright once finalized
    if (liveEl) {
      if (!text) {
        liveEl.textContent = '';
      } else {
        liveEl.innerHTML = interim
          ? '<span class="vl-interim">' + escHtml(text) + '</span>'
          : escHtml(text);
      }
    }
    // Floating overlay (visible across all pages, incl. Arena) while capturing
    const overlay = document.getElementById('vl-overlay');
    const overlayText = document.getElementById('vl-overlay-text');
    if (!overlay || !overlayText) return;

    const finalPart = (captureBuffer && captureBuffer.length) ? captureBuffer.join(' ') : '';
    const interimPart = (text && interim) ? text : '';

    if (!isCapturing && !finalPart && !interimPart) {
      overlay.classList.remove('vl-overlay-visible');
      overlayText.innerHTML = '';
      return;
    }

    let html = '';
    if (finalPart) html += escHtml(finalPart);
    if (interimPart) {
      if (html) html += ' ';
      html += '<span class="vl-interim">' + escHtml(interimPart) + '</span>';
    } else if (!finalPart && text && !interim) {
      html = escHtml(text);
    }

    overlayText.innerHTML = html;
    if (html && isCapturing) overlay.classList.add('vl-overlay-visible');
    else overlay.classList.remove('vl-overlay-visible');
  }

  function renderHistory() {
    if (!historyEl) return;
    historyEl.innerHTML = history.length === 0 ? '' :
      [...history].reverse().slice(0, 10).map(h =>
        `<div class="vl-history-item">
          <span class="vl-hi-bullet">&#8226;</span>
          <span class="vl-hi-text">${escHtml(h.text)}</span>
          <span class="vl-hi-time">${h.time}</span>
        </div>`
      ).join('');
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Sound ────────────────────────────────────────────────
  function playTone(freq, vol, dur, freq2) {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; gain.gain.value = vol;
      osc.start();
      if (freq2) setTimeout(() => { osc.frequency.value = freq2; }, 100);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.stop(ctx.currentTime + dur);
    } catch (_) {}
  }

  function pause() {
    if (isPaused) return; // Already paused, nothing to do
    isPaused = true;
    isListening = false;
    console.log('[VoiceListener] Paused');
    try { recognition.stop(); } catch (_) {}
    updateUI('off', 'Pausiert (Chat aktiv)');
  }

  function resume() {
    if (!isPaused) return; // Not paused, nothing to do
    isPaused = false;
    console.log('[VoiceListener] Resuming...');
    updateUI('listening', 'Warte auf "Jarvis"...');
    // Wait longer (600ms) to ensure the pause fully completed
    setTimeout(() => {
      try {
        console.log('[VoiceListener] Starting recognition after pause');
        recognition.start();
        isListening = true;
      } catch (e) {
        console.warn('[VoiceListener] Failed to start, retrying in 500ms:', e.message);
        setTimeout(() => {
          try {
            console.log('[VoiceListener] Retry start');
            recognition.start();
            isListening = true;
          } catch (_) {
            console.error('[VoiceListener] Resume failed completely');
          }
        }, 500);
      }
    }, 600);
  }

  // Clean mic reset — used on arena room switch.
  // Cancels any active capture without sending, clears buffer, and restarts recognition
  // so the next wake word starts from a clean state in the new room context.
  function reset() {
    const wasCapturing = isCapturing;
    clearAutoSendTimer();
    isCapturing = false;
    skipCurrentUtterance = false;
    captureBuffer = [];
    if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
    showSendBtn(false);
    showLive('');
    if (wasCapturing) {
      console.log('[VL] reset — aborted capture on room switch');
      playTone(330, 0.04, 0.1);
    }
    if (isListening && recognition && !isPaused) {
      try { recognition.stop(); } catch (_) {}
      updateUI('listening', 'Warte auf "Jarvis"...');
    }
  }

  return { init, start: startListener, stop: stopListener, toggle: toggleListener, pause, resume, reset };
})();
