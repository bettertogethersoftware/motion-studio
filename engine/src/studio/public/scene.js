/* Motion Studio — one scene, as a document (v0.27).
 *
 * This was the workbench half of app.js, living inside index.html. That is why
 * the Studio needed two pages and a small industry of breadcrumbs, deep links
 * and same-tab rules to move between them: a film could not open without the
 * scene surface going away, because they were the same page.
 *
 * Now the Studio is a shell (index.html) and this is a document that opens
 * inside it as a tab — or standalone at /scene.html?scene=<id>, which is how a
 * scene lands on a second monitor and why the deep links still work.
 *
 * Embedded, the shell owns the activity bar, the status bar and the tab strip;
 * this file reports its title and its status items upward and leaves the chrome
 * alone. Everything else — preview, transport, render, hot reload — is
 * unchanged from when it was a pane.
 */

'use strict';

const { $, api, enc, toast, toastError } = StudioUtil;

const state = {
  sceneId: null,
  config: null,
  frame: 0,
  playing: false,
  playTimer: null,
  events: null,      // SSE hot-reload stream
  jobId: null,
  jobTimer: null,
  frameReady: Promise.resolve(),
  render: null,      // {text, busy} mirrored into the shell's status bar
  hot: false,        // hot reload connected
};

const sceneUrl = (suffix = '') => `/api/scenes/${enc(state.sceneId)}${suffix}`;
const filmIdOf = (sceneId) => sceneId.split('/').slice(0, 2).join('/');

/* ------------------------------ the document ---------------------------- */

/* What the shell needs to draw a tab and a status bar for this document. It
 * asks; this file never reaches up into the shell's DOM. */
const doc = {
  kind: 'scene',
  get id() { return state.sceneId; },
  title: () => state.config?.name ?? state.sceneId?.split('/').pop() ?? 'scene',
  status: () => {
    const out = [];
    if (state.sceneId) {
      out.push({ text: state.sceneId.split('/').join(' / '), cls: 'mono', title: state.sceneId });
    }
    if (state.render) out.push({ text: state.render.text, cls: 'mono accent' + (state.render.busy ? ' busy' : '') });
    if (state.sceneId) {
      out.push({ text: state.hot ? '⟳ watching' : '⚠ not watching', cls: 'mono' + (state.hot ? ' ok' : ''), align: 'right',
        title: 'hot reload: the Studio is watching this scene’s files' });
    }
    return out;
  },
  /* The preview is scaled to fit its box, and a document that loaded behind a
   * full-stage page had no box to fit. */
  shown: () => { try { fitPreview(); } catch { /* not up yet */ } },
  suspend: () => { try { stopPlayback(); scenePanels.stopAudition(); } catch { /* not up yet */ } },
};

const shell = StudioUtil.registerDocument(doc);
const sync = () => StudioUtil.syncDocument();

/* -------------------------------- scenes -------------------------------- */

async function openScene(id) {
  stopPlayback();
  scenePanels.stopAudition(); // a clip from the previous scene would keep playing with its stop button gone
  stopJobPolling();
  state.events?.close();
  state.sceneId = id;
  const scene = await api(sceneUrl());
  state.config = scene.config;
  state.frame = 0;

  document.title = `${scene.name} — Motion Studio`;
  $('#scene-title').textContent = scene.name;
  setFilmCrumb(filmIdOf(id), id);
  updateMeta();
  // One call points config, audio, assets and outputs at the new scene; the
  // config it already fetched is handed over rather than fetched twice.
  scenePanels.setScene({ id, config: scene.config, path: scene.path }).catch(toastError);
  syncPanelTab();
  sync();

  // Hot reload stream.
  const es = new EventSource(sceneUrl('/events'));
  const dot = $('#hot-reload-dot');
  es.onopen = () => { dot.classList.add('live'); state.hot = true; sync(); };
  es.onmessage = () => {
    dot.classList.add('flash');
    setTimeout(() => dot.classList.remove('flash'), 400);
    reloadPreview({ refetchConfig: true });
  };
  es.onerror = () => { dot.classList.remove('live'); state.hot = false; sync(); };
  state.events = es;

  reloadPreview();
}

/**
 * Standalone, a scene still names the film it belongs to and links back: a
 * scene id is "<ws>/<film>/<scene>", so no origin parameter is needed. Embedded
 * the crumb is hidden by CSS — the Explorer is right there, permanently, which
 * is the whole point of the shell.
 */
