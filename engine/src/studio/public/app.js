/* Motion Studio — the Studio shell (vanilla JS, no build step).
 *
 * v0.27: this file is no longer "the page with the scene editor in it". It is
 * the shell — the Explorer tree of every workspace → film → scene on the
 * machine, the document tabs, the editor stack those documents mount into, the
 * activity bar, the status bar, and the full-stage pages that are not documents
 * (vendors, global settings, the shared library).
 *
 * Films and scenes are documents: /film.html and /scene.html, mounted as
 * same-origin iframes so each keeps its own state while another is in front,
 * and so two open films cannot fight over the same element ids. Nothing here
 * navigates any more.
 */

'use strict';

const { $, api, enc, toast, toastError } = StudioUtil;

/* The shell's own state. Everything a *document* knows — the open scene, its
 * config, the playhead, the render job — now lives in that document. */
const state = {
  tree: [],             // workspaces (each with films) from GET /api/workspaces
  filmScenes: {},       // filmId → scene list, fetched lazily when a film expands
  libraryWs: null,      // workspace id whose library page is showing, or null
  settings: null,       // global settings (GET /api/settings)
  settingsOpen: false,
};

/* Ids are slug paths; every route takes them URL-encoded as one segment. */
const filmIdOf = (sceneId) => sceneId.split('/').slice(0, 2).join('/');

/* Small shared helpers live with the shared panels rather than being declared
 * once per document — scene-panels.js is loaded before this file on both. */
const { fmtBytes, copyText, flashButton } = ScenePanels;

/* ------------------------------ prereqs ------------------------------- */

/**
 * Turn a /api/prereqs response into human sentences. The response has no
 * `problems` array — it reports node/ffmpeg blocks — so the text is derived
 * from those, and an ffmpeg failure names the binary that was probed and
 * where the path came from (settings vs PATH). An anonymous "prerequisites
 * missing" is useless when the cause is a typo in the settings dialog.
 */
function prereqProblems(p) {
  const out = [];
  const node = p.node ?? {};
  if (!node.found) out.push('Node.js not found');
  else if (node.meetsMinimum === false) out.push(`Node.js ${node.version} is below the minimum (${p.minimums?.node ?? '18.0.0'})`);

  const ff = p.ffmpeg ?? {};
  const where = ff.effectivePath ? ` at ${ff.effectivePath}` : '';
  const source = ff.source === 'settings' ? ' (path from settings — clear it to use PATH)' : '';
  if (!ff.found) out.push(`ffmpeg not found${where}${source}`);
  else if (ff.meetsMinimum === false) out.push(`ffmpeg ${ff.version} is below the minimum (${p.minimums?.ffmpeg ?? '5.0'})${where}`);
  return out;
}

async function checkPrereqs() {
  try {
    const p = await api('/api/prereqs');
    const el = $('#engine-status');
    const banner = $('#prereq-banner');
    if (p.ok) {
      el.innerHTML = `engine <span class="ok">ready</span> · ffmpeg ${p.ffmpeg?.version ?? '?'}`;
      banner.classList.add('hidden');
    } else {
      el.innerHTML = `engine <span class="err">missing prereqs</span>`;
      const problems = prereqProblems(p);
      banner.textContent = problems.length
        ? 'Prerequisites missing: ' + problems.join(' · ')
        : 'Prerequisites missing (see ⚙ settings for the ffmpeg path).';
      banner.classList.remove('hidden');
    }
    setStatusProblems(p.ok ? 0 : Math.max(1, prereqProblems(p).length), 'open global settings');
  } catch {
    $('#engine-status').innerHTML = 'engine <span class="err">unreachable</span>';
    setStatusProblems(1, 'the engine is unreachable');
  }
}

/** The status bar's problem count — VS Code's ⊗ N, clicking through to the
 *  place the problem is fixed. */
function setStatusProblems(n, title) {
  const btn = $('#sb-problems');
  btn.textContent = n ? `⊗ ${n}` : '';
  btn.title = title ?? '';
  btn.classList.toggle('hidden', !n);
}

/* --------------------------- workspace tree ---------------------------- */

/* One tree, not tabbed lists: workspace header
 * rows, films under each workspace, scenes under an expanded film, plus a
 * library row per workspace. Collapse state persists across reloads. */

function loadIdSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); } // stale/corrupt value: start fresh rather than crash
}
const saveIdSet = (key, set) => localStorage.setItem(key, JSON.stringify([...set]));
const collapsedWs = loadIdSet('ms.wsCollapsed');   // workspaces default OPEN
const expandedFilms = loadIdSet('ms.filmsOpen');   // films default CLOSED

/** tiny element helper — the tree builds a lot of spans */
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

async function loadWorkspaces() {
  const { workspaces } = await api('/api/workspaces');
  state.tree = workspaces;
  // Scene lists are per-film fetches; refresh the ones that are showing.
  const showing = [...expandedFilms].filter((fid) =>
    workspaces.some((w) => w.films.some((f) => f.id === fid)));
  await Promise.all(showing.map((fid) => loadFilmScenes(fid).catch(() => {})));
  renderTree();
}

async function loadFilmScenes(filmId) {
  StudioPalette.invalidate(); // the quick-open index just went stale
  const { sceneFolders } = await api(`/api/films/${enc(filmId)}`);
  state.filmScenes[filmId] = sceneFolders;
  return sceneFolders;
}

function renderTree() {
  const ul = $('#workspace-tree');
  ul.innerHTML = '';
  if (!state.tree.length) {
    ul.appendChild(el('li', 'dim tree-note', 'no workspaces yet — “+ workspace” starts one'));
    return;
  }
  for (const ws of state.tree) {
    const open = !collapsedWs.has(ws.id);

    const wsRow = el('li', 'tree-ws');
    const name = el('span', 'ws-name', ws.name);
    name.title = `${ws.name} — ${ws.path}`;
    const add = el('button', 'ghost tiny tree-add', '+ film');
    add.title = 'new film in this workspace';
    add.addEventListener('click', (e) => { e.stopPropagation(); openNewFilmDialog(ws.id); });
    wsRow.append(el('span', 'chev', open ? '▾' : '▸'), name, add);
    wsRow.addEventListener('click', () => {
      if (open) collapsedWs.add(ws.id); else collapsedWs.delete(ws.id);
      saveIdSet('ms.wsCollapsed', collapsedWs);
      renderTree();
    });
    ul.appendChild(wsRow);
    if (!open) continue;

    for (const f of ws.films) appendFilmRows(ul, f);
    if (!ws.films.length) {
      // The row's "+ film" only appears on hover, which would leave a fresh
      // workspace with no visible way forward — so the empty state IS the button.
      const first = el('li', 'tree-note tree-first-film');
      first.append(el('span', 'p-name dim', '+ first film'));
      first.title = 'create this workspace\'s first film';
      first.addEventListener('click', () => openNewFilmDialog(ws.id));
      ul.appendChild(first);
    }

    // Library row: the workspace's shared-asset surface (the human uploads,
    // the agent consumes via list_shared_assets / use_shared_asset).
    const lib = el('li', 'tree-lib' + (state.libraryWs === ws.id ? ' active' : ''));
    lib.append(
      el('span', 'chev', ''),
      el('span', 'p-name', '⧉ library'),
      el('span', 'p-meta', `${ws.library.files} file${ws.library.files === 1 ? '' : 's'}`),
    );
    lib.title = `shared assets for this workspace's agent (${fmtBytes(ws.library.bytes)})`;
    lib.addEventListener('click', () => openLibrary(ws.id));
    ul.appendChild(lib);
  }
}

/**
 * What a film row says it holds. Scenes and footage are counted separately
 * because they are different things: only scenes expand into rows beneath, so
 * a film of pure footage that claimed "1sc" would open onto nothing.
 */
function filmCount(f) {
  const clips = f.footage ?? 0;
  if (!clips) return `${f.scenes}sc`;
  const c = `${clips} clip${clips === 1 ? '' : 's'}`;
  return f.scenes ? `${f.scenes}sc · ${c}` : c;
}

/** One film row, plus its scene rows when expanded. */
function appendFilmRows(ul, f) {
  const fOpen = expandedFilms.has(f.id);

  const row = el('li', 'tree-film' + (f.broken ? ' missing' : ''));
  const chev = el('button', 'chev chev-btn', fOpen ? '▾' : '▸');
  chev.title = fOpen ? 'hide scenes' : 'show scenes';
  chev.addEventListener('click', (e) => { e.stopPropagation(); toggleFilm(f.id); });
  const name = el('span', 'p-name', f.name);
  name.title = f.broken ? `${f.name} — film.json is broken or missing` : `${f.name} — watch, advise, and edit`;
  const meta = el('span', 'p-meta', f.broken ? 'broken' : filmCount(f));
  const del = el('button', 'film-del', '✕');
  del.title = 'delete this film…';
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteFilm(f); });
  row.append(chev, name, meta, del);
  // One page per film (v0.23.1). It opens in watch & advise and carries the
  // production editor behind a toggle — there is no second surface to choose.
  row.addEventListener('click', () => openDocument({ kind: 'film', id: f.id, name: f.name }));
  ul.appendChild(row);
  if (!fOpen) return;

  const scenes = state.filmScenes[f.id];
  if (!scenes) {
    ul.appendChild(el('li', 'dim tree-note tree-note-scene', 'loading…'));
    return;
  }
  for (const s of scenes) {
    const sRow = el('li',
      'tree-scene' + (docs.has(docKey('scene', s.id)) ? ' active' : '') + (s.missing ? ' missing' : ''));
    const sName = el('span', 'p-name', s.name);
    sName.title = s.id;
    sRow.append(sName, el('span', 'p-meta', s.missing ? 'missing' : s.unlisted ? 'unlisted' : ''));
    if (!s.missing) sRow.addEventListener('click', () => openDocument({ kind: 'scene', id: s.id, name: s.name }));
    ul.appendChild(sRow);
  }
  const addScene = el('li', 'tree-scene scene-add');
  addScene.append(el('span', 'p-name dim', '+ scene'));
  addScene.title = 'scaffold a new scene into this film';
  addScene.addEventListener('click', () => openNewSceneDialog(f.id));
  ul.appendChild(addScene);
}

function toggleFilm(filmId) {
  if (expandedFilms.has(filmId)) expandedFilms.delete(filmId);
  else if (!state.filmScenes[filmId]) {
    expandedFilms.add(filmId);
    loadFilmScenes(filmId).then(renderTree).catch(toastError);
  } else {
    expandedFilms.add(filmId);
  }
  saveIdSet('ms.filmsOpen', expandedFilms);
  renderTree();
}

/** Two plain confirms instead of a dialog: the second decides file deletion. */
async function deleteFilm(f) {
  if (!confirm(`Delete film "${f.name}"?`)) return;
  const deleteFiles = confirm(
    'Also delete the film folder on disk — its scenes, assets and rendered output?\n\n' +
    'OK: delete everything.\nCancel: remove only the film definition (film.json); all files stay.');
  try {
    await api(`/api/films/${enc(f.id)}${deleteFiles ? '?deleteFiles=1' : ''}`, { method: 'DELETE' });
    delete state.filmScenes[f.id];
    // Its documents are about a thing that no longer exists — so close them
    // without flushing, or the film page would try to save to a deleted film.
    for (const d of [...docs.values()]) {
      if (d.kind === 'film' ? d.id === f.id : filmIdOf(d.id) === f.id) closeDocument(d, { flush: false });
    }
    await loadWorkspaces();
  } catch (err) { toastError(err); }
}

