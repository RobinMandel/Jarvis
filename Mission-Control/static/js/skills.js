/* ── Skills Lab V2 ──────────────────────────────────────────────────── */
(function () {
  let allSkills = [];
  let loaded = false;
  let highlightSlugs = new Set();
  let usageData = {};
  let activeFilter = 'all';
  let sortMode = 'name'; // name, usage, category

  const CATEGORIES = {
    medical: { label: 'Medizin', color: '#ef4444', icon: '🏥' },
    anki: { label: 'Anki', color: '#f97316', icon: '🃏' },
    research: { label: 'Research', color: '#8b5cf6', icon: '🔬' },
    trading: { label: 'Trading', color: '#22c55e', icon: '📈' },
    design: { label: 'Design', color: '#ec4899', icon: '🎨' },
    code: { label: 'Dev', color: '#3b82f6', icon: '💻' },
    writing: { label: 'Writing', color: '#a78bfa', icon: '✍️' },
    data: { label: 'Data', color: '#06b6d4', icon: '📊' },
    general: { label: 'General', color: '#64748b', icon: '⚙️' },
  };

  function getCategory(slug, name, desc) {
    const text = (slug + ' ' + name + ' ' + desc).toLowerCase();
    if (/anki|flashcard/.test(text)) return 'anki';
    if (/medic|pubmed|clinical|zotero|health|osce/.test(text)) return 'medical';
    if (/research|paper|science|academic/.test(text)) return 'research';
    if (/trading|stock|market|alpaca|finance/.test(text)) return 'trading';
    if (/design|ui|ux|css|frontend|figma|canvas/.test(text)) return 'design';
    if (/code|debug|test|dev|git|typescript|python|refactor/.test(text)) return 'code';
    if (/write|writing|doc|essay|article/.test(text)) return 'writing';
    if (/data|csv|excel|xlsx|analytics/.test(text)) return 'data';
    return 'general';
  }

  function getCat(slug, name, desc) {
    return CATEGORIES[getCategory(slug, name, desc)];
  }

  function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Filter + Sort Bar ───────────────────────────────────────────────────

  function renderFilterBar() {
    const container = document.getElementById('skills-filter-bar');
    if (!container) return;

    // Count per category
    const counts = { all: allSkills.length };
    allSkills.forEach(s => {
      const cat = getCategory(s.slug, s.name, s.description);
      counts[cat] = (counts[cat] || 0) + 1;
    });

    const filters = [
      { key: 'all', label: 'Alle', color: '#94a3b8' },
      ...Object.entries(CATEGORIES).filter(([k]) => counts[k] > 0).map(([k, v]) => ({ key: k, label: v.label, color: v.color })),
    ];

    container.innerHTML = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        ${filters.map(f => {
          const isActive = activeFilter === f.key;
          return `<button data-filter="${f.key}" style="font-size:11px;padding:3px 10px;border-radius:16px;border:1px solid ${isActive ? f.color + '50' : 'var(--border-light)'};background:${isActive ? f.color + '18' : 'transparent'};color:${isActive ? f.color : 'var(--text-muted)'};cursor:pointer;transition:all .2s;font-weight:${isActive ? '600' : '400'};">${f.label} <span style="font-size:10px;opacity:0.7;">${counts[f.key] || 0}</span></button>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <select id="skills-sort" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--border-light);background:var(--bg-input);color:var(--text-secondary);cursor:pointer;outline:none;">
          <option value="name" ${sortMode === 'name' ? 'selected' : ''}>A→Z</option>
          <option value="usage" ${sortMode === 'usage' ? 'selected' : ''}>Meistgenutzt</option>
          <option value="category" ${sortMode === 'category' ? 'selected' : ''}>Kategorie</option>
        </select>
      </div>`;

    container.querySelectorAll('[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.filter;
        applyFilters();
      });
    });

    const sortEl = container.querySelector('#skills-sort');
    if (sortEl) sortEl.addEventListener('change', () => {
      sortMode = sortEl.value;
      applyFilters();
    });
  }

  function applyFilters() {
    const searchEl = document.getElementById('skills-search');
    const q = (searchEl?.value || '').toLowerCase().trim();
    let filtered = allSkills;

    if (q) {
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q))
      );
    }

    if (activeFilter !== 'all') {
      filtered = filtered.filter(s => getCategory(s.slug, s.name, s.description) === activeFilter);
    }

    // Sort
    filtered = [...filtered];
    if (sortMode === 'usage') {
      filtered.sort((a, b) => (usageData[b.slug] || 0) - (usageData[a.slug] || 0));
    } else if (sortMode === 'category') {
      filtered.sort((a, b) => getCategory(a.slug, a.name, a.description).localeCompare(getCategory(b.slug, b.name, b.description)));
    }

    renderFilterBar();
    renderCards(filtered);
  }

  // ── Cards ───────────────────────────────────────────────────────────────

  function renderCards(skills) {
    const grid = document.getElementById('skills-grid');
    const loading = document.getElementById('skills-loading');
    if (!grid) return;
    if (!skills.length) {
      grid.innerHTML = '';
      if (loading) { loading.textContent = 'Keine Skills gefunden.'; loading.style.display = 'block'; }
      return;
    }
    if (loading) loading.style.display = 'none';
    grid.innerHTML = skills.map(s => {
      const catKey = getCategory(s.slug, s.name, s.description);
      const cat = CATEGORIES[catKey];
      const isNew = highlightSlugs.has(s.slug);
      const glow = isNew ? `border-color:${cat.color}60;box-shadow:0 0 16px ${cat.color}30;` : '';
      const usage = usageData[s.slug] || 0;

      // Usage bar (visual)
      const maxUsage = Math.max(10, ...Object.values(usageData));
      const usagePct = Math.min(100, Math.round((usage / maxUsage) * 100));
      const usageBar = `<div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
        <div style="flex:1;height:3px;background:var(--border-subtle);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${usagePct}%;background:${usage > 0 ? '#a78bfa' : 'transparent'};border-radius:2px;transition:width .3s;"></div>
        </div>
        <span style="font-size:10px;color:${usage > 0 ? '#a78bfa' : 'var(--text-dim)'};min-width:32px;text-align:right;">${usage}×</span>
      </div>`;

      // Capabilities preview (max 3)
      const caps = (s.capabilities || []).slice(0, 3);
      const capsHtml = caps.length
        ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:1px;">${caps.map(c => `<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5;"><span style="color:${cat.color};margin-right:5px;">▸</span>${escapeHtml(c)}</div>`).join('')}</div>`
        : '';

      // Status row
      const statusItems = [
        s.hasWrapper ? `<span title="Auto-Trigger aktiv" style="font-size:9px;color:#4ade80;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.2);padding:1px 6px;border-radius:3px;">⚡ Auto</span>` : '',
        s.hasSkillMd ? `<span style="font-size:9px;color:var(--text-dim);background:var(--border-subtle);padding:1px 5px;border-radius:3px;">SKILL.md</span>` : '',
      ].filter(Boolean).join('');

      return `<div class="skill-card" data-slug="${s.slug}" style="background:var(--bg-secondary);border:1px solid var(--border-light);border-radius:10px;padding:14px 16px;cursor:pointer;transition:all .25s;${glow};display:flex;flex-direction:column;" onclick="window._openSkillDetail('${s.slug}')" onmouseenter="this.style.borderColor='${cat.color}50';this.style.boxShadow='0 4px 20px ${cat.color}15';this.style.transform='translateY(-1px)'" onmouseleave="this.style.borderColor='${isNew ? cat.color + '60' : 'var(--border-light)'}';this.style.boxShadow='${isNew ? '0 0 16px ' + cat.color + '30' : 'none'}';this.style.transform='none'">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
        <span style="font-size:14px;">${cat.icon}</span>
        <span style="font-size:13px;font-weight:600;color:var(--text-primary);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${isNew ? '<span style="color:#4ade80;margin-right:4px;font-size:10px;font-weight:700;">NEW</span>' : ''}${escapeHtml(s.name)}</span>
        ${s.version ? `<span style="font-size:9px;color:var(--text-dim);">v${s.version}</span>` : ''}
      </div>
      <div style="font-size:11px;color:var(--text-secondary);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(truncate(s.description, 140))}</div>
    </div>
    <span style="font-size:10px;font-weight:600;color:${cat.color};background:${cat.color}15;border:1px solid ${cat.color}25;padding:2px 8px;border-radius:14px;white-space:nowrap;flex-shrink:0;">${cat.label}</span>
  </div>
  ${capsHtml}
  <div style="margin-top:auto;padding-top:8px;border-top:1px solid var(--border-subtle);">
    ${usageBar}
    <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:5px;">${statusItems}</div>
  </div>
</div>`;
    }).join('');
  }

  function scrollToSlug(slug) {
    const card = document.querySelector(`.skill-card[data-slug="${slug}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── Data Loading ────────────────────────────────────────────────────────

  async function loadUsageStats() {
    try {
      const res = await fetch('/api/skills/usage');
      const data = await res.json();
      usageData = data.usage || {};
    } catch (e) { /* silent */ }
  }

  async function loadSkills() {
    if (loaded) return;
    try {
      const [skillsRes] = await Promise.all([
        fetch('/api/skills'),
        loadUsageStats(),
      ]);
      const data = await skillsRes.json();
      allSkills = data.skills || [];
      loaded = true;
      const countEl = document.getElementById('skills-count');
      if (countEl) countEl.textContent = `${allSkills.length} Skills`;
      renderFilterBar();
      applyFilters();
    } catch (e) {
      const loading = document.getElementById('skills-loading');
      if (loading) { loading.textContent = 'Fehler beim Laden der Skills.'; loading.style.display = 'block'; }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const searchEl = document.getElementById('skills-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => applyFilters());
    }
  });

  // ── Skill Detail Modal ────────────────────────────────────────────────────

  function renderFileTree(entries, depth) {
    if (!entries || !entries.length) return '';
    depth = depth || 0;
    return entries.map(e => {
      const indent = '&nbsp;&nbsp;'.repeat(depth);
      if (e.type === 'dir') {
        return `<div style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono);line-height:1.7;">${indent}<span style="color:#fbbf24;">📁</span> ${escapeHtml(e.name)}/</div>` +
          renderFileTree(e.children, depth + 1);
      }
      const sizeStr = e.size > 0 ? ` <span style="color:var(--text-dim);font-size:10px;">${formatBytes(e.size)}</span>` : '';
      const ext = e.name.split('.').pop().toLowerCase();
      const fileIcon = { md: '📝', json: '📋', py: '🐍', js: '📜', ts: '📜', yaml: '⚙️', yml: '⚙️' }[ext] || '📄';
      return `<div style="color:var(--text-secondary);font-size:12px;font-family:var(--font-mono);line-height:1.7;">${indent}${fileIcon} ${escapeHtml(e.name)}${sizeStr}</div>`;
    }).join('');
  }

  window._openSkillDetail = async function(slug) {
    const old = document.getElementById('skill-detail-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'skill-detail-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);animation:fadeIn .15s ease;';
    modal.innerHTML = `<div style="background:var(--bg-primary);border:1px solid var(--border-light);border-radius:14px;width:92%;max-width:780px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div id="skill-detail-header" style="padding:16px 20px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="flex:1;font-size:14px;color:var(--text-muted);">Lade…</div>
          <button onclick="document.getElementById('skill-detail-modal').remove()" style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;padding:4px 8px;">✕</button>
        </div>
      </div>
      <div id="skill-detail-tabs" style="display:none;padding:0 20px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;"></div>
      <div id="skill-detail-body" style="flex:1;overflow-y:auto;padding:20px;"></div>
    </div>`;
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);

    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`);
      const d = await res.json();
      if (d.error) {
        document.getElementById('skill-detail-body').innerHTML = `<div style="color:#f87171;">${escapeHtml(d.error)}</div>`;
        return;
      }

      const catKey = getCategory(d.slug, d.name, d.description);
      const cat = CATEGORIES[catKey];

      // Header
      document.getElementById('skill-detail-header').innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="font-size:28px;line-height:1;">${cat.icon}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-size:17px;font-weight:700;color:var(--text-primary);">${escapeHtml(d.name)}</span>
              ${d.version ? `<span style="font-size:11px;color:var(--text-dim);background:var(--border-subtle);padding:1px 8px;border-radius:10px;">v${escapeHtml(d.version)}</span>` : ''}
              <span style="font-size:10px;font-weight:600;color:${cat.color};background:${cat.color}15;border:1px solid ${cat.color}25;padding:2px 10px;border-radius:14px;">${cat.label}</span>
              ${d.hasWrapper ? '<span style="font-size:10px;color:#4ade80;background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.2);padding:2px 10px;border-radius:14px;">⚡ Auto-Trigger</span>' : ''}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;line-height:1.5;">${escapeHtml(d.description || '(keine Beschreibung)')}</div>
          </div>
          <button onclick="document.getElementById('skill-detail-modal').remove()" style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;padding:4px 8px;flex-shrink:0;">✕</button>
        </div>`;

      // Tab navigation
      const tabs = [
        { id: 'overview', label: 'Übersicht' },
        { id: 'files', label: `Dateien (${d.totalFiles})` },
        { id: 'source', label: 'Quelltext' },
      ];
      const tabsEl = document.getElementById('skill-detail-tabs');
      tabsEl.style.display = 'flex';
      tabsEl.innerHTML = `<div style="display:flex;gap:0;">
        ${tabs.map((t, i) => `<button data-tab="${t.id}" style="padding:10px 16px;font-size:12px;font-weight:${i === 0 ? '600' : '400'};color:${i === 0 ? cat.color : 'var(--text-muted)'};border:none;background:none;cursor:pointer;border-bottom:2px solid ${i === 0 ? cat.color : 'transparent'};transition:all .2s;">${t.label}</button>`).join('')}
      </div>`;

      // Tab content data
      const tabContent = {};

      // ── Overview Tab ──
      const usage = d.usageCount || 0;
      const maxUsage = Math.max(10, ...Object.values(usageData));
      const usagePct = Math.min(100, Math.round((usage / maxUsage) * 100));

      let overviewHtml = '';

      // Stats row
      overviewHtml += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;">
        <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px;">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Nutzung</div>
          <div style="font-size:22px;font-weight:700;color:${usage > 0 ? '#a78bfa' : 'var(--text-primary)'};margin-top:2px;">${usage}</div>
          <div style="height:3px;background:var(--border-subtle);border-radius:2px;margin-top:4px;overflow:hidden;">
            <div style="height:100%;width:${usagePct}%;background:#a78bfa;border-radius:2px;"></div>
          </div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:3px;">${usage > 0 ? 'Sessions' : 'Noch nie genutzt'}</div>
        </div>
        <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px;">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Dateien</div>
          <div style="font-size:22px;font-weight:700;color:var(--text-primary);margin-top:2px;">${d.totalFiles}</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:7px;">${formatBytes(d.totalSize)}</div>
        </div>
        <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px;">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Auto-Trigger</div>
          <div style="font-size:16px;font-weight:700;color:${d.hasWrapper ? '#4ade80' : 'var(--text-muted)'};margin-top:6px;">${d.hasWrapper ? '✓ Aktiv' : '— Kein'}</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:3px;">${[d.hasSkillMd ? 'SKILL.md' : '', d.hasReadme ? 'README' : ''].filter(Boolean).join(' · ') || 'Keine Docs'}</div>
        </div>
      </div>`;

      // Capabilities
      if (d.body) {
        const capMatches = [...d.body.matchAll(/^[-*]\s+(.+)/gm)].slice(0, 10);
        if (capMatches.length) {
          overviewHtml += `<div style="margin-bottom:16px;">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Was kann dieser Skill?</div>
            <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 16px;">
              ${capMatches.map(m => `<div style="font-size:12px;color:var(--text-secondary);padding:4px 0;line-height:1.5;border-bottom:1px solid var(--border-subtle);"><span style="color:${cat.color};margin-right:8px;font-weight:600;">▸</span>${escapeHtml(m[1].trim())}</div>`).join('')}
            </div>
          </div>`;
        }
      }

      // Tags
      if (d.tags && d.tags.length) {
        overviewHtml += `<div style="margin-bottom:14px;display:flex;gap:6px;flex-wrap:wrap;">`;
        d.tags.forEach(t => {
          overviewHtml += `<span style="font-size:10px;color:var(--text-muted);background:var(--border-subtle);padding:3px 10px;border-radius:14px;">${escapeHtml(t)}</span>`;
        });
        overviewHtml += `</div>`;
      }

      // Triggers
      if (d.triggers && d.triggers.length) {
        overviewHtml += `<div style="margin-bottom:14px;">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Trigger-Bedingungen</div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:8px;padding:8px 12px;">`;
        d.triggers.forEach(t => {
          overviewHtml += `<div style="font-size:12px;color:var(--text-secondary);padding:4px 0;font-family:var(--font-mono);"><span style="color:#60a5fa;">→</span> ${escapeHtml(typeof t === 'string' ? t : JSON.stringify(t))}</div>`;
        });
        overviewHtml += `</div></div>`;
      }

      // Meta fields
      const metaKeys = Object.keys(d.meta || {});
      if (metaKeys.length) {
        overviewHtml += `<div style="margin-bottom:14px;">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Metadaten</div>
          <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 14px;border:1px solid var(--border-subtle);">`;
        metaKeys.forEach(k => {
          const v = d.meta[k];
          const display = Array.isArray(v) ? v.join(', ') : String(v);
          overviewHtml += `<div style="font-size:12px;line-height:1.7;"><span style="color:var(--text-muted);font-weight:600;">${escapeHtml(k)}:</span> <span style="color:var(--text-secondary);">${escapeHtml(truncate(display, 200))}</span></div>`;
        });
        overviewHtml += `</div></div>`;
      }

      tabContent.overview = overviewHtml;

      // ── Files Tab ──
      let filesHtml = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:12px;color:var(--text-secondary);">${d.totalFiles} Dateien</span>
        <span style="font-size:11px;color:var(--text-dim);">·</span>
        <span style="font-size:12px;color:var(--text-dim);">${formatBytes(d.totalSize)}</span>
        <span style="font-size:11px;color:var(--text-dim);">·</span>
        <span style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono);">skills/${escapeHtml(d.slug)}/</span>
      </div>
      <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:14px 16px;max-height:400px;overflow-y:auto;">
        ${renderFileTree(d.fileTree)}
      </div>`;
      tabContent.files = filesHtml;

      // ── Source Tab ──
      let sourceHtml = '';
      if (d.skillMdContent || d.body) {
        sourceHtml += `<div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">📝 SKILL.md</div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:14px 16px;max-height:350px;overflow-y:auto;">
            <pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;margin:0;line-height:1.6;font-family:var(--font-mono);">${escapeHtml(d.skillMdContent || d.body)}</pre>
          </div>
        </div>`;
      }
      if (d.wrapperContent) {
        sourceHtml += `<div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">⚡ Claude Code Wrapper</div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:14px 16px;max-height:300px;overflow-y:auto;">
            <pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;margin:0;line-height:1.6;font-family:var(--font-mono);">${escapeHtml(d.wrapperContent)}</pre>
          </div>
        </div>`;
      }
      if (d.readmeContent) {
        sourceHtml += `<div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">📖 README.md</div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:14px 16px;max-height:350px;overflow-y:auto;">
            <pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;margin:0;line-height:1.6;font-family:var(--font-mono);">${escapeHtml(d.readmeContent)}</pre>
          </div>
        </div>`;
      }
      if (!sourceHtml) sourceHtml = '<div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center;">Kein Quelltext verfügbar.</div>';
      tabContent.source = sourceHtml;

      // Render first tab
      const body = document.getElementById('skill-detail-body');
      body.innerHTML = tabContent.overview;

      // Tab switching
      tabsEl.querySelectorAll('button[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          const tabId = btn.dataset.tab;
          tabsEl.querySelectorAll('button[data-tab]').forEach(b => {
            const isActive = b.dataset.tab === tabId;
            b.style.fontWeight = isActive ? '600' : '400';
            b.style.color = isActive ? cat.color : 'var(--text-muted)';
            b.style.borderBottomColor = isActive ? cat.color : 'transparent';
          });
          body.innerHTML = tabContent[tabId] || '';
        });
      });

    } catch (e) {
      document.getElementById('skill-detail-body').innerHTML = `<div style="color:#f87171;">Fehler: ${escapeHtml(e.message)}</div>`;
    }
  };

  // ── Preview / Install ───────────────────────────────────────────────────

  let _pendingInstallContent = null;

  async function previewSkill() {
    const contentEl = document.getElementById('skill-content');
    const statusEl = document.getElementById('skill-add-status');
    const btn = document.getElementById('skill-add-btn');
    const content = (contentEl?.value || '').trim();
    if (!content) { if (statusEl) statusEl.textContent = 'Inhalt oder URL erforderlich.'; return; }
    if (btn) btn.disabled = true;
    if (statusEl) { statusEl.textContent = 'Analysiere…'; statusEl.style.color = 'var(--text-muted)'; }
    _hideReview();
    try {
      const res = await fetch('/api/skills/preview', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (!data.ok) {
        if (statusEl) { statusEl.textContent = `Fehler: ${data.error}`; statusEl.style.color = '#f87171'; }
        return;
      }
      if (statusEl) statusEl.textContent = '';
      _pendingInstallContent = content;
      _showReview(data);
    } catch (e) {
      if (statusEl) { statusEl.textContent = `Fehler: ${e.message}`; statusEl.style.color = '#f87171'; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function _hideReview() {
    const el = document.getElementById('skill-review-card');
    if (el) el.remove();
  }

  function _showReview(data) {
    _hideReview();
    const addBody = document.getElementById('skill-add-body');
    if (!addBody) return;

    const verdictColor = { 'empfohlen': '#4ade80', 'ok': '#fbbf24', 'schwach': '#ef4444', 'batch': '#60a5fa' }[data.verdict] || '#94a3b8';
    const verdictLabel = { 'empfohlen': '✓ Empfohlen', 'ok': '~ Okay', 'schwach': '✗ Schwach', 'batch': '📦 Skill-Paket' }[data.verdict] || data.verdict;
    const alreadyNote = data.already_installed ? '<div style="color:#fbbf24;font-size:12px;margin-bottom:8px;padding:6px 10px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:6px;">⚠ Bereits installiert — wird übersprungen.</div>' : '';

    let details = '';
    if (data.batch) {
      // Batch: show skill list in grid
      const names = data.skill_names || [];
      details = `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">${escapeHtml(data.description)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;max-height:120px;overflow-y:auto;">
          ${names.slice(0, 30).map(n => {
            const nCat = getCat(n, n, '');
            return `<span style="font-size:10px;color:${nCat.color};background:${nCat.color}10;border:1px solid ${nCat.color}20;padding:2px 8px;border-radius:12px;">${escapeHtml(n)}</span>`;
          }).join('')}
          ${names.length > 30 ? `<span style="font-size:10px;color:var(--text-dim);">+${names.length - 30} weitere</span>` : ''}
        </div>`;
    } else {
      const pros = (data.pros || []).map(p => `<div style="color:#4ade80;font-size:11px;padding:2px 0;"><span style="margin-right:4px;">✓</span>${escapeHtml(p)}</div>`).join('');
      const cons = (data.cons || []).map(c => `<div style="color:#f87171;font-size:11px;padding:2px 0;"><span style="margin-right:4px;">✗</span>${escapeHtml(c)}</div>`).join('');
      const triggers = data.triggers?.length ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted);"><span style="font-weight:600;">Trigger:</span> ${data.triggers.map(t => `<code style="font-size:10px;background:var(--border-subtle);padding:1px 6px;border-radius:3px;">${escapeHtml(t)}</code>`).join(' ')}</div>` : '';
      const scoreBar = `<div style="margin-top:10px;display:flex;align-items:center;gap:8px;">
        <div style="font-size:10px;color:var(--text-muted);font-weight:600;">Qualität</div>
        <div style="flex:1;height:5px;background:var(--border-subtle);border-radius:3px;overflow:hidden;max-width:140px;">
          <div style="height:100%;width:${Math.round((data.score || 0) / (data.max_score || 7) * 100)}%;background:${verdictColor};border-radius:3px;transition:width .3s;"></div>
        </div>
        <span style="font-size:11px;font-weight:600;color:${verdictColor};">${data.score || 0}/${data.max_score || 7}</span>
      </div>`;
      details = `
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;line-height:1.5;">${escapeHtml(data.description || '(keine Beschreibung)')}</div>
        <div style="display:flex;flex-direction:column;gap:1px;">${pros}${cons}</div>
        ${triggers}
        ${scoreBar}`;
    }

    // Jarvis recommendation
    const rec = data.recommendation;
    let recHtml = '';
    if (rec) {
      const recIcon = { ja: '👍', nein: '👎', vielleicht: '🤔', selektiv: '⚡' }[rec.action] || '💬';
      const recColor = { ja: '#4ade80', nein: '#f87171', vielleicht: '#fbbf24', selektiv: '#60a5fa' }[rec.action] || '#94a3b8';
      recHtml = `<div style="margin-top:12px;padding:10px 14px;border-radius:10px;background:${recColor}08;border:1px solid ${recColor}20;">
        <div style="font-size:11px;font-weight:700;color:${recColor};margin-bottom:4px;">${recIcon} Jarvis sagt: ${rec.action.toUpperCase()}</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">${escapeHtml(rec.text)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;font-style:italic;">${escapeHtml(rec.reason)}</div>
      </div>`;
    }

    const card = document.createElement('div');
    card.id = 'skill-review-card';
    card.style.cssText = `margin-top:12px;padding:16px 18px;border-radius:12px;border:1px solid ${verdictColor}30;background:${verdictColor}06;`;

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="font-size:15px;font-weight:700;color:var(--text-primary);">${escapeHtml(data.name || 'Skill')}</span>
        ${data.version ? `<span style="font-size:10px;color:var(--text-dim);background:var(--border-subtle);padding:1px 8px;border-radius:10px;">v${escapeHtml(data.version)}</span>` : ''}
        <span style="margin-left:auto;font-size:11px;font-weight:600;color:${verdictColor};background:${verdictColor}15;border:1px solid ${verdictColor}30;padding:3px 12px;border-radius:16px;">${verdictLabel}</span>
      </div>
      ${alreadyNote}
      ${details}
      ${recHtml}
      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;padding-top:12px;border-top:1px solid var(--border-subtle);">
        ${data.already_installed ? '' : `<button onclick="window._confirmInstallSkill()" style="background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);color:#4ade80;border-radius:8px;padding:7px 20px;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;" onmouseenter="this.style.background='rgba(74,222,128,0.2)'" onmouseleave="this.style.background='rgba(74,222,128,0.12)'">Installieren</button>`}
        <button onclick="window._dismissSkillReview()" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:8px;padding:7px 16px;font-size:12px;cursor:pointer;transition:all .2s;">Abbrechen</button>
        <button onclick="window._laterSkillReview()" style="background:transparent;border:1px solid var(--border-light);color:var(--text-muted);border-radius:8px;padding:7px 16px;font-size:12px;cursor:pointer;transition:all .2s;">Später</button>
        <span id="skill-review-status" style="font-size:11px;color:var(--text-muted);margin-left:auto;"></span>
      </div>`;
    addBody.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  window._confirmInstallSkill = async function() {
    const content = _pendingInstallContent;
    if (!content) return;
    const statusEl = document.getElementById('skill-review-status');
    const btns = document.querySelectorAll('#skill-review-card button');
    btns.forEach(b => b.disabled = true);
    if (statusEl) statusEl.textContent = 'Installiere…';
    try {
      const res = await fetch('/api/skills', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (data.ok) {
        _hideReview();
        const contentEl = document.getElementById('skill-content');
        if (contentEl) contentEl.value = '';
        const statusMain = document.getElementById('skill-add-status');
        if (statusMain) {
          statusMain.style.color = '#4ade80';
          statusMain.textContent = data.batch ? `✓ ${data.slug}` : `✓ "${data.slug}" installiert!`;
        }
        highlightSlugs.clear();
        if (data.batch && data.installed) data.installed.filter(i => i.ok).forEach(i => highlightSlugs.add(i.slug));
        else if (data.slug) highlightSlugs.add(data.slug);
        loaded = false;
        await loadSkills();
        const firstNew = data.batch ? (data.installed?.find(i => i.ok) || {}).slug : data.slug;
        if (firstNew) setTimeout(() => scrollToSlug(firstNew), 100);
        setTimeout(() => { highlightSlugs.clear(); applyFilters(); }, 5000);
        setTimeout(() => { if (statusMain) { statusMain.textContent = ''; statusMain.style.color = ''; } }, 3000);
        _pendingInstallContent = null;
      } else {
        if (statusEl) { statusEl.textContent = `Fehler: ${data.error}`; statusEl.style.color = '#f87171'; }
        btns.forEach(b => b.disabled = false);
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = `Fehler: ${e.message}`; statusEl.style.color = '#f87171'; }
      btns.forEach(b => b.disabled = false);
    }
  };

  window._dismissSkillReview = function() {
    _hideReview();
    _pendingInstallContent = null;
    const contentEl = document.getElementById('skill-content');
    if (contentEl) contentEl.value = '';
  };

  window._laterSkillReview = function() {
    _hideReview();
    const statusEl = document.getElementById('skill-add-status');
    if (statusEl) { statusEl.textContent = 'Inhalt bleibt im Textfeld.'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
  };

  window.loadSkills = loadSkills;
  window.installSkill = previewSkill;
})();
