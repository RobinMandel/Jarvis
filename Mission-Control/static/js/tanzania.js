// Mission Control V4 — Tanzania View
// Famulatur KCMC · Kilimanjaro Christian Medical Centre · August 2026

(function () {

  // ── Constants ─────────────────────────────────────────────────────────────
  const PACK_KEY  = 'mc-tanzania-packlist-v4';
  const TODO_KEY  = 'mc-tanzania-todos-v4';
  const TARGET    = new Date('2026-08-01T00:00:00');

  // ── Status-Card Definitionen ──────────────────────────────────────────────
  const STATUS_CARDS = [
    {
      id:    'flug',
      icon:  '&#9992;',
      title: 'Flug',
      sub:   'FRA &#8594; JRO &middot; noch buchen',
      status: 'ausstehend',
    },
    {
      id:    'visum',
      icon:  '&#128706;',
      title: 'Visum',
      sub:   'eTA Tanzania &middot; Antrag ausstehend',
      status: 'in-bearbeitung',
    },
    {
      id:    'impfungen',
      icon:  '&#128137;',
      title: 'Impfungen',
      sub:   'Gelbfieber &#10003; &middot; Malaria &middot; Typhus',
      status: 'in-bearbeitung',
    },
    {
      id:    'dokumente',
      icon:  '&#128196;',
      title: 'Dokumente',
      sub:   'Reisepass &middot; Krankenversicherung &middot; KCMC-Bestaetigung',
      status: 'ausstehend',
    },
    {
      id:    'unterkunft',
      icon:  '&#127968;',
      title: 'Unterkunft',
      sub:   'Guesthouse Moshi &middot; pruefen',
      status: 'ausstehend',
    },
  ];

  const STATUS_META = {
    'erledigt':      { badge: '&#10003;', cls: 'tanz-done',     color: '#22c55e' },
    'in-bearbeitung':{ badge: '&#8987;',  cls: 'tanz-inprogress',color: '#f59e0b' },
    'ausstehend':    { badge: '&#10005;', cls: 'tanz-missing',  color: '#ef4444' },
  };

  // ── Packliste Defaults ────────────────────────────────────────────────────
  const PACK_DEFAULTS = {
    'Dokumente': [
      'Reisepass',
      'Krankenversicherung',
      'Impfpass',
      'Visum / eTA',
      'KCMC Bestaetigung',
      'Notfallkontakte',
    ],
    'Medizin': [
      'Malariaprophylaxe',
      'Impfungen aktuell',
      'Verbandsmaterial',
      'Antibiotikum (Reise-Set)',
      'Sonnenschutz SPF 50+',
      'Insektenschutz DEET 30%+',
      'ORS-Beutel',
    ],
    'Kleidung': [
      'Leichte Hosen (2x)',
      'T-Shirts (5x)',
      'Langarmhemden (2x)',
      'Regen-/Windjacke',
      'Wanderschuhe',
      'Sandalen / Flip Flops',
      'Socken (7x)',
    ],
    'Equipment': [
      'Laptop + Ladekabel',
      'Stethoskop',
      'Stirnlampe / Taschenlampe',
      'Powerbank (20.000 mAh)',
      'Adapter Typ G/D',
      'USB-Hub',
    ],
    'Sonstiges': [
      'Reisewecker',
      'Schlafmaske + Ohrstoepsel',
      'Snacks fuer Flug',
      'Kopfhoerer',
      'Kamera + SD-Karte',
    ],
  };

  // ── Todo Defaults ─────────────────────────────────────────────────────────
  const TODO_DEFAULTS = {
    vor: [
      'Malariaprophylaxe verschreiben lassen',
      'Flug buchen (FRA → JRO)',
      'Unterkunft in Moshi buchen',
      'Reiseversicherung abschliessen',
      'Impfungen auffrischen (Typhus, Hep A)',
      'KCMC Kontakt bestaetigen',
      'Internationalen Fuehrerschein beantragen',
    ],
    in: [
      'Krankenhaus-Einweisung',
      'Stationsplan klären',
      'Lokale SIM-Karte kaufen',
      'Nächste Stadt erkunden',
    ],
    nach: [
      'Famulatur-Bescheinigung anfordern',
      'Bericht schreiben',
      'Fotos sichern',
    ],
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let activeTab   = 'vor';
  let countdownId = null;

  // ── localStorage helpers ──────────────────────────────────────────────────
  function loadPacklist() {
    try { return JSON.parse(localStorage.getItem(PACK_KEY)) || null; } catch { return null; }
  }

  function savePacklist(data) {
    localStorage.setItem(PACK_KEY, JSON.stringify(data));
  }

  function loadTodos() {
    try { return JSON.parse(localStorage.getItem(TODO_KEY)) || null; } catch { return null; }
  }

  function saveTodos(data) {
    localStorage.setItem(TODO_KEY, JSON.stringify(data));
  }

  function getPackState() {
    const stored = loadPacklist();
    if (stored) return stored;
    // Initialise from defaults: { category: [{ text, checked }] }
    const state = {};
    for (const [cat, items] of Object.entries(PACK_DEFAULTS)) {
      state[cat] = items.map(t => ({ text: t, checked: false }));
    }
    return state;
  }

  function getTodoState() {
    const stored = loadTodos();
    if (stored) return stored;
    const state = {};
    for (const [tab, items] of Object.entries(TODO_DEFAULTS)) {
      state[tab] = items.map(t => ({ text: t, done: false }));
    }
    return state;
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
  function startCountdown() {
    if (countdownId) clearInterval(countdownId);
    function tick() {
      const el = document.getElementById('tanz-countdown-num');
      if (!el) { clearInterval(countdownId); return; }
      const now  = new Date();
      const diff = TARGET - now;
      if (diff <= 0) {
        el.textContent = '0';
        document.getElementById('tanz-countdown-sub').textContent = 'Die Famulatur hat begonnen!';
        return;
      }
      const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const mins  = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      el.textContent = days;
      const subEl = document.getElementById('tanz-countdown-hm');
      if (subEl) subEl.textContent = `${hours}h ${mins}m`;
    }
    tick();
    countdownId = setInterval(tick, 60_000);
  }

  // ── Status Cards ──────────────────────────────────────────────────────────
  function renderStatusCards() {
    const grid = document.getElementById('tanz-status-grid');
    if (!grid) return;
    grid.innerHTML = STATUS_CARDS.map(card => {
      const meta = STATUS_META[card.status] || STATUS_META['ausstehend'];
      return `
        <div class="tanz-status-card ${meta.cls}">
          <div class="tanz-card-badge" style="color:${meta.color}">${meta.badge}</div>
          <div class="tanz-card-icon">${card.icon}</div>
          <div class="tanz-card-title">${card.title}</div>
          <div class="tanz-card-sub">${card.sub}</div>
          <div class="tanz-status-label" style="color:${meta.color}">${card.status}</div>
        </div>
      `;
    }).join('');
  }

  // ── Packliste ─────────────────────────────────────────────────────────────
  function renderPackliste() {
    const container = document.getElementById('tanz-packlist');
    if (!container) return;
    const state = getPackState();

    let totalItems = 0;
    let checkedItems = 0;

    let html = '';
    for (const [cat, items] of Object.entries(state)) {
      const done  = items.filter(i => i.checked).length;
      totalItems   += items.length;
      checkedItems += done;

      html += `
        <div class="tanz-pack-cat-header">
          <span class="tanz-pack-cat-label">${cat}</span>
          <span class="tanz-pack-cat-count">${done}/${items.length}</span>
        </div>
      `;
      items.forEach((item, idx) => {
        html += `
          <label class="tanz-check-label">
            <input type="checkbox" data-cat="${cat}" data-idx="${idx}" ${item.checked ? 'checked' : ''}>
            <span class="tanz-check-box">${item.checked ? '&#10003;' : ''}</span>
            <span class="tanz-check-text">${item.text}</span>
          </label>
        `;
      });
    }
    container.innerHTML = html;

    // Progress bar
    const pct = totalItems ? Math.round((checkedItems / totalItems) * 100) : 0;
    const bar  = document.getElementById('tanz-pack-progress-fill');
    const pctEl = document.getElementById('tanz-pack-pct');
    if (bar)   bar.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';

    // Events
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const s   = getPackState();
        const cat = cb.dataset.cat;
        const idx = parseInt(cb.dataset.idx);
        s[cat][idx].checked = cb.checked;
        savePacklist(s);
        renderPackliste();
      });
    });
  }

  // ── Todos ─────────────────────────────────────────────────────────────────
  function renderTodos() {
    const container = document.getElementById('tanz-todo-list');
    if (!container) return;
    const state = getTodoState();
    const items = state[activeTab] || [];

    if (!items.length) {
      container.innerHTML = '<div class="empty-state">Keine Todos. Eintrag hinzufügen.</div>';
      return;
    }

    container.innerHTML = items.map((item, idx) => `
      <div class="tanz-todo-item">
        <label class="tanz-check-label" style="flex:1">
          <input type="checkbox" data-tab="${activeTab}" data-idx="${idx}" ${item.done ? 'checked' : ''}>
          <span class="tanz-check-box">${item.done ? '&#10003;' : ''}</span>
          <span class="tanz-check-text">${item.text}</span>
        </label>
        <button class="tanz-todo-del btn-icon" data-tab="${activeTab}" data-idx="${idx}" title="Loeschen">&#10005;</button>
      </div>
    `).join('');

    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const s   = getTodoState();
        const tab = cb.dataset.tab;
        const idx = parseInt(cb.dataset.idx);
        s[tab][idx].done = cb.checked;
        saveTodos(s);
        renderTodos();
      });
    });

    container.querySelectorAll('.tanz-todo-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const s   = getTodoState();
        const tab = btn.dataset.tab;
        const idx = parseInt(btn.dataset.idx);
        s[tab].splice(idx, 1);
        saveTodos(s);
        renderTodos();
      });
    });
  }

  function addTodo() {
    const input = document.getElementById('tanz-todo-input');
    if (!input) return;
    const text  = input.value.trim();
    if (!text) return;
    const state = getTodoState();
    if (!state[activeTab]) state[activeTab] = [];
    state[activeTab].push({ text, done: false });
    saveTodos(state);
    input.value = '';
    renderTodos();
  }

  function switchTab(tab) {
    activeTab = tab;
    ['vor', 'in', 'nach'].forEach(t => {
      const btn = document.getElementById('tanz-tab-' + t);
      if (btn) btn.classList.toggle('active', t === tab);
    });
    renderTodos();
  }

  // ── Main Entry ────────────────────────────────────────────────────────────
  function loadTanzania() {
    // Build view HTML
    const view = document.getElementById('view-tanzania');
    if (!view || view.dataset.loaded) return;
    view.dataset.loaded = '1';

    view.innerHTML = `
      <style>
        /* ── Tanzania Styles (scoped) ── */
        @keyframes tanz-hero-shift {
          from { background-position: 0% 50%; }
          to   { background-position: 100% 50%; }
        }
        .tanz-hero {
          background: linear-gradient(135deg, rgba(20,184,166,0.14), rgba(20,184,166,0.04), rgba(255,92,92,0.07));
          background-size: 200%;
          animation: tanz-hero-shift 8s ease infinite alternate;
          border: 1px solid rgba(20,184,166,0.25);
          border-radius: 14px;
          padding: 40px 32px;
          text-align: center;
          margin-bottom: 20px;
          position: relative;
          overflow: hidden;
        }
        .tanz-hero::before {
          content: '';
          position: absolute;
          inset: 0;
          background: radial-gradient(ellipse at 60% 50%, rgba(20,184,166,0.08), transparent 70%);
          pointer-events: none;
        }
        #tanz-countdown-num {
          font-size: clamp(72px, 10vw, 120px);
          font-weight: 900;
          font-family: 'JetBrains Mono', monospace;
          color: var(--teal, #14b8a6);
          text-shadow: 0 0 40px rgba(20,184,166,0.5), 0 0 80px rgba(20,184,166,0.2);
          display: block;
          line-height: 1;
        }
        .tanz-hero-label {
          font-size: 20px;
          font-weight: 600;
          color: var(--text, #e2e8f0);
          margin-top: 10px;
        }
        .tanz-hero-sub {
          font-size: 13px;
          color: var(--text-muted, #64748b);
          margin-top: 6px;
          font-family: 'JetBrains Mono', monospace;
        }
        .tanz-hero-hm {
          font-size: 13px;
          color: var(--teal, #14b8a6);
          font-family: 'JetBrains Mono', monospace;
          margin-top: 4px;
          opacity: 0.8;
        }
        .tanz-status-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 12px;
          margin-bottom: 20px;
        }
        .tanz-status-card {
          background: var(--surface, #131720);
          border: 1px solid var(--border, #1e2535);
          border-radius: 12px;
          padding: 16px;
          position: relative;
          transition: transform 0.15s, box-shadow 0.15s;
          cursor: default;
        }
        .tanz-status-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        }
        .tanz-done     { border-color: rgba(34,197,94,0.35); }
        .tanz-inprogress { border-color: rgba(245,158,11,0.35); }
        .tanz-missing  { border-color: rgba(239,68,68,0.35); }
        .tanz-card-badge {
          position: absolute;
          top: 10px;
          right: 12px;
          font-size: 14px;
          line-height: 1;
          font-weight: 700;
        }
        .tanz-card-icon {
          font-size: 22px;
          display: block;
          margin-bottom: 8px;
        }
        .tanz-card-title {
          font-size: 13px;
          font-weight: 700;
          color: var(--text, #e2e8f0);
        }
        .tanz-card-sub {
          font-size: 11px;
          color: var(--text-muted, #64748b);
          margin-top: 3px;
          line-height: 1.4;
        }
        .tanz-status-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-top: 8px;
        }
        .tanz-main-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          align-items: start;
        }
        .tanz-pack-cat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin: 14px 0 6px;
          padding-bottom: 5px;
          border-bottom: 1px solid var(--border, #1e2535);
        }
        .tanz-pack-cat-label {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--teal, #14b8a6);
        }
        .tanz-pack-cat-count {
          font-size: 11px;
          color: var(--text-muted, #64748b);
          font-family: 'JetBrains Mono', monospace;
        }
        .tanz-check-label {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 12.5px;
          cursor: pointer;
          padding: 4px 2px;
          color: var(--text, #e2e8f0);
          transition: color 0.15s;
          border-radius: 6px;
        }
        .tanz-check-label:hover { background: var(--surface-hover, #1a2030); }
        .tanz-check-label input[type="checkbox"] { display: none; }
        .tanz-check-box {
          width: 16px; height: 16px;
          border: 1.5px solid var(--border, #1e2535);
          border-radius: 4px;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
          transition: background 0.15s, border-color 0.15s;
          font-size: 10px;
          color: transparent;
        }
        .tanz-check-label input[type="checkbox"]:checked ~ .tanz-check-box {
          background: var(--teal, #14b8a6);
          border-color: var(--teal, #14b8a6);
          color: #fff;
        }
        .tanz-check-label input[type="checkbox"]:checked ~ .tanz-check-text {
          text-decoration: line-through;
          color: var(--text-muted, #64748b);
        }
        .tanz-progress-bar {
          height: 5px;
          background: var(--border, #1e2535);
          border-radius: 99px;
          overflow: hidden;
          margin-bottom: 4px;
        }
        #tanz-pack-progress-fill {
          height: 100%;
          width: 0%;
          background: #22c55e;
          border-radius: 99px;
          transition: width 0.4s ease;
        }
        .tanz-tab-bar {
          display: flex;
          border-bottom: 1px solid var(--border, #1e2535);
          margin-bottom: 12px;
        }
        .tanz-tab-btn {
          flex: 1;
          padding: 9px 0;
          font-size: 12.5px;
          font-weight: 500;
          border: none;
          background: transparent;
          color: var(--text-muted, #64748b);
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: color 0.15s, border-color 0.15s;
          margin-bottom: -1px;
          font-family: 'Inter', sans-serif;
        }
        .tanz-tab-btn.active {
          color: var(--teal, #14b8a6);
          font-weight: 600;
          border-bottom: 2px solid var(--teal, #14b8a6);
        }
        .tanz-todo-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 4px;
          border-radius: 6px;
          transition: background 0.15s;
        }
        .tanz-todo-item:hover { background: var(--surface-hover, #1a2030); }
        .tanz-todo-del {
          display: none;
          background: none;
          border: none;
          color: #ef4444;
          cursor: pointer;
          font-size: 12px;
          padding: 2px 6px;
          margin-left: auto;
          line-height: 1;
          border-radius: 4px;
        }
        .tanz-todo-item:hover .tanz-todo-del { display: block; }
        .tanz-todo-input-row {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--border, #1e2535);
        }
        .tanz-todo-input {
          flex: 1;
          background: var(--surface, #131720);
          border: 1px solid var(--border, #1e2535);
          border-radius: 8px;
          padding: 8px 12px;
          color: var(--text, #e2e8f0);
          font-size: 13px;
          outline: none;
          transition: border-color 0.15s;
          font-family: 'Inter', sans-serif;
        }
        .tanz-todo-input:focus { border-color: var(--teal, #14b8a6); }
        .tanz-todo-input::placeholder { color: var(--text-muted, #64748b); }
        @media (max-width: 1100px) {
          .tanz-status-grid { grid-template-columns: repeat(3, 1fr); }
          .tanz-main-grid   { grid-template-columns: 1fr; }
        }
      </style>

      <!-- Hero: Countdown ───────────────────────────────────────── -->
      <div class="tanz-hero">
        <span id="tanz-countdown-num">&#8212;</span>
        <div class="tanz-hero-label">Tage bis Tanzania</div>
        <div class="tanz-hero-hm" id="tanz-countdown-hm"></div>
        <div class="tanz-hero-sub">Famulatur &middot; KCMC Moshi, Kilimanjaro &middot; August 2026</div>
      </div>

      <!-- Status Grid ───────────────────────────────────────────── -->
      <div class="tanz-status-grid" id="tanz-status-grid"></div>

      <!-- Main Grid: Packliste + Todos ─────────────────────────── -->
      <div class="tanz-main-grid">

        <!-- Packliste -->
        <div class="panel">
          <div class="panel-header">
            <h2>&#x1F9F3; Packliste</h2>
          </div>
          <div class="panel-body">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
              <div class="tanz-progress-bar" style="flex:1">
                <div id="tanz-pack-progress-fill"></div>
              </div>
              <span id="tanz-pack-pct" style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-muted,#64748b);min-width:32px;text-align:right">0%</span>
            </div>
            <div id="tanz-packlist"></div>
          </div>
        </div>

        <!-- Todos -->
        <div class="panel">
          <div class="panel-header">
            <h2>&#10003; Todo-Liste</h2>
          </div>
          <div class="panel-body">
            <div class="tanz-tab-bar">
              <button id="tanz-tab-vor"  class="tanz-tab-btn active" data-tab="vor">Vor Abreise</button>
              <button id="tanz-tab-in"   class="tanz-tab-btn"        data-tab="in">In Tanzania</button>
              <button id="tanz-tab-nach" class="tanz-tab-btn"        data-tab="nach">Nach Rueckkehr</button>
            </div>
            <div id="tanz-todo-list" style="min-height:80px"></div>
            <div class="tanz-todo-input-row">
              <input id="tanz-todo-input" class="tanz-todo-input" placeholder="Neuer Todo&#8230;">
              <button id="tanz-todo-add" class="btn-primary">+</button>
            </div>
          </div>
        </div>

      </div>
    `;

    // Wire up tab buttons
    document.querySelectorAll('.tanz-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Wire up todo add button + Enter key
    document.getElementById('tanz-todo-add')?.addEventListener('click', addTodo);
    document.getElementById('tanz-todo-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addTodo();
    });

    // Render
    startCountdown();
    renderStatusCards();
    renderPackliste();
    renderTodos();
  }

  // Expose globally for app.js viewLoaders
  window.loadTanzania = loadTanzania;

})();