$('#btn-new-workspace').addEventListener('click', async () => {
  const name = prompt('Workspace name:');
  if (!name || !name.trim()) return;
  try {
    await api('/api/workspaces', { method: 'POST', body: { name: name.trim() } });
    await loadWorkspaces();
  } catch (err) { toastError(err); }
});

/* --------------------------- collapsible rail --------------------------- */

/* Collapsing hides the Explorer completely. The activity bar's ☰ is the only
 * control for it (v0.27) — the rail used to carry its own «/» chevron as well,
 * which is one job with two buttons, and the 46px stub it collapsed to had
 * nothing to show once the vendor buttons moved to the activity bar. */
function setRailCollapsed(collapsed) {
  $('#frame').classList.toggle('rail-collapsed', collapsed);
  localStorage.setItem('ms.railCollapsed', collapsed ? '1' : '');
  syncExplorerIcon();
  // The active document sized itself to a box that just changed width.
  try { activeWindow()?.dispatchEvent(new Event('resize')); } catch { /* still loading */ }
}
if (localStorage.getItem('ms.railCollapsed') === '1') setRailCollapsed(true);

/* ---------------------------- global settings --------------------------- */

async function loadSettings() {
  const data = await api('/api/settings');
  state.settings = data.settings;
  state.environment = data.environment;
  return data;
}

/* ----------------------------- storage paths ---------------------------- */

/* v0.22. The data dir, the workspaces root and the settings file were listed
 * read-only in the environment block below, because there was nowhere to write
 * them to — settings.json cannot record its own location. core/paths.js gave
 * them a bootstrap file of their own, so they are fields now.
 *
 * Two things the markup can't say on its own, and both matter: which layer
 * decided each value (an env var wins, and then editing here would do nothing —
 * so the input is disabled and says why), and that an empty box means "the
 * default", which the placeholder spells out rather than leaving blank. */

const STORAGE_SOURCE_NOTE = {
  env: 'set by the environment',
  configured: 'configured here',
  default: 'default',
  legacy: 'carried over from your earlier install',
};

const storageFields = () => Array.from(document.querySelectorAll('#storage-fields .storage-field'));

function fillStorageFields(storage) {
  for (const el of storageFields()) {
    const info = storage?.locations?.[el.dataset.key];
    const input = el.querySelector('input');
    const hint = el.querySelector('.storage-hint');
    if (!info) { input.value = ''; hint.textContent = ''; continue; }
    // Only what the user actually chose goes in the box. Pre-filling the
    // resolved default would turn every save into a pin, and the next time the
    // default moved this install would silently not follow it.
    input.value = info.source === 'env' ? info.value : (info.stored ?? '');
    input.placeholder = info.default;
    input.disabled = !info.editable;
    el.classList.toggle('locked', !info.editable);
    const notes = [STORAGE_SOURCE_NOTE[info.source] ?? info.source];
    if (info.source === 'env') notes.push(info.env.name);
    if (!info.exists) notes.push(el.dataset.key === 'settingsFile' ? 'not written yet' : 'created on save');
    hint.textContent = `${info.value} · ${notes.join(' · ')}`;
  }
}

/**
 * The storage half of a save, or null when nothing was touched. All three
 * editable keys ride along once any of them changed, so clearing a box back to
 * the default is a change like any other rather than a no-op.
 */
function collectStorageChanges() {
  const locations = state.environment?.storage?.locations;
  if (!locations) return null;
  const patch = {};
  let changed = false;
  for (const el of storageFields()) {
    const info = locations[el.dataset.key];
    if (!info?.editable) continue;
    const value = el.querySelector('input').value.trim();
    patch[el.dataset.key] = value || null;
    if (value !== (info.stored ?? '')) changed = true;
  }
  return changed ? patch : null;
}

/** Show a notice that outlived the reload a relocation triggers. */
const RELOCATE_NOTICE = 'ms.relocateNotice';
const pendingNotice = sessionStorage.getItem(RELOCATE_NOTICE);
if (pendingNotice) {
  sessionStorage.removeItem(RELOCATE_NOTICE);
  toast(pendingNotice, { kind: 'info', timeoutMs: 12000 });
}

/** Show/hide the inline settings page (v0.22 — was a modal dialog). Mirrors
 *  showVendorsPage: it owns the stage while open, and closing restores
 *  whatever the scene state says should be there. */
function showSettingsPage(open) {
  if (open) {
    if (vendorState.openCapability) showVendorsPage(null);
    suspendActiveDocument();
  }
  state.settingsOpen = open;
  syncStagePages();
  $('#settings-page').classList.toggle('hidden', !open);
  $('#btn-settings').classList.toggle('active', open);
  state.settingsOpen = open;
}

$('#btn-settings').addEventListener('click', async () => {
  if (state.settingsOpen) { showSettingsPage(false); return; }
  try {
    const { settings, environment } = await loadSettings();
    const f = $('#settings-form');
    f.fps.value = settings.newSceneDefaults.fps;
    f.width.value = settings.newSceneDefaults.width;
    f.height.value = settings.newSceneDefaults.height;
    f.durationInFrames.value = settings.newSceneDefaults.durationInFrames;
    renderDeliverablePicker($('#settings-deliverable-defaults'),
      settings.newFilmDefaults?.deliverableIds ?? []);
    f.defaultWorkers.value = String(settings.render.defaultWorkers);
    f.reviewBlock.value = (settings.render.review?.block ?? []).join(', ');
    f.reviewWarn.value = (settings.render.review?.warn ?? []).join(', ');
    f.ffmpegPath.value = settings.ffmpeg.path ?? '';
    f.ffmpegCrf.value = settings.ffmpeg.defaultCrf ?? '';
    f.ffmpegPreset.value = settings.ffmpeg.defaultPreset ?? '';
    const fp = environment.ffmpeg;
    $('#ffmpeg-probe').innerHTML = fp?.found
      ? `<span class="ok">✓ ${fp.version}</span> via ${fp.source}`
      : `<span class="err">✗ not found</span> (${fp?.effectivePath ?? 'ffmpeg'})`;
    fillStorageFields(environment.storage);
    const dl = $('#settings-env');
    dl.innerHTML = '';
    const row = (k, v) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v ?? '—';
      dd.classList.toggle('dim', v == null);
      dl.append(dt, dd);
    };
    // The three storage paths used to head this list; they have their own
    // editable section now, and repeating them here would leave two answers to
    // the same question with only one of them writable.
    row('bootstrap file', environment.storage?.locationsFile);
    for (const [k, v] of Object.entries(environment.env)) row(k, v);
    showSettingsPage(true);
  } catch (err) {
    toastError(err);
  }
});
$('#btn-settings-close').addEventListener('click', () => showSettingsPage(false));
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#settings-msg');
  msg.textContent = '…';
  try {
    const reviewCodes = (value) => value.split(',').map((code) => code.trim()).filter(Boolean);
    const patch = {
      newSceneDefaults: {
        fps: Number(f.fps.value),
        width: Number(f.width.value),
        height: Number(f.height.value),
        durationInFrames: Number(f.durationInFrames.value),
      },
      newFilmDefaults: {
        deliverableIds: selectedDeliverableIds($('#settings-deliverable-defaults')),
      },
      render: {
        defaultWorkers: Number(f.defaultWorkers.value),
        review: {
          block: reviewCodes(f.reviewBlock.value),
          warn: reviewCodes(f.reviewWarn.value),
        },
      },
      ffmpeg: {
        path: f.ffmpegPath.value.trim() || null,
        defaultCrf: f.ffmpegCrf.value === '' ? null : Number(f.ffmpegCrf.value),
        defaultPreset: f.ffmpegPreset.value || null,
      },
    };
    const paths = collectStorageChanges();
    const body = { patch, ...(paths ? { paths } : {}) };
    const { settings, environment, relocated } = await api('/api/settings', { method: 'PATCH', body });
    state.settings = settings;
    if (environment) state.environment = environment;
    if (relocated?.moved) {
      // Everything on screen — the workspace tree, the open scene, its preview
      // iframe and its SSE watcher — is bound to the tree that just stopped
      // being the current one. A reload is the only honest way to re-derive it.
      msg.textContent = 'storage moved — reloading…';
      sessionStorage.setItem(RELOCATE_NOTICE,
        `Storage is now ${relocated.to.dataDir}. Nothing was moved — files still in the old location `
        + 'stay there. Restart any connected MCP agents so they follow.');
      setTimeout(() => location.reload(), 600);
      return;
    }
    if (environment) fillStorageFields(environment.storage);
    msg.textContent = 'saved ✓';
    // The binary may have changed — refresh the footer status/banner and the
    // probe line in place.
    checkPrereqs();
    api('/api/settings').then(({ environment }) => {
      const fp = environment.ffmpeg;
      $('#ffmpeg-probe').innerHTML = fp?.found
        ? `<span class="ok">✓ ${fp.version}</span> via ${fp.source}`
        : `<span class="err">✗ not found</span> (${fp?.effectivePath ?? 'ffmpeg'})`;
    }).catch(() => {});
  } catch (err) {
    msg.textContent = err.message;
  }
  setTimeout(() => { msg.textContent = ''; }, 4000);
});

/* ------------------------------ vendor pages ----------------------------- */

/* v0.17. Narration used to have exactly one source — the Windows speech exe —
 * so there was nothing to choose and nothing to show. With Azure AI Speech
 * alongside it, "which vendor speaks" is a real setting, and it is global: the
 * agents connected over MCP narrate through whatever is picked here.
 *
 * The page is data-driven from GET /api/vendors, but each card's *options* are
 * hand-written markup, because they genuinely differ — an exe path is not a
 * region, and only one of the vendors has 500 voices worth of filtering.
 *
 * v0.18: one capability per page. 🗣 tts and ♫ music in the footer each open
 * their own view (#cap-speech / #cap-music), and the save button writes only
 * the capability that is showing.
 *
 * v0.19: the per-card control is a checkbox, not a radio — a capability holds an
 * ordered *preference chain* and uses the highest-ranked vendor that is actually
 * available. The chain lives in `vendorState.chain` while the page is open and is
 * written as `tts.vendors` / `music.vendors` on save; the DOM order of the cards
 * never changes, so rank is shown as a badge rather than by moving anything. */

const vendorState = {
  report: null,        // the speech report
  music: null,         // the music report
  transcription: null, // the transcription report (v0.22)
  openCapability: null, // which page is showing: 'speech' | 'music' | 'transcription' | null
  voices: { system: [], azure: [], piper: [] },
  preview: null,       // the <audio> auditioning a voice/instrument sample
  formatsFilled: false,
  programsFilled: false,
  gmPrograms: [],      // GM program names, for favorite-chip labels
  favoritePrograms: [], // starred GM programs (v0.22); seeded from settings
  favoriteVoices: {},  // starred voices per vendor (v0.22); seeded from settings
  whisperFile: null,   // the recording picked for the transcription test
  whisperMeta: null,   // env hooks, model preference order, and the page's bounds
  // One visible vendor card per capability (v0.22 tabs); touched = user clicked.
  tab: { speech: null, music: null, transcription: null },
  tabTouched: { speech: false, music: false, transcription: false },
  // Edited preference order per capability; seeded from each report's `chain`.
  chain: { speech: [], music: [], transcription: [] },
};