function setFilmCrumb(filmId, sceneId) {
  const slug = sceneId.split('/').slice(2).join('/');
  const crumb = $('#film-crumb');
  const name = filmId.split('/')[1];
  crumb.textContent = `← ${name}`;
  crumb.title = `${name} — back to the film, with this scene selected`;
  crumb.href = `/film.html?id=${enc(filmId)}&scene=${enc(slug)}`;
}

function updateMeta() {
  const c = state.config;
  $('#viewport-meta').textContent =
    `${c.width}×${c.height} · ${c.fps}fps · ${c.durationInFrames}f · ${c.output.format}` +
    (c.output.transparent ? ' · alpha' : '');
  const scrub = $('#scrubber');
  scrub.max = c.durationInFrames - 1;
  $('#frame-total').textContent = c.durationInFrames - 1;
}

/* ------------------------------- preview -------------------------------- */

function fitPreview() {
  const c = state.config;
  if (!c) return;
  const box = $('#viewport').getBoundingClientRect();
  const scale = Math.min((box.width - 2) / c.width, (box.height - 2) / c.height, 1);
  const w = c.width * scale, h = c.height * scale;
  const left = (box.width - w) / 2, top = (box.height - h) / 2;
  for (const el of [$('#preview'), $('#checker')]) {
    el.style.width = c.width + 'px';
    el.style.height = c.height + 'px';
    el.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  }
  $('#checker').style.display = c.output.transparent ? 'block' : 'none';
}

async function reloadPreview({ refetchConfig = false } = {}) {
  if (refetchConfig) {
    try {
      const scene = await api(sceneUrl());
      state.config = scene.config;
      updateMeta();
      // Adopt, don't re-setScene: a hot reload must not discard audio-track
      // edits the user has staged but not saved.
      scenePanels.adoptConfig(scene.config);
    } catch { /* keep previous */ }
  }
  const iframe = $('#preview');
  const entry = state.config.entry || 'composition.html';
  iframe.src = `/preview/${enc(state.sceneId)}/${entry}?t=${Date.now()}`;
  state.frameReady = new Promise((resolve) => {
    iframe.onload = async () => {
      fitPreview();
      state.frame = Math.min(state.frame, state.config.durationInFrames - 1);
      await applyFrame(state.frame);
      resolve();
    };
  });
}

async function applyFrame(n) {
  state.frame = n;
  const scrub = $('#scrubber');
  scrub.value = n;
  scrub.style.setProperty('--pos', `${(n / Math.max(1, scrub.max)) * 100}%`);
  $('#frame-now').textContent = n;
  const sec = n / state.config.fps;
  $('#timecode').textContent =
    String(Math.floor(sec / 60)).padStart(2, '0') + ':' +
    (sec % 60).toFixed(2).padStart(5, '0');
  try {
    const win = $('#preview').contentWindow;
    if (win && typeof win.setFrame === 'function') await win.setFrame(n);
  } catch { /* iframe mid-reload */ }
}

/* ------------------------------ transport ------------------------------- */

function startPlayback() {
  if (state.playing || !state.config) return;
  state.playing = true;
  $('#btn-play').textContent = '⏸';
  $('#btn-play').classList.add('playing');
  const frameMs = 1000 / state.config.fps;
  let last = performance.now();
  let carry = 0;
  const tick = (now) => {
    if (!state.playing) return;
    carry += now - last;
    last = now;
    if (carry >= frameMs) {
      const advance = Math.floor(carry / frameMs);
      carry -= advance * frameMs;
      applyFrame((state.frame + advance) % state.config.durationInFrames);
    }
    state.playTimer = requestAnimationFrame(tick);
  };
  state.playTimer = requestAnimationFrame(tick);
}

function stopPlayback() {
  state.playing = false;
  cancelAnimationFrame(state.playTimer);
  const btn = $('#btn-play');
  btn.textContent = '▶';
  btn.classList.remove('playing');
}

