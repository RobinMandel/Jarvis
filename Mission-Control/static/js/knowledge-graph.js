// Mission Control V7 — Knowledge Graph (Obsidian-Style)
// Domain-clustered, colored by topic, right-side controls

(function () {
  // ── Domain Colors (hover/connected show domain color, rest = gray) ──────
  const DOMAINS = {
    osce:    { color: '#f472b6', glow: 'rgba(244,114,182,0.5)', label: 'OSCE' },
    diss:    { color: '#fbbf24', glow: 'rgba(251,191,36,0.5)',  label: 'Dissertation' },
    trading: { color: '#34d399', glow: 'rgba(52,211,153,0.5)',  label: 'Trading' },
    jarvis:  { color: '#60a5fa', glow: 'rgba(96,165,250,0.5)',  label: 'Jarvis/Tech' },
    daily:   { color: '#a78bfa', glow: 'rgba(167,139,250,0.5)', label: 'Daily Notes' },
    medical: { color: '#f87171', glow: 'rgba(248,113,113,0.5)', label: 'Medizin' },
    meta:    { color: '#c084fc', glow: 'rgba(192,132,252,0.5)', label: 'Meta/System' },
    other:   { color: '#94a3b8', glow: 'rgba(148,163,184,0.4)', label: 'Sonstige' },
  };

  const NODE_REST  = 'rgba(180,180,195,0.6)';
  const NODE_FADED = 'rgba(50,50,60,0.2)';
  const LINE_REST  = 'rgba(130,130,150,0.15)';
  const LINE_HOVER = 'rgba(167,139,250,0.6)';
  const LINE_CONN  = 'rgba(167,139,250,0.25)';
  const LINE_FADED = 'rgba(50,50,60,0.03)';

  // ── Physics ─────────────────────────────────────────────────────────────
  let physics = {
    gravity:   0.012,
    repulsion: 600,
    springK:   0.01,
    springLen: 45,
    nodeScale: 1.0,
    lineScale: 1.0,
    clusterForce: 0.003,  // pull same-domain nodes together
  };
  const TICK_LIMIT = 3000;
  const MIN_R = 2;
  const MAX_R = 11;

  // ── State ───────────────────────────────────────────────────────────────
  let canvas, ctx, nodes, links, adjacency;
  let width, height;
  let tick = 0, animId = null;
  let hoveredNode = null;
  let isDragging = false, dragNode = null;
  let zoom = 1.0, panX = 0, panY = 0;
  let isPanning = false, panStartX, panStartY;
  let domainCenters = {};

  // ── Classify node into domain ───────────────────────────────────────────
  function classifyNode(id) {
    const lo = (id || '').toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}/.test(lo)) return 'daily';
    if (/osce|anki|chirurgie|innere|paed|gyn|anaesth|uro|psych|radio|hno|auge|ortho|blockheft/.test(lo)) return 'osce';
    if (/diss|iti|neutrophil|aki|cardiac|kdigo|biomarker|paper|recherche|prism|elisa|zotero/.test(lo)) return 'diss';
    if (/trading|alpaca|portfolio|bot|market|crypto|equity/.test(lo)) return 'trading';
    if (/jarvis|mission|claude|openclaw|telegram|discord|agent|skill|cron|hook|bridge|gateway/.test(lo)) return 'jarvis';
    if (/soul|identity|robin|memory|readme|projects|todos|decisions|context|routing|pattern/.test(lo)) return 'meta';
    if (/medizin|famulatur|tansania|kcmc|klinik|station|diagnos|therap/.test(lo)) return 'medical';
    return 'other';
  }

  // ── Public entry ────────────────────────────────────────────────────────
  window.loadKnowledgeGraph = async function () {
    canvas = document.getElementById('graph-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    resize();
    window.addEventListener('resize', resize);

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', () => { hoveredNode = null; });
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    initControls();

    try {
      const resp = await fetch('/api/knowledge-graph');
      const data = await resp.json();
      initGraph(data.nodes || [], data.links || []);
      updateStats(data.nodes?.length || 0, data.links?.length || 0);
    } catch (e) {
      console.error('[KnowledgeGraph] fetch error:', e);
      drawError('Fehler beim Laden des Graphen.');
    }
  };

  function updateStats(nc, lc) {
    const el = document.getElementById('graph-stats');
    if (el) el.textContent = nc + ' nodes \u00b7 ' + lc + ' links';
  }

  function resize() {
    if (!canvas) return;
    width = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 800;
    height = canvas.offsetHeight || canvas.parentElement?.offsetHeight || 600;
    canvas.width = width;
    canvas.height = height;
    if (nodes) draw();
  }

  // ── Init with domain-aware placement ────────────────────────────────────
  function initGraph(rawNodes, rawLinks) {
    const deg = {};
    rawLinks.forEach(l => {
      deg[l.source] = (deg[l.source] || 0) + 1;
      deg[l.target] = (deg[l.target] || 0) + 1;
    });

    const cx = width / 2, cy = height / 2;

    // Assign domain cluster positions around center
    const domainList = ['osce', 'diss', 'trading', 'jarvis', 'daily', 'medical', 'meta', 'other'];
    const clusterDist = Math.min(width, height) * 0.22;
    domainCenters = {};
    domainList.forEach((d, i) => {
      const angle = (i / domainList.length) * Math.PI * 2 - Math.PI / 2;
      domainCenters[d] = {
        x: cx + Math.cos(angle) * clusterDist,
        y: cy + Math.sin(angle) * clusterDist,
      };
    });

    // Place nodes near their domain center with jitter
    nodes = rawNodes.map((n) => {
      const d = deg[n.id] || 0;
      const domain = classifyNode(n.id);
      const dc = domainCenters[domain] || { x: cx, y: cy };
      const jitter = 60 + Math.random() * 80;
      const jAngle = Math.random() * Math.PI * 2;
      const phantom = (n.size === 0);  // wikilink target that doesn't exist as file
      return {
        id: n.id,
        domain: domain,
        r: phantom ? MIN_R * 0.7 : MIN_R + Math.min(Math.sqrt(d + 1) * 1.3, MAX_R - MIN_R),
        x: dc.x + Math.cos(jAngle) * jitter,
        y: dc.y + Math.sin(jAngle) * jitter,
        vx: 0, vy: 0,
        degree: d,
        pinned: false,
        phantom: phantom,
      };
    });

    const idxMap = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
    const linkSet = new Set();
    links = rawLinks
      .map(l => ({ s: idxMap[l.source], t: idxMap[l.target] }))
      .filter(l => {
        if (l.s === undefined || l.t === undefined || l.s === l.t) return false;
        const key = Math.min(l.s, l.t) + ':' + Math.max(l.s, l.t);
        if (linkSet.has(key)) return false;
        linkSet.add(key);
        return true;
      });

    adjacency = new Array(nodes.length).fill(null).map(() => []);
    links.forEach(l => {
      adjacency[l.s].push(l.t);
      adjacency[l.t].push(l.s);
    });

    panX = 0; panY = 0; zoom = 1.0;
    tick = 0;
    cancelAnimationFrame(animId);
    loop();
  }

  // ── Simulation ──────────────────────────────────────────────────────────
  function loop() {
    if (tick < TICK_LIMIT) { simulate(); tick++; }
    draw();
    animId = requestAnimationFrame(loop);
  }

  function simulate() {
    const cx = width / 2, cy = height / 2;
    const n = nodes.length;

    // Gravity toward center
    for (let i = 0; i < n; i++) {
      if (nodes[i].pinned) { nodes[i].vx = 0; nodes[i].vy = 0; continue; }
      nodes[i].vx += (cx - nodes[i].x) * physics.gravity;
      nodes[i].vy += (cy - nodes[i].y) * physics.gravity;
    }

    // Cluster force — pull toward domain center
    if (physics.clusterForce > 0) {
      for (let i = 0; i < n; i++) {
        if (nodes[i].pinned) continue;
        const dc = domainCenters[nodes[i].domain];
        if (!dc) continue;
        nodes[i].vx += (dc.x - nodes[i].x) * physics.clusterForce;
        nodes[i].vy += (dc.y - nodes[i].y) * physics.clusterForce;
      }
    }

    // Repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const d2 = dx * dx + dy * dy || 1;
        if (d2 > 200000) continue;
        const d = Math.sqrt(d2);
        // Same domain = less repulsion (tighter clusters)
        const sameDomain = nodes[i].domain === nodes[j].domain ? 0.6 : 1.0;
        const f = (physics.repulsion * sameDomain) / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        if (!nodes[i].pinned) { nodes[i].vx -= fx; nodes[i].vy -= fy; }
        if (!nodes[j].pinned) { nodes[j].vx += fx; nodes[j].vy += fy; }
      }
    }

    // Springs
    links.forEach(({ s, t }) => {
      const dx = nodes[t].x - nodes[s].x;
      const dy = nodes[t].y - nodes[s].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - physics.springLen) * physics.springK;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!nodes[s].pinned) { nodes[s].vx += fx; nodes[s].vy += fy; }
      if (!nodes[t].pinned) { nodes[t].vx -= fx; nodes[t].vy -= fy; }
    });

    // Integrate
    for (let i = 0; i < n; i++) {
      if (nodes[i].pinned) continue;
      nodes[i].vx *= 0.88;
      nodes[i].vy *= 0.88;
      const maxV = 7;
      nodes[i].vx = Math.max(-maxV, Math.min(maxV, nodes[i].vx));
      nodes[i].vy = Math.max(-maxV, Math.min(maxV, nodes[i].vy));
      nodes[i].x += nodes[i].vx;
      nodes[i].y += nodes[i].vy;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(panX + width / 2, panY + height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-width / 2, -height / 2);

    const connected = new Set();
    if (hoveredNode !== null && adjacency) {
      adjacency[hoveredNode].forEach(j => connected.add(j));
    }
    const hasHover = hoveredNode !== null;

    // ── Lines ──
    links.forEach(({ s, t }) => {
      const isHovLink = hasHover && (s === hoveredNode || t === hoveredNode);
      const isConLink = hasHover && !isHovLink && (connected.has(s) || connected.has(t));
      const isFadedLink = hasHover && !isHovLink && !isConLink;

      if (isHovLink) {
        ctx.strokeStyle = LINE_HOVER;
        ctx.lineWidth = 1.8 * physics.lineScale;
      } else if (isConLink) {
        ctx.strokeStyle = LINE_CONN;
        ctx.lineWidth = 0.8 * physics.lineScale;
      } else if (isFadedLink) {
        ctx.strokeStyle = LINE_FADED;
        ctx.lineWidth = 0.3 * physics.lineScale;
      } else {
        ctx.strokeStyle = LINE_REST;
        ctx.lineWidth = 0.5 * physics.lineScale;
      }

      ctx.beginPath();
      ctx.moveTo(nodes[s].x, nodes[s].y);
      ctx.lineTo(nodes[t].x, nodes[t].y);
      ctx.stroke();
    });

    // ── Nodes ──
    nodes.forEach((n, i) => {
      const isHov = hoveredNode === i;
      const isCon = connected.has(i);
      const isFaded = hasHover && !isHov && !isCon;
      const r = n.r * physics.nodeScale * (isHov ? 1.5 : 1.0);
      const dom = DOMAINS[n.domain] || DOMAINS.other;

      if (isHov || isCon) {
        ctx.shadowColor = dom.glow;
        ctx.shadowBlur = isHov ? 18 : 8;
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);

      if (isHov) {
        ctx.fillStyle = dom.color;
      } else if (isCon) {
        ctx.fillStyle = dom.color;
        ctx.globalAlpha = 0.7;
      } else if (isFaded) {
        ctx.fillStyle = NODE_FADED;
      } else if (n.phantom) {
        ctx.fillStyle = 'rgba(120,120,140,0.3)';
      } else {
        ctx.fillStyle = NODE_REST;
      }

      ctx.fill();
      ctx.globalAlpha = 1.0;
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    });

    // ── Labels (ONLY hovered node + its name) ──
    if (hasHover) {
      const hn = nodes[hoveredNode];
      const hr = hn.r * physics.nodeScale * 1.5;
      const dom = DOMAINS[hn.domain] || DOMAINS.other;

      // Connected node names (small, subtle)
      connected.forEach(i => {
        const n = nodes[i];
        const r = n.r * physics.nodeScale;
        const d = DOMAINS[n.domain] || DOMAINS.other;
        ctx.fillStyle = d.color + 'AA';
        ctx.font = '9px Inter,system-ui,sans-serif';
        ctx.textAlign = 'center';
        const label = n.id.length > 24 ? n.id.slice(0, 21) + '\u2026' : n.id;
        ctx.fillText(label, n.x, n.y - r - 4);
      });

      // Hovered node label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px Inter,system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(hn.id, hn.x, hn.y - hr - 10);

      // Domain + connections subtitle
      const cnt = adjacency[hoveredNode]?.length || 0;
      ctx.fillStyle = dom.color;
      ctx.font = '9px Inter,system-ui,sans-serif';
      ctx.fillText(dom.label + ' \u00b7 ' + cnt + ' links', hn.x, hn.y - hr - 10 + 14);
      ctx.fillStyle = 'rgba(120,120,140,0.5)';
      ctx.fillText('Klick \u2192 Datei anzeigen', hn.x, hn.y - hr - 10 + 26);
    }

    ctx.restore();
  }

  function drawError(msg) {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(239,68,68,0.8)';
    ctx.font = '14px Inter,system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, width / 2, height / 2);
  }

  // ── Hit-test ────────────────────────────────────────────────────────────
  function screenToWorld(sx, sy) {
    return {
      x: (sx - panX - width / 2) / zoom + width / 2,
      y: (sy - panY - height / 2) / zoom + height / 2,
    };
  }

  function nodeAt(sx, sy) {
    const { x, y } = screenToWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy <= (n.r * physics.nodeScale + 5) ** 2) return i;
    }
    return null;
  }

  function canvasXY(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Mouse ───────────────────────────────────────────────────────────────
  function onMouseMove(e) {
    if (!nodes) return;
    const { x, y } = canvasXY(e);
    if (isPanning) {
      panX += x - panStartX; panY += y - panStartY;
      panStartX = x; panStartY = y;
      return;
    }
    if (isDragging && dragNode !== null) {
      const w = screenToWorld(x, y);
      nodes[dragNode].x = w.x; nodes[dragNode].y = w.y;
      nodes[dragNode].vx = 0; nodes[dragNode].vy = 0;
      tick = Math.min(tick, TICK_LIMIT - 300);
      return;
    }
    hoveredNode = nodeAt(x, y);
    canvas.style.cursor = hoveredNode !== null ? 'pointer' : 'grab';
  }

  function onMouseDown(e) {
    if (!nodes) return;
    const { x, y } = canvasXY(e);
    const hit = nodeAt(x, y);
    if (hit !== null) {
      isDragging = true; dragNode = hit; nodes[hit].pinned = true;
    } else {
      isPanning = true; panStartX = x; panStartY = y;
      canvas.style.cursor = 'grabbing';
    }
  }

  function onMouseUp() {
    if (dragNode !== null) {
      nodes[dragNode].pinned = false;
      nodes[dragNode].vx = 0.1; nodes[dragNode].vy = 0.1;
    }
    isDragging = false; dragNode = null; isPanning = false;
    if (canvas) canvas.style.cursor = hoveredNode !== null ? 'pointer' : 'grab';
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.92 : 1.08;
    const newZoom = Math.max(0.15, Math.min(6.0, zoom * delta));
    const { x, y } = canvasXY(e);
    panX = x - (x - panX) * (newZoom / zoom);
    panY = y - (y - panY) * (newZoom / zoom);
    zoom = newZoom;
    const el = document.getElementById('graph-zoom-level');
    if (el) el.textContent = Math.round(zoom * 100) + '%';
  }

  function onClick(e) {
    if (!nodes) return;
    const { x, y } = canvasXY(e);
    const hit = nodeAt(x, y);
    if (hit === null) return;
    const node = nodes[hit];

    // Open in MC Brain Files tab
    if (MC.memory && MC.memory.open) {
      MC.memory.open(node.id + '.md');
    }
  }

  // ── Controls ────────────────────────────────────────────────────────────
  function initControls() {
    const sliders = {
      'graph-node-size':   { key: 'nodeScale',     min: 0.3, max: 3.0, step: 0.05 },
      'graph-line-width':  { key: 'lineScale',     min: 0.2, max: 3.0, step: 0.05 },
      'graph-gravity':     { key: 'gravity',       min: 0,   max: 0.06, step: 0.001 },
      'graph-repulsion':   { key: 'repulsion',     min: 100, max: 2000, step: 10 },
      'graph-spring-k':    { key: 'springK',       min: 0.001, max: 0.03, step: 0.001 },
      'graph-spring-len':  { key: 'springLen',     min: 10,  max: 200, step: 1 },
    };

    Object.entries(sliders).forEach(([id, cfg]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.min = cfg.min; el.max = cfg.max; el.step = cfg.step;
      el.value = physics[cfg.key];
      el.addEventListener('input', () => {
        physics[cfg.key] = parseFloat(el.value);
        tick = 0;
      });
    });

    const resetBtn = document.getElementById('graph-reset-zoom');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        zoom = 1.0; panX = 0; panY = 0;
        const el = document.getElementById('graph-zoom-level');
        if (el) el.textContent = '100%';
      });
    }

    const animBtn = document.getElementById('graph-animate');
    if (animBtn) {
      animBtn.addEventListener('click', () => { tick = 0; });
    }
  }
})();