/** The card ids belonging to a capability, in the DOM order they appear. */
const CAP_VENDORS = {
  speech: ['system', 'azure', 'piper', 'elevenlabs', 'openai', 'deepgram'],
  music: ['node', 'fluidsynth'],
  transcription: ['whisper-cpp'],
};

/** Page title + one line of what the capability decides. */
const CAP_LABELS = {
  speech: { title: 'tts vendors', subtitle: 'who narrates — for the Studio and every connected agent', noun: 'narration' },
  music: { title: 'music vendors', subtitle: 'who renders a note spec — for the Studio and every connected agent', noun: 'music' },
  transcription: {
    title: 'transcription vendors',
    subtitle: 'who reads speech out of a recording — for the Studio and every connected agent',
    noun: 'transcription',
  },
};

/**
 * The v0.20 cloud vendors all share one card shape — env-only key, a voice
 * pick, at most a couple of text knobs — so their cards are GENERATED from
 * this table instead of hand-written in index.html. Adding vendor #7 should
 * be a row here plus its settings knobs, not another 50 lines of markup.
 * (system/azure/piper keep their bespoke cards: exe paths, locale filters and
 * style selects don't fit the shared grammar.)
 */
const CLOUD_VENDOR_CARDS = [
  {
    id: 'elevenlabs',
    title: 'elevenlabs',
    summary: 'ElevenLabs cloud voices — the strongest voice quality of the cloud vendors. ' +
      'Free tier: 10,000 credits/month with API access (attribution required, no commercial license).',
    keyNote: 'Set the key with <code>setx ELEVENLABS_API_KEY "&lt;key&gt;"</code> (get one at elevenlabs.io → profile), then restart the Studio.',
    knobs: [
      { key: 'model', label: 'model', placeholder: 'eleven_multilingual_v2' },
      { key: 'outputFormat', label: 'output format', select: 'elevenlabs-formats' },
    ],
    voiceNone: '(first premade voice)',
  },
  {
    id: 'openai',
    title: 'openai tts',
    summary: 'OpenAI\'s gpt-4o-mini-tts — 13 voices, steerable with free-form style instructions. ' +
      'No free tier; roughly $0.015 per minute of audio.',
    keyNote: 'Set the key with <code>setx OPENAI_API_KEY "&lt;key&gt;"</code> (platform.openai.com → API keys), then restart the Studio.',
    knobs: [
      { key: 'model', label: 'model', placeholder: 'gpt-4o-mini-tts' },
      { key: 'instructions', label: 'style instructions', placeholder: 'Speak warmly, medium pace', wide: true },
    ],
    voiceNone: '(marin)',
  },
  {
    id: 'deepgram',
    title: 'deepgram aura',
    summary: 'Deepgram\'s Aura-2 voices — the most generous free cloud tier: $200 signup credit ' +
      '(≈6.6M characters), no card, no expiry.',
    keyNote: 'Set the key with <code>setx DEEPGRAM_API_KEY "&lt;key&gt;"</code> (console.deepgram.com), then restart the Studio.',
    knobs: [],
    voiceNone: '(aura-2-thalia-en)',
  },
];

/** Build the generated cloud cards once, after the piper card. Idempotent. */
function buildCloudVendorCards() {
  const piperCard = $('.vendor-card[data-vendor="piper"]');
  if (!piperCard || $('.vendor-card[data-vendor="elevenlabs"]')) return;
  for (const d of CLOUD_VENDOR_CARDS) {
    const card = document.createElement('article');
    card.className = 'vendor-card';
    card.dataset.vendor = d.id;
    const knobs = d.knobs.map((k) => k.select
      ? `<label${k.wide ? ' class="wide"' : ''}>${k.label}<select id="cv-${d.id}-${k.key}" data-fill="${k.select}"></select></label>`
      : `<label${k.wide ? ' class="wide"' : ''}>${k.label}<input id="cv-${d.id}-${k.key}" placeholder="${k.placeholder}" spellcheck="false"></label>`,
    ).join('\n');
    card.innerHTML = `
      <header class="vendor-head">
        <label class="radio">
          <input type="checkbox" name="speech-vendor" value="${d.id}">
          <span class="v-title">${d.title}</span>
        </label>
        <span class="rank mono hidden" data-rank="${d.id}"></span>
        <button class="ghost tiny" data-up="${d.id}" title="higher priority">▲</button>
        <button class="ghost tiny" data-down="${d.id}" title="lower priority">▼</button>
        <span class="pill" data-status="${d.id}">probing…</span>
      </header>
      <p class="dim v-summary">${d.summary}</p>
      <dl class="env-list mono" data-facts="${d.id}"></dl>
      <p class="v-error err-line hidden" data-error="${d.id}"></p>
      <div class="config-grid vendor-grid">
        <label class="wide">default voice<span class="voice-pick"><select data-voice="${d.id}"></select><button type="button" class="ghost tiny" data-fav-voice="${d.id}" title="star this voice — agents narrating are told to prefer starred voices">☆</button></span></label>
        ${knobs}
      </div>
      <div class="fieldrow vendor-test">
        <label class="grow">test line
          <input data-test-text="${d.id}" value="Motion Studio. Scene one, take one." maxlength="400">
        </label>
        <button class="ghost test-btn" data-test="${d.id}">▶ test</button>
        <span class="dim mono" data-test-msg="${d.id}"></span>
      </div>
      <p class="dim note">${d.keyNote}</p>`;
    // piper is the last static speech card, so appending keeps table order.
    piperCard.parentElement.appendChild(card);
  }
}
const capOf = (vendor) => Object.keys(CAP_VENDORS).find((c) => CAP_VENDORS[c].includes(vendor)) ?? 'speech';
const capReport = (cap) => (cap === 'speech' ? vendorState.report : vendorState[cap]);

const vendorEl = {
  status: (v) => $(`[data-status="${v}"]`),
  facts: (v) => $(`[data-facts="${v}"]`),
  error: (v) => $(`[data-error="${v}"]`),
  voice: (v) => $(`[data-voice="${v}"]`),
  testBtn: (v) => $(`[data-test="${v}"]`),
  testText: (v) => $(`[data-test-text="${v}"]`),
  testMsg: (v) => $(`[data-test-msg="${v}"]`),
  card: (v) => $(`.vendor-card[data-vendor="${v}"]`),
};

// Generated cards must exist BEFORE the module-scope binding loops below
// (checkboxes, ▲▼, test buttons all bind via querySelectorAll at load), so the
// shared handlers pick them up exactly like the hand-written cards.
buildCloudVendorCards();

function defList(dl, rows) {
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (v instanceof Node) dd.append(v);
    else {
      dd.textContent = v ?? '—';
      dd.classList.toggle('dim', v == null);
    }
    dl.append(dt, dd);
  }
}

/** "westeurope (from AZURE_SPEECH_REGION)" — a value is only useful with its origin. */
const withSource = (value, source) => (value == null ? null : source && source !== 'settings' ? `${value}  ← ${source}` : value);

/* A filesystem path is routinely longer than any field we can give it, and an
 * <input> cannot wrap. So every path box carries its current value as a
 * tooltip: hovering answers "what is actually in there" without selecting the
 * text and scrolling through it. Done on hover rather than on paint so it is
 * correct while typing and needs no hook in each painter. */
const PATH_INPUTS = '.path-fields input, .path-field input, .storage-field input';
const syncPathTitle = (el) => { el.title = el.value || el.placeholder || ''; };
document.addEventListener('mouseover', (e) => {
  if (e.target?.matches?.(PATH_INPUTS)) syncPathTitle(e.target);
}, true);
document.addEventListener('input', (e) => {
  if (e.target?.matches?.(PATH_INPUTS)) syncPathTitle(e.target);
});

/* ---------------------------- preference chain ---------------------------- */
/* Each card used to carry an "in use: yes (from settings)" fact row. It is gone
 * as of v0.19: the row was painted from the server's report, so the moment a box
 * was ticked it contradicted the card highlight beside it. Rank badge + the
 * "active" highlight + the summary line below now say the same thing and all
 * three follow the edit. Where the choice *came from* moved to the summary too —
 * it is a property of the chain, not of each vendor. */

/**
 * Which vendor a capability would actually use with the *currently edited*
 * chain: the first entry that probed available. Null when the chain is empty or
 * nothing in it is usable — the page says so rather than implying a winner.
 */
function effectiveVendor(cap) {
  const report = capReport(cap);
  const chain = vendorState.chain[cap];
  return chain.find((id) => report?.vendors.find((v) => v.id === id)?.available) ?? null;
}

/** Repaint every rank badge, checkbox, ▲▼ state and the chain summary line. */
function paintChain(cap) {
  const chain = vendorState.chain[cap];
  const report = capReport(cap);
  const effective = effectiveVendor(cap);

  for (const id of CAP_VENDORS[cap]) {
    const card = vendorEl.card(id);
    if (!card) continue;
    const idx = chain.indexOf(id);
    const enrolled = idx >= 0;
    card.querySelector('input[type="checkbox"]').checked = enrolled;
    // "active" keeps meaning what it always meant: the vendor that will run.
    card.classList.toggle('active', id === effective);
    card.classList.toggle('enrolled', enrolled && id !== effective);

    const rank = $(`[data-rank="${id}"]`);
    rank.classList.toggle('hidden', !enrolled || chain.length < 2);
    rank.textContent = enrolled ? `#${idx + 1}` : '';

    const up = $(`[data-up="${id}"]`);
    const down = $(`[data-down="${id}"]`);
    // Reordering is meaningless for a chain of one, and hiding rather than
    // disabling would make the header jump as boxes are ticked.
    for (const b of [up, down]) b.classList.toggle('hidden', chain.length < 2);
    up.disabled = !enrolled || idx === 0;
    down.disabled = !enrolled || idx === chain.length - 1;
  }

  const note = $(`#${cap}-chain-note`);
  const label = CAP_LABELS[cap].noun;
  // An env var outranks settings.json, so saving this page would change nothing
  // — the one case where the page must admit it is not in charge.
  const envOverride = report?.activeSource === 'env'
    ? ` — ${report.vendorEnv} is set, which overrides this page until it is cleared`
    : '';
  const order = chain.length > 1 ? `chain: ${chain.join(' → ')} — ` : '';

  let text, warn;
  if (!chain.length) {
    [text, warn] = [`no ${label} vendor ticked — tick at least one before saving`, true];
  } else if (!report) {
    [text, warn] = [`chain: ${chain.join(' → ')}`, false];
  } else if (!effective) {
    [text, warn] = [`chain: ${chain.join(' → ')} — none of these is set up on this machine, so ${label} will fail`, true];
  } else if (effective !== chain[0]) {
    const skipped = chain.slice(0, chain.indexOf(effective)).join(', ');
    [text, warn] = [`${order}${label} will use "${effective}" (${skipped} unavailable)`, true];
  } else {
    [text, warn] = [`${order}${label} will use "${effective}"`, false];
  }
  note.textContent = text + envOverride;
  note.classList.toggle('warn', warn || !!envOverride);
}

/** Tick/untick: a newly enrolled vendor joins at the end, as lowest priority. */
function toggleChainVendor(vendor, enrolled) {
  const cap = capOf(vendor);
  const chain = vendorState.chain[cap];
  const idx = chain.indexOf(vendor);
  if (enrolled && idx < 0) chain.push(vendor);
  else if (!enrolled && idx >= 0) chain.splice(idx, 1);
  paintChain(cap);
}

