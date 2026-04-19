// Mission Control — Bot Arena V2: Multi-Bot Discussion Rooms with Orchestrator
(function () {
  let rooms = [];
  let activeRoom = null;
  let _refreshTimer = null;
  let _orchestratorOpen = false;
  let _resultsOpen = false;
  let _meetingMode = false;
  let _meetingRec = null;
  let _meetingMicMuted = false; // Mic-gate during TTS playback
  let _ttsPlaying = false;
  let _ttsQueue = [];
  let _ttsBusy = false;
  let _ttsAutoEnabled = localStorage.getItem('arena_tts_auto') !== 'false'; // Auto-speak bot msgs
  let _sammlerOpen = false;
  let _pageVisible = true;
  let _notifiedRooms = new Set();
  let _spokenMessageIds = new Set(); // Track which messages have been spoken aloud

  // ── Visibility & Notifications ────────────────────────────────────────
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  document.addEventListener('visibilitychange', () => {
    _pageVisible = document.visibilityState === 'visible';
    if (_pageVisible) _notifiedRooms.clear();
  });

  function _notifyBotsWaiting() {
    if (_pageVisible) return;
    const running = rooms.find(r => r.running);
    if (running && !_notifiedRooms.has(running.id) && 'Notification' in window && Notification.permission === 'granted') {
      _notifiedRooms.add(running.id);
      new Notification('Bots warten 🤖', {
        body: `"${running.title}" – neue Nachrichten!`,
        icon: '/favicon.ico',
        tag: 'bot-arena-' + running.id
      });
    }
  }

  const BOT_PRESETS = [
    { name: 'Alpha', model: 'sonnet', color: '#6366f1', persona: 'Du bist ein analytischer Denker. Argumentiere logisch und praezise. Stuetze dich auf Fakten und Evidenz. Wenn andere gute Punkte machen, erkenne das an und baue darauf auf.' },
    { name: 'Beta', model: 'sonnet', color: '#22c55e', persona: 'Du bist ein kreativer Querdenker. Bringe unerwartete Perspektiven ein, aber erkenne auch gute Ideen der anderen an. Nicht immer dagegen — manchmal ist Zustimmung + Erweiterung wertvoller als Widerspruch.' },
    { name: 'Gamma', model: 'sonnet', color: '#f59e0b', persona: 'Du bist ein pragmatischer Umsetzer. Fokussiere auf Machbarkeit und konkrete naechste Schritte. Wenn die Diskussion abdriftet, bringe sie zurueck zum Kern. Baue auf den besten Ideen der anderen auf.' },
    { name: 'Delta', model: 'sonnet', color: '#ec4899', persona: 'Du bist ein Vermittler und Synthesizer. Finde Gemeinsamkeiten zwischen verschiedenen Positionen, fasse Zwischenergebnisse zusammen und schlage Kompromisse vor. Dein Job ist es, die Gruppe voranzubringen.' },
  ];

  const ROOM_CATEGORIES = [
    { id: 'general', label: 'Allgemein', color: '#6b7280', icon: '💬' },
    { id: 'code', label: 'Code & Architektur', color: '#6366f1', icon: '🔧' },
    { id: 'research', label: 'Recherche', color: '#22c55e', icon: '🔍' },
    { id: 'brainstorm', label: 'Brainstorming', color: '#f59e0b', icon: '💡' },
    { id: 'review', label: 'Review & QA', color: '#ef4444', icon: '✓' },
    { id: 'planning', label: 'Planung', color: '#a855f7', icon: '📋' },
  ];

  // ── Helpers ────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function relTime(iso) {
    if (!iso) return '';
    const diff = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (diff < 2) return 'gerade eben';
    if (diff < 60) return `vor ${diff}min`;
    if (diff < 1440) return `vor ${Math.round(diff / 60)}h`;
    return `vor ${Math.round(diff / 1440)}d`;
  }

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getCat(id) {
    return ROOM_CATEGORIES.find(c => c.id === id) || ROOM_CATEGORIES[0];
  }

  // ── Room List ──────────────────────────────────────────────────────────
  async function loadRooms() {
    try {
      const res = await fetch('/api/arena/rooms');
      rooms = await res.json();
    } catch (e) {
      rooms = [];
    }
    renderRoomList();
    _notifyBotsWaiting();
    if (activeRoom && !rooms.find(r => r.id === activeRoom)) {
      _setActiveRoom(null);
      renderRoomView();
    }
  }

  function renderRoomList() {
    const container = el('arena-room-list');
    if (!container) return;

    const meetingCard = `<div onclick="MC.arena.startMeetingRoom()" style="
      padding:10px 13px;border:1.5px solid rgba(16,185,129,0.4);border-radius:8px;
      margin-bottom:10px;cursor:pointer;background:rgba(16,185,129,0.06);
      transition:all 0.15s;display:flex;align-items:center;gap:9px;
      box-shadow:0 0 8px rgba(16,185,129,0.12);"
      onmouseover="this.style.background='rgba(16,185,129,0.12)';this.style.borderColor='rgba(16,185,129,0.7)'"
      onmouseout="this.style.background='rgba(16,185,129,0.06)';this.style.borderColor='rgba(16,185,129,0.4)'">
      <span style="font-size:18px;flex-shrink:0;">🗣</span>
      <div>
        <div style="font-weight:700;font-size:12px;color:#10b981;">Freisprech-Meeting starten</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:1px;">Neuer Dauer-Dialog-Raum + Mikro sofort aktiv</div>
      </div>
      <span style="margin-left:auto;font-size:16px;color:#10b981;opacity:0.7;">→</span>
    </div>`;

    if (rooms.length === 0) {
      container.innerHTML = meetingCard + `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">
        Noch keine Raeume.<br>Erstelle einen neuen Raum um loszulegen.
      </div>`;
      return;
    }

    // Sort: running first, then by last_active
    const sorted = [...rooms].sort((a, b) => {
      if (a.running && !b.running) return -1;
      if (!a.running && b.running) return 1;
      const ta = new Date(a.last_active || a.created || 0).getTime();
      const tb = new Date(b.last_active || b.created || 0).getTime();
      return tb - ta;
    });

    // Group by category
    const grouped = {};
    sorted.forEach(r => {
      const cat = r.category || 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r);
    });

    let html = meetingCard;
    for (const [catId, catRooms] of Object.entries(grouped)) {
      const cat = getCat(catId);
      html += `<div style="margin-bottom:12px;">
        <div style="font-size:10px;font-weight:600;color:${cat.color};text-transform:uppercase;letter-spacing:0.5px;padding:4px 6px;margin-bottom:4px;">${cat.icon} ${cat.label}</div>`;

      catRooms.forEach(r => {
        const isActive = r.id === activeRoom;
        const isRunning = r.running;
        const msgCount = (r.messages || []).length;
        const dotColor = isRunning ? '#22c55e' : '#6b7280';
        html += `<div class="arena-room-card ${isActive ? 'active' : ''}" onclick="MC.arena.openRoom('${r.id}')" style="
          padding:10px 12px;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'};
          border-radius:8px;margin-bottom:6px;cursor:pointer;background:${isActive ? 'rgba(99,102,241,0.08)' : 'var(--bg-tertiary)'};
          transition:all 0.15s;border-left:3px solid ${cat.color};">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0;${isRunning ? 'box-shadow:0 0 6px ' + dotColor + '88;animation:pulse-dot 2s infinite' : ''}"></span>
            <span style="font-weight:600;font-size:12px;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.title)}</span>
            <span style="font-size:10px;color:var(--text-muted);">${msgCount}</span>
          </div>
          <div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${escHtml(r.topic || 'Kein Thema')}
          </div>
          <div style="display:flex;gap:3px;margin-top:5px;flex-wrap:wrap;">
            ${(r.bots || []).map(b => `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${b.color}18;color:${b.color};border:1px solid ${b.color}33;">${escHtml(b.name)}</span>`).join('')}
          </div>
          <div style="font-size:9px;color:var(--text-muted);margin-top:3px;">${relTime(r.last_active || r.created)}</div>
        </div>`;
      });
      html += '</div>';
    }
    container.innerHTML = html;
  }

  // ── Room Detail View ───────────────────────────────────────────────────
  function renderRoomView() {
    const container = el('arena-room-view');
    if (!container) return;

    if (!activeRoom) {
      container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:14px;">
        Waehle einen Raum oder erstelle einen neuen.
      </div>`;
      return;
    }

    const room = rooms.find(r => r.id === activeRoom);
    if (!room) {
      container.innerHTML = `<div style="padding:24px;color:var(--text-muted);">Raum nicht gefunden.</div>`;
      return;
    }

    const isRunning = room.running;
    const cat = getCat(room.category || 'general');
    const hasSummary = room.orchestrator_summary;

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:0;">
        <!-- Header -->
        <div style="padding:10px 16px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span style="font-size:14px;">${cat.icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:14px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(room.title)}</div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:1px;">${escHtml(room.topic || 'Kein Thema')} · ${(room.messages || []).length} Nachrichten</div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0;">
            <button onclick="MC.arena.toggleOrchestrator()" style="background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.25);color:#a855f7;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;font-weight:600;" title="Orchestrator/Richter">Richter</button>
            <button onclick="MC.arena.toggleResults()" style="background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.25);color:#10b981;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;font-weight:600;" title="Ergebnis-Seite: Fortschritt aller Aktionen">Ergebnisse${countRoomResultsBadge(room)}</button>
            <button id="arena-sammler-btn" onclick="MC.arena.toggleSammler()" style="background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;font-weight:600;" title="Aktions-Sammler: Alle Vorschlaege der Bots gebuendelt zur Freigabe">Sammler${countSammlerBadge(room)}</button>
            <button onclick="MC.arena.requestSummary('${room.id}')" style="background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.2);color:#a855f7;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;" title="Zusammenfassung anfordern">Fazit</button>
            <button onclick="MC.arena.editRoom('${room.id}')" style="background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.25);color:#818cf8;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;">Settings</button>
            ${isRunning
              ? `<button onclick="MC.arena.stopRoom('${room.id}')" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.25);color:#ef4444;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;">Stop</button>`
              : `<button onclick="MC.arena.startRoom('${room.id}')" style="background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.25);color:#22c55e;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;">Start</button>`
            }
            <button onclick="MC.arena.deleteRoom('${room.id}')" style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.15);color:#ef4444;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;" title="Loeschen">X</button>
          </div>
        </div>

        <!-- Main area: Messages + Orchestrator panel -->
        <div style="flex:1;display:flex;min-height:0;overflow:hidden;">
          <!-- Messages -->
          <div id="arena-room-drop" style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative;">
            <div id="arena-messages" style="flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:6px;min-height:0;">
              ${renderMessages(room.messages || [])}
            </div>

            <!-- Thinking indicator -->
            <div id="arena-thinking" style="display:none;padding:6px 14px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--border-subtle);flex-shrink:0;">
              <span id="arena-thinking-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;animation:pulse-dot 1.5s infinite;"></span>
              <span id="arena-thinking-text"></span>
            </div>

            <!-- Meeting mode indicator -->
            <div id="arena-meeting-bar" style="display:${_meetingMode ? 'flex' : 'none'};padding:5px 14px;border-top:1px solid rgba(16,185,129,0.25);background:rgba(16,185,129,0.06);align-items:center;gap:6px;flex-shrink:0;">
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;animation:pulse-dot 1s infinite;flex-shrink:0;"></span>
              <span style="font-size:10px;color:#10b981;font-weight:600;white-space:nowrap;">MEETING MODE</span>
              <span id="arena-meeting-status" style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">Sprich frei — jede Aussage geht sofort rein</span>
              <button onclick="MC.arena.toggleMeetingMode('${room.id}')" style="background:none;border:none;color:#10b981;cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0;">&#10005;</button>
            </div>
            <!-- Mode indicator -->
            <div id="arena-mode-bar" style="display:${room.tools_enabled ? 'flex' : 'none'};padding:5px 14px;border-top:1px solid rgba(239,68,68,0.2);background:rgba(239,68,68,0.06);align-items:center;gap:6px;flex-shrink:0;">
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;animation:pulse-dot 1s infinite;"></span>
              <span style="font-size:10px;color:#ef4444;font-weight:600;">EXECUTION MODE</span>
              <span id="arena-exec-turns" style="font-size:10px;color:var(--text-muted);">${room.execution_turns_left || 0} Turns</span>
            </div>

            <!-- Inject bar -->
            <div style="padding:8px 14px;border-top:1px solid var(--border-subtle);display:flex;gap:6px;flex-shrink:0;">
              <input id="arena-inject-input" type="text" placeholder="Einwerfen: Text, Screenshot per Strg+V, oder Datei per Drag&Drop..."
                style="flex:1;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:6px 10px;font-size:12px;outline:none;"
                onkeydown="if(event.key==='Enter')MC.arena.inject('${room.id}')">
              <button onclick="MC.arena.pickAndInject('${room.id}')"
                title="Datei anhaengen (PDF, Bild, Text...)"
                style="background:rgba(148,163,184,0.12);border:1px solid rgba(148,163,184,0.3);color:#94a3b8;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;font-weight:500;white-space:nowrap;">&#128206;</button>
              <button id="arena-mic-btn" onclick="MC.arena.toggleMic('${room.id}')"
                title="Mikrofon (Sprache statt Tippen)"
                style="background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.25);color:#6366f1;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;font-weight:500;white-space:nowrap;">&#127908;</button>
              <button id="arena-meeting-btn" onclick="MC.arena.toggleMeetingMode('${room.id}')"
                title="Dauer-Dialog-Modus: Freisprech-Meeting — jede Aussage geht sofort in den Raum, kein Wake-Word nötig"
                style="background:${_meetingMode ? 'rgba(16,185,129,0.22)' : 'rgba(16,185,129,0.08)'};border:1px solid ${_meetingMode ? 'rgba(16,185,129,0.6)' : 'rgba(16,185,129,0.2)'};color:#10b981;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;font-weight:600;white-space:nowrap;">${_meetingMode ? '⏹ Meeting' : '🗣 Meeting'}</button>
              <button id="arena-tts-btn" onclick="MC.arena.toggleTts()"
                title="Bot-Sprachausgabe: Bots lesen ihre Antworten automatisch vor"
                style="background:${_ttsAutoEnabled ? 'rgba(245,158,11,0.22)' : 'rgba(245,158,11,0.08)'};border:1px solid ${_ttsAutoEnabled ? 'rgba(245,158,11,0.6)' : 'rgba(245,158,11,0.2)'};color:#f59e0b;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;font-weight:600;white-space:nowrap;">${_ttsAutoEnabled ? '🔊 Ton an' : '🔇 Ton aus'}</button>
              <button onclick="MC.arena.inject('${room.id}')"
                style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.25);color:#f59e0b;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer;font-weight:500;white-space:nowrap;">Einwerfen</button>
              <button onclick="MC.arena.execute('${room.id}')"
                style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.25);color:#ef4444;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer;font-weight:600;white-space:nowrap;" title="Execution-Modus: Bots bekommen Tool-Zugriff (Read/Write/Edit/Bash) und setzen [ACTION]-Punkte aus dem Fazit selbstaendig um. Du bestaetigst jede Aktion einzeln. Stoppt automatisch nach den vorgegebenen Turns.">Umsetzen</button>
            </div>
            <!-- Hint text: erklaert was der Umsetzen-Knopf macht -->
            <div style="padding:2px 14px 6px 14px;font-size:10px;color:var(--text-muted);text-align:right;flex-shrink:0;line-height:1.3;">
              <span style="color:#ef4444;font-weight:600;">Umsetzen</span> = Bots schalten in Execution-Modus &amp; fuehren [ACTION]-Punkte aus dem Fazit mit Tool-Zugriff aus (du bestaetigst jede).
            </div>
          </div>

          <!-- Orchestrator / Fazit Panel (collapsible) -->
          <div id="arena-orchestrator-panel" style="display:${_orchestratorOpen ? 'flex' : 'none'};width:420px;flex-shrink:0;border-left:1px solid var(--border-subtle);flex-direction:column;background:var(--bg-secondary);">
            <div style="padding:10px 14px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:6px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#a855f7;"></span>
              <span style="font-weight:700;font-size:12px;color:#a855f7;flex:1;">Fazit & Richter</span>
              <button onclick="MC.arena.requestSummary('${room.id}')" style="background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.25);color:#a855f7;border-radius:6px;padding:3px 8px;font-size:10px;cursor:pointer;" title="Neues Fazit generieren">Aktualisieren</button>
              <button onclick="MC.arena.toggleOrchestrator()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:2px 4px;">X</button>
            </div>
            <!-- Summary display with live-rendered action checkboxes -->
            <div id="arena-orch-summary" style="flex:1;overflow-y:auto;padding:10px 14px;font-size:12px;color:var(--text-primary);line-height:1.5;">
              ${hasSummary
                ? renderFazitWithActions(room.orchestrator_summary, room)
                : '<span style="color:var(--text-muted);">Noch kein Fazit. Starte die Diskussion oder klicke "Aktualisieren".</span>'}
            </div>
            <!-- Direktfrage an den Richter -->
            <div style="border-top:2px solid rgba(168,85,247,0.4);background:rgba(168,85,247,0.07);padding:10px 14px;">
              <div style="font-size:10px;font-weight:700;color:#a855f7;letter-spacing:0.05em;margin-bottom:6px;display:flex;align-items:center;gap:5px;">
                <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#a855f7;"></span>
                DIREKTFRAGE AN RICHTER
              </div>
              <div style="display:flex;gap:6px;">
                <input id="arena-orch-input" type="text" placeholder="Direkt an den Orchestrator…" onkeydown="if(event.key==='Enter')MC.arena.chatOrchestrator()"
                  style="flex:1;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.3);border-radius:6px;padding:6px 10px;font-size:11px;color:var(--text-primary);outline:none;"/>
                <button onclick="MC.arena.chatOrchestrator()"
                  style="background:rgba(168,85,247,0.2);border:1px solid rgba(168,85,247,0.4);color:#a855f7;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;font-weight:700;flex-shrink:0;">→</button>
              </div>
            </div>
          </div>

          <!-- Ergebnis-Seite / Results Panel (collapsible) -->
          <div id="arena-results-panel" style="display:${_resultsOpen ? 'flex' : 'none'};width:460px;flex-shrink:0;border-left:1px solid var(--border-subtle);flex-direction:column;background:var(--bg-secondary);">
            <div style="padding:10px 14px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:6px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;"></span>
              <span style="font-weight:700;font-size:12px;color:#10b981;flex:1;">Ergebnisse &amp; Fortschritt</span>
              <button onclick="MC.arena.toggleResults()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:2px 4px;">X</button>
            </div>
            <div id="arena-results-body" style="flex:1;overflow-y:auto;padding:10px 14px;font-size:12px;color:var(--text-primary);line-height:1.5;">
              ${renderResultsPanel(room)}
            </div>
          </div>

          <!-- Aktions-Sammler Panel (collapsible) -->
          <div id="arena-sammler-panel" style="display:${_sammlerOpen ? 'flex' : 'none'};width:420px;flex-shrink:0;border-left:1px solid var(--border-subtle);flex-direction:column;background:var(--bg-secondary);">
            <div style="padding:10px 14px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:6px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#fbbf24;"></span>
              <span style="font-weight:700;font-size:12px;color:#fbbf24;flex:1;">Aktions-Sammler</span>
              <button onclick="MC.arena.refreshSammler()" style="background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.25);color:#fbbf24;border-radius:6px;padding:3px 8px;font-size:10px;cursor:pointer;" title="Erneut scannen">Refresh</button>
              <button onclick="MC.arena.toggleSammler()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:2px 4px;">X</button>
            </div>
            <div id="arena-sammler-body" style="flex:1;overflow-y:auto;padding:10px 14px;font-size:12px;color:var(--text-primary);line-height:1.5;">
              ${renderSammlerPanel(room)}
            </div>
          </div>
        </div>
      </div>`;

    // Scroll to bottom
    const msgBox = el('arena-messages');
    if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;

    // Drag-and-drop images into the room
    setupDropZone(room.id);
  }

  // ── Drag & Drop / Attach Files (Images, PDFs, Text...) ─────────────────
  async function uploadAndInject(roomId, file, captionInput) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      MC.toast && MC.toast(`${file.name || 'Datei'} zu gross (max 20 MB)`, 'error', 2500);
      return;
    }
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'upload');
      const up = await fetch('/api/upload', { method: 'POST', body: fd });
      const upData = await up.json();
      if (!up.ok || !upData.filename) {
        MC.toast && MC.toast(upData.error || 'Upload fehlgeschlagen', 'error', 3000);
        return;
      }
      const caption = (captionInput && captionInput.value || '').trim();
      const isImage = (file.type || '').startsWith('image/');
      const body = { message: caption, attachments: [upData.filename] };
      if (isImage) body.image = upData.filename; // back-compat for image rendering
      await fetch(`/api/arena/rooms/${roomId}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (captionInput) captionInput.value = '';
      const label = isImage ? 'Bild' : (file.name || 'Datei');
      MC.toast && MC.toast(`${label} eingeworfen`, 'success', 1500);
    } catch (e) {
      console.error('[Arena] file inject failed:', e);
      MC.toast && MC.toast('Netzwerkfehler beim Upload', 'error', 3000);
    }
  }

  // Pick files via hidden <input type="file"> — called from the paperclip button
  async function pickAndInject(roomId) {
    const captionInput = el('arena-inject-input');
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = 'image/*,.pdf,.txt,.md,.csv,.json,.py,.js,.html,.css,.yaml,.yml,.log,.tsv,.ini,.toml';
    picker.style.display = 'none';
    document.body.appendChild(picker);
    picker.addEventListener('change', async () => {
      const files = Array.from(picker.files || []);
      for (const f of files) await uploadAndInject(roomId, f, captionInput);
      picker.remove();
    });
    picker.click();
  }

  function setupDropZone(roomId) {
    // Cover the whole room column (messages + inject bar), fallback to messages only.
    const zone = el('arena-room-drop') || el('arena-messages');
    if (!zone || zone.dataset.dropBound === '1') return;
    zone.dataset.dropBound = '1';

    let overlay = null;
    let dragDepth = 0; // counter pattern: avoids flicker when crossing child elements
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const showOverlay = () => {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.id = 'arena-drop-overlay';
      overlay.style.cssText = 'position:absolute;inset:0;background:rgba(99,102,241,0.18);border:2px dashed #6366f1;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#c7d2fe;font-size:14px;font-weight:700;pointer-events:none;z-index:50;backdrop-filter:blur(1px);';
      overlay.textContent = 'Datei hier ablegen zum Einwerfen (Bild / PDF / Text)';
      zone.appendChild(overlay);
    };
    const hideOverlay = () => { dragDepth = 0; if (overlay) { overlay.remove(); overlay = null; } };

    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      showOverlay();
    });
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hideOverlay();
    });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault(); hideOverlay();
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      const captionInput = el('arena-inject-input');
      for (const f of files) {
        await uploadAndInject(roomId, f, captionInput);
      }
    });

    // Paste für arena-inject-input: siehe handleArenaPaste() (document-level),
    // fügt Screenshot als [Screenshot](url) ins Inputfeld ein, damit Robin
    // noch Caption tippen und gezielt "Einwerfen" drücken kann.
  }

  function formatMarkdown(text) {
    if (!text) return '';
    return escHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;font-size:11px;">$1</code>')
      .replace(/^- (.+)/gm, '<span style="display:block;padding-left:12px;position:relative;"><span style="position:absolute;left:0;">·</span>$1</span>')
      .replace(/^\d+\. (.+)/gm, '<span style="display:block;padding-left:16px;">$1</span>')
      .replace(/\n/g, '<br>');
  }

  // Render the orchestrator summary with extracted [ACTION] items as checkboxes in the Fazit panel
  function renderFazitWithActions(summary, room) {
    if (!summary) return '';
    const actionRegex = /\[ACTION(?::([^\]]*))?\]\s*(.+)/g;
    const actions = [];
    let match;
    while ((match = actionRegex.exec(summary)) !== null) {
      actions.push({ bot: (match[1] || '').trim(), text: match[2].trim() });
    }
    // Remove the [ACTION] lines from the visible text
    const cleaned = summary.replace(/\[ACTION(?::[^\]]*)?\]\s*.+/g, '').replace(/\n{3,}/g, '\n\n').trim();
    const rid = room && room.id ? `'${room.id}'` : 'MC.arena.activeRoom';
    let html = `<div style="margin-bottom:10px;">${formatMarkdown(cleaned)}</div>`;
    html += `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">` +
      `<button onclick="MC.arena.injectText(${rid},'Ja, weiter so.')" style="flex:1;min-width:70px;padding:7px 10px;border-radius:7px;border:1px solid rgba(34,197,94,0.4);background:rgba(34,197,94,0.1);color:#22c55e;font-size:11px;font-weight:700;cursor:pointer;" title="Richtung bestaetigen">Ja-weiter</button>` +
      `<button onclick="(function(){var t=window.prompt('Pivot: neue Richtung?');if(t&&t.trim())MC.arena.injectText(${rid},'Pivot: '+t.trim());})()" style="flex:1;min-width:60px;padding:7px 10px;border-radius:7px;border:1px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.1);color:#f59e0b;font-size:11px;font-weight:700;cursor:pointer;" title="Neue Richtung vorgeben">Pivot</button>` +
      `<button onclick="MC.arena.stopRoom(${rid})" style="flex:1;min-width:55px;padding:7px 10px;border-radius:7px;border:1px solid rgba(239,68,68,0.4);background:rgba(239,68,68,0.1);color:#ef4444;font-size:11px;font-weight:700;cursor:pointer;" title="Diskussion stoppen">Stop</button>` +
      `</div>`;
    if (actions.length > 0) {
      const panelMsgId = `panel-actions-${Date.now()}`;
      const checkboxes = actions.map((a, i) => {
        const botBadge = a.bot ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(168,85,247,0.18);color:#c084fc;font-weight:700;flex-shrink:0;margin-right:4px;">${escHtml(a.bot)}</span>` : '';
        return `<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:7px 10px;border-radius:7px;background:rgba(168,85,247,0.06);border:1px solid rgba(168,85,247,0.18);transition:background 0.15s;margin-bottom:5px;">
          <input type="checkbox" checked data-action-idx="${i}" data-action-text="${escHtml(a.text)}" class="arena-panel-action-cb" style="accent-color:#a855f7;margin-top:2px;flex-shrink:0;">
          <span style="font-size:11px;color:var(--text-primary);line-height:1.4;display:flex;align-items:center;gap:0;flex-wrap:wrap;">${botBadge}${escHtml(a.text)}</span>
        </label>`;
      }).join('');
      html += `
        <div id="${panelMsgId}" style="margin-top:10px;padding-top:10px;border-top:1px dashed rgba(168,85,247,0.25);">
          <div style="font-size:9px;color:#a855f7;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:700;">Aktionen — Haken setzen zum Umsetzen</div>
          ${checkboxes}
          <button onclick="MC.arena.approveFromPanel('${panelMsgId}')"
            title="Startet den Executor-Bot fuer die angehakten Aktionen. Jede Aktion laeuft als eigene Claude-Session mit Tool-Zugriff (Read/Write/Edit/Bash) im Jarvis-Repo. Du siehst vorher nochmal die betroffenen Dateien in einem Preview-Dialog und kannst abbrechen."
            style="margin-top:8px;width:100%;padding:8px 16px;border-radius:7px;border:1px solid rgba(16,185,129,0.4);background:rgba(16,185,129,0.12);color:#10b981;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;"
            onmouseover="this.style.background='rgba(16,185,129,0.25)'"
            onmouseout="this.style.background='rgba(16,185,129,0.12)'"
          >Ausgewaehlte umsetzen lassen</button>
          <div style="margin-top:6px;font-size:10px;color:var(--text-muted);line-height:1.35;text-align:center;">
            Startet je angehakter Aktion eine Executor-Session mit Tool-Zugriff. File-Preview zeigt dir vorher, was angefasst wird.
          </div>
        </div>`;
    }
    return html;
  }

  // ── Ergebnis-Seite (Results Panel) ─────────────────────────────────────
  function collectRoomResults(room) {
    const approvals = (room.messages || []).filter(m => m.role === 'approval' && Array.isArray(m.actions));
    const executorMsgs = (room.messages || []).filter(m => m.role === 'executor');
    let done = 0, failed = 0, running = 0, pending = 0, total = 0;
    approvals.forEach(a => {
      (a.actions || []).forEach(act => {
        total++;
        if (act.status === 'done') done++;
        else if (act.status === 'failed') failed++;
        else if (act.status === 'running') running++;
        else pending++;
      });
    });
    return { approvals, executorMsgs, total, done, failed, running, pending };
  }

  function countRoomResultsBadge(room) {
    const s = collectRoomResults(room);
    if (s.total === 0) return '';
    const live = s.running + s.pending;
    if (live > 0) return ` <span style="background:rgba(245,158,11,0.25);color:#f59e0b;border-radius:10px;padding:1px 6px;font-size:9px;margin-left:3px;">${s.done}/${s.total}</span>`;
    return ` <span style="background:rgba(16,185,129,0.25);color:#10b981;border-radius:10px;padding:1px 6px;font-size:9px;margin-left:3px;">${s.done}/${s.total}</span>`;
  }

  function renderResultsPanel(room) {
    if (!room) return '';
    const s = collectRoomResults(room);
    if (s.total === 0) {
      return `<div style="color:var(--text-muted);font-size:12px;padding:20px 4px;text-align:center;">
        Noch keine freigegebenen Aktionen.<br>
        Gib im Fazit-Panel Aktionen frei, dann erscheint hier dein Fortschritt.
      </div>`;
    }
    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
    const header = `
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:120px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:6px;padding:6px 10px;">
          <div style="font-size:9px;color:#10b981;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Fertig</div>
          <div style="font-size:18px;font-weight:700;color:#10b981;">${s.done}<span style="font-size:11px;color:var(--text-muted);font-weight:400;"> / ${s.total}</span></div>
        </div>
        <div style="flex:1;min-width:70px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;padding:6px 10px;">
          <div style="font-size:9px;color:#f59e0b;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Laeuft</div>
          <div style="font-size:18px;font-weight:700;color:#f59e0b;">${s.running + s.pending}</div>
        </div>
        <div style="flex:1;min-width:70px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;padding:6px 10px;">
          <div style="font-size:9px;color:#ef4444;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Fehler</div>
          <div style="font-size:18px;font-weight:700;color:#ef4444;">${s.failed}</div>
        </div>
      </div>
      <div style="height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden;margin-bottom:14px;">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#10b981,#22c55e);transition:width 0.3s;"></div>
      </div>`;

    const sections = s.approvals.slice().reverse().map((a, ai) => {
      const rows = (a.actions || []).map((act, ri) => {
        const statusColor = act.status === 'done' ? '#10b981' : act.status === 'failed' ? '#ef4444' : act.status === 'running' ? '#f59e0b' : '#9ca3af';
        const statusLabel = act.status === 'done' ? '&check; fertig' : act.status === 'failed' ? '&cross; Fehler' : act.status === 'running' ? 'laeuft...' : 'wartet';
        const diffFiles = act.status === 'done' ? extractFilePreview([act.text || '', act.result || '']).slice(0, 8) : [];
        const diffSection = diffFiles.length > 0 ? `
          <div style="margin-top:5px;padding-top:4px;border-top:1px dashed rgba(16,185,129,0.2);">
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;font-weight:700;">Diff — Datei anklicken</div>
            ${diffFiles.map((f, fi) => {
              const uid = `ard-${ai}-${ri}-${fi}`;
              return `<div style="margin:2px 0;"><a href="javascript:void(0)" onclick="MC.arena.peekFileInline('${escHtml(f)}','${uid}')" style="font-family:monospace;font-size:10px;color:#60a5fa;text-decoration:none;cursor:pointer;" title="Klick: Diff anzeigen">&#128196; ${escHtml(f)}</a><div id="${uid}" style="display:none;margin-top:3px;max-height:260px;overflow-y:auto;background:rgba(0,0,0,0.35);border-radius:4px;padding:6px 8px;font-size:10px;font-family:monospace;white-space:pre-wrap;color:#e2e8f0;border:1px solid rgba(96,165,250,0.2);"></div></div>`;
            }).join('')}
          </div>` : '';
        return `<div style="padding:7px 9px;border-radius:6px;background:rgba(${act.status === 'done' ? '16,185,129' : act.status === 'failed' ? '239,68,68' : '255,255,255'},0.05);border:1px solid rgba(${act.status === 'done' ? '16,185,129' : act.status === 'failed' ? '239,68,68' : '255,255,255'},0.12);margin-bottom:5px;">
          <div style="display:flex;align-items:flex-start;gap:6px;">
            <span style="font-size:9px;padding:2px 6px;border-radius:3px;background:${statusColor}22;color:${statusColor};font-weight:700;flex-shrink:0;margin-top:1px;">${statusLabel}</span>
            <span style="font-size:11px;color:var(--text-primary);line-height:1.4;flex:1;">${escHtml(act.text || '')}</span>
          </div>
          ${act.result ? `<div style="font-size:10px;color:var(--text-muted);line-height:1.4;padding:5px 4px 0;margin-top:4px;border-top:1px dashed rgba(255,255,255,0.07);white-space:pre-wrap;">${escHtml(act.result)}</div>` : ''}
          ${diffSection}
        </div>`;
      }).join('');
      const rejList = Array.isArray(a.rejected) ? a.rejected : [];
      const rejHtml = rejList.length === 0 ? '' : `
        <details style="margin-top:6px;border:1px dashed rgba(156,163,175,0.25);border-radius:6px;padding:5px 8px;background:rgba(156,163,175,0.04);">
          <summary style="cursor:pointer;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Verworfene Alternativen (${rejList.length}) — warum Weg A gewann</summary>
          ${rejList[0] && rejList[0].reason ? `<div style="font-size:10px;color:var(--text-muted);padding:6px 2px 4px;font-style:italic;line-height:1.4;">Begruendung: ${escHtml(rejList[0].reason)}</div>` : ''}
          ${rejList.map(r => `<div style="padding:5px 8px;margin-top:4px;border-radius:5px;background:rgba(156,163,175,0.06);border:1px solid rgba(156,163,175,0.15);">
            <span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(156,163,175,0.2);color:#9ca3af;font-weight:700;margin-right:6px;">verworfen</span>
            <span style="font-size:11px;color:var(--text-muted);text-decoration:line-through;text-decoration-color:rgba(156,163,175,0.4);">${escHtml(r.text || '')}</span>
          </div>`).join('')}
        </details>`;
      return `<div style="margin-bottom:14px;">
        <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;font-weight:700;">Freigabe ${s.approvals.length - ai} · ${relTime(a.timestamp)}</div>
        ${rows}
        ${rejHtml}
      </div>`;
    }).join('');

    const execSection = s.executorMsgs.length > 0 ? `
      <div style="margin-top:8px;padding-top:10px;border-top:1px dashed rgba(16,185,129,0.25);">
        <div style="font-size:9px;color:#10b981;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:700;">Executor-Zusammenfassungen (${s.executorMsgs.length})</div>
        ${s.executorMsgs.slice(-3).reverse().map(m => `
          <div style="padding:6px 9px;border-radius:6px;background:rgba(16,185,129,0.05);border:1px solid rgba(16,185,129,0.15);margin-bottom:5px;font-size:11px;line-height:1.4;color:var(--text-primary);">
            <div style="font-size:9px;color:var(--text-muted);margin-bottom:3px;">${relTime(m.timestamp)}</div>
            ${formatMarkdown((m.content || '').slice(0, 500))}${(m.content || '').length > 500 ? '...' : ''}
          </div>`).join('')}
      </div>` : '';

    return header + sections + execSection;
  }

  function toggleResults() {
    _resultsOpen = !_resultsOpen;
    const panel = el('arena-results-panel');
    if (panel) panel.style.display = _resultsOpen ? 'flex' : 'none';
    if (_resultsOpen) {
      const room = rooms.find(r => r.id === activeRoom);
      const body = el('arena-results-body');
      if (body && room) body.innerHTML = renderResultsPanel(room);
    }
  }

  // ── Aktions-Sammler ────────────────────────────────────────────────────

  // Löst "Alpha oder Beta" → nimmt ersten Bot, markiert es als auto-resolved
  function _resolveOwner(rawTag, msgName) {
    let raw = (rawTag || msgName || '').trim();
    let autoResolved = false;
    if (/\boder\b/i.test(raw)) {
      raw = raw.split(/\boder\b/i)[0].trim();
      autoResolved = true;
    }
    if (!raw) {
      raw = msgName || 'Unbekannt';
      autoResolved = true;
    }
    return { owner: raw, autoResolved };
  }

  function collectAllActionsFromMessages(room) {
    const msgs = (room && room.messages) || [];
    const collected = [];
    msgs.forEach((m, idx) => {
      if (!m.content || m.role === 'robin' || m.role === 'executor' || m.role === 'approval') return;
      let match;
      const re = /\[ACTION(?::([^\]]*))?\]\s*(.+)/g;
      while ((match = re.exec(m.content)) !== null) {
        const { owner, autoResolved } = _resolveOwner(match[1], m.name);
        collected.push({
          bot: owner,
          autoResolved,
          text: match[2].trim(),
          msgIdx: idx,
          timestamp: m.timestamp,
          color: m.color || '#fbbf24',
        });
      }
    });
    return collected;
  }

  function countSammlerBadge(room) {
    const actions = collectAllActionsFromMessages(room);
    if (actions.length === 0) return '';
    return ` <span style="background:rgba(251,191,36,0.25);color:#fbbf24;border-radius:10px;padding:1px 6px;font-size:9px;margin-left:3px;">${actions.length}</span>`;
  }

  function renderSammlerPanel(room) {
    if (!room) return '';
    const actions = collectAllActionsFromMessages(room);
    if (actions.length === 0) {
      return `<div style="color:var(--text-muted);font-size:12px;padding:20px 4px;text-align:center;">
        Noch keine Aktionsvorschlaege.<br><br>
        Bots markieren Vorschlaege mit <code style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-size:10px;">[ACTION: BotName] Text</code><br>
        im Diskussionsverlauf. Diese erscheinen hier gebuendelt.
      </div>`;
    }

    // Group by bot name
    const byBot = {};
    actions.forEach(a => {
      const key = a.bot || 'Unbekannt';
      if (!byBot[key]) byBot[key] = { color: a.color, items: [] };
      byBot[key].items.push(a);
    });

    const sammlerMsgId = `sammler-actions-${Date.now()}`;
    let html = `<div style="margin-bottom:10px;padding:8px 10px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);border-radius:7px;">
      <div style="font-size:10px;color:#fbbf24;font-weight:700;margin-bottom:2px;">${actions.length} Vorschlaege aus dem Verlauf</div>
      <div style="font-size:10px;color:var(--text-muted);">Haken setzen, dann "Freigeben" druecken. Executor setzt die Auswahl um.</div>
    </div>`;

    html += `<div id="${sammlerMsgId}" style="display:flex;flex-direction:column;gap:12px;">`;
    Object.entries(byBot).forEach(([botName, group]) => {
      html += `<div>
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;color:${escHtml(group.color)};margin-bottom:5px;display:flex;align-items:center;gap:5px;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${escHtml(group.color)};"></span>${escHtml(botName)}
        </div>`;
      group.items.forEach((a, i) => {
        const autoWarn = a.autoResolved
          ? `<span title="Besitzer auto-zugewiesen (mehrdeutig im Original)" style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,0.12);color:#ef4444;border:1px solid rgba(239,68,68,0.25);margin-left:5px;vertical-align:middle;">auto</span>`
          : '';
        html += `<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:7px 10px;border-radius:7px;background:rgba(251,191,36,0.05);border:1px solid rgba(251,191,36,0.15);margin-bottom:4px;transition:background 0.15s;">
          <input type="checkbox" checked class="arena-sammler-cb" data-bot="${escHtml(botName)}" data-text="${escHtml(a.text)}" style="accent-color:#fbbf24;margin-top:2px;flex-shrink:0;">
          <span style="font-size:11px;color:var(--text-primary);line-height:1.4;"><span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${escHtml(group.color)}18;color:${escHtml(group.color)};border:1px solid ${escHtml(group.color)}33;margin-right:6px;vertical-align:middle;">${escHtml(botName)}</span>${autoWarn}${escHtml(a.text)}</span>
        </label>`;
      });
      html += `</div>`;
    });
    html += `</div>`;

    html += `<button onclick="MC.arena.approveSammlerActions('${sammlerMsgId}')"
      style="margin-top:12px;width:100%;padding:9px 16px;border-radius:7px;border:1px solid rgba(16,185,129,0.4);background:rgba(16,185,129,0.12);color:#10b981;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;"
      onmouseover="this.style.background='rgba(16,185,129,0.25)'"
      onmouseout="this.style.background='rgba(16,185,129,0.12)'"
      title="Startet Executor-Bot fuer alle angehakten Vorschlaege">Ausgewaehlte freigeben &amp; umsetzen</button>
    <div style="margin-top:6px;font-size:10px;color:var(--text-muted);line-height:1.35;text-align:center;">Executor bekommt Tool-Zugriff (Read/Write/Edit/Bash) und setzt die freigegebenen Punkte um.</div>`;

    return html;
  }

  function toggleSammler() {
    _sammlerOpen = !_sammlerOpen;
    const panel = el('arena-sammler-panel');
    if (panel) panel.style.display = _sammlerOpen ? 'flex' : 'none';
    if (_sammlerOpen) {
      const room = rooms.find(r => r.id === activeRoom);
      const body = el('arena-sammler-body');
      if (body && room) body.innerHTML = renderSammlerPanel(room);
    }
  }

  function refreshSammler() {
    const room = rooms.find(r => r.id === activeRoom);
    const body = el('arena-sammler-body');
    if (body && room) body.innerHTML = renderSammlerPanel(room);
  }

  function updateSammlerBadge(room) {
    const btn = el('arena-sammler-btn');
    if (!btn) return;
    const badge = countSammlerBadge(room);
    btn.innerHTML = 'Sammler' + badge;
    if (badge) {
      btn.style.borderColor = 'rgba(251,191,36,0.7)';
      btn.style.boxShadow = '0 0 6px rgba(251,191,36,0.35)';
    }
  }

  async function approveSammlerActions(containerId) {
    if (!activeRoom) return;
    const container = document.getElementById(containerId);
    if (!container) return;
    const checkboxes = container.querySelectorAll('.arena-sammler-cb');
    const approved = [];
    checkboxes.forEach(cb => {
      if (cb.checked) {
        const bot = cb.dataset.bot || '';
        const text = cb.dataset.text || (cb.parentElement.querySelector('span')?.textContent.trim() || '');
        approved.push(bot ? `[${bot}] ${text}` : text);
      }
    });
    if (approved.length === 0) {
      MC.toast && MC.toast('Keine Aktionen ausgewaehlt', 'warning', 2000);
      return;
    }
    const btn = document.querySelector(`#${containerId}`).closest('[style*="flex-direction:column"]')
      ? document.evaluate(`following-sibling::button`, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
      : null;
    const approveBtn = container.parentElement && container.parentElement.querySelector('button[onclick*="approveSammlerActions"]');
    if (approveBtn) {
      approveBtn.disabled = true;
      approveBtn.textContent = 'Executor wird gestartet...';
      approveBtn.style.opacity = '0.6';
    }
    try {
      const res = await fetch(`/api/arena/rooms/${activeRoom}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: approved, rejected: [], reject_reason: '' }),
      });
      const data = await res.json();
      if (data.ok) {
        MC.toast && MC.toast(`Executor gestartet: ${approved.length} Aktionen`, 'success', 3000);
        if (approveBtn) {
          approveBtn.textContent = `Executor laeuft (${approved.length} Items)`;
          approveBtn.style.background = 'rgba(16,185,129,0.3)';
        }
        if (!_resultsOpen) {
          _resultsOpen = true;
          const rPanel = el('arena-results-panel');
          if (rPanel) rPanel.style.display = 'flex';
          const rBody = el('arena-results-body');
          const room = rooms.find(r => r.id === activeRoom);
          if (rBody && room) rBody.innerHTML = renderResultsPanel(room);
        }
      } else {
        if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Ausgewaehlte freigeben & umsetzen'; approveBtn.style.opacity = '1'; }
        MC.toast && MC.toast(data.error || 'Fehler', 'error', 3000);
      }
    } catch (e) {
      if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Ausgewaehlte freigeben & umsetzen'; approveBtn.style.opacity = '1'; }
      MC.toast && MC.toast('Netzwerkfehler', 'error', 3000);
    }
  }

  function renderApprovalMessage(m) {
    // Approval message with per-action live status (rendered inline in main chat)
    const badgeFor = (status) => {
      if (status === 'pending') return '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(156,163,175,0.2);color:#9ca3af;">wartet</span>';
      if (status === 'running') return '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(245,158,11,0.2);color:#f59e0b;animation:pulse-dot 1.5s infinite;">laeuft...</span>';
      if (status === 'done') return '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(16,185,129,0.2);color:#10b981;font-weight:700;">&check; fertig</span>';
      if (status === 'failed') return '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(239,68,68,0.2);color:#ef4444;font-weight:700;">&cross; Fehler</span>';
      if (status === 'haengend') return '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(139,92,246,0.2);color:#a78bfa;font-weight:700;">&#8987; haengend</span>';
      return '';
    };
    const actionRows = (m.actions || []).map((a, i) => {
      const botMatch = a.text ? a.text.match(/^\[([^\]]+)\]\s*(.+)/) : null;
      const displayBot = botMatch ? botMatch[1] : (a.bot || '');
      const displayText = botMatch ? botMatch[2] : (a.text || '');
      const botBadge = displayBot ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(251,191,36,0.12);color:#fbbf24;border:1px solid rgba(251,191,36,0.3);margin-right:6px;vertical-align:middle;">${escHtml(displayBot)}</span>` : '';
      return `
      <div class="arena-approval-action" data-approval-id="${m.approval_id}" data-action-idx="${i}"
        style="display:flex;flex-direction:column;gap:3px;padding:6px 9px;border-radius:6px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.15);margin-bottom:4px;">
        <div style="display:flex;align-items:flex-start;gap:8px;">
          <span class="arena-approval-badge" style="flex-shrink:0;margin-top:1px;">${badgeFor(a.status)}</span>
          <span style="font-size:11px;color:var(--text-primary);line-height:1.4;flex:1;">${botBadge}${escHtml(displayText)}</span>
        </div>
        <div class="arena-approval-result" style="font-size:10px;color:var(--text-muted);line-height:1.4;padding-left:4px;${a.result ? '' : 'display:none;'}">${a.result ? escHtml(a.result) : ''}</div>
      </div>
    `; }).join('');
    return `<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:8px 12px;">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:6px;">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;flex-shrink:0;"></span>
        <span style="font-weight:600;font-size:11px;color:#f59e0b;">Robin</span>
        <span style="font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(245,158,11,0.15);color:#f59e0b;margin-left:3px;font-weight:600;">GRUENES LICHT</span>
        <span style="font-size:9px;color:var(--text-muted);margin-left:auto;">${relTime(m.timestamp)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-primary);line-height:1.4;margin-bottom:6px;">${escHtml(m.content || '')}</div>
      <div>${actionRows}</div>
    </div>`;
  }

  function renderMessages(messages) {
    if (!messages || messages.length === 0) {
      return `<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:40px 0;">
        Noch keine Nachrichten. Starte die Diskussion oder wirf etwas ein.
      </div>`;
    }

    return messages.map((m, idx) => {
      // Approval messages with live per-action status get their own renderer
      if (m.role === 'approval' && m.approval_id) {
        return renderApprovalMessage(m);
      }
      const isRobin = m.role === 'robin';
      const isOrch = m.role === 'orchestrator';
      const isExec = m.mode === 'execute';
      const isExecutor = m.role === 'executor';
      const bgColor = isExecutor ? 'rgba(16,185,129,0.08)' : isOrch ? 'rgba(168,85,247,0.08)' : isRobin ? 'rgba(245,158,11,0.08)' : isExec ? 'rgba(239,68,68,0.06)' : `${m.color || '#6366f1'}0a`;
      const borderColor = isExecutor ? 'rgba(16,185,129,0.25)' : isOrch ? 'rgba(168,85,247,0.25)' : isRobin ? 'rgba(245,158,11,0.2)' : isExec ? 'rgba(239,68,68,0.25)' : `${m.color || '#6366f1'}20`;
      const nameColor = m.color || (isRobin ? '#f59e0b' : isOrch ? '#a855f7' : isExecutor ? '#10b981' : '#6366f1');
      const modelBadge = m.model ? `<span style="font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.05);color:var(--text-muted);margin-left:4px;">${m.model}</span>` : '';
      const execBadge = isExec ? `<span style="font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(239,68,68,0.15);color:#ef4444;margin-left:3px;font-weight:600;">EXEC</span>` : '';
      const executorBadge = isExecutor ? `<span style="font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(16,185,129,0.15);color:#10b981;margin-left:3px;font-weight:600;">UMSETZUNG</span>` : '';
      const orchBadge = isOrch ? `<span style="font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(168,85,247,0.15);color:#a855f7;margin-left:3px;font-weight:600;">FAZIT</span>` : '';
      const turnBadge = m.turn !== undefined ? `<span style="font-size:8px;color:var(--text-muted);margin-left:auto;">#${m.turn + 1}</span>` : '';

      let content = formatMarkdown(m.content);

      // Image attachment (drag & drop upload)
      if (m.image) {
        const imgUrl = `/api/uploads/${encodeURIComponent(m.image)}`;
        content += `<div style="margin-top:6px;"><a href="${imgUrl}" target="_blank" rel="noopener"><img src="${imgUrl}" style="max-width:100%;max-height:240px;border-radius:6px;border:1px solid var(--border-subtle);display:block;" alt="Bild"></a></div>`;
      }
      // Non-image attachments (PDF, text, code, CSV, JSON...) — zeig Chip mit Link
      const _atts = Array.isArray(m.attachments) ? m.attachments : [];
      const _nonImg = _atts.filter(fn => {
        const ext = String(fn).toLowerCase().split('.').pop();
        return !['png','jpg','jpeg','gif','webp','bmp'].includes(ext);
      });
      if (_nonImg.length) {
        const _iconFor = (fn) => {
          const ext = String(fn).toLowerCase().split('.').pop();
          if (ext === 'pdf') return '\u{1F4C4}';
          if (['txt','md','log','csv','tsv','json','yaml','yml','ini','toml'].includes(ext)) return '\u{1F4DD}';
          if (['py','js','html','css','ts','tsx','jsx','sh','ps1','bat'].includes(ext)) return '\u{1F4BB}';
          return '\u{1F4CE}';
        };
        const chips = _nonImg.map(fn => {
          const safe = encodeURIComponent(fn);
          const label = escHtml(fn);
          return `<a href="/api/uploads/${safe}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:5px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.25);color:#10b981;font-size:11px;text-decoration:none;margin:3px 4px 0 0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Alle Bots koennen diese Datei lesen">${_iconFor(fn)} ${label}</a>`;
        }).join('');
        content += `<div style="margin-top:4px;">${chips}</div>`;
      }

      // For orchestrator messages: parse [ACTION] items into interactive checkboxes
      let actionBlock = '';
      if (isOrch && m.content) {
        const actionRegex = /\[ACTION(?::([^\]]*))?\]\s*(.+)/g;
        const actions = [];
        let match;
        while ((match = actionRegex.exec(m.content)) !== null) {
          actions.push({ bot: (match[1] || '').trim(), text: match[2].trim() });
        }
        if (actions.length > 0) {
          const msgId = `orch-actions-${idx}-${Date.now()}`;
          const checkboxes = actions.map((a, i) => {
            const botBadge = a.bot ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(168,85,247,0.18);color:#c084fc;font-weight:700;flex-shrink:0;margin-right:4px;">${escHtml(a.bot)}</span>` : '';
            return `<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 8px;border-radius:6px;background:rgba(168,85,247,0.04);border:1px solid rgba(168,85,247,0.12);transition:background 0.15s;">
              <input type="checkbox" checked data-action-idx="${i}" data-action-text="${escHtml(a.text)}" class="arena-action-cb" data-msg-id="${msgId}" style="accent-color:#a855f7;margin-top:2px;flex-shrink:0;">
              <span style="font-size:11px;color:var(--text-primary);line-height:1.4;display:flex;align-items:center;gap:0;flex-wrap:wrap;">${botBadge}${escHtml(a.text)}</span>
            </label>`;
          }).join('');
          actionBlock = `
            <div id="${msgId}" style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">
              <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Aktionsvorschlaege — waehle aus:</div>
              ${checkboxes}
              <button onclick="MC.arena.approveActions('${msgId}')"
                title="Gibt die angehakten [ACTION]-Punkte zur Ausfuehrung frei. Executor-Bot bekommt Tool-Zugriff (Read/Write/Edit/Bash) und setzt sie als eigene Claude-Sessions um. Preview-Dialog zeigt vorher betroffene Dateien."
                style="margin-top:6px;align-self:flex-start;padding:6px 16px;border-radius:6px;border:1px solid rgba(16,185,129,0.4);background:rgba(16,185,129,0.12);color:#10b981;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;"
                onmouseover="this.style.background='rgba(16,185,129,0.25)'"
                onmouseout="this.style.background='rgba(16,185,129,0.12)'"
              >Gruenes Licht — Ausgewaehlte umsetzen</button>
              <div style="margin-top:4px;font-size:10px;color:var(--text-muted);line-height:1.35;">
                Gibt die Haken frei &amp; startet je Aktion eine Executor-Session mit Tool-Zugriff.
              </div>
            </div>`;
          // Remove [ACTION] lines from the main content since we render them as checkboxes
          content = content.replace(/\[ACTION(?::[^\]]*)?\]\s*.+?(<br>|$)/g, '');
        }
      }

      const leftBorder = isOrch ? 'border-left:3px solid #a855f7;' : isExecutor ? 'border-left:3px solid #10b981;' : '';

      return `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:8px 12px;${leftBorder}">
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${nameColor};flex-shrink:0;"></span>
          <span style="font-weight:600;font-size:11px;color:${nameColor};">${escHtml(m.name)}</span>
          ${modelBadge}${execBadge}${executorBadge}${orchBadge}${turnBadge}
          <span style="font-size:9px;color:var(--text-muted);margin-left:auto;">${relTime(m.timestamp)}</span>
        </div>
        <div class="arena-msg-body" style="font-size:12px;color:var(--text-primary);line-height:1.45;">${content}</div>
        ${actionBlock}
      </div>`;
    }).join('');
  }

  // ── Actions ────────────────────────────────────────────────────────────
  // Einheitlicher Raum-Wechsel: Mikro sauber zuruecksetzen, dann activeRoom setzen.
  // Jeder Codepfad, der activeRoom aendert, MUSS diese Funktion benutzen.
  function _setActiveRoom(newId) {
    if (activeRoom !== newId) {
      _stopMicHard();
      _stopMeetingMode();
      if (MC.voiceListener && MC.voiceListener.reset) {
        try { MC.voiceListener.reset(); } catch (_) {}
      }
    }
    activeRoom = newId;
  }

  function openRoom(roomId) {
    _setActiveRoom(roomId);
    renderRoomList();
    renderRoomView();
  }

  async function createRoom() {
    // Build a nice creation dialog instead of prompt()
    let modal = document.getElementById('arena-create-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'arena-create-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    const catOptions = ROOM_CATEGORIES.map(c =>
      `<option value="${c.id}">${c.icon} ${c.label}</option>`
    ).join('');

    const botCheckboxes = BOT_PRESETS.map((b, i) =>
      `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 0;">
        <input type="checkbox" data-bot-idx="${i}" ${i < 4 ? 'checked' : ''} style="accent-color:${b.color};">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${b.color};"></span>
        <span style="font-size:12px;color:var(--text-primary);">${b.name}</span>
        <span style="font-size:10px;color:var(--text-muted);">${b.model}</span>
      </label>`
    ).join('');

    modal.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-medium);border-radius:16px;width:100%;max-width:500px;padding:24px;">
        <h2 style="margin:0 0 16px;font-size:16px;color:var(--text-primary);">Neuer Diskussionsraum</h2>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Titel</label>
            <input id="arena-new-title" type="text" placeholder="z.B. Mission Control Review" style="width:100%;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:8px 10px;font-size:12px;outline:none;box-sizing:border-box;">
          </div>
          <div>
            <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Thema</label>
            <textarea id="arena-new-topic" placeholder="Worueber sollen die Bots diskutieren?" style="width:100%;height:60px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:8px 10px;font-size:12px;outline:none;resize:vertical;box-sizing:border-box;"></textarea>
          </div>
          <div style="display:flex;gap:12px;">
            <div style="flex:1;">
              <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Kategorie</label>
              <select id="arena-new-category" style="width:100%;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:8px 10px;font-size:12px;outline:none;">${catOptions}</select>
            </div>
            <div>
              <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;" title="Harte Obergrenze: maximal 25 Runden. Jede Runde = 1 Turn pro Bot.">Max Runden <span style="color:#f59e0b;">(Cap 25)</span></label>
              <input id="arena-new-rounds" type="number" value="10" min="1" max="25" style="width:70px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:8px 10px;font-size:12px;outline:none;" title="Echte Rundenzahl (nicht Turns). Jede Runde = 1 Turn pro Bot. Hard-Cap: 25.">
            </div>
            <div>
              <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Fazit alle</label>
              <input id="arena-new-summarize" type="number" value="10" min="0" max="50" style="width:70px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:8px 10px;font-size:12px;outline:none;" title="0 = kein Auto-Fazit">
            </div>
          </div>
          <div>
            <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Bots</label>
            <div style="display:flex;flex-wrap:wrap;gap:4px 16px;">${botCheckboxes}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input id="arena-new-read" type="checkbox" checked style="accent-color:#6366f1;">
              <span style="font-size:11px;color:var(--text-primary);">Bots duerfen Dateien lesen</span>
            </label>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
            <button onclick="document.getElementById('arena-create-modal').remove()" style="background:var(--bg-tertiary);border:1px solid var(--border-medium);color:var(--text-muted);border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;">Abbrechen</button>
            <button id="arena-new-submit" style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#818cf8;border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600;">Erstellen</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(modal);
    document.getElementById('arena-new-title').focus();

    document.getElementById('arena-new-submit').onclick = async () => {
      const title = document.getElementById('arena-new-title').value.trim() || 'Bot Diskussion';
      const topic = document.getElementById('arena-new-topic').value.trim();
      const category = document.getElementById('arena-new-category').value;
      const maxRoundsRaw = parseInt(document.getElementById('arena-new-rounds').value) || 5;
      const maxRounds = Math.min(10, Math.max(1, maxRoundsRaw));
      const summarizeEvery = parseInt(document.getElementById('arena-new-summarize').value) || 10;
      const allowRead = document.getElementById('arena-new-read').checked;

      // Collect selected bots
      const bots = [];
      document.querySelectorAll('#arena-create-modal [data-bot-idx]').forEach(cb => {
        if (cb.checked) {
          bots.push({ ...BOT_PRESETS[parseInt(cb.dataset.botIdx)] });
        }
      });
      if (bots.length < 2) {
        alert('Mindestens 2 Bots auswaehlen!');
        return;
      }

      // Echte Runden -> effektive Turns (1 Turn pro Bot pro Runde). Keine Fantasiezahlen.
      const maxTurns = maxRounds * bots.length;

      try {
        const res = await fetch('/api/arena/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, topic, category, bots, max_turns: maxTurns, max_rounds: maxRounds, summarize_every: summarizeEvery, allow_read: allowRead }),
        });
        const room = await res.json();
        _setActiveRoom(room.id);
        modal.remove();
        await loadRooms();
        renderRoomView();
      } catch (e) {
        console.error('[Arena] Create failed:', e);
      }
    };
  }

  async function deleteRoom(roomId) {
    if (!confirm('Raum wirklich loeschen?')) return;
    try {
      await fetch(`/api/arena/rooms/${roomId}`, { method: 'DELETE' });
      if (activeRoom === roomId) _setActiveRoom(null);
      await loadRooms();
      renderRoomView();
    } catch (e) {
      console.error('[Arena] Delete failed:', e);
    }
  }

  async function startRoom(roomId) {
    const room = rooms.find(r => r.id === roomId);
    let topic = room ? room.topic : '';
    if (!topic) {
      topic = prompt('Worueber sollen die Bots diskutieren?', '');
      if (!topic) return;
    }
    try {
      await fetch(`/api/arena/rooms/${roomId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      });
      const r = rooms.find(r => r.id === roomId);
      if (r) { r.running = true; r.topic = topic; }
      renderRoomList();
      renderRoomView();
    } catch (e) {
      console.error('[Arena] Start failed:', e);
    }
  }

  async function stopRoom(roomId) {
    try {
      await fetch(`/api/arena/rooms/${roomId}/stop`, { method: 'POST' });
      const r = rooms.find(r => r.id === roomId);
      if (r) r.running = false;
      renderRoomList();
      renderRoomView();
    } catch (e) {
      console.error('[Arena] Stop failed:', e);
    }
  }

  async function inject(roomId) {
    const input = el('arena-inject-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    await injectText(roomId, msg);
  }

  // Direkt Text in einen Raum einwerfen (ohne Input-Feld) — fuer Voice-Listener etc.
  async function injectText(roomId, text) {
    const target = roomId || activeRoom;
    const msg = (text || '').trim();
    if (!target || !msg) return false;
    try {
      await fetch(`/api/arena/rooms/${target}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      return true;
    } catch (e) {
      console.error('[Arena] injectText failed:', e);
      return false;
    }
  }

  function getActiveRoomId() { return activeRoom; }

  async function execute(roomId) {
    // Mini-Brief Modal: Vor jedem Bau steht ein klarer Auftrag mit Zielen.
    let modal = document.getElementById('arena-brief-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'arena-brief-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    const room = rooms.find(r => r.id === roomId);
    const suggestedGoal = room && room.orchestrator_summary
      ? (room.orchestrator_summary.split('\n').find(l => l.trim().length > 20) || '').slice(0, 200)
      : '';

    // Datei-Vorschau: Scan der letzten Bot-Nachrichten + Fazit nach Dateipfaden
    const previewSources = [];
    if (room && room.orchestrator_summary) previewSources.push(room.orchestrator_summary);
    if (room && Array.isArray(room.messages)) {
      room.messages.slice(-12).forEach(m => {
        if (m && typeof m.content === 'string' && m.role !== 'executor') previewSources.push(m.content);
      });
    }
    const previewFiles = extractFilePreview(previewSources);
    const previewShown = previewFiles.slice(0, 25);
    const previewBlock = previewFiles.length > 0
      ? `<div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:10px 12px;">
           <div style="font-size:10px;color:#ef4444;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;margin-bottom:6px;">Vorschau — wahrscheinlich betroffene Dateien (${previewFiles.length}) <span id="arena-preview-new-count" style="color:#22c55e;font-weight:700;"></span></div>
           <div id="arena-preview-file-list" style="font-size:11px;color:var(--text-primary);font-family:var(--font-mono,monospace);line-height:1.8;max-height:160px;overflow-y:auto;">
             ${previewShown.map(f => `<div data-arena-file="${escHtml(f)}">• <a href="javascript:void(0)" onclick="event.stopPropagation();MC.arena.peekFile('${escHtml(f)}')" style="color:#60a5fa;text-decoration:none;cursor:pointer;" title="Klick: aktuellen Inhalt / git diff anzeigen">${escHtml(f)}</a> <span class="arena-file-badge" style="font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;color:var(--text-muted);background:transparent;">…</span></div>`).join('')}
             ${previewFiles.length > 25 ? `<div style="color:var(--text-muted);">… und ${previewFiles.length - 25} weitere</div>` : ''}
           </div>
           <div style="font-size:9px;color:var(--text-muted);margin-top:6px;font-style:italic;">Heuristik aus Fazit &amp; letzten Nachrichten. <span style="color:#22c55e;font-weight:700;">NEU</span> = Executor legt Datei an · <span style="color:#94a3b8;">MOD</span> = existiert bereits · Klick: Inhalt / Diff.</div>
         </div>`
      : `<div style="background:var(--bg-tertiary);border:1px solid var(--border-medium);border-radius:8px;padding:10px 12px;">
           <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;font-weight:700;margin-bottom:4px;">Vorschau</div>
           <div id="arena-deep-preview-slot" style="font-size:11px;color:var(--text-muted);">Keine konkreten Dateipfade in der Diskussion erkannt. Executor arbeitet frei anhand des Briefings.</div>
           <button id="arena-deep-preview-btn" type="button" style="margin-top:8px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.35);color:#60a5fa;border-radius:5px;padding:5px 10px;font-size:11px;cursor:pointer;">🔬 Tiefe Analyse starten</button>
         </div>`;

    const lbl = 'font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;';
    const inp = 'width:100%;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:8px 10px;font-size:12px;outline:none;box-sizing:border-box;';

    modal.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-medium);border-radius:16px;width:100%;max-width:560px;padding:24px;">
        <h2 style="margin:0 0 4px;font-size:16px;color:var(--text-primary);">Mini-Auftrag vor dem Bau</h2>
        <p style="margin:0 0 14px;font-size:11px;color:var(--text-muted);line-height:1.5;">Klare Ziele, klarer Scope, klare Definition-of-Done. Die Bots bekommen diesen Auftrag woertlich als Briefing bevor sie loslegen.</p>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div>
            <label style="${lbl}">Ziel (was soll am Ende konkret rauskommen?)</label>
            <textarea id="brief-goal" style="${inp}height:54px;resize:vertical;" placeholder="z.B. Arena zeigt vor jedem Execute einen Mini-Brief Dialog">${escHtml(suggestedGoal)}</textarea>
          </div>
          <div>
            <label style="${lbl}">Scope / Grenzen (was gehoert NICHT dazu?)</label>
            <textarea id="brief-scope" style="${inp}height:44px;resize:vertical;" placeholder="z.B. Kein grosses Refactoring, keine neuen Dependencies"></textarea>
          </div>
          <div>
            <label style="${lbl}">Definition of Done (woran merken wir dass fertig?)</label>
            <textarea id="brief-dod" style="${inp}height:44px;resize:vertical;" placeholder="z.B. Modal erscheint, Brief wird als Nachricht geloggt, Robin kann bestaetigen"></textarea>
          </div>
          ${previewBlock}
          <div style="display:flex;gap:12px;align-items:flex-end;">
            <div style="flex:1;">
              <label style="${lbl}">Erfolgskriterium / Checkpoint</label>
              <input id="brief-check" type="text" style="${inp}" placeholder="Wie pruefen wir? z.B. 'Robin klickt Execute und sieht das Modal'">
            </div>
            <div>
              <label style="${lbl}">Turns</label>
              <input id="brief-turns" type="number" value="2" min="1" max="10" style="${inp}width:70px;">
            </div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
            <button id="brief-cancel" style="background:var(--bg-tertiary);border:1px solid var(--border-medium);color:var(--text-muted);border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;">Abbrechen</button>
            <button id="brief-submit" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:#ef4444;border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600;">Briefing freigeben &amp; bauen</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(modal);
    setTimeout(() => { const f = document.getElementById('brief-goal'); if (f) f.focus(); }, 50);
    // Async: prüfe welche Dateien schon existieren → markiere NEU vs MOD
    if (previewShown.length > 0) {
      (async () => {
        try {
          const q = encodeURIComponent(previewShown.join(','));
          const r = await fetch(`/api/arena/files-status?paths=${q}`);
          const j = await r.json();
          if (!j || !j.status) return;
          const plausible = j.plausible || {};
          let newCount = 0;
          let hidden = 0;
          previewShown.forEach(p => {
            const row = modal.querySelector(`[data-arena-file="${CSS.escape(p)}"]`);
            if (!row) return;
            const badge = row.querySelector('.arena-file-badge');
            const exists = j.status[p] === true;
            const isReal = exists || plausible[p] === true;
            // Filter: Pfade ohne echten Projekt-Bezug ausblenden (False Matches aus Prosa).
            if (!isReal) {
              row.style.display = 'none';
              hidden += 1;
              return;
            }
            if (!badge) return;
            if (exists) {
              badge.textContent = 'MOD';
              badge.style.color = '#94a3b8';
              badge.style.background = 'rgba(148,163,184,0.12)';
            } else {
              badge.textContent = 'NEU';
              badge.style.color = '#22c55e';
              badge.style.background = 'rgba(34,197,94,0.15)';
              badge.style.fontWeight = '700';
              newCount += 1;
            }
          });
          const ctr = document.getElementById('arena-preview-new-count');
          if (ctr) {
            const bits = [];
            if (newCount > 0) bits.push(`${newCount} NEU`);
            if (hidden > 0) bits.push(`<span style="color:#64748b;font-weight:500;">${hidden} ignoriert</span>`);
            if (bits.length) ctr.innerHTML = '· ' + bits.join(' · ');
          }
        } catch (e) {
          console.warn('[Arena] files-status fetch failed', e);
        }
      })();
    }
    document.getElementById('brief-cancel').onclick = () => modal.remove();
    document.getElementById('brief-submit').onclick = async () => {
      const goal = document.getElementById('brief-goal').value.trim();
      const scope = document.getElementById('brief-scope').value.trim();
      const dod = document.getElementById('brief-dod').value.trim();
      const check = document.getElementById('brief-check').value.trim();
      const turns = parseInt(document.getElementById('brief-turns').value) || 2;
      if (!goal) { alert('Ziel ist Pflicht — ohne Ziel kein Bau.'); return; }
      try {
        await fetch(`/api/arena/rooms/${roomId}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turns, brief: { goal, scope, dod, check } }),
        });
        const r = rooms.find(r => r.id === roomId);
        if (r) { r.tools_enabled = true; r.execution_turns_left = turns; }
        modal.remove();
        renderRoomView();
      } catch (e) {
        console.error('[Arena] Execute failed:', e);
      }
    };
  }

  async function requestSummary(roomId) {
    const btn = document.querySelector('[onclick*="requestSummary"]');
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    try {
      const res = await fetch(`/api/arena/rooms/${roomId}/summarize`, { method: 'POST' });
      const data = await res.json();
      // Update local room data
      const r = rooms.find(r => r.id === roomId);
      if (r) {
        r.orchestrator_summary = data.summary;
        r.orchestrator_summary_at = new Date().toISOString();
      }
      // Update orchestrator panel if open — render with action checkboxes
      const summaryEl = el('arena-orch-summary');
      if (summaryEl) summaryEl.innerHTML = renderFazitWithActions(data.summary, r);
      // Open orchestrator panel
      if (!_orchestratorOpen) toggleOrchestrator();
      // Refresh messages (summary was added as message)
      await loadRooms();
      renderRoomView();
    } catch (e) {
      console.error('[Arena] Summary failed:', e);
    } finally {
      if (btn) { btn.textContent = 'Fazit'; btn.disabled = false; }
    }
  }

  function toggleOrchestrator() {
    _orchestratorOpen = !_orchestratorOpen;
    const panel = el('arena-orchestrator-panel');
    if (panel) panel.style.display = _orchestratorOpen ? 'flex' : 'none';
  }

  async function chatOrchestrator() {
    const input = el('arena-orch-input');
    if (!input || !activeRoom) return;
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';

    // Show user message
    const msgsEl = el('arena-orch-messages');
    if (msgsEl) {
      msgsEl.innerHTML += `<div style="margin-bottom:8px;text-align:right;">
        <span style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.2);border-radius:6px;padding:4px 8px;font-size:11px;color:#f59e0b;display:inline-block;max-width:90%;text-align:left;">${escHtml(msg)}</span>
      </div>`;
      msgsEl.innerHTML += `<div id="arena-orch-loading" style="margin-bottom:8px;">
        <span style="font-size:10px;color:var(--text-muted);animation:pulse-dot 1.5s infinite;">Orchestrator denkt nach...</span>
      </div>`;
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    try {
      const res = await fetch(`/api/arena/rooms/${activeRoom}/orchestrator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();

      // Remove loading, add response
      const loadEl = document.getElementById('arena-orch-loading');
      if (loadEl) loadEl.remove();

      if (msgsEl) {
        msgsEl.innerHTML += `<div style="margin-bottom:8px;">
          <span style="background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.2);border-radius:6px;padding:6px 8px;font-size:11px;color:var(--text-primary);display:inline-block;max-width:90%;line-height:1.4;">${formatMarkdown(data.response)}</span>
        </div>`;
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    } catch (e) {
      const loadEl = document.getElementById('arena-orch-loading');
      if (loadEl) loadEl.innerHTML = `<span style="font-size:10px;color:#ef4444;">Fehler: ${e.message}</span>`;
    }
  }

  function editRoom(roomId) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    let modal = document.getElementById('arena-edit-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'arena-edit-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    const catOptions = ROOM_CATEGORIES.map(c =>
      `<option value="${c.id}" ${(room.category || 'general') === c.id ? 'selected' : ''}>${c.icon} ${c.label}</option>`
    ).join('');

    const botRows = (room.bots || []).map((b, i) => `
      <div class="arena-bot-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
        <input type="color" value="${b.color}" data-idx="${i}" data-field="color" style="width:28px;height:24px;border:none;background:none;cursor:pointer;">
        <input type="text" value="${escHtml(b.name)}" data-idx="${i}" data-field="name" placeholder="Name" style="width:70px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:5px;padding:4px 6px;font-size:11px;">
        <select data-idx="${i}" data-field="model" style="background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:5px;padding:4px 6px;font-size:11px;">
          <option value="haiku" ${b.model === 'haiku' ? 'selected' : ''}>Haiku</option>
          <option value="sonnet" ${b.model === 'sonnet' ? 'selected' : ''}>Sonnet</option>
          <option value="opus" ${b.model === 'opus' ? 'selected' : ''}>Opus</option>
        </select>
        <input type="text" value="${escHtml(b.persona)}" data-idx="${i}" data-field="persona" placeholder="Persona" style="flex:1;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:5px;padding:4px 6px;font-size:11px;">
        <button onclick="this.closest('.arena-bot-row').remove()" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.2);color:#ef4444;border-radius:5px;padding:3px 6px;font-size:10px;cursor:pointer;">X</button>
      </div>
    `).join('');

    modal.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-medium);border-radius:16px;width:100%;max-width:700px;max-height:85vh;overflow-y:auto;padding:24px;">
        <h2 style="margin:0 0 16px;font-size:16px;color:var(--text-primary);">Raum bearbeiten</h2>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;gap:10px;">
            <div style="flex:1;">
              <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Titel</label>
              <input id="arena-edit-title" type="text" value="${escHtml(room.title)}" style="width:100%;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:7px 10px;font-size:12px;outline:none;box-sizing:border-box;">
            </div>
            <div>
              <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Kategorie</label>
              <select id="arena-edit-category" style="background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:7px 10px;font-size:12px;">${catOptions}</select>
            </div>
          </div>
          <div>
            <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Thema</label>
            <textarea id="arena-edit-topic" style="width:100%;height:50px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:7px 10px;font-size:12px;outline:none;resize:vertical;box-sizing:border-box;">${escHtml(room.topic)}</textarea>
          </div>
          <div style="display:flex;gap:10px;">
            <div>
              <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;" title="Harte Obergrenze: maximal 25 Runden. Jede Runde = 1 Turn pro Bot.">Max Runden <span style="color:#f59e0b;">(Cap 25)</span></label>
              <input id="arena-edit-rounds" type="number" value="${Math.min(25, Math.max(1, room.max_rounds || Math.ceil((room.max_turns || 20) / Math.max(1, (room.bots || []).length || 2))))}" min="1" max="25" style="width:70px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:7px 10px;font-size:12px;outline:none;" title="Echte Rundenzahl (nicht Turns). Hard-Cap: 25.">
            </div>
            <div>
              <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px;">Fazit alle N</label>
              <input id="arena-edit-summarize" type="number" value="${room.summarize_every || 10}" min="0" max="50" style="width:70px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:6px;padding:7px 10px;font-size:12px;outline:none;" title="0 = kein Auto-Fazit">
            </div>
            <div style="display:flex;align-items:flex-end;padding-bottom:2px;">
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
                <input id="arena-edit-read" type="checkbox" ${room.allow_read !== false ? 'checked' : ''} style="accent-color:#6366f1;">
                <span style="font-size:11px;color:var(--text-primary);">Lesen erlaubt</span>
              </label>
            </div>
            <div style="display:flex;align-items:flex-end;padding-bottom:2px;">
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;" title="An: nach Umsetzung KEINE neue Bot-Runde. Einzel-Session liefert, Diskussion re-startet nicht automatisch.">
                <input id="arena-edit-single" type="checkbox" ${room.auto_continue === false ? 'checked' : ''} style="accent-color:#10b981;">
                <span style="font-size:11px;color:var(--text-primary);">Einzel-Session (kein Auto-Re-Loop)</span>
              </label>
            </div>
          </div>
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <label style="font-size:10px;color:var(--text-muted);">Bots</label>
              <button id="arena-add-bot-btn" style="background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.25);color:#818cf8;border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;">+ Bot</button>
            </div>
            <div id="arena-bot-rows">${botRows}</div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
            <button onclick="document.getElementById('arena-edit-modal').remove()" style="background:var(--bg-tertiary);border:1px solid var(--border-medium);color:var(--text-muted);border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;">Abbrechen</button>
            <button id="arena-save-btn" style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#818cf8;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;font-weight:600;">Speichern</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Add bot button
    document.getElementById('arena-add-bot-btn').onclick = () => {
      const nextPreset = BOT_PRESETS[document.querySelectorAll('.arena-bot-row').length % BOT_PRESETS.length];
      const row = document.createElement('div');
      row.className = 'arena-bot-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px;';
      const idx = document.querySelectorAll('.arena-bot-row').length;
      row.innerHTML = `
        <input type="color" value="${nextPreset.color}" data-idx="${idx}" data-field="color" style="width:28px;height:24px;border:none;background:none;cursor:pointer;">
        <input type="text" value="${nextPreset.name}" data-idx="${idx}" data-field="name" placeholder="Name" style="width:70px;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:5px;padding:4px 6px;font-size:11px;">
        <select data-idx="${idx}" data-field="model" style="background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:5px;padding:4px 6px;font-size:11px;">
          <option value="haiku">Haiku</option>
          <option value="sonnet" selected>Sonnet</option>
          <option value="opus">Opus</option>
        </select>
        <input type="text" value="${escHtml(nextPreset.persona)}" data-idx="${idx}" data-field="persona" placeholder="Persona" style="flex:1;background:var(--bg-input);border:1px solid var(--border-medium);color:var(--text-primary);border-radius:5px;padding:4px 6px;font-size:11px;">
        <button onclick="this.closest('.arena-bot-row').remove()" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.2);color:#ef4444;border-radius:5px;padding:3px 6px;font-size:10px;cursor:pointer;">X</button>
      `;
      document.getElementById('arena-bot-rows').appendChild(row);
    };

    // Save button
    document.getElementById('arena-save-btn').onclick = async () => {
      const bots = [];
      document.querySelectorAll('.arena-bot-row').forEach(row => {
        const name = row.querySelector('[data-field="name"]').value.trim() || 'Bot';
        const model = row.querySelector('[data-field="model"]').value;
        const color = row.querySelector('[data-field="color"]').value;
        const persona = row.querySelector('[data-field="persona"]').value.trim();
        bots.push({ name, model, color, persona });
      });

      const maxRoundsRaw = parseInt(document.getElementById('arena-edit-rounds').value) || 5;
      const maxRounds = Math.min(10, Math.max(1, maxRoundsRaw));
      // Echte Runden -> effektive Turns. Keine Fantasiezahlen.
      const effTurns = maxRounds * Math.max(1, bots.length);

      const payload = {
        title: document.getElementById('arena-edit-title').value.trim() || 'Raum',
        topic: document.getElementById('arena-edit-topic').value.trim(),
        category: document.getElementById('arena-edit-category').value,
        max_turns: effTurns,
        max_rounds: maxRounds,
        summarize_every: parseInt(document.getElementById('arena-edit-summarize').value) || 10,
        allow_read: document.getElementById('arena-edit-read').checked,
        auto_continue: !document.getElementById('arena-edit-single').checked,
        bots,
      };

      try {
        await fetch(`/api/arena/rooms/${roomId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        modal.remove();
        await loadRooms();
        renderRoomView();
      } catch (e) {
        console.error('[Arena] Save failed:', e);
      }
    };
  }

  // ── Live-Mitschrift (Typewriter fake-stream) ─────────────────────────
  // Spielt die Bot-Antwort zeichenweise in Kursiv ab, danach Swap auf finalen HTML-Content.
  // Kein echtes Backend-Streaming — UX-Effekt fuer "Live-Mitschrift waehrend er spricht".
  function liveTranscribe(bodyEl, scrollContainer, rawText) {
    if (!bodyEl || bodyEl._transcribing) return;
    const finalHtml = bodyEl.innerHTML;
    rawText = (rawText || '').toString();
    if (!rawText.trim()) return;

    bodyEl._transcribing = true;
    bodyEl.style.fontStyle = 'italic';
    bodyEl.style.opacity = '0.88';
    bodyEl.textContent = '';

    // ~45 Zeichen/s, Cap auf max 2.2s Gesamtdauer bei langen Texten
    const total = rawText.length;
    const targetMs = Math.min(2200, Math.max(400, total * 22));
    const chunkSize = Math.max(1, Math.ceil(total / (targetMs / 30)));
    let i = 0;
    const tick = () => {
      if (!document.body.contains(bodyEl)) return; // gone from DOM
      i = Math.min(total, i + chunkSize);
      bodyEl.textContent = rawText.slice(0, i);
      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
      if (i < total) {
        setTimeout(tick, 30);
      } else {
        // Fertig — finalen formatierten HTML einsetzen, Kursiv weg
        bodyEl.innerHTML = finalHtml;
        bodyEl.style.fontStyle = '';
        bodyEl.style.opacity = '';
        bodyEl._transcribing = false;
        if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    };
    setTimeout(tick, 30);
  }

  // ── WebSocket Events ───────────────────────────────────────────────────
  function handleWsEvent(data) {
    if (data.type === 'arena.message') {
      const room = rooms.find(r => r.id === data.room_id);
      if (room) {
        if (!room.messages) room.messages = [];
        room.messages.push(data.message);
      }
      const isOrchestrator = data.message && data.message.role === 'orchestrator';
      const isActiveAndVisible = data.room_id === activeRoom && MC.getCurrentView && MC.getCurrentView() === 'arena';

      if (data.room_id === activeRoom) {
        const msgBox = el('arena-messages');
        if (msgBox) {
          const thinkingEl = el('arena-thinking');
          if (thinkingEl) thinkingEl.style.display = 'none';

          if (msgBox.querySelector('[style*="text-align:center"]') && (room.messages || []).length <= 1) {
            msgBox.innerHTML = '';
          }
          const tmp = document.createElement('div');
          tmp.innerHTML = renderMessages([data.message]);
          const appended = tmp.firstElementChild;
          msgBox.appendChild(appended);
          msgBox.scrollTop = msgBox.scrollHeight;

          // Live-Mitschrift: Bot-Nachrichten typewriter-fake-streamen, kursiv bis fertig
          const role = data.message && data.message.role;
          if (role !== 'robin' && role !== 'approval') {
            const body = appended && appended.querySelector && appended.querySelector('.arena-msg-body');
            if (body) liveTranscribe(body, msgBox, data.message.content);
          }

          // If orchestrator message, update summary panel + auto-open it
          if (isOrchestrator) {
            if (room) {
              room.orchestrator_summary = data.message.content;
            }
            const summaryEl = el('arena-orch-summary');
            if (summaryEl) {
              summaryEl.innerHTML = renderFazitWithActions(data.message.content, room);
            }
            if (isActiveAndVisible) {
              MC.toast && MC.toast('Neues Fazit — rechts im Panel', 'info', 2500);
            }
          }
        }

        // Aktions-Sammler: Badge + Panel auto-refresh wenn neue [ACTION] erkannt
        if (data.message && data.message.content && /\[ACTION/i.test(data.message.content)) {
          const updRoom = rooms.find(r => r.id === activeRoom);
          if (updRoom) {
            updateSammlerBadge(updRoom);
            if (_sammlerOpen) refreshSammler();
          }
        }

        // TTS: auto-speak bot messages wenn aktiviert
        const _role = data.message && data.message.role;
        if (_ttsAutoEnabled && _role !== 'robin' && _role !== 'approval' && _role !== 'user') {
          _enqueueTts(data.message.content || '', data.message.name || 'Bot');
        }
      }

      // Persistent completion toast if Robin is elsewhere (other view or other room)
      if (isOrchestrator && !isActiveAndVisible && MC.completionToast) {
        const rawText = (data.message.content || '').toString();
        let preview = rawText.replace(/[#*_`~>\[\]()!|]/g, '').replace(/\n+/g, ' ').trim();
        if (preview.length > 140) preview = preview.slice(0, 137) + '…';
        const roomName = (room && room.name) || 'Arena';
        MC.completionToast({
          icon: '⚖️',
          label: 'Arena — Neues Fazit',
          title: roomName,
          preview,
          dedupKey: 'arena:' + data.room_id,
          onClick: () => {
            _setActiveRoom(data.room_id);
            if (MC.switchView) MC.switchView('arena');
            setTimeout(() => {
              renderRoomList();
              renderRoomView();
              _orchestratorOpen = true;
              const panel = el('arena-orchestrator-panel');
              if (panel) panel.style.display = 'flex';
            }, 100);
          },
        });
      }
      renderRoomList();
    } else if (data.type === 'arena.action.status') {
      // Per-action status update (pending -> running -> done/failed)
      updateActionStatus(data.approval_id, data.action_idx, data.status, data.result);
    } else if (data.type === 'arena.thinking') {
      if (data.room_id === activeRoom) {
        const thinkingEl = el('arena-thinking');
        const thinkingDot = el('arena-thinking-dot');
        const thinkingText = el('arena-thinking-text');
        if (thinkingEl) {
          thinkingEl.style.display = 'block';
          if (thinkingDot) thinkingDot.style.background = data.bot_color || '#6366f1';
          if (thinkingText) thinkingText.textContent = `${data.bot_name} denkt nach...`;
        }
      }
    } else if (data.type === 'arena.started') {
      const room = rooms.find(r => r.id === data.room_id);
      if (room) room.running = true;
      renderRoomList();
      if (data.room_id === activeRoom) renderRoomView();
    } else if (data.type === 'arena.mode_change') {
      const room = rooms.find(r => r.id === data.room_id);
      if (room) {
        room.tools_enabled = data.mode === 'execute';
        room.execution_turns_left = data.turns_left || 0;
      }
      if (data.room_id === activeRoom) {
        const modeBar = el('arena-mode-bar');
        if (modeBar) modeBar.style.display = data.mode === 'execute' ? 'flex' : 'none';
        const turnsEl = el('arena-exec-turns');
        if (turnsEl) turnsEl.textContent = `${data.turns_left || 0} Turns`;
      }
    } else if (data.type === 'arena.stopped') {
      const room = rooms.find(r => r.id === data.room_id);
      if (room) room.running = false;
      renderRoomList();
      if (data.room_id === activeRoom) {
        const thinkingEl = el('arena-thinking');
        if (thinkingEl) thinkingEl.style.display = 'none';
        renderRoomView();
      }
    } else if (data.type === 'arena.needs_decision') {
      const room = rooms.find(r => r.id === data.room_id);
      if (room) { room.running = false; room.awaiting_robin = true; room.awaiting_reason = data.verdict; }
      renderRoomList();
      if (data.room_id === activeRoom) {
        const thinkingEl = el('arena-thinking');
        if (thinkingEl) thinkingEl.style.display = 'none';
        if (data.verdict !== 'consensus' && !_orchestratorOpen) {
          _orchestratorOpen = true;
          const panel = el('arena-orchestrator-panel');
          if (panel) panel.style.display = 'flex';
        }
        renderRoomView();
      }
      const label = data.verdict === 'consensus' ? 'Bots sind sich einig' : 'Bots drehen sich im Kreis';
      const roomHere = rooms.find(r => r.id === data.room_id);
      const viewing = data.room_id === activeRoom && MC.getCurrentView && MC.getCurrentView() === 'arena';
      if (viewing) {
        MC.toast && MC.toast(`Arena pausiert: ${label} — deine Entscheidung`, 'info', 6000);
      } else if (MC.completionToast) {
        MC.completionToast({
          icon: data.verdict === 'consensus' ? '✅' : '⚠️',
          label: `Arena — ${label}`,
          title: (roomHere && roomHere.name) || 'Arena',
          preview: 'Robin-Entscheidung benötigt',
          dedupKey: 'arena-decision:' + data.room_id,
          onClick: () => {
            _setActiveRoom(data.room_id);
            if (MC.switchView) MC.switchView('arena');
            setTimeout(() => { renderRoomList(); renderRoomView(); }, 100);
          },
        });
      }
    } else if (data.type === 'arena.executor') {
      if (data.room_id === activeRoom && data.status === 'done') {
        // Collect done/failed summary from approval messages
        const room = rooms.find(r => r.id === data.room_id);
        const doneActions = [];
        (room?.messages || []).forEach(m => {
          if (m.role === 'approval' && m.actions) {
            m.actions.forEach(a => {
              if (a.status === 'done') doneActions.push(a.text);
            });
          }
        });
        const contextSummary = doneActions.length
          ? doneActions.map((a, i) => `${i + 1}. ${a}`).join('\n')
          : `${data.actions_count} Aktion(en) abgeschlossen`;

        // Show continuation button in Fazit panel
        const summaryEl = el('arena-orch-summary');
        if (summaryEl) {
          const btnId = `continue-btn-${Date.now()}`;
          const continueBanner = document.createElement('div');
          continueBanner.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px dashed rgba(16,185,129,0.3);';
          continueBanner.innerHTML = `
            <div style="font-size:10px;color:#10b981;margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">
              Umsetzung abgeschlossen
            </div>
            <button id="${btnId}"
              style="width:100%;padding:9px 16px;border-radius:7px;border:1px solid rgba(99,102,241,0.4);background:rgba(99,102,241,0.12);color:#6366f1;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;"
              onmouseover="this.style.background='rgba(99,102,241,0.25)'"
              onmouseout="this.style.background='rgba(99,102,241,0.12)'"
              onclick="MC.arena.continueDiscussion(${JSON.stringify(contextSummary)})">
              Weiter-Diskutieren →
            </button>`;
          summaryEl.appendChild(continueBanner);
          // Auto-open panel
          if (!_orchestratorOpen) {
            _orchestratorOpen = true;
            const panel = el('arena-orchestrator-panel');
            if (panel) panel.style.display = 'flex';
          }
        }
        // Auto-open Results-Panel damit Robin die Ergebnisse ungefragt sieht
        if (!_resultsOpen) {
          _resultsOpen = true;
          const rpanel = el('arena-results-panel');
          if (rpanel) rpanel.style.display = 'flex';
        }
        // Frisch rendern (neueste Executor-Msg + alle Action-Results)
        try {
          const room = rooms.find(r => r.id === activeRoom);
          const body = el('arena-results-body');
          if (body && room) body.innerHTML = renderResultsPanel(room);
        } catch (_) {}
        MC.toast && MC.toast(`${data.actions_count} Aktion(en) fertig — Ergebnisse sind offen`, 'success', 3000);
      }
      // Persistent toast if user isn't watching the arena right now
      if (data.status === 'done') {
        const roomHere = rooms.find(r => r.id === data.room_id);
        const viewing = data.room_id === activeRoom && MC.getCurrentView && MC.getCurrentView() === 'arena';
        if (!viewing && MC.completionToast) {
          MC.completionToast({
            icon: '✅',
            label: 'Arena — Executor fertig',
            title: (roomHere && roomHere.name) || 'Arena',
            preview: `${data.actions_count || 0} Aktion(en) abgeschlossen`,
            dedupKey: 'arena-exec:' + data.room_id,
            onClick: () => {
              _setActiveRoom(data.room_id);
              if (MC.switchView) MC.switchView('arena');
              setTimeout(() => { renderRoomList(); renderRoomView(); }, 100);
            },
          });
        }
      }
    }
  }

  // ── Screenshot Paste (Strg+V) ──────────────────────────────────────────
  // Pastes image from clipboard into arena inject/orch inputs by uploading
  // to /api/upload and appending a markdown link to the input value.
  async function handleArenaPaste(ev) {
    const target = ev.target;
    if (!target || !target.id) return;
    if (target.id !== 'arena-inject-input' && target.id !== 'arena-orch-input') return;
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    let imgItem = null;
    for (const it of items) {
      if (it && it.type && it.type.startsWith('image/')) { imgItem = it; break; }
    }
    if (!imgItem) return; // let normal paste proceed for text
    ev.preventDefault();
    const file = imgItem.getAsFile();
    if (!file) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const named = new File([file], `screenshot-${ts}.${ext}`, { type: file.type });
    const placeholder = ' [Bild wird hochgeladen...]';
    // Synthetisches input-Event nach jedem value-Write, damit Mic-Handler
    // (arena.js:1699) baseText mitzieht und Speech-Results den Paste-Text
    // nicht ueberschreiben.
    const fireInput = () => { try { target.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} };
    target.value = (target.value || '') + placeholder;
    fireInput();
    try {
      const fd = new FormData();
      fd.append('file', named);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok || !j.filename) throw new Error(j.error || 'Upload fehlgeschlagen');
      const url = `/api/uploads/${j.filename}`;
      const link = ` [Screenshot](${url})`;
      target.value = (target.value || '').replace(placeholder, link);
      fireInput();
      MC.toast && MC.toast('Screenshot hochgeladen', 'success', 1500);
    } catch (e) {
      target.value = (target.value || '').replace(placeholder, '');
      fireInput();
      MC.toast && MC.toast('Screenshot-Upload fehlgeschlagen: ' + (e.message || e), 'error', 3000);
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────
  function init() {
    loadRooms();
    if (!window._arenaPasteHooked) {
      window._arenaPasteHooked = true;
      document.addEventListener('paste', handleArenaPaste, true);
    }
    if (!window._arenaWsHooked && MC.ws) {
      window._arenaWsHooked = true;
      MC.ws.on('arena.message', handleWsEvent);
      MC.ws.on('arena.thinking', handleWsEvent);
      MC.ws.on('arena.started', handleWsEvent);
      MC.ws.on('arena.stopped', handleWsEvent);
      MC.ws.on('arena.mode_change', handleWsEvent);
      MC.ws.on('arena.executor', handleWsEvent);
      MC.ws.on('arena.action.status', handleWsEvent);
      MC.ws.on('arena.needs_decision', handleWsEvent);
      // After server restart: re-fetch rooms + refresh active view
      MC.ws.on('_ws_reconnect', () => {
        loadRooms().then(() => {
          if (activeRoom) renderRoomView();
        });
      });
      // Server sent explicit restart signal → show paused rooms
      MC.ws.on('arena.server_restart', () => {
        loadRooms().then(() => {
          if (activeRoom) renderRoomView();
          // Show banner if any rooms were paused by the restart
          const paused = rooms.filter(r => r.status === 'paused');
          if (paused.length) {
            const names = paused.map(r => r.title).join(', ');
            MC.toast && MC.toast(`Server neugestartet — ${paused.length} Raum(e) pausiert: ${names}`, 'warning', 5000);
          }
        });
      });
    }
  }

  // ── TTS: Auto-speak bot messages ──────────────────────────────────────
  async function _speakBotMessage(content, botName, onDone) {
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${botName}: ${content}` })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.audio_url) {
          const audio = new Audio(data.audio_url);
          const finish = () => onDone && onDone();
          audio.addEventListener('ended', finish);
          audio.addEventListener('error', finish);
          audio.play().catch(e => {
            console.log('Audio play suppressed:', e.message);
            finish();
          });
          return;
        }
      }
    } catch (e) {
      console.log('TTS failed silently:', e.message);
    }
    onDone && onDone();
  }

  // TTS queue — serializes playback and gates the mic in Meeting Mode
  function _enqueueTts(content, botName) {
    _ttsQueue.push({ content, botName });
    if (!_ttsBusy) _processTtsQueue();
  }

  function _processTtsQueue() {
    if (_ttsQueue.length === 0) {
      _ttsBusy = false;
      _ttsPlaying = false;
      _updateMeetingStatusTts(false);
      // Mic wieder freigeben wenn alle TTS-Ausgaben abgespielt
      if (_meetingMode && _meetingRec && _meetingMicMuted) {
        _meetingMicMuted = false;
        setTimeout(() => {
          if (_meetingMode && _meetingRec && !_meetingMicMuted) {
            try { _meetingRec.start(); } catch (_) {}
          }
        }, 400);
      }
      return;
    }
    _ttsBusy = true;
    _ttsPlaying = true;
    const { content, botName } = _ttsQueue.shift();
    _updateMeetingStatusTts(true, botName);
    // Mic stoppen damit Bot-Sprache nicht als Nutzereingabe erkannt wird
    if (_meetingMode && _meetingRec && !_meetingMicMuted) {
      _meetingMicMuted = true;
      try { _meetingRec.stop(); } catch (_) {}
    }
    _speakBotMessage(content, botName, () => {
      _processTtsQueue();
    });
  }

  function _updateMeetingStatusTts(playing, botName) {
    const statusEl = document.getElementById('arena-meeting-status');
    if (!statusEl) return;
    if (playing) {
      statusEl.textContent = `${botName} spricht…`;
      statusEl.style.color = '#f59e0b';
    } else {
      statusEl.textContent = 'Sprich frei — jede Aussage geht sofort rein';
      statusEl.style.color = '';
    }
  }

  function _triggerTtsForNewMessages(room) {
    if (!room || !room.messages) return;
    room.messages.forEach(m => {
      const isBot = m.role !== 'robin' && m.role !== 'user' && m.role !== 'executor';
      const msgId = `${room.id}-${m.timestamp || m.name}`;
      if (isBot && !_spokenMessageIds.has(msgId)) {
        _spokenMessageIds.add(msgId);
        _speakBotMessage(m.content || '', m.name || 'Bot');
      }
    });
  }

  function destroy() {
    if (_refreshTimer) clearInterval(_refreshTimer);
  }

  // ── Continue Discussion after Executor ───────────────────────────────
  async function continueDiscussion(contextSummary) {
    if (!activeRoom) return;
    const btn = document.querySelector('[onclick*="continueDiscussion"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Starte Diskussion...'; btn.style.opacity = '0.6'; }
    try {
      await fetch(`/api/arena/rooms/${activeRoom}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: contextSummary }),
      });
      MC.toast && MC.toast('Diskussion wird fortgesetzt...', 'info', 2000);
    } catch (e) {
      MC.toast && MC.toast('Fehler beim Fortsetzen', 'error', 3000);
      if (btn) { btn.disabled = false; btn.textContent = 'Weiter-Diskutieren →'; btn.style.opacity = '1'; }
    }
  }

  // ── File-Preview fuer Umsetzen-Knopf ─────────────────────────────────
  // Scannt die genehmigten Aktionstexte nach Datei-Pfaden und zeigt eine
  // Bestaetigungsdialog, damit Robin sieht, was der Executor wirklich anfassen
  // wird, bevor die Aktion losgetreten wird.
  function extractFilePreview(actions) {
    const exts = 'py|js|ts|tsx|jsx|mjs|cjs|md|json|html|htm|css|scss|yaml|yml|sh|ps1|bat|toml|ini|cfg|txt|xml|svg|vue|rs|go|java|cpp|hpp|c|h|rb|php|sql|env';
    const pathRe = new RegExp('([A-Za-z0-9_./\\\\-]+\\.(?:' + exts + '))\\b', 'g');
    const dirRe = /(?:^|\s|`|")([A-Za-z0-9_-]+\/[A-Za-z0-9_./\\-]+)(?=\s|`|"|$|,|;|\))/g;
    const files = new Set();
    (actions || []).forEach(a => {
      const txt = String(a || '');
      let m;
      while ((m = pathRe.exec(txt)) !== null) {
        const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
        if (p.length > 2 && !/^\d+\./.test(p)) files.add(p);
      }
      while ((m = dirRe.exec(txt)) !== null) {
        const p = m[1].replace(/\\/g, '/');
        if (p.includes('.') && p.length > 3) files.add(p);
      }
    });
    return Array.from(files).sort();
  }

  // HTML-Modal statt confirm(): Dateien sind klickbar und oeffnen Inhalt/Diff.
  function confirmFilePreview(actions) {
    const files = extractFilePreview(actions);
    return new Promise((resolve) => {
      const esc = (s) => String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
      const actList = actions.map((a, i) => {
        const t = String(a || '').replace(/\s+/g, ' ').trim();
        return `<div style="padding:4px 6px;border-left:2px solid rgba(245,158,11,0.4);margin:3px 0;font-size:12px;color:#ccc;">${i + 1}. ${esc(t.length > 160 ? t.slice(0, 160) + '...' : t)}</div>`;
      }).join('');
      const fileItems = files.length === 0
        ? `<div style="color:#888;font-style:italic;font-size:12px;">Keine konkreten Dateipfade erkannt.</div>`
        : files.slice(0, 40).map(f => `
          <div class="arena-prev-file" data-path="${esc(f)}"
               style="padding:6px 10px;border-radius:4px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);margin:3px 0;cursor:pointer;font-family:monospace;font-size:12px;color:#93c5fd;display:flex;justify-content:space-between;align-items:center;gap:6px;"
               title="Klick: Inhalt/Diff anzeigen">
            <span class="arena-prev-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;">📄 ${esc(f)}</span>
            <span class="arena-prev-badge" style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;color:#64748b;background:rgba(100,116,139,0.12);letter-spacing:0.5px;">…</span>
            <button type="button" class="arena-prev-miss" data-path="${esc(f)}"
                    style="font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid rgba(239,68,68,0.35);background:rgba(239,68,68,0.08);color:#fca5a5;cursor:pointer;"
                    title="Fehlklick — Datei gehoert hier nicht rein. System lernt daraus.">👎 daneben</button>
            <span style="font-size:10px;color:#64748b;">öffnen →</span>
          </div>`).join('');
      const moreNote = files.length > 40 ? `<div style="color:#888;font-size:11px;margin-top:4px;">… und ${files.length - 40} weitere</div>` : '';
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
      overlay.innerHTML = `
        <div style="background:#0f172a;border:1px solid rgba(59,130,246,0.4);border-radius:8px;max-width:900px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.6);">
          <div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center;">
            <div style="font-weight:600;color:#e2e8f0;">Vorschau — Umsetzung bestätigen</div>
            <button class="arena-prev-close" style="background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="flex:1;overflow:auto;padding:14px 18px;display:grid;grid-template-columns:300px 1fr;gap:14px;min-height:300px;">
            <div style="border-right:1px solid rgba(255,255,255,0.06);padding-right:12px;overflow:auto;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Dateien (${files.length}) <span class="arena-prev-header-count" style="color:#10b981;font-weight:700;"></span></div>
              ${fileItems}${moreNote}
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 6px;">Aktionen (${actions.length})</div>
              ${actList}
            </div>
            <div class="arena-prev-viewer" style="overflow:auto;background:#020617;border-radius:6px;padding:12px;font-family:monospace;font-size:12px;color:#cbd5e1;white-space:pre-wrap;">
              <span style="color:#64748b;font-style:italic;">← Klick auf eine Datei zeigt hier Inhalt bzw. Git-Diff.</span>
            </div>
          </div>
          <div style="padding:12px 18px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end;gap:8px;">
            <button class="arena-prev-cancel" style="padding:8px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#cbd5e1;border-radius:4px;cursor:pointer;">Abbrechen</button>
            <button class="arena-prev-ok" style="padding:8px 16px;background:rgba(16,185,129,0.2);border:1px solid rgba(16,185,129,0.5);color:#10b981;border-radius:4px;cursor:pointer;font-weight:600;">Umsetzen →</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      // Async: Dateien mit NEU/MOD markieren, damit Robin auf einen Blick sieht,
      // welche Files der Executor neu anlegt vs. welche er nur aendert.
      if (files.length > 0) {
        (async () => {
          try {
            const q = encodeURIComponent(files.slice(0, 40).join(','));
            const r = await fetch(`/api/arena/files-status?paths=${q}`);
            const j = await r.json();
            if (!j || !j.status) return;
            let newCount = 0;
            overlay.querySelectorAll('.arena-prev-file').forEach(row => {
              const p = row.getAttribute('data-path');
              const badge = row.querySelector('.arena-prev-badge');
              if (!badge || !(p in j.status)) return;
              if (j.status[p]) {
                badge.textContent = 'MOD';
                badge.style.color = '#94a3b8';
                badge.style.background = 'rgba(148,163,184,0.15)';
              } else {
                badge.textContent = 'NEU';
                badge.style.color = '#10b981';
                badge.style.background = 'rgba(16,185,129,0.18)';
                // Subtle highlight on the whole row so new files pop out
                row.style.borderColor = 'rgba(16,185,129,0.45)';
                row.style.background = 'rgba(16,185,129,0.07)';
                newCount += 1;
              }
            });
            if (newCount > 0) {
              const hdr = overlay.querySelector('.arena-prev-header-count');
              if (hdr) hdr.textContent = `· ${newCount} NEU`;
            }
          } catch (_) { /* best-effort */ }
        })();
      }
      const close = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector('.arena-prev-close').onclick = () => close(false);
      overlay.querySelector('.arena-prev-cancel').onclick = () => close(false);
      overlay.querySelector('.arena-prev-ok').onclick = () => close(true);
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(false); });
      const viewer = overlay.querySelector('.arena-prev-viewer');
      // Fehlklick-Tracking: User flagt eine Vorschau-Datei als daneben.
      // Klick auf den Button stoppt die Propagation (kein File-Open), sendet
      // Signal an den Server und markiert die Zeile visuell als "daneben".
      overlay.querySelectorAll('.arena-prev-miss').forEach(btn => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          const p = btn.getAttribute('data-path');
          const row = btn.closest('.arena-prev-file');
          btn.disabled = true;
          btn.textContent = '…';
          try {
            const r = await fetch('/api/arena/preview-misclick', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file: p, room_id: activeRoom, actions }),
            });
            const j = await r.json();
            if (j && j.ok) {
              btn.textContent = '✓ gemerkt';
              btn.style.color = '#94a3b8';
              btn.style.borderColor = 'rgba(148,163,184,0.4)';
              btn.style.background = 'rgba(148,163,184,0.12)';
              if (row) {
                row.style.opacity = '0.45';
                row.style.textDecoration = 'line-through';
                const lbl = row.querySelector('.arena-prev-label');
                if (lbl) lbl.title = 'Als Fehlklick markiert — System lernt aus diesem Signal.';
              }
              MC.toast && MC.toast('Fehlklick erfasst. Heuristik lernt mit.', 'info', 1500);
            } else {
              btn.textContent = '👎 daneben';
              btn.disabled = false;
              MC.toast && MC.toast('Konnte Fehlklick nicht speichern.', 'error', 2000);
            }
          } catch (_) {
            btn.textContent = '👎 daneben';
            btn.disabled = false;
            MC.toast && MC.toast('Netzwerkfehler beim Fehlklick-Log.', 'error', 2000);
          }
        };
      });
      overlay.querySelectorAll('.arena-prev-file').forEach(el => {
        el.onclick = async (ev) => {
          if (ev.target && ev.target.closest && ev.target.closest('.arena-prev-miss')) return;
          const p = el.getAttribute('data-path');
          overlay.querySelectorAll('.arena-prev-file').forEach(e => {
            e.style.background = 'rgba(59,130,246,0.08)';
            e.style.borderColor = 'rgba(59,130,246,0.25)';
          });
          el.style.background = 'rgba(59,130,246,0.2)';
          el.style.borderColor = 'rgba(59,130,246,0.6)';
          viewer.innerHTML = '<span style="color:#64748b;">Lade ' + esc(p) + '…</span>';
          try {
            const r = await fetch('/api/arena/file-peek?path=' + encodeURIComponent(p));
            const d = await r.json();
            if (!d.ok) { viewer.innerHTML = '<span style="color:#ef4444;">Fehler: ' + esc(d.error || '?') + '</span>'; return; }
            const header = `<div style="color:#94a3b8;font-size:11px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:6px;">${esc(d.path)}${d.exists ? ` · ${d.size} B` : ' · (neu, noch nicht vorhanden)'}${d.note ? ` · ${esc(d.note)}` : ''}</div>`;
            let body = '';
            if (d.diff) {
              body += '<div style="color:#f59e0b;font-size:11px;margin-bottom:4px;">Git-Diff (HEAD):</div>';
              body += '<pre style="margin:0 0 12px;color:#fbbf24;">' + esc(d.diff) + '</pre>';
              body += '<div style="color:#94a3b8;font-size:11px;margin-bottom:4px;">Aktueller Inhalt:</div>';
            }
            body += '<pre style="margin:0;">' + esc(d.content || '(leer)') + '</pre>';
            viewer.innerHTML = header + body;
          } catch (e) {
            viewer.innerHTML = '<span style="color:#ef4444;">Netzwerkfehler</span>';
          }
        };
      });
    });
  }

  // ── Approve from Fazit panel (right side) ────────────────────────────
  async function approveFromPanel(panelMsgId) {
    if (!activeRoom) return;
    const container = document.getElementById(panelMsgId);
    if (!container) return;
    const checkboxes = container.querySelectorAll('.arena-panel-action-cb');
    const approved = [];
    const rejected = [];
    checkboxes.forEach(cb => {
      const label = cb.parentElement.querySelector('span');
      if (!label) return;
      if (cb.checked) approved.push(label.textContent);
      else rejected.push(label.textContent);
    });
    if (approved.length === 0) {
      MC.toast && MC.toast('Keine Aktionen ausgewaehlt', 'warning', 2000);
      return;
    }
    if (!(await confirmFilePreview(approved))) {
      MC.toast && MC.toast('Umsetzen abgebrochen', 'info', 1500);
      return;
    }
    let rejectReason = '';
    if (rejected.length > 0) {
      rejectReason = (prompt(`Warum Weg A (die ${approved.length} gewaehlten) statt der ${rejected.length} Alternativen? (optional, leer = ueberspringen)`) || '').trim();
    }
    const btn = container.querySelector('button');
    if (btn) { btn.disabled = true; btn.textContent = 'Executor wird gestartet...'; btn.style.opacity = '0.6'; }
    try {
      const res = await fetch(`/api/arena/rooms/${activeRoom}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: approved, rejected, reject_reason: rejectReason }),
      });
      const data = await res.json();
      if (data.ok) {
        if (btn) { btn.textContent = `Executor laeuft (${approved.length})`; btn.style.background = 'rgba(16,185,129,0.3)'; }
        MC.toast && MC.toast(`Executor gestartet: ${approved.length} Aktionen`, 'success', 3000);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = 'Ausgewaehlte umsetzen lassen'; btn.style.opacity = '1'; }
        MC.toast && MC.toast(data.error || 'Fehler', 'error', 3000);
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Ausgewaehlte umsetzen lassen'; btn.style.opacity = '1'; }
      MC.toast && MC.toast('Netzwerkfehler', 'error', 3000);
    }
  }

  // ── Action status live update (called from WS handler) ──────────────
  function updateActionStatus(approvalId, actionIdx, status, result) {
    const row = document.querySelector(`.arena-approval-action[data-approval-id="${approvalId}"][data-action-idx="${actionIdx}"]`);
    if (!row) return;
    const badge = row.querySelector('.arena-approval-badge');
    if (badge) {
      if (status === 'running') {
        badge.innerHTML = '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(245,158,11,0.2);color:#f59e0b;animation:pulse-dot 1.5s infinite;">laeuft...</span>';
      } else if (status === 'done') {
        badge.innerHTML = '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(16,185,129,0.2);color:#10b981;font-weight:700;">&check; fertig</span>';
        row.style.background = 'rgba(16,185,129,0.05)';
        row.style.borderColor = 'rgba(16,185,129,0.2)';
      } else if (status === 'failed') {
        badge.innerHTML = '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(239,68,68,0.2);color:#ef4444;font-weight:700;">&cross; Fehler</span>';
        row.style.background = 'rgba(239,68,68,0.05)';
        row.style.borderColor = 'rgba(239,68,68,0.2)';
      } else if (status === 'haengend') {
        badge.innerHTML = '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(139,92,246,0.2);color:#a78bfa;font-weight:700;">&#8987; haengend</span>';
        row.style.background = 'rgba(139,92,246,0.05)';
        row.style.borderColor = 'rgba(139,92,246,0.2)';
      }
    }
    if (result) {
      const resultEl = row.querySelector('.arena-approval-result');
      if (resultEl) {
        resultEl.textContent = result;
        resultEl.style.display = 'block';
      }
    }
    // Auto-push: sobald ein echtes Resultat vorliegt, Panel automatisch oeffnen
    // (damit Robin nicht mehr selbst nachgucken muss)
    const hasFinishedResult = (status === 'done' || status === 'failed') && !!result;
    if (hasFinishedResult && !_resultsOpen) {
      _resultsOpen = true;
      const panel = el('arena-results-panel');
      if (panel) panel.style.display = 'flex';
      // Dezenter Toast mit Preview des Resultats (erste Zeile, max ~140 Zeichen)
      try {
        const preview = String(result).split('\n').find(l => l.trim().length > 0) || String(result);
        const shortPreview = preview.length > 140 ? preview.slice(0, 140) + '...' : preview;
        const icon = status === 'done' ? '&check;' : '&cross;';
        MC.toast && MC.toast(`${icon} Resultat da: ${shortPreview}`, status === 'done' ? 'success' : 'error', 5000);
      } catch (_) {}
    }
    // Live-refresh the results panel (nur wenn jetzt offen)
    if (_resultsOpen) {
      const room = rooms.find(r => r.id === activeRoom);
      const body = el('arena-results-body');
      if (body && room) body.innerHTML = renderResultsPanel(room);
    }
    // Badge am "Ergebnisse"-Toggle-Button live aktualisieren
    try {
      const room = rooms.find(r => r.id === activeRoom);
      if (room) {
        const btn = document.querySelector('button[onclick*="toggleResults"]');
        if (btn && !btn.closest('#arena-results-panel')) {
          btn.innerHTML = `Ergebnisse${countRoomResultsBadge(room)}`;
        }
      }
    } catch (_) {}
  }

  // ── Approve Actions (Gruenes Licht) ──────────────────────────────────
  async function approveActions(msgId) {
    if (!activeRoom) return;
    const container = document.getElementById(msgId);
    if (!container) return;

    // Collect checked + unchecked action texts (Gegenstimmen bleiben sichtbar)
    const checkboxes = container.querySelectorAll('.arena-action-cb');
    const approved = [];
    const rejected = [];
    checkboxes.forEach(cb => {
      const label = cb.parentElement.querySelector('span');
      if (!label) return;
      if (cb.checked) approved.push(label.textContent);
      else rejected.push(label.textContent);
    });

    if (approved.length === 0) {
      MC.toast && MC.toast('Keine Aktionen ausgewaehlt', 'warning', 2000);
      return;
    }
    let rejectReason = '';
    if (rejected.length > 0) {
      rejectReason = (prompt(`Warum Weg A (die ${approved.length} gewaehlten) statt der ${rejected.length} Alternativen? (optional, leer = ueberspringen)`) || '').trim();
    }

    // Disable button + show loading
    const btn = container.querySelector('button');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Executor wird gestartet...';
      btn.style.opacity = '0.6';
    }

    try {
      const res = await fetch(`/api/arena/rooms/${activeRoom}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: approved, rejected, reject_reason: rejectReason }),
      });
      const data = await res.json();
      if (data.ok) {
        if (btn) {
          btn.textContent = `Executor laeuft (${approved.length} Items)`;
          btn.style.background = 'rgba(16,185,129,0.3)';
        }
        MC.toast && MC.toast(`Executor gestartet: ${approved.length} Aktionen`, 'success', 3000);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = 'Gruenes Licht — Ausgewaehlte umsetzen'; btn.style.opacity = '1'; }
        MC.toast && MC.toast(data.error || 'Fehler', 'error', 3000);
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Gruenes Licht — Ausgewaehlte umsetzen'; btn.style.opacity = '1'; }
      MC.toast && MC.toast('Netzwerkfehler', 'error', 3000);
    }
  }

  // ── Mic / Speech-to-Text fuer Inject-Feld ─────────────────────────────
  let _mic = { rec: null, active: false, baseText: '', finalText: '', roomId: null };

  // Hartes Mikro-Reset (fuer Raum-Wechsel): Recognition beenden, Overlay weg,
  // ── Dauer-Dialog / Meeting Mode ───────────────────────────────────────
  function _stopMeetingMode() {
    if (!_meetingMode && !_meetingRec) return;
    _meetingMode = false;
    _meetingMicMuted = false;
    if (_meetingRec) {
      try { _meetingRec.stop(); } catch (_) {}
      _meetingRec = null;
    }
    if (MC.voiceListener && typeof MC.voiceListener.resume === 'function') {
      try { MC.voiceListener.resume(); } catch (_) {}
    }
  }

  function toggleTts() {
    _ttsAutoEnabled = !_ttsAutoEnabled;
    localStorage.setItem('arena_tts_auto', _ttsAutoEnabled ? 'true' : 'false');
    const btn = document.getElementById('arena-tts-btn');
    if (btn) {
      btn.textContent = _ttsAutoEnabled ? '🔊 Ton an' : '🔇 Ton aus';
      btn.style.background = _ttsAutoEnabled ? 'rgba(245,158,11,0.22)' : 'rgba(245,158,11,0.08)';
      btn.style.borderColor = _ttsAutoEnabled ? 'rgba(245,158,11,0.6)' : 'rgba(245,158,11,0.2)';
    }
    MC.toast && MC.toast(_ttsAutoEnabled ? 'Bot-Sprachausgabe aktiviert' : 'Bot-Sprachausgabe deaktiviert', 'info', 1500);
    if (!_ttsAutoEnabled) {
      // Laufende Queue leeren
      _ttsQueue = [];
    }
  }

  function toggleMeetingMode(roomId) {
    if (_meetingMode) {
      _stopMeetingMode();
      renderRoomView();
      MC.toast && MC.toast('Meeting beendet', 'info', 1500);
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      MC.toast && MC.toast('Browser unterstuetzt kein Web Speech API', 'error', 3000);
      return;
    }

    // Pausiere Wake-Word-Listener um Konflikte zu vermeiden
    if (MC.voiceListener && typeof MC.voiceListener.pause === 'function') {
      try { MC.voiceListener.pause(); } catch (_) {}
    }

    _meetingMode = true;
    renderRoomView();

    const rec = new SR();
    rec.lang = 'de-DE';
    rec.interimResults = true;
    rec.continuous = true;
    _meetingRec = rec;

    rec.addEventListener('result', (e) => {
      if (!_meetingMode) return;
      const statusEl = document.getElementById('arena-meeting-status');
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text.length > 1) {
            injectText(roomId, text);
            if (statusEl) statusEl.textContent = '\u201e' + text.slice(0, 45) + (text.length > 45 ? '\u2026' : '') + '\u201c';
          }
        } else {
          const interim = result[0].transcript;
          if (statusEl) statusEl.textContent = interim.slice(0, 55) + (interim.length > 55 ? '\u2026' : '');
        }
      }
    });

    rec.addEventListener('end', () => {
      if (_meetingMode && _meetingRec && !_meetingMicMuted) {
        setTimeout(() => {
          if (_meetingMode && _meetingRec && !_meetingMicMuted) {
            try { _meetingRec.start(); } catch (_) {}
          }
        }, 300);
      }
    });

    rec.addEventListener('error', (e) => {
      if (e.error === 'not-allowed') {
        _stopMeetingMode();
        renderRoomView();
        MC.toast && MC.toast('Mikrofon nicht erlaubt', 'error', 3000);
        return;
      }
      if (_meetingMode && _meetingRec && !_meetingMicMuted) {
        setTimeout(() => {
          if (_meetingMode && _meetingRec && !_meetingMicMuted) {
            try { _meetingRec.start(); } catch (_) {}
          }
        }, 500);
      }
    });

    try {
      rec.start();
      MC.toast && MC.toast('Meeting-Modus aktiv — sprich frei!', 'info', 2000);
    } catch (err) {
      _stopMeetingMode();
      renderRoomView();
      MC.toast && MC.toast('Mikrofon konnte nicht starten', 'error', 2500);
    }
  }

  // Listener abhaengen, Button-State zuruecksetzen, Voice-Listener wieder an.
  function _stopMicHard() {
    if (!_mic.active && !_mic.rec) return;
    _mic.resetPending = false; // kein Auto-Restart im end-Handler
    const input = _mic.onUserInput && document.getElementById('arena-inject-input');
    if (input && _mic.onUserInput) {
      try { input.removeEventListener('input', _mic.onUserInput); } catch (_) {}
    }
    _mic.onUserInput = null;
    if (_mic.liveEl) {
      try { _mic.liveEl.remove(); } catch (_) {}
      _mic.liveEl = null;
    }
    try { _mic.rec && _mic.rec.stop(); } catch (_) {}
    try { _mic.rec && _mic.rec.abort && _mic.rec.abort(); } catch (_) {}
    _mic.rec = null;
    _mic.active = false;
    _mic.baseText = '';
    _mic.finalText = '';
    _mic.roomId = null;
    if (MC.voiceListener && typeof MC.voiceListener.resume === 'function') {
      try { MC.voiceListener.resume(); } catch (_) {}
    }
  }

  function toggleMic(roomId, inputId, btnId) {
    inputId = inputId || 'arena-inject-input';
    btnId = btnId || 'arena-mic-btn';
    const btn = el(btnId);
    const input = el(inputId);
    if (!input) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      MC.toast && MC.toast('Browser unterstuetzt kein Web Speech API', 'error', 3000);
      return;
    }

    if (_mic.active) {
      try { _mic.rec && _mic.rec.stop(); } catch (_) {}
      return;
    }

    // Pause voice listener damit Web Speech API nicht doppelt greift
    if (MC.voiceListener && typeof MC.voiceListener.pause === 'function') {
      try { MC.voiceListener.pause(); } catch (_) {}
    }

    const rec = new SR();
    rec.lang = 'de-DE';
    rec.interimResults = true;
    rec.continuous = true;
    _mic.rec = rec;
    _mic.roomId = roomId;
    _mic.baseText = input.value ? input.value.trimEnd() + ' ' : '';
    _mic.finalText = '';
    _mic.resetPending = false;

    // Wenn Robin waehrend Mic-Aufnahme pastet/tippt: baseText mitziehen,
    // Recognition neu starten damit interim nichts ueberschreibt.
    const onUserInput = () => {
      if (!_mic.active) return;
      _mic.baseText = input.value ? input.value.trimEnd() + ' ' : '';
      _mic.finalText = '';
      _mic.resetPending = true;
      try { rec.stop(); } catch (_) {}
    };
    input.addEventListener('input', onUserInput);
    _mic.onUserInput = onUserInput;

    rec.addEventListener('result', (e) => {
      // Race-Guard: Sobald Robin tippt/pastet (onUserInput -> resetPending),
      // duerfen verspaetete Results der ALTEN Recognition den Input nicht
      // mehr ueberschreiben. Weiter geht's erst mit der neuen Recognition.
      if (_mic.resetPending) {
        if (_mic.liveEl) _mic.liveEl.style.display = 'none';
        return;
      }
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) _mic.finalText += t;
        else interim += t;
      }
      // Finaler Text landet im Input, interim-Text wird kursiv live angezeigt
      input.value = _mic.baseText + _mic.finalText;
      if (_mic.liveEl) {
        if (interim.trim()) {
          _mic.liveEl.textContent = interim;
          _mic.liveEl.style.display = 'block';
        } else {
          _mic.liveEl.style.display = 'none';
        }
      }
    });

    rec.addEventListener('end', () => {
      if (_mic.resetPending) {
        _mic.resetPending = false;
        try { rec.start(); return; } catch (_) {}
      }
      if (_mic.onUserInput) {
        try { input.removeEventListener('input', _mic.onUserInput); } catch (_) {}
        _mic.onUserInput = null;
      }
      if (_mic.liveEl) {
        try { _mic.liveEl.remove(); } catch (_) {}
        _mic.liveEl = null;
      }
      _mic.active = false;
      if (btn) {
        btn.style.background = 'rgba(99,102,241,0.12)';
        btn.style.borderColor = 'rgba(99,102,241,0.25)';
        btn.style.color = '#6366f1';
        btn.innerHTML = '&#127908;';
        btn.title = 'Mikrofon (Sprache statt Tippen)';
      }
      if (MC.voiceListener && typeof MC.voiceListener.resume === 'function') {
        try { MC.voiceListener.resume(); } catch (_) {}
      }
      input.focus();
    });

    rec.addEventListener('error', (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        MC.toast && MC.toast('Mic-Fehler: ' + e.error, 'error', 2500);
      }
      _mic.active = false;
      try { rec.stop(); } catch (_) {}
    });

    try {
      rec.start();
      _mic.active = true;
      // Live-Mitschrift Overlay (kursiv) oberhalb der Inject-Bar einblenden
      const injectBar = input.parentElement;
      if (injectBar && !_mic.liveEl) {
        const live = document.createElement('div');
        live.id = 'arena-mic-live';
        live.style.cssText = 'position:absolute;left:14px;right:14px;bottom:100%;margin-bottom:4px;padding:6px 10px;background:rgba(99,102,241,0.10);border:1px dashed rgba(99,102,241,0.35);border-radius:6px;color:#a5b4fc;font-size:12px;font-style:italic;line-height:1.4;pointer-events:none;display:none;z-index:5;';
        if (getComputedStyle(injectBar).position === 'static') {
          injectBar.style.position = 'relative';
        }
        injectBar.appendChild(live);
        _mic.liveEl = live;
      }
      if (btn) {
        btn.style.background = 'rgba(239,68,68,0.18)';
        btn.style.borderColor = 'rgba(239,68,68,0.45)';
        btn.style.color = '#ef4444';
        btn.innerHTML = '&#9632;';
        btn.title = 'Aufnahme stoppen';
      }
      MC.toast && MC.toast('Mic an — sprich jetzt', 'info', 1500);
    } catch (err) {
      MC.toast && MC.toast('Mic konnte nicht starten', 'error', 2500);
      _mic.active = false;
    }
  }

  // ── Freisprech-Meeting: Dauer-Dialog-Raum erstellen + Meeting-Mode direkt aktivieren ──
  async function startMeetingRoom() {
    const now = new Date();
    const dateStr = `${now.getDate().toString().padStart(2,'0')}.${(now.getMonth()+1).toString().padStart(2,'0')} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    const title = `Freisprech-Meeting ${dateStr}`;
    try {
      const res = await fetch('/api/arena/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          topic: 'Offenes Freisprech-Meeting — Dauer-Dialog-Modus',
          category: 'general',
          max_turns: 40,
          max_rounds: 12,
          bots: [
            { name: 'Alpha', model: 'sonnet', color: '#6366f1', persona: 'Du bist ein analytischer Zuhörer in einem Sprach-Meeting. Reagiere auf das Gesprochene, stelle klärende Fragen, fasse Kernpunkte prägnant zusammen. Halte deine Beiträge kurz (2-4 Sätze) da der User freispricht.' },
            { name: 'Beta', model: 'sonnet', color: '#22c55e', persona: 'Du bist ein kreativer Ideengeber in einem Sprach-Meeting. Bringe unerwartete Perspektiven ein, knüpfe an das Gesagte an, schlage neue Richtungen vor. Kurz und prägnant — max 3 Sätze pro Beitrag.' },
          ],
        })
      });
      if (!res.ok) throw new Error('Create failed');
      const room = await res.json();
      await loadRooms();
      _setActiveRoom(room.id);
      renderRoomView();
      // Mikro nach kurzem Delay aktivieren (DOM muss gerendert sein)
      setTimeout(() => toggleMeetingMode(room.id), 400);
      MC.toast && MC.toast('Freisprech-Meeting gestartet — sprich frei!', 'info', 2500);
    } catch (e) {
      MC.toast && MC.toast('Raum konnte nicht erstellt werden', 'error', 3000);
    }
  }

  // ── Inline-Diff fuer Results-Panel ────────────────────────────────────
  async function peekFileInline(path, divId) {
    const box = document.getElementById(divId);
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.textContent = 'Lade ' + path + '…';
    try {
      const r = await fetch('/api/arena/file-peek?path=' + encodeURIComponent(path));
      const d = await r.json();
      if (!d.ok) { box.textContent = 'Fehler: ' + (d.error || '?'); return; }
      let txt = '';
      if (d.diff) txt += '── Git-Diff (HEAD) ──\n' + d.diff + '\n\n── Aktueller Inhalt ──\n';
      txt += d.content || '(leer)';
      box.textContent = txt;
    } catch (_) { box.textContent = 'Netzwerkfehler'; }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.MC = window.MC || {};
  MC.arena = {
    init, destroy, openRoom, createRoom, deleteRoom,
    startRoom, stopRoom, inject, injectText, getActiveRoomId, execute, editRoom,
    handleWsEvent, loadRooms, requestSummary,
    toggleOrchestrator, chatOrchestrator, approveActions,
    approveFromPanel, continueDiscussion, toggleResults,
    toggleSammler, refreshSammler, approveSammlerActions,
    toggleMic, pickAndInject, peekFileInline, toggleTts,
    startMeetingRoom, toggleMeetingMode,
  };
})();
