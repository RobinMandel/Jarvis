// Email Panel
async function loadEmails() {
  const panel = document.getElementById('email-panel');
  panel.innerHTML = '<div class="empty-state">Lade Emails...</div>';
  try {
    const res = await fetch('/api/email');
    const data = await res.json();
    const all = [...(data.outlook || []), ...(data.uni || [])];
    if (!all.length) {
      panel.innerHTML = '<div class="empty-state">Keine ungelesenen Emails</div>';
      return;
    }
    let html = `<div class="email-summary" style="margin-bottom:16px;color:var(--text-muted)">
      ${data.total_unread} ungelesen (${data.outlook?.length || 0} Outlook, ${data.uni?.length || 0} Uni)
    </div>`;
    html += '<div class="email-list">';
    for (const m of all) {
      const badge = m.account === 'Uni'
        ? '<span class="email-badge uni">UNI</span>'
        : '<span class="email-badge outlook">OL</span>';
      html += `<div class="email-item">
        ${badge}
        <div class="email-content">
          <div class="email-from">${esc(m.from)}</div>
          <div class="email-subject">${esc(m.subject)}</div>
        </div>
        <div class="email-date">${esc(m.date?.slice(0, 10) || '')}</div>
      </div>`;
    }
    html += '</div>';
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">Fehler: ${e.message}</div>`;
  }
}

document.getElementById('btn-refresh-email')?.addEventListener('click', loadEmails);

// --- Compose / Send ---
const composeBox = document.getElementById('email-compose');
document.getElementById('btn-compose-email')?.addEventListener('click', () => {
  if (!composeBox) return;
  composeBox.style.display = composeBox.style.display === 'none' ? 'block' : 'none';
  if (composeBox.style.display === 'block') {
    document.getElementById('compose-to')?.focus();
  }
});
document.getElementById('btn-cancel-email')?.addEventListener('click', () => {
  if (composeBox) composeBox.style.display = 'none';
  const s = document.getElementById('compose-status'); if (s) s.textContent = '';
});
document.getElementById('btn-send-email')?.addEventListener('click', async () => {
  const to = document.getElementById('compose-to')?.value.trim();
  const subject = document.getElementById('compose-subject')?.value.trim();
  const body = document.getElementById('compose-body')?.value;
  const statusEl = document.getElementById('compose-status');
  const btn = document.getElementById('btn-send-email');
  if (!to) { if (statusEl) statusEl.textContent = 'Empfaenger fehlt'; return; }
  if (!subject && !confirm('Mail ohne Betreff senden?')) return;
  if (statusEl) statusEl.textContent = 'Sende...';
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/quick-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', to, subject, body }),
    });
    const data = await res.json();
    if (data.ok) {
      if (statusEl) statusEl.textContent = 'OK: gesendet';
      ['compose-to','compose-subject','compose-body'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      setTimeout(() => { if (composeBox) composeBox.style.display = 'none'; if (statusEl) statusEl.textContent = ''; }, 1500);
    } else {
      if (statusEl) statusEl.textContent = 'Fehler: ' + (data.error || data.output || 'unbekannt');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Fehler: ' + e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
});