/** Move one vendor up (-1) or down (+1) the priority order. */
function moveChainVendor(vendor, delta) {
  const cap = capOf(vendor);
  const chain = vendorState.chain[cap];
  const idx = chain.indexOf(vendor);
  const to = idx + delta;
  if (idx < 0 || to < 0 || to >= chain.length) return;
  [chain[idx], chain[to]] = [chain[to], chain[idx]];
  paintChain(cap);
}

/**
 * Show one capability's vendor page ('speech' | 'music' | 'transcription'), or
 * close with null.
 * v0.18: the page holds a single capability at a time — 🗣 tts, ♫ music and
 * ✎ transcribe in the footer each open their own view — so narration settings
 * never render under a music heading, and saving one page cannot touch
 * another's config.
 */
function showVendorsPage(capability) {
  vendorState.openCapability = capability ?? null;
  const open = !!capability;
  if (open && state.settingsOpen) {
    // The stage holds one page at a time; opening a capability replaces settings.
    $('#settings-page').classList.add('hidden');
    $('#btn-settings').classList.remove('active');
    state.settingsOpen = false;
  }
  $('#vendors-page').classList.toggle('hidden', !open);
  for (const cap of Object.keys(CAP_VENDORS)) {
    $(`#cap-${cap}`).classList.toggle('hidden', capability !== cap);
  }
  $('#btn-tts').classList.toggle('active', capability === 'speech');
  $('#btn-music').classList.toggle('active', capability === 'music');
  $('#btn-transcribe').classList.toggle('active', capability === 'transcription');
  // Switching capability mid-clip would leave audio playing with its stop
  // button hidden; opening fresh makes this a no-op.
  stopVendorPreview();
  if (open) {
    $('#vendors-title').textContent = CAP_LABELS[capability].title;
    $('#vendors-subtitle').textContent = CAP_LABELS[capability].subtitle;
    suspendActiveDocument();
  }
  syncStagePages();
}

/** The open page's button toggles it closed; the other button switches capability. */
function toggleVendorsPage(capability) {
  const next = vendorState.openCapability === capability ? null : capability;
  showVendorsPage(next);
  if (next) loadVendors().catch((err) => setVendorMsg(err.message, true));
}
$('#btn-tts').addEventListener('click', () => toggleVendorsPage('speech'));
$('#btn-music').addEventListener('click', () => toggleVendorsPage('music'));
$('#btn-transcribe').addEventListener('click', () => toggleVendorsPage('transcription'));
$('#btn-vendors-close').addEventListener('click', () => showVendorsPage(null));
$('#btn-vendors-refresh').addEventListener('click', () => {
  setVendorMsg('re-probing…');
  loadVendors({ force: true }).then(() => setVendorMsg('')).catch((err) => setVendorMsg(err.message, true));
});

function setVendorMsg(text, isError = false) {
  const el = $('#vendors-msg');
  el.textContent = text;
  el.classList.toggle('err', isError);
  if (text && !isError) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
}

async function loadVendors({ force = false } = {}) {
  const data = await api(`/api/vendors${force ? '?force=1' : ''}`);
  vendorState.report = data.speech;
  vendorState.music = data.music;
  vendorState.transcription = data.transcription;
  vendorState.whisperMeta = data.whisper ?? null;
  // Re-seed the edited chains from the server's truth on every load, including
  // after a save — an in-progress edit is not worth preserving across a reload
  // the user asked for, and a stale chain would silently re-save the old order.
  vendorState.chain.speech = [...(data.speech.chain ?? [data.speech.active])];
  vendorState.chain.music = [...(data.music.chain ?? [data.music.active])];
  vendorState.chain.transcription = [...(data.transcription.chain ?? [data.transcription.active])];

  if (!vendorState.programsFilled) {
    const sel = $('#mu-program');
    sel.innerHTML = '';
    data.gmPrograms.forEach((name, program) => {
      const o = document.createElement('option');
      o.value = String(program);
      o.textContent = `${String(program).padStart(3, '0')} · ${name}`;
      sel.appendChild(o);
    });
    vendorState.programsFilled = true;
  }
  vendorState.gmPrograms = data.gmPrograms;

  if (!vendorState.formatsFilled) {
    const sel = $('#az-format');
    sel.innerHTML = '';
    for (const f of data.azure.outputFormats) {
      const o = document.createElement('option');
      o.value = f;
      // riff-24khz-16bit-mono-pcm → "24khz · 16bit mono"
      o.textContent = f.replace(/^riff-/, '').replace(/-16bit-mono-pcm$/, ' · 16-bit mono');
      sel.appendChild(o);
    }
    vendorState.formatsFilled = true;
  }

  const azureCfg = data.speech.settings.azure ?? {};
  $('#az-format').value = azureCfg.outputFormat ?? data.azure.outputFormats[0];

  // ElevenLabs' generated card has the only <select data-fill> today; filled
  // here (not in the builder) because the format list comes from the server.
  const elFormat = $('[data-fill="elevenlabs-formats"]');
  if (elFormat && !elFormat.options.length && data.elevenlabs?.outputFormats) {
    for (const f of data.elevenlabs.outputFormats) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      elFormat.appendChild(o);
    }
    elFormat.value = data.speech.settings.elevenlabs?.outputFormat ?? 'wav_24000';
  }

  for (const v of data.speech.vendors) paintVendor(v, data.speech);
  paintMusic(data.music);
  paintTranscription(data.transcription);
  paintChain('speech');
  paintChain('music');
  paintChain('transcription');

  const fv = data.speech.settings.favoriteVoices ?? {};
  vendorState.favoriteVoices = Object.fromEntries(Object.entries(fv).map(([k, v]) => [k, [...v]]));
  renderFavoriteVoices();
  // Land on the vendor that will actually run — until the user picks a tab.
  if (!vendorState.tabTouched.speech && data.speech.active) selectVendorTab('speech', data.speech.active);
  if (!vendorState.tabTouched.music && data.music.active) selectVendorTab('music', data.music.active);
  if (!vendorState.tabTouched.transcription && data.transcription.active) {
    selectVendorTab('transcription', data.transcription.active);
  }

  // Each capability gets its own environment block, under its own cards —
  // one shared list at the foot of the page meant the speech variables read as
  // if they belonged to whatever section they happened to land under.
  const { environment } = await api('/api/settings');
  const envRows = (re) => Object.keys(environment.env).filter((k) => re.test(k)).map((k) => [k, environment.env[k]]);
  defList($('#speech-env'), envRows(/SPEECH|TTS_VENDOR|TTS_EXE|PIPER|ELEVENLABS|XI_API|OPENAI|DEEPGRAM/));
  defList($('#music-env'), envRows(/MUSIC_VENDOR|SOUNDFONT|FLUIDSYNTH|MIDI_EXE/));
  defList($('#transcription-env'), envRows(/WHISPER|TRANSCRIPTION_VENDOR/));

  await Promise.all(data.speech.vendors
    .filter((v) => v.available)
    .map((v) => loadVendorVoices(v.id).catch(() => {})));
}

function paintVendor(v, report) {
  const pill = vendorEl.status(v.id);
  pill.textContent = v.available ? `ready · ${v.voiceCount} voices` : 'unavailable';
  pill.className = `pill ${v.available ? 'done' : 'error'}`;
  // The checkbox, rank badge and card highlight are painted from the edited
  // chain by paintChain(), which loadVendors() calls after this.

  const err = vendorEl.error(v.id);
  err.classList.toggle('hidden', !v.error);
  err.textContent = v.error ?? '';

  const c = v.config ?? {};
  const cloudCard = CLOUD_VENDOR_CARDS.find((d) => d.id === v.id);
  if (cloudCard) {
    // Generated cards share one fact grammar: where the key came from (masked),
    // any endpoint override, and the live catalogue size.
    defList(vendorEl.facts(v.id), [
      ['api key', c.keyConfigured ? `${c.keyMasked}  ← ${c.keySource}` : null],
      ['endpoint', c.endpointSource && c.endpointSource !== 'default' ? withSource(c.endpoint, c.endpointSource) : null],
      ['voices', v.available ? String(v.voiceCount) : null],
    ]);
    const stored = report.settings?.[v.id] ?? {};
    for (const knob of cloudCard.knobs) {
      const input = $(`#cv-${v.id}-${knob.key}`);
      if (input && !input.matches(':focus')) input.value = stored[knob.key] ?? '';
    }
    return;
  }
  if (v.id === 'system') {
    defList(vendorEl.facts(v.id), [
      ['executable', withSource(c.exePath, c.exeSource)],
      ['voices', v.available ? String(v.voiceCount) : null],
    ]);
  } else if (v.id === 'piper') {
    defList(vendorEl.facts(v.id), [
      ['command', withSource(c.command, c.commandSource)],
      ['voices folder', withSource(c.voicesDir, c.voicesSource)],
      ['voices', v.available ? String(v.voiceCount) : null],
    ]);
    const s = report.settings.piper ?? {};
    $('#pi-exe').value = s.exe ?? '';
    $('#pi-python').value = s.python ?? '';
    $('#pi-voices').value = s.voicesDir ?? '';
  } else {
    defList(vendorEl.facts(v.id), [
      ['api key', c.keyConfigured ? `${c.keyMasked}  ← ${c.keySource}` : null],
      ['region', withSource(c.region, c.regionSource)],
      ['endpoint', c.endpoint],
      ['voices', v.available ? `${v.voiceCount} · ${v.locales.length} locales` : null],
    ]);

    // An env-supplied region wins over the field, so show it and lock the input
    // rather than letting someone type a value that will never be used.
    const regionInput = $('#az-region');
    const fromEnv = c.regionSource && c.regionSource !== 'settings' && c.regionSource !== 'argument';
    regionInput.value = fromEnv ? c.region : (report.settings.azure?.region ?? '');
    regionInput.disabled = !!fromEnv;
    regionInput.title = fromEnv ? `set by ${c.regionSource} — clear that variable to edit here` : '';
    regionInput.closest('label').classList.toggle('disabled', !!fromEnv);

    const locales = $('#az-locale');
    if (locales.options.length <= 1 && v.locales?.length) {
      for (const loc of v.locales) {
        const o = document.createElement('option');
        o.value = loc;
        o.textContent = loc;
        locales.appendChild(o);
      }
      // Default the filter to the configured voice's locale so the select
      // opens on something usable instead of 500 unrelated names.
      const configured = report.settings.azure?.voice;
      if (configured) locales.value = v.locales.find((l) => configured.startsWith(l)) ?? '';
    }
  }
}

/** The music half of the page — same card grammar, different knobs. */
function paintMusic(report) {
  for (const v of report.vendors) {
    const pill = vendorEl.status(v.id);
    pill.textContent = v.available ? 'ready' : 'unavailable';
    pill.className = `pill ${v.available ? 'done' : 'error'}`;
    // Checkbox / rank / highlight come from paintChain(), as on the speech page.

    const err = vendorEl.error(v.id);
    err.classList.toggle('hidden', !v.error);
    err.textContent = v.error ?? '';

    const c = v.config ?? {};
    if (v.id === 'node') {
      defList(vendorEl.facts(v.id), [
        ['soundfont', c.soundfont],
        ['library', c.library],
        ['render', v.available ? `${c.sampleRate} Hz · gain ${c.gain}` : null],
        ]);
    } else {
      defList(vendorEl.facts(v.id), [
        ['midi exe', c.midiExe],
        ['fluidsynth', c.fluidsynth],
        ['soundfont', c.soundfont],
        ]);
    }
  }

  const s = report.settings ?? {};
  $('#mu-soundfont').value = s.node?.soundfont ?? '';
  $('#mu-samplerate').value = String(s.node?.sampleRate ?? 44100);
  $('#mu-gain').value = s.node?.gain ?? 1.575;
  $('#mu-target').value = s.targetPeakDb === null || s.targetPeakDb === undefined ? '' : String(s.targetPeakDb);
  vendorState.favoritePrograms = [...(s.favoritePrograms ?? [])];
  renderFavoritePrograms();
}

