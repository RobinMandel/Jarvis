// Mission Control — Dokumente-View
// Listet aktive Bewerbungen/Schreiben mit Google-Doc-Link (Live-Co-Edit) +
// Word-Download (gesynct via Sync-Trigger). Backend: /api/documents/*
(function () {
  const view = document.getElementById('view-documents');
  if (!view) return;

  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  function _fmtTime(iso) {
    if (!iso) return '–';
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMin = (now - d) / 60000;
      if (diffMin < 1) return 'gerade eben';
      if (diffMin < 60) return `vor ${Math.round(diffMin)} min`;
      if (diffMin < 1440) return `vor ${Math.round(diffMin/60)} h`;
      return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'});
    } catch (e) { return iso; }
  }

  function _renderCard(d) {
    const tags = (d.tags || []).map(t =>
      `<span style="font-size:10px;background:#1e293b;color:#94a3b8;padding:2px 7px;border-radius:10px">${_esc(t)}</span>`
    ).join(' ');
    const wordStatus = d.word_exists
      ? `<span style="color:#34d399">✓ ${d.word_size_kb} KB · ${_fmtTime(d.word_mtime)}</span>`
      : `<span style="color:#ef4444">✗ Datei fehlt</span>`;
    const deadline = d.deadline
      ? `<div style="font-size:11px;color:#fbbf24;margin-top:2px">⏰ Deadline: ${_esc(d.deadline)}</div>`
      : '';
    const statusBadge = d.status
      ? `<span style="font-size:10px;background:#0c4a6e;color:#7dd3fc;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.05em">${_esc(d.status)}</span>`
      : '';

    return `
    <div class="panel" style="border-color:#a78bfa30;margin-bottom:14px" data-doc-id="${_esc(d.id)}">
      <div class="panel-header">
        <div>
          <h2 style="margin:0">${_esc(d.title)} ${statusBadge}</h2>
          ${d.subtitle ? `<div style="font-size:13px;color:var(--text-muted);margin-top:3px">${_esc(d.subtitle)}</div>` : ''}
          ${deadline}
        </div>
        <div style="display:flex;gap:6px">${tags}</div>
      </div>
      <div class="panel-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div style="padding:14px;border:1px solid #1e3a8a55;border-radius:10px;background:#0a0c12">
            <div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#7dd3fc;margin-bottom:8px">📝 Live-Edit (Google Docs)</div>
            <div style="font-size:12px;color:#cbd5e1;margin-bottom:10px;line-height:1.5">Editierbar im Browser, beide arbeiten gleichzeitig. Robin tippt direkt, Claude liest auf Anfrage.</div>
            <a href="${_esc(d.gdoc_url)}" target="_blank" rel="noopener"
               style="display:inline-block;padding:8px 16px;background:#0ea5e9;color:#fff;border-radius:7px;font-size:12px;font-weight:700;text-decoration:none">
               Google Docs öffnen →
            </a>
          </div>
          <div style="padding:14px;border:1px solid #16a34a55;border-radius:10px;background:#0a0c12">
            <div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#86efac;margin-bottom:8px">📄 Word-Snapshot (.docx)</div>
            <div style="font-size:12px;color:#cbd5e1;margin-bottom:10px;line-height:1.5">Lokale Word-Version, gesynct mit Google Docs. ${wordStatus}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <a href="/api/documents/${_esc(d.id)}/word" target="_blank"
                 style="padding:8px 14px;background:#16a34a;color:#fff;border-radius:7px;font-size:12px;font-weight:700;text-decoration:none">
                 ⬇ Download
              </a>
              <button class="dlr-doc-sync" data-doc-id="${_esc(d.id)}"
                style="padding:8px 14px;background:#0a0c12;color:#fbbf24;border:1px solid #f59e0b55;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">
                ⟳ Word neu syncen
              </button>
            </div>
          </div>
        </div>
        <div style="font-size:11px;color:#64748b">
          Letzter Sync: ${_fmtTime(d.last_synced)} ·
          GDoc-ID: <code style="font-size:10px">${_esc(d.gdoc_id || '–')}</code>
        </div>
      </div>
    </div>`;
  }

  async function _load() {
    view.innerHTML = `
      <div style="padding:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div>
            <h1 style="margin:0;font-size:22px">📄 Dokumente</h1>
            <div style="font-size:13px;color:var(--text-muted);margin-top:3px">
              Live-Co-Edit via Google Docs · Word-Snapshot synchronisiert · neue Dokumente per Auftrag an Jarvis
            </div>
          </div>
          <button id="dlr-doc-refresh" style="padding:8px 14px;background:#0a0c12;color:#a78bfa;border:1px solid #a78bfa55;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">⟳ Reload</button>
        </div>
        <div id="dlr-doc-list" style="font-size:13px;color:var(--text-muted)">Lade …</div>
      </div>`;

    const list = view.querySelector('#dlr-doc-list');
    try {
      const r = await fetch('/api/documents/list');
      const data = await r.json();
      if (!data.ok || !data.documents || !data.documents.length) {
        list.innerHTML = `<div style="padding:30px;text-align:center;color:#64748b">
          <div style="font-size:36px;margin-bottom:10px">📭</div>
          <div>Noch keine Dokumente</div>
          <div style="margin-top:8px;font-size:11px">Sage Jarvis: "leg ein neues Dokument an für …"</div>
        </div>`;
        return;
      }
      list.innerHTML = data.documents.map(_renderCard).join('');

      // Sync-Buttons verkabeln
      list.querySelectorAll('.dlr-doc-sync').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.docId;
          btn.disabled = true;
          const oldText = btn.textContent;
          btn.textContent = '⏳ ...';
          try {
            const sr = await fetch(`/api/documents/${encodeURIComponent(id)}/sync`, { method: 'POST' });
            const sd = await sr.json();
            if (sd.ok) {
              btn.textContent = '✓ Sync angefordert';
              btn.style.color = '#34d399';
              setTimeout(() => _load(), 1500);
            } else {
              btn.textContent = '✗ ' + (sd.error || 'Fehler');
              btn.style.color = '#ef4444';
            }
          } catch (e) {
            btn.textContent = '✗ Network';
          }
          setTimeout(() => {
            btn.textContent = oldText; btn.disabled = false; btn.style.color = '#fbbf24';
          }, 3500);
        });
      });
    } catch (e) {
      list.innerHTML = `<div style="color:#ef4444">Fehler beim Laden: ${_esc(e.message)}</div>`;
    }

    const refreshBtn = view.querySelector('#dlr-doc-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', _load);
  }

  window.DocumentsView = { init: _load };
})();
