// Memory panel — list and preview markdown files
MC.memory = (function() {
  let files = [];

  async function load() {
    try {
      const res = await fetch(MC.config.apiBase + '/memory');
      files = await res.json();
      renderList();
    } catch {
      document.getElementById('memory-list').innerHTML = '<div class="empty-state">Fehler beim Laden</div>';
    }
  }

  function renderList() {
    const el = document.getElementById('memory-list');
    if (!files.length) {
      el.innerHTML = '<div class="empty-state">Keine Memory-Dateien gefunden</div>';
      return;
    }

    let html = '';
    let lastType = '';
    let lastEra = '';

    for (const f of files) {
      // Section headers
      const type = f.type || 'other';
      const era = f.era || '';

      if (type !== lastType || era !== lastEra) {
        let label = '';
        if (type === 'meta') label = 'Kern-Dateien';
        else if (type === 'daily' && era === 'claude-code') label = 'Claude Code (ab 10.04.2026)';
        else if (type === 'daily' && era === 'openclaw') label = 'OpenClaw (Feb-Apr 2026)';
        else label = 'Sonstige';

        html += `<div class="memory-section">${label}</div>`;
        lastType = type;
        lastEra = era;
      }

      const icon = type === 'meta' ? '\u2605 ' : type === 'daily' ? '' : '\u25CB ';
      const eraTag = era === 'openclaw' ? '<span class="memory-era oc">OC</span>' :
                     era === 'claude-code' ? '<span class="memory-era cc">CC</span>' : '';

      html += `<div class="memory-item" data-name="${f.name}">
        <span>${icon}${f.name}</span>
        <span style="display:flex;align-items:center;gap:6px">
          ${eraTag}
          <span class="memory-size">${formatSize(f.size)}</span>
        </span>
      </div>`;
    }

    el.innerHTML = html;

    el.querySelectorAll('.memory-item').forEach(item => {
      item.addEventListener('click', () => {
        el.querySelectorAll('.memory-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        loadFile(item.dataset.name);
      });
    });
  }

  async function loadFile(name) {
    const preview = document.getElementById('memory-preview');
    try {
      const res = await fetch(MC.config.apiBase + '/memory/' + encodeURIComponent(name));
      const text = await res.text();
      preview.innerHTML = '<div class="memory-rendered">' + renderMarkdown(text) + '</div>';
    } catch {
      preview.innerHTML = '<div class="empty-state">Fehler beim Laden</div>';
    }
  }

  function renderMarkdown(text) {
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
    text = text.replace(/\n/g, '<br>');
    return text;
  }

  function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function formatSize(b) { return b < 1024 ? b + 'B' : (b/1024).toFixed(1) + 'KB'; }

  async function open(name) {
    // Switch to Brain view if not there
    const memNav = document.querySelector('.nav-item[data-view="memory"]');
    if (memNav) memNav.click();

    // Switch to Files tab
    await new Promise(r => setTimeout(r, 150));
    const filesTab = document.querySelector('.brain-tab[data-brain-tab="files"]');
    if (filesTab) filesTab.click();

    // Ensure file list is loaded
    if (!files.length) await load();
    await new Promise(r => setTimeout(r, 200));

    // Find and click the file in the list
    const baseName = name.replace(/\.md$/, '');
    const candidates = [name, baseName + '.md', baseName];

    const items = document.querySelectorAll('.memory-item');
    for (const item of items) {
      if (candidates.includes(item.dataset.name)) {
        item.classList.add('active');
        item.click();
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }

    // File not in memory list (maybe from Knowledge folder) — try direct fetch
    console.log('[Memory] File not in list, trying direct fetch:', name);
    const preview = document.getElementById('memory-preview');
    try {
      const fname = baseName + '.md';
      const res = await fetch(MC.config.apiBase + '/memory/' + encodeURIComponent(fname));
      if (res.ok) {
        const text = await res.text();
        preview.innerHTML = '<div class="memory-rendered"><h3>' + escapeHtml(fname) + '</h3>' + renderMarkdown(text) + '</div>';
      } else {
        preview.innerHTML = '<div class="empty-state">Phantom-Node: <strong>' + escapeHtml(baseName) + '</strong><br><small style="opacity:0.6">Wird als [[Wikilink]] referenziert, aber die Datei existiert nicht im Vault.</small></div>';
      }
    } catch {
      preview.innerHTML = '<div class="empty-state">Fehler beim Laden</div>';
    }
  }

  return { load, open };
})();