/* --------------------------- transcription ------------------------------ */

/** Human size for a model file — the only honest thing we know about a .bin. */
const fmtModelBytes = (n) => (n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/**
 * The transcription half of the page (v0.22). Same card grammar as speech and
 * music — pill, facts, error, config grid — with the model picker in place of a
 * voice picker.
 */
function paintTranscription(report, meta = vendorState.whisperMeta) {
  // The page test and the tool have different bounds on purpose — say both, so
  // "it refused my two-hour recording" is never a mystery.
  if (meta) {
    $('#wh-limits').textContent =
      `This test reads up to ${Math.round(meta.maxPreviewSeconds / 60)} minutes of a file; ` +
      `transcribe_asset handles up to ${Math.round(meta.maxSeconds / 60)} minutes. ` +
      'Nothing is written into a scene either way.';
  }
  for (const v of report.vendors) {
    const pill = vendorEl.status(v.id);
    pill.textContent = v.available
      ? `ready · ${v.config?.activeModel ?? '?'}`
      : 'unavailable';
    pill.className = `pill ${v.available ? 'done' : 'error'}`;

    const err = vendorEl.error(v.id);
    err.classList.toggle('hidden', !v.error);
    err.textContent = v.error ?? '';

    const c = v.config ?? {};
    defList(vendorEl.facts(v.id), [
      // `commandFolder` is set when the setting named a folder and the engine
      // found the binary inside it — say so, so a working setup that does not
      // literally match what is typed in the box is not a mystery.
      ['command', withSource(c.command, c.commandFolder ? `found in ${c.commandFolder}` : c.commandSource)],
      ['models folder', withSource(c.modelsDir, c.modelsDirSource)],
      ['model in use', v.available ? `${c.activeModel} · ${fmtModelBytes(c.activeModelBytes)}` : null],
      ['models found', c.modelCount == null ? null : String(c.modelCount)],
      ['threads', c.threads ? withSource(String(c.threads), c.threadsSource) : 'whisper default (4)'],
    ]);

    // The picker lists what is on disk; "(auto)" means the documented
    // preference order picks, which is what an unconfigured machine gets.
    const sel = $('#wh-model');
    const stored = report.settings?.whisper?.model ?? '';
    const models = v.models ?? [];
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = c.activeModel && !stored ? `(auto — ${c.activeModel})` : '(auto)';
    sel.appendChild(auto);
    // What "auto" means, in the order it means it — otherwise the choice looks
    // arbitrary on a machine holding several models.
    sel.title = meta?.modelPreference
      ? `(auto) picks the first of these that is installed: ${meta.modelPreference.join(', ')}`
      : '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = `${m.name}${m.englishOnly ? ' · english only' : ''}${m.bytes ? ` · ${fmtModelBytes(m.bytes)}` : ''}`;
      sel.appendChild(o);
    }
    if (stored && !models.some((m) => m.name === stored)) {
      // A configured model that is not on disk (or is named by full path) stays
      // selectable, so saving the page cannot silently drop it.
      const o = document.createElement('option');
      o.value = stored;
      o.textContent = `${stored} (configured)`;
      sel.appendChild(o);
    }
    sel.value = stored;
  }

  const s = report.settings ?? {};
  $('#wh-exe').value = s.whisper?.exe ?? '';
  $('#wh-models').value = s.whisper?.modelsDir ?? '';
  $('#wh-threads').value = s.whisper?.threads ?? '';
  $('#wh-language').value = s.whisper?.language ?? '';
}

/* --------------------- transcription test (read a file) ------------------ */

$('#wh-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0] ?? null;
  vendorState.whisperFile = file;
  $('#wh-file-name').textContent = file ? `${file.name} · ${fmtBytes(file.size)}` : 'no file chosen';
  vendorEl.testBtn('whisper-cpp').disabled = !file;
  $('#wh-result').classList.add('hidden');
});

/**
 * Read the chosen recording with the configured vendor and show what came back.
 *
 * The mirror of the voice preview: nothing is written into a scene, and the
 * point is to answer "is this model good enough, and how fast is it here"
 * before a film is built on it. The frames column is the same number an agent
 * would place a caption with, so the page shows the actual product of the tool
 * rather than a paraphrase of it.
 */
async function testTranscription() {
  const btn = vendorEl.testBtn('whisper-cpp');
  const msg = vendorEl.testMsg('whisper-cpp');
  const file = vendorState.whisperFile;
  if (!file) return;
  const model = $('#wh-model').value;
  const language = $('#wh-language').value.trim();
  const params = new URLSearchParams({ name: file.name });
  if (model) params.set('model', model);
  if (language) params.set('language', language);
  const idle = btn.dataset.idleLabel ?? btn.textContent;
  btn.dataset.idleLabel = idle;
  btn.disabled = true;
  btn.textContent = '…';
  msg.textContent = 'reading — whisper runs at a few times realtime, so this takes a moment';
  msg.classList.remove('err');
  try {
    const res = await fetch(`/api/vendors/transcription/whisper-cpp/preview?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `transcription failed (HTTP ${res.status})`);
    }
    const data = await res.json();
    $('#wh-result').classList.remove('hidden');
    $('#wh-result-text').textContent = data.text || '(no speech found in this file)';
    $('#wh-result-stats').textContent =
      `${data.sentences.length} sentences · ${data.wordCount} words · ${data.durationSeconds.toFixed(1)}s of audio ` +
      `read in ${(data.elapsedMs / 1000).toFixed(1)}s (${data.realtimeFactor}× realtime) · ${data.model} · ${data.language ?? '?'}`;
    const rows = $('#wh-result-rows');
    rows.innerHTML = '';
    for (const s of data.sentences) {
      const tr = document.createElement('tr');
      const p = s.minTokenP;
      tr.innerHTML =
        `<td class="num mono">${s.startInFrames}</td>` +
        `<td class="num mono">${s.durationInFrames}</td>` +
        `<td class="num mono${p != null && p < 0.5 ? ' err' : ''}">${p == null ? '—' : p.toFixed(2)}</td>` +
        '<td></td>';
      tr.lastElementChild.textContent = s.text;
      rows.appendChild(tr);
    }
    msg.textContent = `${data.realtimeFactor}× realtime`;
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('err');
  } finally {
    btn.disabled = false;
    btn.textContent = btn.dataset.idleLabel ?? '▶ read it';
  }
}
{
  // Its own binding rather than testVendor()'s loop: this button uploads a file
  // instead of synthesizing a sample. idleLabel is set here for the same reason
  // the others set it — stopVendorPreview() restores every .test-btn's label.
  const btn = vendorEl.testBtn('whisper-cpp');
  btn.dataset.idleLabel = btn.textContent;
  btn.addEventListener('click', testTranscription);
}

/* ------------------------- favorite instruments ------------------------- */

/** Chip list + star state for the audition instrument (v0.22). Starred
 *  programs save with the music settings and reach agents via list_vendors. */
function renderFavoritePrograms() {
  const list = $('#mu-fav-list');
  list.innerHTML = '';
  for (const p of vendorState.favoritePrograms) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'fav-chip mono';
    chip.title = 'remove from favorites';
    chip.textContent = `${String(p).padStart(3, '0')} · ${vendorState.gmPrograms[p] ?? '?'} ×`;
    chip.addEventListener('click', () => {
      vendorState.favoritePrograms = vendorState.favoritePrograms.filter((x) => x !== p);
      renderFavoritePrograms();
    });
    list.appendChild(chip);
  }
  if (!vendorState.favoritePrograms.length) {
    const hint = document.createElement('span');
    hint.className = 'dim';
    hint.textContent = 'none starred yet';
    list.appendChild(hint);
  }
  syncFavToggle();
}

function syncFavToggle() {
  const p = Number($('#mu-program').value) || 0;
  const starred = vendorState.favoritePrograms.includes(p);
  $('#mu-fav-toggle').textContent = starred ? '★ unfavorite' : '☆ favorite';
}

$('#mu-fav-toggle').addEventListener('click', () => {
  const p = Number($('#mu-program').value) || 0;
  vendorState.favoritePrograms = vendorState.favoritePrograms.includes(p)
    ? vendorState.favoritePrograms.filter((x) => x !== p)
    : [...vendorState.favoritePrograms, p].sort((a, b) => a - b);
  renderFavoritePrograms();
});
$('#mu-program').addEventListener('change', syncFavToggle);

/* --------------------------- favorite voices ---------------------------- */

/** Speech twin of the instrument favorites (v0.22): ☆ next to each vendor's
 *  voice picker, one shared chip row, saved as tts.favoriteVoices. */
function renderFavoriteVoices() {
  const list = $('#voice-fav-list');
  list.innerHTML = '';
  const entries = Object.entries(vendorState.favoriteVoices)
    .flatMap(([vendor, voices]) => voices.map((voice) => ({ vendor, voice })));
  for (const { vendor, voice } of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'fav-chip mono';
    chip.title = 'remove from favorites';
    chip.textContent = `${vendor} · ${voice} ×`;
    chip.addEventListener('click', () => {
      vendorState.favoriteVoices[vendor] = (vendorState.favoriteVoices[vendor] ?? []).filter((x) => x !== voice);
      renderFavoriteVoices();
    });
    list.appendChild(chip);
  }
  if (!entries.length) {
    const hint = document.createElement('span');
    hint.className = 'dim';
    hint.textContent = 'none starred yet';
    list.appendChild(hint);
  }
  syncFavVoiceButtons();
}

function syncFavVoiceButtons() {
  for (const btn of document.querySelectorAll('[data-fav-voice]')) {
    const vendor = btn.dataset.favVoice;
    const voice = vendorEl.voice(vendor)?.value ?? '';
    btn.textContent = voice && (vendorState.favoriteVoices[vendor] ?? []).includes(voice) ? '★' : '☆';
  }
}

for (const btn of document.querySelectorAll('[data-fav-voice]')) {
  btn.addEventListener('click', () => {
    const vendor = btn.dataset.favVoice;
    const voice = vendorEl.voice(vendor)?.value;
    if (!voice) return; // "(vendor default)" — a concrete voice must be picked first
    const cur = vendorState.favoriteVoices[vendor] ?? [];
    vendorState.favoriteVoices[vendor] = cur.includes(voice)
      ? cur.filter((x) => x !== voice)
      : [...cur, voice];
    renderFavoriteVoices();
  });
}
for (const sel of document.querySelectorAll('[data-voice]')) {
  sel.addEventListener('change', syncFavVoiceButtons);
}

/* ------------------------------ vendor tabs ------------------------------ */

/** One card at a time per capability (v0.22) — six speech cards made the page
 *  a long scroll. Tab labels come from each card's own title. */
function buildVendorTabs() {
  for (const cap of Object.keys(CAP_VENDORS)) {
    const nav = $(`#${cap}-tabs`);
    if (!nav || nav.children.length) continue;
    for (const vendor of CAP_VENDORS[cap]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.dataset.vendorTab = vendor;
      btn.textContent = vendorEl.card(vendor)?.querySelector('.v-title')?.textContent ?? vendor;
      btn.addEventListener('click', () => {
        vendorState.tabTouched[cap] = true;
        selectVendorTab(cap, vendor);
      });
      nav.appendChild(btn);
    }
    selectVendorTab(cap, CAP_VENDORS[cap][0]);
  }
}

function selectVendorTab(cap, vendor) {
  vendorState.tab[cap] = vendor;
  for (const v of CAP_VENDORS[cap]) {
    vendorEl.card(v)?.classList.toggle('tab-active', v === vendor);
  }
  const nav = $(`#${cap}-tabs`);
  for (const btn of nav.querySelectorAll('[data-vendor-tab]')) {
    btn.classList.toggle('active', btn.dataset.vendorTab === vendor);
  }
}
buildVendorTabs();

/** Fill one vendor's voice <select> (Azure honours the locale/search filters). */
async function loadVendorVoices(vendor) {
  const params = new URLSearchParams();
  if (vendor === 'azure') {
    const locale = $('#az-locale').value;
    const search = $('#az-search').value.trim();
    if (locale) params.set('locale', locale);
    if (search) params.set('search', search);
    params.set('limit', '300');
  }
  const qs = params.toString();
  const data = await api(`/api/vendors/speech/${vendor}/voices${qs ? `?${qs}` : ''}`);
  vendorState.voices[vendor] = data.voices;

  const sel = vendorEl.voice(vendor);
  // Azure and Piper have a stored default voice; the exe vendor's select is a
  // scratch control for the test line.
  const configured = vendorState.report?.settings?.[vendor]?.voice ?? null;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = {
    azure: '(auto — first neural en-US voice)',
    piper: '(first voice in the folder)',
    ...Object.fromEntries(CLOUD_VENDOR_CARDS.map((d) => [d.id, d.voiceNone])),
  }[vendor] ?? '(first installed voice)';
  sel.appendChild(none);
  for (const v of data.voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.locale
      ? `${v.name}${v.gender ? ` · ${v.gender.toLowerCase()}` : ''}${v.quality ? ` · ${v.quality}` : ''}` +
        `${v.styles?.length ? ` · ${v.styles.length} styles` : ''}`
      : v.name;
    sel.appendChild(o);
  }
  if (configured && data.voices.some((v) => v.name === configured)) sel.value = configured;
  else if (configured) {
    // Configured voice filtered out of view (or its file has gone): keep it
    // selectable so saving the page doesn't silently drop it.
    const o = document.createElement('option');
    o.value = configured;
    o.textContent = `${configured} (configured)`;
    sel.appendChild(o);
    sel.value = configured;
  }
  if (vendor === 'azure') syncAzureStyles();
  if (data.truncated) setVendorMsg(`showing ${data.voices.length} of ${data.total} voices — narrow with the locale filter`);
}

/** Styles belong to the voice, so the list follows the selection. */
function syncAzureStyles() {
  const sel = $('#az-style');
  const chosen = vendorEl.voice('azure').value;
  const voice = vendorState.voices.azure.find((v) => v.name === chosen);
  const styles = voice?.styles ?? [];
  const previous = sel.value;
  sel.innerHTML = '<option value="">(none)</option>';
  for (const s of styles) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  }
  const configured = vendorState.report?.settings?.azure?.style;
  const want = styles.includes(previous) ? previous : (configured && styles.includes(configured) ? configured : '');
  sel.value = want;
  sel.disabled = styles.length === 0;
  sel.closest('label').classList.toggle('disabled', styles.length === 0);
}

