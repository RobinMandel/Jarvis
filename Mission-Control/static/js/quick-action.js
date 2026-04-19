// Quick-Action FAB: Anki-Karte / Mail / Kalender aus einer Hand
(function () {
  const fab = document.getElementById('qa-fab');
  const modal = document.getElementById('qa-modal');
  if (!fab || !modal) return;

  const statusEl = document.getElementById('qa-status');
  const submitBtn = document.getElementById('qa-submit');
  let currentTab = 'anki';

  function open() {
    modal.classList.remove('qa-hidden');
    setStatus('', '');
    // prefill calendar start with next rounded half-hour
    const startEl = document.getElementById('qa-cal-start');
    if (startEl && !startEl.value) {
      const d = new Date(Date.now() + 30 * 60000);
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() >= 30 ? 30 : 0);
      const pad = (n) => String(n).padStart(2, '0');
      startEl.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  function close() { modal.classList.add('qa-hidden'); }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.classList.remove('ok', 'err');
    if (kind) statusEl.classList.add(kind);
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.qa-tab').forEach(b => b.classList.toggle('active', b.dataset.qaTab === tab));
    document.querySelectorAll('.qa-pane').forEach(p => p.classList.toggle('active', p.dataset.qaPane === tab));
    setStatus('', '');
  }

  async function submit() {
    submitBtn.disabled = true;
    setStatus('Sende...', '');
    let payload = { type: currentTab };
    if (currentTab === 'anki') {
      const tags = (document.getElementById('qa-anki-tags').value || '')
        .split(',').map(t => t.trim()).filter(Boolean);
      payload = {
        ...payload,
        deck: document.getElementById('qa-anki-deck').value.trim() || 'Default',
        front: document.getElementById('qa-anki-front').value.trim(),
        back: document.getElementById('qa-anki-back').value.trim(),
        tags,
      };
      if (!payload.front || !payload.back) {
        setStatus('Vorder- und Rückseite erforderlich.', 'err');
        submitBtn.disabled = false; return;
      }
    } else if (currentTab === 'email') {
      payload = {
        ...payload,
        to: document.getElementById('qa-mail-to').value.trim(),
        subject: document.getElementById('qa-mail-subject').value.trim(),
        body: document.getElementById('qa-mail-body').value,
      };
      if (!payload.to) {
        setStatus('Empfänger fehlt.', 'err');
        submitBtn.disabled = false; return;
      }
    } else if (currentTab === 'calendar') {
      const startLocal = document.getElementById('qa-cal-start').value;
      if (!startLocal) {
        setStatus('Startzeit fehlt.', 'err');
        submitBtn.disabled = false; return;
      }
      payload = {
        ...payload,
        title: document.getElementById('qa-cal-title').value.trim(),
        start: new Date(startLocal).toISOString(),
        duration: parseInt(document.getElementById('qa-cal-duration').value, 10) || 60,
        location: document.getElementById('qa-cal-location').value.trim(),
        description: document.getElementById('qa-cal-desc').value.trim(),
      };
      if (!payload.title) {
        setStatus('Titel fehlt.', 'err');
        submitBtn.disabled = false; return;
      }
    }

    try {
      const res = await fetch('/api/quick-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        const msg = currentTab === 'anki' ? `Karte gespeichert (Deck: ${data.deck})`
                  : currentTab === 'email' ? 'Mail gesendet.'
                  : 'Event angelegt.';
        setStatus(msg, 'ok');
        setTimeout(close, 1200);
      } else {
        setStatus('Fehler: ' + (data.error || data.output || 'unbekannt'), 'err');
      }
    } catch (e) {
      setStatus('Netzwerk-Fehler: ' + e.message, 'err');
    } finally {
      submitBtn.disabled = false;
    }
  }

  fab.addEventListener('click', open);
  submitBtn.addEventListener('click', submit);
  modal.querySelectorAll('[data-qa-close]').forEach(el => el.addEventListener('click', close));
  document.querySelectorAll('.qa-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.qaTab)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('qa-hidden')) close();
  });
})();
