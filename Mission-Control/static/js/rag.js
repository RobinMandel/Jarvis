/* Jarvis RAG Panel */

async function ragLoadStatus() {
  try {
    const res = await fetch('/api/rag/status');
    const d = await res.json();
    const badge = document.getElementById('rag-status-badge');
    if (!badge) return;
    if (d.ok && d.total_chunks > 0) {
      badge.textContent = `${d.total_chunks} Chunks · ${d.model.split('/').pop()}`;
      badge.style.background = '#064e3b';
      badge.style.color = '#34d399';
    } else if (d.ok) {
      badge.textContent = 'Index leer — Reindex starten';
      badge.style.background = '#78350f';
      badge.style.color = '#fbbf24';
    } else {
      badge.textContent = 'Nicht verfügbar';
      badge.style.color = '#f87171';
    }
  } catch (_) {}
}

async function ragSearch() {
  const q = document.getElementById('rag-query')?.value?.trim();
  if (!q) return;
  const n = parseInt(document.getElementById('rag-n')?.value || '5');
  const type = document.getElementById('rag-type')?.value || null;
  const out = document.getElementById('rag-results');
  if (!out) return;

  out.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">Suche läuft...</div>';
  try {
    const res = await fetch('/api/rag/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, n_results: n, type: type || undefined }),
    });
    const d = await res.json();
    if (d.error) {
      out.innerHTML = `<div style="color:#f87171">${d.error}</div>`;
      return;
    }
    if (!d.results?.length) {
      out.innerHTML = '<div style="color:var(--text-muted)">Keine Ergebnisse.</div>';
      return;
    }
    out.innerHTML = d.results.map((r, i) => {
      const score = Math.round(r.score * 100);
      const scoreColor = score > 70 ? '#34d399' : score > 45 ? '#fbbf24' : '#9ca3af';
      const typeIcon = r.type === 'pdf' ? '📄' : '📝';
      const shortPath = r.source.replace(/.*[\/\\]/, '').replace(r.filename, '') || r.filename;
      return `
        <div style="background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:8px;padding:14px;border-left:3px solid ${scoreColor}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:0.85rem;font-weight:600;color:var(--text-primary)">${typeIcon} ${r.filename}</span>
            <span style="margin-left:auto;font-size:0.75rem;padding:2px 6px;border-radius:10px;background:${scoreColor}22;color:${scoreColor}">
              ${score}% Match
            </span>
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px;font-family:var(--font-mono)">${r.source.slice(-60)}</div>
          <div style="font-size:0.85rem;color:var(--text-secondary);line-height:1.5;white-space:pre-wrap">${r.text.slice(0, 400)}${r.text.length > 400 ? '…' : ''}</div>
        </div>`;
    }).join('');
  } catch (e) {
    out.innerHTML = `<div style="color:#f87171">Fehler: ${e.message}</div>`;
  }
}

async function ragReindex(force = false) {
  const status = document.getElementById('rag-reindex-status');
  const badge  = document.getElementById('rag-status-badge');
  if (status) {
    status.textContent = force ? 'Rebuild läuft — dauert einige Minuten (bge-m3 embeds ~2000 Chunks)...' : 'Update läuft...';
    status.style.color = '#fbbf24';
  }
  try {
    const res = await fetch('/api/rag/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    const d = await res.json();
    if (d.ok) {
      if (status) {
        status.textContent = `Fertig: ${d.indexed} neue Chunks indexiert (${d.elapsed_s}s). Total: ${d.total}`;
        status.style.color = '#34d399';
      }
      ragLoadStatus();
    } else {
      if (status) { status.textContent = 'Fehler: ' + d.error; status.style.color = '#f87171'; }
    }
  } catch (e) {
    if (status) { status.textContent = 'Fehler: ' + e.message; status.style.color = '#f87171'; }
  }
}

// Load status when RAG view is activated
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item[data-view="rag"]').forEach(btn => {
    btn.addEventListener('click', ragLoadStatus);
  });
});