let voiceFilterTimer = null;
for (const id of ['#az-locale', '#az-search']) {
  $(id).addEventListener('input', () => {
    clearTimeout(voiceFilterTimer);
    voiceFilterTimer = setTimeout(() => loadVendorVoices('azure').catch((e) => setVendorMsg(e.message, true)), 200);
  });
}
vendorEl.voice('azure').addEventListener('change', syncAzureStyles);

// Each capability's chain is edited independently: ticking a speech vendor never
// touches the music page, and the two pages save separately.
for (const group of ['speech-vendor', 'music-vendor', 'transcription-vendor']) {
  for (const box of document.querySelectorAll(`input[name="${group}"]`)) {
    box.addEventListener('change', () => toggleChainVendor(box.value, box.checked));
  }
}
for (const btn of document.querySelectorAll('[data-up]')) {
  btn.addEventListener('click', () => moveChainVendor(btn.dataset.up, -1));
}
for (const btn of document.querySelectorAll('[data-down]')) {
  btn.addEventListener('click', () => moveChainVendor(btn.dataset.down, +1));
}

$('#btn-vendors-save').addEventListener('click', async () => {
  const cap = vendorState.openCapability ?? 'speech';
  const chain = vendorState.chain[cap];
  // An empty chain would leave the capability with nothing to resolve to, and
  // silently substituting a default is exactly the kind of guess this page is
  // supposed to make visible. Refuse, and say which page is wrong.
  // Transcription is the exception (v0.26): it is an optional capability with
  // one vendor, so "nothing ticked" is a legitimate machine state — whisper is
  // often simply not installed. Saving is allowed; the engine reports
  // transcription_unavailable with the fix, and picks whisper up the moment
  // the paths on this page (or the MOTION_STUDIO_WHISPER_* env) point at it.
  if (!chain.length && cap !== 'transcription') {
    setVendorMsg(`tick at least one ${CAP_LABELS[cap].noun} vendor before saving`, true);
    return;
  }
  setVendorMsg('saving…');
  try {
    // Each page saves only its own capability: the tts page cannot rewrite
    // music settings it isn't showing, and vice versa.
    let patch;
    if (cap === 'transcription') {
      patch = {
        transcription: {
          // The scalar stays a valid vendor name even when nothing is ticked
          // (settings validation requires it, and old readers expect one);
          // an unticked page saves vendors: null — "resolve the default, and
          // report unavailable honestly when it is not installed".
          vendor: chain[0] ?? 'whisper-cpp',
          vendors: chain.length ? chain : null,
          whisper: {
            exe: $('#wh-exe').value.trim() || null,
            // "" = the documented preference order picks; a name pins it.
            model: $('#wh-model').value || null,
            modelsDir: $('#wh-models').value.trim() || null,
            threads: $('#wh-threads').value === '' ? null : Number($('#wh-threads').value),
            language: $('#wh-language').value.trim() || null,
          },
        },
      };
    } else if (cap === 'music') {
      patch = {
        music: {
          // `vendor` stays the chain head so an older engine (or anything
          // reading the scalar) still sees a coherent single choice.
          vendor: chain[0],
          vendors: chain,
          targetPeakDb: $('#mu-target').value === '' ? null : Number($('#mu-target').value),
          // null when empty keeps "never used" and "un-starred everything"
          // looking the same in settings.json.
          favoritePrograms: vendorState.favoritePrograms.length ? [...vendorState.favoritePrograms] : null,
          node: {
            soundfont: $('#mu-soundfont').value.trim() || null,
            sampleRate: Number($('#mu-samplerate').value),
            gain: Number($('#mu-gain').value),
          },
        },
      };
    } else {
      const regionInput = $('#az-region');
      // Drop vendors whose star list is empty; null when nothing is starred
      // at all — same "never used" convention as music.favoritePrograms.
      const fv = Object.fromEntries(
        Object.entries(vendorState.favoriteVoices).filter(([, voices]) => voices.length),
      );
      patch = {
        tts: {
          vendor: chain[0],   // chain head, for anything reading the scalar
          vendors: chain,
          favoriteVoices: Object.keys(fv).length ? fv : null,
          azure: {
            // A disabled field is env-controlled: leave the stored value alone
            // instead of writing the env value into settings.json.
            ...(regionInput.disabled ? {} : { region: regionInput.value.trim() || null }),
            voice: vendorEl.voice('azure').value || null,
            outputFormat: $('#az-format').value,
            style: $('#az-style').value || null,
          },
          piper: {
            exe: $('#pi-exe').value.trim() || null,
            python: $('#pi-python').value.trim() || null,
            voicesDir: $('#pi-voices').value.trim() || null,
            voice: vendorEl.voice('piper').value || null,
          },
          // Generated cloud cards: voice select + whatever knobs the card
          // descriptor declares, read back by the same ids the builder minted.
          ...Object.fromEntries(CLOUD_VENDOR_CARDS.map((d) => [d.id, {
            voice: vendorEl.voice(d.id)?.value || null,
            ...Object.fromEntries(d.knobs.map((k) => {
              const el = $(`#cv-${d.id}-${k.key}`);
              const raw = (el?.value ?? '').trim();
              // outputFormat keeps its stored default rather than null-ing.
              if (k.key === 'outputFormat') return [k.key, raw || 'wav_24000'];
              return [k.key, raw || null];
            })),
          }])),
        },
      };
    }
    const { settings } = await api('/api/settings', { method: 'PATCH', body: { patch } });
    state.settings = settings;
    setVendorMsg('saved ✓');
    await loadVendors();
  } catch (err) {
    setVendorMsg(err.message, true);
  }
});

/* ------------------------------ voice test ------------------------------ */

function stopVendorPreview() {
  vendorState.preview?.pause();
  if (vendorState.preview?.src.startsWith('blob:')) URL.revokeObjectURL(vendorState.preview.src);
  vendorState.preview = null;
  for (const b of document.querySelectorAll('.test-btn')) {
    // Buttons label themselves ("▶ test" / "▶ listen"); restore what was there.
    b.textContent = b.dataset.idleLabel ?? '▶ test';
    b.classList.remove('playing');
  }
}

/**
 * Audition whichever vendor the button belongs to. Speech previews speak the
 * test line; the music preview renders a short phrase on the chosen instrument
 * through the *selected* music vendor, so "does this SoundFont sound right"
 * is answerable before a render rather than after one.
 */
