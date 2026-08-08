/* Motion Studio — a target's own panels, shared by every Studio surface.
 *
 * config · audio · assets · outputs. These are the deeper fields of one scene,
 * and until v0.27 they existed only on the scene page (/index.html), wired to
 * that page's markup and globals. The film page could show a scene's facts but
 * not its config, so the routine act of checking a scene while reviewing a film
 * was a navigation — and a reviewer who leaves the timeline loses the thread of
 * the film they are judging.
 *
 * The fix is Final Cut's: the inspector is where a selected thing explains
 * itself. But porting these panels into film.js would leave TWO implementations
 * of the same four panels, and they would drift — within a release the film
 * inspector and the scene page would disagree about what editing a scene means,
 * which is the same mode error the document strip was built to end, one layer
 * down. So there is one implementation and two hosts.
 *
 * The module builds its own DOM (it does not adopt markup from either page) and
 * takes everything host-specific by injection: the transport, the notifications,
 * and the two callbacks that say what a config change and a deletion MEAN to the
 * host. It reuses the existing class names throughout, so both documents style
 * it from styles.css and only the compact overrides live in scene-panels.css.
 *
 * v0.27.1: **assets and outputs are not scene-only.** A film has an assets/
 * folder and an out/ folder addressed by the same routes — the server calls
 * them "shared target routes" — so the module takes a `kind` and the film
 * inspector mounts the same two panels. config and audio stay scene-only, and
 * for a good reason rather than an unfinished one: a film's timing lives in
 * film.json edited by the timeline, and its audio IS the timeline. A second
 * editor for either would be a second source of truth.
 *
 * Loaded as a classic script before app.js / film.js, which each declare their
 * own top-level `$`, `el` and `state` — hence the IIFE: one global, ScenePanels.
 */