$('#btn-play').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));
$('#btn-step-back').addEventListener('click', () => { stopPlayback(); applyFrame(Math.max(0, state.frame - 1)); });
$('#btn-step-fwd').addEventListener('click', () => { stopPlayback(); applyFrame(Math.min(state.config.durationInFrames - 1, state.frame + 1)); });
$('#scrubber').addEventListener('input', (e) => { stopPlayback(); applyFrame(Number(e.target.value)); });
// The same transport keys as the film document: shift steps by ten, Home and
// End go to the ends. Two surfaces that scrub must not have two keyboards.
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || !state.config) return;
  const last = state.config.durationInFrames - 1;
  const step = e.shiftKey ? 10 : 1;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stopPlayback() : startPlayback(); }
  if (e.code === 'ArrowLeft') { stopPlayback(); applyFrame(Math.max(0, state.frame - step)); }
  if (e.code === 'ArrowRight') { stopPlayback(); applyFrame(Math.min(last, state.frame + step)); }
  if (e.code === 'Home') { stopPlayback(); applyFrame(0); }
  if (e.code === 'End') { stopPlayback(); applyFrame(last); }
});
/* Watch the box, not the window: a document mounted behind another tab — or
 * behind a full-stage page — starts at zero size and only gets a real one
 * later, and a `resize` on the window is not guaranteed to be how it hears
 * about that. Same reason the film document watches its timeline viewport. */
new ResizeObserver(() => fitPreview()).observe($('#viewport'));

/* -------------------------------- render -------------------------------- */

function parseRange(text, total) {
  const t = text.trim();
  if (!t) return undefined;
  const m = /^(\d+)\s*[-–:]\s*(\d+)$/.exec(t);
  if (!m) throw new Error('range must look like 0-89');
  const range = [Number(m[1]), Number(m[2])];
  if (range[1] >= total) throw new Error(`end frame max is ${total - 1}`);
  return range;
}

function setRenderStatus(text, { busy = false } = {}) {
  state.render = text ? { text, busy } : null;
  sync();
}

$('#btn-render').addEventListener('click', async () => {
  try {
    const body = {
      workers: Number($('#rd-workers').value),
      frameRange: parseRange($('#rd-range').value, state.config.durationInFrames),
    };
    const job = await api(sceneUrl('/render'), { method: 'POST', body });
    trackJob(job.jobId);
  } catch (err) {
    toastError(err);
  }
});

$('#btn-still').addEventListener('click', async () => {
  try {
    const res = await api(sceneUrl('/still'), { method: 'POST', body: { frame: state.frame } });
    scenePanels.reloadOutputs();
    const a = $('#job-download');
    $('#job-card').classList.remove('hidden');
    a.classList.remove('hidden');
    a.textContent = `⤓ ${res.outputPath.split(/[\\/]/).pop()} (frame ${res.frame})`;
    a.href = `/api/scenes/${enc(state.sceneId)}/output?file=${enc(res.outputPath.split(/[\\/]/).pop())}&download=1`;
  } catch (err) {
    toastError(err);
  }
});

function trackJob(jobId) {
  stopJobPolling();
  state.jobId = jobId;
  $('#job-card').classList.remove('hidden');
  $('#job-download').classList.add('hidden');
  $('#btn-cancel').disabled = false;
  const poll = async () => {
    try {
      const s = await api(`/api/jobs/${jobId}`);
      const pill = $('#job-state');
      pill.textContent = s.state + (s.queuePosition ? ` #${s.queuePosition}` : '');
      pill.className = `pill ${s.state}`;
      $('#job-phase').textContent = s.phase;
      $('#job-bar').style.width = `${s.percent}%`;
      $('#job-frames').textContent = `${s.framesDone}/${s.totalFrames} frames`;
      $('#job-fps').textContent = s.renderFps ? `${s.renderFps} fps` : '';
      $('#job-eta').textContent = s.etaMs != null ? `eta ${(s.etaMs / 1000).toFixed(1)}s` : '';
      setRenderStatus(`⟳ ${s.state} ${s.percent ?? 0}%`, { busy: true });
      const { logs } = await api(`/api/jobs/${jobId}/logs?tail=40`);
      $('#job-logs').textContent = logs.map((l) => `[${l.level}] ${l.message}`).join('\n');

      if (['done', 'error', 'cancelled'].includes(s.state)) {
        stopJobPolling();
        setRenderStatus(s.state === 'done' ? '✓ rendered' : `⊗ ${s.state}`);
        setTimeout(() => setRenderStatus(null), 6000);
        $('#btn-cancel').disabled = true;
        $('#job-eta').textContent = '';
        if (s.state === 'done') {
          $('#job-bar').style.width = '100%';
          const file = s.outputPath.split(/[\\/]/).pop();
          const a = $('#job-download');
          a.classList.remove('hidden');
          a.textContent = `⤓ ${file}`;
          a.href = `/api/scenes/${enc(state.sceneId)}/output?file=${enc(file)}&download=1`;
        }
        scenePanels.reloadOutputs();
      }
    } catch {
      stopJobPolling();
    }
  };
  poll();
  state.jobTimer = setInterval(poll, 500);
}