async function testVendor(kind) {
  const btn = vendorEl.testBtn(kind);
  const msg = vendorEl.testMsg(kind);
  if (btn.classList.contains('playing')) { stopVendorPreview(); return; }
  stopVendorPreview();
  suspendActiveDocument(); // never two clips at once

  const music = kind === 'music';
  // The music page has one shared test button, so it auditions whichever vendor
  // the *edited* chain would actually use — not the top-ranked one, which may be
  // the very vendor that is unavailable. Speech buttons are per-card already.
  const vendor = music
    ? (effectiveVendor('music') ?? vendorState.chain.music[0] ?? 'node')
    : kind;
  const idle = btn.dataset.idleLabel ?? btn.textContent;
  btn.dataset.idleLabel = idle;
  btn.disabled = true;
  btn.textContent = '…';
  msg.textContent = '';
  msg.classList.remove('err');
  try {
    let body;
    if (music) {
      body = { program: Number($('#mu-program').value) || 0, drums: $('#mu-drums').checked };
    } else {
      body = { text: vendorEl.testText(kind).value, voice: vendorEl.voice(kind).value || undefined };
      if (kind === 'azure' && $('#az-style').value) body.style = $('#az-style').value;
    }
    const res = await fetch(`/api/vendors/${music ? 'music' : 'speech'}/${vendor}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `preview failed (HTTP ${res.status})`);
    }
    const seconds = Number(res.headers.get(music ? 'X-Music-Duration' : 'X-Speech-Duration'));
    const label = music
      ? `${vendor} · peak ${res.headers.get('X-Music-Peak-Db')} dBFS`
      : (decodeURIComponent(res.headers.get('X-Speech-Voice') ?? '') || 'default voice');
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    audio.addEventListener('ended', stopVendorPreview);
    audio.addEventListener('error', stopVendorPreview);
    await audio.play();
    vendorState.preview = audio;
    btn.textContent = '⏸ stop';
    btn.classList.add('playing');
    msg.textContent = `${label} · ${seconds.toFixed(2)}s`;
  } catch (err) {
    stopVendorPreview();
    msg.textContent = err.message;
    msg.classList.add('err');
  } finally {
    btn.disabled = false;
  }
}
for (const kind of [...CAP_VENDORS.speech, 'music']) {
  const btn = vendorEl.testBtn(kind);
  btn.dataset.idleLabel = btn.textContent; // "▶ test" / "▶ listen"
  btn.addEventListener('click', () => testVendor(kind));
}

/* -------------------------------- films -------------------------------- */

/* --------------------------- new film / scene -------------------------- */

/* A film is the container a video is authored in; the timeline itself is
 * edited on /film.html. Creating one here only needs a name and the scene
 * dimensions every scene inside will inherit. */

let newFilmWorkspace = null;

function studioDeliverablePresets() {
  return Array.isArray(state.settings?.deliverablePresets) ? state.settings.deliverablePresets : [];
}

function selectedDeliverableIds(host) {
  return host ? [...host.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value) : [];
}

/** Render the same persisted platform presets in Settings and New Film. */
function renderDeliverablePicker(host, selectedIds = [], { onChange = null } = {}) {
  if (!host) return;
  host.replaceChildren();
  const chosen = new Set(selectedIds);
  const presets = studioDeliverablePresets();
  if (!presets.length) {
    host.appendChild(el('span', 'dim', 'No platform presets are configured.'));
    return;
  }
  for (const preset of presets) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = preset.id;
    input.checked = chosen.has(preset.id);
    input.addEventListener('change', () => onChange?.());
    const text = document.createElement('span');
    text.textContent = preset.label;
    const size = document.createElement('span');
    size.className = 'deliverable-size';
    size.textContent = `${preset.width}×${preset.height}`;
    label.append(input, text, size);
    host.appendChild(label);
  }
}

function syncNewFilmPrimaryCanvas() {
  const f = $('#new-film-form');
  const selected = selectedDeliverableIds($('#new-film-deliverables'));
  const primary = studioDeliverablePresets().find((preset) => selected.includes(preset.id));
  const note = $('#new-film-platform-note');
  if (!primary) {
    note.textContent = 'Optional. Leave all unchecked for a master-only film.';
    return;
  }
  f.width.value = primary.width;
  f.height.value = primary.height;
  note.textContent = `${primary.label} supplies the master canvas. The same edit is reframed for every selected version.`;
}

async function openNewFilmDialog(wsId) {
  newFilmWorkspace = wsId;
  // The picker must reflect the same persisted defaults the server will use.
  // If the footer's background settings load has not landed yet, wait for it
  // rather than accidentally sending an explicit empty list that overrides it.
  if (!state.settings) await loadSettings().catch(() => {});
  const d = state.settings?.newSceneDefaults;
  const f = $('#new-film-form');
  if (d) {
    f.width.value = d.width;
    f.height.value = d.height;
    f.fps.value = d.fps;
    f.durationInFrames.value = d.durationInFrames;
  }
  renderDeliverablePicker($('#new-film-deliverables'), state.settings?.newFilmDefaults?.deliverableIds ?? [], {
    onChange: syncNewFilmPrimaryCanvas,
  });
  syncNewFilmPrimaryCanvas();
  $('#new-film-workspace').textContent = wsId;
  $('#new-film-dialog').showModal();
}
$('#btn-new-film-cancel').addEventListener('click', () => $('#new-film-dialog').close());
$('#new-film-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const selectedDeliverables = selectedDeliverableIds($('#new-film-deliverables')).map((id) => ({ id }));
    const { film } = await api(`/api/workspaces/${enc(newFilmWorkspace)}/films`, {
      method: 'POST',
      body: {
        name: f.name.value,
        width: Number(f.width.value),
        height: Number(f.height.value),
        fps: Number(f.fps.value),
        durationInFrames: Number(f.durationInFrames.value),
        // Only send an explicit list once the picker has a real settings
        // snapshot. Otherwise the server correctly applies its defaults.
        ...(state.settings ? { deliverables: selectedDeliverables } : {}),
      },
    });
    $('#new-film-dialog').close();
    f.reset();
    location.href = `/film.html?id=${enc(film.id)}`;
  } catch (err) {
    toastError(err);
  }
});

/* A scene inherits the film's sceneDefaults, so the dialog asks only for a
 * name and an optional duration — diverging width/fps would break the film's
 * lossless concat, and is left to the config tab where the warning is. */

let newSceneFilm = null;
function openNewSceneDialog(filmId) {
  newSceneFilm = filmId;
  $('#new-scene-film').textContent = filmId;
  $('#new-scene-dialog').showModal();
}
$('#btn-new-scene-cancel').addEventListener('click', () => $('#new-scene-dialog').close());
$('#new-scene-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const duration = Number(f.durationInFrames.value);
  try {
    const scene = await api(`/api/films/${enc(newSceneFilm)}/scenes`, {
      method: 'POST',
      body: {
        name: f.name.value,
        ...(duration > 0 ? { durationInFrames: duration } : {}),
      },
    });
    $('#new-scene-dialog').close();
    f.reset();
    delete state.filmScenes[newSceneFilm];
    await loadFilmScenes(newSceneFilm).catch(() => {});
    await loadWorkspaces();
    openDocument({ kind: 'scene', id: scene.id, name: scene.name });
  } catch (err) {
    toastError(err);
  }
});

/* ---------------------------- shared library --------------------------- */

/* The workspace library is the human's half of the asset story: drop large
 * files here (a 500 MB plate, a licensed soundtrack) and the workspace's
 * agent can pull them into any scene with use_shared_asset — no base64, no
 * 25 MB tool cap. It is a page rather than a tab because it belongs to the
 * workspace, not to whichever scene happens to be open. */

function showLibraryPage(wsId) {
  state.libraryWs = wsId;
  $('#library-page').classList.toggle('hidden', !wsId);
  if (wsId) suspendActiveDocument();
  syncStagePages();
  renderTree();
}

async function openLibrary(wsId) {
  if (vendorState.openCapability) showVendorsPage(null);
  if (state.settingsOpen) showSettingsPage(false);
  showLibraryPage(wsId);
  const ws = state.tree.find((w) => w.id === wsId);
  $('#library-title').textContent = `${ws?.name ?? wsId} — shared library`;
  $('#library-path').textContent = ws ? `${ws.path}${ws.path.includes('\\') ? '\\' : '/'}library` : '';
  await refreshLibrary();
}

async function refreshLibrary() {
  const ws = state.libraryWs;
  if (!ws) return;
  const tbody = $('#library-rows');
  tbody.innerHTML = '';
  let files = [];
  try { ({ files } = await api(`/api/workspaces/${enc(ws)}/library`)); }
  catch (err) { return toastError(err); }
  $('#library-empty').classList.toggle('hidden', files.length > 0);
  for (const f of files) {
    const tr = document.createElement('tr');
    tr.append(el('td', 'lib-path', f.path), el('td', null, f.kind),
      el('td', 'num', fmtBytes(f.bytes)), el('td', 'dim', (f.mtime ?? '').slice(0, 16).replace('T', ' ')));
    const actions = el('td', 'lib-actions');
    const dl = el('a', 'ghost tiny', 'download');
    dl.href = `/api/workspaces/${enc(ws)}/library/file?path=${enc(f.path)}&download=1`;
    const del = el('button', 'ghost tiny danger', 'delete');
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${f.path}" from the library?\n\nScenes that already pulled it in keep their copy.`)) return;
      try {
        await api(`/api/workspaces/${enc(ws)}/library/file?path=${enc(f.path)}`, { method: 'DELETE' });
        await refreshLibrary();
        await loadWorkspaces();
      } catch (err) { toastError(err); }
    });
    actions.append(dl, del);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

$('#btn-library-close').addEventListener('click', () => showLibraryPage(null));
$('#library-upload').addEventListener('change', async (e) => {
  const ws = state.libraryWs;
  const files = [...e.target.files];
  e.target.value = ''; // let the same file be re-picked after a fix
  if (!ws || !files.length) return;
  // A subfolder prefix keeps a big library navigable; it is optional and the
  // server re-checks the path, so a typo fails safely.
  const folder = ($('#library-folder').value || '').trim().replace(/^\/+|\/+$/g, '');
  for (const file of files) {
    const rel = folder ? `${folder}/${file.name}` : file.name;
    try {
      await fetch(`/api/workspaces/${enc(ws)}/library/file?path=${enc(rel)}`, { method: 'PUT', body: file })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json()).message ?? r.statusText); });
    } catch (err) { toastError(err); }
  }
  await refreshLibrary();
  await loadWorkspaces();
});

/* ------------------------------ documents -------------------------------- */

/* A film or a scene, open as a tab. Each is a same-origin iframe pointing at
 * the document's own page, mounted once and then only shown or hidden — so a
 * tab you come back to still has its playhead, its undo stack, its timeline
 * zoom and its scroll exactly where you left them. That is what a tab strip
 * promises, and rebuilding the view on every switch would break it.
 *
 * Iframes also make two open films a non-event. film.js and scene.js both use
 * #inspector, #btn-play, #frame-total and #timecode; in one runtime the second
 * film would quietly drive the first one's controls. */

const docs = new Map();   // "kind:id" -> {kind, id, name, frame}
let activeDocKey = null;

const docKey = (kind, id) => `${kind}:${id}`;
const docSrc = (kind, id) => (kind === 'film'
  ? `/film.html?id=${enc(id)}`
  : `/scene.html?scene=${enc(id)}`);
const activeDoc = () => (activeDocKey ? docs.get(activeDocKey) : null);
const activeWindow = () => { try { return activeDoc()?.frame?.contentWindow ?? null; } catch { return null; } };

const DOCS_KEY = 'ms.docs';

function persistDocs() {
  try {
    localStorage.setItem(DOCS_KEY, JSON.stringify({
      open: [...docs.values()].map((d) => ({ kind: d.kind, id: d.id, name: d.name })),
      active: activeDocKey,
    }));
  } catch { /* private mode / quota: the working set is a convenience */ }
}

function openDocument({ kind, id, name = null, activate = true }) {
  if (kind !== 'film' && kind !== 'scene') return;
  const key = docKey(kind, id);
  let doc = docs.get(key);
  if (!doc) {
    const frame = document.createElement('iframe');
    frame.className = 'editor-frame';
    frame.title = name ?? id;
    frame.src = docSrc(kind, id);
    $('#editor-stack').appendChild(frame);
    doc = { kind, id, name: name ?? id.split('/').pop(), frame };
    docs.set(key, doc);
  } else if (name) {
    doc.name = name;
  }
  if (activate) showDocument(key);
  else { renderDocTabs(); persistDocs(); }
}

