// Email Panel v2 — 3-Pane Outlook-Style
// State + rendering for accounts, folder tree, message list, message detail.

var loadEmails; // hoisted global — app.js's view-loader registry looks it up as a bare identifier
(function () {
  'use strict';

  const esc = (typeof window.esc === 'function') ? window.esc :
    (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  const state = {
    accounts: [],
    selectedFolderId: null,
    selectedMessageId: null,
    messagesCache: new Map(),  // folderId -> array
    messageCache: new Map(),   // messageId -> full message
    syncingAccounts: new Set(),
  };

  const root  = () => document.getElementById('email-v2-root');
  const tree  = () => root()?.querySelector('.email-v2-tree');
  const list  = () => root()?.querySelector('.email-v2-list');
  const detail = () => root()?.querySelector('.email-v2-detail');
  const listTitle = () => document.getElementById('email-list-title');
  const listBody  = () => list()?.querySelector('.email-v2-list-body');
  const syncStatus = () => document.getElementById('email-sync-status');

  // ---------- API helpers ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  // ---------- Folder tree ----------
  function folderIcon(kind) {
    return ({
      inbox: '\u{1F4E5}', sent: '\u{1F4E4}', drafts: '\u{1F4DD}',
      trash: '\u{1F5D1}', spam: '\u{1F6AB}', archive: '\u{1F4E6}',
    }[kind]) || '\u{1F4C1}';
  }

  // ---------- Tree collapsed-state persistence ----------
  const COLLAPSED_STORAGE_KEY = 'email_v2_collapsed';
  function readCollapsed() {
    try { return JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }
  function writeCollapsed(map) {
    try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(map)); } catch {}
  }
  function isCollapsed(key) { return !!readCollapsed()[key]; }
  function toggleCollapsedKey(key) {
    const map = readCollapsed();
    if (map[key]) delete map[key]; else map[key] = true;
    writeCollapsed(map);
    return !!map[key];
  }

  function renderTree(accounts) {
    if (!tree()) return;
    const html = accounts.map(a => renderAccountBlock(a)).join('');
    tree().innerHTML = `<div class="email-v2-tree-scroll">${html || '<div class="empty-state">Keine Konten</div>'}</div>`;
  }

  function renderAccountBlock(a) {
    const accKey = `acc:${a.slug}`;
    const collapsed = isCollapsed(accKey) ? 'collapsed' : '';
    const foldersHTML = (a.folders || []).map(f => renderFolderNode(a.slug, f, 0)).join('')
      || '<div class="email-v2-tree-empty">Noch nicht synchronisiert</div>';
    const err = a.last_error
      ? `<div class="email-v2-sync-error" title="${esc(a.last_error)}">\u26A0\uFE0F Sync-Fehler</div>`
      : '';
    const spin = state.syncingAccounts.has(a.slug) ? 'spinning' : '';
    const lastSync = a.last_sync_at ? `seit ${fmtDate(a.last_sync_at)}` : 'nie synchronisiert';
    return `
      <div class="email-v2-account ${collapsed}" data-slug="${esc(a.slug)}" data-key="${esc(accKey)}">
        <div class="email-v2-account-header" data-action="toggle-account">
          <span class="email-v2-caret">\u25BE</span>
          <span class="email-v2-account-dot" style="background:${esc(a.color)}"></span>
          <span class="email-v2-account-name">${esc(a.display_name)}</span>
          <span class="email-v2-account-email">${esc(a.email)}</span>
          <button class="email-v2-account-sync ${spin}" title="Synchronisieren (${lastSync})" data-sync="${esc(a.slug)}" data-nocollapse>\u21BB</button>
        </div>
        ${err}
        <div class="email-v2-account-folders">${foldersHTML}</div>
      </div>`;
  }

  function renderFolderNode(slug, f, depth) {
    const key = `fld:${slug}:${f.id}`;
    const hasKids = (f.children && f.children.length > 0);
    const collapsed = hasKids && isCollapsed(key) ? 'collapsed' : '';
    const active = (state.selectedFolderId === f.id) ? 'active' : '';
    const countCls = f.unread_count > 0 ? 'unread' : '';
    const countTxt = f.unread_count > 0 ? String(f.unread_count)
                   : (f.total_count > 0 ? String(f.total_count) : '');
    const caretHTML = hasKids
      ? `<span class="email-v2-caret" data-action="toggle-folder" data-key="${esc(key)}" data-nocollapse>\u25BE</span>`
      : `<span class="email-v2-caret placeholder"></span>`;
    const childrenHTML = hasKids
      ? `<div class="email-v2-folder-children">${f.children.map(c => renderFolderNode(slug, c, depth + 1)).join('')}</div>`
      : '';
    return `
      <div class="email-v2-folder-node ${collapsed}" data-depth="${depth}">
        <div class="email-v2-folder ${active}" data-folder-id="${f.id}" style="padding-left:${8 + depth * 14}px">
          ${caretHTML}
          <span class="email-v2-folder-icon">${folderIcon(f.kind)}</span>
          <span class="email-v2-folder-name" title="${esc(f.path)}">${esc(f.display_name)}</span>
          <span class="email-v2-folder-count ${countCls}">${esc(countTxt)}</span>
        </div>
        ${childrenHTML}
      </div>`;
  }

  // Delegated click handler on the tree — one place, covers all nesting levels.
  function onTreeClick(ev) {
    // Sync button: fire sync, stop event
    const syncBtn = ev.target.closest('[data-sync]');
    if (syncBtn) {
      ev.stopPropagation();
      ev.preventDefault();
      triggerSync(syncBtn.dataset.sync);
      return;
    }
    // Caret toggle for a folder (has children)
    const folderCaret = ev.target.closest('.email-v2-caret[data-action="toggle-folder"]');
    if (folderCaret) {
      ev.stopPropagation();
      ev.preventDefault();
      const node = folderCaret.closest('.email-v2-folder-node');
      const collapsed = toggleCollapsedKey(folderCaret.dataset.key);
      node?.classList.toggle('collapsed', collapsed);
      return;
    }
    // Account header toggle (anywhere on the header that's not a nocollapse child)
    const accHeader = ev.target.closest('.email-v2-account-header');
    if (accHeader && !ev.target.closest('[data-nocollapse]')) {
      const acc = accHeader.closest('.email-v2-account');
      if (!acc) return;
      const collapsed = toggleCollapsedKey(acc.dataset.key);
      acc.classList.toggle('collapsed', collapsed);
      return;
    }
    // Folder row click → select (unless clicked on a caret/sync)
    const folderRow = ev.target.closest('[data-folder-id]');
    if (folderRow && !ev.target.closest('.email-v2-caret') && !ev.target.closest('[data-nocollapse]')) {
      selectFolder(parseInt(folderRow.dataset.folderId, 10));
    }
  }

  // ---------- Messages list ----------
  async function selectFolder(folderId) {
    state.selectedFolderId = folderId;
    state.selectedMessageId = null;
    // update active highlight
    tree().querySelectorAll('.email-v2-folder.active').forEach(el => el.classList.remove('active'));
    tree().querySelector(`[data-folder-id="${folderId}"]`)?.classList.add('active');

    listBody().innerHTML = '<div class="empty-state">Lade\u2026</div>';
    listTitle().textContent = '\u2026';
    detail().innerHTML = '<div class="empty-state">Wähle eine Mail</div>';

    try {
      const data = await api(`/api/email/v2/folders/${folderId}/messages?limit=100`);
      state.messagesCache.set(folderId, data.messages);
      listTitle().textContent = `${data.folder.display_name} (${data.messages.length})`;
      renderMessageList(data.messages);
    } catch (e) {
      listBody().innerHTML = `<div class="empty-state">Fehler: ${esc(e.message)}</div>`;
    }
  }

  function renderMessageList(messages) {
    if (!messages.length) {
      listBody().innerHTML = '<div class="empty-state">Keine Mails in diesem Ordner</div>';
      return;
    }
    const html = messages.map(m => {
      const unread = m.is_read ? '' : 'unread';
      const active = (state.selectedMessageId === m.id) ? 'active' : '';
      const from = m.from_name || m.from_addr || '(unbekannt)';
      const subject = m.subject || '(kein Betreff)';
      const date = fmtDate(m.date);
      const attach = m.has_attachments ? '\u{1F4CE}' : '';
      return `
        <div class="email-v2-msg-item ${unread} ${active}" data-message-id="${m.id}">
          <div class="email-v2-msg-unread-dot"></div>
          <div class="email-v2-msg-body">
            <div class="email-v2-msg-row">
              <div class="email-v2-msg-from" title="${esc(m.from_addr || '')}">${esc(from)}</div>
              <div class="email-v2-msg-date">${esc(date)}</div>
            </div>
            <div class="email-v2-msg-subject">${esc(subject)}</div>
            <div class="email-v2-msg-preview">${esc(m.preview || '')}</div>
            ${attach ? `<div class="email-v2-msg-meta"><span class="email-v2-msg-attach">${attach} Anhang</span></div>` : ''}
          </div>
        </div>`;
    }).join('');
    listBody().innerHTML = html;
    listBody().querySelectorAll('[data-message-id]').forEach(el => {
      el.addEventListener('click', () => selectMessage(parseInt(el.dataset.messageId, 10)));
    });
  }

  // ---------- Message detail ----------
  async function selectMessage(messageId) {
    state.selectedMessageId = messageId;
    listBody().querySelectorAll('.email-v2-msg-item.active').forEach(el => el.classList.remove('active'));
    listBody().querySelector(`[data-message-id="${messageId}"]`)?.classList.add('active');
    detail().innerHTML = '<div class="empty-state">Lade Thread\u2026</div>';

    try {
      const data = await api(`/api/email/v2/messages/${messageId}/thread`);
      const thread = data.thread || [];
      if (!thread.length) {
        detail().innerHTML = '<div class="empty-state">Mail nicht gefunden</div>';
        return;
      }
      renderThreadView(thread, messageId);
      // Mark target as read
      const target = thread.find(m => m.id === messageId) || thread[thread.length - 1];
      if (target && !target.is_read) {
        api(`/api/email/v2/messages/${target.id}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_read: true })
        }).catch(() => {});
        listBody().querySelector(`[data-message-id="${target.id}"]`)?.classList.remove('unread');
      }
    } catch (e) {
      detail().innerHTML = `<div class="empty-state">Fehler: ${esc(e.message)}</div>`;
    }
  }

  function renderThreadView(thread, targetId) {
    // Always reply to the latest message in the thread (or the one clicked).
    const target = thread.find(m => m.id === targetId) || thread[thread.length - 1];
    const subject = target.subject || thread[0]?.subject || '(kein Betreff)';

    // Sort oldest first — newest on top would hide earlier context.
    // Users scroll down to see the latest and the reply-chat is sticky on top,
    // so context flows naturally.
    const sorted = [...thread].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const cards = sorted.map(m => renderThreadCard(m, m.id === target.id, sorted.length === 1)).join('');
    const threadCountBadge = sorted.length > 1
      ? `<span class="email-v2-thread-count">${sorted.length} Nachrichten</span>`
      : '';

    detail().innerHTML = `
      <div class="email-v2-detail-top">
        <div class="email-v2-detail-subject-row">
          <div class="email-v2-detail-subject">${esc(subject)}</div>
          ${threadCountBadge}
        </div>
        <div class="email-v2-detail-toolbar">
          <button class="primary" data-action="reply-chat">\u{1F4AC} Mit Jarvis</button>
          ${sorted.length > 1 ? `
            <button data-action="collapse-all" title="Alle einklappen">\u2212</button>
            <button data-action="expand-all" title="Alle ausklappen">+</button>
          ` : ''}
          ${target.web_link ? '<button data-action="open-outlook" title="In Outlook Web öffnen">\u2197\uFE0E</button>' : ''}
        </div>
      </div>
      <div class="email-v2-reply-chat collapsed" id="email-reply-chat" data-message-id="${target.id}">
        <div class="email-v2-reply-chat-header" data-action="toggle-chat">
          <span>\u{2728} Jarvis-Antwort — Vorgabe eingeben</span>
          <span class="email-v2-reply-chat-caret">\u25BC</span>
        </div>
        <div class="email-v2-reply-chat-input">
          <div class="reply-chat-input-col">
            <div class="reply-chat-attachments" id="reply-chat-attachments-${target.id}"></div>
            <textarea id="reply-chat-input-${target.id}" rows="2" placeholder="Enter = Vorschläge holen · Shift+Enter = neue Zeile · \u{1F3A4} für Diktieren · \u{1F4CE} für Datei"></textarea>
          </div>
          <div class="reply-chat-input-buttons">
            <button class="reply-chat-icon-btn" data-action="attach" data-mid="${target.id}" title="Datei anhängen">\u{1F4CE}</button>
            <button class="reply-chat-icon-btn" data-action="mic" data-mid="${target.id}" title="Diktat (de-DE)">\u{1F3A4}</button>
            <input type="file" id="reply-chat-file-${target.id}" multiple style="display:none">
            <button data-action="suggest" data-mid="${target.id}">\u2728</button>
          </div>
        </div>
        <div class="email-v2-reply-chat-body">
          <div class="reply-chat-messages" id="reply-chat-messages-${target.id}"></div>
        </div>
      </div>
      <div class="email-v2-thread">${cards}</div>`;

    // Attach toolbar handlers
    detail().querySelector('[data-action="open-outlook"]')?.addEventListener('click', () => {
      if (target.web_link) window.open(target.web_link, '_blank');
    });
    detail().querySelector('[data-action="reply-chat"]')?.addEventListener('click', () => {
      const el = document.getElementById('email-reply-chat');
      el?.classList.remove('collapsed');
      document.getElementById(`reply-chat-input-${target.id}`)?.focus();
    });
    detail().querySelector('[data-action="collapse-all"]')?.addEventListener('click', () => {
      detail().querySelectorAll('.email-v2-thread-card').forEach(c => c.classList.add('collapsed'));
    });
    detail().querySelector('[data-action="expand-all"]')?.addEventListener('click', () => {
      detail().querySelectorAll('.email-v2-thread-card').forEach(c => c.classList.remove('collapsed'));
    });
    detail().querySelector('[data-action="toggle-chat"]')?.addEventListener('click', () => {
      document.getElementById('email-reply-chat')?.classList.toggle('collapsed');
    });
    detail().querySelector('[data-action="suggest"]')?.addEventListener('click', (e) => {
      const mid = parseInt(e.currentTarget.dataset.mid, 10);
      suggestReply(mid);
    });
    // Thread-card interactions via event delegation — one listener, robust to re-renders.
    detail().addEventListener('click', (ev) => {
      const toggleBtn = ev.target.closest('.email-v2-thread-card-toggle-details');
      if (toggleBtn) {
        ev.stopPropagation();
        ev.preventDefault();
        toggleBtn.closest('.email-v2-thread-card')?.classList.toggle('show-details');
        return;
      }
      const head = ev.target.closest('.email-v2-thread-card-head');
      if (head && !ev.target.closest('[data-nocollapse]')) {
        head.parentElement.classList.toggle('collapsed');
      }
    });
    // Enter-to-send in the textarea (Shift+Enter = newline)
    const ta = document.getElementById(`reply-chat-input-${target.id}`);
    if (ta) {
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          suggestReply(target.id);
        }
      });
    }
    // Mic dictation
    detail().querySelector('[data-action="mic"]')?.addEventListener('click', (ev) => {
      const mid = parseInt(ev.currentTarget.dataset.mid, 10);
      toggleMic(mid, ev.currentTarget);
    });
    // File picker
    detail().querySelector('[data-action="attach"]')?.addEventListener('click', (ev) => {
      const mid = parseInt(ev.currentTarget.dataset.mid, 10);
      document.getElementById(`reply-chat-file-${mid}`)?.click();
    });
    detail().querySelector(`#reply-chat-file-${target.id}`)?.addEventListener('change', (ev) => {
      uploadAttachments(target.id, ev.currentTarget.files);
      ev.currentTarget.value = '';  // reset so same file can be re-picked
    });
  }

  function renderThreadCard(m, isTarget, singleInThread) {
    const from = m.from_name || m.from_addr || '(unbekannt)';
    const toArr = (m.to || []).map(x => x.name ? `${x.name} <${x.addr}>` : x.addr).filter(Boolean);
    const ccArr = (m.cc || []).map(x => x.name ? `${x.name} <${x.addr}>` : x.addr).filter(Boolean);
    const toShort = toArr.length > 2
      ? `${toArr[0].split('<')[0].trim()} +${toArr.length - 1}`
      : toArr.map(a => a.split('<')[0].trim() || a).join(', ');
    const preview = (m.preview || '').slice(0, 140);
    const body = renderBody(m);
    const collapsedCls = (isTarget || singleInThread) ? '' : 'collapsed';
    const attach = m.has_attachments ? '\u{1F4CE}' : '';

    const detailsRows = [];
    if (m.from_addr) detailsRows.push(`<div><strong>Von:</strong> ${esc(m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr)}</div>`);
    if (toArr.length) detailsRows.push(`<div><strong>An:</strong> ${esc(toArr.join(', '))}</div>`);
    if (ccArr.length) detailsRows.push(`<div><strong>CC:</strong> ${esc(ccArr.join(', '))}</div>`);
    detailsRows.push(`<div><strong>Datum:</strong> ${esc(fmtDateLong(m.date))}</div>`);

    return `
      <article class="email-v2-thread-card ${collapsedCls}" data-msg-id="${m.id}">
        <header class="email-v2-thread-card-head">
          <div class="email-v2-thread-card-avatar">${esc((from || '?').charAt(0).toUpperCase())}</div>
          <div class="email-v2-thread-card-meta">
            <div class="email-v2-thread-card-row">
              <span class="email-v2-thread-card-from" title="${esc(m.from_addr || '')}">${esc(from)}</span>
              <span class="email-v2-thread-card-date">${esc(fmtDate(m.date))}</span>
            </div>
            <div class="email-v2-thread-card-to-short">
              an ${esc(toShort || '(unbekannt)')}${ccArr.length ? `, CC ${ccArr.length}` : ''}
              <button class="email-v2-thread-card-toggle-details" data-nocollapse title="Alle Adressen ein/ausblenden">\u25BE</button>
            </div>
            <div class="email-v2-thread-card-details" data-nocollapse>
              ${detailsRows.join('')}
            </div>
            <div class="email-v2-thread-card-preview">${esc(preview)}</div>
          </div>
          <div class="email-v2-thread-card-chevron">${attach} \u25BE</div>
        </header>
        <div class="email-v2-thread-card-body-wrap">
          ${body}
        </div>
      </article>`;
  }

  // Per-message reply chat history (ephemeral, cleared on reload)
  const replyHistories = new Map();    // messageId -> [{role, content}]
  const replyAttachments = new Map();  // messageId -> [{path, filename, size}]
  const micState = { recognition: null, activeMid: null, btn: null };

  // ---------- Voice (webkitSpeechRecognition, de-DE) ----------
  // Chrome/Edge exposes SpeechRecognition only on secure origins (HTTPS or localhost).
  // Over plain http://192.168.… it silently refuses. We detect that and give
  // a clear message instead of leaving Robin staring at a dead button.
  function micReport(mid, text) {
    const box = document.getElementById(`reply-chat-messages-${mid}`);
    if (box) appendChatMsg(box, 'jarvis', text);
    else console.warn('[mic]', text);
  }
  function isSecureForMic() {
    if (window.isSecureContext) return true;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return true;
    return false;
  }
  async function ensureMicPermission() {
    // Trigger the browser permission prompt before SR.start().
    // navigator.mediaDevices.getUserMedia is the reliable path.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      return true;
    } catch (e) {
      return false;
    }
  }

  async function toggleMic(mid, btn) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micReport(mid, 'Spracherkennung braucht Chrome oder Edge (Firefox/Safari unterstützen das nicht).');
      return;
    }
    if (!isSecureForMic()) {
      micReport(mid, `Mic braucht HTTPS oder localhost — du bist auf "${location.origin}". Öffne MC über http://localhost:8090 oder https://mc.robinmandel.de, dann geht's.`);
      return;
    }
    if (micState.activeMid === mid && micState.recognition) {
      try { micState.recognition.stop(); } catch {}
      return;
    }
    if (micState.recognition) {
      try { micState.recognition.stop(); } catch {}
    }
    // Pause the global wake-word listener — browser allows only one active SR per page.
    if (window.MC?.voiceListener?.pause) {
      try { window.MC.voiceListener.pause(); } catch {}
    }

    // Ensure we actually have mic access. If permission was previously denied,
    // start() will fire error="not-allowed" — we warn the user explicitly.
    const permOk = await ensureMicPermission();
    if (!permOk) {
      micReport(mid, 'Mikrofon-Zugriff wurde verweigert. Klick aufs Schloss-Symbol in der Adressleiste → Mikrofon erlauben, dann nochmal drücken.');
      return;
    }

    const rec = new SR();
    rec.lang = 'de-DE';
    rec.interimResults = true;
    rec.continuous = true;
    let finalText = '';
    const ta = document.getElementById(`reply-chat-input-${mid}`);
    const startValue = ta ? ta.value : '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      if (ta) {
        const joiner = startValue && !startValue.endsWith(' ') ? ' ' : '';
        ta.value = startValue + joiner + finalText + interim;
      }
    };
    rec.onend = () => {
      btn.classList.remove('recording');
      btn.textContent = '\u{1F3A4}';
      micState.recognition = null;
      micState.activeMid = null;
      micState.btn = null;
      if (ta) ta.focus();
      // Resume wake-word listener
      if (window.MC?.voiceListener?.resume) {
        try { window.MC.voiceListener.resume(); } catch {}
      }
    };
    rec.onerror = (e) => {
      console.warn('[mic] SpeechRecognition error:', e.error, e);
      const msg = {
        'not-allowed': 'Mikrofon-Berechtigung fehlt. Schloss-Symbol in Adressleiste → Mic erlauben.',
        'service-not-allowed': 'Spracherkennungs-Service blockiert (Browser-Setting oder Gruppenrichtlinie).',
        'no-speech': 'Keine Sprache erkannt.',
        'audio-capture': 'Kein Mikrofon gefunden oder belegt.',
        'network': 'Netzwerk-Fehler bei der Spracherkennung.',
        'aborted': null,  // silent when we intentionally stop
      }[e.error] || `Fehler: ${e.error}`;
      if (msg) micReport(mid, msg);
    };
    try {
      rec.start();
      micState.recognition = rec;
      micState.activeMid = mid;
      micState.btn = btn;
      btn.classList.add('recording');
      btn.textContent = '\u{23F9}';
      micReport(mid, '\u{1F534} Aufnahme läuft — sprich los. Nochmal klicken zum Stoppen.');
    } catch (e) {
      micReport(mid, `Konnte Mic nicht starten: ${e.message}`);
    }
  }

  // ---------- Attachments upload ----------
  async function uploadAttachments(mid, fileList) {
    if (!fileList || !fileList.length) return;
    const box = document.getElementById(`reply-chat-messages-${mid}`);
    const status = appendChatMsg(box, 'jarvis', `\u{23F3} Lade ${fileList.length} Datei(en) hoch\u2026`);
    const fd = new FormData();
    for (const f of fileList) fd.append('file', f, f.name);
    try {
      const res = await fetch('/api/email/v2/attachments', { method: 'POST', body: fd });
      const data = await res.json();
      status.remove();
      if (!data.ok) {
        appendChatMsg(box, 'jarvis', `Upload-Fehler: ${data.error || 'unbekannt'}`);
        return;
      }
      const cur = replyAttachments.get(mid) || [];
      for (const a of (data.attachments || [])) cur.push(a);
      replyAttachments.set(mid, cur);
      renderAttachmentChips(mid);
    } catch (e) {
      status.remove();
      appendChatMsg(box, 'jarvis', `Upload-Fehler: ${e.message}`);
    }
  }

  function renderAttachmentChips(mid) {
    const box = document.getElementById(`reply-chat-attachments-${mid}`);
    if (!box) return;
    const items = replyAttachments.get(mid) || [];
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = items.map((a, i) => `
      <span class="reply-chat-attach-chip" title="${esc(a.path)}">
        \u{1F4CE} ${esc(a.filename)}
        <span class="reply-chat-attach-size">${fmtSize(a.size)}</span>
        <button class="reply-chat-attach-remove" data-idx="${i}" title="Entfernen">\u00D7</button>
      </span>
    `).join('');
    box.querySelectorAll('.reply-chat-attach-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const cur = replyAttachments.get(mid) || [];
        cur.splice(idx, 1);
        replyAttachments.set(mid, cur);
        renderAttachmentChips(mid);
      });
    });
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024*1024) return `${(bytes/1024).toFixed(0)} KB`;
    return `${(bytes/1024/1024).toFixed(1)} MB`;
  }

  async function suggestReply(messageId) {
    const input = document.getElementById(`reply-chat-input-${messageId}`);
    const msgsBox = document.getElementById(`reply-chat-messages-${messageId}`);
    if (!input || !msgsBox) return;
    const userPrompt = (input.value || '').trim();
    if (!userPrompt) {
      input.focus();
      return;
    }
    const history = replyHistories.get(messageId) || [];
    history.push({ role: 'user', content: userPrompt });
    replyHistories.set(messageId, history);
    appendChatMsg(msgsBox, 'user', userPrompt);
    input.value = '';
    const pending = appendChatMsg(msgsBox, 'jarvis', '\u{2728} Denkt nach\u2026');

    try {
      const res = await fetch(`/api/email/v2/messages/${messageId}/suggest-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_prompt: userPrompt, history: history.slice(0, -1) }),
      });
      const data = await res.json();
      pending.remove();
      if (!data.ok) {
        appendChatMsg(msgsBox, 'jarvis', `Fehler: ${data.error || 'unbekannt'}`);
        return;
      }
      if (data.type === 'chat') {
        // Modus B: freie Antwort — als Chat-Bubble rendern
        const text = (data.text || '').trim() || '(leere Antwort)';
        history.push({ role: 'jarvis', content: text });
        appendChatMsg(msgsBox, 'jarvis', text);
      } else {
        // Modus A: Draft-Vorschläge als Karten
        const suggestions = data.suggestions || [];
        const summary = suggestions.map((s, i) => `Variante ${i+1} (${s.label})`).join(', ');
        history.push({ role: 'jarvis', content: summary || 'Vorschläge' });
        renderSuggestions(msgsBox, messageId, suggestions, data.parse_note);
      }
    } catch (e) {
      pending.remove();
      appendChatMsg(msgsBox, 'jarvis', `Fehler: ${e.message}`);
    }
  }

  function appendChatMsg(box, role, text) {
    const el = document.createElement('div');
    el.className = `reply-chat-msg reply-chat-${role}`;
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function renderSuggestions(box, messageId, suggestions, parseNote) {
    if (!suggestions.length) {
      appendChatMsg(box, 'jarvis', 'Keine Vorschläge zurückgekommen.');
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'reply-chat-suggestions';
    if (parseNote) {
      const note = document.createElement('div');
      note.className = 'reply-chat-note';
      note.textContent = parseNote;
      wrap.appendChild(note);
    }
    suggestions.forEach((s, idx) => {
      const card = document.createElement('div');
      card.className = 'reply-chat-suggestion';
      card.innerHTML = `
        <div class="reply-chat-suggestion-head">
          <span class="reply-chat-suggestion-label">\u2728 ${esc(s.label)}</span>
          <button class="reply-chat-suggestion-pick">In Outlook öffnen</button>
        </div>
        <div class="reply-chat-suggestion-subject"><strong>Betreff:</strong> ${esc(s.subject)}</div>
        <div class="reply-chat-suggestion-body"></div>`;
      card.querySelector('.reply-chat-suggestion-body').textContent = s.body;
      card.querySelector('.reply-chat-suggestion-pick').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Öffne\u2026';
        try {
          const attachObjs = replyAttachments.get(messageId) || [];
          const res = await fetch(`/api/email/v2/messages/${messageId}/open-draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subject: s.subject,
              body: s.body,
              attachments: attachObjs.map(a => a.path),
            }),
          });
          const data = await res.json();
          if (data.ok) {
            btn.textContent = '\u2713 Geöffnet';
            btn.style.background = '#16a34a';
            btn.style.borderColor = '#16a34a';
            btn.style.color = '#fff';
            appendChatMsg(box, 'jarvis', data.note || 'Draft ist in Outlook offen — Attachments drantun, Senden drücken.');
          } else {
            btn.disabled = false;
            btn.textContent = orig;
            appendChatMsg(box, 'jarvis', `Fehler beim Öffnen: ${data.error || 'unbekannt'}`);
          }
        } catch (e) {
          btn.disabled = false;
          btn.textContent = orig;
          appendChatMsg(box, 'jarvis', `Netzwerk-Fehler: ${e.message}`);
        }
      });
      wrap.appendChild(card);
    });
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function renderBody(m) {
    if (m.body_html) {
      // Very minimal HTML rendering. Outgoing mail clients do much more sophisticated
      // sanitation. For now: strip scripts/iframes and inject into a scoped container.
      const cleaned = sanitizeHtml(m.body_html);
      return `<div class="email-v2-detail-body html">${cleaned}</div>`;
    }
    if (m.body_text) {
      return `<div class="email-v2-detail-body"><pre>${esc(m.body_text)}</pre></div>`;
    }
    return `<div class="email-v2-detail-body"><div class="empty-state">Kein Inhalt geladen (nur Metadaten). Phase 2 fetcht Body on-demand.</div></div>`;
  }

  function sanitizeHtml(html) {
    // Strip script / iframe / style / onclick-style event handlers.
    // Using DOMParser is safer than regex.
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, iframe, object, embed, link[rel="import"]').forEach(n => n.remove());
      doc.querySelectorAll('*').forEach(el => {
        for (const attr of [...el.attributes]) {
          if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
          if (attr.name === 'src' && /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
          if (attr.name === 'href' && /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        }
      });
      return doc.body.innerHTML;
    } catch {
      return esc(html);
    }
  }

  // ---------- Sync ----------
  async function triggerSync(slug) {
    if (state.syncingAccounts.has(slug)) return;
    state.syncingAccounts.add(slug);
    setSyncStatus(`Sync ${slug}\u2026`);
    try {
      await api(`/api/email/v2/sync?account=${encodeURIComponent(slug)}`, { method: 'POST' });
      // Poll for completion
      pollSyncStatus(slug);
    } catch (e) {
      state.syncingAccounts.delete(slug);
      setSyncStatus(`Sync-Fehler ${slug}: ${e.message}`);
    }
  }

  async function pollSyncStatus(slug) {
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      await sleep(2000);
      try {
        const data = await api('/api/email/v2/accounts');
        const acc = data.accounts.find(a => a.slug === slug);
        if (acc && !acc.sync_running) {
          state.syncingAccounts.delete(slug);
          state.accounts = data.accounts;
          renderTree(data.accounts);
          if (acc.last_error) {
            setSyncStatus(`${slug}: Fehler — ${acc.last_error.slice(0, 80)}`);
          } else {
            setSyncStatus(`${slug} synchronisiert (${fmtDate(acc.last_sync_at)})`);
            setTimeout(() => setSyncStatus(''), 4000);
          }
          // If the open folder belongs to this account, refresh its list
          if (state.selectedFolderId) {
            const openFolder = findFolderInAccount(acc, state.selectedFolderId);
            if (openFolder) selectFolder(state.selectedFolderId);
          }
          return;
        }
      } catch { /* keep polling */ }
    }
    state.syncingAccounts.delete(slug);
    setSyncStatus(`${slug} Sync dauert länger als 5 min?`);
  }

  function findFolderInAccount(account, folderId) {
    const stack = [...(account.folders || [])];
    while (stack.length) {
      const n = stack.pop();
      if (n.id === folderId) return n;
      if (n.children) stack.push(...n.children);
    }
    return null;
  }

  async function refreshAll() {
    setSyncStatus('Sync alle Konten\u2026');
    const slugs = state.accounts.map(a => a.slug);
    for (const s of slugs) state.syncingAccounts.add(s);
    renderTree(state.accounts);
    try {
      await api('/api/email/v2/sync', { method: 'POST' });
      for (const s of slugs) pollSyncStatus(s);
    } catch (e) {
      setSyncStatus(`Fehler: ${e.message}`);
    }
  }

  // ---------- Utilities ----------
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso.slice(0, 16);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toTimeString().slice(0, 5);
    const sameYear = d.getFullYear() === now.getFullYear();
    if (sameYear) return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  function fmtDateLong(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function setSyncStatus(txt) { if (syncStatus()) syncStatus().textContent = txt; }

  // ---------- Bootstrap ----------
  async function _loadEmails() {
    try {
      const data = await api('/api/email/v2/accounts');
      state.accounts = data.accounts;
      renderTree(data.accounts);
      // Auto-select first Inbox on initial load so Robin sees mails immediately
      // instead of empty panels. Respects any previously selected folder.
      if (!state.selectedFolderId) {
        const firstFolder = pickFirstReadableFolder(data.accounts);
        if (firstFolder) selectFolder(firstFolder.id);
      }
    } catch (e) {
      tree().innerHTML = `<div class="empty-state">Fehler: ${esc(e.message)}</div>`;
    }
  }

  function pickFirstReadableFolder(accounts) {
    // Preference: first inbox > first non-spam/trash folder > any folder
    const walk = (nodes, kind) => {
      for (const n of (nodes || [])) {
        if (n.kind === kind) return n;
        const r = walk(n.children, kind);
        if (r) return r;
      }
      return null;
    };
    for (const a of (accounts || [])) {
      const inbox = walk(a.folders, 'inbox');
      if (inbox) return inbox;
    }
    for (const a of (accounts || [])) {
      const walkFirst = (nodes) => {
        for (const n of (nodes || [])) {
          if (n.kind !== 'spam' && n.kind !== 'trash' && (n.total_count || 0) > 0) return n;
          const r = walkFirst(n.children);
          if (r) return r;
        }
        return null;
      };
      const first = walkFirst(a.folders);
      if (first) return first;
    }
    return null;
  }

  document.getElementById('btn-email-sync-all')?.addEventListener('click', refreshAll);
  // Tree uses a single delegated handler — attached once, survives re-renders.
  tree()?.addEventListener('click', onTreeClick);

  // Expose both for app.js's `loadEmails` bare-identifier lookup and window.loadEmails
  loadEmails = _loadEmails;
  window.loadEmails = _loadEmails;
})();