function stopJobPolling() {
  clearInterval(state.jobTimer);
  state.jobTimer = null;
}

$('#btn-cancel').addEventListener('click', () => {
  if (state.jobId) api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' }).catch(() => {});
});

/* ----------------------------- scene panels ------------------------------ */

/* config · audio · assets · outputs come from scene-panels.js — the one
 * implementation every surface mounts, so a scene cannot mean two different
 * things depending on where you opened it. The render tab is this document's
 * own: it drives the job card, the still export and the preview, none of which
 * the film inspector has. */

const scenePanels = ScenePanels.create({
  host: $('.panel'),
  api,
  toast,
  toastError,
  onConfigChanged(config) {
    state.config = config;
    updateMeta();
    reloadPreview();
    sync();                    // the tab title may have just changed
    shell?.treeChanged();      // …and so may the Explorer's row for this scene
  },
  onSceneDeleted() {
    // The document's subject is gone, so the document goes with it.
    shell?.treeChanged();
    if (shell) shell.closeDocument({ kind: 'scene', id: state.sceneId });
    else location.href = '/';
  },
});

const activeTabName = () => $('nav.tabs .tab.active')?.dataset.tab ?? 'render';

/** The render tab is this document's own markup; the other four are the module's. */
function syncPanelTab() {
  const tab = activeTabName();
  $('#tab-render').classList.toggle('hidden', tab !== 'render');
  scenePanels.show(tab === 'render' ? null : tab);
}

/* Scoped to the panel's own nav so it cannot catch a tab row inside a panel. */
for (const tab of document.querySelectorAll('nav.tabs .tab')) {
  tab.addEventListener('click', () => {
    // Picking a tab while collapsed means you want to see it.
    if ($('#workbench').classList.contains('panel-collapsed')) setPanelCollapsed(false);
    document.querySelectorAll('nav.tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    syncPanelTab();
    // Files can change on disk under an open scene; the staged audio draft is
    // deliberately NOT reset here, so switching tabs never eats unsaved edits.
    if (tab.dataset.tab === 'outputs') scenePanels.reloadOutputs();
    if (tab.dataset.tab === 'assets') scenePanels.reloadAssets();
  });
}

/* --------------------------- collapsible panel --------------------------- */

/* Collapsing leaves the tab bar in place, so the viewport gets the full height
 * for scrubbing without losing the way back. */
function setPanelCollapsed(collapsed) {
  $('#workbench').classList.toggle('panel-collapsed', collapsed);
  const btn = $('#btn-panel-toggle');
  btn.textContent = collapsed ? '▴' : '▾';
  btn.title = collapsed ? 'expand this panel' : 'collapse this panel';
  localStorage.setItem('ms.panelCollapsed', collapsed ? '1' : '');
  requestAnimationFrame(fitPreview); // re-fit after the grid row resizes
}
$('#btn-panel-toggle').addEventListener('click', () =>
  setPanelCollapsed(!$('#workbench').classList.contains('panel-collapsed')));
if (localStorage.getItem('ms.panelCollapsed') === '1') setPanelCollapsed(true);

/* The render tab's worker count defaults to the global setting, until the human
 * picks one for this scene. It moved here with the tab it belongs to. */
api('/api/settings')
  .then((data) => {
    const w = $('#rd-workers');
    if (!w.dataset.touched) w.value = String(data.settings.render.defaultWorkers);
  })
  .catch(() => { /* the default in the markup is fine */ });
$('#rd-workers').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });

/* --------------------------------- boot ---------------------------------- */

/* The shell passes the scene in the iframe's own query string, so a document is
 * addressable either way: as a tab, and as /scene.html?scene=<id> on its own. */
const wanted = new URLSearchParams(location.search).get('scene');
if (wanted) {
  openScene(wanted).catch((err) => {
    toastError(err);
    $('#scene-title').textContent = 'scene not found';
  });
}

/* The shell owns Ctrl+P, but the keystroke lands wherever the focus is — and
 * the focus is usually inside a document. Hand it up rather than swallowing it. */
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'p') return;
  if (document.querySelector('dialog[open]')) return;
  const s = StudioUtil.shell();
  if (!s) return;
  e.preventDefault();
  s.openPalette(e.shiftKey ? 'commands' : 'files');
});