function showDocument(key) {
  if (!docs.has(key)) return;
  activeDocKey = key;
  // Opening a document leaves whatever full-stage page was up: they are
  // alternatives to the editor, not layers over it.
  if (vendorState.openCapability) showVendorsPage(null);
  if (state.settingsOpen) showSettingsPage(false);
  if (state.libraryWs) showLibraryPage(null);
  syncStagePages();
  renderDocTabs();
  renderStatusBar();
  persistDocs();
  const doc = docs.get(key);
  document.title = `${doc.name} - Motion Studio`;
}

/**
 * A document's last chance to finish what it was doing.
 *
 * The film page saves on a 700ms debounce and guards the window with
 * `beforeunload` — which browsers do not run for a subframe being removed. So
 * closing a tab inside that window dropped the edit, silently, defeating the
 * one protection written against exactly that. The document flushes; we wait,
 * but not forever, because a wedged document must not make its tab unclosable.
 */
const CLOSE_FLUSH_MS = 4000;

async function flushDocument(doc) {
  let closing;
  try { closing = doc.frame.contentWindow?.StudioDoc?.closing?.(); }
  catch { return; } // still loading, or already gone: nothing staged to lose
  if (!closing?.then) return;
  await Promise.race([closing, new Promise((r) => setTimeout(r, CLOSE_FLUSH_MS))])
    .catch((err) => toastError(err));
}

async function closeDocument({ kind, id }, { flush = true } = {}) {
  const key = docKey(kind, id);
  const doc = docs.get(key);
  if (!doc) return;
  // `flush: false` when the thing being edited no longer exists — flushing
  // would PATCH a deleted film and report a failure the human just caused.
  if (flush) await flushDocument(doc);
  // It may have been closed underneath us while the flush was in flight.
  if (!docs.has(key)) return;
  const order = [...docs.keys()];
  const at = order.indexOf(key);
  doc.frame.remove();
  docs.delete(key);
  dropDocToasts(key);
  if (activeDocKey === key) {
    // The neighbour, not the end of the strip: every editor activates what
    // slid into the closed tab's place, else the tab before it.
    activeDocKey = order[at + 1] ?? order[at - 1] ?? null;
    if (activeDocKey) { showDocument(activeDocKey); return; }
    document.title = 'Motion Studio';
  }
  syncStagePages();
  renderDocTabs();
  renderStatusBar();
  persistDocs();
}

/** Exactly one document is visible, and only when no full-stage page is up. */
function syncStagePages() {
  const pageUp = !!vendorState.openCapability || !!state.settingsOpen || !!state.libraryWs;
  $('#editor-stack').classList.toggle('hidden', pageUp || !docs.size);
  $('#empty-state').classList.toggle('hidden', pageUp || docs.size > 0);
  for (const [key, d] of docs) d.frame.classList.toggle('on', key === activeDocKey);
  if (!pageUp && docs.size) notifyShown();
}

/* A document that loaded while the stack was display:none had no box at all —
 * its own ResizeObserver cannot help, because a document inside a hidden
 * iframe is not rendered and never observes anything. So the shell says when
 * it is on screen, and the document does whatever it could not do before:
 * fit its timeline, scale its preview. */
function notifyShown() {
  const w = activeWindow();
  if (!w) return; // still loading; its own boot runs with a real box
  try {
    w.StudioDoc?.shown?.();
    w.dispatchEvent(new Event('resize'));
  } catch { /* mid-navigation */ }
}

function renderDocTabs() {
  const strip = $('#doc-tabs');
  // The strip is rebuilt wholesale on every repaint — including the one a film
  // rename triggers through syncDocument — and emptying it collapses the
  // scrollable width, so the browser clamps scrollLeft to 0 and refilling
  // leaves it there. Put it back, then make sure the active tab is on screen:
  // now that tabs hold their width (U-1), the strip really can scroll, and
  // switching to a tab you cannot see is not an improvement.
  const scrollLeft = strip.scrollLeft;
  strip.innerHTML = '';
  strip.classList.toggle('hidden', !docs.size);
  let activeTab = null;
  for (const [key, d] of docs) {
    const tab = el('div', 'doc-tab' + (key === activeDocKey ? ' active' : ''));
    tab.title = `${d.name}\n${d.id}`;
    tab.append(
      el('span', 'doc-tab-mark', d.kind === 'film' ? '▶' : '◧'),
      el('span', 'doc-tab-name', d.name),
    );
    const close = el('button', 'doc-tab-close', '✕');
    close.title = 'close this document';
    close.addEventListener('click', (ev) => { ev.stopPropagation(); closeDocument(d); });
    tab.appendChild(close);
    tab.addEventListener('click', () => showDocument(key));
    strip.appendChild(tab);
    if (key === activeDocKey) activeTab = tab;
  }
  strip.scrollLeft = scrollLeft;
  activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * A toast raised inside a document, shown by the shell.
 *
 * The document it came from is a chip on the toast, and clicking it activates
 * that tab — a render that failed while you were looking at something else
 * should both say so and take you there. Without this the toast landed inside
 * a `visibility: hidden` iframe and was never seen at all.
 */
function docToast({ kind = 'error', code = null, message = '', timeoutMs, doc = null } = {}) {
  const entry = doc?.kind && doc?.id ? docs.get(docKey(doc.kind, doc.id)) : null;
  const err = code ? Object.assign(new Error(message), { data: { code } }) : message;
  const node = toast(err, { kind, timeoutMs });
  if (!entry || !node) return;
  const chip = el('button', 'toast-src', entry.name);
  chip.title = `from ${entry.id} — click to open it`;
  chip.addEventListener('click', () => showDocument(docKey(entry.kind, entry.id)));
  node.insertBefore(chip, node.querySelector('.toast-close'));
  node.dataset.doc = docKey(entry.kind, entry.id);
}

/** A closed document's failures are about something no longer open. */
function dropDocToasts(key) {
  for (const t of document.querySelectorAll(`#toasts .toast[data-doc="${CSS.escape(key)}"]`)) t.remove();
}

/** A document has loaded and named itself. */
function documentReady(doc) {
  syncDocument(doc);
  // It may have booted behind a full-stage page and be on screen by now.
  if (!$('#editor-stack').classList.contains('hidden')) notifyShown();
}

/** A document's title or status items changed. */
function syncDocument(doc) {
  if (!doc?.id) return;
  const key = docKey(doc.kind, doc.id);
  const entry = docs.get(key);
  if (entry) {
    const name = doc.title?.();
    if (name && name !== entry.name) {
      entry.name = name;
      renderDocTabs();
      persistDocs();
      if (key === activeDocKey) document.title = `${name} - Motion Studio`;
    }
  }
  if (key === activeDocKey) renderStatusBar();
}

/** A document changed what films or scenes exist. */
function treeChanged() {
  loadWorkspaces().catch(() => {});
  StudioPalette.invalidate();
}

function restoreDocs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(DOCS_KEY) || 'null'); } catch { saved = null; }
  for (const d of saved?.open ?? []) openDocument({ ...d, activate: false });
  if (saved?.active && docs.has(saved.active)) showDocument(saved.active);
  else if (docs.size) showDocument([...docs.keys()][0]);
  else { syncStagePages(); renderDocTabs(); }
}

window.StudioShell = {
  isShell: true,
  openDocument,
  closeDocument,
  documentReady,
  syncDocument,
  treeChanged,
  docToast,
  openPalette: (mode) => StudioPalette.open(mode),
};

/* ------------------------ activity bar + status bar ---------------------- */

/* The activity bar's vendor and settings buttons ARE the old rail-footer
 * buttons - same ids, same handlers, wired above. Only these two are new. */
$('#btn-explorer').addEventListener('click', () =>
  setRailCollapsed(!$('#frame').classList.contains('rail-collapsed')));
$('#btn-palette').addEventListener('click', () => StudioPalette.open('files'));
$('#sb-problems').addEventListener('click', () => $('#btn-settings').click());
$('#sb-goto').addEventListener('click', () => StudioPalette.open('files'));

/** A document going behind a full-stage page must stop playing. */
function suspendActiveDocument() {
  try { activeWindow()?.StudioDoc?.suspend?.(); } catch { /* still loading */ }
}

/** The activity bar's explorer icon is lit whenever the side bar is showing. */
function syncExplorerIcon() {
  $('#btn-explorer').classList.toggle('active', !$('#frame').classList.contains('rail-collapsed'));
}

/* The status bar belongs to the shell, but what goes in it belongs to the
 * active document - so the shell asks it, and the document never reaches up
 * into this DOM. Items marked align:'right' sit after the spacer. */
function renderStatusBar() {
  const host = $('#sb-doc');
  const right = $('#sb-doc-right');
  host.innerHTML = '';
  right.innerHTML = '';
  let items = [];
  try { items = activeWindow()?.StudioDoc?.status?.() ?? []; } catch { /* still loading */ }
  for (const item of items) {
    const node = el(item.onClick ? 'button' : 'span', `sb-item ${item.cls ?? ''}`, item.text);
    if (item.title) node.title = item.title;
    if (item.onClick) node.addEventListener('click', () => { try { item.onClick(); } catch { /* gone */ } });
    (item.align === 'right' ? right : host).appendChild(node);
  }
}

// A document reports on change, but a poll keeps a slow SSE or a job tick from
// leaving a stale line up.
setInterval(renderStatusBar, 1000);

/* ------------------------------ the palette ------------------------------ */

/* Commands the SHELL owns. The documents' own commands live with them. */
StudioPalette.register([
  { id: 'new.workspace', title: 'Workspace: New…', group: 'commands', run: () => $('#btn-new-workspace').click() },
  { id: 'page.tts', title: 'Vendors: Speech', group: 'commands', run: () => toggleVendorsPage('speech') },
  { id: 'page.music', title: 'Vendors: Music', group: 'commands', run: () => toggleVendorsPage('music') },
  { id: 'page.trans', title: 'Vendors: Transcription', group: 'commands', run: () => toggleVendorsPage('transcription') },
  { id: 'page.settings', title: 'Preferences: Global Settings', group: 'commands', run: () => $('#btn-settings').click() },
  { id: 'view.rail', title: 'View: Toggle Side Bar', group: 'commands', run: () => $('#btn-explorer').click() },
  {
    id: 'doc.close', title: 'View: Close the Active Document', group: 'commands',
    when: () => !!activeDocKey, run: () => closeDocument(activeDoc()),
  },
  {
    id: 'doc.closeAll', title: 'View: Close All Documents', group: 'commands',
    // Serially, and awaited: each document gets to flush before the next one
    // closes, which a fire-and-forget loop would race.
    when: () => docs.size > 0,
    run: async () => { for (const d of [...docs.values()]) await closeDocument(d); },
  },
]);

/* -------------------------------- boot -------------------------------- */

checkPrereqs();
loadSettings().catch(() => {});
syncExplorerIcon();
renderStatusBar();
loadWorkspaces()
  .then(async () => {
    const params = new URLSearchParams(location.search);
    // Reopen what was open, then honour the deep links on top of it.
    restoreDocs();
    const scene = params.get('scene');
    if (scene) openDocument({ kind: 'scene', id: scene });
    const film = params.get('film');
    if (film) openDocument({ kind: 'film', id: film });
    const page = params.get('page');
    if (page === 'settings') $('#btn-settings').click();
    else if (['speech', 'music', 'transcription'].includes(page)) toggleVendorsPage(page);
  })
  .catch((e) => console.error(e));
