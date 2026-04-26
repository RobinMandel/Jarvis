window.ImageLab = (function() {
  const STORAGE_KEY = 'mc_image_lab_gallery';
  const STYLE_HINTS = {
    medical: 'Clean medical textbook style, accurate anatomy, neutral background, readable labels, high clarity.',
    diagram: 'Crisp infographic diagram, structured layout, clear visual hierarchy, readable text, no clutter.',
    product: 'Premium product mockup, clean studio lighting, realistic material detail, sharp composition.',
    cinematic: 'Cinematic lighting, strong composition, realistic depth, polished high-end look.',
  };

  let initialized = false;
  let providersLoaded = false;
  let providers = [];
  let gallery = [];
  let activeCodexJob = null;
  let codexPollTimer = null;

  const $ = (id) => document.getElementById(id);

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function loadGallery() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      gallery = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(gallery)) gallery = [];
    } catch (_) {
      gallery = [];
    }
  }

  function saveGallery() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(gallery.slice(0, 24)));
    } catch (_) {}
  }

  function setStatus(message, kind) {
    const el = $('image-lab-status');
    if (!el) return;
    el.classList.remove('error', 'success');
    if (kind === 'ok' || kind === 'success') el.classList.add('success');
    else if (kind === 'error') el.classList.add('error');
    el.textContent = message || '';
  }

  function setProgressBar(visible) {
    const bar = $('nbs-progress-bar');
    if (!bar) return;
    if (visible) bar.classList.add('visible');
    else bar.classList.remove('visible');
  }

  function setGenerateLoading(loading) {
    const btn = $('image-lab-generate');
    if (!btn) return;
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  function updateProviderChip() {
    const chip = $('image-lab-provider-chip');
    if (!chip) return;
    const selected = $('image-lab-provider')?.value || '';
    const prov = providers.find((p) => p.name === selected);
    if (prov && prov.configured) {
      chip.textContent = prov.label || selected;
    } else {
      chip.textContent = 'Kein Provider aktiv';
    }
  }

  function populateModelDropdown() {
    const providerSel = $('image-lab-provider');
    const modelWrap = $('image-lab-model-wrap');
    const modelSel = $('image-lab-model');
    const modelToggle = $('nbs-model-toggle');
    const modelDesc = $('nbs-model-desc');
    const costWidget = $('image-lab-cost-widget');
    if (!providerSel || !modelWrap || !modelSel) return;
    const provName = providerSel.value;
    const prov = providers.find((p) => p.name === provName);
    if (!prov || !Array.isArray(prov.models) || !prov.models.length) {
      modelWrap.style.display = 'none';
      if (costWidget) costWidget.style.display = 'none';
      return;
    }
    modelWrap.style.display = '';
    if (costWidget) costWidget.style.display = 'flex';
    const current = modelSel.value;
    const preferred = current && prov.models.find((m) => m.id === current)
      ? current
      : (prov.default_model || prov.models[0].id);
    // Hidden select — für Backend-Kompatibilität
    modelSel.innerHTML = prov.models.map((m) =>
      `<option value="${esc(m.id)}">${esc(m.label)}</option>`
    ).join('');
    modelSel.value = preferred;
    // Segmented toggle — wie der Resolution-Toggle im alten Studio
    if (modelToggle) {
      modelToggle.innerHTML = prov.models.map((m) => {
        const active = m.id === preferred ? ' active' : '';
        const shortLabel = (m.label || m.id).replace('Nano Banana', 'NB');
        return `<button type="button" class="nbs-res-btn${active}" data-model-id="${esc(m.id)}" data-price="${Number(m.usd_per_image || 0).toFixed(3)}" title="${esc(m.description || '')}">${esc(shortLabel)}</button>`;
      }).join('');
      modelToggle.querySelectorAll('.nbs-res-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-model-id');
          if (!id) return;
          modelSel.value = id;
          modelToggle.querySelectorAll('.nbs-res-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          updateModelDescription();
          updateCostNextEstimate();
        });
      });
    }
    updateModelDescription();
    updateCostNextEstimate();
  }

  function updateModelDescription() {
    const descEl = $('nbs-model-desc');
    const modelSel = $('image-lab-model');
    const providerSel = $('image-lab-provider');
    if (!descEl || !modelSel || !providerSel) return;
    const prov = providers.find((p) => p.name === providerSel.value);
    if (!prov || !Array.isArray(prov.models)) { descEl.textContent = ''; return; }
    const m = prov.models.find((x) => x.id === modelSel.value);
    if (m) descEl.textContent = `${m.description || ''} — $${Number(m.usd_per_image).toFixed(3)}/Bild`;
  }

  function updateCostNextEstimate() {
    const provName = $('image-lab-provider')?.value;
    const prov = providers.find((p) => p.name === provName);
    const modelId = $('image-lab-model')?.value;
    const nextEl = $('image-lab-cost-next');
    if (!prov || !Array.isArray(prov.models) || !modelId || !nextEl) return;
    const m = prov.models.find((x) => x.id === modelId);
    if (m) nextEl.textContent = `$${Number(m.usd_per_image).toFixed(3)}`;
  }

  async function refreshCostWidget() {
    try {
      const [monthRes, todayRes] = await Promise.all([
        fetch('/api/image/usage?period=month').then((r) => r.json()),
        fetch('/api/image/usage?period=today').then((r) => r.json()),
      ]);
      const mEl = $('image-lab-cost-month');
      const tEl = $('image-lab-cost-today');
      if (mEl) mEl.textContent = `$${Number(monthRes.total_usd || 0).toFixed(3)} (${monthRes.total_images || 0} Bilder)`;
      if (tEl) tEl.textContent = `$${Number(todayRes.total_usd || 0).toFixed(3)} (${todayRes.total_images || 0} Bilder)`;
    } catch (_) {
      // silent — widget bleibt einfach auf alten werten
    }
  }

  async function loadProviders() {
    if (providersLoaded) return;
    const select = $('image-lab-provider');
    if (!select) return;

    select.innerHTML = '<option>Lade Provider...</option>';
    try {
      const res = await fetch('/api/image/providers');
      const data = await res.json();
      providers = Array.isArray(data.providers) ? data.providers : [];
      providers.push({
        name: 'codex-session',
        label: 'Codex Session Bridge',
        configured: true,
        free_tier: true,
        key_var: '',
      });

      select.innerHTML = providers.map((p) => {
        const cost = p.name === 'codex-session' ? 'manual bridge' : (p.free_tier ? 'free' : 'API-Kosten');
        const state = p.configured ? cost : `nicht konfiguriert (${p.key_var})`;
        const disabled = p.configured ? '' : 'disabled';
        return `<option value="${esc(p.name)}" ${disabled}>${esc(p.label)} - ${esc(state)}</option>`;
      }).join('');

      const freeFirst = $('image-lab-free-first')?.checked !== false;
      const preferred = freeFirst
        ? providers.find((p) => p.name === 'gemini' && p.configured)
        : null;
      const fallback = providers.find((p) => p.configured);
      const chosen = preferred || fallback;
      if (chosen) select.value = chosen.name;

      providersLoaded = true;
      updateProviderChip();
      populateModelDropdown();
      refreshCostWidget();
      if (!chosen) {
        setStatus('Kein Bildprovider ist konfiguriert. Für kostenfrei bevorzugt brauchst du GEMINI_API_KEY oder GOOGLE_API_KEY.', 'warn');
      } else if (chosen.name === 'gemini') {
        setStatus('Bereit. Generierung läuft standardmäßig über Gemini/Nano Banana.', 'ok');
      } else {
        setStatus('Nur kostenpflichtiger OpenAI-Provider ist aktiv. Gemini-Key fehlt.', 'warn');
      }
      select.addEventListener('change', () => {
        updateProviderChip();
        populateModelDropdown();
      });
      $('image-lab-model')?.addEventListener('change', updateCostNextEstimate);
    } catch (err) {
      select.innerHTML = '<option>Provider nicht erreichbar</option>';
      setStatus(`Provider konnten nicht geladen werden: ${err.message}`, 'error');
    }
  }

  function buildPrompt() {
    const prompt = $('image-lab-prompt')?.value.trim() || '';
    const style = $('image-lab-style')?.value || '';
    const hint = STYLE_HINTS[style];
    return hint ? `${prompt}\n\nStyle direction: ${hint}` : prompt;
  }

  function renderCurrent(item) {
    const host = $('image-lab-current');
    if (!host) return;
    if (!item) {
      host.innerHTML = `
        <div class="nbs-empty-state">
          <div class="nbs-empty-icon">🍌</div>
          <div class="nbs-empty-title">Noch keine Bilder</div>
          <div class="nbs-empty-sub">Beschreib deine Vision links und klick auf Generate um das erste Bild zu machen.</div>
        </div>
      `;
      return;
    }
    host.innerHTML = `<img src="${esc(item.url)}" alt="${esc(item.prompt)}" data-lb-src="${esc(item.url)}">`;
    const img = host.querySelector('img');
    if (img) img.addEventListener('click', () => openLightbox(item.url, _galleryItemToMeta(item)));
  }

  function _galleryItemToMeta(item) {
    if (!item) return null;
    return {
      user_prompt: item.prompt || '',
      enhanced_prompt: item.enhanced_prompt || null,
      final_prompt: item.final_prompt || item.prompt || '',
      references_used: item.references_used || [],
      provider: item.provider || '',
      model: item.model || '',
      size: item.size || '',
      created_at: item.createdAt || '',
    };
  }

  function renderGallery() {
    const host = $('image-lab-gallery');
    const meta = $('nbs-gallery-meta');
    const clearBtn = $('image-lab-clear-gallery');
    if (!host) return;
    if (meta) meta.textContent = gallery.length ? `${gallery.length} Bild${gallery.length === 1 ? '' : 'er'}` : 'Noch keine Bilder';
    if (clearBtn) clearBtn.style.display = gallery.length ? '' : 'none';
    if (!gallery.length) {
      host.innerHTML = '';
      renderCurrent(null);
      return;
    }
    host.innerHTML = gallery.map((item, idx) => `
      <div class="nbs-img-card" data-idx="${idx}" title="${esc(item.prompt)}">
        <div class="nbs-img-thumb-wrap">
          <img class="nbs-img-thumb" src="${esc(item.url)}" alt="">
          <div class="nbs-img-overlay">
            <div class="nbs-img-overlay-prompt">${esc(item.prompt)}</div>
          </div>
        </div>
        <div class="nbs-img-footer">
          <div class="nbs-img-footer-model">${esc(item.model || item.provider || '')}</div>
          <div class="nbs-img-timestamp">${esc(formatTimeAgo(item.createdAt))}</div>
        </div>
      </div>
    `).join('');
    host.querySelectorAll('.nbs-img-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = Number(card.getAttribute('data-idx'));
        const item = gallery[idx];
        renderCurrent(item);
        openLightbox(item.url, _galleryItemToMeta(item));
      });
    });
    renderCurrent(gallery[0]);
  }

  function formatTimeAgo(iso) {
    if (!iso) return '';
    const diff = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (diff < 1) return 'gerade';
    if (diff < 60) return `vor ${diff}m`;
    if (diff < 1440) return `vor ${Math.round(diff / 60)}h`;
    return `vor ${Math.round(diff / 1440)}d`;
  }

  function openLightbox(url, meta) {
    const lb = $('nbs-lightbox');
    const img = $('nbs-lightbox-img');
    const info = $('nbs-lightbox-info');
    if (!lb || !img || !url) return;
    img.src = url;
    if (info) info.innerHTML = renderLightboxInfo(meta);
    if (info) {
      info.querySelectorAll('.nbs-lb-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = btn.dataset.text || '';
          navigator.clipboard?.writeText(text);
          btn.textContent = '✓ Kopiert';
          setTimeout(() => { btn.textContent = btn.dataset.label || 'Kopieren'; }, 1400);
        });
      });
    }
    lb.classList.add('open');
  }

  function renderLightboxInfo(meta) {
    if (!meta || (!meta.user_prompt && !meta.prompt && !meta.enhanced_prompt && !meta.final_prompt)) {
      return `<div class="nbs-empty-state" style="padding:30px 10px;">
        <div class="nbs-empty-icon">📝</div>
        <div class="nbs-empty-sub">Keine Prompt-Infos zu diesem Bild gespeichert.</div>
      </div>`;
    }
    const userPrompt = meta.user_prompt || meta.prompt || '';
    const enhanced = meta.enhanced_prompt || null;
    const finalP = meta.final_prompt || enhanced || userPrompt;
    let html = '';
    if (userPrompt) {
      html += `<div class="nbs-lb-prompt-label">Dein Prompt</div>
        <div class="nbs-lb-prompt-text">${esc(userPrompt)}</div>
        <button class="nbs-lb-copy-btn" data-label="Kopieren" data-text="${esc(userPrompt)}">Kopieren</button>`;
    }
    if (enhanced && enhanced !== userPrompt) {
      html += `<div class="nbs-lb-prompt-label">🪄 Enhanced (an Modell geschickt)</div>
        <div class="nbs-lb-prompt-text enhanced">${esc(enhanced)}</div>
        <button class="nbs-lb-copy-btn" data-label="Kopieren" data-text="${esc(enhanced)}">Kopieren</button>`;
    } else if (!enhanced && finalP && finalP === userPrompt) {
      html += `<div class="nbs-lb-prompt-label" style="color:#6b6b8a;">Kein Enhancement (Original verwendet)</div>`;
    }
    const refs = meta.references_used || [];
    if (refs.length) {
      html += `<div class="nbs-lb-prompt-label">👥 Avatar-References verwendet</div><div class="nbs-lb-meta">`;
      for (const r of refs) {
        html += `<div class="nbs-lb-meta-key">${esc(r.name)}</div><div class="nbs-lb-meta-val">${r.files.length} Bilder</div>`;
      }
      html += `</div>`;
    }
    const metaPairs = [
      ['Provider', meta.provider],
      ['Modell', meta.model],
      ['Size', meta.size],
      ['Style', meta.style],
      ['Erstellt', meta.created_at ? new Date(meta.created_at).toLocaleString('de-DE') : null],
    ].filter(([_, v]) => v);
    if (metaPairs.length) {
      html += `<div class="nbs-lb-prompt-label">Meta</div><div class="nbs-lb-meta">`;
      for (const [k, v] of metaPairs) {
        html += `<div class="nbs-lb-meta-key">${esc(k)}</div><div class="nbs-lb-meta-val">${esc(String(v))}</div>`;
      }
      html += `</div>`;
    }
    return html;
  }
  function closeLightbox() {
    const lb = $('nbs-lightbox');
    if (lb) lb.classList.remove('open');
  }

  async function generate() {
    const btn = $('image-lab-generate');
    const prompt = buildPrompt();
    if (!prompt || prompt.length < 3) {
      setStatus('Prompt ist zu kurz.', 'warn');
      $('image-lab-prompt')?.focus();
      return;
    }

    await loadProviders();
    const provider = $('image-lab-provider')?.value || 'gemini';
    const model = $('image-lab-model')?.value || '';
    const size = $('image-lab-size')?.value || '1024x1024';
    const postToChat = $('image-lab-post-chat')?.checked;
    const sessionId = postToChat ? (window.MC?.chat?.activeSession || '') : '';

    if (provider === 'codex-session') {
      await createCodexJob(prompt, size);
      return;
    }

    setGenerateLoading(true);
    setProgressBar(true);
    setStatus(`Generiere via ${provider}${model ? ' · ' + model : ''}…`, 'info');

    try {
      const started = Date.now();
      const enhance = $('image-lab-enhance-prompt')?.checked !== false;
      const res = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          prompt,
          size,
          model: model || undefined,
          session_id: sessionId || undefined,
          enhance,
        }),
      });
      const data = await res.json();
      const ms = Date.now() - started;

      if (!data.ok) {
        setStatus(`${data.error || 'Generierung fehlgeschlagen'} [${data.code || '?'}]`, 'error');
        return;
      }

      const item = {
        url: data.url,
        prompt: data.prompt || prompt,
        enhanced_prompt: data.enhanced_prompt || null,
        final_prompt: data.final_prompt || data.prompt || prompt,
        references_used: data.references_used || [],
        provider: data.provider || provider,
        model: data.model || '',
        size: data.size || size,
        createdAt: new Date().toISOString(),
      };
      gallery = [item, ...gallery.filter((old) => old.url !== item.url)].slice(0, 24);
      saveGallery();
      renderGallery();
      renderCurrent(item);
      const costTxt = data.metadata && typeof data.metadata.estimated_cost_usd === 'number'
        ? ` · ≈$${Number(data.metadata.estimated_cost_usd).toFixed(3)}`
        : '';
      setStatus(`Fertig in ${ms} ms via ${item.provider}/${item.model || 'default'}${costTxt}.`, 'ok');
      refreshCostWidget();
    } catch (err) {
      setStatus(`Netzwerkfehler: ${err.message}`, 'error');
    } finally {
      setGenerateLoading(false);
      setProgressBar(false);
    }
  }

  // ── UI-Wiring: Format-Toggle, Preset-Chips, Char-Count, Lightbox ─
  function wireStudioUI() {
    // Format-Toggle (Res-Buttons)
    const formatToggle = $('nbs-format-toggle');
    const sizeSelect = $('image-lab-size');
    const formatDesc = formatToggle ? formatToggle.parentElement.querySelector('.nbs-res-desc') : null;
    if (formatToggle && sizeSelect) {
      formatToggle.querySelectorAll('.nbs-res-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const v = btn.getAttribute('data-value');
          if (!v) return;
          sizeSelect.value = v;
          formatToggle.querySelectorAll('.nbs-res-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          if (formatDesc) {
            const labels = {
              '1024x1024': 'Quadrat 1:1 · 1024×1024',
              '1024x1792': 'Portrait 9:16 · 1024×1792',
              '1792x1024': 'Landscape 16:9 · 1792×1024',
            };
            formatDesc.textContent = labels[v] || v;
          }
        });
      });
    }
    // Preset-Chips
    document.querySelectorAll('.nbs-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const preset = chip.getAttribute('data-preset');
        const promptEl = $('image-lab-prompt');
        if (promptEl && preset) {
          promptEl.value = preset;
          updateCharCount();
          promptEl.focus();
        }
      });
    });
    // Char-Count
    const promptEl = $('image-lab-prompt');
    if (promptEl) promptEl.addEventListener('input', updateCharCount);
    updateCharCount();
    // Lightbox
    const lb = $('nbs-lightbox');
    const lbClose = $('nbs-lightbox-close');
    if (lb) lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
    if (lbClose) lbClose.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
  }

  function updateCharCount() {
    const el = $('image-lab-prompt');
    const out = $('nbs-char-count');
    if (el && out) out.textContent = String((el.value || '').length);
  }

  function addGalleryItemFromResult(data) {
    const item = {
      url: data.url,
      prompt: data.prompt || 'Imported from Codex generated_images',
      provider: data.provider || 'codex-session',
      model: data.model || 'codex image tool',
      size: data.size || '',
      sourcePath: data.source_path || '',
      createdAt: new Date().toISOString(),
    };
    gallery = [item, ...gallery.filter((old) => old.url !== item.url)].slice(0, 24);
    saveGallery();
    renderGallery();
    renderCurrent(item);
    return item;
  }

  async function createCodexJob(prompt, size) {
    const btn = $('image-lab-generate');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Warte...';
    }

    try {
      const res = await fetch('/api/image/codex/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          size,
          style: $('image-lab-style')?.value || '',
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatus(data.error || 'Codex-Job konnte nicht erstellt werden.', 'error');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Generieren';
        }
        return;
      }
      activeCodexJob = data.job;
      setStatus(`Codex-Job ${activeCodexJob.id} erstellt. Wartet auf Codex-Session...`, 'warn');
      startCodexPolling(activeCodexJob.id);
      return activeCodexJob;
    } catch (err) {
      setStatus(`Codex-Job fehlgeschlagen: ${err.message}`, 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Generieren';
      }
    }
    return null;
  }

  function startCodexPolling(jobId) {
    if (codexPollTimer) clearInterval(codexPollTimer);
    pollCodexJob(jobId);
    codexPollTimer = setInterval(() => pollCodexJob(jobId), 3000);
  }

  async function pollCodexJob(jobId) {
    try {
      const res = await fetch(`/api/image/codex/jobs/${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (!data.ok || !data.job) return;
      const job = data.job;
      if (job.status === 'pending') {
        setStatus(`Codex-Job ${job.id} wartet. Prompt ist in der Queue.`, 'warn');
        return;
      }
      if (codexPollTimer) {
        clearInterval(codexPollTimer);
        codexPollTimer = null;
      }
      const btn = $('image-lab-generate');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Generieren';
      }
      if (job.status === 'completed' && job.result) {
        addGalleryItemFromResult(job.result);
        setStatus(`Codex-Job ${job.id} abgeschlossen.`, 'ok');
      } else if (job.status === 'error') {
        setStatus(job.error || `Codex-Job ${job.id} fehlgeschlagen.`, 'error');
      }
    } catch (_) {}
  }

  async function importCodexDrop() {
    const buttons = Array.from(document.querySelectorAll('.image-lab-import-codex'));
    buttons.forEach((btn) => {
      btn.disabled = true;
      btn.dataset.originalText = btn.textContent;
      btn.textContent = 'Importiere...';
    });
    setStatus('Suche neuestes Codex-Bild...', 'info');

    try {
      const res = await fetch('/api/image/codex/import', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setStatus(data.error || 'Kein Codex-Bild gefunden.', 'warn');
        return;
      }

      addGalleryItemFromResult(data);
      setStatus(`Codex Drop importiert: ${data.path}`, 'ok');
    } catch (err) {
      setStatus(`Codex-Drop-Import fehlgeschlagen: ${err.message}`, 'error');
    } finally {
      buttons.forEach((btn) => {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || 'Codex Drop importieren';
      });
    }
  }

  // ============================================================
  // LIBRARY (persistente Bilder, Folders, Day-Grouping, Delete/Move)
  // ============================================================
  let libState = { folder: null, folders: [], grouped: [], loaded: false };

  async function loadLibrary() {
    try {
      const url = '/api/library?group=day' + (libState.folder ? '&folder=' + encodeURIComponent(libState.folder) : '');
      const r = await fetch(url);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'load failed');
      libState.folders = d.folders || [];
      libState.grouped = d.grouped || [];
      libState.loaded = true;
      renderLibraryFolders();
      renderLibraryContent();
    } catch (e) {
      console.warn('[Library] load failed', e);
      const c = $('nbs-lib-content');
      if (c) c.innerHTML = `<div class="nbs-empty-state"><div class="nbs-empty-icon">⚠️</div><div class="nbs-empty-title">Konnte Library nicht laden</div><div class="nbs-empty-sub">${esc(e.message)}</div></div>`;
    }
  }

  function renderLibraryFolders() {
    const host = $('nbs-lib-folders');
    if (!host) return;
    const total = libState.folders.reduce((sum, f) => sum + (f.count || 0), 0);
    const items = [
      { name: null, label: 'Alle', count: total, isAll: true },
      ...libState.folders.map(f => ({ name: f.name, label: f.name === '_inbox' ? 'Inbox' : f.name, count: f.count })),
    ];
    host.innerHTML = items.map(it => {
      const active = (libState.folder == null && it.isAll) || (libState.folder === it.name) ? 'active' : '';
      return `<div class="nbs-lib-folder ${active}" data-folder="${esc(it.name == null ? '' : it.name)}" data-isall="${it.isAll ? '1' : ''}">
        <span class="nbs-lib-folder-name">${esc(it.label)}</span>
        <span class="nbs-lib-folder-count">${it.count}</span>
      </div>`;
    }).join('');
    host.querySelectorAll('.nbs-lib-folder').forEach(el => {
      el.addEventListener('click', () => {
        libState.folder = el.dataset.isall ? null : el.dataset.folder;
        loadLibrary();
      });
    });
    // Folder-Toolbar Actions nur wenn ein konkreter Folder (nicht "Alle", nicht _inbox) gewählt
    const actions = $('nbs-lib-folder-actions');
    if (actions) {
      const showActions = libState.folder && libState.folder !== '_inbox';
      actions.style.display = showActions ? '' : 'none';
    }
    const cur = $('nbs-lib-current-folder');
    if (cur) {
      cur.textContent = libState.folder == null ? 'Alle Bilder'
        : (libState.folder === '_inbox' ? 'Inbox' : libState.folder);
    }
  }

  function renderLibraryContent() {
    const host = $('nbs-lib-content');
    if (!host) return;
    if (!libState.grouped.length) {
      host.innerHTML = `<div class="nbs-empty-state">
        <div class="nbs-empty-icon">📭</div>
        <div class="nbs-empty-title">Noch keine Bilder hier</div>
        <div class="nbs-empty-sub">Generiere Bilder, sie landen automatisch in der Inbox.</div>
      </div>`;
      return;
    }
    // Lookup-Map fuer Lightbox-Meta — Key = "<folder>/<filename>"
    libState.imageByKey = {};
    for (const g of libState.grouped) {
      for (const im of g.images) {
        libState.imageByKey[`${im.folder}/${im.filename}`] = im;
      }
    }
    host.innerHTML = libState.grouped.map(g => `
      <div class="nbs-lib-day-group">
        <div class="nbs-lib-day-header">${esc(formatDayHeader(g.day))} · ${g.images.length}</div>
        <div class="nbs-lib-grid">
          ${g.images.map(img => libImgCardHtml(img)).join('')}
        </div>
      </div>
    `).join('');
    host.querySelectorAll('.nbs-lib-img-card img').forEach(img => {
      img.addEventListener('click', (e) => {
        const url = img.getAttribute('src');
        if (!url) return;
        const card = img.closest('.nbs-lib-img-card');
        const key = card?.dataset.libkey;
        const entry = key ? libState.imageByKey[key] : null;
        const meta = entry?.meta ? Object.assign({}, entry.meta) : null;
        openLightbox(url, meta);
      });
    });
    host.querySelectorAll('.nbs-lib-img-action[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLibImage(btn.dataset.folder, btn.dataset.filename);
      });
    });
    host.querySelectorAll('.nbs-lib-img-action[data-action="move"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showMoveMenu(btn);
      });
    });
  }

  function libImgCardHtml(img) {
    const folderTag = libState.folder == null && img.folder !== '_inbox'
      ? `<div class="nbs-lib-img-folder-tag">${esc(img.folder)}</div>` : '';
    const promptTitle = (img.meta?.user_prompt || img.meta?.prompt || img.filename);
    return `<div class="nbs-lib-img-card" title="${esc(promptTitle)}" data-libkey="${esc(img.folder + '/' + img.filename)}">
      <img src="${esc(img.url)}" alt="" loading="lazy">
      ${folderTag}
      <div class="nbs-lib-img-actions">
        <button class="nbs-lib-img-action" data-action="move" data-folder="${esc(img.folder)}" data-filename="${esc(img.filename)}" title="Verschieben">↪</button>
        <button class="nbs-lib-img-action danger" data-action="delete" data-folder="${esc(img.folder)}" data-filename="${esc(img.filename)}" title="Löschen">🗑</button>
      </div>
    </div>`;
  }

  function formatDayHeader(day) {
    if (!day) return '';
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    if (day === today) return 'Heute';
    if (day === yesterday) return 'Gestern';
    try {
      const d = new Date(day + 'T12:00');
      return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } catch { return day; }
  }

  async function deleteLibImage(folder, filename) {
    if (!confirm(`Bild "${filename}" wirklich löschen?`)) return;
    try {
      const r = await fetch('/api/library/image', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, filename }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'delete failed');
      loadLibrary();
    } catch (e) {
      alert('Löschen fehlgeschlagen: ' + e.message);
    }
  }

  function showMoveMenu(triggerBtn) {
    document.querySelectorAll('.nbs-move-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'nbs-move-menu';
    const folders = libState.folders.filter(f => f.name !== triggerBtn.dataset.folder);
    const items = [
      ...folders.map(f => ({ name: f.name, label: f.name === '_inbox' ? 'Inbox' : f.name })),
      { name: '__new__', label: '+ Neuer Folder…' },
    ];
    menu.innerHTML = items.map(it =>
      `<button type="button" class="nbs-move-menu-item" data-folder="${esc(it.name)}">${esc(it.label)}</button>`
    ).join('');
    document.body.appendChild(menu);
    const rect = triggerBtn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = Math.max(8, rect.left - 130) + 'px';
    const close = (e) => { if (e && menu.contains(e.target)) return; menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 50);
    menu.querySelectorAll('.nbs-move-menu-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        let dest = item.dataset.folder;
        if (dest === '__new__') {
          dest = (prompt('Name des neuen Folders:') || '').trim();
          if (!dest) { menu.remove(); return; }
          if (!await createLibFolder(dest)) { menu.remove(); return; }
        }
        await moveLibImage(triggerBtn.dataset.folder, triggerBtn.dataset.filename, dest);
        menu.remove();
      });
    });
  }

  async function moveLibImage(srcFolder, filename, destFolder) {
    try {
      const r = await fetch('/api/library/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src_folder: srcFolder, filename, dest_folder: destFolder }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'move failed');
      loadLibrary();
    } catch (e) {
      alert('Verschieben fehlgeschlagen: ' + e.message);
    }
  }

  async function createLibFolder(name) {
    try {
      const r = await fetch('/api/library/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'create failed');
      return true;
    } catch (e) {
      alert('Folder anlegen fehlgeschlagen: ' + e.message);
      return false;
    }
  }

  async function deleteLibFolder(name) {
    const folderInfo = libState.folders.find(f => f.name === name);
    const count = folderInfo?.count || 0;
    const msg = count > 0
      ? `Folder "${name}" enthält ${count} Bilder. Wirklich komplett löschen?`
      : `Folder "${name}" löschen?`;
    if (!confirm(msg)) return;
    try {
      const r = await fetch('/api/library/folder', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, force: true }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'delete failed');
      libState.folder = null;
      loadLibrary();
    } catch (e) {
      alert('Folder löschen fehlgeschlagen: ' + e.message);
    }
  }

  // ============================================================
  // AVATARE (Personen mit References)
  // ============================================================
  let avatarsState = { list: [], selected: null };

  async function loadAvatars() {
    try {
      const r = await fetch('/api/avatars');
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'load failed');
      avatarsState.list = d.avatars || [];
      renderAvatarsList();
    } catch (e) {
      const host = $('nbs-avatars-list');
      if (host) host.innerHTML = `<div class="nbs-empty-state"><div class="nbs-empty-icon">⚠️</div><div class="nbs-empty-title">Konnte Avatare nicht laden</div><div class="nbs-empty-sub">${esc(e.message)}</div></div>`;
    }
  }

  function renderAvatarsList() {
    const host = $('nbs-avatars-list');
    const detail = $('nbs-avatar-detail');
    if (!host || !detail) return;
    detail.style.display = 'none';
    host.style.display = '';
    host.innerHTML = avatarsState.list.map(a => `
      <div class="nbs-avatar-card" data-name="${esc(a.name)}">
        <div class="nbs-avatar-cover">
          ${a.cover_url ? `<img src="${esc(a.cover_url)}" alt="">` : '👤'}
        </div>
        <div class="nbs-avatar-card-body">
          <div class="nbs-avatar-card-name">${esc(a.name)}</div>
          <div class="nbs-avatar-card-meta">${a.ref_count} Reference${a.ref_count === 1 ? '' : 's'}</div>
        </div>
      </div>
    `).join('') + `
      <div class="nbs-avatar-card nbs-avatar-new" id="nbs-avatar-new-btn">
        <div class="nbs-avatar-new-icon">＋</div>
        <div>Neue Person anlegen</div>
      </div>`;
    host.querySelectorAll('.nbs-avatar-card[data-name]').forEach(card => {
      card.addEventListener('click', () => openAvatarDetail(card.dataset.name));
    });
    $('nbs-avatar-new-btn')?.addEventListener('click', createNewAvatar);
  }

  async function createNewAvatar() {
    const name = (prompt('Name der Person (z.B. Robin, Mama, Papa):') || '').trim();
    if (!name) return;
    const description = (prompt('Kurze Beschreibung (optional, z.B. "Robin, brown hair, blue eyes, 28 yo"):') || '').trim();
    try {
      const r = await fetch('/api/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'create failed');
      await loadAvatars();
      openAvatarDetail(name);
    } catch (e) {
      alert('Anlegen fehlgeschlagen: ' + e.message);
    }
  }

  async function openAvatarDetail(name) {
    try {
      const r = await fetch('/api/avatars/' + encodeURIComponent(name));
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'load failed');
      avatarsState.selected = d.avatar;
      renderAvatarDetail();
    } catch (e) {
      alert('Avatar nicht ladbar: ' + e.message);
    }
  }

  function renderAvatarDetail() {
    const list = $('nbs-avatars-list');
    const detail = $('nbs-avatar-detail');
    if (!list || !detail) return;
    const a = avatarsState.selected;
    if (!a) return;
    list.style.display = 'none';
    detail.style.display = '';
    detail.innerHTML = `
      <button type="button" class="nbs-avatar-back" id="nbs-avatar-back-btn">← Zurück zu allen</button>
      <div class="nbs-avatar-detail-header">
        <div>
          <div class="nbs-avatar-detail-title">👤 ${esc(a.name)}</div>
          <div class="nbs-avatar-detail-desc">${esc(a.description || 'Keine Beschreibung. Click ✎ zum Bearbeiten.')}</div>
        </div>
        <div class="nbs-avatar-detail-actions">
          <button type="button" class="nbs-lib-folder-action" id="nbs-avatar-edit-btn">✎ Bearbeiten</button>
          <button type="button" class="nbs-lib-folder-action" id="nbs-avatar-use-btn">🪄 Im Prompt verwenden</button>
          <button type="button" class="nbs-lib-folder-action danger" id="nbs-avatar-delete-btn">🗑 Person löschen</button>
        </div>
      </div>
      <div class="nbs-avatar-section-title">References (${a.references.length})</div>
      <div class="nbs-avatar-refs-grid">
        ${a.references.map(r => `
          <div class="nbs-avatar-ref">
            <img src="${esc(r.url)}" alt="" data-url="${esc(r.url)}">
            <button type="button" class="nbs-avatar-ref-delete" data-filename="${esc(r.filename)}" title="Löschen">✕</button>
          </div>
        `).join('')}
        <label class="nbs-avatar-upload">
          <div class="nbs-avatar-upload-icon">＋</div>
          <div>Reference hochladen</div>
          <input type="file" accept="image/*" multiple style="display:none;" id="nbs-avatar-upload-input">
        </label>
      </div>
    `;
    $('nbs-avatar-back-btn')?.addEventListener('click', renderAvatarsList);
    $('nbs-avatar-edit-btn')?.addEventListener('click', editAvatar);
    $('nbs-avatar-use-btn')?.addEventListener('click', useAvatarInPrompt);
    $('nbs-avatar-delete-btn')?.addEventListener('click', deleteCurrentAvatar);
    $('nbs-avatar-upload-input')?.addEventListener('change', uploadAvatarRefs);
    detail.querySelectorAll('.nbs-avatar-ref img').forEach(img => {
      img.addEventListener('click', () => openLightbox(img.dataset.url));
    });
    detail.querySelectorAll('.nbs-avatar-ref-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAvatarRef(btn.dataset.filename);
      });
    });
  }

  async function editAvatar() {
    const a = avatarsState.selected;
    if (!a) return;
    const desc = prompt('Beschreibung (für Image-Prompts):', a.description || '');
    if (desc === null) return;
    try {
      const r = await fetch('/api/avatars/' + encodeURIComponent(a.name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'update failed');
      avatarsState.selected = d.avatar;
      renderAvatarDetail();
      loadAvatars(); // refresh card list
    } catch (e) {
      alert('Bearbeiten fehlgeschlagen: ' + e.message);
    }
  }

  function useAvatarInPrompt() {
    const a = avatarsState.selected;
    if (!a) return;
    const prompt = $('image-lab-prompt');
    if (!prompt) return;
    const anchor = a.description ? `${a.name} (${a.description})` : a.name;
    const cur = (prompt.value || '').trim();
    prompt.value = cur ? `${cur}, featuring ${anchor}` : `Portrait of ${anchor}, `;
    prompt.dispatchEvent(new Event('input'));
    // Switch to "Aktuell"-Tab und zum Prompt scrollen
    activateTab('recent');
    prompt.focus();
  }

  async function deleteCurrentAvatar() {
    const a = avatarsState.selected;
    if (!a) return;
    if (!confirm(`Person "${a.name}" und alle References löschen?`)) return;
    try {
      const r = await fetch('/api/avatars/' + encodeURIComponent(a.name), { method: 'DELETE' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'delete failed');
      avatarsState.selected = null;
      await loadAvatars();
    } catch (e) {
      alert('Löschen fehlgeschlagen: ' + e.message);
    }
  }

  async function uploadAvatarRefs(ev) {
    const a = avatarsState.selected;
    if (!a) return;
    const files = Array.from(ev.target.files || []);
    for (const file of files) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch('/api/avatars/' + encodeURIComponent(a.name) + '/reference', {
          method: 'POST',
          body: fd,
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'upload failed');
      } catch (e) {
        alert(`Upload "${file.name}" fehlgeschlagen: ${e.message}`);
      }
    }
    await openAvatarDetail(a.name);
  }

  async function deleteAvatarRef(filename) {
    const a = avatarsState.selected;
    if (!a) return;
    if (!confirm(`Reference "${filename}" löschen?`)) return;
    try {
      const r = await fetch('/api/avatars/' + encodeURIComponent(a.name) + '/reference', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'delete failed');
      await openAvatarDetail(a.name);
    } catch (e) {
      alert('Löschen fehlgeschlagen: ' + e.message);
    }
  }

  // ============================================================
  // TAB-Switching
  // ============================================================
  function activateTab(name) {
    document.querySelectorAll('#nbs-tab-bar .nbs-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.nbs-tab-pane').forEach(p => {
      p.classList.toggle('active', p.dataset.pane === name);
    });
    if (name === 'library' && !libState.loaded) loadLibrary();
    if (name === 'library') loadLibrary(); // immer refresh damit neu generierte Bilder erscheinen
    if (name === 'avatars') loadAvatars();
  }

  function init() {
    if (initialized) {
      loadProviders();
      return;
    }
    initialized = true;
    loadGallery();
    renderGallery();
    loadProviders();
    wireStudioUI();

    $('image-lab-generate')?.addEventListener('click', generate);
    document.querySelectorAll('.image-lab-import-codex').forEach((btn) => {
      btn.addEventListener('click', importCodexDrop);
    });
    $('image-lab-clear')?.addEventListener('click', () => {
      const prompt = $('image-lab-prompt');
      if (prompt) prompt.value = '';
      setStatus('', 'info');
      prompt?.focus();
    });
    $('image-lab-clear-gallery')?.addEventListener('click', () => {
      gallery = [];
      saveGallery();
      renderGallery();
      setStatus('Galerie geleert.', 'info');
    });
    $('image-lab-free-first')?.addEventListener('change', () => {
      providersLoaded = false;
      loadProviders();
    });
    $('image-lab-provider')?.addEventListener('change', updateProviderChip);
    $('image-lab-prompt')?.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        generate();
      }
    });

    // Tab-Switching
    document.querySelectorAll('#nbs-tab-bar .nbs-tab').forEach(btn => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });
    // Library-Folder-Aktionen
    $('nbs-lib-new-folder')?.addEventListener('click', async () => {
      const name = (prompt('Name des neuen Folders:') || '').trim();
      if (!name) return;
      if (await createLibFolder(name)) loadLibrary();
    });
    document.querySelectorAll('#nbs-lib-folder-actions .nbs-lib-folder-action').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (!libState.folder) return;
        if (action === 'rename') {
          const name = (prompt('Neuer Name:', libState.folder) || '').trim();
          if (!name || name === libState.folder) return;
          // Rename via DELETE old → create new + move all (kein dedicated rename-API, nutzen Move)
          alert('Rename ist noch nicht implementiert — Workaround: neuen Folder anlegen, Bilder einzeln verschieben, alten löschen.');
        } else if (action === 'delete') {
          deleteLibFolder(libState.folder);
        }
      });
    });
  }

  return { init, loadLibrary, loadAvatars };
})();
