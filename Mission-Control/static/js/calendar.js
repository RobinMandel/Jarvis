// Calendar Panel
async function loadCalendar() {
  const panel = document.getElementById('calendar-panel');
  panel.innerHTML = '<div class="empty-state">Lade Kalender...</div>';
  try {
    const res = await fetch('/api/calendar?days=7');
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) {
      panel.innerHTML = '<div class="empty-state">Keine Termine in den naechsten 7 Tagen</div>';
      return;
    }
    // Group by day
    const days = {};
    for (const e of events) {
      const start = e.start || '';
      const day = start.slice(0, 10);
      if (!days[day]) days[day] = [];
      days[day].push(e);
    }

    let html = '';
    for (const [day, evts] of Object.entries(days)) {
      const d = new Date(day + 'T00:00:00');
      const dayName = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
      html += `<div class="cal-day">
        <div class="cal-day-header">${dayName}</div>`;
      for (const e of evts) {
        const time = e.start?.slice(11, 16) || 'Ganztaegig';
        const cal = e.calendar ? `<span class="cal-tag">${esc(e.calendar)}</span>` : '';
        const loc = e.location ? `<span class="cal-location">${esc(e.location)}</span>` : '';
        html += `<div class="cal-event">
          <span class="cal-time">${time}</span>
          <span class="cal-title">${esc(e.summary)}</span>
          ${cal}${loc}
        </div>`;
      }
      html += '</div>';
    }
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">Fehler: ${e.message}</div>`;
  }
}

// New-event form toggle + submit
function _calFormToggle(show) {
  const form = document.getElementById('calendar-new-form');
  if (!form) return;
  form.style.display = show ? 'block' : 'none';
  if (show) {
    // Default: naechste volle Stunde
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    // toISOString ist UTC, wir brauchen local datetime-local format
    const pad = n => String(n).padStart(2, '0');
    const iso = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const startInput = document.getElementById('cal-start');
    if (startInput && !startInput.value) startInput.value = iso;
    document.getElementById('cal-title')?.focus();
  }
}

async function _calSave() {
  const title = document.getElementById('cal-title').value.trim();
  const startLocal = document.getElementById('cal-start').value; // YYYY-MM-DDTHH:MM (local)
  const duration = parseInt(document.getElementById('cal-duration').value, 10) || 60;
  const location = document.getElementById('cal-location').value.trim();
  const description = document.getElementById('cal-description').value.trim();
  const fb = document.getElementById('cal-feedback');

  if (!title) { fb.textContent = 'Titel fehlt'; fb.style.color = '#e66'; return; }
  if (!startLocal) { fb.textContent = 'Startzeit fehlt'; fb.style.color = '#e66'; return; }

  // Local datetime -> ISO mit Offset (icloud-calendar.py akzeptiert ISO)
  const d = new Date(startLocal);
  const isoStart = d.toISOString();

  fb.textContent = 'Speichere...';
  fb.style.color = '#888';
  try {
    const res = await fetch('/api/quick-action', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: 'calendar',
        title, start: isoStart, duration,
        location, description,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      fb.textContent = 'Angelegt. Wird synchronisiert...';
      fb.style.color = '#6c6';
      // Reset + schliessen
      document.getElementById('cal-title').value = '';
      document.getElementById('cal-location').value = '';
      document.getElementById('cal-description').value = '';
      setTimeout(() => {
        _calFormToggle(false);
        fb.textContent = '';
        loadCalendar();
      }, 1200);
    } else {
      fb.textContent = 'Fehler: ' + (data.error || data.output || 'unbekannt');
      fb.style.color = '#e66';
    }
  } catch (e) {
    fb.textContent = 'Netzwerkfehler: ' + e.message;
    fb.style.color = '#e66';
  }
}

document.getElementById('btn-refresh-calendar')?.addEventListener('click', loadCalendar);
document.getElementById('btn-new-calendar-event')?.addEventListener('click', () => {
  const form = document.getElementById('calendar-new-form');
  _calFormToggle(form && form.style.display === 'none');
});
document.getElementById('btn-cal-cancel')?.addEventListener('click', () => _calFormToggle(false));
document.getElementById('btn-cal-save')?.addEventListener('click', _calSave);