(() => {
  'use strict';

  const enc = encodeURIComponent;

  /* Which output fields each format actually consumes — mirrors core/formats.js.
   * Irrelevant fields are shown disabled rather than hidden, so the config panel
   * is a complete picture of scene.json instead of a curated subset. */
  const FORMAT_CAPS = {
    mp4: { crf: 1, preset: 1, pixFmt: 1, transparent: 0, audio: 1 },
    webm: { crf: 1, preset: 0, pixFmt: 0, transparent: 1, audio: 1 },
    gif: { crf: 0, preset: 0, pixFmt: 0, transparent: 0, audio: 0 },
    prores: { crf: 0, preset: 0, pixFmt: 0, transparent: 1, audio: 1 },
    'png-sequence': { crf: 0, preset: 0, pixFmt: 0, transparent: 1, audio: 0 },
  };

  const FORMAT_NOTES = {
    mp4: 'H.264: crf, preset and pix fmt all apply. No alpha channel.',
    webm: 'VP9: crf applies; pix fmt is chosen automatically (yuva420p when transparent).',
    gif: 'GIF encodes with a two-pass palette — crf/preset/pix fmt are unused, and audio tracks are skipped.',
    prores: 'ProRes: profile and pix fmt follow the alpha setting (4444 when transparent, else 422 HQ).',
    'png-sequence': 'A folder of frame-%06d.png — "filename" names the folder. No encode settings, no audio.',
  };

  const FORMAT_OPTIONS = [
    ['mp4', 'mp4 · H.264'],
    ['webm', 'webm · VP9'],
    ['gif', 'gif'],
    ['prores', 'prores · .mov'],
    ['png-sequence', 'png sequence'],
  ];

  const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

  /* `video` earns a glyph now that films mount this panel: a film's assets/ is
     mostly footage and transparent-overlay stingers, and every one of them was
     falling through to the generic ⧉. */
  const KIND_GLYPH = { image: '🖼', video: '▶', audio: '♫', font: 'Aa', data: '⧉' };

  const fmtBytes = (n) => (n == null ? '—' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB');

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  function flashButton(btn, label = '✓') {
    const orig = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n && (k === 'value' || k === 'checked' || k === 'disabled')) n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...children.filter((c) => c != null));
    return n;
  }

  const field = (label, input, cls = '') => el('label', { class: cls }, document.createTextNode(label + ' '), input);

  let seq = 0;

  /**
   * Mount the four panels into `host`.
   *
   * @param {object}   o
   * @param {Element}  o.host              where the panel bodies are appended
   * @param {Function} o.api               (path, opts) => parsed JSON, throws on !ok
   * @param {Function} o.toast             (message, {kind}) => void
   * @param {Function} o.toastError        (error) => void
   * @param {boolean}  o.compact           narrow single-column layout (the inspector)
   * @param {object}   o.capabilities      {deleteScene} — what this host permits
   * @param {Function} o.onConfigChanged   (config) => void — the host updates its own chrome
   * @param {Function} o.onSceneDeleted    () => void — the host decides what "gone" means
   */
  function create({
    host,
    api,
    toast = () => {},
    toastError = () => {},
    compact = false,
    capabilities = {},
    onConfigChanged = () => {},
    onSceneDeleted = () => {},
    onAssetsChanged = () => {},
  }) {
    const caps = { deleteScene: true, ...capabilities };
    const uid = `sp${++seq}`;

    /* Per-instance state. The audio draft is staged here and written with one
     * PATCH, so a half-typed path never reaches disk. */
    const st = {
      kind: 'scene',      // 'scene' | 'film'
      targetId: null,
      config: null,       // scenes only
      targetPath: null,
      audioDraft: [],
      audioPreview: null,
      activeTab: null,
    };

    const isFilm = () => st.kind === 'film';
    const sceneUrl = (suffix = '') => `/api/${isFilm() ? 'films' : 'scenes'}/${enc(st.targetId)}${suffix}`;
    /* A scene's images are previewed through the sandboxed /preview/ route; a
     * film has no such route and reads its own assets back through the API —
     * which already carries a query string, so the cache-buster has to join
     * with & rather than a second ?. */
    const assetPreviewUrl = (rel, bust = null) => {
      const base = isFilm()
        ? `/api/films/${enc(st.targetId)}/asset?path=${enc(rel)}`
        : `/preview/${enc(st.targetId)}/${rel.split('/').map(enc).join('/')}`;
      return bust == null ? base : `${base}${base.includes('?') ? '&' : '?'}t=${enc(bust)}`;
    };
    const pathSep = () => ((st.targetPath ?? '').includes('\\') ? '\\' : '/');
    /** Which panels this kind of target actually has. */
    const OFFERS = { scene: ['config', 'audio', 'assets', 'outputs'], film: ['assets', 'outputs'] };
    const offers = (tab) => OFFERS[st.kind].includes(tab);

    /* ------------------------------ config ------------------------------ */

    const f = {
      name: el('input', { name: 'name' }),
      fps: el('input', { name: 'fps', type: 'number', min: '1', max: '240' }),
      width: el('input', { name: 'width', type: 'number', step: '2' }),
      height: el('input', { name: 'height', type: 'number', step: '2' }),
      durationInFrames: el('input', { name: 'durationInFrames', type: 'number', min: '1' }),
      format: el('select', { name: 'format' }, ...FORMAT_OPTIONS.map(([v, t]) => el('option', { value: v, text: t }))),
      dir: el('input', { name: 'dir', spellcheck: 'false' }),
      filename: el('input', { name: 'filename', spellcheck: 'false' }),
      crf: el('input', { name: 'crf', type: 'number', min: '0', max: '63' }),
      preset: el('select', { name: 'preset' },
        el('option', { value: '', text: '(unset)' }),
        ...X264_PRESETS.map((p) => el('option', { value: p, text: p }))),
      pixFmt: el('input', { name: 'pixFmt', spellcheck: 'false', placeholder: 'yuv420p' }),
      transparent: el('input', { name: 'transparent', type: 'checkbox' }),
      audioLimiter: el('input', { name: 'audioLimiter', type: 'checkbox' }),
    };

    const formatNote = el('p', { class: 'dim note' });
    const configMsg = el('span', { class: 'dim' });
    const configFacts = el('dl', { class: 'env-list mono' });
    const rawConfigBody = el('pre', { class: 'logs' });
    const scenePathChip = el('span', { class: 'mono path-chip' });

    const configForm = el('form', { autocomplete: 'off' },
      el('p', { class: 'section-label', text: 'composition' }),
      el('div', { class: 'config-grid' },
        field('name', f.name), field('fps', f.fps), field('width', f.width),
        field('height', f.height), field('frames', f.durationInFrames)),
      el('p', { class: 'section-label', text: 'output' }),
      el('div', { class: 'config-grid' },
        field('format', f.format), field('dir', f.dir), field('filename', f.filename),
        field('crf', f.crf), field('preset', f.preset), field('pix fmt', f.pixFmt),
        el('label', { class: 'check' }, f.transparent, document.createTextNode(' transparent (alpha)')),
        el('label', { class: 'check' }, f.audioLimiter, document.createTextNode(' audio limiter (−1 dBFS)'))),
      formatNote,
      el('div', { class: 'config-actions' },
        el('button', { type: 'submit', class: 'primary', text: 'apply' }), configMsg),
    );

    const btnCopyPath = el('button', {
      type: 'button', class: 'ghost', title: 'copy the scene folder path', text: 'copy',
      onclick: (e) => { copyText(st.targetPath ?? ''); flashButton(e.target, '✓'); },
    });
    const btnDeleteScene = el('button', {
      type: 'button', class: 'ghost danger', title: 'remove this scene', text: 'delete scene…',
      onclick: () => openDeleteSceneDialog(),
    });
    const locationRow = el('div', { class: 'meta-row' },
      el('span', { class: 'meta-label', text: 'location' }), scenePathChip, btnCopyPath,
      caps.deleteScene ? btnDeleteScene : null);

    const configPanel = el('div', { class: 'tab-body sp-panel hidden' },
      configForm,
      el('p', { class: 'section-label' }, document.createTextNode('scene facts '), el('span', { class: 'dim', text: '(read-only)' })),
      configFacts,
      el('details', {}, el('summary', { text: 'raw scene.json' }), rawConfigBody),
      locationRow,
    );

    f.format.addEventListener('change', applyFormatCaps);

    function applyFormatCaps() {
      const c = FORMAT_CAPS[f.format.value] ?? FORMAT_CAPS.mp4;
      const on = { crf: c.crf, preset: c.preset, pixFmt: c.pixFmt, transparent: c.transparent, audioLimiter: c.audio };
      for (const [name, enabled] of Object.entries(on)) {
        f[name].disabled = !enabled;
        f[name].closest('label').classList.toggle('disabled', !enabled);
      }
      formatNote.textContent = FORMAT_NOTES[f.format.value] ?? '';
    }

    function fillConfigForm() {
      const c = st.config;
      if (!c) return;
      const o = c.output ?? {};
      f.name.value = c.name ?? '';
      f.fps.value = c.fps ?? '';
      f.width.value = c.width ?? '';
      f.height.value = c.height ?? '';
      f.durationInFrames.value = c.durationInFrames ?? '';
      f.format.value = o.format ?? 'mp4';
      f.dir.value = o.dir ?? 'out';
      f.filename.value = o.filename ?? '';
      f.crf.value = o.crf ?? '';
      f.preset.value = o.preset ?? '';
      f.pixFmt.value = o.pixFmt ?? '';
      f.transparent.checked = !!o.transparent;
      f.audioLimiter.checked = o.audioLimiter !== false;
      applyFormatCaps();
      fillConfigFacts();
    }

    /** Everything in scene.json the form cannot edit, shown rather than hidden. */
    function fillConfigFacts() {
      const c = st.config;
      configFacts.innerHTML = '';
      if (!c) return;
      const row = (k, v, dim = false) => configFacts.append(
        el('dt', { text: k }), el('dd', { class: dim ? 'dim' : '', text: v }));
      row('entry', c.entry);
      row('schema', `v${c.schemaVersion ?? 1}`);
      row('audio tracks', String(c.audio?.length ?? 0), !c.audio?.length);
      const libs = c.libraries ?? [];
      row('libraries', libs.length ? libs.join(', ') : 'none', !libs.length);
      for (const [file, b] of Object.entries(c.libraryBuilds ?? {})) {
        row(`  ${file}`, `${b.version ?? 'unknown'} · ${b.sha256.slice(0, 12)}… · ${fmtBytes(b.bytes)}`, true);
      }
      rawConfigBody.textContent = JSON.stringify(c, null, 2);
    }

    configForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      configMsg.textContent = '…';
      try {
        // null clears a field (the server drops null-valued output keys); an
        // omitted field would just keep its current value through the merge.
        const patch = {
          name: f.name.value,
          fps: Number(f.fps.value),
          width: Number(f.width.value),
          height: Number(f.height.value),
          durationInFrames: Number(f.durationInFrames.value),
          output: {
            format: f.format.value,
            dir: f.dir.value.trim() || 'out',
            filename: f.filename.value.trim() || 'output',
            transparent: f.transparent.checked,
            audioLimiter: f.audioLimiter.checked,
            crf: f.crf.value === '' ? null : Number(f.crf.value),
            preset: f.preset.value || null,
            pixFmt: f.pixFmt.value.trim() || null,
          },
        };
        const { config } = await api(sceneUrl('/config'), { method: 'PATCH', body: { patch } });
        st.config = config;
        fillConfigForm();
        renderAudioNote();
        configMsg.textContent = 'saved ✓';
        onConfigChanged(config);
      } catch (err) {
        configMsg.textContent = err.message;
      }
      setTimeout(() => { configMsg.textContent = ''; }, 4000);
    });

    /* ---------------------------- delete scene --------------------------- */

    const deleteFilesBox = el('input', { name: 'deleteFiles', type: 'checkbox' });
    const deleteSummary = el('p', { class: 'dialog-body' });
    const deleteForm = el('form', { method: 'dialog' },
      el('h2', { text: 'delete scene' }),
      deleteSummary,
      el('label', { class: 'check' }, deleteFilesBox, document.createTextNode(' also delete files on disk')),
      el('p', { class: 'dim sp-delete-note', text: 'Unchecked: the scene leaves the film’s play order but its folder stays on disk (listed as “unlisted”). Checked: the scene folder and everything in it is deleted.' }),
      el('div', { class: 'fieldrow right' },
        el('button', { type: 'button', class: 'ghost', text: 'cancel', onclick: () => deleteDialog.close() }),
        el('button', { type: 'submit', class: 'primary', text: 'delete' })),
    );
    const deleteDialog = el('dialog', { class: 'sp-dialog' }, deleteForm);

    function openDeleteSceneDialog() {
      deleteSummary.textContent = `Remove "${st.config?.name ?? st.targetId}" from its film?`;
      deleteFilesBox.checked = false;
      deleteDialog.showModal();
    }

    deleteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`${sceneUrl()}?deleteFiles=${deleteFilesBox.checked ? 1 : 0}`, { method: 'DELETE' });
        deleteDialog.close();
        onSceneDeleted();
      } catch (err) { toastError(err); }
    });

    /* --------------------------- audition player -------------------------- */

    /* One player shared by the assets and audio panels: starting a clip stops
     * whatever was playing, clicking the same clip again stops it, and every
     * button falls back to ▶ when playback ends, errors, or is superseded. */

    const auditionButtons = () => root.querySelectorAll('.audition-btn');

    function resetAuditionButtons() {
      for (const b of auditionButtons()) { b.textContent = '▶'; b.classList.remove('playing'); }
    }

    /** Re-mark the ⏸ after a list re-renders, so a clip playing from the assets
     *  panel still shows a stop control on its row in the audio panel. */
    function syncAuditionButtons() {
      const cur = st.audioPreview;
      const playing = cur && !cur.paused ? cur.dataset.src : null;
      for (const b of auditionButtons()) {
        const on = !!playing && b.dataset.src === playing;
        b.textContent = on ? '⏸' : '▶';
        b.classList.toggle('playing', on);
      }
    }

    function stopAudition() {
      st.audioPreview?.pause();
      st.audioPreview = null;
      resetAuditionButtons();
    }

    function toggleAudition(relPath, btn) {
      const src = (relPath ?? '').trim();
      const cur = st.audioPreview;
      if (cur && !cur.paused && cur.dataset.src === src) { stopAudition(); return; }
      stopAudition();
      if (!src) return; // a track row with no path yet
      const audio = new Audio(assetPreviewUrl(src));
      audio.dataset.src = src;
      audio.addEventListener('ended', resetAuditionButtons);
      audio.addEventListener('error', resetAuditionButtons); // typo'd path: don't strand a ⏸
      audio.play().catch(resetAuditionButtons);
      st.audioPreview = audio;
      btn.textContent = '⏸';
      btn.classList.add('playing');
    }

    /* ------------------------------- audio ------------------------------- */

    /* config.audio is the only part of scene.json with real structure. Edits are
     * staged in st.audioDraft and written with one PATCH. */

    const audioMsg = el('span', { class: 'dim sp-audio-msg' });
    const audioList = el('ul', { class: 'audio-list' });
    const audioNote = el('p', { class: 'dim note' });
    const audioOptions = el('datalist', { id: `${uid}-audio-assets` });

    const btnAddTrack = el('button', {
      type: 'button', class: 'primary', text: '+ add track',
      onclick: () => {
        st.audioDraft.push({ src: '', startInFrames: 0, gainDb: 0 });
        renderAudioList();
        markAudioDirty();
        audioList.querySelector('li:last-child .t-src')?.focus();
      },
    });

    const btnSaveAudio = el('button', {
      type: 'button', class: 'ghost', text: 'save tracks',
      onclick: async () => {
        const tracks = st.audioDraft.filter((t) => (t.src ?? '').trim());
        audioMsg.classList.remove('warn');
        audioMsg.textContent = '…';
        try {
          const { config } = await api(sceneUrl('/config'), { method: 'PATCH', body: { patch: { audio: tracks } } });
          st.config = config;
          st.audioDraft = structuredClone(config.audio ?? []);
          renderAudioList();
          fillConfigFacts();
          loadAssets().catch(() => {}); // track edits change the assets panel's ♫ badges
          audioMsg.textContent = `saved ✓ (${tracks.length} track${tracks.length === 1 ? '' : 's'})`;
          setTimeout(() => { audioMsg.textContent = ''; }, 4000);
          onConfigChanged(config);
        } catch (err) {
          audioMsg.textContent = err.message;
          audioMsg.classList.add('warn');
        }
      },
    });

    const audioPanel = el('div', { class: 'tab-body sp-panel hidden' },
      el('div', { class: 'fieldrow assets-head' },
        btnAddTrack,
        el('span', { class: 'dim', text: 'tracks are mixed without normalization and trimmed to the video length' }),
        el('span', { class: 'spacer' }), btnSaveAudio, audioMsg),
      audioList, audioOptions, audioNote,
    );

    function markAudioDirty() {
      audioMsg.textContent = 'unsaved changes';
      audioMsg.classList.add('warn');
    }

    function updateAudioSeconds(li, track) {
      const fps = st.config?.fps ?? 30;
      li.querySelector('.t-at').textContent = `= ${((track.startInFrames ?? 0) / fps).toFixed(2)}s`;
    }

    function audioRow(track, index) {
      const src = el('input', {
        class: 'mono t-src', value: track.src ?? '', placeholder: 'assets/music.mp3',
        list: audioOptions.id, spellcheck: 'false',
      });
      const start = el('input', {
        type: 'number', class: 'mono t-num', min: '0', value: track.startInFrames ?? 0, title: 'start frame',
      });
      const gain = el('input', {
        type: 'number', class: 'mono t-num', step: '0.5', value: track.gainDb ?? 0, title: 'gain in dB',
      });
      const play = el('button', { type: 'button', class: 'ghost a-btn audition-btn', text: '▶', title: 'audition this file' });
      const del = el('button', {
        type: 'button', class: 'ghost a-btn danger', text: 'remove',
        onclick: () => { st.audioDraft.splice(index, 1); renderAudioList(); markAudioDirty(); },
      });
      const at = el('span', { class: 't-at dim mono' });

      const syncPlayEnabled = () => {
        play.disabled = !src.value.trim();
        play.dataset.src = src.value.trim();
      };
      src.addEventListener('input', () => {
        st.audioDraft[index].src = src.value;
        markAudioDirty();
        syncPlayEnabled();
      });
      start.addEventListener('input', () => {
        st.audioDraft[index].startInFrames = start.value === '' ? 0 : Number(start.value);
        markAudioDirty();
        updateAudioSeconds(li, st.audioDraft[index]);
      });
      gain.addEventListener('input', () => {
        st.audioDraft[index].gainDb = gain.value === '' ? 0 : Number(gain.value);
        markAudioDirty();
      });
      play.addEventListener('click', () => toggleAudition(st.audioDraft[index].src, play));
      syncPlayEnabled();

      const li = el('li', {},
        field('src', src, 'grow'), field('start', start), at, field('gain dB', gain), play, del);
      updateAudioSeconds(li, track);
      return li;
    }

    function renderAudioNote() {
      const c = FORMAT_CAPS[st.config?.output?.format] ?? FORMAT_CAPS.mp4;
      audioNote.textContent = c.audio
        ? 'Paths are scene-relative. Tracks mix without normalization and are trimmed/padded to the video length.'
        : `Note: ${st.config?.output?.format} cannot carry audio — these tracks are skipped at render time with a warning in the logs.`;
    }

    function renderAudioList() {
      audioList.innerHTML = '';
      if (!st.audioDraft.length) {
        audioList.appendChild(el('li', { class: 'dim', text: 'no audio tracks — add one, or leave empty for a silent render' }));
      } else {
        st.audioDraft.forEach((t, i) => audioList.appendChild(audioRow(t, i)));
      }
      syncAuditionButtons();
      renderAudioNote();
    }

    function resetAudioDraft() {
      st.audioDraft = structuredClone(st.config?.audio ?? []);
      audioMsg.textContent = '';
      audioMsg.classList.remove('warn');
      renderAudioList();
    }

    /* ------------------------------- assets ------------------------------- */

    const assetList = el('ul', { class: 'asset-list' });
    const assetsPathChip = el('span', { class: 'mono path-chip' });
    const assetFileInput = el('input', { type: 'file', multiple: true, hidden: true });

    const assetsPanel = el('div', { class: 'tab-body sp-panel hidden' },
      el('div', { class: 'fieldrow assets-head' },
        el('button', { type: 'button', class: 'primary', text: '+ upload', onclick: () => assetFileInput.click() }),
        assetFileInput,
        el('span', { class: 'dim', text: 'or drop files anywhere on this panel · 25 MB max each' }),
        el('span', { class: 'spacer' }),
        assetsPathChip,
        el('button', {
          type: 'button', class: 'ghost', title: 'copy the assets folder path', text: 'copy',
          onclick: (e) => { copyText(assetsPathChip.textContent); flashButton(e.target, '✓'); },
        })),
      assetList,
    );

    assetFileInput.addEventListener('change', (e) => {
      if (e.target.files.length) uploadAssets([...e.target.files]);
      e.target.value = '';
    });
    assetsPanel.addEventListener('dragover', (e) => { e.preventDefault(); assetsPanel.classList.add('dropping'); });
    assetsPanel.addEventListener('dragleave', () => assetsPanel.classList.remove('dropping'));
    assetsPanel.addEventListener('drop', (e) => {
      e.preventDefault();
      assetsPanel.classList.remove('dropping');
      if (e.dataTransfer.files.length) uploadAssets([...e.dataTransfer.files]);
    });

    async function uploadAssets(fileList) {
      const errors = [];
      for (const file of fileList) {
        try {
          const res = await fetch(
            sceneUrl(`/asset?path=${enc('assets/' + file.name)}`),
            { method: 'PUT', body: file },
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || res.statusText);
          }
        } catch (err) {
          errors.push(`${file.name}: ${err.message}`);
        }
      }
      loadAssets().catch(() => {});
      onAssetsChanged(null);
      if (errors.length) toast('Some uploads failed:\n' + errors.join('\n'), { kind: 'error' });
    }

    async function loadAssets() {
      if (!st.targetId) return;
      const { files } = await api(sceneUrl('/assets'));
      // The audio panel offers this scene's audio assets as src autocomplete.
      audioOptions.innerHTML = '';
      for (const a of files.filter((x) => x.kind === 'audio')) {
        audioOptions.appendChild(el('option', { value: a.path }));
      }

      assetList.innerHTML = '';
      if (!files.length) {
        assetList.appendChild(el('li', { class: 'dim', text: 'no assets yet — upload files, or drop them into the assets/ folder on disk' }));
        return;
      }
      for (const a of files) {
        const thumb = el('span', { class: 'a-thumb' });
        if (a.kind === 'image') {
          thumb.appendChild(el('img', { src: assetPreviewUrl(a.path, a.mtime), alt: '', loading: 'lazy' }));
        } else if (a.kind === 'audio') {
          const play = el('button', { type: 'button', class: 'a-play audition-btn', title: 'audition', text: '▶' });
          play.dataset.src = a.path;
          play.addEventListener('click', () => toggleAudition(a.path, play));
          thumb.appendChild(play);
        } else {
          thumb.textContent = KIND_GLYPH[a.kind] ?? '⧉';
        }

        // Referenced-by badge, so the consequence of deleting is visible before
        // the click rather than only in the confirm dialog.
        const badge = a.audioRefs
          ? el('span', {
            class: 'a-ref mono', text: `♫ ${a.audioRefs}`,
            title: `used by ${a.audioRefs} audio track${a.audioRefs === 1 ? '' : 's'}`,
          })
          : el('span', {});

        const mkBtn = (label, title, fn) => el('button', { type: 'button', class: 'ghost a-btn', text: label, title, onclick: fn });
        const actions = el('span', { class: 'a-actions' },
          mkBtn('copy', 'copy the scene-relative path (use this in your composition)', (e) => {
            copyText(a.path);
            flashButton(e.target, '✓ copied');
          }),
          mkBtn('rename', 'rename or move within assets/', () => renameAsset(a)),
          mkBtn('delete', 'delete this asset', () => openAssetDeleteDialog(a)),
          el('a', {
            class: 'a-btn download-link', text: '⤓', title: 'download',
            href: sceneUrl(`/asset?path=${enc(a.path)}&download=1`),
          }));

        assetList.appendChild(el('li', {},
          thumb,
          el('span', { class: 'a-name mono', text: a.path.replace(/^assets\//, ''), title: a.path }),
          badge,
          el('span', { class: 'a-size dim mono', text: fmtBytes(a.bytes) }),
          actions));
      }
      syncAuditionButtons();
    }

    async function renameAsset(a) {
      // Moving a file out from under an audio track breaks it just as badly as
      // deleting it, and here the repair is unambiguous — so the tracks are the
      // same dialog's second question, ticked, rather than a chained confirm()
      // whose OK and Cancel were the only words describing either outcome.
      const answer = await StudioUtil.askForText({
        title: 'rename asset',
        label: 'new path',
        note: 'Must stay under assets/.',
        value: a.path,
        ok: 'rename',
        checkbox: a.audioRefs
          ? {
            label: `also repoint ${a.audioRefs} audio track${a.audioRefs === 1 ? '' : 's'} that reference ${a.path}`,
            checked: true,
            note: 'Left alone, those tracks point at a file that no longer exists and the next render fails when ffmpeg tries to mix them.',
          }
          : null,
      });
      if (!answer) return;
      const to = a.audioRefs ? answer.value : answer;
      const updateAudio = a.audioRefs ? answer.checked : false;
      if (to === a.path) return;
      try {
        const res = await api(sceneUrl('/asset/rename'), { method: 'POST', body: { from: a.path, to, updateAudio } });
        await afterAssetMutation(res);
      } catch (err) { toastError(err); }
    }

    /* An asset delete/rename can also rewrite config.audio, so the endpoints
     * return the new config when they touched it. Adopting it here keeps the
     * audio panel, the config facts and the raw JSON view in step without a
     * second round trip. */
    async function afterAssetMutation(result) {
      // A rename or delete can rewrite the target's own document — config.audio
      // for a scene, the master tracks for a film — so the host is told before
      // it saves something built on what was there a moment ago.
      onAssetsChanged(result);
      if (result?.config) {
        st.config = result.config;
        st.audioDraft = structuredClone(result.config.audio ?? []);
        fillConfigForm();
        renderAudioList();
        onConfigChanged(result.config);
      }
      await loadAssets();
    }

    const assetDeleteSummary = el('p', { class: 'dialog-body' });
    const assetDeleteCount = el('span');
    const assetDeleteList = el('ul', { class: 'ref-list mono' });
    const assetUpdateAudioBox = el('input', { name: 'updateAudio', type: 'checkbox', checked: true });
    const assetDeleteRefs = el('div', { class: 'hidden' },
      el('p', { class: 'warn-line' }, document.createTextNode('⚠ '), assetDeleteCount),
      assetDeleteList,
      el('label', { class: 'check' }, assetUpdateAudioBox, document.createTextNode(' also remove those audio tracks')),
      el('p', { class: 'dim note', text: 'Left in place, the tracks point at a missing file and the next render fails when ffmpeg tries to mix them.' }),
    );
    const assetDeleteForm = el('form', { method: 'dialog' },
      el('h2', { text: 'delete asset' }),
      assetDeleteSummary,
      assetDeleteRefs,
      el('div', { class: 'fieldrow right' },
        el('button', { type: 'button', class: 'ghost', text: 'cancel', onclick: () => assetDeleteDialog.close() }),
        el('button', { type: 'submit', class: 'primary', text: 'delete' })),
    );
    const assetDeleteDialog = el('dialog', { class: 'sp-dialog' }, assetDeleteForm);
    let assetPendingDelete = null;

    function openAssetDeleteDialog(a) {
      assetPendingDelete = a;
      assetDeleteSummary.textContent = `Delete ${a.path}?`;
      assetDeleteRefs.classList.toggle('hidden', !a.audioRefs);
      if (a.audioRefs) {
        assetDeleteCount.textContent = `${a.audioRefs} audio track${a.audioRefs === 1 ? '' : 's'} in this ${st.kind} reference it.`;
        assetDeleteList.innerHTML = '';
        for (const t of (st.config?.audio ?? []).filter((t) => (t.src ?? '').toLowerCase() === a.path.toLowerCase())) {
          assetDeleteList.appendChild(el('li', { text: `${t.src} · start ${t.startInFrames ?? 0}f · ${t.gainDb ?? 0} dB` }));
        }
        assetUpdateAudioBox.checked = true;
      }
      assetDeleteDialog.showModal();
    }

    assetDeleteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = assetPendingDelete;
      if (!a) return;
      const updateAudio = !!a.audioRefs && assetUpdateAudioBox.checked;
      try {
        const res = await api(
          sceneUrl(`/asset?path=${enc(a.path)}${updateAudio ? '&updateAudio=1' : ''}`),
          { method: 'DELETE' },
        );
        assetDeleteDialog.close();
        await afterAssetMutation(res);
      } catch (err) { toastError(err); }
    });

    /* ------------------------------- outputs ------------------------------ */

    const outputList = el('ul', { class: 'output-list' });
    const outputsPanel = el('div', { class: 'tab-body sp-panel hidden' }, outputList);

    async function loadOutputs() {
      if (!st.targetId) return;
      const { files } = await api(sceneUrl('/outputs'));
      outputList.innerHTML = '';
      if (!files.length) {
        outputList.appendChild(el('li', { class: 'dim', text: 'no outputs yet — render something' }));
        return;
      }
      for (const o of files) {
        if (o.dir) {
          outputList.appendChild(el('li', {},
            el('span', {}, document.createTextNode(`${o.name}/ `), el('span', { class: 'dim', text: '(png sequence)' })),
            el('span', { class: 'size', text: 'folder' })));
        } else {
          outputList.appendChild(el('li', {},
            el('a', { text: o.name, href: sceneUrl(`/output?file=${enc(o.name)}&download=1`) }),
            el('span', { class: 'size', text: fmtBytes(o.bytes) })));
        }
      }
    }

    /* -------------------------------- mount ------------------------------- */

    const PANELS = { config: configPanel, audio: audioPanel, assets: assetsPanel, outputs: outputsPanel };
    const root = el('div', { class: 'sp-root' + (compact ? ' sp-compact' : '') },
      configPanel, audioPanel, assetsPanel, outputsPanel);
    host?.appendChild(root);
    document.body.append(deleteDialog, assetDeleteDialog);

    return {
      root,
      panels: PANELS,
      get targetId() { return st.targetId; },
      get kind() { return st.kind; },
      get config() { return st.config; },
      /** The panels this target actually has, in tab order. */
      offered: () => OFFERS[st.kind].slice(),

      /** Point every panel at a film or a scene. `config`/`path` skip a refetch
       *  when the host already has them (every host does, from its own load). */
      async setTarget({ kind = 'scene', id, config = null, path = null } = {}) {
        stopAudition();
        st.kind = kind === 'film' ? 'film' : 'scene';
        st.targetId = id;
        if (!id) { st.config = null; st.targetPath = null; return; }
        if (path != null && (config || isFilm())) {
          st.config = config;
          st.targetPath = path;
        } else {
          // A film's document is not a scene config; only a scene refetches one.
          const t = await api(sceneUrl());
          st.config = isFilm() ? null : t.config;
          st.targetPath = isFilm() ? t.film?.path ?? null : t.path;
        }
        scenePathChip.textContent = st.targetPath ?? '';
        scenePathChip.title = st.targetPath ?? '';
        assetsPathChip.textContent = (st.targetPath ?? '') + pathSep() + 'assets';
        assetsPathChip.title = assetsPathChip.textContent;
        if (!isFilm()) { fillConfigForm(); resetAudioDraft(); }
        await Promise.all([loadAssets().catch(() => {}), loadOutputs().catch(() => {})]);
      },

      /** Adopt a config the host refetched (hot reload, an external edit). Does
       *  not clobber staged audio edits the user has not saved. */
      adoptConfig(config) {
        st.config = config;
        fillConfigForm();
        renderAudioNote();
      },

      /** Show one panel, or none (the host is showing a panel of its own). A
       *  panel this kind of target does not have is treated as none. */
      show(tab) {
        const wanted = tab && offers(tab) ? tab : null;
        st.activeTab = wanted;
        for (const [name, panel] of Object.entries(PANELS)) panel.classList.toggle('hidden', name !== wanted);
        root.classList.toggle('hidden', !wanted);
      },

      get activeTab() { return st.activeTab; },

      refresh() {
        loadAssets().catch(() => {});
        loadOutputs().catch(() => {});
      },
      reloadAssets: () => loadAssets().catch(() => {}),
      reloadOutputs: () => loadOutputs().catch(() => {}),

      stopAudition,

      destroy() {
        stopAudition();
        root.remove();
        deleteDialog.remove();
        assetDeleteDialog.remove();
      },
    };
  }

  window.ScenePanels = { create, fmtBytes, copyText, flashButton, FORMAT_CAPS, FORMAT_NOTES };
})();
