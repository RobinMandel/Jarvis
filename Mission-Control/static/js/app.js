// Mission Control V4 — Main App
(function () {
  // ── Title map ────────────────────────────────────────────────────────────
  const TITLES = {
    home:       'Home',
    world:      'World Monitor',
    chat:       'Chat',
    multichat:  'Multi-Chat',
    diss:       'Dissertation',
    medizin:    'Medizinstudium',
    trading:    'Trading',
    tanzania:   'Tanzania',
    email:      'Email',
    calendar:   'Kalender',
    memory:     'Brain',
    funnel:     'Knowledge Funnel',
    tasks:      'Tasks',
    system:     'System',
    bots:       'Bots & Crons',
    graph:         'Knowledge Graph',
    'smart-tasks': 'Build Queue',
    skills:        'Skills Lab',
    arena:         'Bot Arena',
  };

  // ── Lazy-load registry ───────────────────────────────────────────────────
  const viewLoaders = new Map([
    ['home',     loadHome],
    ['world',    loadWorldMonitor],
    ['email',    loadEmails],
    ['calendar', loadCalendar],
    ['system',   loadSystem],
    ['diss',     loadDiss],
    ['medizin',  function() { if (window.MedizinView) window.MedizinView.init(); }],
    ['trading',  loadTrading],
    ['tanzania', loadTanzania],
    ['memory',      function() { loadKnowledgeGraph(); }],
    ['funnel',      function() { if (window.FunnelView) window.FunnelView.init(); }],
    ['smart-tasks', loadSmartTasks],
    ['bots',        function() { if (window.initBotsView) window.initBotsView(); }],
    ['skills',      function() { if (window.loadSkills) window.loadSkills(); }],
    ['arena',       function() { if (MC.arena) MC.arena.init(); }],
  ]);
  const loadedViews = new Set();

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const navItems    = document.querySelectorAll('.nav-item[data-view]');
  const views       = document.querySelectorAll('.view');
  const topbarTitle = document.getElementById('topbarTitle');
  const clockEl     = document.getElementById('sidebar-clock');
  const badgeEl     = document.getElementById('gatewayBadge');

  // ── Navigation ───────────────────────────────────────────────────────────
  let _currentView = null;
  function switchView(target) {
    // Teardown previous view if needed
    if (_currentView === 'bots' && target !== 'bots' && window.destroyBotsView) window.destroyBotsView();
    if (_currentView === 'arena' && target !== 'arena' && MC.arena && MC.arena.destroy) MC.arena.destroy();
    _currentView = target;

    navItems.forEach(n => n.classList.toggle('active', n.dataset.view === target));
    views.forEach(v => v.classList.toggle('active', v.id === 'view-' + target));

    // Sync Bottom Nav
    document.querySelectorAll('.bn-item[data-view]').forEach(b =>
      b.classList.toggle('active', b.dataset.view === target));
    document.querySelectorAll('.md-item[data-view]').forEach(b =>
      b.classList.toggle('active', b.dataset.view === target));

    // Chat + Multi-Chat need full-height layout without outer scroll/padding
    const mc = document.getElementById('main-content');
    if (mc) mc.classList.toggle('chat-active', target === 'chat' || target === 'multichat' || target === 'arena');

    if (topbarTitle) topbarTitle.textContent = TITLES[target] || target;

    if (viewLoaders.has(target) && !loadedViews.has(target)) {
      loadedViews.add(target);
      viewLoaders.get(target)();
    }
    // Multi-Chat: auto-init 2 panels on first open
    if (target === 'multichat' && !loadedViews.has('multichat-panels')) {
      loadedViews.add('multichat-panels');
      if (MC.multiChat) {
        setTimeout(() => { MC.multiChat.addPanel(); MC.multiChat.addPanel(); }, 200);
      }
    }

    // Persist active view for reload
    try { localStorage.setItem('mc_active_view', target); } catch (_) {}

    // Clear pending badge for this view
    _activityClear(target);
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });

  // ── Bottom Nav ────────────────────────────────────────────────────────────
  document.querySelectorAll('.bn-item[data-view]').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });

  // More Drawer
  const moreBtn     = document.getElementById('bn-more-btn');
  const moreDrawer  = document.getElementById('more-drawer');
  const moreBackdrop = document.getElementById('more-drawer-backdrop');

  function openMoreDrawer()  { if (moreDrawer) moreDrawer.classList.add('open'); }
  function closeMoreDrawer() { if (moreDrawer) moreDrawer.classList.remove('open'); }

  if (moreBtn)     moreBtn.addEventListener('click', openMoreDrawer);
  if (moreBackdrop) moreBackdrop.addEventListener('click', closeMoreDrawer);

  document.querySelectorAll('.md-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      switchView(item.dataset.view);
      closeMoreDrawer();
    });
  });

  // Expose switchView globally
  window.MC = window.MC || {};
  MC.switchView = switchView;
  MC.getCurrentView = () => _currentView;

  // ── Theme Toggle ──────────────────────────────────────────────────────
  const themeBtn = document.getElementById('btn-theme-toggle');
  const sunIcon  = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');
  function applyThemeIcons() {
    const isLight = document.documentElement.classList.contains('light');
    if (sunIcon)  sunIcon.style.display  = isLight ? 'none' : 'block';
    if (moonIcon) moonIcon.style.display = isLight ? 'block' : 'none';
  }
  applyThemeIcons();
  if (themeBtn) {
    themeBtn.addEventListener('click', function() {
      document.documentElement.classList.add('theme-transition');
      document.documentElement.classList.toggle('light');
      var isLight = document.documentElement.classList.contains('light');
      localStorage.setItem('mc_theme', isLight ? 'light' : 'dark');
      applyThemeIcons();
      setTimeout(function(){ document.documentElement.classList.remove('theme-transition'); }, 300);
    });
  }

  // ── Brain Tabs (Memory + Graph) ─────────────────────────────────────────
  document.querySelectorAll('.brain-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.brain-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.brain-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.brainTab;
      const panel = document.getElementById('brain-' + target + '-panel');
      if (panel) panel.classList.add('active');
      // Resize canvas when switching to graph
      if (target === 'graph') {
        const c = document.getElementById('graph-canvas');
        if (c) { c.width = c.offsetWidth; c.height = c.offsetHeight; }
      }
    });
  });

  // ── Font Picker ────────────────────────────────────────────────────────
  const fontPicker = document.getElementById('font-picker');
  if (fontPicker) {
    const savedFont = localStorage.getItem('mc_font');
    if (savedFont) {
      document.documentElement.style.setProperty('--font-main', savedFont);
      fontPicker.value = savedFont;
    }
    fontPicker.addEventListener('change', function() {
      document.documentElement.style.setProperty('--font-main', this.value);
      localStorage.setItem('mc_font', this.value);
    });
  }

  // ── Boot: restore last view or default to home ─────────────────────────
  const savedView = localStorage.getItem('mc_active_view') || 'home';
  switchView(savedView);

  // ── Init modules ─────────────────────────────────────────────────────────
  MC.ws.connect();
  MC.chat.init();
  if (MC.multiChat) MC.multiChat.init();
  MC.tasks.load();
  MC.memory.load();

  // Nach Server-Reconnect Tasks automatisch neu laden (aktueller Stand nach Restart)
  if (MC.ws && MC.ws.on) {
    MC.ws.on('_ws_reconnect', () => {
      MC.tasks.load();
      if (MC.memory && MC.memory.load) MC.memory.load();
    });
  }

  // Tab wieder sichtbar → Tasks refreshen (Stand stimmt nach Idle / Restart)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      MC.tasks.load();
    }
  });
  if (MC.voiceListener) MC.voiceListener.init();

  // ── Periodic home refresh (60 s) ─────────────────────────────────────────
  setInterval(() => {
    if (document.getElementById('view-home')?.classList.contains('active')) {
      loadHome();
    }
  }, 60_000);

  // ── Live Clock ───────────────────────────────────────────────────────────
  if (clockEl) {
    clockEl.style.fontFamily = "var(--font-mono)";
    function tickClock() {
      const now  = new Date();
      const pad  = n => String(n).padStart(2, '0');
      clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    tickClock();
    setInterval(tickClock, 1000);
  }

  // ── Gateway Badge (driven by WebSocket events) ───────────────────────────
  function updateGatewayBadge(state) {
    if (!badgeEl) return;
    const statusText = document.getElementById('statusText');
    const map = {
      connected:    { text: 'Live',       cls: 'badge-ok'      },
      connecting:   { text: 'Connecting', cls: 'badge-warn'    },
      disconnected: { text: 'Offline',    cls: 'badge-error'   },
    };
    const { text, cls } = map[state] || map.disconnected;
    if (statusText) statusText.textContent = text;
    badgeEl.className = `gateway-badge ${cls}`;
  }

  // Expose so MC.ws can call it on status changes
  window.MC = window.MC || {};
  MC.updateGatewayBadge = updateGatewayBadge;

  // Initial state while WS is connecting
  updateGatewayBadge('connecting');

  // ── Activity Indicators ──────────────────────────────────────────────────
  // Views with badge elements (chat also maps to multichat)
  const ACTIVITY_VIEWS = ['chat', 'multichat', 'funnel', 'arena', 'transcriber', 'smart-tasks'];

  function _activityRender(view, state) {
    const badge = document.getElementById('nav-badge-' + view);
    if (!badge) return;
    const active  = state && state.active;
    const pending = state ? (state.pending || 0) : 0;
    if (active) {
      badge.className = 'nav-badge is-active';
      badge.textContent = '';
    } else if (pending > 0) {
      badge.className = 'nav-badge has-pending';
      badge.textContent = pending > 9 ? '9+' : String(pending);
    } else {
      badge.className = 'nav-badge';
      badge.textContent = '';
    }
  }

  // chat activity also shows on multichat badge
  function _activityRenderAll(view, state) {
    _activityRender(view, state);
    if (view === 'chat') _activityRender('multichat', state);
  }

  function _activityClear(view) {
    fetch('/api/activity/clear/' + view, { method: 'POST' }).catch(() => {});
    // Also clear multichat if navigating to chat
    if (view === 'multichat') fetch('/api/activity/clear/chat', { method: 'POST' }).catch(() => {});
    const badge = document.getElementById('nav-badge-' + view);
    if (badge) { badge.className = 'nav-badge'; badge.textContent = ''; }
  }

  // Load initial state
  fetch('/api/activity').then(r => r.json()).then(data => {
    for (const [view, state] of Object.entries(data)) {
      _activityRenderAll(view, state);
    }
  }).catch(() => {});

  // Handle WS activity updates
  if (MC.ws) {
    MC.ws.on('activity.update', function(d) {
      if (d.view && d.state) {
        // Don't show badge for the view the user is currently on
        const isCurrent = (_currentView === d.view) ||
          (_currentView === 'chat' && d.view === 'multichat') ||
          (_currentView === 'multichat' && d.view === 'chat');
        if (isCurrent && !d.state.active) {
          _activityClear(d.view);
        } else {
          _activityRenderAll(d.view, d.state);
        }
      }
    });
  }

})();
