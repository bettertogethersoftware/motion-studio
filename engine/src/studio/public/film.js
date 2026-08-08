/* Motion Studio — the film page (vanilla JS, no build step).
 *
 * ONE page per film (/film.html?id=<filmId>, the id a "ws/film" slug path sent
 * URL-encoded as one segment), in two modes over the same document, timeline
 * and player:
 *
 *   watch & advise (default) — the human half of an AI-directed production.
 *     Play the film, walk the Film → Sequence → Scene/Footage tree, click the
 *     thing that looks wrong, and leave plain-language advice. Read-only:
 *     nothing here mutates production, and nothing waits for approval.
 *   advanced editing — every production control this editor has always had:
 *     add, trim, reorder, render, build.
 *
 * There is no second review page. A mode is a CSS class plus a handful of
 * guards, not a separate surface with its own idea of the same timeline.
 *
 * The document: an ordered segment list (scenes and footage) plus master
 * audio / caption / overlay tracks, persisted through PATCH /api/films/:id.
 * Scenes and assets belong to the film's own folder (scenes/, assets/, out/);
 * a scene's full id is `${filmId}/${slug}`. The timeline IS the document —
 * every block is data first (film.audio[n], film.captions[n], …) and pixels
 * second. A sequence is a label on segments, so grouping moves no files.
 *
 * Preview honesty:
 *  - "preview" plays the scenes' REAL rendered outputs back to back (two
 *    <video> elements double-buffer across cuts).
 *  - "built film" plays one archived delivery and pins to it — it never swaps
 *    beneath the playhead, and advice records exactly which one was visible.
 *  - Master audio auditions through POST /api/films/:id/preview-audio — the
 *    build's exact ffmpeg mix (gains, fades, trims, sidechain ducking,
 *    limiter). A WebAudio approximation of that graph would lie about
 *    ducking, so we don't approximate.
 *  - Overlays and captions are drawn as DOM layers, geometrically identical
 *    to what the finishing pass burns in.
 */

'use strict';

/* One transport, one toast, for every Studio document. film.js carried its own
 * copies of these until v0.27 and they had already drifted — its toast forgot
 * the dismiss tooltip that studio-util.js sets. `el`, `uuid` and `clamp` stay
 * local: see the note at the top of studio-util.js on why `el` is deliberately
 * not shared. */
const { $, api, toast, toastError, askForText, askToConfirm } = StudioUtil;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));


/* -------------------------------- state -------------------------------- */

const HEAD_W = 128;   // sticky track-header column (matches .tl-head width)
const TAIL_PX = 220;  // slack after the last frame so end-of-film blocks stay grabbable
const FALLBACK_CLIP_FRAMES = 90; // audio block length until the clip is decoded

const filmId = new URLSearchParams(location.search).get('id');

const state = {
  film: null,        // the editable document (what PATCH sends)
  detail: null,      // server-resolved reality: scene layout, problems, fps…
  settings: null,    // global platform presets; films still keep their own snapshots
  assets: [],        // the film's own assets (media bin)
  pxf: 1,            // pixels per frame (zoom)
  pxfFit: 1,
  snap: true,
  playhead: 0,       // float frames
  playing: false,
  play: { t0: 0, frame0: 0, raf: 0 },
  // {kind:'scene',index} | {kind:'sequence',sequence} | {kind:'audio'|'caption'|'overlay', id} | null
  selection: null,
  undo: [], redo: [],
  saveTimer: null,
  saving: false,
  dirty: false,
  waves: new Map(),  // src -> {loading} | {duration, peaks}
  audioCtx: null,
  mix: { el: null, url: null, dirty: true, building: false, active: false },
  sceneJobs: new Map(), // scene slug -> {jobId, percent, state}
  buildJobId: null,
  buildPoll: null,
  lastBuild: null,       // {status, logs} — refills the build panel on re-open
  inspectorMode: null,   // null = selection properties | 'build'
  /* Which tab each kind of selection is showing. `advice` is first on every
   * one of them and is where a fresh selection lands: the human's half of this
   * page is advising, and the conversation used to sit at the FOOT of the
   * property sheet — under a scene's whole summary, and absent entirely on the
   * config/audio/assets/outputs tabs, which stood it down. Sticky per kind, so
   * an editing pass that picks `scene` once keeps landing there. */
  tab: {
    film: 'advice', scene: 'advice', footage: 'advice', sequence: 'advice',
    lane: 'advice', audio: 'advice', caption: 'advice', overlay: 'advice',
  },
  sceneFolders: [],      // scenes rail: the film's scene folders (incl. unlisted)
  overlayEls: new Map(), // overlay id -> preview element

  /* ---- the production loop (v0.23): what the AI did, what the human says --- */
  advice: [],               // this film's advice, newest first
  adviceSummary: null,
  revisions: {},            // scene slug -> { count, currentRevisionId, latestAt }
  sceneRevisions: new Map(),// scene slug -> full revision list (loaded on demand)
  status: null,             // production status projection (agent activity, readiness)
  deliveries: [],
  latestDeliveryId: null,
  pinnedDelivery: null,     // the delivery "built film" is locked to
  manifest: null,           // that delivery's frozen manifest
  updatedDismissed: false,
  source: 'preview',        // 'preview' (live scene outputs) | 'delivery' (a build)
  watchingRevision: null,   // { slug, revision } while auditioning an older take
  aiming: false,            // "advise AI" pressed with nothing selected
  adviceCtx: null,          // what the open popup is aimed at
  collapsedSequences: new Set(),
  openAdviceId: null,
  boardFilter: 'open',      // the advice board's filter: open | answered | all
  namingSequence: null,     // a just-created band, waiting for the inspector to focus its name
};

let reviewRequestId = 0;

const fps = () => state.detail?.fps || 30;
// One frame domain for the whole page. In "built film" mode the archived file
// is what scrubs, so its length wins; when the cut has moved on since that
// build the two disagree, and `deliveryIsStale()` says so out loud rather than
// letting the timeline quietly mislabel the picture.
const totalFrames = () => (state.source === 'delivery' && state.manifest?.totalFrames
  ? state.manifest.totalFrames
  : state.detail?.totalFrames || 0);
const deliveryIsStale = () => !!(state.source === 'delivery' && state.manifest
  && state.manifest.totalFrames !== (state.detail?.totalFrames ?? state.manifest.totalFrames));
// Ids are slug paths ("ws/film", "ws/film/scene") sent as ONE encoded segment.
const fid = encodeURIComponent(filmId ?? '');
const sceneApi = (slug) => `/api/scenes/${encodeURIComponent(`${filmId}/${slug}`)}`;
const assetUrl = (rel) => `/api/films/${fid}/asset?path=${encodeURIComponent(rel)}`;
const sceneSrc = (s) => (s.kind === 'footage'
  // Footage is served by the film's own asset route (Range-capable already), not
  // from a scene's out/ dir — it was never rendered.
  ? assetUrl(s.footage)
  : `${sceneApi(s.slug)}/output?file=${encodeURIComponent(s.outputFile)}`);
const isVideoAsset = (p) => /\.(mp4|webm|mov)$/i.test(p);

function timecode(frame) {
  const sec = frame / fps();
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(2).padStart(5, '0')}`;
}
function frameOfEvent(ev) {
  const rect = $('#tl-inner').getBoundingClientRect();
  return clamp((ev.clientX - rect.left - HEAD_W) / state.pxf, 0, Math.max(0, totalFrames()));
}

/* ------------------------------ persistence ---------------------------- */

const EDITABLE = ['name', 'scenes', 'audio', 'overlays', 'captions', 'captionStyle',
  // `sequences` carries the narrative labels' intent text. The labels themselves
  // live on the segments inside `scenes`, so a regrouping is one atomic patch.
  'sequences', 'audioTargetPeakDb', 'burnCaptions', 'outputFilename', 'deliverables',
  // How many lanes each family shows, and which of them are muted. The first
  // is presentation (but an empty lane you just made must survive a reload);
  // the second changes what the film sounds like.
  'lanes', 'mutedLanes'];

function snapshot() {
  return JSON.parse(JSON.stringify(Object.fromEntries(EDITABLE.map((k) => [k, state.film[k]]))));
}

function setSaveState(text, cls = '') {
  const el = $('#save-state');
  el.textContent = text;
  el.className = `sb-item mono ${cls || 'dim'}`;
  StudioUtil.syncDocument();
}

function scheduleSave({ now = false } = {}) {
  state.dirty = true;
  setSaveState('unsaved', 'dirty');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(doSave, now ? 0 : 700);
}

async function doSave() {
  if (state.saving) { scheduleSave(); return; }
  state.saving = true;
  setSaveState('saving…', 'dirty');
  const sent = JSON.stringify(snapshot());
  try {
    const { film, detail } = await api(`/api/films/${fid}`, {
      method: 'PATCH',
      // The revision this page last read. A patch replaces whole arrays, so
      // without it a tab left open across an agent's edit would save its
      // page-load-old `scenes` back and silently undo that work.
      body: { patch: JSON.parse(sent), revision: state.film.revision },
    });
    // Only adopt the server's film if nothing changed while the PATCH was in
    // flight — otherwise the response would clobber keystrokes.
    if (JSON.stringify(snapshot()) === sent) {
      state.film = film;
      state.dirty = false;
      setSaveState('saved ✓');
    } else {
      // Keystrokes landed mid-flight, so the local document stays authoritative
      // — but it is now based on `film`, and the next save must say so.
      state.film.revision = film.revision;
    }
    adoptDetail(detail);
    renderTimeline(); // scene offsets / problems may have moved
  } catch (err) {
    if (err?.data?.code === 'film_conflict') await handleSaveConflict();
    else { setSaveState('save failed', 'err'); toastError(err); }
  } finally {
    state.saving = false;
    if (state.dirty) scheduleSave();
  }
}

/**
 * The film moved under us. There is no honest merge available: a patch is a
 * statement about whole lists, so re-sending ours would revert whatever we did
 * not see, and keeping ours locally would make every later save do the same.
 * So we drop the unsaved edit — at most one debounce of work — reload the truth,
 * and say plainly that it was dropped. Undo history goes too: those snapshots
 * describe a document that no longer exists.
 */
async function handleSaveConflict() {
  state.dirty = false;
  clearTimeout(state.saveTimer);
  state.undo.length = 0;
  state.redo.length = 0;
  syncUndoButtons();
  setSaveState('reloaded — last edit not saved', 'err');
  await refresh().catch(toastError);
  toast('This film changed elsewhere (the AI, another tab, or an edit on disk) while you had it open. '
    + 'The page has been reloaded and your last unsaved change was NOT applied — saving it would have reverted '
    + 'the change you had not seen. Please make that edit again.');
}

/** One mutation = one undo step = one (debounced) save. */
function mutate(fn, { structural = false, silent = false } = {}) {
  // BUG-3: the document is wired before it is loaded. `registerDocument` runs
  // at top level so the shell can draw a tab while the film is still fetching,
  // which means `#film-name` is in the DOM with its listener attached while
  // `state.film` is still null — and snapshot() below then throws on it.
  //
  // The window is tens of milliseconds on a warm local film and effectively
  // unreachable; on a cold start, a large film or a slow disk it is long enough
  // to lose a keystroke. What made it worth fixing is not the throw but the
  // SILENCE: `#save-state` stayed "saved", the edit was discarded, and nothing
  // told the human. The boot gate below is the real fix; this is the guard
  // underneath it, and it speaks.
  if (!filmReady()) return false;
  state.undo.push(snapshot());
  if (state.undo.length > 100) state.undo.shift();
  state.redo.length = 0;
  fn(state.film);
  syncUndoButtons();
  scheduleSave({ now: structural });
  if (!silent) renderTimeline();
  invalidateMixIfAudioChanged();
  return true;
}

/**
 * True when there is a film to edit; otherwise says so and returns false.
 *
 * A caller that reads `state.film` BEFORE calling mutate() — the name field
 * does, to restore the old value when the box is cleared — has to ask this
 * first, because mutate()'s own guard is too late to save it.
 */
function filmReady() {
  if (state.film) return true;
  toast('The film is still loading, so that change was not applied — make it again in a moment.',
    { kind: 'error' });
  return false;
}

/** Resolve once the pending save has landed (structural edits need the
 *  server-recomputed scene layout before continuing). */
async function waitForSaved() {
  while (state.dirty || state.saving) await new Promise((r) => setTimeout(r, 80));
}

/** The same wait with a deadline, for callers that must not hang on a save
 *  that keeps failing — `doSave` re-queues one, so "clean" may never come. */
async function saveSettled(ms) {
  const until = Date.now() + ms;
  while ((state.dirty || state.saving) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 80));
  }
  return !state.dirty && !state.saving;
}

/**
 * Throw away the rendered preview mix when anything that changes the SOUND
 * changes — and, mid-playback, replace it there and then.
 *
 * Two bugs lived here. The signature covered `audio` alone, so muting a lane
 * (which is `film.mutedLanes`) left the cache looking fresh and you kept
 * hearing the lane you had just silenced, even after stopping and playing
 * again. And revoking an object URL does not stop a media element that has
 * already loaded it: dropping the reference without pausing left the old mix
 * playing to its end, which is what "it does not mute in real time" looks and
 * sounds like.
 *
 * The mix is one ffmpeg render of the whole film — that is what makes the
 * preview the build's actual graph, gains, ducking and limiter included — so a
 * mute cannot be applied to it in place. Silence is immediate; the re-mixed
 * audio rejoins at the playhead a moment later.
 */
let lastMixJson = '';
let mixRebuildTimer = null;
/** Everything the rendered mix depends on — one place, so nothing is forgotten. */
const mixSignature = (film) => JSON.stringify({
  audio: film?.audio ?? [],
  mutedLanes: film?.mutedLanes ?? null,
});

function invalidateMixIfAudioChanged() {
  const cur = mixSignature(state.film);
  if (cur === lastMixJson) return;
  lastMixJson = cur;
  try { state.mix.el?.pause(); } catch { /* already detached */ }
  if (state.mix.url) URL.revokeObjectURL(state.mix.url);
  Object.assign(state.mix, { el: null, url: null, dirty: true, active: false });
  updateMixChip();
  // Debounced: dragging a gain slider must not queue a render per pixel.
  clearTimeout(mixRebuildTimer);
  if (state.playing) mixRebuildTimer = setTimeout(() => { if (state.playing) buildMix(); }, 350);
}

function applySnapshot(snap) {
  Object.assign(state.film, JSON.parse(JSON.stringify(snap)));
  $('#film-name').value = state.film.name;
  scheduleSave({ now: true });
  invalidateMixIfAudioChanged();
  state.selection = null;
  renderAll();
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  applySnapshot(state.undo.pop());
  syncUndoButtons();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  applySnapshot(state.redo.pop());
  syncUndoButtons();
}
function syncUndoButtons() {
  $('#btn-undo').disabled = !state.undo.length;
  $('#btn-redo').disabled = !state.redo.length;
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------ detail sync ----------------------------- */

function adoptDetail(detail) {
  state.detail = detail;
  renderHeader();
  fitPlayerBox();
}

async function refresh() {
  const [{ film, detail, sceneFolders }, settingsResult] = await Promise.all([
    api(`/api/films/${fid}`),
    api('/api/settings').catch(() => null),
  ]);
  state.film = film;
  state.settings = settingsResult?.settings ?? state.settings;
  state.sceneFolders = sceneFolders ?? [];
  lastMixJson = mixSignature(film);
  adoptDetail(detail);
  $('#film-name').value = film.name;
  document.title = `${film.name} — Motion Studio`;
  StudioUtil.syncDocument();
  await loadAssets();
  await loadOverview();
  renderAll();
  // After the draw, never before it: the repair reads the same packed layout
  // the timeline just drew, and that layout is only true once the waveforms
  // have decoded. Not awaited — a film opens now, and the repair (if there is
  // one to make) lands a moment later with a sentence saying what it did.
  repairPackedLaneMute().catch(toastError);
}

/**
 * Reload this film — the header's ↻.
 *
 * A browser reload would take the whole shell with it: every open document goes
 * back to the Studio home, and the film you were looking at is a navigation
 * away. This reloads the *film*, and reloads all of it, because "the page and
 * the disk disagree" never has one cause: unsaved edits are flushed first (so
 * the reload cannot eat them), then the document, its plan, its assets and the
 * production loop are re-read, and the rendered mix — a cache of the document
 * we are about to replace — is thrown away so the next play is made from what
 * is on disk now.
 *
 * Not a workaround for a stale editor. It is the honest answer to a page that
 * has been open for hours while an agent worked underneath it, and the one
 * gesture that re-syncs everything at once when something has gone strange.
 */
async function reloadFilm() {
  const btn = $('#btn-reload');
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  try {
    // Flush first, and refuse to reload if the flush will not land. `doSave`
    // retries a failed save on its own, so waiting for it unconditionally is a
    // button that never comes back — and reloading anyway would throw away the
    // very edit it could not write down.
    if (state.dirty || state.saving) {
      scheduleSave({ now: true });
      if (!await saveSettled(10_000)) {
        toast('Not reloaded: the change you have not saved yet could not be written, and reloading would '
          + 'discard it. The page still holds it — fix what the save is complaining about, then reload.',
        { kind: 'error' });
        return;
      }
    }
    stopPlayback();
    // The one gesture that re-reads everything from disk also drops the strips:
    // a scene re-rendered at the same length and path is the case their cache
    // key cannot see, and this is the button for "something changed underneath".
    clearStrips();
    // Pause before dropping: revoking an object URL does not stop an element
    // that has already loaded it (the same trap as invalidateMixIfAudioChanged).
    try { state.mix.el?.pause(); } catch { /* already detached */ }
    if (state.mix.url) URL.revokeObjectURL(state.mix.url);
    Object.assign(state.mix, { el: null, url: null, dirty: true, active: false });
    state.undo.length = 0;
    state.redo.length = 0;
    syncUndoButtons();
    await refresh();
    toast('Reloaded from disk.', { kind: 'info', timeoutMs: 2500 });
  } catch (err) {
    toastError(err);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

/**
 * The production-loop snapshot: advice, per-scene revision counts, archived
 * deliveries and the AI's activity, in one call. Deliberately separate from
 * the film document — an event on this side must never overwrite the edits
 * the human is in the middle of making on that side.
 */
let catchingUp = false;

async function loadOverview() {
  let snap;
  try { snap = await api(`/api/films/${fid}/overview`); }
  catch { return; } // a film that will not plan still edits fine
  // The overview carries the current film document, so this is also where an
  // open tab notices the AI edited the film under it. Catching up while clean
  // costs nothing and keeps the page from drifting for hours until its next
  // save conflicts. While dirty we say so and leave the human's edit alone —
  // adopting the server's document would be the very clobber we are avoiding.
  const moved = snap.film?.revision && state.film?.revision && snap.film.revision !== state.film.revision;
  if (moved && !catchingUp) {
    if (state.dirty) {
      setSaveState('changed elsewhere', 'err');
    } else {
      catchingUp = true;
      try { await refresh(); } finally { catchingUp = false; }
      return; // refresh() re-ran this function with the new document
    }
  }
  state.advice = snap.advice ?? [];
  state.revisions = snap.revisions ?? {};
  state.status = snap.status ?? null;
  state.deliveries = snap.deliveries ?? [];
  state.latestDeliveryId = snap.currentDeliveryId ?? null;
  if (!state.pinnedDelivery) state.pinnedDelivery = state.latestDeliveryId;
  if (state.pinnedDelivery && (!state.manifest || state.manifest.id !== state.pinnedDelivery)) {
    try { state.manifest = await api(`/api/films/${fid}/deliveries/${encodeURIComponent(state.pinnedDelivery)}`); }
    catch { state.pinnedDelivery = null; state.manifest = null; }
  }
  if (!state.latestDeliveryId) { state.pinnedDelivery = null; state.manifest = null; }
}

async function loadAssets() {
  try {
    const { files } = await api(`/api/films/${fid}/assets`);
    state.assets = files;
  } catch { state.assets = []; }
}

function renderHeader() {
  const d = state.detail;
  const scenes = d.scenes.filter((s) => !s.missing);
  $('#film-facts').textContent = d.fps
    ? `${scenes[0]?.width ?? '?'}×${scenes[0]?.height ?? '?'} · ${d.fps}fps · ${d.totalFrames}f · ${timecode(d.totalFrames)} · ${d.format}`
    : 'no scenes yet';
  $('#frame-total').textContent = Math.max(0, d.totalFrames - 1);

  const problems = d.problems ?? [];
  const btn = $('#btn-problems');
  btn.classList.toggle('hidden', !problems.length);
  btn.textContent = `⊗ ${problems.length} issue${problems.length === 1 ? '' : 's'}`;
  btn.title = 'what would stop a build — click for the list';
  $('#sb-film').textContent = filmId;
  const HARD = new Set([
    'scene_missing', 'signature_mismatch', 'format_not_concatenatable', 'asset_missing', 'mixed_scene_audio',
    // Footage problems block a build exactly as their scene equivalents do, so
    // they must not render as soft warnings (v0.22).
    'footage_missing', 'footage_duration_mismatch', 'footage_signature_mismatch', 'footage_source_changed',
  ]);
  const ul = $('#problems-list');
  ul.innerHTML = '';
  for (const p of problems) {
    const li = document.createElement('li');
    li.textContent = p.message;
    li.classList.toggle('hard', HARD.has(p.code));
    ul.appendChild(li);
  }
  if (!problems.length) $('#problems-panel').classList.add('hidden');
  renderAdviseButton();
  renderProductionLine();
  renderUpdatedBanner();
}

$('#btn-problems').addEventListener('click', () => $('#problems-panel').classList.toggle('hidden'));

/* ------------------------------- preview ------------------------------- */

const videoEls = [$('#video-a'), $('#video-b')];
let activeVideo = null;

/* ---- drawing an unrendered scene, live (v0.28) ------------------------ */

/**
 * A scene that has never been rendered used to show a striped card with its
 * name on it. That answers "is it rendered" — which the timeline's own dot
 * already answered — and not "what IS it", which is the question you have when
 * a film holds a scene called `2026-08-07 18_40_02-public_html — jj@…`.
 *
 * So the composition is drawn here instead, in this browser, at the playhead's
 * frame — the same `/preview/<scene>/` iframe and the same `setFrame(n)`
 * contract the scene page uses. It follows the playhead, so an unrendered scene
 * can be scrubbed and not merely glimpsed.
 *
 * It is NOT the delivery, and the difference is the film page's whole promise
 * ("what you scrub is what you ship"). This is the one exception, so it carries
 * a tag saying so rather than passing for a render. Fonts, 3D libraries and
 * heavy per-frame work behave like they do in the scene editor, not like the
 * render engine's frame-by-frame capture.
 */
const liveScene = { slug: null, entry: new Map(), pending: false, want: null, ready: false };

function hideLiveScene() {
  if (liveScene.slug === null) return;
  liveScene.slug = null;
  liveScene.ready = false;
  const f = $('#scene-live');
  f.classList.add('hidden');
  f.removeAttribute('src');
  $('#live-tag')?.classList.add('hidden');
}

/** The scene's entry file, cached — planFilm does not report it, and it is rarely not the default. */
function liveEntry(slug) {
  if (liveScene.entry.has(slug)) return liveScene.entry.get(slug);
  liveScene.entry.set(slug, 'composition.html');
  api(sceneApi(slug))
    .then((s) => { if (s?.config?.entry) liveScene.entry.set(slug, s.config.entry); })
    .catch(() => { /* the default is right for every scaffolded scene */ });
  return liveScene.entry.get(slug);
}

/** Scale the composition's own pixels into the player box. */
function fitLiveScene(scene) {
  const f = $('#scene-live');
  const box = $('#player-box').getBoundingClientRect();
  const w = scene.width || 1920;
  const h = scene.height || 1080;
  f.style.width = `${w}px`;
  f.style.height = `${h}px`;
  f.style.transform = `scale(${Math.min(box.width / w, box.height / h)})`;
}

/**
 * @returns {boolean} true when the live preview is showing this scene
 */
function showLiveScene(scene, sceneFrame) {
  if (!scene.slug) return false;
  const f = $('#scene-live');
  if (liveScene.slug !== scene.slug) {
    liveScene.slug = scene.slug;
    liveScene.ready = false;
    f.classList.remove('hidden');
    $('#live-tag')?.classList.remove('hidden');
    f.onload = () => {
      liveScene.ready = true;
      // The engine states the frame geometry on every page it opens; a
      // composition authored against those variables must get them here too or
      // it lays out against nothing.
      try {
        const root = f.contentDocument?.documentElement;
        if (root) {
          root.style.setProperty('--ms-width', `${scene.width}px`);
          root.style.setProperty('--ms-height', `${scene.height}px`);
        }
      } catch { /* cross-document mid-load */ }
      pushLiveFrame();
    };
    f.src = `/preview/${encodeURIComponent(`${filmId}/${scene.slug}`)}/${liveEntry(scene.slug)}`;
  }
  fitLiveScene(scene);
  liveScene.want = Math.max(0, Math.min(sceneFrame, (scene.durationInFrames || 1) - 1));
  pushLiveFrame();
  return true;
}

/**
 * Drive the composition to the wanted frame, one call at a time. Scrubbing
 * fires far faster than a composition can draw, so a queue would run minutes
 * behind the pointer; instead the newest wanted frame wins and everything in
 * between is dropped — which is what a scrub means anyway.
 */
async function pushLiveFrame() {
  if (liveScene.pending || !liveScene.ready) return;
  const n = liveScene.want;
  if (n === null) return;
  liveScene.pending = true;
  try {
    const win = $('#scene-live').contentWindow;
    if (win && typeof win.setFrame === 'function') await win.setFrame(n);
  } catch { /* iframe mid-reload */ } finally {
    liveScene.pending = false;
    if (liveScene.want !== n) pushLiveFrame();
  }
}

function fitPlayerBox() {
  const first = state.detail?.scenes.find((s) => !s.missing);
  const w = first?.width ?? 1920, h = first?.height ?? 1080;
  const box = $('#fe-viewport').getBoundingClientRect();
  const scale = Math.min((box.width - 2) / w, (box.height - 2) / h);
  const pb = $('#player-box');
  pb.style.width = `${Math.max(64, w * scale)}px`;
  pb.style.height = `${Math.max(36, h * scale)}px`;
  // A live scene is scaled into the box by hand, so it has to be re-scaled when
  // the box changes — the video elements get this free from `inset: 0`.
  if (liveScene.slug) {
    const s = state.detail?.scenes.find((x) => x.slug === liveScene.slug);
    if (s) fitLiveScene(s);
  }
  updateLayers(state.playhead);
}
window.addEventListener('resize', fitPlayerBox);

/** How many layers are on the film — the things that ride over the play order. */
function layerCount() {
  const f = state.film;
  return (f?.overlays?.length ?? 0) + (f?.captions?.length ?? 0) + (f?.audio?.length ?? 0);
}

function sceneAt(frame) {
  const scenes = state.detail?.scenes ?? [];
  for (let i = scenes.length - 1; i >= 0; i--) {
    const s = scenes[i];
    if (!s.missing && frame >= s.filmOffset && frame < s.filmOffset + s.durationInFrames) return { scene: s, index: i };
  }
  return { scene: null, index: -1 };
}

/**
 * "built film" playback: one archived delivery, pinned. It is the only place
 * the human sees the real mix, the real overlays and the real burned captions,
 * so it must not silently become a different film — a newer build offers
 * itself in a banner and is never swapped in beneath the playhead.
 */
function syncDeliveryVideo(frame) {
  const v = $('#video-film');
  videoEls.forEach((el) => { el.classList.remove('active'); el.pause(); });
  activeVideo = null;
  // A delivery is ONE file; there are no segment slots left to fall short of.
  $('#shortfall-tag')?.classList.add('hidden');
  const ph = $('#scene-placeholder');
  if (!state.manifest) {
    v.classList.remove('active');
    v.pause();
    ph.classList.remove('hidden');
    ph.querySelector('.ph-name').textContent = 'no built film yet';
    ph.querySelector('.ph-note').textContent = 'The AI has not assembled one. Switch to “preview” to watch the scenes as they stand.';
    return;
  }
  ph.classList.add('hidden');
  v.classList.add('active');
  const src = `/api/films/${fid}/deliveries/${encodeURIComponent(state.pinnedDelivery)}/file`;
  if (v.dataset.src !== src) {
    v.dataset.src = src;
    v.src = src;
    // Same as syncVideo: the first pass cannot seek a file with no metadata yet.
    v.addEventListener('loadedmetadata', () => syncDeliveryVideo(state.playhead), { once: true });
  }
  v.muted = false;
  const t = frame / (state.manifest.fps || fps());
  const drift = Math.abs(v.currentTime - t);
  if (state.playing) {
    if (drift > 0.4 && v.readyState >= 1) v.currentTime = t;
    if (v.paused) v.play().catch(() => {});
  } else {
    if (!v.paused) v.pause();
    if (drift > 0.03 && v.readyState >= 1) v.currentTime = t;
  }
}

/**
 * Say when the picture has run out before its slot has.
 *
 * A segment states a frame COUNT and the timeline lays it out at the FILM's
 * rate, so the two agree only while the file's own rate does. A 60fps clip of
 * 623 frames is 10.4s of video in a 20.8s slot: the element reaches its last
 * frame halfway through and holds it. That is a real defect in the film — the
 * plan reports it as `footage_signature_mismatch` — but the player, where you
 * actually notice, used to freeze in silence and leave you wondering whether
 * the app had hung. It names the shortfall instead.
 */
function showShortfall(scene, wantSeconds, el) {
  const tag = $('#shortfall-tag');
  if (!tag) return;
  const have = el?.duration;
  const slot = (scene.durationInFrames ?? 0) / fps();
  // Half a frame of slack: the last frame legitimately starts fractionally
  // before `duration`, and flagging that would cry wolf on every clip.
  const short = Number.isFinite(have) && have > 0 && wantSeconds > have + 0.5 / fps();
  tag.classList.toggle('hidden', !short);
  if (!short) return;
  tag.textContent = `holding the last frame — ${have.toFixed(1)}s of video in a ${slot.toFixed(1)}s slot`;
  tag.title = scene.kind === 'footage'
    ? `This clip is ${scene.fps ?? '?'}fps and the film is ${fps()}fps, so its ${scene.durationInFrames} frames are `
      + `${have.toFixed(1)}s of file but ${slot.toFixed(1)}s of this film. Conform it with transcode_asset, or `
      + 'correct the segment\'s durationInFrames.'
    : `This scene is ${scene.durationInFrames} frames but its material runs out at ${have.toFixed(1)}s. `
      + 'Shorten the scene, or give its composition more to show.';
}

function syncVideo(frame) {
  if (state.source === 'delivery') return syncDeliveryVideo(frame);
  $('#video-film').classList.remove('active');
  $('#video-film').pause();
  const { scene, index } = sceneAt(frame);
  const ph = $('#scene-placeholder');
  const playable = scene && (scene.kind === 'footage' ? !scene.missing : scene.rendered);
  if (!playable) {
    videoEls.forEach((v) => { v.classList.remove('active'); v.pause(); });
    activeVideo = null;
    $('#shortfall-tag')?.classList.add('hidden');
    // An unrendered SCENE can still be shown: draw its composition here, at
    // this frame. Only a scene — footage has no composition to run, and a gap
    // has nothing at all.
    if (scene && scene.kind !== 'footage' && !scene.missing && showLiveScene(scene, frame - scene.filmOffset)) {
      ph.classList.add('hidden');
      return;
    }
    hideLiveScene();
    ph.classList.remove('hidden');
    ph.querySelector('.ph-name').textContent = scene ? scene.name : (totalFrames() ? 'gap' : 'no scenes yet');
    // A film can have overlays, captions and audio on it and STILL be empty:
    // those are composited over the play order and give it no length, so the
    // player has nothing to run. Saying "add scenes" to someone who has just
    // added an overlay reads as the app ignoring what they did.
    ph.querySelector('.ph-note').textContent = !scene
      ? (layerCount() ? 'overlays, captions and audio sit OVER the film — they give it no length. '
        + 'Add a scene or a clip and they will play over it.' : 'add scenes with “+ scene”')
      : scene.kind === 'footage' ? 'footage file missing from the film’s assets/'
        : 'scene not rendered — render it to preview';
    return;
  }
  hideLiveScene();
  ph.classList.add('hidden');

  // Auditioning an older take substitutes ONLY that scene's picture, in place,
  // so the human compares it against the cut it actually sits in. Nothing is
  // written — asking for it back is advice, made from the inspector.
  // `watchingRevision?.slug === scene.slug` is NOT enough, and the difference
  // was why supplied footage played as a black rectangle for two versions: a
  // footage segment has no `slug`, so with nothing being auditioned this read
  // `undefined === undefined` — true — and then dereferenced the null it had
  // just tested for. The throw happened before any src was assigned, on every
  // playhead move inside the clip, and was invisible without a console open.
  const watched = state.watchingRevision && state.watchingRevision.slug
    && state.watchingRevision.slug === scene.slug
    ? state.watchingRevision.revision
    : null;
  const src = watched
    ? `${sceneApi(scene.slug)}/revisions/${encodeURIComponent(watched.id)}/file`
    : sceneSrc(scene);
  let el = videoEls.find((v) => v.dataset.src === src);
  if (!el) {
    el = videoEls.find((v) => v !== activeVideo) ?? videoEls[0];
    el.dataset.src = src;
    el.src = src;
    // A just-assigned element is at readyState 0, so the seek below is skipped
    // and the picture sits on frame 0 until the playhead moves AGAIN — scrub
    // into a clip and you are shown the wrong frame of it. Re-run the moment
    // the metadata lands, against wherever the playhead is by then. It cannot
    // recurse: by that point this element matches `src` and is not re-assigned.
    el.addEventListener('loadedmetadata', () => syncVideo(state.playhead), { once: true });
  }
  if (el !== activeVideo) {
    if (activeVideo) { activeVideo.classList.remove('active'); activeVideo.pause(); }
    el.classList.add('active');
    activeVideo = el;
  }
  // Per-scene audio only plays when the film has no master timeline —
  // build_film's rule (a master timeline replaces scene audio), mirrored.
  el.muted = (state.film.audio ?? []).length > 0;

  const t = (frame - scene.filmOffset) / fps();
  const drift = Math.abs(el.currentTime - t);
  if (state.playing) {
    if (drift > 0.15 && el.readyState >= 1) el.currentTime = t;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (drift > 0.03 && el.readyState >= 1) el.currentTime = t;
  }
  showShortfall(scene, t, el);

  // Preload the next rendered scene into the spare element near the cut.
  const next = (state.detail.scenes ?? []).slice(index + 1).find((s) => !s.missing && s.rendered);
  if (next && next.filmOffset - frame < fps() * 3) {
    const spare = videoEls.find((v) => v !== activeVideo);
    const nsrc = sceneSrc(next);
    if (spare && spare.dataset.src !== nsrc) {
      spare.dataset.src = nsrc;
      spare.src = nsrc;
      spare.muted = true;
    }
  }
}

function updateLayers(frame) {
  const film = state.film;
  if (!film) return;
  const pb = $('#player-box');
  const layer = $('#overlay-layer');

  // A built film already HAS its overlays composited and, when burnCaptions is
  // on, its captions burned. Drawing them again would double them — so in that
  // mode the DOM layers show only what the file genuinely lacks.
  if (state.source === 'delivery') {
    for (const [id, el] of state.overlayEls) { el.remove(); state.overlayEls.delete(id); }
    const capEl = $('#caption-layer');
    const m = state.manifest;
    const burned = m ? m.burnCaptions : film.burnCaptions;
    const list = m ? (m.captions ?? []) : (film.captions ?? []);
    capEl.textContent = burned ? '' : list.filter((c) => frame >= c.fromFrame && frame < c.toFrame).map((c) => c.text).join('\n');
    const st = (m ? m.captionStyle : film.captionStyle) ?? {};
    capEl.style.fontSize = `${(pb.clientHeight * (st.sizePct ?? 4.5)) / 100}px`;
    if ((st.position ?? 'bottom') === 'top') { capEl.style.top = '4.5%'; capEl.style.bottom = 'auto'; }
    else { capEl.style.bottom = '4.5%'; capEl.style.top = 'auto'; }
    return;
  }

  // Overlays — keyed elements so a playing video overlay isn't recreated per frame.
  const live = new Set();
  for (const o of film.overlays ?? []) {
    const visible = frame >= o.fromFrame && frame < o.toFrame;
    if (!visible) continue;
    live.add(o.id);
    let el = state.overlayEls.get(o.id);
    const isVid = isVideoAsset(o.src);
    if (!el || el.dataset.src !== o.src) {
      el?.remove();
      el = document.createElement(isVid ? 'video' : 'img');
      el.dataset.src = o.src;
      if (isVid) { el.muted = true; el.playsInline = true; el.loop = false; }
      el.src = assetUrl(o.src);
      state.overlayEls.set(o.id, el);
      layer.appendChild(el);
      attachOverlayDrag(el, o.id);
    }
    el.style.left = `${o.xPct ?? 0}%`;
    el.style.top = `${o.yPct ?? 0}%`;
    el.style.width = o.widthPct != null ? `${o.widthPct}%` : 'auto';
    el.style.opacity = String(o.opacity ?? 1);
    el.classList.toggle('sel', state.selection?.kind === 'overlay' && state.selection.id === o.id);
    if (isVid) {
      const t = (frame - o.fromFrame) / fps();
      if (Math.abs(el.currentTime - t) > 0.15 && el.readyState >= 1) el.currentTime = t;
      if (state.playing && el.paused) el.play().catch(() => {});
      if (!state.playing && !el.paused) el.pause();
    }
  }
  for (const [id, el] of state.overlayEls) {
    if (!live.has(id)) { el.remove(); state.overlayEls.delete(id); }
  }
  syncOverlayHandle();

  // Captions.
  const cap = $('#caption-layer');
  const active = (film.captions ?? []).filter((c) => frame >= c.fromFrame && frame < c.toFrame);
  cap.textContent = active.map((c) => c.text).join('\n');
  const style = film.captionStyle ?? {};
  cap.style.fontSize = `${(pb.clientHeight * (style.sizePct ?? 4.5)) / 100}px`;
  if ((style.position ?? 'bottom') === 'top') { cap.style.top = '4.5%'; cap.style.bottom = 'auto'; }
  else { cap.style.bottom = '4.5%'; cap.style.top = 'auto'; }
}

/* ---- placing an overlay by hand (v0.28) ------------------------------- */

/*
 * An overlay's box lived only in the inspector's x/y/width sliders, so putting
 * a face cam in a corner meant reading three numbers and imagining the result.
 * Now the picture itself is the control: drag it to move, drag its corner to
 * resize. Percentages stay the stored truth — that is what keeps a placement
 * meaningful across aspect variants — the drag just writes them.
 *
 * PREVIEW ONLY, and that is not an omission. In `built film` the overlay is
 * already composited into the file by the finishing pass; there is no element
 * to grab, and offering a handle over baked pixels would promise an edit that
 * could not happen. `updateLayers` removes the live layer in that mode, so this
 * code is simply never reached there.
 *
 * The commit shape is the sliders': live updates during the gesture touch state
 * and the preview only, then ONE `mutate` on release — so a drag is one undo
 * step and one save, not a hundred.
 */

/** The slider bounds, so a drag and the inspector can never disagree. */
const OVERLAY_BOUNDS = { pos: [-50, 150], width: [2, 200] };
/** The sliders step in halves; matching it keeps the numbers readable. */
const halfStep = (n) => Math.round(n * 2) / 2;

function overlayById(id) {
  return (state.film?.overlays ?? []).find((x) => x.id === id) ?? null;
}

/** Percent of the player box that one pixel is worth, on each axis. */
function overlayPctPerPx() {
  const pb = $('#player-box');
  return { x: 100 / Math.max(1, pb.clientWidth), y: 100 / Math.max(1, pb.clientHeight) };
}

/**
 * A drag that edits the film document: live while it moves, one commit at the
 * end. `apply` writes onto the live object (preview only); `final` is what the
 * single mutate writes.
 */
function overlayGesture(ev, id, { apply }) {
  const o = overlayById(id);
  if (!o) return;
  ev.preventDefault();
  ev.stopPropagation();
  const before = { xPct: o.xPct ?? 0, yPct: o.yPct ?? 0, widthPct: o.widthPct ?? 30 };
  const per = overlayPctPerPx();
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  let next = { ...before };

  const move = (e2) => {
    next = apply(before, (e2.clientX - x0) * per.x, (e2.clientY - y0) * per.y);
    const live = overlayById(id);
    if (!live) return;
    Object.assign(live, next);
    updateLayers(state.playhead);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const live = overlayById(id);
    if (!live) return;
    // Put the pre-drag values back, then commit once: the undo stack gets the
    // whole gesture as a single step, exactly as the sliders do it.
    Object.assign(live, before);
    if (next.xPct === before.xPct && next.yPct === before.yPct && next.widthPct === before.widthPct) {
      updateLayers(state.playhead);
      return;
    }
    mutate((film) => {
      const target = (film.overlays ?? []).find((x) => x.id === id);
      if (target) Object.assign(target, next);
    }, { silent: true });
    updateLayers(state.playhead);
    if (state.selection?.kind === 'overlay' && state.selection.id === id) renderInspector();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Click to select, drag to move. Attached once, when the element is created. */
function attachOverlayDrag(el, id) {
  el.addEventListener('pointerdown', (ev) => {
    if (state.source === 'delivery') return;      // baked pixels, nothing to move
    if (state.selection?.kind !== 'overlay' || state.selection.id !== id) {
      select({ kind: 'overlay', id });
      renderInspector();
    }
    overlayGesture(ev, id, {
      apply: (before, dxPct, dyPct) => ({
        ...before,
        xPct: halfStep(clamp(before.xPct + dxPct, ...OVERLAY_BOUNDS.pos)),
        yPct: halfStep(clamp(before.yPct + dyPct, ...OVERLAY_BOUNDS.pos)),
      }),
    });
  });
}

/** Keep the resize grip on the selected overlay's bottom-right corner. */
function syncOverlayHandle() {
  const grip = $('#overlay-handle');
  if (!grip) return;
  const sel = state.selection;
  const el = sel?.kind === 'overlay' && state.source !== 'delivery' ? state.overlayEls.get(sel.id) : null;
  if (!el || !el.offsetWidth) { grip.classList.add('hidden'); return; }
  grip.classList.remove('hidden');
  grip.style.left = `${el.offsetLeft + el.offsetWidth}px`;
  grip.style.top = `${el.offsetTop + el.offsetHeight}px`;
}

$('#overlay-handle')?.addEventListener('pointerdown', (ev) => {
  const sel = state.selection;
  if (sel?.kind !== 'overlay') return;
  overlayGesture(ev, sel.id, {
    // Width only: height follows from the asset's own aspect, so a drag can
    // never squash the picture.
    apply: (before, dxPct) => ({
      ...before,
      widthPct: halfStep(clamp(before.widthPct + dxPct, ...OVERLAY_BOUNDS.width)),
    }),
  });
});

/* ------------------------------ playback ------------------------------- */

function updateMixChip() {
  const el = $('#mix-state');
  const m = state.mix;
  const hasAudio = (state.film?.audio ?? []).length > 0;
  el.className = 'sb-item mono';
  if (!hasAudio) { el.textContent = ''; return; }
  if (m.building) { el.textContent = '⏳ mixing audio…'; el.classList.add('building'); }
  else if (m.url && !m.dirty) { el.textContent = '♪ master mix ready'; el.classList.add('ready'); }
  else { el.textContent = '♪ mix on next play'; el.classList.add('dim'); }
  StudioUtil.syncDocument();
}

async function buildMix() {
  if (state.mix.building || !filmId) return;
  state.mix.building = true;
  // What this render is OF. An edit landing while ffmpeg runs is dropped by the
  // guard above, so the mix that arrives can already be out of date — compare
  // at the end and go again rather than leaving a stale one marked ready.
  const renderingFor = lastMixJson;
  updateMixChip();
  try {
    const res = await fetch(`/api/films/${fid}/preview-audio`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.message || res.statusText), { data });
    }
    const blob = await res.blob();
    if (state.mix.url) URL.revokeObjectURL(state.mix.url);
    state.mix.url = URL.createObjectURL(blob);
    state.mix.el = new Audio(state.mix.url);
    state.mix.dirty = false;
    if (state.playing) {
      state.mix.el.currentTime = state.playhead / fps();
      await state.mix.el.play().catch(() => {});
      state.mix.active = true;
      // Hand the clock to the audio: re-anchor so there is no jump.
      state.play.t0 = performance.now();
      state.play.frame0 = state.playhead;
    }
  } catch (err) {
    toastError(err);
    state.mix.dirty = true;
  } finally {
    state.mix.building = false;
    if (renderingFor !== lastMixJson) {
      state.mix.dirty = true;
      if (state.playing) setTimeout(buildMix, 0);
    }
    updateMixChip();
  }
}

function startPlayback() {
  if (state.playing || !totalFrames()) return;
  if (state.playhead >= totalFrames() - 1) state.playhead = 0;
  state.playing = true;
  $('#btn-play').textContent = '⏸';
  $('#btn-play').classList.add('playing');
  state.play.t0 = performance.now();
  state.play.frame0 = state.playhead;

  // A delivery carries its own finished mix; the file is the clock and the
  // preview mixer stays out of it entirely.
  if (state.source === 'delivery') {
    syncVideo(state.playhead);
    $('#video-film').play().catch(() => {});
    state.play.raf = requestAnimationFrame(tick);
    return;
  }

  const hasMaster = (state.film.audio ?? []).length > 0;
  if (hasMaster) {
    if (state.mix.el && !state.mix.dirty) {
      state.mix.el.currentTime = state.playhead / fps();
      state.mix.el.play().catch(() => {});
      state.mix.active = true;
    } else {
      buildMix(); // async; the clock drives until the mix lands
    }
  }
  state.play.raf = requestAnimationFrame(tick);
}

function stopPlayback() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(state.play.raf);
  $('#btn-play').textContent = '▶';
  $('#btn-play').classList.remove('playing');
  state.mix.el?.pause();
  state.mix.active = false;
  videoEls.forEach((v) => v.pause());
  $('#video-film').pause();
  for (const el of state.overlayEls.values()) el.pause?.();
}

function tick(now) {
  if (!state.playing) return;
  let f;
  const dv = $('#video-film');
  if (state.source === 'delivery' && state.manifest && !dv.paused && !dv.ended) {
    f = dv.currentTime * (state.manifest.fps || fps()); // the built file is the clock
  } else if (state.mix.active && state.mix.el && !state.mix.el.ended) {
    f = state.mix.el.currentTime * fps(); // audio is the master clock
  } else {
    f = state.play.frame0 + ((now - state.play.t0) / 1000) * fps();
  }
  if (f >= totalFrames()) {
    stopPlayback();
    setPlayhead(Math.max(0, totalFrames() - 1));
    return;
  }
  setPlayhead(f, { fromTick: true });
  state.play.raf = requestAnimationFrame(tick);
}

function setPlayhead(frame, { fromTick = false } = {}) {
  state.playhead = clamp(frame, 0, Math.max(0, totalFrames() - (fromTick ? 0 : 1)));
  const ph = $('#tl-playhead');
  if (ph) ph.style.left = `${HEAD_W + state.playhead * state.pxf}px`;
  $('#frame-now').textContent = Math.floor(state.playhead);
  $('#timecode').textContent = timecode(state.playhead);
  if (!fromTick && state.mix.active && state.mix.el) state.mix.el.currentTime = state.playhead / fps();
  if (!fromTick) { state.play.t0 = performance.now(); state.play.frame0 = state.playhead; }
  syncVideo(state.playhead);
  updateLayers(state.playhead);
  if (fromTick) autoScroll();
}

function autoScroll() {
  const sc = $('#tl-scroll');
  const x = HEAD_W + state.playhead * state.pxf;
  if (x < sc.scrollLeft + HEAD_W || x > sc.scrollLeft + sc.clientWidth - 60) {
    sc.scrollLeft = x - HEAD_W - 40;
  }
}

$('#btn-play').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));
$('#btn-step-back').addEventListener('click', () => { stopPlayback(); setPlayhead(Math.floor(state.playhead) - 1); });
$('#btn-step-fwd').addEventListener('click', () => { stopPlayback(); setPlayhead(Math.floor(state.playhead) + 1); });

/* ------------------------------- waveforms ------------------------------ */

function loadWave(src) {
  if (state.waves.has(src)) return;
  state.waves.set(src, { loading: true });
  (async () => {
    try {
      const buf = await (await fetch(assetUrl(src))).arrayBuffer();
      state.audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
      const audio = await state.audioCtx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const BUCKETS = 600;
      const peaks = new Float32Array(BUCKETS);
      const per = Math.max(1, Math.floor(ch.length / BUCKETS));
      for (let b = 0; b < BUCKETS; b++) {
        let m = 0;
        const start = b * per, end = Math.min(ch.length, start + per);
        for (let i = start; i < end; i += 16) { const a = Math.abs(ch[i]); if (a > m) m = a; }
        peaks[b] = m;
      }
      state.waves.set(src, { duration: audio.duration, peaks });
      renderTimeline(); // widths were guesses until now
      if (state.selection?.kind === 'audio') renderInspector();
    } catch {
      state.waves.set(src, { failed: true });
    }
  })();
}

/* Both trims index the SOURCE file: the clip plays [trimStart, trimEnd). The
 * head trim is v0.27 — before it, a clip could only be shortened from the end,
 * so dropping two seconds of silence off the front of a take meant editing the
 * file. `clipFrames` is what the timeline draws; `naturalFrames` is the file. */
const headFrames = (track) => track.trimStartInFrames ?? 0;
function clipFrames(track) {
  const head = headFrames(track);
  if (track.trimEndInFrames) return Math.max(1, track.trimEndInFrames - head);
  const nat = naturalFrames(track);
  if (nat) return Math.max(1, nat - head);
  return FALLBACK_CLIP_FRAMES;
}
function naturalFrames(track) {
  const wave = state.waves.get(track.src);
  return wave?.duration ? Math.max(1, Math.round(wave.duration * fps())) : null;
}

function drawWave(canvas, track) {
  const wave = state.waves.get(track.src);
  const W = canvas.width = Math.min(2000, Math.max(8, canvas.offsetWidth));
  const H = canvas.height = canvas.offsetHeight || 36;
  if (!wave?.peaks) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = track.duck ? 'rgba(178,142,230,0.75)' : 'rgba(127,209,140,0.7)';
  // Draw the KEPT WINDOW of the file, not its first N seconds: with a head
  // trim the block shows source frames [trimStart, trimEnd), and a waveform
  // that still started at the file's beginning would be a picture of audio the
  // build no longer plays.
  const total = naturalFrames(track) ?? clipFrames(track);
  const from = clamp(headFrames(track) / total, 0, 1);
  const to = clamp((track.trimEndInFrames ?? total) / total, from, 1);
  const i0 = Math.floor(wave.peaks.length * from);
  const i1 = Math.max(i0 + 1, Math.floor(wave.peaks.length * to));
  for (let x = 0; x < W; x++) {
    const p = wave.peaks[i0 + Math.floor((x / W) * (i1 - i0))] ?? 0;
    const h = Math.max(1, p * (H - 4));
    ctx.fillRect(x, (H - h) / 2, 1, h);
  }
}

/* ------------------------------- timeline ------------------------------- */

function packLanes(items) {
  const lanes = [];
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    let lane = lanes.find((l) => l.end <= it.start);
    if (!lane) { lane = { end: 0, items: [] }; lanes.push(lane); }
    lane.items.push(it);
    lane.end = Math.max(lane.end, it.end);
  }
  return lanes.map((l) => l.items);
}

/* ------------------------------ lanes ----------------------------------- */

/* Lanes used to be a picture, not a fact: rows were derived by packing items
 * into the fewest non-overlapping rows on every repaint. So a lane appeared
 * when two clips overlapped and VANISHED the moment you dragged them apart —
 * the track you had carefully built disappeared underneath the mouse — and
 * "give me an empty lane to work in" was unsayable, because a lane with
 * nothing in it could not exist. Now an item carries `lane`, the film carries
 * how many lanes each family shows, and the packing below is only the
 * migration for films authored before this. */

const LANE_FAMILIES = ['audio', 'captions', 'overlays'];

/* Every row of the timeline the human can select and advise on — the two
 * single-row families above the cut, then the three stacking ones. The advice
 * row is deliberately absent: it is the record of the conversation, not a part
 * of the film, and "advise on the advice" is not a thing anyone means. */
const ADVISABLE_FAMILIES = ['sequences', 'scenes', ...LANE_FAMILIES];
const SINGLE_ROW_FAMILIES = ['sequences', 'scenes'];
const laneFamilyRows = (family) => (SINGLE_ROW_FAMILIES.includes(family) ? 1 : laneRows(family).length);
/** The head text of one row — the same words the human clicked on. */
function laneLabel(family, li = 0) {
  const word = { sequences: 'sequences', scenes: 'scenes', audio: 'audio', captions: 'captions', overlays: 'overlay' }[family];
  return laneFamilyRows(family) > 1 ? `${word} ${li + 1}` : word;
}
/** Identity of a row, for matching a selection to the head that drew it. */
const laneKey = (family, li = 0) => `${family}:${SINGLE_ROW_FAMILIES.includes(family) ? 0 : li}`;
const laneSelKey = (sel) => (sel?.kind === 'lane' ? laneKey(sel.family, sel.lane) : null);
/** How many things are in one row right now — what the lane's advice is about. */
function laneContents(family, li = 0) {
  if (family === 'sequences') return sequenceBands().filter((b) => b.label).length;
  if (family === 'scenes') return (state.detail?.scenes ?? []).length;
  return (laneRows(family)[li] ?? []).length;
}

/* Which lane the next item of each family goes into — set by the `+` you
 * clicked, cleared as soon as it is used, so "add audio" from the toolbar or
 * the palette still means lane 1. */
const pendingLane = { audio: 0, captions: 0, overlays: 0 };
function takeLane(family) {
  const lane = pendingLane[family] ?? 0;
  pendingLane[family] = 0;
  return Math.max(0, Math.min(laneRows(family).length - 1, lane));
}
const MAX_LANES = 32;
const laneItems = (family) => state.film?.[family] ?? [];
const laneStartOf = (family, it) => (family === 'audio' ? (it.startInFrames ?? 0) : it.fromFrame);
const laneEndOf = (family, it) => (family === 'audio'
  ? (it.startInFrames ?? 0) + clipFrames(it)
  : it.toFrame);

/** Which lane each item is drawn in — stored when it has one, packed when not. */
function laneAssignment(family) {
  const items = laneItems(family);
  const map = new Map();
  const legacy = items.filter((it) => !Number.isInteger(it.lane));
  for (const it of items) if (Number.isInteger(it.lane)) map.set(it, Math.min(MAX_LANES - 1, it.lane));
  if (legacy.length) {
    // Films written before lanes were real: keep exactly the rows they have
    // always been drawn in, so opening one looks like nothing happened.
    packLanes(legacy.map((it) => ({ item: it, start: laneStartOf(family, it), end: laneEndOf(family, it) })))
      .forEach((group, li) => group.forEach(({ item }) => map.set(item, li)));
  }
  return map;
}

/** The rows to draw for a family: at least one, never fewer than it needs. */
function laneRows(family) {
  const map = laneAssignment(family);
  const declared = state.film?.lanes?.[family] ?? 0;
  const needed = Math.max(...[...map.values()].map((n) => n + 1), 0);
  const count = Math.min(MAX_LANES, Math.max(1, declared, needed));
  const rows = Array.from({ length: count }, () => []);
  for (const it of laneItems(family)) rows[Math.min(count - 1, map.get(it) ?? 0)].push(it);
  return rows;
}

/**
 * Write down what the rows currently say, inside a mutation.
 *
 * Called by every lane-affecting edit, so a film converts from packed to
 * explicit lanes the first time someone touches one — and from then on a drag
 * moves a clip without rearranging everything around it.
 */
function persistLanes(film, family, rows) {
  rows.forEach((items, li) => {
    for (const it of items) {
      const stored = (film[family] ?? []).find((x) => x.id === it.id);
      if (stored) stored.lane = li;
    }
  });
  film.lanes = { ...(film.lanes ?? {}), [family]: rows.length };
}

/** Add an empty lane at the bottom of a family — the thing that was unsayable. */
function addLane(family) {
  const rows = laneRows(family);
  if (rows.length >= MAX_LANES) return toast(`${family} already has ${MAX_LANES} lanes.`, { kind: 'error' });
  mutate((film) => {
    persistLanes(film, family, rows);
    film.lanes = { ...(film.lanes ?? {}), [family]: rows.length + 1 };
  });
}

/** Remove one empty lane, and pull the lanes below it up. */
function removeLane(family, index) {
  const rows = laneRows(family);
  if (rows.length <= 1 || rows[index]?.length) return;
  const kept = rows.filter((_, i) => i !== index);
  mutate((film) => {
    persistLanes(film, family, kept);
    // The lanes below the removed one move up, and their mute has to move with
    // them — otherwise deleting lane 1 silences whatever was in lane 2.
    if (family === 'audio' && film.mutedLanes?.audio) {
      const shifted = film.mutedLanes.audio
        .filter((n) => n !== index)
        .map((n) => (n > index ? n - 1 : n));
      if (shifted.length) film.mutedLanes = { ...film.mutedLanes, audio: shifted };
      else delete film.mutedLanes.audio;
    }
  });
}

/* ------------------------------- mute ---------------------------------- */

/* Mute is the LANE's, not the clip's: mute lane 2 to hear the film without the
 * bed, drop another bed clip in, and it is silent too. A single clip can still
 * be silenced on its own from the inspector — the mix drops a track when either
 * says so, which is `audibleTracks` in core/films.js, so what you hear here,
 * what preview_audio mixes and what the build renders cannot disagree. */
const mutedLanes = () => state.film?.mutedLanes?.audio ?? [];
const isLaneMuted = (lane) => mutedLanes().includes(lane);
const isTrackAudible = (t) => !t.mute && !isLaneMuted(t.lane ?? 0);

/**
 * Do the rows this page DRAWS disagree with the lane the mixer READS?
 *
 * They can, and on exactly the films that matter. `audibleTracks` in
 * core/films.js decides a track's lane with `t.lane ?? 0`, but a film authored
 * before lanes existed carries no `lane` at all — and every film an agent
 * builds is such a film, because `update_film` writes the tracks the caller
 * sent and nothing stamps a lane on them. The timeline draws those by *packing*
 * them into rows, so four tracks appear on three lanes here while the mix sees
 * four tracks on lane 0. That gap is invisible until someone mutes: silencing
 * the row labelled `audio 1` silences the whole film.
 */
function audioLanesDiverge() {
  return [...laneAssignment('audio')].some(([it, li]) => li !== (it.lane ?? 0));
}

/**
 * Resolve once every audio clip's length is a measurement rather than a guess.
 *
 * `clipFrames` falls back to a fixed width until the file has been fetched and
 * decoded, so anything that reasons about which clips overlap has to wait. A
 * decode that failed counts as settled: its fallback width is what the timeline
 * draws too, so a layout built on it still matches what is on screen. Returns
 * false if a decode is still outstanding after ~10s, and the caller does
 * nothing rather than act on a guess.
 */
async function audioDurationsSettled() {
  const srcs = [...new Set((state.film?.audio ?? []).map((t) => t.src))];
  for (const src of srcs) loadWave(src);
  const pending = () => srcs.some((s) => state.waves.get(s)?.loading);
  for (let i = 0; i < 200 && pending(); i++) await new Promise((r) => setTimeout(r, 50));
  return !pending();
}

function toggleLaneMute(lane) {
  const next = isLaneMuted(lane)
    ? mutedLanes().filter((n) => n !== lane)
    : [...mutedLanes(), lane].sort((a, b) => a - b);
  // Write the drawn rows down BEFORE recording the mute, exactly as every other
  // lane edit does (addLane, removeLane, moveToLane). Muting is the one lane
  // action whose meaning leaves this page, so it is the one that cannot afford
  // to leave the packing implicit: after this, the lane the mixer reads is the
  // row you clicked on.
  const rows = laneRows('audio');
  mutate((film) => {
    persistLanes(film, 'audio', rows);
    // Always STATE the list, never delete the key: a patch that omits a field
    // keeps the field's saved value, so `delete` would leave the lane muted on
    // disk while the editor showed it live.
    film.mutedLanes = { ...(film.mutedLanes ?? {}), audio: next };
  });
}

/**
 * Repair a film that was muted while its lanes were still implicit.
 *
 * A film saved before the fix above holds a mute that means one row on screen
 * and every track in the mix — it opens with the timeline showing one amber
 * lane head and every clip dimmed, and `preview_audio` refusing with "every
 * track on this film is muted". Writing the drawn rows down once resolves it
 * the way the human meant it: the row they muted stays muted, the rest come
 * back.
 *
 * Deliberately narrow. It fires only when a mute is actually in force AND the
 * lanes diverge, so simply opening a film never bumps its revision under an
 * agent that is mid-production with an `expectedRevision` in hand.
 */
let repairingLanes = false;
async function repairPackedLaneMute() {
  // One at a time. Loading a film runs `refresh()` more than once — the boot
  // call, then the catch-up when the overview notices a newer revision — and
  // two repairs waiting on the same decodes would both wake to the same
  // divergence, save it twice and say so twice.
  if (repairingLanes || !state.film || !mutedLanes().length) return;
  repairingLanes = true;
  try { await runLaneMuteRepair(); } finally { repairingLanes = false; }
}

async function runLaneMuteRepair() {
  // The packing is done by DURATION, and a clip's duration arrives with its
  // decoded waveform — several fetches and decodes after the page loads. Repair
  // before they land and the rows written down are not the rows the packing
  // will settle on, let alone the ones anybody saw: an undecoded clip is a
  // fallback width, so two clips that do overlap look like they do not and
  // share a lane. Wait for the picture to be true, then write it down.
  if (!await audioDurationsSettled()) return;
  if (!audioLanesDiverge()) return;
  const silenced = (state.film.audio ?? []).filter((t) => !isTrackAudible(t)).length;
  persistLanes(state.film, 'audio', laneRows('audio'));
  const nowSilenced = (state.film.audio ?? []).filter((t) => !isTrackAudible(t)).length;
  scheduleSave({ now: true });
  invalidateMixIfAudioChanged(); // tracks just came back — a cached mix without them is a lie
  renderTimeline();
  if (nowSilenced < silenced) {
    toast(`Muting on this film silenced all ${silenced} tracks, not the lane it was aimed at: the tracks were `
      + 'written before lanes were, so the mix read every one of them as lane 1. The lanes you see are now the '
      + `lanes the mix reads — ${nowSilenced} track${nowSilenced === 1 ? '' : 's'} muted, the rest are back.`,
    { kind: 'info', timeoutMs: 15000 });
  }
}

/** Move one item to another lane (the vertical half of a drag). */
function moveToLane(family, id, lane) {
  const rows = laneRows(family);
  const target = Math.max(0, Math.min(rows.length - 1, lane));
  const from = rows.findIndex((items) => items.some((it) => it.id === id));
  if (from === target) return;
  const next = rows.map((items) => items.filter((it) => it.id !== id));
  const moved = rows[from]?.find((it) => it.id === id);
  if (moved) next[target].push(moved);
  mutate((film) => persistLanes(film, family, next));
}

/**
 * Which lane row is under the pointer, for a drag that crosses lanes.
 *
 * Measured once when the drag starts: the rows do not move under it, and
 * hit-testing live would re-measure on every pointermove.
 */
function laneHitboxes(family) {
  return [...document.querySelectorAll(`.tl-row[data-family="${family}"]`)].map((r) => {
    const box = r.getBoundingClientRect();
    return { lane: Number(r.dataset.lane), top: box.top, bottom: box.bottom, row: r };
  });
}

function laneUnder(boxes, clientY) {
  if (!boxes.length) return null;
  const hit = boxes.find((b) => clientY >= b.top && clientY < b.bottom);
  if (hit) return hit;
  return clientY < boxes[0].top ? boxes[0] : boxes[boxes.length - 1];
}

function snapTargets(exclude) {
  const t = [0, totalFrames(), Math.round(state.playhead)];
  for (const s of state.detail?.scenes ?? []) { t.push(s.filmOffset, s.filmOffset + s.durationInFrames); }
  for (const a of state.film.audio ?? []) {
    if (exclude?.kind === 'audio' && exclude.id === a.id) continue;
    const s = a.startInFrames ?? 0;
    t.push(s, s + clipFrames(a));
  }
  for (const kind of ['captions', 'overlays']) {
    for (const c of state.film[kind] ?? []) {
      if ((exclude?.kind === 'caption' || exclude?.kind === 'overlay') && exclude.id === c.id) continue;
      t.push(c.fromFrame, c.toFrame);
    }
  }
  return t;
}

function snapFrame(f, exclude) {
  if (!state.snap) return { f: Math.round(f), snapped: null };
  const threshold = 8 / state.pxf;
  let best = null, bestDist = threshold;
  for (const t of snapTargets(exclude)) {
    const d = Math.abs(t - f);
    if (d < bestDist) { best = t; bestDist = d; }
  }
  return best !== null ? { f: best, snapped: best } : { f: Math.round(f), snapped: null };
}

function tlWidth() { return HEAD_W + Math.max(1, totalFrames()) * state.pxf + TAIL_PX; }

/**
 * One row: a sticky head and the lane beside it.
 *
 * The head's controls sit in a fixed three-column group — mute · add · lane —
 * and every row renders all three, using an empty slot where it has nothing to
 * put. Before this each button was appended in turn with `margin-left: auto`
 * on the first, so a row with one button put it where the row below put its
 * second, and no two columns lined up down the timeline.
 *
 * `family` makes the head itself a target: clicking it selects the whole row,
 * which is what "the captions are all late" is about. The ruler and the advice
 * row pass nothing and stay inert.
 */
function row(cls, headText, laneWidth, { family = null, laneIndex = 0 } = {}) {
  const r = document.createElement('div');
  r.className = `tl-row ${cls}`;
  const head = document.createElement('div');
  head.className = 'tl-head';
  const label = document.createElement('span');
  label.className = 'tl-head-label';
  label.textContent = headText;
  label.title = headText;
  const btns = document.createElement('div');
  btns.className = 'lane-btns';
  head.append(label, btns);
  if (family) {
    const li = SINGLE_ROW_FAMILIES.includes(family) ? 0 : laneIndex;
    head.dataset.laneKey = laneKey(family, li);
    head.classList.add('selectable');
    head.classList.toggle('selected', laneSelKey(state.selection) === head.dataset.laneKey);
    // Between the name and the buttons, so it reads with the row's name rather
    // than sitting past the controls where it looks like a fourth one.
    const n = unresolvedCount(laneAdviceMatcher(family, li));
    if (n) head.insertBefore(adviceBadge(n), btns);
    head.title = `${headText} — the whole row.\nClick to select it, then ✎ advise to tell the AI about it.`;
    head.addEventListener('pointerdown', (ev) => {
      // The head's own buttons act on the lane; they are not a way of picking it.
      if (ev.target.closest('.lane-add')) return;
      select({ kind: 'lane', family, lane: li });
    });
  }
  const lane = document.createElement('div');
  lane.className = 'lane';
  lane.style.width = `${laneWidth}px`;
  r.append(head, lane);
  return { row: r, head, lane, btns, label };
}

/** A head button in one of the three slots, or the empty slot that holds it. */
function laneBtn(text, title, onClick, cls = '') {
  if (!onClick) {
    const slot = document.createElement('span');
    slot.className = 'lane-slot';
    return slot;
  }
  const b = document.createElement('button');
  b.className = `lane-add ${cls}`.trim();
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function addCutlines(lane) {
  for (const s of (state.detail?.scenes ?? []).slice(1)) {
    const c = document.createElement('div');
    c.className = 'cutline';
    c.style.left = `${s.filmOffset * state.pxf}px`;
    lane.appendChild(c);
  }
}

function renderTimeline() {
  const inner = $('#tl-inner');
  if (!inner || !state.film) return;
  const sc = $('#tl-scroll');
  const keepScroll = { left: sc.scrollLeft, top: sc.scrollTop };
  inner.innerHTML = '';
  const laneW = tlWidth() - HEAD_W;
  inner.style.width = `${tlWidth()}px`;

  /* ruler */
  {
    const { row: r, lane } = row('tl-ruler-row', '', laneW);
    const F = fps();
    const targetPx = 90;
    const NICE = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const sec = NICE.find((s) => s * F * state.pxf >= targetPx) ?? 600;
    const step = Math.max(1, Math.round(sec * F));
    for (let f = 0; f <= totalFrames(); f += step) {
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = `${f * state.pxf}px`;
      const label = document.createElement('span');
      // Sub-second grids need the decimals or every label reads "00:00".
      label.textContent = step >= F ? timecode(f).replace(/\.\d+$/, '') : timecode(f);
      tick.appendChild(label);
      lane.appendChild(tick);
      const half = f + step / 2;
      if (half < totalFrames() && step * state.pxf > 50) {
        const minor = document.createElement('div');
        minor.className = 'tick minor';
        minor.style.left = `${half * state.pxf}px`;
        lane.appendChild(minor);
      }
    }
    const scrub = (ev) => { stopPlayback(); setPlayhead(frameOfEvent(ev)); };
    lane.addEventListener('pointerdown', (ev) => {
      scrub(ev);
      const move = (e2) => scrub(e2);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    inner.appendChild(r);
  }

  /* sequences — the narrative band above the cut (v0.23) */
  {
    const { row: r, lane, btns } = row('row-sequences', 'sequences', laneW, { family: 'sequences' });
    // Three empty slots, not none: the mute · add · lane columns line up down
    // the whole timeline, and a row that skipped them would pull the rows
    // below it out of true. A sequence is made by dragging across this lane.
    btns.append(laneBtn('', '', null), laneBtn('', '', null), laneBtn('', '', null));
    for (const band of sequenceBands()) lane.appendChild(sequenceBlock(band));
    inner.appendChild(r);
  }

  /* scenes */
  {
    const { row: r, lane, btns } = row('row-scenes', 'scenes', laneW, { family: 'scenes' });
    // As above. This row's `+` only ever revealed the rail and pulsed it —
    // a signpost to `+ new scene`, not an action — so the rail is the one
    // place scenes are made, and the timeline is where they are arranged.
    btns.append(laneBtn('', '', null), laneBtn('', '', null), laneBtn('', '', null));
    addCutlines(lane);
    (state.detail?.scenes ?? []).forEach((s, i) => lane.appendChild(sceneBlock(s, i)));
    inner.appendChild(r);
  }

  /* audio · captions · overlays — the lane families (v0.27: lanes are stored,
   * so one you added is still there after a drag, a reload, or an agent's
   * edit, and one you emptied is still there to drop the next clip into). */
  for (const family of LANE_FAMILIES) {
    const spec = {
      audio: { cls: 'row-audio', label: 'audio', add: openAudioDialog, addTitle: 'add audio at the playhead, in this lane', block: (it) => audioBlock(it) },
      captions: { cls: 'row-captions', label: 'captions', add: addCaptionAtPlayhead, addTitle: 'add a caption at the playhead, in this lane', block: (it) => rangeBlock(it, 'caption') },
      overlays: { cls: 'row-overlays', label: 'overlay', add: openOverlayDialog, addTitle: 'add an overlay at the playhead, in this lane', block: (it) => rangeBlock(it, 'overlay') },
    }[family];
    const rows = laneRows(family);
    rows.forEach((items, li) => {
      const { row: r, lane, btns } = row(spec.cls, laneLabel(family, li), laneW, { family, laneIndex: li });
      r.dataset.family = family;
      r.dataset.lane = String(li);

      // Slot 1 — mute. Audio only: a caption lane makes no sound to silence.
      const muted = family === 'audio' && isLaneMuted(li);
      if (family === 'audio') {
        const m = laneBtn('♪', muted ? 'unmute this lane' : 'mute this lane — its clips leave the mix, the build and the preview',
          () => toggleLaneMute(li), `lane-mute${muted ? ' on' : ''}`);
        m.setAttribute('aria-pressed', String(muted));
        btns.appendChild(m);
        r.classList.toggle('lane-muted', muted);
      } else {
        btns.appendChild(laneBtn('', '', null));
      }

      // Slot 2 — add an item, into THIS lane.
      btns.appendChild(laneBtn('+', spec.addTitle, () => { pendingLane[family] = li; spec.add(); }));

      // Slot 3 — the lane itself. An empty lane below the first offers to go;
      // otherwise the last lane offers another below it. The two never compete
      // for the slot, because an empty last lane IS the lane you would add.
      // The first lane never goes: a family always has somewhere to put its
      // next item.
      if (li > 0 && !items.length) {
        btns.appendChild(laneBtn('✕', 'remove this empty lane', () => removeLane(family, li), 'lane-del'));
      } else if (li === rows.length - 1) {
        btns.appendChild(laneBtn('⊕', `add another ${spec.label} lane — empty, and it stays`,
          () => addLane(family), 'lane-more'));
      } else {
        btns.appendChild(laneBtn('', '', null));
      }

      addCutlines(lane);
      for (const it of items) lane.appendChild(spec.block(it));
      inner.appendChild(r);
    });
  }

  /* advice — where the human has spoken (v0.23) */
  {
    const { row: r, lane } = row('row-advice', 'advice', laneW);
    for (const a of state.advice ?? []) {
      const frame = adviceFilmFrame(a);
      if (frame == null) continue;
      const m = document.createElement('div');
      m.className = `adv-marker${a.status === 'resolved' ? ' resolved' : ''}`;
      m.style.left = `${frame * state.pxf}px`;
      m.title = `${humanAdviceStatus(a).label} — ${a.message.slice(0, 120)}`;
      m.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      m.addEventListener('click', (ev) => { ev.stopPropagation(); focusAdvice(a); });
      lane.appendChild(m);
    }
    inner.appendChild(r);
  }

  /* playhead */
  const ph = document.createElement('div');
  ph.className = 'tl-playhead';
  ph.id = 'tl-playhead';
  ph.style.left = `${HEAD_W + state.playhead * state.pxf}px`;
  inner.appendChild(ph);

  inner.classList.toggle('stale-delivery', deliveryIsStale());
  sc.scrollLeft = keepScroll.left;
  sc.scrollTop = keepScroll.top;
}

/* --------------------------- narrative sequences ------------------------ */

/**
 * Consecutive segments sharing a `sequence` label form one band — the same
 * rule the engine's `sequenceBands` uses, so the picture here and the plan the
 * AI reads can never disagree. Unlabeled runs become anonymous bands so the
 * timeline is always fully covered: a half-labeled film still navigates.
 */
function sequenceBands() {
  const bands = [];
  (state.detail?.scenes ?? []).forEach((s, i) => {
    const label = s.sequence ?? null;
    const last = bands[bands.length - 1];
    if (last && last.label === label) {
      last.to = i;
      last.frames += s.durationInFrames ?? 0;
      last.segments.push(s);
      return;
    }
    bands.push({
      label, from: i, to: i, offset: s.filmOffset ?? 0,
      frames: s.durationInFrames ?? 0, segments: [s],
    });
  });
  return bands;
}

function sequenceBlock(band) {
  const el = document.createElement('div');
  const selected = state.selection?.kind === 'sequence' && state.selection.sequence === band.label;
  el.className = `seq-band${band.label ? '' : ' anon'}${selected ? ' selected' : ''}`;
  el.style.left = `${band.offset * state.pxf}px`;
  el.style.width = `${Math.max(6, band.frames * state.pxf)}px`;
  const width = band.frames * state.pxf;
  const name = document.createElement('span');
  name.className = 'seq-name';
  // An unnamed stretch is where a sequence gets *made*, so when there is room
  // for it the band says so itself. The gesture was previously discoverable
  // only from a tooltip, which is how "+ seq" ended up being the only route
  // anyone found.
  name.textContent = band.label ?? (width > 150 ? 'drag to make a sequence' : '—');
  el.appendChild(name);
  // Double-click zooms the band to the viewport — movement-to-movement is the
  // granularity a film is reviewed at, and an anonymous run is still a stretch
  // of film worth filling the screen with.
  el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); zoomToRange(band.offset, band.frames); });
  if (band.label) {
    const n = unresolvedCount((a) => a.target?.type === 'sequence' && a.target.sequence === band.label);
    if (n) el.appendChild(adviceBadge(n));
    el.title = `sequence “${band.label}” — ${band.segments.length} segment${band.segments.length === 1 ? '' : 's'}`
      + '\ndouble-click to zoom to it · drag either edge across a cut to change which segments are in it'
      + `${state.film?.sequences?.[band.label]?.intent ? `\n${state.film.sequences[band.label].intent}` : ''}`;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target.classList.contains('grip')) return;
      ev.stopPropagation();
      select({ kind: 'sequence', sequence: band.label });
      stopPlayback();
      setPlayhead(band.offset);
    });
    el.append(bandGrip(el, band, 'left'), bandGrip(el, band, 'right'));
  } else {
    el.title = 'not in a sequence yet — drag across this to make one '
      + '(pull past the end to take scenes off the sequence next door)';
    el.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      drawSequence(ev, el.parentElement);
    });
  }
  return el;
}

/**
 * Draw a new sequence straight onto the lane (v0.28) — the create gesture the
 * timeline never had. It starts on an unnamed stretch, snaps to cuts, and the
 * tooltip names what it is taking as you drag; releasing without moving just
 * parks the playhead there, so the lane stays safe to click.
 *
 * Because it begins on a boundary — an unnamed run always sits between bands —
 * it can grow into either neighbour without ever leaving one sequence in two
 * pieces: the neighbour loses segments off the end nearest you and keeps the
 * rest in one run. That is the whole reason this is the primary way to create,
 * and why it needs no dialog explaining what it is about to do.
 */
function drawSequence(ev, lane) {
  const scenes = state.detail?.scenes ?? [];
  if (!scenes.length || !lane) return;
  const anchor = segmentIndexAt(frameOfEvent(ev));
  let lo = anchor, hi = anchor;
  const marquee = document.createElement('div');
  marquee.className = 'seq-marquee';
  const paint = () => {
    const from = scenes[lo].filmOffset ?? 0;
    const to = (scenes[hi].filmOffset ?? 0) + (scenes[hi].durationInFrames ?? 0);
    marquee.style.left = `${from * state.pxf}px`;
    marquee.style.width = `${Math.max(4, (to - from) * state.pxf)}px`;
  };
  pointerDrag(ev, {
    onMove: (_d, e2) => {
      if (!marquee.isConnected) lane.appendChild(marquee);
      const at = segmentIndexAt(frameOfEvent(e2));
      lo = Math.min(anchor, at);
      hi = Math.max(anchor, at);
      paint();
      // Name the neighbours it is eating into, because that is the only part
      // of this gesture that is not already on screen.
      const taken = new Map();
      for (let i = lo; i <= hi; i++) {
        if (scenes[i].sequence) taken.set(scenes[i].sequence, (taken.get(scenes[i].sequence) ?? 0) + 1);
      }
      const from = [...taken].map(([l, n]) => `${n} from “${l}”`).join(', ');
      dragTip(`${segmentRangeText(lo, hi)}${from ? ` · takes ${from}` : ''}`, e2);
    },
    onDone: (moved) => {
      marquee.remove();
      // A click, not a draw: go to the cut like every other block does.
      if (!moved) { stopPlayback(); setPlayhead(scenes[anchor].filmOffset ?? 0); return select({ kind: 'scene', index: anchor }); }
      nameNewSequence(lo, hi);
    },
  });
}

/**
 * A band edge you can drag (v0.28). A sequence *is* a run of segments, so the
 * only regrouping that keeps that true is moving a boundary — which makes the
 * edge itself the control. Dragging outward takes segments off whichever band
 * is next to it; dragging inward hands them back to that neighbour (or to no
 * sequence at all, at the ends of the film). The edge can only land on a cut,
 * because that is the only place a band can begin or end, and it can never
 * cross the band's far edge: a band with no segments is an *ungroup*, which is
 * a separate, honestly named action.
 */
function bandGrip(el, band, side) {
  const g = document.createElement('div');
  g.className = `grip ${side}`;
  g.title = side === 'left'
    ? `drag across a cut to move where “${band.label}” starts`
    : `drag across a cut to move where “${band.label}” ends`;
  g.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    const scenes = state.detail?.scenes ?? [];
    if (!scenes.length) return;
    // Every cut this edge could sit on, as {index, frame}: for the left edge,
    // the segment the band would start at; for the right, the one it would end
    // at. The range is what stops the band eating itself.
    const marks = [];
    if (side === 'left') {
      for (let i = 0; i <= band.to; i++) marks.push({ index: i, frame: scenes[i].filmOffset ?? 0 });
    } else {
      for (let i = band.from; i < scenes.length; i++) {
        marks.push({ index: i, frame: (scenes[i].filmOffset ?? 0) + (scenes[i].durationInFrames ?? 0) });
      }
    }
    const origIndex = side === 'left' ? band.from : band.to;
    const origFrame = side === 'left' ? band.offset : band.offset + band.frames;
    let pick = marks.find((m) => m.index === origIndex) ?? marks[0];
    pointerDrag(ev, {
      onMove: (d, e2) => {
        const want = origFrame + d;
        pick = marks.reduce((best, m) => (Math.abs(m.frame - want) < Math.abs(best.frame - want) ? m : best), marks[0]);
        const from = side === 'left' ? pick.frame : band.offset;
        const to = side === 'left' ? band.offset + band.frames : pick.frame;
        el.style.left = `${from * state.pxf}px`;
        el.style.width = `${Math.max(6, (to - from) * state.pxf)}px`;
        showSnapline(pick.frame);
        const n = side === 'left' ? band.to - pick.index + 1 : pick.index - band.from + 1;
        dragTip(`${n} segment${n === 1 ? '' : 's'}`, e2);
      },
      onDone: (moved) => {
        if (!moved || pick.index === origIndex) return renderTimeline();
        if (side === 'left') {
          // Grow: the segments in front join us, whatever they were labelled.
          // Shrink: the head we let go joins the band before it — or leaves the
          // sequences entirely, when there is nothing in front of it.
          if (pick.index < band.from) assignSequence(pick.index, band.from - 1, band.label);
          else assignSequence(band.from, pick.index - 1, scenes[band.from - 1]?.sequence ?? null);
        } else if (pick.index > band.to) {
          assignSequence(band.to + 1, pick.index, band.label);
        } else {
          assignSequence(pick.index + 1, band.to, scenes[band.to + 1]?.sequence ?? null);
        }
        renderAll();
      },
    });
  });
  return g;
}

/**
 * Write one label across a contiguous run of segments — the only shape a
 * regrouping can take, because a band is a run. A null label unlabels them.
 * Both copies move in one step: `film.scenes` is what saves, `detail.scenes`
 * is what the timeline is drawn from until the server answers.
 */
function assignSequence(from, to, label) {
  const scenes = state.detail?.scenes ?? [];
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(scenes.length - 1, Math.max(from, to));
  if (hi < lo) return;
  // Whatever this run used to be called might not exist anywhere else once we
  // are done, and intent text for a label no segment carries is exactly what
  // planFilm reports as `unreferencedSequences`. Only labels this call could
  // have emptied are considered — damage that arrived with the film is not
  // ours to quietly tidy away.
  const displaced = new Set();
  for (let i = lo; i <= hi; i++) if (scenes[i].sequence) displaced.add(scenes[i].sequence);
  displaced.delete(label);
  mutate((film) => {
    for (let i = lo; i <= hi; i++) {
      if (label) film.scenes[i].sequence = label;
      else delete film.scenes[i].sequence;
    }
    const meta = { ...(film.sequences ?? {}) };
    if (label) meta[label] ??= {};
    if (displaced.size) {
      const inUse = new Set(film.scenes.map((s) => s.sequence).filter(Boolean));
      for (const gone of displaced) if (!inUse.has(gone)) delete meta[gone];
    }
    film.sequences = meta;
  }, { structural: true, silent: true });
  for (let i = lo; i <= hi; i++) {
    if (label) scenes[i].sequence = label;
    else delete scenes[i].sequence;
  }
}

/** The segment a film frame lands in. */
function segmentIndexAt(frame) {
  const scenes = state.detail?.scenes ?? [];
  const i = scenes.findIndex((s) => frame < (s.filmOffset ?? 0) + (s.durationInFrames ?? 0));
  return i < 0 ? Math.max(0, scenes.length - 1) : i;
}

/**
 * Where “+ seq” starts from: the selected segment, the start of the selected
 * band, or — with nothing selected — the segment under the playhead. It used
 * to fall back to index 0, which is why pressing it without a selection
 * swallowed the entire film into one sequence.
 */
function sequenceAnchor() {
  const sel = state.selection;
  if (sel?.kind === 'scene') return sel.index;
  if (sel?.kind === 'sequence') {
    const band = sequenceBands().find((b) => b.label === sel.sequence);
    if (band) return band.from;
  }
  return segmentIndexAt(Math.floor(state.playhead));
}

/** The last segment of the run `index` shares a label with. */
function bandEnd(index) {
  const scenes = state.detail?.scenes ?? [];
  const label = scenes[index]?.sequence ?? null;
  let i = index;
  while (i + 1 < scenes.length && (scenes[i + 1].sequence ?? null) === label) i++;
  return i;
}

/**
 * What a *new* sequence anchored here covers. On unnamed film it is exactly
 * the segment you pointed at — nothing else has a name to lose, so there is no
 * reason to take more. Inside an existing sequence it runs to that sequence's
 * end, which splits it at the cut rather than leaving its name on two
 * separated stretches of film.
 *
 * Those two cases are the whole rule, and both are visible the instant the
 * band appears — which is why creating no longer opens a dialog to explain
 * itself first.
 */
function newSequenceRange(index) {
  const scenes = state.detail?.scenes ?? [];
  return scenes[index]?.sequence ? [index, bandEnd(index)] : [index, index];
}

const segmentLabel = (s, i) => s?.name ?? s?.label ?? s?.footage ?? `segment ${i + 1}`;

/** "3 segments, “The Truth” → “The Handoff”" — what a drag is taking, live. */
function segmentRangeText(from, to) {
  const scenes = state.detail?.scenes ?? [];
  return from === to
    ? `“${segmentLabel(scenes[from], from)}”`
    : `${to - from + 1} segments, “${segmentLabel(scenes[from], from)}” → “${segmentLabel(scenes[to], to)}”`;
}

/** `sequence 3` — the first number nothing is using. A new band always has a
 *  real name, so there is no half-made state to get stuck in if the naming is
 *  abandoned, and nothing to validate. */
function nextSequenceName() {
  const used = new Set((state.detail?.scenes ?? []).map((s) => s.sequence).filter(Boolean));
  for (const key of Object.keys(state.film?.sequences ?? {})) used.add(key);
  for (let n = 1; ; n++) if (!used.has(`sequence ${n}`)) return `sequence ${n}`;
}

/**
 * Make the sequence and hand the human the name field — the create half of the
 * CRUD, shared by the lane drag, “+ seq” and the segment inspector's picker.
 *
 * It commits first and asks nothing: the band is on screen, its extent is
 * visible, both its edges drag, and Ctrl+Z undoes the whole thing in one step.
 * A modal that asked for a name up front had to explain in prose what the
 * picture now simply shows.
 */
function nameNewSequence(from, to) {
  const label = nextSequenceName();
  assignSequence(from, to, label);
  state.namingSequence = label;   // the inspector focuses and selects it
  select({ kind: 'sequence', sequence: label });
  renderAll();
}

/** “+ seq” — the keyboard route to the same create the lane drag performs. */
function createSequenceFromSelection() {
  const scenes = state.detail?.scenes ?? [];
  if (!scenes.length) return toast('Add a scene or clip first.', { kind: 'error' });
  const [from, to] = newSequenceRange(sequenceAnchor());
  nameNewSequence(from, to);
}

/** Rename in place. Every segment carrying the old label follows it, and the
 *  intent text moves with the name rather than being stranded under it. */
function renameSequence(oldLabel, next) {
  const label = String(next ?? '').trim().slice(0, 80);
  if (!label || label === oldLabel) return false;
  // Two bands may not share a name — that is what keeps rename, ungroup and
  // advice targeting unambiguous — so a collision is refused, not merged.
  if ((state.detail?.scenes ?? []).some((s) => s.sequence === label)) {
    toast(`“${label}” is already a sequence in this film.`, { kind: 'error' });
    return false;
  }
  mutate((film) => {
    for (const s of film.scenes) if (s.sequence === oldLabel) s.sequence = label;
    const meta = { ...(film.sequences ?? {}) };
    meta[label] = meta[oldLabel] ?? {};
    delete meta[oldLabel];
    film.sequences = meta;
  }, { structural: true, silent: true });
  for (const s of state.detail.scenes) if (s.sequence === oldLabel) s.sequence = label;
  if (state.selection?.kind === 'sequence' && state.selection.sequence === oldLabel) {
    state.selection = { kind: 'sequence', sequence: label };
  }
  renderAll();
  return true;
}

/**
 * Which sequence a segment is in, from the segment's own inspector (v0.28) —
 * the keyboard-reachable twin of dragging a band edge, and the thing whose
 * absence meant a segment could only ever be regrouped by relabelling every
 * segment after it.
 *
 * Picking here moves this segment **and the rest of its band**, because that
 * is what keeps a sequence one unbroken run. For the same reason the choices
 * are only the band before, the band after, no sequence, or a new one: any
 * other label in the film would put one name on two stretches with someone
 * else's in between, which the engine's bands, the tree and advice targeting
 * would each read differently. Moving a segment somewhere else in the film is
 * what *move earlier/later* is for.
 */
function sequenceInspectorRow(box, index) {
  const scenes = state.detail?.scenes ?? [];
  const s = scenes[index];
  if (!s) return;
  const to = bandEnd(index);
  const current = s.sequence ?? null;
  const before = index > 0 ? (scenes[index - 1].sequence ?? null) : null;
  const after = to + 1 < scenes.length ? (scenes[to + 1].sequence ?? null) : null;

  // Values are prefixed so a sequence a human named "new" cannot collide with
  // the "new sequence…" sentinel.
  const pick = el('select');
  if (current) pick.appendChild(el('option', { value: `=${current}`, text: current }));
  pick.appendChild(el('option', { value: '=', text: '— no sequence —' }));
  if (before && before !== current) pick.appendChild(el('option', { value: `=${before}`, text: `${before} — join the one before` }));
  if (after && after !== current) pick.appendChild(el('option', { value: `=${after}`, text: `${after} — join the one after` }));
  pick.appendChild(el('option', { value: 'new', text: 'a new sequence' }));
  pick.value = current ? `=${current}` : '=';
  pick.addEventListener('change', () => {
    // "A new one" is the same create the lane drag makes, so it takes the same
    // range and lands in the same place: named, selected, name field focused.
    if (pick.value === 'new') { const [f, t] = newSequenceRange(index); return nameNewSequence(f, t); }
    assignSequence(index, to, pick.value.slice(1) || null);
    renderAll();
  });
  box.appendChild(el('div', { class: 'insp-row' }, labelled('sequence', pick)));
  box.appendChild(el('p', {
    class: 'dim note',
    text: to > index
      ? `Moving this segment moves the ${to - index} after it too — a sequence is one unbroken run, `
        + 'so the rest of its band comes along. Drag a band’s edges on the timeline for the same edit by hand.'
      : 'Drag a band’s edges on the timeline for the same edit by hand.',
  }));
}

/** Drop the grouping. The segments stay exactly where they are. */
function ungroupSequence(label) {
  mutate((film) => {
    for (const s of film.scenes) if (s.sequence === label) delete s.sequence;
    const meta = { ...(film.sequences ?? {}) };
    delete meta[label];
    film.sequences = meta;
  }, { structural: true, silent: true });
  for (const s of state.detail.scenes) if (s.sequence === label) delete s.sequence;
  if (state.selection?.kind === 'sequence' && state.selection.sequence === label) state.selection = null;
  renderAll();
}

/* ------------------------------- blocks -------------------------------- */

function baseBlock(kind, id, x, w, cls) {
  const el = document.createElement('div');
  el.className = `blk ${cls}`;
  el.style.left = `${x}px`;
  el.style.width = `${Math.max(6, w)}px`;
  el.dataset.kind = kind;
  el.dataset.id = String(id);
  const sel = state.selection;
  if (sel && sel.kind === kind && (sel.id === id || (kind === 'scene' && sel.index === id))) el.classList.add('selected');
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target.classList.contains('grip')) return;
    select(kind === 'scene' ? { kind, index: id } : { kind, id });
    ev.stopPropagation();
  });
  return el;
}

function dragTip(text, ev) {
  let tip = $('#drag-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'drag-tip';
    tip.className = 'drag-tip';
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  tip.style.left = `${ev.clientX + 14}px`;
  tip.style.top = `${ev.clientY - 26}px`;
}
const removeDragTip = () => $('#drag-tip')?.remove();

function showSnapline(frame) {
  removeSnapline();
  if (frame === null || frame === undefined) return;
  const el = document.createElement('div');
  el.className = 'snapline';
  el.id = 'tl-snapline';
  el.style.left = `${HEAD_W + frame * state.pxf}px`;
  $('#tl-inner').appendChild(el);
}
const removeSnapline = () => $('#tl-snapline')?.remove();

/** Shared pointer-drag plumbing: calls onMove with the frame delta, onDone
 *  with whether anything moved. Threshold of 3px so a click is not a drag. */
function pointerDrag(ev, { onMove, onDone }) {
  ev.preventDefault();
  const startX = ev.clientX;
  let moved = false;
  const move = (e2) => {
    const dx = e2.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    onMove(dx / state.pxf, e2);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    removeDragTip();
    removeSnapline();
    onDone(moved);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function sceneBlock(s, index) {
  const x = s.filmOffset * state.pxf;
  const w = (s.durationInFrames || 1) * state.pxf;
  const footage = s.kind === 'footage';
  const el = baseBlock('scene', index, x, w, footage ? 'blk-scene blk-footage' : 'blk-scene');
  // Footage is never "rendered" — it is a file the user supplied — so the
  // unrendered styling would read as a problem that does not exist. What CAN be
  // wrong with it is a signature or frame-count disagreement, both of which
  // planFilm reports against the segment path.
  if (footage) {
    const bad = (state.detail.problems ?? []).some((p) => p.segment === s.footage);
    if (bad || s.missing) el.classList.add('mismatch');
  } else {
    if (!s.rendered) el.classList.add('unrendered');
    const mismatch = (state.detail.problems ?? []).some((p) => p.code === 'signature_mismatch' && p.sceneId === s.sceneId);
    if (mismatch) el.classList.add('mismatch');
  }

  const dot = document.createElement('span');
  dot.className = 'sc-status';
  if (footage) {
    dot.title = s.missing ? 'footage file missing'
      : s.framesVerified === false ? 'declared frame count disagrees with the file'
        : s.framesVerified === null ? 'frame count unverified (ffprobe unavailable)'
          : 'footage, verified';
  } else {
    dot.title = s.missing ? 'scene folder missing' : s.rendered ? 'rendered' : 'not rendered yet';
  }
  const label = document.createElement('span');
  label.className = 'blk-label';
  if (footage) {
    label.textContent = s.missing ? `⚠ missing (${s.footage})` : `▣ ${s.label ?? s.name}`;
    label.title = s.footage;
  } else {
    label.textContent = s.missing ? `⚠ missing (${s.slug})` : s.name;
  }
  const dur = document.createElement('span');
  dur.className = 'sc-dur';
  const job = footage ? null : state.sceneJobs.get(s.slug);
  dur.textContent = job && !['done', 'error', 'cancelled'].includes(job.state)
    ? `render ${job.percent ?? 0}%`
    : `${s.durationInFrames ?? 0}f`;
  el.append(dot, label, dur);
  const advN = unresolvedCount(segmentAdviceMatcher(s));
  if (advN) el.appendChild(adviceBadge(advN));

  // Frames along the block, when it is wide enough to show any (v0.28).
  attachStrip(el, s, w);

  // Footage can be TRIMMED at its edges (v0.28); a scene cannot, because a
  // scene's length is its config and its render. See attachFootageGrips.
  if (footage && !s.missing) attachFootageGrips(el, s);

  // Drag to reorder: scenes are butt-joined, so the only degree of freedom is order.
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target.classList.contains('grip')) return;
    const scenes = state.detail.scenes;
    pointerDrag(ev, {
      onMove: (dFrames, e2) => {
        el.classList.add('dragging');
        el.style.transform = `translateX(${dFrames * state.pxf}px)`;
        const pointerFrame = frameOfEvent(e2);
        let idx = scenes.length;
        for (let i = 0; i < scenes.length; i++) {
          if (pointerFrame < scenes[i].filmOffset + (scenes[i].durationInFrames || 0) / 2) { idx = i; break; }
        }
        el.dataset.dropIndex = idx;
        showInsertMarker(idx);
        dragTip(`move "${s.name ?? '?'}" → position ${idx + 1}`, e2);
      },
      onDone: (movedAny) => {
        el.classList.remove('dragging');
        el.style.transform = '';
        $('#tl-insert')?.remove();
        if (!movedAny) return;
        let to = Number(el.dataset.dropIndex);
        if (Number.isNaN(to)) return;
        if (to > index) to--;
        if (to === index) { renderTimeline(); return; }
        mutate((film) => {
          const [ref] = film.scenes.splice(index, 1);
          film.scenes.splice(to, 0, ref);
        }, { structural: true, silent: true });
        // Offsets shift for every later scene; reflect it locally right away.
        const [ds] = state.detail.scenes.splice(index, 1);
        state.detail.scenes.splice(to, 0, ds);
        reflowLocalScenes();
        state.selection = { kind: 'scene', index: to };
        renderTimeline();
        renderInspector();
        setPlayhead(state.playhead);
      },
    });
  });
  return el;
}

/* ---- filmstrips on timeline blocks (v0.28) ---------------------------- */

/**
 * Frames drawn along a block, so the timeline can be read rather than decoded.
 *
 * A block used to carry a filename and a frame count, which is what you already
 * knew. This draws the clip itself — the same thing every other editor does,
 * and the same complaint that produced the live scene preview: it is hard to
 * tell what a thing IS without opening it.
 *
 * Each strip is one image of evenly-spaced frames, stretched across the block.
 * Because the tiles are evenly spaced in TIME and a block maps that span
 * linearly, tile boundaries land where those frames actually are — so the strip
 * is a picture of the clip's timing, not wallpaper.
 *
 * Generating one costs an ffmpeg run, so: only for blocks wide enough to show
 * anything, at most a few at a time, cached for the session, and asked for at a
 * tile count that suits the block's width rather than its zoom-of-the-moment.
 */
const strips = { cache: new Map(), inFlight: 0, queue: [] };
const STRIP_MAX_PARALLEL = 3;
/** Below this a strip is a smear; the label is more use. */
const STRIP_MIN_WIDTH = 90;

/** A tile ladder, so a nudge of the zoom slider does not re-fetch everything. */
function stripTilesFor(px) {
  if (px < 260) return 4;
  if (px < 640) return 8;
  if (px < 1400) return 16;
  return 32;
}

/**
 * Cache key. It carries what the picture depends on — the file and its length —
 * so a trim (which changes the path) or a length change misses, while a plain
 * repaint hits. A re-render at the SAME length and path is the one case that
 * keeps a stale strip; the reload button clears the cache for exactly that.
 */
function stripKey(s, tiles) {
  return s.kind === 'footage'
    ? `f:${s.id}:${s.footage}:${s.durationInFrames}:${tiles}`
    : `s:${s.sceneId}:${s.durationInFrames}:${tiles}`;
}

function stripUrl(s, tiles) {
  return s.kind === 'footage'
    ? `/api/films/${fid}/footage/${encodeURIComponent(s.id)}/filmstrip?tiles=${tiles}`
    : `${sceneApi(s.slug)}/filmstrip?tiles=${tiles}`;
}

function pumpStripQueue() {
  while (strips.inFlight < STRIP_MAX_PARALLEL && strips.queue.length) {
    const job = strips.queue.shift();
    strips.inFlight += 1;
    fetch(job.url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        // A scene that is not rendered, or a file with nothing to sample, is a
        // normal answer — remembered as "no strip" so it is asked once.
        const href = b ? URL.createObjectURL(b) : null;
        strips.cache.set(job.key, href);
        if (href) job.paint(href);
      })
      .catch(() => strips.cache.set(job.key, null))
      .finally(() => { strips.inFlight -= 1; pumpStripQueue(); });
  }
}

/** Put a strip behind a block's label, fetching it if this is the first ask. */
function attachStrip(el, s, widthPx) {
  if (widthPx < STRIP_MIN_WIDTH) return;
  if (s.missing || (s.kind !== 'footage' && !s.rendered)) return;
  const tiles = stripTilesFor(widthPx);
  const key = stripKey(s, tiles);
  const paint = (href) => {
    // The block may have been repainted since the fetch started.
    if (!el.isConnected) return;
    let strip = el.querySelector('.blk-strip');
    if (!strip) {
      strip = el.insertBefore(document.createElement('div'), el.firstChild);
      strip.className = 'blk-strip';
    }
    strip.style.backgroundImage = `url(${href})`;
  };
  if (strips.cache.has(key)) {
    const href = strips.cache.get(key);
    if (href) paint(href);
    return;
  }
  strips.cache.set(key, null);            // claim it, so a repaint does not re-queue
  strips.queue.push({ key, url: stripUrl(s, tiles), paint });
  pumpStripQueue();
}

/** Drop every cached strip — the explicit reload, when the files may have changed. */
function clearStrips() {
  for (const href of strips.cache.values()) if (href) URL.revokeObjectURL(href);
  strips.cache.clear();
  strips.queue.length = 0;
}

/* ---- trimming footage (v0.28) ---------------------------------------- */

/**
 * Where each footage segment can be cut for free, keyed by segment id.
 * Fetched once per segment and dropped whenever the film reloads, because a
 * trim replaces the file and therefore the grid.
 */
const keyframeGrids = new Map();

/** Segments already told that they re-encode on every trim. Advice, said once. */
const coarseHinted = new Set();

/**
 * Start fetching a segment's grid. Deliberately fire-and-forget: a pointerdown
 * handler must call `pointerDrag` SYNCHRONOUSLY or the pointer capture is set
 * up after the gesture has already begun, and the first pointermove events go
 * missing. So the grid is warmed on hover and read synchronously below.
 */
function warmFootageGrid(segmentId) {
  if (keyframeGrids.has(segmentId)) return;
  keyframeGrids.set(segmentId, null);
  api(`/api/films/${fid}/footage/${encodeURIComponent(segmentId)}/keyframes`)
    .then((g) => keyframeGrids.set(segmentId, g))
    .catch(() => keyframeGrids.set(segmentId, { frames: [], intervalFrames: null, coarse: true }));
}

/**
 * The grid if it has arrived, else null. A null grid means the handle moves
 * freely for this one drag and the SERVER snaps on commit — which is still
 * honest, because the response says where the cut actually landed and the
 * toast repeats it.
 */
const footageGridNow = (segmentId) => keyframeGrids.get(segmentId) ?? null;

/**
 * Magnetic snap toward a cheap cut point — NOT a cage.
 *
 * A keyframe is where a trim can be a stream copy, so the handle pulls toward
 * one when it is close. It does not refuse to leave: an in-point between
 * keyframes is perfectly reachable, it just re-encodes, and a re-encode costs
 * by the frames it KEEPS — a half-second segment re-encodes in well under a
 * second. Caging the handle to the grid was this feature's first shipped bug:
 * repeated copy-trims of a coarse clip converge on a file whose only keyframe
 * is frame 0, and a caged handle on such a clip can never move at all.
 *
 * @returns {{frame: number, onKeyframe: boolean}}
 */
function magnetToKeyframe(grid, frame) {
  if (!grid?.length) return { frame, onKeyframe: false };
  // A fixed pixel feel rather than a fixed frame count, so the pull is the
  // same gesture at every zoom level.
  const tolerance = Math.max(1, Math.round(6 / Math.max(state.pxf, 0.0001)));
  let best = null;
  for (const f of grid) {
    if (Math.abs(f - frame) <= tolerance && (best === null || Math.abs(f - frame) < Math.abs(best - frame))) best = f;
  }
  return best === null ? { frame, onKeyframe: false } : { frame: best, onKeyframe: true };
}

/**
 * Trim handles on a footage block.
 *
 * Unlike an audio clip's grips, this is **not** free metadata: it re-cuts the
 * file. What makes it a handle rather than a job is that the head grip snaps
 * to the clip's own KEYFRAME GRID, and a cut that starts on a keyframe is a
 * stream copy — measured at 0.1-1.8 s where the same cut re-encoded is 0.5 s
 * plus 0.69 s per second KEPT (see the plan's §3). Snapping is therefore not a
 * UI nicety: it is what keeps the gesture affordable.
 *
 * It is also what keeps it honest. `ffmpeg -ss` snaps to the preceding
 * keyframe *silently*, so a handle that moved freely would promise a frame it
 * would not deliver. Here the handle can only stop where the cut can land, and
 * a coarse clip visibly drags coarsely — which is the truth about that clip.
 *
 * The tail grip needs no grid: frame 0 is always a keyframe, so shortening the
 * end is always a copy.
 */
function attachFootageGrips(el, s) {
  const segmentId = s.id;
  if (!segmentId) return;
  // Warm the grid on hover so the drag itself never waits on a probe.
  el.addEventListener('pointerenter', () => warmFootageGrid(segmentId), { once: true });

  const commit = async (body, describe) => {
    el.classList.add('busy');
    try {
      const r = await api(`/api/films/${fid}/footage/${encodeURIComponent(segmentId)}/trim`, {
        method: 'POST', body,
      });
      keyframeGrids.delete(segmentId);
      await refresh();

      /* ONE line for what happened. `trimFootage` throws when a trim fails, so
       * everything it returns in `warnings` is a note about a SUCCESS — none of
       * it is an error, and none of it should be red or permanent. Reporting a
       * finished cut as two sticky red boxes is how this first shipped, and it
       * read as a failure over a clip that had been cut correctly. */
      const asked = body.durationInFrames;
      const short = Number.isInteger(asked) && r.durationInFrames !== asked
        ? ` (kept ${r.durationInFrames} of ${asked} — the file's container over-counts its own tail)`
        : '';
      toast(`${describe} ✓ — ${r.durationInFrames}f by ${r.method === 'copy' ? 'copy' : 're-encode'} `
        + `in ${(r.elapsedMs / 1000).toFixed(1)}s${short}. ${r.keptOnDisk} is still in assets/.`,
      { kind: 'info', timeoutMs: 9000 });

      /* The one piece of advice worth interrupting for, and only ONCE per clip:
       * this one re-encodes on every trim, and a single prepare fixes it for
       * good. Repeating it on each drag would train the reader to dismiss it. */
      if (r.method === 'reencode' && r.keyframes?.coarse && !coarseHinted.has(segmentId)) {
        coarseHinted.add(segmentId);
        toast(`This clip re-encodes on every trim — its cut points are `
          + `${r.keyframes.intervalFrames ? `~${r.keyframes.intervalFrames} frames` : 'too far'} apart. `
          + 'Preparing it once (transcode_asset with gop 10) makes every later trim on it instant.',
        { kind: 'info', timeoutMs: 14000 });
      }
    } catch (err) {
      toastError(err);
      renderTimeline();
    } finally {
      el.classList.remove('busy');
    }
  };

  /* Head grip — moves the IN-POINT through the file. Snapped to the grid. */
  const head = el.appendChild(document.createElement('div'));
  head.className = 'grip left';
  head.title = 'trim the clip start — pulls toward cut points that need no re-encode, exact anywhere else';
  head.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    warmFootageGrid(segmentId);
    const grid = footageGridNow(segmentId);
    const total = s.durationInFrames;
    const x0 = s.filmOffset * state.pxf;
    let cut = 0;
    let cheap = true;
    pointerDrag(ev, {
      onMove: (d, e2) => {
        // Never past the last frame, never before the head of the file.
        const want = Math.round(Math.max(0, Math.min(total - 1, d)));
        const m = magnetToKeyframe(grid?.frames, want);
        cut = m.frame;
        cheap = cut === 0 || m.onKeyframe;
        el.style.left = `${x0 + cut * state.pxf}px`;
        el.style.width = `${Math.max(6, (total - cut) * state.pxf)}px`;
        // Say which of the two operations this drop would be. The cost is the
        // frames KEPT, so it is named rather than the frames removed.
        dragTip(cut === 0
          ? 'full clip'
          : `in at ${cut}f · keeps ${total - cut}f (${((total - cut) / fps()).toFixed(2)}s) · `
            + (cheap ? 'copy' : `re-encode ${total - cut}f`), e2);
      },
      onDone: (moved) => {
        el.style.left = ''; el.style.width = '';
        if (!moved || cut <= 0) { renderTimeline(); return; }
        // The handle has already chosen the frame, so ask for it EXACTLY: a
        // landing on a keyframe copies by itself, and anywhere else the caller
        // gets the frame it pointed at rather than a silent slide backwards.
        commit(
          { startInFrames: cut, durationInFrames: total - cut, snapToKeyframe: false },
          `Trimmed ${cut}f off the head`,
        );
      },
    });
  });

  /* Tail grip — always a copy, because the cut starts at frame 0. */
  const tail = el.appendChild(document.createElement('div'));
  tail.className = 'grip right';
  tail.title = 'trim the clip end — always a fast copy';
  tail.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    const total = s.durationInFrames;
    let keep = total;
    pointerDrag(ev, {
      onMove: (d, e2) => {
        keep = Math.round(Math.max(1, Math.min(total, total + d)));
        el.style.width = `${Math.max(6, keep * state.pxf)}px`;
        dragTip(keep === total ? 'full clip' : `keeps ${keep}f (${(keep / fps()).toFixed(2)}s)`, e2);
      },
      onDone: (moved) => {
        el.style.width = '';
        if (!moved || keep >= total) { renderTimeline(); return; }
        commit({ startInFrames: 0, durationInFrames: keep }, `Trimmed ${total - keep}f off the tail`);
      },
    });
  });
}

function showInsertMarker(idx) {
  $('#tl-insert')?.remove();
  const scenes = state.detail.scenes;
  const f = idx >= scenes.length ? totalFrames() : scenes[idx].filmOffset;
  const el = document.createElement('div');
  el.id = 'tl-insert';
  el.className = 'insert-marker';
  el.style.left = `${HEAD_W + f * state.pxf}px`;
  el.style.top = '26px';
  el.style.height = '54px';
  $('#tl-inner').appendChild(el);
}

function audioBlock(t) {
  loadWave(t.src);
  const start = t.startInFrames ?? 0;
  const frames = clipFrames(t);
  const silent = !isTrackAudible(t);
  const el = baseBlock('audio', t.id, start * state.pxf, frames * state.pxf,
    `blk-audio${t.duck ? ' duck' : ''}${silent ? ' muted' : ''}`);
  if (silent) el.title = t.mute ? 'muted track — not in the mix' : 'muted lane — not in the mix';

  const wave = document.createElement('canvas');
  wave.className = 'wave';
  el.appendChild(wave);
  requestAnimationFrame(() => drawWave(wave, t));

  if (t.fadeInFrames) {
    const f = document.createElement('div');
    f.className = 'fade-marker';
    f.style.left = '0';
    f.style.width = `${Math.min(frames, t.fadeInFrames) * state.pxf}px`;
    el.appendChild(f);
  }
  if (t.fadeOutFrames) {
    const f = document.createElement('div');
    f.className = 'fade-marker out';
    f.style.right = '0';
    f.style.width = `${Math.min(frames, t.fadeOutFrames) * state.pxf}px`;
    el.appendChild(f);
  }

  const label = document.createElement('span');
  label.className = 'blk-label';
  label.textContent = `${t.mute ? 'muted · ' : ''}${t.duck ? '⤓ ' : ''}${t.label || t.src.replace(/^assets\//, '')}${t.gainDb ? ` · ${t.gainDb > 0 ? '+' : ''}${t.gainDb}dB` : ''}`;
  el.appendChild(label);

  // Move — horizontally in time, vertically between lanes.
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target.classList.contains('grip')) return;
    const orig = t.startInFrames ?? 0;
    let next = orig;
    const boxes = laneHitboxes('audio');
    let lane = Number(el.closest('.tl-row')?.dataset.lane ?? 0);
    pointerDrag(ev, {
      onMove: (d, e2) => {
        el.classList.add('dragging');
        const hit = laneUnder(boxes, e2.clientY);
        if (hit && hit.lane !== lane) {
          lane = hit.lane;
          for (const b of boxes) b.row.classList.toggle('lane-drop', b.lane === lane);
        }
        const rawStart = Math.max(0, orig + d);
        // Snap whichever edge is closer to a target.
        const s1 = snapFrame(rawStart, { kind: 'audio', id: t.id });
        const s2 = snapFrame(rawStart + frames, { kind: 'audio', id: t.id });
        next = s2.snapped !== null && (s1.snapped === null || Math.abs(s2.f - (rawStart + frames)) < Math.abs(s1.f - rawStart))
          ? Math.max(0, s2.f - frames) : Math.max(0, s1.f);
        showSnapline(s1.snapped ?? (s2.snapped !== null ? s2.f : null));
        el.style.left = `${next * state.pxf}px`;
        dragTip(`${next}f · ${timecode(next)}`, e2);
      },
      onDone: (moved) => {
        el.classList.remove('dragging');
        for (const b of boxes) b.row.classList.remove('lane-drop');
        const startLane = Number(el.closest('.tl-row')?.dataset.lane ?? 0);
        if (!moved || (next === orig && lane === startLane)) return;
        if (next !== orig) {
          mutate((film) => {
            const tr = film.audio.find((x) => x.id === t.id);
            if (tr) tr.startInFrames = next;
          });
        }
        if (lane !== startLane) moveToLane('audio', t.id, lane);
        if (state.selection?.kind === 'audio' && state.selection.id === t.id) renderInspector();
      },
    });
  });

  /* Left grip = head trim (v0.27). Dragging it moves the clip's IN-POINT
   * through the file while the audio under the cursor stays where it is —
   * `startInFrames` follows the edge, so the rest of the take does not slide.
   * Before this the only grip was the right one, and cutting two seconds off
   * the front of a narration meant re-cutting the file. */
  const head = document.createElement('div');
  head.className = 'grip left';
  head.title = 'trim the clip start — the head of the file, not its place on the timeline';
  head.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    const origHead = headFrames(t);
    const clipEnd = start + frames;          // fixed: only the in-point moves
    let nextHead = origHead;
    let nextStart = start;
    pointerDrag(ev, {
      onMove: (d, e2) => {
        const nat = naturalFrames(t);
        const maxHead = (t.trimEndInFrames ?? nat ?? (origHead + frames)) - 1;
        // Never past the clip's own end, never before the file's first frame,
        // and never so far left that the clip would start before frame 0.
        // Frames are integers everywhere in this document: an un-rounded drag
        // delta would store 44.31 and the film would fail validation on save.
        let h = Math.round(Math.max(0, Math.min(maxHead, origHead + d, origHead + start)));
        const s1 = snapFrame(start + (h - origHead), { kind: 'audio', id: t.id });
        if (s1.snapped !== null) h = Math.max(0, origHead + (s1.f - start));
        showSnapline(s1.snapped);
        nextHead = h;
        nextStart = Math.max(0, start + (h - origHead));
        el.style.left = `${nextStart * state.pxf}px`;
        el.style.width = `${Math.max(6, (clipEnd - nextStart) * state.pxf)}px`;
        dragTip(`in ${nextHead}f · ${((clipEnd - nextStart) / fps()).toFixed(2)}s left`, e2);
      },
      onDone: (moved) => {
        if (!moved || nextHead === origHead) return;
        mutate((film) => {
          const tr = film.audio.find((x) => x.id === t.id);
          if (!tr) return;
          if (nextHead > 0) tr.trimStartInFrames = nextHead;
          else delete tr.trimStartInFrames;
          tr.startInFrames = nextStart;
        });
        if (state.selection?.kind === 'audio' && state.selection.id === t.id) renderInspector();
      },
    });
  });
  el.appendChild(head);

  // Right grip = tail trim.
  const grip = document.createElement('div');
  grip.className = 'grip right';
  grip.title = 'trim the clip end';
  grip.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    const origFrames = frames;
    let nextTrim;
    pointerDrag(ev, {
      onMove: (d, e2) => {
        const nat = naturalFrames(t);
        const h = headFrames(t);
        let f2 = Math.max(1, Math.round(origFrames + d));
        if (nat) f2 = Math.min(f2, nat - h);     // the kept window ends at the file's end
        const se = snapFrame(start + f2, { kind: 'audio', id: t.id });
        if (se.snapped !== null && se.f > start) f2 = se.f - start;
        showSnapline(se.snapped);
        // trimEnd indexes the SOURCE, so it is the head plus what is kept.
        nextTrim = (nat && f2 >= nat - h - 2) ? null : h + f2; // release ≈ untrimmed
        el.style.width = `${Math.max(6, f2 * state.pxf)}px`;
        dragTip(`${f2}f · ${(f2 / fps()).toFixed(2)}s${nextTrim === null ? ' (full clip)' : ''}`, e2);
      },
      onDone: (moved) => {
        if (!moved) return;
        mutate((film) => {
          const tr = film.audio.find((x) => x.id === t.id);
          if (!tr) return;
          if (nextTrim === null) delete tr.trimEndInFrames;
          else tr.trimEndInFrames = nextTrim;
        });
        if (state.selection?.kind === 'audio' && state.selection.id === t.id) renderInspector();
      },
    });
  });
  el.appendChild(grip);
  return el;
}

/** Caption + overlay blocks share the from/to range grammar. */
function rangeBlock(item, kind) {
  const el = baseBlock(kind, item.id, item.fromFrame * state.pxf,
    (item.toFrame - item.fromFrame) * state.pxf, kind === 'caption' ? 'blk-caption' : 'blk-overlay');
  const label = document.createElement('span');
  label.className = 'blk-label';
  label.textContent = kind === 'caption'
    ? (item.text || '(empty)')
    : `${item.src.replace(/^assets\//, '')}`;
  el.appendChild(label);

  const list = () => (kind === 'caption' ? state.film.captions : state.film.overlays);

  el.addEventListener('pointerdown', (ev) => {
    if (ev.target.classList.contains('grip')) return;
    const len = item.toFrame - item.fromFrame;
    const orig = item.fromFrame;
    let next = orig;
    const family = kind === 'caption' ? 'captions' : 'overlays';
    const boxes = laneHitboxes(family);
    let lane = Number(el.closest('.tl-row')?.dataset.lane ?? 0);
    pointerDrag(ev, {
      onMove: (d, e2) => {
        el.classList.add('dragging');
        const hit = laneUnder(boxes, e2.clientY);
        if (hit && hit.lane !== lane) {
          lane = hit.lane;
          for (const b of boxes) b.row.classList.toggle('lane-drop', b.lane === lane);
        }
        const raw = Math.max(0, orig + d);
        const s1 = snapFrame(raw, { kind, id: item.id });
        const s2 = snapFrame(raw + len, { kind, id: item.id });
        next = s2.snapped !== null && (s1.snapped === null || Math.abs(s2.f - (raw + len)) < Math.abs(s1.f - raw))
          ? Math.max(0, s2.f - len) : Math.max(0, s1.f);
        showSnapline(s1.snapped ?? s2.snapped);
        el.style.left = `${next * state.pxf}px`;
        dragTip(`${next}f · ${timecode(next)}`, e2);
      },
      onDone: (moved) => {
        el.classList.remove('dragging');
        for (const b of boxes) b.row.classList.remove('lane-drop');
        const startLane = Number(el.closest('.tl-row')?.dataset.lane ?? 0);
        if (!moved || (next === orig && lane === startLane)) return;
        if (next !== orig) {
          mutate(() => {
            const it = list().find((x) => x.id === item.id);
            if (it) { it.toFrame = next + len; it.fromFrame = next; }
          });
        }
        if (lane !== startLane) moveToLane(family, item.id, lane);
        renderSelectionAffected(kind, item.id);
      },
    });
  });

  const mkGrip = (side) => {
    const g = document.createElement('div');
    g.className = `grip ${side}`;
    g.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      const o = { from: item.fromFrame, to: item.toFrame };
      let nf = o.from, nt = o.to;
      pointerDrag(ev, {
        onMove: (d, e2) => {
          if (side === 'left') {
            const s = snapFrame(Math.max(0, Math.min(o.to - 1, o.from + d)), { kind, id: item.id });
            nf = Math.min(o.to - 1, Math.max(0, s.f));
            showSnapline(s.snapped);
            el.style.left = `${nf * state.pxf}px`;
            el.style.width = `${Math.max(6, (o.to - nf) * state.pxf)}px`;
            dragTip(`${nf}f → ${o.to}f`, e2);
          } else {
            const s = snapFrame(Math.max(o.from + 1, o.to + d), { kind, id: item.id });
            nt = Math.max(o.from + 1, s.f);
            showSnapline(s.snapped);
            el.style.width = `${Math.max(6, (nt - o.from) * state.pxf)}px`;
            dragTip(`${o.from}f → ${nt}f (${((nt - o.from) / fps()).toFixed(2)}s)`, e2);
          }
        },
        onDone: (moved) => {
          if (!moved) return;
          mutate(() => {
            const it = list().find((x) => x.id === item.id);
            if (it) { it.fromFrame = nf; it.toFrame = nt; }
          });
          renderSelectionAffected(kind, item.id);
        },
      });
    });
    return g;
  };
  el.append(mkGrip('left'), mkGrip('right'));

  if (kind === 'caption') {
    el.addEventListener('dblclick', () => {
      select({ kind: 'caption', id: item.id });
      $('#insp-caption-text')?.focus();
    });
  }
  return el;
}

function renderSelectionAffected(kind, id) {
  if (state.selection?.kind === kind && state.selection.id === id) renderInspector();
  updateLayers(state.playhead);
}

/* ------------------------------ selection ------------------------------- */

/**
 * The film is what the inspector shows when nothing narrower is picked, so
 * `null` and an explicit film selection look the same everywhere except in one
 * place: pressing advise. With nothing selected that arms a targeting click;
 * with the film picked it advises on the film. That is the whole difference,
 * and it is why clicking the Explorer's root row is not the same as Escape.
 */
const filmIsSelected = () => !state.selection || state.selection.kind === 'film';

/** Selection updates classes in place — a re-render here would detach the
 *  very block a pointer-drag is about to move. */
function select(sel) {
  state.selection = sel;
  state.inspectorMode = null; // picking a block always shows its properties
  state.openAdviceId = null;
  for (const b of document.querySelectorAll('.blk')) {
    const on = !!sel && sel.kind === b.dataset.kind
      && String(sel.kind === 'scene' ? sel.index : sel.id) === b.dataset.id;
    b.classList.toggle('selected', on);
  }
  for (const b of document.querySelectorAll('.seq-band')) {
    b.classList.toggle('selected', sel?.kind === 'sequence' && b.querySelector('.seq-name')?.textContent === sel.sequence);
  }
  const laneWanted = laneSelKey(sel);
  for (const h of document.querySelectorAll('.tl-head[data-lane-key]')) {
    h.classList.toggle('selected', h.dataset.laneKey === laneWanted);
  }
  renderTree();
  renderInspector();
  // The header button names what it will advise on, so it has to follow the
  // selection the same way the inspector does.
  renderAdviseButton();
  // "Advise AI" with nothing selected arms one click: whatever the human picks
  // next becomes the target, and the popup opens on it immediately.
  if (state.aiming) { disarmAim(); openAdviceDialog(); }
}

/**
 * Cut-to-cut movement (v0.26): the next scene boundary, or with shift the next
 * sequence start — the granularity a human actually reviews at, where ←/→ are
 * for the frame you have already found. PgUp/PgDn so nothing collides with
 * frame stepping. Boundaries are the offsets the timeline is already drawn
 * from, so they cannot disagree with the picture.
 */
function boundaryFrom(dir, sequencesOnly) {
  const offsets = sequencesOnly
    ? sequenceBands().map((b) => b.offset)
    : (state.detail?.scenes ?? []).map((s) => s.filmOffset ?? 0);
  const marks = [...new Set([0, ...offsets])].sort((a, b) => a - b);
  const here = Math.floor(state.playhead);
  const next = dir > 0 ? marks.find((f) => f > here) : marks.filter((f) => f < here).pop();
  return next ?? (dir > 0 ? Math.max(0, totalFrames() - 1) : 0);
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if ($('#advice-dialog')?.open) return; // the popup owns the keyboard while it is up
  if ($('#advice-board')?.open) return; // as does the board — Escape closes it natively
  // Alt belongs to the shell (Alt+W, Alt+PageUp/Down, Alt+1…9). Without this,
  // Alt+PageDown would move the playhead AND switch documents — these branches
  // test `code` alone and call preventDefault, so they would both fire.
  if (e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stopPlayback() : startPlayback(); }
  else if (e.code === 'ArrowLeft') { stopPlayback(); setPlayhead(Math.floor(state.playhead) - (e.shiftKey ? 10 : 1)); }
  else if (e.code === 'ArrowRight') { stopPlayback(); setPlayhead(Math.floor(state.playhead) + (e.shiftKey ? 10 : 1)); }
  else if (e.code === 'Home') { stopPlayback(); setPlayhead(0); }
  else if (e.code === 'End') { stopPlayback(); setPlayhead(totalFrames() - 1); }
  else if (e.code === 'PageDown') { e.preventDefault(); stopPlayback(); setPlayhead(boundaryFrom(1, e.shiftKey)); }
  else if (e.code === 'PageUp') { e.preventDefault(); stopPlayback(); setPlayhead(boundaryFrom(-1, e.shiftKey)); }
  else if (e.key === '+' || e.key === '=') zoomBy(1.3);
  else if (e.key === '-') zoomBy(1 / 1.3);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) { e.preventDefault(); deleteSelection(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); scheduleSave({ now: true }); }
  else if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (e.shiftKey) toggleAdviceBoard(); else startAdvice();
  } else if (e.code === 'Escape') { if (state.aiming) disarmAim(); else select(null); }
});
document.addEventListener('keydown', (e) => {
  // Ctrl+Z/S must work while typing in inspector fields too.
  if (!e.target.matches('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); scheduleSave({ now: true }); }
});

/** Recompute local scene offsets after an optimistic detail.scenes edit. */
function reflowLocalScenes() {
  let off = 0;
  for (const sd of state.detail.scenes) {
    sd.filmOffset = off;
    sd.startSeconds = fps() ? Number((off / fps()).toFixed(3)) : 0;
    off += sd.durationInFrames ?? 0;
  }
  state.detail.totalFrames = off;
  state.detail.durationSeconds = fps() ? Number((off / fps()).toFixed(3)) : 0;
}

function deleteSelection() {
  const sel = state.selection;
  if (!sel) return;
  // The film and a lane are places, not things: Del on either would have to
  // mean "delete everything in it", which no one presses Del expecting. A lane
  // still empties from its own ✕, one item at a time.
  if (sel.kind === 'film' || sel.kind === 'lane') return;
  // Deleting a sequence would read as "delete these scenes". It only ever
  // means "stop grouping them", which has its own, honestly named action.
  if (sel.kind === 'sequence') return ungroupSequence(sel.sequence);
  if (sel.kind === 'scene') {
    mutate((film) => film.scenes.splice(sel.index, 1), { structural: true, silent: true });
    state.detail.scenes.splice(sel.index, 1);
    reflowLocalScenes();
    state.selection = null;
    renderAll();
    return;
  }
  const key = { audio: 'audio', caption: 'captions', overlay: 'overlays' }[sel.kind];
  mutate((film) => { film[key] = film[key].filter((x) => x.id !== sel.id); });
  state.selection = null;
  renderInspector();
  updateLayers(state.playhead);
}

/* ------------------------------ inspector ------------------------------- */

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...children);
  return n;
}
function labelled(text, input) {
  return el('label', {}, el('span', { text }), input);
}
function numInput(value, { min = 0, step = 1, onCommit, width }) {
  const i = el('input', { type: 'number', min: String(min), step: String(step) });
  i.value = value ?? '';
  if (width) i.style.width = width;
  i.addEventListener('change', () => onCommit(i.value === '' ? null : Number(i.value)));
  return i;
}

/**
 * True while the inspector is showing one of the shared panels mounted from
 * scene-panels.js. They own an audition that has to be stopped when you leave
 * them — which is now the only thing this answers, since advice moved out of
 * the panel foot and onto a tab of its own.
 */
function isDeepSceneTab() {
  if (state.inspectorMode === 'build') return false;
  if (state.selection?.kind !== 'scene' || !SHARED_PANEL_TABS.includes(state.tab.scene)) return false;
  return state.detail?.scenes?.[state.selection.index]?.kind !== 'footage';
}

/** The film's own mounted panels, on the same rule. */
function isDeepFilmTab() {
  return state.inspectorMode !== 'build' && filmIsSelected() && SHARED_PANEL_TABS.includes(state.tab.film);
}

/* The inspector is rebuilt from scratch on selection, mutation, save, SSE and
 * the once-a-second scene-job poll. That was survivable when everything in it
 * was a label; now it holds a config form, so a render running in the
 * background would retype the user's field out from under them once a second.
 * The panel DOM itself is long-lived (detached and re-appended, never rebuilt),
 * and the caret comes back with it. The film-name and caption inputs have
 * wanted this since they were written. */
function captureFocus(box) {
  const node = document.activeElement;
  if (!node || node === document.body || !box.contains(node)) return null;
  const at = { node };
  if (typeof node.selectionStart === 'number') { at.start = node.selectionStart; at.end = node.selectionEnd; }
  return at;
}

function restoreFocus(at) {
  if (!at || !at.node.isConnected || document.activeElement === at.node) return;
  at.node.focus();
  // Number and colour inputs throw on setSelectionRange; the focus is the part
  // that matters, so losing the caret position on those is not worth a guard
  // list that would rot as input types are added.
  if (at.start != null) { try { at.node.setSelectionRange(at.start, at.end); } catch { /* not a text field */ } }
}

function renderInspector() {
  const box = $('#inspector');
  const at = captureFocus(box);
  // Leaving the panels must not strand a clip playing with its stop button
  // gone from the page.
  if (scenePanels?.root.isConnected && !isDeepSceneTab()) scenePanels.stopAudition();
  if (filmPanels?.root.isConnected && !isDeepFilmTab()) filmPanels.stopAudition();
  box.innerHTML = '';
  if (state.inspectorMode === 'build') { renderBuildInspector(box); return restoreFocus(at); }
  const sel = state.selection;
  // Properties first, then the conversation about this exact thing: which
  // takes of it exist, and what the human has already said. Advising is
  // driven from here because the inspector already knows the selection —
  // that is why there is no separate advise button in the header.
  if (filmIsSelected()) renderFilmInspector(box);
  else if (sel.kind === 'lane') renderLaneInspector(box, sel);
  else if (sel.kind === 'sequence') renderSequenceInspector(box, sel.sequence);
  else if (sel.kind === 'scene') renderSceneInspector(box, sel.index);
  else if (sel.kind === 'audio') renderAudioInspector(box, sel.id);
  else if (sel.kind === 'caption') renderCaptionInspector(box, sel.id);
  else if (sel.kind === 'overlay') renderOverlayInspector(box, sel.id);
  restoreFocus(at);
}

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

function filmDeliverablePresets() {
  return Array.isArray(state.settings?.deliverablePresets) ? state.settings.deliverablePresets : [];
}

function deliverableBaseName(value) {
  const base = String(value ?? 'film').replace(/\.[a-z0-9]+$/i, '');
  return base.trim() || 'film';
}

function deliverableById(film, id) {
  return (film.deliverables ?? []).find((item) => item.id === id) ?? null;
}

function segmentFocusKeys(scene) {
  return [scene?.slug, scene?.name, scene?.footage, scene?.sceneId]
    .filter((key) => typeof key === 'string' && key.trim());
}

function segmentFocus(deliverable, scene) {
  const keys = segmentFocusKeys(scene);
  const segments = deliverable?.reframe?.segments ?? {};
  const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(segments, candidate)) ?? null;
  return {
    key,
    point: (key ? segments[key] : null) ?? deliverable?.reframe?.default ?? { xPct: 50, yPct: 50 },
  };
}

function updateFilmDeliverable(id, change, options = {}) {
  mutate((film) => {
    const deliverable = deliverableById(film, id);
    if (deliverable) change(deliverable, film);
  }, options);
}

function renderDeliverableFocusRows(card, deliverable) {
  const scenes = state.detail?.scenes ?? [];
  if (!scenes.length) return;
  const details = el('details', { class: 'deliverable-focus' });
  const customCount = Object.keys(deliverable.reframe?.segments ?? {}).length;
  details.appendChild(el('summary', { text: `per-scene framing${customCount ? ` (${customCount} custom)` : ''}` }));
  details.appendChild(el('p', {
    class: 'dim note',
    text: 'Set the crop focus for a scene only when it needs a different subject position. Reset returns it to this version’s default focus.',
  }));
  scenes.forEach((scene, index) => {
    const keys = segmentFocusKeys(scene);
    const primaryKey = scene.slug ?? keys[0];
    if (!primaryKey) return;
    const focus = segmentFocus(deliverable, scene);
    const row = el('div', { class: 'deliverable-focus-row' });
    row.appendChild(el('span', {
      class: 'deliverable-focus-name',
      text: scene.name ?? scene.slug ?? scene.footage ?? `scene ${index + 1}`,
      title: primaryKey,
    }));
    const writeFocus = (field, value) => updateFilmDeliverable(deliverable.id, (current) => {
      current.reframe ??= { default: { xPct: 50, yPct: 50 }, segments: {} };
      current.reframe.segments ??= {};
      const previous = segmentFocus(current, scene).point;
      current.reframe.segments[primaryKey] = {
        xPct: previous.xPct ?? 50,
        yPct: previous.yPct ?? 50,
        [field]: value ?? previous[field] ?? 50,
      };
    }, { silent: true });
    row.appendChild(labelled('x%', numInput(focus.point.xPct, {
      min: 0, step: 1, width: '48px', onCommit: (value) => writeFocus('xPct', value),
    })));
    row.appendChild(labelled('y%', numInput(focus.point.yPct, {
      min: 0, step: 1, width: '48px', onCommit: (value) => writeFocus('yPct', value),
    })));
    if (focus.key) {
      row.appendChild(el('button', {
        class: 'ghost tiny-btn', text: 'reset', title: 'use the default focus for this version',
        onclick: () => {
          updateFilmDeliverable(deliverable.id, (current) => {
            for (const key of keys) delete current.reframe?.segments?.[key];
          }, { structural: true, silent: true });
          renderInspector();
        },
      }));
    } else {
      row.appendChild(el('span', { class: 'dim deliverable-default', text: 'default' }));
    }
    details.appendChild(row);
  });
  card.appendChild(details);
}

function renderDeliverablesInspector(box, film) {
  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('h3', { text: 'platform versions' }));
  box.appendChild(el('p', {
    class: 'dim note',
    text: 'Each version is a saved reframe of this film’s completed master. Its timing, audio and edit stay shared; its crop, captions and output file stay version-specific.',
  }));

  const versions = film.deliverables ?? [];
  for (const deliverable of versions) {
    const card = el('section', { class: 'deliverable-card' });
    const title = el('div', { class: 'deliverable-card-head' },
      el('strong', { text: deliverable.label ?? deliverable.id }),
      el('span', { class: 'dim mono', text: `${deliverable.width}×${deliverable.height}` }),
      el('button', {
        class: 'ghost tiny-btn danger', text: 'remove', title: 'remove this platform version',
        onclick: () => {
          mutate((current) => { current.deliverables = (current.deliverables ?? []).filter((item) => item.id !== deliverable.id); }, { structural: true, silent: true });
          renderInspector();
        },
      }),
    );
    card.appendChild(title);

    const filename = el('input', { spellcheck: 'false', value: deliverable.outputFilename ?? '' });
    filename.value = deliverable.outputFilename ?? '';
    filename.addEventListener('change', () => {
      const next = filename.value.trim();
      if (!next) { filename.value = deliverable.outputFilename ?? ''; return; }
      updateFilmDeliverable(deliverable.id, (current) => { current.outputFilename = next; }, { silent: true });
    });
    card.appendChild(el('div', { class: 'insp-row' }, labelled('output filename', filename)));

    const style = deliverable.captionStyle ?? {};
    const captionSize = numInput(style.sizePct ?? 4.5, {
      min: 1, step: 0.5, width: '62px',
      onCommit: (value) => updateFilmDeliverable(deliverable.id, (current) => {
        current.captionStyle = { ...current.captionStyle, sizePct: value ?? 4.5 };
      }, { silent: true }),
    });
    const captionPosition = el('select', {
      onchange: (event) => updateFilmDeliverable(deliverable.id, (current) => {
        current.captionStyle = { ...current.captionStyle, position: event.target.value };
      }, { silent: true }),
    }, el('option', { value: 'bottom', text: 'bottom' }), el('option', { value: 'top', text: 'top' }));
    captionPosition.value = style.position ?? 'bottom';
    card.appendChild(el('div', { class: 'insp-row' },
      labelled('caption size %', captionSize), labelled('caption position', captionPosition),
    ));

    const def = deliverable.reframe?.default ?? { xPct: 50, yPct: 50 };
    const focusX = numInput(def.xPct, {
      min: 0, step: 1, width: '50px',
      onCommit: (value) => updateFilmDeliverable(deliverable.id, (current) => {
        current.reframe = { ...current.reframe, default: { ...current.reframe?.default, xPct: value ?? 50 } };
      }, { silent: true }),
    });
    const focusY = numInput(def.yPct, {
      min: 0, step: 1, width: '50px',
      onCommit: (value) => updateFilmDeliverable(deliverable.id, (current) => {
        current.reframe = { ...current.reframe, default: { ...current.reframe?.default, yPct: value ?? 50 } };
      }, { silent: true }),
    });
    card.appendChild(el('div', { class: 'insp-row' },
      labelled('default focus x%', focusX), labelled('y%', focusY),
    ));
    const safe = deliverable.safeAreas?.caption;
    if (safe) {
      card.appendChild(el('p', {
        class: 'dim note',
        text: `Caption-safe guide: ${safe.leftPct}% left / ${safe.rightPct}% right / ${safe.topPct}% top / ${safe.bottomPct}% bottom. It is drawn on the delivery contact sheet.`,
      }));
    }
    renderDeliverableFocusRows(card, deliverable);
    box.appendChild(card);
  }

  const available = filmDeliverablePresets().filter((preset) => !versions.some((item) => item.id === preset.id));
  if (!available.length) return;
  const choose = el('select');
  for (const preset of available) {
    choose.appendChild(el('option', { value: preset.id, text: `${preset.label} · ${preset.width}×${preset.height}` }));
  }
  const add = el('button', {
    class: 'ghost', text: 'add version',
    onclick: () => {
      const preset = available.find((item) => item.id === choose.value);
      if (!preset) return;
      const next = cloneJson(preset);
      next.outputFilename = `${deliverableBaseName(film.outputFilename)}-${next.id}`;
      mutate((current) => { (current.deliverables ??= []).push(next); }, { structural: true, silent: true });
      renderInspector();
    },
  });
  box.appendChild(el('div', { class: 'insp-row deliverable-add' }, labelled('add platform version', choose), add));
}

/* The film's own panels (v0.27.1). A scene explains itself through tabs; the
 * film did not, and it has the same two folders on disk — assets/ and out/ —
 * reachable through the very routes the server calls "shared target routes".
 *
 * It stops at two. `config` is not mirrored because a film's settings ARE the
 * film tab (captions style, platform versions, the facts) and its timing lives
 * in the timeline; `audio` is not mirrored because a film's audio IS the
 * timeline's master tracks, with fades and ducking a flat list cannot express.
 * Either would be a second editor for something already edited elsewhere. */
let filmPanels = null;

function ensureFilmPanels() {
  if (filmPanels) return filmPanels;
  filmPanels = ScenePanels.create({
    host: null,
    api,
    toast,
    toastError,
    compact: true,
    capabilities: { deleteScene: false }, // a film is deleted from the Studio tree
    onConfigChanged: () => {},            // films have no config panel to change one
    onSceneDeleted: () => {},
    // Deleting a film asset can drop master audio tracks with it, which is an
    // edit to the very document this page is holding open.
    onAssetsChanged: () => { refresh().catch(toastError); },
  });
  filmPanels.setTarget({ kind: 'film', id: filmId, path: state.film?.path ?? null })
    .catch(toastError);
  return filmPanels;
}

/**
 * Every kind of selection has a tab strip, and `advice` is the first tab on
 * all of them.
 *
 * It used to be a section at the foot of whatever panel you were on, which
 * made the human's half of the loop the one thing on this page you had to
 * scroll to find — past a scene's whole property sheet, and not present at all
 * on its four deep tabs. A tab is one click from anywhere, always in the same
 * place, and can carry the unresolved count so a selection says it has
 * something waiting before you open it.
 */
const INSPECTOR_TABS = {
  film: [
    ['advice', 'what has been said about this film, and where you say the next thing'],
    ['film', 'this film: its facts, caption style and platform versions'],
    ['assets', 'files in the film’s own assets/ folder — master audio, overlays, footage'],
    ['outputs', 'what this film has built'],
  ],
  scene: [
    ['advice', 'this take’s versions and the advice on it — and where you advise'],
    ['scene', 'this take: its facts and what to do with it'],
    ['config', 'composition and output settings — the scene’s own scene.json'],
    ['audio', 'audio tracks inside this scene (the film’s master audio is on the timeline)'],
    ['assets', 'files in this scene’s assets/ folder'],
    ['outputs', 'what this scene has rendered'],
  ],
  footage: [
    ['advice', 'the advice on this clip — and where you advise'],
    ['clip', 'this supplied clip: its file, its trim and its place in the cut'],
  ],
  sequence: [
    ['advice', 'the advice on this sequence and everything in it'],
    ['sequence', 'this sequence: its name, its intent and its span'],
  ],
  lane: [
    ['advice', 'the advice on this whole row — and on what is standing in it'],
    ['lane', 'this row: what it holds and what you can do to it'],
  ],
  audio: [['advice', 'the advice on this track'], ['audio', 'this track: level, trim, fades and ducking']],
  caption: [['advice', 'the advice on this caption'], ['caption', 'this caption: its words and its timing']],
  overlay: [['advice', 'the advice on this overlay'], ['overlay', 'this overlay: its source, its box and its timing']],
};

/** The panels mounted from scene-panels.js, which own an audition to stop. */
const SHARED_PANEL_TABS = ['config', 'audio', 'assets', 'outputs'];

function inspectorTabStrip(kind) {
  const nav = el('nav', { class: 'tabs insp-tabs' });
  for (const [name, title] of INSPECTOR_TABS[kind]) {
    const btn = el('button', {
      class: 'tab' + (state.tab[kind] === name ? ' active' : ''),
      text: name,
      title,
      onclick: () => { state.tab[kind] = name; renderInspector(); },
    });
    // The count belongs on the tab, not behind it: the whole point of putting
    // advice first is that you can see there is something to read.
    if (name === 'advice') {
      const n = (state.advice ?? []).filter((a) => a.status !== 'resolved').filter(adviceScope().pred).length;
      if (n) btn.appendChild(adviceBadge(n));
    }
    nav.appendChild(btn);
  }
  return nav;
}

/** The advice tab: this thing's takes, then the conversation about it. */
function renderAdviceTab(box) {
  renderVersionsSection(box, { lead: true });
  renderAdviceSection(box, { lead: box.children.length === 1 });
}

function renderFilmInspector(box) {
  box.appendChild(inspectorTabStrip('film'));
  if (state.tab.film === 'advice') return renderAdviceTab(box);
  if (state.tab.film !== 'film') {
    const panels = ensureFilmPanels();
    panels.show(state.tab.film);
    box.appendChild(panels.root);
    return;
  }
  const d = state.detail, f = state.film;
  box.appendChild(el('h3', { text: 'film' }));
  const dl = el('dl', { class: 'insp-facts' });
  const fact = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
  fact('scenes', String(f.scenes.length));
  fact('duration', d.totalFrames ? `${d.totalFrames}f · ${timecode(d.totalFrames)}` : '—');
  fact('audio tracks', String(f.audio.length));
  fact('captions', String(f.captions.length));
  fact('overlays', String(f.overlays.length));
  fact('workspace', f.workspace ?? '—');
  fact('output file', `${f.outputFilename}.${d.format === 'prores' ? 'mov' : d.format ?? 'mp4'}`);
  box.appendChild(dl);

  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('h3', { text: 'captions style' }));
  const style = f.captionStyle ?? {};
  const size = numInput(style.sizePct ?? 4.5, {
    min: 1, step: 0.5,
    onCommit: (v) => mutate((film) => { film.captionStyle = { ...film.captionStyle, sizePct: v ?? 4.5 }; }, { silent: true }) & updateLayers(state.playhead),
  });
  const pos = el('select', {
    onchange: (e) => mutate((film) => { film.captionStyle = { ...film.captionStyle, position: e.target.value }; }, { silent: true }) & updateLayers(state.playhead),
  }, el('option', { value: 'bottom', text: 'bottom' }), el('option', { value: 'top', text: 'top' }));
  pos.value = style.position ?? 'bottom';
  const burn = el('input', { type: 'checkbox' });
  burn.checked = !!f.burnCaptions;
  burn.addEventListener('change', () => mutate((film) => { film.burnCaptions = burn.checked; }, { silent: true }));
  box.appendChild(el('div', { class: 'insp-row' }, labelled('size % of height', size), labelled('position', pos)));
  box.appendChild(el('label', { class: 'check' }, burn, document.createTextNode(' burn captions into the picture')));
  box.appendChild(el('p', { class: 'dim note', text: 'A .srt sidecar is always written next to the film when captions exist. Burning re-encodes once in the finishing pass.' }));

  renderDeliverablesInspector(box, f);
  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('p', { class: 'dim note', text: 'Select a block on the timeline to edit it. Drag blocks to move, drag edges to trim, Del to remove.' }));
}

/* The scene's own panels (v0.27), mounted from scene-panels.js — the same four
 * the scene page mounts, so a scene cannot mean two different things depending
 * on which surface you opened it from. Created on first use: a film opened only
 * to watch never pays for them. */
let scenePanels = null;
let scenePanelsSceneId = null;

function ensureScenePanels() {
  if (scenePanels) return scenePanels;
  scenePanels = ScenePanels.create({
    host: null, // the inspector appends root itself, wherever the tab wants it
    api,
    toast,
    toastError,
    compact: true,
    async onConfigChanged() {
      // A renamed or retimed scene moves every offset after it, so the whole
      // film document is what changed — not one inspector row.
      try { await refresh(); } catch (err) { toastError(err); }
      StudioUtil.shell()?.treeChanged();
    },
    async onSceneDeleted() {
      state.selection = null;
      state.tab.scene = 'advice';
      scenePanelsSceneId = null;
      try { await refresh(); } catch (err) { toastError(err); }
    },
  });
  return scenePanels;
}

function mountScenePanels(box, s) {
  const panels = ensureScenePanels();
  const sceneId = `${filmId}/${s.slug}`;
  if (scenePanelsSceneId !== sceneId) {
    scenePanelsSceneId = sceneId;
    panels.setTarget({ kind: 'scene', id: sceneId })
      .then(() => panels.show(state.tab.scene))
      .catch((err) => { scenePanelsSceneId = null; toastError(err); });
  }
  panels.show(state.tab.scene);
  box.appendChild(panels.root);
}

function renderSceneInspector(box, index) {
  const s = state.detail.scenes[index];
  if (!s) return renderFilmInspector(box);
  if (s.kind === 'footage') return renderFootageInspector(box, index, s);
  box.appendChild(inspectorTabStrip('scene'));
  if (state.tab.scene === 'advice') return renderAdviceTab(box);
  if (state.tab.scene !== 'scene') return mountScenePanels(box, s);
  box.appendChild(el('h3', { text: `scene ${index + 1}` }));
  const dl = el('dl', { class: 'insp-facts' });
  const fact = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
  fact('name', s.name ?? '(missing)');
  fact('status', s.missing ? 'scene folder missing' : s.rendered ? 'rendered ✓' : 'NOT rendered');
  if (!s.missing) {
    fact('video', `${s.width}×${s.height} @ ${s.fps}fps`);
    fact('length', `${s.durationInFrames}f · ${(s.durationInFrames / s.fps).toFixed(2)}s`);
    fact('format', s.format + (s.hasAudio ? ' · has audio' : ''));
    fact('film offset', `${s.filmOffset}f · ${timecode(s.filmOffset)}`);
  }
  box.appendChild(dl);
  sequenceInspectorRow(box, index);

  const row1 = el('div', { class: 'insp-row' });
  if (!s.missing) {
    const job = state.sceneJobs.get(s.slug);
    const rendering = job && !['done', 'error', 'cancelled'].includes(job.state);
    const btnRender = el('button', {
      class: 'ghost', text: rendering ? `rendering ${job.percent ?? 0}%…` : (s.rendered ? 're-render scene' : 'render scene'),
      onclick: () => renderScene(s.slug),
    });
    if (rendering) btnRender.disabled = true;
    row1.appendChild(btnRender);
  }
  box.appendChild(row1);
  const row2 = el('div', { class: 'insp-row' });
  row2.appendChild(el('button', {
    class: 'ghost', text: '◀ move earlier',
    onclick: () => moveScene(index, index - 1),
  }));
  row2.appendChild(el('button', {
    class: 'ghost', text: 'move later ▶',
    onclick: () => moveScene(index, index + 1),
  }));
  row2.appendChild(el('button', { class: 'ghost danger', text: 'remove', onclick: deleteSelection }));
  box.appendChild(row2);
  box.appendChild(el('p', { class: 'dim note', text: 'Each scene is its own folder inside the film, stitched losslessly. Its settings, audio, assets and renders are the tabs above; re-render and the film picks the new output up automatically. Removing a scene only drops it from the play order; the folder stays in the rail as unlisted.' }));
  // Demoted in v0.27. This used to be the only route to a scene's config, so it
  // sat beside "render scene" as a primary action and every reviewer had to
  // leave the timeline to read a format. With the tabs above, it is what the
  // arrow always claimed: an escape hatch to the full-screen editor, for the
  // preview iframe and the render job card the inspector has no room for. Still
  // a plain <a href>, so ctrl/cmd-click opens a browser tab.
  box.appendChild(el('p', { class: 'dim note insp-escape' },
    el('a', {
      href: `/scene.html?scene=${encodeURIComponent(s.sceneId)}`,
      text: 'open scene ↗',
      title: 'open this scene as its own document',
      onclick: (ev) => {
        // Embedded this is a sibling tab; standalone the href is the fallback,
        // and ctrl/cmd-click still means "a real browser tab" either way.
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
        ev.preventDefault();
        StudioUtil.openDocument({ kind: 'scene', id: s.sceneId, name: s.name });
      },
    })));
}

/**
 * Footage segments (v0.22): a supplied file on the timeline. Almost none of the
 * scene inspector applies — there is nothing to render, no folder to open, and
 * the file's own properties are the truth — so it gets its own facts rather than
 * a scene panel with half its rows blank or wrong.
 */
function renderFootageInspector(box, index, s) {
  box.appendChild(inspectorTabStrip('footage'));
  if (state.tab.footage === 'advice') return renderAdviceTab(box);
  box.appendChild(el('h3', { text: `footage ${index + 1}` }));
  const dl = el('dl', { class: 'insp-facts' });
  const fact = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
  fact('file', s.footage);
  if (s.label) fact('label', s.label);
  if (s.derivedFrom) {
    fact('source', s.derivedFrom.asset);
    fact('source record', s.derivedFrom.transcodeMeta);
    fact('source status', s.derivedFrom.sourceVerified === true
      ? 'verified ✓'
      : s.derivedFrom.sourceVerified === false
        ? `⚠ ${String(s.derivedFrom.reason ?? 'changed').replace(/_/g, ' ')}`
        : 'unverified');
  }
  if (s.missing) {
    fact('status', '⚠ missing from the film’s assets/');
  } else if (s.probed === false) {
    fact('status', 'unverified (ffprobe unavailable)');
  } else {
    fact('video', `${s.width}×${s.height} @ ${s.fps}fps · ${s.codec} · ${s.pixFmt}`);
    // The declared count is what every later offset is built on, so a
    // disagreement is the headline, not a footnote.
    fact('frames', s.framesVerified === false
      ? `⚠ declared ${s.durationInFrames} → actual ${s.actualFrames}`
      : `${s.durationInFrames}f verified ✓`);
    if (s.hasAudio) fact('audio', '⚠ has an audio stream (footage must be silent)');
    fact('signature', s.signature ?? '(unknown)');
  }
  fact('film offset', `${s.filmOffset}f · ${timecode(s.filmOffset)}`);
  box.appendChild(dl);
  sequenceInspectorRow(box, index);

  // A clip is already a video, and the player is already showing this film at
  // this offset — so "watch it" is just: go to its first frame and roll. It
  // plays in the cut it sits in, which is the only place its length, its
  // neighbours and its overlays mean anything.
  if (!s.missing) {
    box.appendChild(el('div', { class: 'insp-row' }, el('button', {
      class: 'ghost', text: '▶ watch this clip',
      title: 'plays the clip from its first frame, in the film',
      onclick: () => { stopPlayback(); setPlayhead(s.filmOffset ?? 0); startPlayback(); },
    })));
  }

  const row = el('div', { class: 'insp-row' });
  row.appendChild(el('button', { class: 'ghost', text: '◀ move earlier', onclick: () => moveScene(index, index - 1) }));
  row.appendChild(el('button', { class: 'ghost', text: 'move later ▶', onclick: () => moveScene(index, index + 1) }));
  row.appendChild(el('button', { class: 'ghost danger', text: 'remove', onclick: deleteSelection }));
  box.appendChild(row);
  box.appendChild(el('p', {
    class: 'dim note',
    text: 'Footage joins the film as-is — no re-encode, so it must already match the film signature and carry no '
      + 'audio (put its sound on the master audio timeline instead). Removing it only drops it from the play order; '
      + 'the file stays in the film’s assets/.',
  }));
  // The capability a human would otherwise never learn exists, said instead of
  // offered. Converting a clip into a composition costs a re-encode and a full
  // render — an operator's decision, and the operator here is the AI. So this
  // teaches the sentence to say rather than putting a button on the spend.
  box.appendChild(el('p', {
    class: 'dim note',
    text: 'Nothing can change what this clip LOOKS like while it is footage. If you need it masked, reframed, '
      + 're-timed, graded or transitioned, advise the AI on it — the AI can turn a clip into a scene that plays '
      + 'it and then direct that with code.',
  }));
}

function moveScene(from, to) {
  if (to < 0 || to >= state.film.scenes.length) return;
  mutate((film) => {
    const [ref] = film.scenes.splice(from, 1);
    film.scenes.splice(to, 0, ref);
  }, { structural: true, silent: true });
  const [ds] = state.detail.scenes.splice(from, 1);
  state.detail.scenes.splice(to, 0, ds);
  reflowLocalScenes();
  state.selection = { kind: 'scene', index: to };
  renderTimeline();
  renderInspector();
  setPlayhead(state.playhead);
}

async function renderScene(slug) {
  try {
    const job = await api(`${sceneApi(slug)}/render`, { method: 'POST', body: {} });
    state.sceneJobs.set(slug, { jobId: job.jobId, state: job.state, percent: 0 });
    pollSceneJobs();
    renderTimeline();
    renderInspector();
  } catch (err) { toastError(err); }
}

let scenePollTimer = null;
function pollSceneJobs() {
  if (scenePollTimer) return;
  scenePollTimer = setInterval(async () => {
    let activeCount = 0;
    for (const [slug, j] of state.sceneJobs) {
      if (['done', 'error', 'cancelled'].includes(j.state)) continue;
      activeCount++;
      try {
        const s = await api(`/api/jobs/${j.jobId}`);
        state.sceneJobs.set(slug, { jobId: j.jobId, state: s.state, percent: s.percent });
        if (s.state === 'done') {
          toast(`Scene rendered ✓`, { kind: 'info' });
          await refresh();
        } else if (s.state === 'error') {
          toastError(new Error(`Scene render failed: ${s.error?.message ?? 'unknown'}`));
        }
      } catch { /* job may have been evicted */ }
    }
    renderTimeline();
    if (state.selection?.kind === 'scene') renderInspector();
    if (!activeCount) { clearInterval(scenePollTimer); scenePollTimer = null; }
  }, 900);
}

function renderAudioInspector(box, id) {
  const t = state.film.audio.find((x) => x.id === id);
  if (!t) return renderFilmInspector(box);
  box.appendChild(inspectorTabStrip('audio'));
  if (state.tab.audio === 'advice') return renderAdviceTab(box);
  box.appendChild(el('h3', { text: 'audio track' }));

  const name = el('input', { placeholder: '(label)' });
  name.value = t.label ?? '';
  name.addEventListener('change', () => mutate((film) => {
    const tr = film.audio.find((x) => x.id === id);
    if (tr) { if (name.value.trim()) tr.label = name.value.trim(); else delete tr.label; }
  }));
  box.appendChild(el('div', { class: 'insp-row' }, labelled('label', name)));

  const srcRow = el('div', { class: 'insp-row' });
  const srcSel = el('select', {
    onchange: () => mutate((film) => {
      const tr = film.audio.find((x) => x.id === id);
      if (tr) { tr.src = srcSel.value; delete tr.trimEndInFrames; delete tr.trimStartInFrames; }
    }),
  });
  for (const a of state.assets.filter((a) => a.kind === 'audio')) {
    srcSel.appendChild(el('option', { value: a.path, text: a.path.replace(/^assets\//, '') }));
  }
  if (![...srcSel.options].some((o) => o.value === t.src)) {
    srcSel.appendChild(el('option', { value: t.src, text: `${t.src} (missing?)` }));
  }
  srcSel.value = t.src;
  const audition = el('button', { class: 'ghost', text: '▶', title: 'audition this file', onclick: () => new Audio(assetUrl(t.src)).play().catch(() => {}) });
  srcRow.append(labelled('file', srcSel), audition);
  box.appendChild(srcRow);

  const start = numInput(t.startInFrames ?? 0, { min: 0, onCommit: (v) => mutate((film) => { const tr = film.audio.find((x) => x.id === id); if (tr) tr.startInFrames = v ?? 0; }) });
  // Both trims index the source file, so they read as a window: in at N, out
  // at M. The timeline's two grips write these same two numbers.
  const trimIn = numInput(t.trimStartInFrames ?? '', { min: 0, onCommit: (v) => mutate((film) => { const tr = film.audio.find((x) => x.id === id); if (!tr) return; if (v) tr.trimStartInFrames = v; else delete tr.trimStartInFrames; }) });
  const trim = numInput(t.trimEndInFrames ?? '', { min: 1, onCommit: (v) => mutate((film) => { const tr = film.audio.find((x) => x.id === id); if (!tr) return; if (v) tr.trimEndInFrames = v; else delete tr.trimEndInFrames; }) });
  trimIn.placeholder = 'file start';
  trim.placeholder = 'full';
  box.appendChild(el('div', { class: 'insp-row' }, labelled('start (frames)', start)));
  box.appendChild(el('div', { class: 'insp-row' }, labelled('trim in (source f)', trimIn), labelled('trim out (source f)', trim)));

  // Gain: slider + numeric readout.
  const gainWrap = el('div', { class: 'range-row' });
  const slider = el('input', { type: 'range', min: '-40', max: '12', step: '0.5' });
  slider.value = t.gainDb ?? 0;
  const val = el('span', { class: 'val', text: `${t.gainDb ?? 0} dB` });
  slider.addEventListener('input', () => { val.textContent = `${slider.value} dB`; });
  slider.addEventListener('change', () => mutate((film) => {
    const tr = film.audio.find((x) => x.id === id);
    if (tr) tr.gainDb = Number(slider.value);
  }));
  gainWrap.append(slider, val);
  box.appendChild(el('div', { class: 'insp-row' }, labelled('gain', gainWrap)));

  const fin = numInput(t.fadeInFrames ?? '', { min: 0, onCommit: (v) => mutate((film) => { const tr = film.audio.find((x) => x.id === id); if (!tr) return; if (v) tr.fadeInFrames = v; else delete tr.fadeInFrames; }) });
  const fout = numInput(t.fadeOutFrames ?? '', { min: 0, onCommit: (v) => mutate((film) => { const tr = film.audio.find((x) => x.id === id); if (!tr) return; if (v) tr.fadeOutFrames = v; else delete tr.fadeOutFrames; }) });
  fin.placeholder = 'none'; fout.placeholder = 'none';
  box.appendChild(el('div', { class: 'insp-row' }, labelled('fade in (frames)', fin), labelled('fade out (frames)', fout)));

  const mute = el('input', { type: 'checkbox' });
  mute.checked = !!t.mute;
  mute.addEventListener('change', () => mutate((film) => {
    const tr = film.audio.find((x) => x.id === id);
    if (tr) { if (mute.checked) tr.mute = true; else delete tr.mute; }
  }));
  box.appendChild(el('label', { class: 'check' }, mute, document.createTextNode(
    ` mute this track${isLaneMuted(t.lane ?? 0) ? ' (its lane is muted too)' : ''}`)));

  const duck = el('input', { type: 'checkbox' });
  duck.checked = !!t.duck;
  duck.addEventListener('change', () => mutate((film) => {
    const tr = film.audio.find((x) => x.id === id);
    if (tr) { if (duck.checked) tr.duck = true; else delete tr.duck; }
  }));
  box.appendChild(el('label', { class: 'check' }, duck, document.createTextNode(' duck under the other tracks (music bed under narration)')));

  const wave = state.waves.get(t.src);
  if (wave?.duration) {
    box.appendChild(el('p', { class: 'dim note mono', text: `clip: ${wave.duration.toFixed(2)}s · ${Math.round(wave.duration * fps())}f` }));
  }

  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('div', { class: 'insp-row' },
    el('button', { class: 'ghost', text: 'duplicate', onclick: () => mutate((film) => { film.audio.push({ ...t, id: uuid(), startInFrames: (t.startInFrames ?? 0) + clipFrames(t) }); }) }),
    el('button', { class: 'ghost danger', text: 'delete', onclick: deleteSelection })));
}

function renderCaptionInspector(box, id) {
  const c = state.film.captions.find((x) => x.id === id);
  if (!c) return renderFilmInspector(box);
  box.appendChild(inspectorTabStrip('caption'));
  if (state.tab.caption === 'advice') return renderAdviceTab(box);
  box.appendChild(el('h3', { text: 'caption' }));
  const text = el('textarea', { id: 'insp-caption-text' });
  text.value = c.text;
  text.addEventListener('input', () => {
    const cc = state.film.captions.find((x) => x.id === id);
    if (cc) { cc.text = text.value; scheduleSave(); updateLayers(state.playhead); }
  });
  text.addEventListener('change', () => renderTimeline());
  box.appendChild(el('div', { class: 'insp-row' }, labelled('text', text)));

  const from = numInput(c.fromFrame, { min: 0, onCommit: (v) => mutate((film) => { const cc = film.captions.find((x) => x.id === id); if (cc) cc.fromFrame = Math.min(v ?? 0, cc.toFrame - 1); }) });
  const to = numInput(c.toFrame, { min: 1, onCommit: (v) => mutate((film) => { const cc = film.captions.find((x) => x.id === id); if (cc) cc.toFrame = Math.max(v ?? 1, cc.fromFrame + 1); }) });
  box.appendChild(el('div', { class: 'insp-row' }, labelled('from (frame)', from), labelled('to (frame)', to)));
  box.appendChild(el('p', { class: 'dim note mono', text: `${timecode(c.fromFrame)} → ${timecode(c.toFrame)} · ${((c.toFrame - c.fromFrame) / fps()).toFixed(2)}s` }));
  box.appendChild(el('div', { class: 'insp-row' },
    el('button', { class: 'ghost', text: 'set from = playhead', onclick: () => mutate((film) => { const cc = film.captions.find((x) => x.id === id); if (cc) cc.fromFrame = Math.min(Math.round(state.playhead), cc.toFrame - 1); }) }),
    el('button', { class: 'ghost', text: 'set to = playhead', onclick: () => mutate((film) => { const cc = film.captions.find((x) => x.id === id); if (cc) cc.toFrame = Math.max(Math.round(state.playhead), cc.fromFrame + 1); }) })));
  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('div', { class: 'insp-row' },
    el('button', { class: 'ghost danger', text: 'delete', onclick: deleteSelection })));
}

function renderOverlayInspector(box, id) {
  const o = state.film.overlays.find((x) => x.id === id);
  if (!o) return renderFilmInspector(box);
  box.appendChild(inspectorTabStrip('overlay'));
  if (state.tab.overlay === 'advice') return renderAdviceTab(box);
  box.appendChild(el('h3', { text: 'overlay' }));

  const srcSel = el('select', {
    onchange: () => mutate((film) => { const oo = film.overlays.find((x) => x.id === id); if (oo) oo.src = srcSel.value; }),
  });
  for (const a of state.assets.filter((a) => a.kind === 'image' || a.kind === 'video')) {
    srcSel.appendChild(el('option', { value: a.path, text: a.path.replace(/^assets\//, '') }));
  }
  if (![...srcSel.options].some((x) => x.value === o.src)) srcSel.appendChild(el('option', { value: o.src, text: `${o.src} (missing?)` }));
  srcSel.value = o.src;
  box.appendChild(el('div', { class: 'insp-row' }, labelled('asset', srcSel)));

  const from = numInput(o.fromFrame, { min: 0, onCommit: (v) => mutate((film) => { const oo = film.overlays.find((x) => x.id === id); if (oo) oo.fromFrame = Math.min(v ?? 0, oo.toFrame - 1); }) });
  const to = numInput(o.toFrame, { min: 1, onCommit: (v) => mutate((film) => { const oo = film.overlays.find((x) => x.id === id); if (oo) oo.toFrame = Math.max(v ?? 1, oo.fromFrame + 1); }) });
  box.appendChild(el('div', { class: 'insp-row' }, labelled('from (frame)', from), labelled('to (frame)', to)));

  const mkPct = (key, cur, min, max, step) => {
    const wrap = el('div', { class: 'range-row' });
    const slider = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    slider.value = cur;
    const val = el('span', { class: 'val', text: `${cur}` });
    let before = cur;
    // Live: update state + preview only. Commit: restore, then mutate — so the
    // whole slider gesture is ONE undo step and one save.
    slider.addEventListener('input', () => {
      val.textContent = slider.value;
      const oo = state.film.overlays.find((x) => x.id === id);
      if (oo) { oo[key] = Number(slider.value); updateLayers(state.playhead); }
    });
    slider.addEventListener('change', () => {
      const v = Number(slider.value);
      const oo = state.film.overlays.find((x) => x.id === id);
      if (oo) oo[key] = before;
      mutate((film) => {
        const o2 = film.overlays.find((x) => x.id === id);
        if (o2) o2[key] = v;
      }, { silent: true });
      before = v;
      renderTimeline();
      updateLayers(state.playhead);
    });
    wrap.append(slider, val);
    return wrap;
  };
  box.appendChild(el('div', { class: 'insp-row' }, labelled('x %', mkPct('xPct', o.xPct ?? 0, -50, 150, 0.5))));
  box.appendChild(el('div', { class: 'insp-row' }, labelled('y %', mkPct('yPct', o.yPct ?? 0, -50, 150, 0.5))));
  box.appendChild(el('div', { class: 'insp-row' }, labelled('width % (of frame)', mkPct('widthPct', o.widthPct ?? 30, 2, 200, 0.5))));
  box.appendChild(el('div', { class: 'insp-row' }, labelled('opacity', mkPct('opacity', o.opacity ?? 1, 0, 1, 0.02))));
  box.appendChild(el('p', { class: 'dim note', text: 'Composited by the finishing pass (one re-encode). Transparent .webm overlays keep their alpha.' }));
  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('div', { class: 'insp-row' },
    el('button', { class: 'ghost danger', text: 'delete', onclick: deleteSelection })));
}

/* ---------------------------- inspector width ---------------------------- */

/* 300px was right when the inspector held six facts and three buttons. It now
 * carries a scene's whole configuration, so it is a column the human owns:
 * dragged from its left edge, clamped so the stage can still show a film, and
 * remembered. Final Cut's inspector resizes for the same reason. */
const INSP_MIN = 280;
const INSP_MAX = 620;
const INSP_KEY = 'ms.inspectorWidth';

function setInspectorWidth(px) {
  const w = clamp(Math.round(px), INSP_MIN, Math.max(INSP_MIN, Math.min(INSP_MAX, Math.round(window.innerWidth * 0.55))));
  document.documentElement.style.setProperty('--insp-w', `${w}px`);
  return w;
}

const RAIL_KEY = 'ms.railWidth';
const RAIL_MIN = 150;
const RAIL_MAX = 480;

/** The film explorer's width, clamped the way the inspector's is. */
function setRailWidth(px) {
  const w = clamp(Math.round(px), RAIL_MIN, Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(window.innerWidth * 0.4))));
  document.documentElement.style.setProperty('--rail-w', `${w}px`);
  return w;
}

/**
 * Drag either edge of the stage. Written once for both grips because they are
 * the same gesture mirrored: the inspector grows as the pointer moves LEFT, the
 * rail as it moves right, which is the whole difference and is the `sign`.
 */
function bindGrip({ grip, panel, sign, apply, storageKey, busyClass }) {
  grip?.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = panel().getBoundingClientRect().width;
    document.body.classList.add(busyClass);
    const move = (e2) => { apply(startW + sign * (e2.clientX - startX)); fitPlayerBox(); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove(busyClass);
      const w = apply(panel().getBoundingClientRect().width);
      try { localStorage.setItem(storageKey, String(w)); }
      catch { /* private mode / quota: the width is a convenience, never a blocker */ }
      fitPlayerBox();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

{
  const stored = Number(localStorage.getItem(INSP_KEY));
  if (Number.isFinite(stored) && stored > 0) setInspectorWidth(stored);

  const storedRail = Number(localStorage.getItem(RAIL_KEY));
  if (Number.isFinite(storedRail) && storedRail > 0) setRailWidth(storedRail);

  bindGrip({
    grip: $('#insp-grip'),
    panel: () => $('#inspector'),
    sign: -1,                    // the inspector grows as the pointer goes left
    apply: setInspectorWidth,
    storageKey: INSP_KEY,
    busyClass: 'resizing-insp',
  });
  bindGrip({
    grip: $('#rail-grip'),
    panel: () => $('#fe-scenes'),
    sign: 1,                     // the rail grows as the pointer goes right
    apply: setRailWidth,
    storageKey: RAIL_KEY,
    busyClass: 'resizing-rail',
  });

  // Both clamps are a fraction of the window, so a shrunk window must re-clamp
  // or a panel eats the stage.
  window.addEventListener('resize', () => {
    setInspectorWidth($('#inspector').getBoundingClientRect().width);
    if (!document.querySelector('.fe-frame')?.classList.contains('rail-collapsed')) {
      setRailWidth($('#fe-scenes').getBoundingClientRect().width);
    }
  });
}

/* The timeline's height, traded against the stage's (v0.27). The wrapper
 * carried `resize: vertical` and a comment promising a resizer row that was
 * never built; the native handle grows a bottom-pinned panel downward, off the
 * window, which is why the timeline was 300px whatever the film needed. Four
 * audio lanes plus captions and overlays do not fit in 300px, and a film you
 * are only watching does not need them. */
const TL_MIN = 120;
const STAGE_MIN = 200;
const TL_DEFAULT = 300;
const TL_KEY = 'ms.timelineHeight';

function setTimelineHeight(px) {
  // Always leave the player something to be: the STAGE keeps 200px, which is
  // the frame minus the chrome above it — the header, and the problems banner
  // when a film has any. Measuring against the frame alone left the stage at
  // 147px, because that chrome is inside the frame too.
  const frame = document.querySelector('.fe-frame')?.getBoundingClientRect().height ?? window.innerHeight;
  const chrome = ['.fe-top', '.problems']
    .reduce((sum, sel) => sum + (document.querySelector(sel)?.getBoundingClientRect().height ?? 0), 0);
  const room = Math.round(frame - chrome - STAGE_MIN);
  const h = clamp(Math.round(px), TL_MIN, Math.max(TL_MIN, room));
  document.documentElement.style.setProperty('--tl-h', `${h}px`);
  return h;
}

{
  const stored = Number(localStorage.getItem(TL_KEY));
  if (Number.isFinite(stored) && stored > 0) setTimelineHeight(stored);

  $('#tl-grip')?.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const startY = ev.clientY;
    const startH = $('#tl-scroll').closest('.fe-timeline-wrap').getBoundingClientRect().height;
    document.body.classList.add('resizing-tl');
    // Up is bigger: the grip is the timeline's TOP edge.
    const move = (e2) => { setTimelineHeight(startH - (e2.clientY - startY)); fitPlayerBox(); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-tl');
      const h = setTimelineHeight($('#tl-scroll').closest('.fe-timeline-wrap').getBoundingClientRect().height);
      try { localStorage.setItem(TL_KEY, String(h)); }
      catch { /* private mode / quota: the height is a convenience, never a blocker */ }
      fitPlayerBox();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  $('#tl-grip')?.addEventListener('dblclick', () => {
    const h = setTimelineHeight(TL_DEFAULT);
    try { localStorage.setItem(TL_KEY, String(h)); } catch { /* see above */ }
    fitPlayerBox();
  });

  // A shorter window must re-clamp, or a timeline sized on a big screen leaves
  // no stage at all on a small one.
  window.addEventListener('resize', () => {
    const wrap = $('#tl-scroll')?.closest('.fe-timeline-wrap');
    if (wrap) setTimelineHeight(wrap.getBoundingClientRect().height);
  });
}

/* --------------------------------- zoom --------------------------------- */

/* `fitMeasured` is false when the timeline has no box yet — a document mounted
 * behind another tab, or one whose editor stack was display:none while a
 * full-stage page was up. Fitting to that gives the 0.005 floor, which is the
 * whole film squeezed into a hundred pixels. Callers must not latch a fit they
 * did not actually measure. */
function computeFit() {
  const sc = $('#tl-scroll');
  // BUG-4: the ResizeObserver below can fire while this document's iframe is
  // being torn down — the element is gone, the callback is not. A document with
  // no timeline has no fit to compute; the cost of not guarding was one red
  // console line per closed film, which a real error then had to be found among.
  if (!sc) return;
  const usable = sc.clientWidth - HEAD_W - TAIL_PX / 2;
  state.fitMeasured = usable > 0;
  state.pxfFit = Math.max(0.005, usable / Math.max(1, totalFrames()));
}

/* A film opens fitted, and "has it been fitted yet, for real?" is ONE rule —
 * both the first render and the ResizeObserver below ask it. Keeping the
 * condition in two places is what let this break: the observer's own first
 * firing (before the film's frames had loaded) latched the flag, and the real
 * fit that should have followed was then skipped.
 *
 * A fit is real only when the timeline has a width AND the film has frames.
 * Neither is true for a document mounted while its editor stack is
 * display:none — which is what a deep link like /?page=music does on its way
 * past, and how the whole film ended up squeezed into a hundred pixels. */
function needsFit() {
  if (!state.fitMeasured) return false;
  if (!state._zoomInit) return true;                                 // never fitted
  if (state._zoomInitFrames === 0 && totalFrames() > 0) return true; // fitted against an empty film
  // "Fit" is a MODE, not a value it was set to once: while nobody has zoomed
  // deliberately, a film that fits stays fitting as its viewport settles or
  // changes. The moment they zoom, the view is theirs and nothing touches it.
  return !state.userZoomed;
}

function applyFit() {
  if (!needsFit()) return false;
  state.pxf = clamp(state.pxfFit, 0.002, 24);
  state._zoomInit = true;
  state._zoomInitFrames = totalFrames();
  setZoomSlider();
  return true;
}
function setZoomSlider() {
  const lo = Math.log(state.pxfFit), hi = Math.log(Math.max(state.pxfFit * 4, 12));
  $('#zoom-slider').value = String(Math.round(clamp((Math.log(state.pxf) - lo) / (hi - lo), 0, 1) * 100));
}
function setPxf(pxf, anchorFrame = null) {
  const sc = $('#tl-scroll');
  // Anchor the zoom on the viewport centre so the view doesn't lurch.
  if (anchorFrame === null) anchorFrame = (sc.scrollLeft + sc.clientWidth / 2 - HEAD_W) / state.pxf;
  const anchorPx = HEAD_W + anchorFrame * state.pxf - sc.scrollLeft;
  state.pxf = clamp(pxf, Math.max(0.002, state.pxfFit * 0.25), 24);
  renderTimeline();
  sc.scrollLeft = HEAD_W + anchorFrame * state.pxf - anchorPx;
  setZoomSlider();
}
function zoomBy(factor) { state.userZoomed = true; setPxf(state.pxf * factor); }
/** Fill the timeline viewport with one stretch of film and park it against the
 *  track heads — "zoom to this movement", the double-click on a sequence. */
function zoomToRange(offset, frames) {
  state.userZoomed = true;
  const sc = $('#tl-scroll');
  setPxf(Math.max(80, sc.clientWidth - HEAD_W) / Math.max(1, frames));
  sc.scrollLeft = offset * state.pxf; // a block at frame f sits at HEAD_W + f·pxf
}
function zoomFit() { state.userZoomed = false; computeFit(); setPxf(state.pxfFit, 0); }

/* A film opens fitted. It could not when the timeline had no box yet at load —
 * a document mounted while its editor stack was display:none, which is what a
 * deep link like /?page=music does on its way past — because the fit was
 * computed against zero width, pinned at the 0.005 floor, and latched. The
 * whole film ended up in a hundred pixels with no way back but the fit button.
 *
 * This finishes that first fit once the timeline actually has a width. It
 * deliberately does NOT re-fit on later resizes: once a zoom is on screen it
 * is the human's, and collapsing the Explorer must not re-zoom the timeline
 * any more than it re-zooms an editor. Later resizes only keep pxfFit — the
 * slider's low end, and the floor setPxf clamps against — honest. */
new ResizeObserver(() => {
  computeFit();
  if (!state.fitMeasured) return;              // still no box; try again later
  if (applyFit()) renderTimeline();
  else setZoomSlider();                        // keep the slider's scale honest
}).observe($('#tl-scroll'));
$('#btn-zoom-in').addEventListener('click', () => zoomBy(1.3));
$('#btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));
$('#btn-zoom-fit').addEventListener('click', zoomFit);
// Double-clicking the empty timeline is the way back out of a zoomed sequence:
// the whole film, the same as the fit button. A block or band owns its own
// double-click, so those are left alone.
$('#tl-scroll').addEventListener('dblclick', (ev) => {
  if (ev.target.closest('.seq-band, .blk, .tl-head, .adv-marker')) return;
  zoomFit();
});
// The tree repaints on selection, so the row that took the first click is gone
// before the second one lands and the dblclick is delivered to this container
// instead. That first click already selected the band — so zoom to whatever is
// selected, which is exactly the row the pointer is on.
$('#fe-tree').addEventListener('dblclick', () => {
  if (state.selection?.kind !== 'sequence') return;
  const band = sequenceBands().find((b) => b.label === state.selection.sequence);
  if (band) zoomToRange(band.offset, band.frames);
});
$('#zoom-slider').addEventListener('input', (e) => {
  state.userZoomed = true;
  const lo = Math.log(state.pxfFit), hi = Math.log(Math.max(state.pxfFit * 4, 12));
  setPxf(Math.exp(lo + (Number(e.target.value) / 100) * (hi - lo)));
});
$('#btn-snap').addEventListener('click', (e) => {
  state.snap = !state.snap;
  e.target.classList.toggle('on', state.snap);
});

/* ------------------------------- dialogs -------------------------------- */

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => $(`#${btn.dataset.close}`).close());
}

/* ---- scenes ---- */

/* The unused-scenes rail: scene folders on disk that the play order does NOT
 * reference. Listed scenes moved up into the tree (v0.23.1) — showing them in
 * both places was the confusion, since the tree is the play order and this is
 * the shelf beside it. A row here is one drag (or +) away from the timeline.
 * "+ new scene" scaffolds a fresh folder — the server appends it. */

function sceneCompat(f) {
  // Compatibility against the film's established signature (first scene wins).
  // `detail.signature` is the structured contract (v0.22); `.id` is the string
  // each scene's own signature is compared against.
  const sig = state.detail?.signature;
  if (!sig || f.missing) return { ok: true };
  const s = state.detail.scenes.find((x) => x.slug === f.slug && !x.missing);
  if (s) return { ok: s.signature === sig.id, sig: s.signature };
  // Unlisted folder: resolution/fps/format are known; alpha and pixFmt only
  // resolve server-side after adding — flagged then if wrong. Compared field by
  // field now that the contract is data, instead of re-parsing its string form.
  const known = f.width === sig.width && f.height === sig.height
    && f.fps === sig.fps && f.format === sig.format;
  return { ok: known ? null : false };
}

function renderScenesRail() {
  const ul = $('#fe-scene-list');
  if (!ul || !state.film) return;
  ul.innerHTML = '';
  const listedSlugs = new Set(state.film.scenes.map((s) => s.slug));
  const rows = (state.sceneFolders ?? []).filter((f) => !listedSlugs.has(f.slug));
  document.querySelector('.fe-rail-split')?.classList.toggle('hidden', !rows.length);
  if (!rows.length) {
    ul.classList.add('hidden');
    return;
  }
  ul.classList.remove('hidden');
  for (const f of rows) {
    const li = document.createElement('li');
    li.title = 'drag onto the timeline to place, or + to append';
    const compat = sceneCompat(f);
    if (compat.ok === false || f.missing) li.classList.add('incompat');
    li.appendChild(el('span', { class: 'sr-name', text: f.name ?? f.slug }));
    if (!f.missing) {
      const add = el('button', {
        class: 'sr-add', text: '+', title: 'append as the last scene',
        onclick: (ev) => { ev.stopPropagation(); insertSceneAt(f.slug, state.film.scenes.length); },
      });
      add.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      li.appendChild(add);
    }
    // Getting rid of one, from where they pile up. A scene dropped from the
    // play order lands here and then had nowhere to go: deleting the folder
    // lived behind the CONFIG tab of a scene you first had to put BACK on the
    // timeline to select. This is the shelf, so it is where "throw it away"
    // belongs — and because that is irreversible, it asks first and says what
    // goes with it. A broken folder gets the button too; clearing it is the
    // only thing anyone wants from it.
    const del = el('button', {
      class: 'sr-del', text: '✕', title: 'delete this scene folder — composition, assets and renders',
      onclick: (ev) => { ev.stopPropagation(); confirmDeleteSceneFolder(f); },
    });
    del.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    li.appendChild(del);
    const meta = el('span', {
      class: 'sr-meta',
      text: (f.missing ? 'unreadable ' : compat.ok === false ? '≠ film format ' : '') || ' ',
    });
    meta.appendChild(el('span', { class: 'sr-flag unlisted', text: 'unused' }));
    li.appendChild(meta);
    if (!f.missing) li.addEventListener('pointerdown', (ev) => dragSceneFromRail(ev, f));
    ul.appendChild(li);
  }
}

/**
 * Delete an unused scene's folder for good.
 *
 * The only destructive act in this rail, so it names what it destroys rather
 * than asking "are you sure?" — a scene folder holds the composition someone
 * wrote, its assets and every render, and none of it is in the undo stack.
 * Only scenes the play order does NOT reference are listed here, so this can
 * never pull a segment out from under the film.
 */
async function confirmDeleteSceneFolder(f) {
  const ok = await askToConfirm({
    title: `delete “${f.name ?? f.slug}”`,
    body: `Delete the scene folder ${f.slug} from disk — its composition, its assets and everything it has `
      + 'rendered?\n\nThis film does not play it, so the cut does not change. Nothing here is undoable, and the '
      + 'folder is not in the film’s history.',
    ok: 'delete the folder',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`${sceneApi(f.slug)}?deleteFiles=1`, { method: 'DELETE' });
    toast(`Deleted ${f.name ?? f.slug}.`, { kind: 'info' });
    await refresh();
    StudioUtil.shell()?.treeChanged();
  } catch (err) { toastError(err); }
}

/** Pointer-drag an unlisted scene row onto the timeline: a chip follows the
 *  cursor, an insert marker shows where the scene will land, release drops it. */
function dragSceneFromRail(ev, p) {
  ev.preventDefault();
  const chip = el('div', { class: 'drag-chip', text: `▶ ${p.name ?? p.slug}` });
  let started = false;
  let dropIndex = null;
  const startX = ev.clientX, startY = ev.clientY;
  const tl = $('#tl-scroll').getBoundingClientRect();

  const move = (e2) => {
    if (!started && Math.hypot(e2.clientX - startX, e2.clientY - startY) < 4) return;
    if (!started) { started = true; document.body.appendChild(chip); }
    chip.style.left = `${e2.clientX}px`;
    chip.style.top = `${e2.clientY}px`;
    const over = e2.clientX >= tl.left && e2.clientX <= tl.right && e2.clientY >= tl.top && e2.clientY <= tl.bottom;
    if (over) {
      const scenes = state.detail.scenes;
      const pointerFrame = frameOfEvent(e2);
      dropIndex = scenes.length;
      for (let i = 0; i < scenes.length; i++) {
        if (pointerFrame < scenes[i].filmOffset + (scenes[i].durationInFrames || 0) / 2) { dropIndex = i; break; }
      }
      showInsertMarker(dropIndex);
      chip.style.borderColor = 'var(--ok)';
    } else {
      dropIndex = null;
      $('#tl-insert')?.remove();
      chip.style.borderColor = 'var(--accent)';
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    chip.remove();
    $('#tl-insert')?.remove();
    if (started && dropIndex !== null) insertSceneAt(p.slug, dropIndex);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

async function insertSceneAt(slug, index) {
  if (state.film.scenes.some((s) => s.slug === slug)) {
    return toast('That scene is already in the play order — a scene plays once.', { kind: 'error' });
  }
  mutate((film) => {
    // Land inside whatever sequence surrounds the drop, so placing a scene in
    // the middle of "Opening" does not silently cut the band in three.
    const before = film.scenes[index - 1]?.sequence;
    const after = film.scenes[index]?.sequence;
    const sequence = before && before === after ? before : (after ?? before);
    film.scenes.splice(index, 0, { slug, ...(sequence ? { sequence } : {}) });
  }, { structural: true, silent: true });
  await waitForSaved(); // the save returns the recomputed layout
  renderAll();
}

async function createNewScene() {
  const name = await askForText({
    title: 'new scene',
    label: 'name',
    note: 'Resolution and fps come from the film, so every scene stays concat-compatible.',
    ok: 'create',
  });
  if (!name) return;
  try {
    await waitForSaved(); // the server appends to the play order it reads from disk
    await api(`/api/films/${fid}/scenes`, { method: 'POST', body: { name } });
    await refresh();
    toast('Scene created ✓ — appended to the play order', { kind: 'info' });
  } catch (err) { toastError(err); }
}
$('#btn-new-scene').addEventListener('click', createNewScene);

/**
 * Duplicate a scene into this film — composition, assets, vendored library
 * builds and settings, in ONE engine call. The hand recipe it replaces (new
 * scene → retype the config → copy the files → re-attach the assets) is what
 * leaves half-copied folders behind, and those are exactly the folders that
 * later show up in the rail as `unused` mysteries.
 *
 * The endpoint can clone into another film; the button deliberately does not.
 * Cross-film is the agent's move — in front of an open film, "give me another
 * one of these" is the ask, and a film picker would be UI for a rarer case.
 */
async function duplicateScene(slug, sourceName) {
  const name = await askForText({
    title: 'duplicate scene',
    label: 'name',
    note: `Copies “${sourceName ?? slug}” — composition, assets, vendored libraries and settings — and appends it to the play order.`,
    value: `${sourceName ?? slug} (copy)`,
    ok: 'duplicate',
  });
  if (!name) return;
  try {
    await waitForSaved(); // the server appends to the play order it reads from disk
    const clone = await api(`/api/films/${fid}/scenes/${encodeURIComponent(slug)}/clone`, {
      method: 'POST', body: { name },
    });
    await refresh();
    const n = clone.copied?.files ?? 0;
    toast(`Duplicated as “${clone.name}” ✓ — ${n} file${n === 1 ? '' : 's'} copied, appended to the play order`,
      { kind: 'info' });
    // A signature warning is not a failure — the copy happened — but it is the
    // human's to act on (update the clone, or keep the reframe), so it gets the
    // sticky toast rather than one that vanishes in five seconds.
    for (const w of clone.warnings ?? []) toast(w, { kind: 'error' });
  } catch (err) { toastError(err); }
}

/**
 * Collapse the film explorer. The rail's own `«` button is gone — a rail you
 * can drag to any width is that control with more of it — so the activity bar
 * is the one way to fold it away, which is also where the Explorer toggle lives
 * in the shell. This used to be a button the activity bar clicked by proxy.
 */
function toggleRail() {
  document.querySelector('.fe-frame').classList.toggle('rail-collapsed');
  syncExplorerIcon();
  fitPlayerBox();
}

/* ---- audio ---- */

/* One audition player for every picker: a second ▶ stops the first, and
 * closing the dialog stops it too. Without this the only way to know which of
 * eight `stable-audio3-bed-*.flac` was the right one was to place it on the
 * timeline, play the film, and undo. */
let pickAudition = null;
function stopPickAudition() {
  if (!pickAudition) return;
  pickAudition.el.pause();
  pickAudition.btn?.classList.remove('playing');
  if (pickAudition.btn) pickAudition.btn.textContent = '▶';
  // A video row grew to be watchable; it shrinks back to its poster.
  pickAudition.li?.classList.remove('auditioning');
  pickAudition = null;
}

/** m:ss, for a picker row that has just read its own metadata. */
function clockOf(seconds) {
  if (!Number.isFinite(seconds)) return '';
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}
for (const id of ['audio-dialog', 'overlay-dialog', 'footage-dialog']) {
  $(`#${id}`)?.addEventListener('close', stopPickAudition);
}

function auditionButton(a, li) {
  const btn = el('button', {
    class: 'pk-play', text: '▶', title: `listen to ${a.path.replace(/^assets\//, '')}`,
  });
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();                 // the row itself picks the file
    const mine = pickAudition?.btn === btn;
    stopPickAudition();
    if (mine) return;                     // second click = stop
    const audio = new Audio(assetUrl(a.path));
    audio.addEventListener('loadedmetadata', () => {
      li.querySelector('.pk-dur').textContent = clockOf(audio.duration);
    });
    audio.addEventListener('ended', stopPickAudition);
    audio.addEventListener('error', () => { toast(`Could not play ${a.path}`, { kind: 'error' }); stopPickAudition(); });
    audio.play().then(() => {
      btn.textContent = '■';
      btn.classList.add('playing');
      pickAudition = { el: audio, btn };
    }).catch(() => { /* autoplay policy: the click IS the gesture, so this is a real failure */ });
  });
  return btn;
}

/**
 * The picture a video row is about, and a way to watch it.
 *
 * A clip is the one asset kind that had neither: images showed a thumbnail and
 * audio auditioned, while a video offered a filename and a byte count — for
 * the one decision that has to be right first time, since footage joins the
 * cut unre-encoded and its frame count moves every scene after it. The poster
 * is a real frame (half a second in, because an export's frame 0 is usually
 * black), and the row reports the size and length it just read from the file.
 */
function videoPreviewRow(a, li) {
  const v = el('video', { class: 'pk-thumb pk-video', preload: 'metadata', playsinline: '' });
  v.muted = true;                 // a poster makes no noise; the ▶ unmutes it
  v.src = assetUrl(a.path);
  v.addEventListener('loadedmetadata', () => {
    // Seeking paints a frame; without it Chrome shows an empty box.
    try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { /* unseekable */ }
    li.querySelector('.pk-dur').textContent = clockOf(v.duration);
    if (!v.videoWidth) return;
    const size = `${v.videoWidth}×${v.videoHeight}`;
    // The dialog says footage must already match the film — so say whether
    // this one does, here, rather than after it is in the play order and the
    // plan reports a signature mismatch.
    const first = (state.detail?.scenes ?? []).find((s) => !s.missing && s.width);
    const fits = !first || (first.width === v.videoWidth && first.height === v.videoHeight);
    li.insertBefore(el('span', {
      class: `pk-badge${fits ? '' : ' err'}`,
      text: size,
      title: fits ? 'matches the film’s frame size' : `the film is ${first.width}×${first.height} — this would not join it as-is`,
    }), li.querySelector('.pk-meta'));
  });
  v.addEventListener('error', () => { li.querySelector('.pk-dur').textContent = '—'; });
  return v;
}

/** Watch a picker's clip in its own row, under the same one-at-a-time rule. */
function watchButton(a, li, video) {
  const btn = el('button', { class: 'pk-play', text: '▶', title: `watch ${a.path.replace(/^assets\//, '')}` });
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();                 // the row itself picks the file
    const mine = pickAudition?.btn === btn;
    stopPickAudition();
    if (mine) return;                     // second click = stop
    li.classList.add('auditioning');      // the poster grows into something watchable
    video.currentTime = 0;
    video.muted = false;
    video.play().then(() => {
      btn.textContent = '■';
      btn.classList.add('playing');
      pickAudition = { el: video, btn, li };
    }).catch(() => {
      li.classList.remove('auditioning');
      toast(`Could not play ${a.path}`, { kind: 'error' });
    });
  });
  video.addEventListener('ended', stopPickAudition);
  return btn;
}

function pickListForAssets(ulSel, kinds, onPick) {
  const ul = $(ulSel);
  stopPickAudition();
  ul.innerHTML = '';
  const files = state.assets.filter((a) => kinds.includes(a.kind));
  if (!files.length) {
    ul.innerHTML = '<li class="pick-empty">nothing here yet — upload a file above</li>';
    return;
  }
  for (const a of files) {
    const li = document.createElement('li');
    if (a.kind === 'image') li.appendChild(el('img', { class: 'pk-thumb', src: assetUrl(a.path) }));
    if (a.kind === 'audio') li.appendChild(auditionButton(a, li));
    let video = null;
    if (a.kind === 'video') {
      video = videoPreviewRow(a, li);
      li.append(video, watchButton(a, li, video));
    }
    li.append(
      el('span', { class: 'pk-name mono', text: a.path.replace(/^assets\//, '') }),
      el('span', { class: 'pk-dur mono dim', text: '' }),
      el('span', { class: 'pk-meta', text: a.bytes > 1e6 ? `${(a.bytes / 1e6).toFixed(1)} MB` : `${Math.round(a.bytes / 1e3)} kB` }),
    );
    // Clicking the row commits the file; while it is being watched that would
    // be a surprise, so the picture and its button only ever play it.
    // The row is handed to the picker too: it already holds a loaded thumbnail,
    // which is the cheapest place to learn an asset's real aspect.
    li.addEventListener('click', (ev) => {
      if (ev.target === video || ev.target.closest('.pk-play')) return;
      onPick(a, li);
    });
    ul.appendChild(li);
  }
}

function openAudioDialog() {
  const lane = takeLane('audio');
  pickListForAssets('#audio-pick', ['audio'], (a) => {
    mutate((film) => film.audio.push({
      id: uuid(), src: a.path, startInFrames: Math.round(state.playhead), gainDb: 0, lane,
    }));
    $('#audio-dialog').close();
    select({ kind: 'audio', id: state.film.audio[state.film.audio.length - 1].id });
  });
  $('#audio-dialog').showModal();
}

async function uploadInto(files, msgSel, afterUpload) {
  const msg = $(msgSel);
  for (const file of files) {
    msg.textContent = `uploading ${file.name}…`;
    try {
      const res = await fetch(`/api/films/${fid}/asset?path=${encodeURIComponent('assets/' + file.name)}`, { method: 'PUT', body: file });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || res.statusText);
      }
    } catch (err) {
      toastError(err);
    }
  }
  msg.textContent = '';
  await loadAssets();
  afterUpload();
}
$('#btn-audio-upload').addEventListener('click', () => $('#audio-file-input').click());
$('#audio-file-input').addEventListener('change', (e) => {
  if (e.target.files.length) uploadInto([...e.target.files], '#audio-upload-msg', () => pickListForAssets('#audio-pick', ['audio'], (a) => {
    mutate((film) => film.audio.push({ id: uuid(), src: a.path, startInFrames: Math.round(state.playhead), gainDb: 0, lane: takeLane('audio') }));
    $('#audio-dialog').close();
  }));
  e.target.value = '';
});
$('#btn-add-audio').addEventListener('click', openAudioDialog);

/* ---- overlays ---- */

/**
 * Add footage to the play order (v0.22).
 *
 * The frame count is READ FROM THE FILE rather than typed: it is what every
 * later offset is built on, and probe_asset already knows it. The user picking a
 * clip should not have to know its frame count, and a guessed one would shift
 * every subsequent scene, caption and cue.
 */
async function openFootageDialog() {
  pickListForAssets('#footage-pick', ['video'], async (a) => {
    const msg = $('#footage-upload-msg');
    msg.textContent = 'reading the file…';
    let frames = null;
    try {
      const probed = await api(`/api/films/${fid}/probe?path=${encodeURIComponent(a.path)}`);
      frames = probed?.video?.frames ?? null;
      if (!frames && probed?.video?.fps && probed?.durationSeconds) {
        frames = Math.round(probed.durationSeconds * probed.video.fps);
      }
    } catch { /* fall through to the note below */ }
    if (!frames) {
      msg.textContent = 'could not read the frame count — check ffprobe, or add it over MCP with an explicit durationInFrames';
      return;
    }
    msg.textContent = '';
    // Insert AFTER the segment the playhead is in, which is what "add here" means
    // on a timeline the user is scrubbing.
    const at = sceneAt(Math.round(state.playhead));
    const index = at.index >= 0 ? at.index + 1 : state.film.scenes.length;
    mutate((film) => {
      film.scenes.splice(index, 0, { footage: a.path, durationInFrames: frames });
    });
    $('#footage-dialog').close();
    select({ kind: 'scene', index });
  });
  $('#footage-dialog').showModal();
}
$('#btn-footage-upload').addEventListener('click', () => $('#footage-file-input').click());
$('#footage-file-input').addEventListener('change', (e) => {
  if (e.target.files.length) uploadInto([...e.target.files], '#footage-upload-msg', openFootageDialog);
  e.target.value = '';
});
$('#btn-add-footage').addEventListener('click', openFootageDialog);

/* ---- stills ---- */

/**
 * Put a still on the timeline (v0.28).
 *
 * Not a new kind of block — a SCENE that holds the picture, which is the whole
 * point: a still segment could only sit there, while a scene can be pushed in
 * on, cross-faded, or have type laid over it, and the author can open it. The
 * play order therefore gains an ordinary `{slug}` entry and nothing downstream
 * treats it specially. The engine does the work (`create_scene_from_image`);
 * this button is the convenience.
 *
 * The picker lists the WORKSPACE LIBRARY first, because that is where a
 * human's pictures actually live and it is shared across every film in the
 * workspace, then this film's own image assets. Upload puts a file in the
 * film's assets — same route as every other dialog here.
 */
function imageDefaultFrames() {
  return state.film?.sceneDefaults?.durationInFrames || 90;
}

function syncImageDurationHint() {
  const frames = Number($('#image-duration').value);
  $('#image-duration-hint').textContent = frames > 0 ? `frames — ${(frames / fps()).toFixed(1)}s` : 'frames';
}

async function openImageDialog() {
  const ul = $('#image-pick');
  const msg = $('#image-upload-msg');
  const dur = $('#image-duration');
  dur.value = String(imageDefaultFrames());
  syncImageDurationHint();
  ul.innerHTML = '<li class="pick-empty">reading the library…</li>';
  $('#image-dialog').showModal();

  const ws = String(filmId ?? '').split('/')[0];
  let library = [];
  // A missing or unreadable library is not an error here: the film's own
  // assets are still a complete answer, and an empty list says so.
  try { ({ files: library } = await api(`/api/workspaces/${encodeURIComponent(ws)}/library`)); }
  catch { library = []; }

  const items = [
    ...library.filter((f) => f.kind === 'image').map((f) => ({
      from: 'library',
      path: f.path,
      bytes: f.bytes,
      url: `/api/workspaces/${encodeURIComponent(ws)}/library/file?path=${encodeURIComponent(f.path)}`,
    })),
    ...state.assets.filter((a) => a.kind === 'image').map((a) => ({
      from: 'film', path: a.path, bytes: a.bytes, url: assetUrl(a.path),
    })),
  ];

  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="pick-empty">no images here yet — upload one above, '
      + 'or drop files in the workspace library</li>';
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.append(
      el('img', { class: 'pk-thumb', src: it.url, loading: 'lazy', alt: '' }),
      el('span', { class: 'pk-name mono', text: it.path.replace(/^assets\//, '') }),
      // Where it comes from is worth a badge: the library is shared across the
      // workspace, the film's assets are this film's alone.
      el('span', { class: 'pk-dur mono dim', text: it.from }),
      el('span', {
        class: 'pk-meta',
        text: it.bytes > 1e6 ? `${(it.bytes / 1e6).toFixed(1)} MB` : `${Math.round(it.bytes / 1e3)} kB`,
      }),
    );
    li.addEventListener('click', () => addImageScene(it));
    ul.appendChild(li);
  }
  msg.textContent = '';
}

async function addImageScene(pick) {
  const msg = $('#image-upload-msg');
  const frames = Number($('#image-duration').value);
  if (!(frames > 0)) { msg.textContent = 'give it a length in frames'; return; }
  msg.textContent = 'building the scene…';
  try {
    await waitForSaved(); // the server appends to the play order it reads from disk
    const made = await api(`/api/films/${fid}/scenes/from-image`, {
      method: 'POST',
      body: { image: pick.path, imageFrom: pick.from, durationInFrames: frames },
    });
    $('#image-dialog').close();
    await refresh();
    const index = state.film.scenes.findIndex((s) => s.slug === made.scene.split('/').pop());
    if (index >= 0) select({ kind: 'scene', index });
    toast(`“${made.name}” is on the timeline ✓ — ${made.config.durationInFrames} frames, `
      + `object-fit: ${made.fit.mode}. Render it before you build.`, { kind: 'info' });
    // Measured facts the human has to act on — transparency, an animated GIF —
    // get the sticky toast: the scene was built, and the decision is theirs.
    for (const w of made.warnings ?? []) toast(w, { kind: 'error' });
  } catch (err) {
    toastError(err);
  } finally {
    msg.textContent = '';
  }
}
$('#image-duration').addEventListener('input', syncImageDurationHint);
$('#btn-image-upload').addEventListener('click', () => $('#image-file-input').click());
$('#image-file-input').addEventListener('change', (e) => {
  if (e.target.files.length) uploadInto([...e.target.files], '#image-upload-msg', openImageDialog);
  e.target.value = '';
});
$('#btn-add-image').addEventListener('click', openImageDialog);

/** Margin from the frame edge, in percent, for a newly placed overlay. */
const OVERLAY_INSET_PCT = 4;

/**
 * Where a new overlay lands: the **bottom-right corner**, which is where a
 * face cam goes and the corner a viewer's eye is least often reading.
 *
 * `xPct`/`yPct` place the overlay's TOP-LEFT, so a bottom-right corner has to
 * be computed backwards through the asset's own aspect — the element is sized
 * by width and takes its height from the picture. Guessing that height is what
 * would leave a portrait overlay hanging off the bottom of the frame, so it is
 * read from the picker's already-loaded thumbnail, and falls back to the film's
 * aspect (which makes height% equal width%) only when nothing has loaded yet.
 */
function overlayStartBox(row) {
  const widthPct = 28;
  const media = row?.querySelector('img.pk-thumb, video.pk-video');
  const aw = media?.naturalWidth || media?.videoWidth || 0;
  const ah = media?.naturalHeight || media?.videoHeight || 0;
  const frame = state.detail?.scenes.find((s) => s.width > 0);
  const frameAspect = (frame?.width ?? 1920) / (frame?.height ?? 1080);
  const assetAspect = aw > 0 && ah > 0 ? aw / ah : frameAspect;
  const heightPct = widthPct * (frameAspect / assetAspect);
  return {
    widthPct,
    xPct: halfStep(clamp(100 - widthPct - OVERLAY_INSET_PCT, ...OVERLAY_BOUNDS.pos)),
    yPct: halfStep(clamp(100 - heightPct - OVERLAY_INSET_PCT, ...OVERLAY_BOUNDS.pos)),
  };
}

function openOverlayDialog() {
  const lane = takeLane('overlays');
  pickListForAssets('#overlay-pick', ['image', 'video'], (a, row) => {
    const box = overlayStartBox(row);
    mutate((film) => film.overlays.push({
      id: uuid(), src: a.path, lane,
      fromFrame: Math.round(state.playhead),
      toFrame: Math.min(Math.round(state.playhead) + fps() * 3, Math.max(totalFrames(), Math.round(state.playhead) + fps() * 3)),
      ...box, opacity: 1,
    }));
    $('#overlay-dialog').close();
    select({ kind: 'overlay', id: state.film.overlays[state.film.overlays.length - 1].id });
    updateLayers(state.playhead);
  });
  $('#overlay-dialog').showModal();
}
$('#btn-overlay-upload').addEventListener('click', () => $('#overlay-file-input').click());
$('#overlay-file-input').addEventListener('change', (e) => {
  if (e.target.files.length) uploadInto([...e.target.files], '#overlay-upload-msg', openOverlayDialog);
  e.target.value = '';
});
$('#btn-add-overlay').addEventListener('click', openOverlayDialog);

/* ---- captions ---- */

function addCaptionAtPlayhead() {
  const from = Math.round(state.playhead);
  const cap = { id: uuid(), text: 'Caption', fromFrame: from, toFrame: from + fps() * 3, lane: takeLane('captions') };
  mutate((film) => film.captions.push(cap));
  select({ kind: 'caption', id: cap.id });
  updateLayers(state.playhead);
  $('#insp-caption-text')?.focus();
  $('#insp-caption-text')?.select();
}
$('#btn-add-caption').addEventListener('click', addCaptionAtPlayhead);

/* ---- narration (TTS) ---- */

$('#btn-add-tts').addEventListener('click', async () => {
  $('#tts-msg').textContent = '';
  try {
    const rep = await api('/api/vendors?probe=0');
    const sel = $('#tts-vendor');
    sel.innerHTML = '';
    const active = rep.speech?.active;
    for (const v of rep.speech?.vendors ?? []) {
      sel.appendChild(el('option', { value: v.id, text: v.id === active ? `${v.id} (default)` : v.id }));
    }
    if (active) sel.value = active;
    loadTtsVoices();
  } catch { /* vendor list is a nicety */ }
  $('#tts-dialog').showModal();
});

async function loadTtsVoices() {
  const vendor = $('#tts-vendor').value;
  const dl = $('#tts-voice-list');
  dl.innerHTML = '';
  try {
    const { voices } = await api(`/api/vendors/speech/${vendor}/voices?limit=400`);
    for (const v of voices ?? []) {
      dl.appendChild(el('option', { value: v.shortName ?? v.name ?? String(v) }));
    }
  } catch { /* vendor unconfigured: leave the datalist empty */ }
}
$('#tts-vendor').addEventListener('change', loadTtsVoices);

$('#tts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#tts-text').value.trim();
  if (!text) return;
  const btn = $('#tts-generate');
  btn.disabled = true;
  $('#tts-msg').textContent = 'synthesizing…';
  try {
    const body = {
      text,
      vendor: $('#tts-vendor').value || undefined,
      voice: $('#tts-voice').value.trim() || undefined,
      rate: Number($('#tts-rate').value) || undefined,
      sentenceTimings: $('#tts-captions').checked,
    };
    const res = await api(`/api/films/${fid}/tts`, { method: 'POST', body });
    const at = Math.round(state.playhead);
    const label = text.split(/\s+/).slice(0, 4).join(' ');
    mutate((film) => {
      film.audio.push({ id: uuid(), src: res.assetPath, startInFrames: at, gainDb: 0, label });
      if ($('#tts-duckbed').checked) {
        for (const tr of film.audio) {
          if (tr.src !== res.assetPath && !/narration/.test(tr.src)) tr.duck = true;
        }
      }
      if ($('#tts-captions').checked && res.timings) {
        for (const tm of res.timings) {
          film.captions.push({
            id: uuid(), text: tm.text,
            fromFrame: at + tm.startInFrames,
            toFrame: at + tm.startInFrames + Math.max(tm.durationInFrames, Math.round(fps() * 0.8)),
          });
        }
      }
    });
    await loadAssets();
    $('#tts-msg').textContent = `✓ ${res.durationSeconds.toFixed(1)}s · peak ${res.peakDb ?? '?'} dBFS`;
    $('#tts-text').value = '';
    setTimeout(() => $('#tts-dialog').close(), 600);
  } catch (err) {
    $('#tts-msg').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* --------------------------------- build -------------------------------- */

/* The build panel lives in the right-side inspector column, not a modal —
 * you keep seeing (and can keep editing) the timeline while a build runs. */

$('#btn-build').addEventListener('click', () => {
  state.inspectorMode = 'build';
  renderInspector();
});

function renderBuildInspector(box) {
  const f = state.film, d = state.detail;
  const head = el('div', { class: 'insp-row', style: 'justify-content:space-between;align-items:center' },
    el('h3', { text: 'build film', style: 'margin:0' }),
    el('button', { class: 'ghost tiny-btn', text: '✕', title: 'back to properties', onclick: () => { state.inspectorMode = null; renderInspector(); } }));
  box.appendChild(head);

  const version = el('select', { id: 'bi-deliverable' });
  const masterScene = d.scenes.find((scene) => !scene.missing);
  version.appendChild(el('option', {
    value: '', text: `master · ${masterScene?.width ?? '?'}×${masterScene?.height ?? '?'}`,
  }));
  for (const deliverable of f.deliverables ?? []) {
    version.appendChild(el('option', {
      value: deliverable.id, text: `${deliverable.label ?? deliverable.id} · ${deliverable.width}×${deliverable.height}`,
    }));
  }
  box.appendChild(el('div', { class: 'insp-row' }, labelled('build version', version)));

  const name = el('input', { id: 'bi-filename', placeholder: 'film', spellcheck: 'false' });
  name.value = f.outputFilename ?? 'film';
  box.appendChild(el('div', { class: 'insp-row' }, labelled('output filename', name)));
  const targetNote = el('p', { id: 'bi-deliverable-note', class: 'dim note' });
  box.appendChild(targetNote);

  const target = el('select', { id: 'bi-target' });
  for (const [v, t] of [['', 'off — ship the gains as set'], ['-1', '−1 dBFS'], ['-2', '−2 dBFS (recommended)'], ['-3', '−3 dBFS'], ['-6', '−6 dBFS']]) {
    target.appendChild(el('option', { value: v, text: t }));
  }
  target.value = f.audioTargetPeakDb != null ? String(f.audioTargetPeakDb) : '-2';
  box.appendChild(el('div', { class: 'insp-row' }, labelled('master to peak', target)));

  const burn = el('input', { type: 'checkbox', id: 'bi-burn' });
  burn.checked = !!f.burnCaptions;
  burn.disabled = !f.captions.length;
  box.appendChild(el('label', { class: 'check' }, burn, document.createTextNode(' burn captions into the picture')));

  const bits = [
    `<b>${f.scenes.length}</b> scene${f.scenes.length === 1 ? '' : 's'} · <b>${timecode(d.totalFrames)}</b> · ${d.format ?? '?'}`,
    `${f.audio.length ? `master audio: <b>${f.audio.length}</b> track${f.audio.length === 1 ? '' : 's'}` : 'audio: per-scene (no master timeline)'}`,
    `${f.overlays.length ? `overlays: <b>${f.overlays.length}</b> (finishing pass re-encodes once)` : ''}`,
    `${f.captions.length ? `captions: <b>${f.captions.length}</b> → .srt sidecar${f.burnCaptions ? ' + burn-in' : ''}` : ''}`,
  ].filter(Boolean);
  const summary = el('p', { class: 'build-summary' });
  summary.innerHTML = bits.join('<br>');
  box.appendChild(summary);

  const go = el('button', { class: 'primary', id: 'bi-go', text: 'build master →', style: 'width:100%' });
  go.addEventListener('click', startBuild);
  box.appendChild(go);
  if ((f.deliverables ?? []).length) {
    const all = el('button', {
      class: 'ghost', id: 'bi-go-all', text: 'build master + all versions', style: 'width:100%;margin-top:7px',
    });
    all.addEventListener('click', startBuildAll);
    box.appendChild(all);
  }

  const syncBuildTarget = () => {
    const deliverable = deliverableById(f, version.value);
    const isVariant = !!deliverable;
    name.disabled = isVariant;
    name.value = isVariant ? deliverable.outputFilename : (f.outputFilename ?? 'film');
    targetNote.textContent = isVariant
      ? `${deliverable.label ?? deliverable.id} reuses the master edit, then applies its saved crop, caption style and safe-area review guide.`
      : 'The master preserves the completed scene layout. Choose a platform version to make a separately named reframe.';
    go.textContent = isVariant ? `build ${deliverable.label ?? deliverable.id} →` : 'build master →';
  };
  version.addEventListener('change', syncBuildTarget);
  syncBuildTarget();

  // Job card — same ids the poller writes into.
  const job = el('div', { class: 'job-card', id: 'build-job' });
  job.innerHTML =
    '<div class="job-line"><span id="bj-state" class="pill">—</span>' +
    '<span id="bj-phase" class="mono dim"></span><span id="bj-eta" class="mono dim"></span>' +
    '<button id="bj-cancel" class="ghost danger">cancel</button></div>' +
    '<div class="bar"><div id="bj-bar" class="bar-fill"></div></div>' +
    '<pre id="bj-logs" class="logs"></pre>' +
    '<div id="bj-levels" class="levels hidden"></div>' +
    '<section id="bj-review" class="output-review hidden" aria-live="polite"></section>' +
    '<a id="bj-download" class="download hidden" href="#">⤓ download film</a>';
  if (!state.buildJobId) job.classList.add('hidden');
  box.appendChild(job);
  $('#bj-cancel').addEventListener('click', () => {
    if (state.buildJobId) api(`/api/jobs/${state.buildJobId}/cancel`, { method: 'POST' }).catch(() => {});
  });
  if (state.lastBuild) updateBuildUI(state.lastBuild.status, state.lastBuild.logs);
}

function readBuildOptions() {
  return {
    outputFilename: $('#bi-filename').value.trim() || 'film',
    audioTargetPeakDb: $('#bi-target').value === '' ? null : Number($('#bi-target').value),
    burnCaptions: $('#bi-burn').checked,
  };
}

function buildRequestFor(deliverableId, options) {
  const body = {
    audioTargetPeakDb: options.audioTargetPeakDb,
    burnCaptions: options.burnCaptions,
  };
  if (deliverableId) body.deliverable = deliverableId;
  else body.outputFilename = options.outputFilename;
  return body;
}

function beginBuildJob(submitted, { watch = true } = {}) {
  state.buildJobId = submitted.jobId;
  state.lastBuild = null;
  $('#build-job')?.classList.remove('hidden');
  $('#bj-download')?.classList.add('hidden');
  $('#bj-levels')?.classList.add('hidden');
  const review = $('#bj-review');
  if (review) { review.classList.add('hidden'); review.replaceChildren(); review.dataset.reviewPath = ''; }
  if (watch) pollBuild();
}

async function startBuild() {
  try {
    const deliverableId = $('#bi-deliverable')?.value || null;
    const options = readBuildOptions();
    const submitted = await api(`/api/films/${fid}/build`, {
      method: 'POST', body: buildRequestFor(deliverableId, options),
    });
    if (!deliverableId) state.film.outputFilename = options.outputFilename;
    state.film.audioTargetPeakDb = options.audioTargetPeakDb;
    state.film.burnCaptions = options.burnCaptions;
    beginBuildJob(submitted);
  } catch (err) { toastError(err); }
}

async function waitForBuildCompletion(jobId) {
  for (;;) {
    const status = await api(`/api/jobs/${jobId}`);
    const { logs } = await api(`/api/jobs/${jobId}/logs?tail=12`);
    state.lastBuild = { status, logs };
    updateBuildUI(status, logs);
    if (['done', 'error', 'cancelled'].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

/** Build separate staged outputs in sequence. That preserves the normal job
 * queue limit even for a film with every allowed platform version selected. */
async function startBuildAll() {
  const options = { ...readBuildOptions(), outputFilename: state.film.outputFilename ?? 'film' };
  const targets = [null, ...(state.film.deliverables ?? []).map((item) => item.id)];
  const single = $('#bi-go');
  const all = $('#bi-go-all');
  if (single) single.disabled = true;
  if (all) all.disabled = true;
  clearInterval(state.buildPoll);
  state.buildPoll = null;
  try {
    for (const deliverableId of targets) {
      const submitted = await api(`/api/films/${fid}/build`, {
        method: 'POST', body: buildRequestFor(deliverableId, options),
      });
      beginBuildJob(submitted, { watch: false });
      const finished = await waitForBuildCompletion(submitted.jobId);
      if (finished.state !== 'done') {
        throw new Error(`Build failed: ${finished.error?.message ?? finished.state}`);
      }
    }
    state.film.outputFilename = options.outputFilename;
    state.film.audioTargetPeakDb = options.audioTargetPeakDb;
    state.film.burnCaptions = options.burnCaptions;
    toast(`${targets.length} deliveries built ✓`, { kind: 'info' });
  } catch (err) {
    toastError(err);
  } finally {
    if (single) single.disabled = false;
    if (all) all.disabled = false;
  }
}

/** Write the job status into the panel IF it is showing — the poll keeps
 *  running when the user switches the inspector back to a block's properties,
 *  and the header button always carries the live percent. */
function updateBuildUI(s, logs) {
  const bset = (sel, fn) => { const e = $(sel); if (e) fn(e); };
  bset('#bj-state', (e) => { e.textContent = s.state; e.className = `pill ${s.state}`; });
  bset('#bj-phase', (e) => { e.textContent = s.phase; });
  bset('#bj-eta', (e) => { e.textContent = s.etaMs != null ? `eta ${(s.etaMs / 1000).toFixed(0)}s` : ''; });
  bset('#bj-bar', (e) => { e.style.width = `${s.state === 'done' ? 100 : s.percent}%`; });
  if (logs) bset('#bj-logs', (e) => { e.textContent = logs.map((l) => `[${l.level}] ${l.message}`).join('\n'); });
  const running = !['done', 'error', 'cancelled'].includes(s.state);
  $('#btn-build').textContent = running ? `building ${s.percent ?? 0}%…` : 'build film →';
  if (s.state === 'done') {
    const file = s.outputPath.split(/[\\/]/).pop();
    bset('#bj-download', (e) => {
      e.classList.remove('hidden');
      e.textContent = `⤓ ${file}`;
      e.href = `/api/films/${fid}/output?file=${encodeURIComponent(file)}&download=1`;
    });
    if (s.audio) {
      bset('#bj-levels', (e) => {
        e.classList.remove('hidden');
        e.innerHTML = s.audio.clipping
          ? `<span class="clip">⚠ mix clipping: peak ${s.audio.peakDb} dBFS</span>`
          : `<span class="ok">mix ok</span> · peak ${s.audio.peakDb ?? '?'} dBFS · mean ${s.audio.meanDb ?? '?'} dBFS` +
            (s.audio.appliedOffsetDb != null ? ` · mastered ${s.audio.appliedOffsetDb > 0 ? '+' : ''}${s.audio.appliedOffsetDb} dB` : '');
      });
    }
    if (s.review) renderBuildReview(s.review);
  }
}

function deliveryFileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/).pop() ?? '';
}

function reviewOutputUrl(filePath) {
  return `/api/films/${fid}/output?file=${encodeURIComponent(deliveryFileName(filePath))}`;
}

/**
 * Read the persisted review record rather than trying to reconstruct warning
 * positions from the live timeline. The contact sheet is made from the staged
 * delivery, so this stays honest after an edit or a page reload.
 */
async function renderBuildReview(review) {
  const host = $('#bj-review');
  if (!host || !review?.reviewPath) return;
  if (host.dataset.reviewPath === review.reviewPath && host.dataset.loaded === 'true') return;
  if (host.dataset.reviewPath === review.reviewPath && host.dataset.loading === 'true') return;

  const requestId = ++reviewRequestId;
  host.dataset.reviewPath = review.reviewPath;
  host.dataset.loading = 'true';
  host.dataset.loaded = '';
  host.classList.remove('hidden');
  host.replaceChildren(el('p', { class: 'review-loading dim', text: 'loading output review…' }));
  try {
    const report = await api(reviewOutputUrl(review.reviewPath));
    if (requestId !== reviewRequestId || host !== $('#bj-review')) return;

    host.replaceChildren();
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    const heading = el('div', { class: 'review-head' },
      el('strong', { text: 'output review' }),
      el('span', {
        class: `review-count ${warnings.some((warning) => warning.level === 'block') ? 'block' : ''}`,
        text: warnings.length ? `${warnings.length} finding${warnings.length === 1 ? '' : 's'}` : 'clear',
      }),
    );
    host.appendChild(heading);

    const figure = el('div', { class: 'review-contact' });
    const contact = report.contact ?? {};
    const image = el('img', {
      src: reviewOutputUrl(review.contactPath ?? contact.filename),
      alt: 'Contact sheet for the delivered film',
      loading: 'lazy',
    });
    figure.appendChild(image);
    const grid = el('div', { class: 'review-thumb-grid' });
    grid.style.gridTemplateColumns = `repeat(${Math.max(1, Number(contact.columns) || 1)}, minmax(0, 1fr))`;
    const warningsForFrame = (frame) => warnings.filter((warning) => {
      if (!Number.isInteger(warning.frame)) return false;
      const end = warning.frame + Math.max(1, Number(warning.durationFrames) || 1);
      return frame >= warning.frame && frame < end;
    });
    for (const thumb of contact.thumbnails ?? []) {
      const finding = warningsForFrame(thumb.frame);
      const label = [
        `f${thumb.frame}`,
        thumb.context?.name ?? thumb.context?.footage ?? thumb.context?.scene,
        thumb.captionOnset ? 'caption' : '',
      ].filter(Boolean).join(' · ');
      const cell = el('div', {
        class: `review-thumb${finding.length ? ' has-warning' : ''}`,
        title: [label, ...finding.map((warning) => warning.message)].filter(Boolean).join('\n'),
      }, el('span', { class: 'review-thumb-label', text: label }));
      for (const warning of finding) {
        cell.appendChild(el('span', { class: `review-thumb-badge ${warning.level}`, text: warning.code }));
      }
      grid.appendChild(cell);
    }
    figure.appendChild(grid);
    host.appendChild(figure);

    const facts = el('p', {
      class: 'review-facts dim',
      text: `${report.delivery?.actualFrames ?? '?'} / ${report.delivery?.expectedFrames ?? '?'} frames · ${contact.thumbnails?.length ?? 0} review frames${contact.truncated ? ' (sampled)' : ''}`,
    });
    host.appendChild(facts);
    if (warnings.length) {
      const list = el('ul', { class: 'review-warning-list' });
      for (const warning of warnings) {
        list.appendChild(el('li', { class: warning.level ?? 'info' },
          el('span', { class: 'review-warning-code', text: warning.code }),
          document.createTextNode(warning.message),
        ));
      }
      host.appendChild(list);
    }
    host.dataset.loaded = 'true';
  } catch (err) {
    if (requestId !== reviewRequestId || host !== $('#bj-review')) return;
    host.replaceChildren(el('p', { class: 'review-loading err', text: `Output review could not be opened: ${err.message}` }));
  } finally {
    if (requestId === reviewRequestId && host === $('#bj-review')) delete host.dataset.loading;
  }
}

function pollBuild() {
  clearInterval(state.buildPoll);
  const poll = async () => {
    try {
      const s = await api(`/api/jobs/${state.buildJobId}`);
      const { logs } = await api(`/api/jobs/${state.buildJobId}/logs?tail=12`);
      state.lastBuild = { status: s, logs };
      updateBuildUI(s, logs);
      if (['done', 'error', 'cancelled'].includes(s.state)) {
        clearInterval(state.buildPoll);
        state.buildPoll = null;
        if (s.state === 'done') toast('Film assembled ✓', { kind: 'info' });
        if (s.state === 'error') toastError(new Error(`Build failed: ${s.error?.message ?? 'unknown'}`));
      }
    } catch {
      clearInterval(state.buildPoll);
      state.buildPoll = null;
    }
  };
  poll();
  state.buildPoll = setInterval(poll, 700);
}

/* ------------------------------------------------------------------------ */
/* The production loop: tree, advice, versions, deliveries                   */
/*                                                                           */
/* Motion Studio is AI-directed and human-advised. Everything below is the    */
/* human's half of that: see what the AI made, say what is wrong in plain     */
/* language, and read what it did about it. Nothing here approves, claims,    */
/* promotes or blocks — asking for an older take is advice too.               */
/* ------------------------------------------------------------------------ */

const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return (Date.now() - d.getTime()) < 86400000
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Internal advice state → the four words the human actually needs. */
function humanAdviceStatus(a) {
  if (a.status === 'open') return { cls: 'sent', label: 'advice sent' };
  if (a.status === 'acknowledged') return { cls: 'received', label: 'AI received it' };
  if (a.status === 'working') return { cls: 'working', label: 'AI is working on it' };
  if (a.status === 'needs-clarification') return { cls: 'question', label: 'AI needs more information' };
  // A withdrawn item was never the AI's to answer — saying "AI reviewed it"
  // would credit a decision nobody made.
  if (a.resolution?.withdrawnByHuman) return { cls: 'reviewed', label: 'you withdrew this' };
  const outcome = a.resolution?.outcome;
  return (outcome === 'applied' || outcome === 'partially-applied')
    ? { cls: 'done', label: 'updated' }
    : { cls: 'reviewed', label: 'AI reviewed it' };
}

const unresolvedCount = (pred) => (state.advice ?? []).filter((a) => a.status !== 'resolved' && pred(a)).length;

/** Which advice belongs to this timeline segment — slug for scenes, id for clips. */
function segmentAdviceMatcher(seg) {
  if (seg.kind === 'footage') return (a) => a.target?.type === 'footage' && a.target.itemId === seg.id;
  return (a) => a.target?.type === 'scene' && a.target.scene === seg.slug;
}

/** Which advice belongs to one timeline row — family plus its index. */
function laneAdviceMatcher(family, li = 0) {
  const lane = SINGLE_ROW_FAMILIES.includes(family) ? 0 : li;
  return (a) => a.target?.type === 'lane' && a.target.family === family && (a.target.lane ?? 0) === lane;
}

function adviceBadge(n) {
  const b = document.createElement('span');
  b.className = 'adv-badge';
  b.textContent = String(n);
  b.title = `${n} unresolved piece${n === 1 ? '' : 's'} of advice`;
  return b;
}

/** Where a piece of advice sits on the film, if it can be placed at all. */
function adviceFilmFrame(a) {
  if (a.observation?.filmFrame != null) return a.observation.filmFrame;
  if (a.target?.filmFrame != null) return a.target.filmFrame;
  const segs = state.detail?.scenes ?? [];
  const seg = a.target?.type === 'scene' ? segs.find((s) => s.slug === a.target.scene)
    : a.target?.type === 'footage' ? segs.find((s) => s.id === a.target.itemId)
      : a.target?.type === 'sequence' ? segs.find((s) => s.sequence === a.target.sequence)
        : null;
  if (seg) return (seg.filmOffset ?? 0) + (a.target?.sceneFrame ?? 0);
  const item = a.target?.itemId
    ? [...(state.film?.audio ?? []), ...(state.film?.captions ?? []), ...(state.film?.overlays ?? [])]
      .find((x) => x.id === a.target.itemId)
    : null;
  if (item) return item.startInFrames ?? item.fromFrame ?? 0;
  return null;
}

/* ------------------------------ status line ----------------------------- */

function renderProductionLine() {
  const box = $('#production-line');
  if (!box) return;
  const s = state.status;
  if (!s) { box.textContent = ''; box.className = 'sb-item fe-production mono'; return; }
  const live = (s.activity ?? []).filter((a) => !a.stale);
  let cls = 'idle';
  let text;
  if (live.length) {
    cls = 'live';
    text = `${live[0].activity}${live.length > 1 ? ` (+${live.length - 1})` : ''}`;
  } else if ((s.advice?.unresolved ?? 0) > 0) {
    cls = 'pending';
    text = `${s.advice.unresolved} advice waiting for the next AI run`;
  } else if (!s.currentDelivery) {
    text = 'no film built yet';
  } else if (s.newerWorkThanDelivery) {
    cls = 'pending';
    text = 'newer work awaits a film build';
  } else {
    text = 'waiting for the next AI run';
  }
  box.className = `sb-item fe-production mono ${cls}`;
  box.innerHTML = '<span class="dot"></span>';
  box.appendChild(document.createTextNode(text));
  StudioUtil.syncDocument();
}

function renderUpdatedBanner() {
  const stale = state.latestDeliveryId && state.pinnedDelivery && state.latestDeliveryId !== state.pinnedDelivery;
  $('#film-updated')?.classList.toggle('hidden', !(stale && !state.updatedDismissed));
  const tag = $('#delivery-tag');
  if (!tag) return;
  if (state.source !== 'delivery' || !state.manifest) { tag.classList.add('hidden'); return; }
  tag.classList.remove('hidden');
  const parts = [`built ${fmtWhen(state.manifest.createdAt)}`];
  if (state.pinnedDelivery !== state.latestDeliveryId) parts.push('pinned · a newer build exists');
  if (deliveryIsStale()) parts.push(`the cut has changed since (${state.manifest.totalFrames}f built → ${state.detail?.totalFrames ?? '?'}f now)`);
  tag.textContent = parts.join(' · ');
  tag.classList.toggle('warn', deliveryIsStale());
}

/* --------------------------------- tree --------------------------------- */

/**
 * Film → Sequence → Scene/Footage. It is the same play order the timeline
 * draws, read vertically: the human picks a thing here or there and both
 * highlight, because both are views of `film.scenes[]`.
 */
/**
 * The film tree's keyboard (U-10). `#fe-tree` has carried
 * `role="tree" aria-label="film structure"` since it was built, while every row
 * under it was a plain `div` — so it announced as **a tree containing nothing**.
 * The role was added in good faith and never finished; this finishes it.
 *
 * Rows activate on `pointerdown` rather than `click` (selection has to beat the
 * timeline's own drag), so `Enter` dispatches a `pointerdown` — the same
 * listener the pointer reaches, rather than a second copy of what selecting
 * does. The delegated handler on `#fe-tree` is `dblclick` only, so nothing
 * double-fires.
 */
const filmTreeNav = StudioUtil.treeNav($('#fe-tree'), {
  rows: () => [...$('#fe-tree').querySelectorAll('.tree-row')],
  level: (row) => (row.classList.contains('tree-film') ? 1
    : row.classList.contains('tree-seq') ? 2 : 3),
  expanded: (row) => (row.classList.contains('tree-seq')
    ? row.dataset.collapsed !== 'true'
    : null),
  toggle: (row) => row.querySelector('.tree-twist')
    ?.dispatchEvent(new Event('pointerdown', { bubbles: true })),
  open: (row) => row.dispatchEvent(new Event('pointerdown', { bubbles: true })),
  key: (row) => row.dataset.key ?? '',
});

function renderTree() {
  const box = $('#fe-tree');
  if (!box || !state.detail) return;
  filmTreeNav.capture();   // before the wipe — see treeNav()
  box.innerHTML = '';
  const sel = state.selection;

  // The film itself is a target, not just the absence of one: "the whole thing
  // is too slow" is advice, and before this the only way to say it was to press
  // advise with nothing selected — which armed a targeting click instead.
  //
  // Highlighted only when it was actually picked. The inspector still shows the
  // film when nothing is selected (there is nothing narrower to show), but that
  // state is *not* the film selected: pressing advise in it arms a targeting
  // click, and a row lit the same way in both would make that a coin toss.
  const rootRow = el('div', {
    class: `tree-row tree-film${sel?.kind === 'film' ? ' selected' : ''}`,
    title: 'the whole film — click to select it, then ✎ advise to tell the AI about it',
    onpointerdown: () => select({ kind: 'film' }),
  },
  el('span', { class: 'tree-twist', text: '▾' }),
  el('span', { class: 'tree-name', text: state.film?.name ?? 'film' }),
  el('span', { class: 'tree-meta mono', text: state.detail.totalFrames ? timecode(state.detail.totalFrames) : '—' }));
  rootRow.dataset.key = 'film';
  const filmAdvice = unresolvedCount((a) => a.target?.type === 'film');
  if (filmAdvice) rootRow.appendChild(adviceBadge(filmAdvice));
  box.appendChild(rootRow);

  for (const band of sequenceBands()) {
    const key = band.label ?? `__anon-${band.from}`;
    const collapsed = state.collapsedSequences.has(key);
    const bandRow = el('div', {
      class: `tree-row tree-seq${band.label ? '' : ' anon'}`
        + `${sel?.kind === 'sequence' && sel.sequence === band.label ? ' selected' : ''}`,
    });
    bandRow.dataset.key = `seq:${key}`;
    bandRow.dataset.collapsed = String(collapsed);
    bandRow.appendChild(el('span', {
      class: 'tree-twist',
      text: collapsed ? '▸' : '▾',
      onpointerdown: (ev) => {
        ev.stopPropagation();
        if (collapsed) state.collapsedSequences.delete(key); else state.collapsedSequences.add(key);
        renderTree();
      },
    }));
    bandRow.appendChild(el('span', { class: 'tree-name', text: band.label ?? 'not in a sequence' }));
    bandRow.appendChild(el('span', { class: 'tree-meta mono', text: `${band.segments.length}` }));
    // Same gesture as its band on the timeline: double-click zooms to it. A
    // *labelled* row is repainted by the selection its first click makes, so
    // that case is caught by the delegated handler on #fe-tree; this one is
    // what an anonymous run (which never selects) still gets.
    bandRow.addEventListener('dblclick', () => zoomToRange(band.offset, band.frames));
    if (band.label) {
      const n = unresolvedCount((a) => a.target?.type === 'sequence' && a.target.sequence === band.label);
      if (n) bandRow.appendChild(adviceBadge(n));
      bandRow.title = `${state.film?.sequences?.[band.label]?.intent ?? 'a narrative sequence'}`
        + '\n(double-click to zoom the timeline to it)';
      bandRow.addEventListener('pointerdown', () => {
        select({ kind: 'sequence', sequence: band.label });
        stopPlayback();
        setPlayhead(band.offset);
      });
    }
    box.appendChild(bandRow);
    if (collapsed) continue;

    for (let i = band.from; i <= band.to; i++) {
      const seg = state.detail.scenes[i];
      if (!seg) continue;
      const footage = seg.kind === 'footage';
      const ready = footage ? !seg.missing : seg.rendered;
      const row = el('div', {
        class: `tree-row tree-seg${footage ? ' footage' : ''}${ready ? '' : ' unready'}`
          + `${sel?.kind === 'scene' && sel.index === i ? ' selected' : ''}`,
        onpointerdown: () => {
          select({ kind: 'scene', index: i });
          stopPlayback();
          setPlayhead(seg.filmOffset ?? 0);
        },
      },
      // The Explorer's mark, said the same way here: shape is the kind (◧ a
      // scene, ▦ supplied footage), colour is whether it is ready. It was a
      // bare dot, which carried the colour but named nothing.
      el('span', {
        class: 'tree-kind', text: footage ? '▦' : '◧', role: 'img',
        'aria-label': footage
          ? (seg.missing ? 'footage, missing' : 'footage')
          : (seg.rendered ? 'scene, rendered' : 'scene, not rendered yet'),
      }),
      el('span', { class: 'tree-name', text: seg.missing ? `⚠ ${seg.slug ?? seg.footage}` : seg.name }),
      el('span', { class: 'tree-meta mono', text: `${seg.durationInFrames ?? 0}f` }));
      row.dataset.key = `seg:${i}`;
      row.title = footage
        ? `footage — ${seg.footage}`
        : `${seg.slug}${seg.rendered ? '' : ' — not rendered yet'}`;
      const n = unresolvedCount(segmentAdviceMatcher(seg));
      if (n) row.appendChild(adviceBadge(n));
      const revs = footage ? null : state.revisions[seg.slug];
      if (revs?.count > 1) {
        row.appendChild(el('span', { class: 'tree-vers mono', text: `v${revs.count}`, title: `${revs.count} archived takes` }));
      }
      // Duplicate, beside the take count: both answer "I want another one of
      // these". Footage has nothing to clone (it is a supplied file, not a
      // folder), and a missing scene has nothing to copy from.
      if (!footage && !seg.missing) {
        row.appendChild(el('button', {
          class: 'tree-dup', text: '⧉',
          title: 'duplicate this scene into this film — composition, assets, libraries and settings',
          // The row itself selects on pointerdown, so the button has to claim
          // the gesture before the row hears it.
          onpointerdown: (ev) => ev.stopPropagation(),
          onclick: (ev) => { ev.stopPropagation(); duplicateScene(seg.slug, seg.name); },
        }));
      }
      box.appendChild(row);
    }
  }
  filmTreeNav.sync();
}

/* ------------------------- inspector: shared bits ----------------------- */

const itemLabel = (kind, item) => {
  if (!item) return '(gone)';
  if (kind === 'audio') return item.label ?? item.src?.split('/').pop() ?? 'audio';
  if (kind === 'caption') return `“${String(item.text ?? '').slice(0, 48)}”`;
  return item.src?.split('/').pop() ?? 'overlay';
};

function renderSequenceInspector(box, label) {
  const band = sequenceBands().find((b) => b.label === label);
  box.appendChild(inspectorTabStrip('sequence'));
  if (state.tab.sequence === 'advice') return renderAdviceTab(box);
  box.appendChild(el('h3', { text: 'sequence' }));

  // The name is a field, not a heading with a "rename…" button beside it that
  // opened a dialog to edit one string. It is also where a just-created
  // sequence puts the caret, which is what replaces the dialog that used to
  // ask for the name before the band existed.
  const nameInput = el('input', { id: 'insp-seq-name', spellcheck: 'false', maxlength: '80' });
  nameInput.value = label;
  const commit = () => {
    if (nameInput.value.trim() === label) { nameInput.value = label; return; }
    if (!renameSequence(label, nameInput.value)) nameInput.value = label;
  };
  nameInput.addEventListener('change', commit);
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); nameInput.blur(); }
    else if (ev.key === 'Escape') { nameInput.value = label; nameInput.blur(); }
    ev.stopPropagation();   // Delete/Backspace here edit text, they do not ungroup
  });
  box.appendChild(el('div', { class: 'insp-row' }, labelled('name', nameInput)));
  if (state.namingSequence === label) {
    // Deferred, because creating renders the inspector twice — once from
    // `select`, once from `renderAll` — and focusing the first pass's field
    // would put the caret in a node the second pass throws away. The flag is
    // cleared by whichever pass is still attached when the microtasks run.
    queueMicrotask(() => {
      if (!nameInput.isConnected || state.namingSequence !== label) return;
      state.namingSequence = null;
      nameInput.focus();
      nameInput.select();
    });
  }

  if (!band) {
    box.appendChild(el('p', { class: 'dim note', text: 'This sequence no longer has any segments.' }));
    return;
  }
  const dl = el('dl', { class: 'insp-facts' });
  const fact = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
  fact('segments', String(band.segments.length));
  fact('starts at', timecode(band.offset));
  fact('length', `${band.frames}f · ${timecode(band.frames)}`);
  box.appendChild(dl);

  const ta = el('textarea', {
    rows: '2', maxlength: '500',
    placeholder: 'What is this sequence for? (the AI reads it)',
  });
  ta.value = state.film?.sequences?.[label]?.intent ?? '';
  ta.addEventListener('change', () => mutate((film) => {
    const meta = { ...(film.sequences ?? {}) };
    const text = ta.value.trim();
    meta[label] = text ? { intent: text.slice(0, 500) } : {};
    film.sequences = meta;
  }, { silent: true }));
  box.appendChild(labelled('intent', ta));
  const row = el('div', { class: 'insp-row' });
  row.appendChild(el('button', { class: 'ghost danger', text: 'ungroup', onclick: () => ungroupSequence(label) }));
  box.appendChild(row);
  box.appendChild(el('p', {
    class: 'dim note',
    text: 'Drag this band’s edges on the timeline to change which segments are in it. '
      + 'Ungroup returns them to unnamed film — ready to be drawn over again — and removes nothing else.',
  }));
}

/* ------------------------------ lane inspector --------------------------- */

/**
 * A whole row of the timeline. It has no properties of its own — a lane is a
 * place, not a stored object — so this panel is what the row currently holds
 * and the two things you can do to it, above the advice section that is the
 * reason a lane is selectable at all: "every caption is a beat late" is one
 * sentence about a row, not one sentence per clip.
 */
function renderLaneInspector(box, sel) {
  box.appendChild(inspectorTabStrip('lane'));
  if (state.tab.lane === 'advice') return renderAdviceTab(box);
  const { family } = sel;
  const li = SINGLE_ROW_FAMILIES.includes(family) ? 0 : sel.lane;
  const label = laneLabel(family, li);
  box.appendChild(el('h3', { text: 'lane' }));

  const dl = el('dl', { class: 'insp-facts' });
  const fact = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
  fact('row', label);
  fact(family === 'sequences' ? 'sequences' : family === 'scenes' ? 'segments' : 'items', String(laneContents(family, li)));
  if (family === 'audio') fact('sound', isLaneMuted(li) ? 'muted' : 'in the mix');
  if (!SINGLE_ROW_FAMILIES.includes(family)) fact('of', `${laneRows(family).length} ${family} lane${laneRows(family).length === 1 ? '' : 's'}`);
  box.appendChild(dl);

  if (family === 'audio') {
    box.appendChild(el('div', { class: 'insp-row' }, el('button', {
      class: 'ghost',
      text: isLaneMuted(li) ? 'unmute this lane' : 'mute this lane',
      title: 'muting takes every clip in this row out of the mix, the build and the preview',
      onclick: () => toggleLaneMute(li),
    })));
  }
  box.appendChild(el('p', {
    class: 'dim note',
    text: SINGLE_ROW_FAMILIES.includes(family)
      ? 'Advice on this row is about the whole stack of them, not one block — “the cuts are all a beat late”.'
      : 'Advice on this row is about everything in it, and stays with the row as its clips change. '
        + 'The head’s buttons add to it, mute it, or remove it when it is empty.',
  }));
}

/* ---------------------------- versions section --------------------------- */

/**
 * Every promoted render is archived, so a scene has takes. Previewing one
 * changes nothing; asking for one back is ADVICE — Studio never repoints
 * production, because that decision is the director's.
 */
function renderVersionsSection(box, { lead = false } = {}) {
  const sel = state.selection;
  if (sel?.kind !== 'scene') return;
  const seg = state.detail?.scenes?.[sel.index];
  if (!seg || seg.kind === 'footage' || seg.missing) return;
  const summary = state.revisions[seg.slug];
  if (!summary?.count) return;

  // The rule separates this from what came before it. At the top of its own
  // tab there is nothing before it to separate from.
  if (!lead) box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('h3', { text: `versions · ${summary.count}` }));
  const list = state.sceneRevisions.get(seg.slug);
  if (!list) {
    box.appendChild(el('p', { class: 'dim note', text: 'loading takes…' }));
    loadSceneRevisions(seg.slug);
    return;
  }
  const strip = el('div', { class: 'rev-strip' });
  for (const rev of list) {
    const card = el('div', {
      class: `rev-card${state.watchingRevision?.revision?.id === rev.id ? ' playing' : ''}`,
    });
    const thumb = el('div', {
      class: 'rev-thumb',
      title: 'watch this take in the player (changes nothing)',
      onclick: () => watchRevision(seg.slug, rev),
    });
    if (rev.hasContactSheet) {
      const img = el('img', { loading: 'lazy', src: `${sceneApi(seg.slug)}/revisions/${encodeURIComponent(rev.id)}/contact` });
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el('span', { class: 'no-thumb', text: '▶' }));
    }
    card.appendChild(thumb);
    const body = el('div', { class: 'rev-body' });
    const badges = el('div', { class: 'rev-badges' });
    if (rev.current) badges.appendChild(el('span', { class: 'rev-badge current', text: 'in the film' }));
    if (rev.adviceIds?.length) badges.appendChild(el('span', { class: 'rev-badge', text: 'answers advice' }));
    body.appendChild(badges);
    if (rev.note) body.appendChild(el('div', { class: 'rev-note', text: rev.note }));
    body.appendChild(el('div', { class: 'rev-meta mono', text: `${fmtWhen(rev.createdAt)}${rev.agent ? ` · ${rev.agent}` : ''} · ${rev.frames}f` }));
    if (!rev.current) {
      body.appendChild(el('button', {
        class: 'ghost',
        text: 'ask AI to use this',
        title: 'sends advice naming this exact take — the AI decides, and answers with its reasoning',
        onclick: (ev) => askForRevision(seg.slug, rev, ev.currentTarget),
      }));
    }
    card.appendChild(body);
    strip.appendChild(card);
  }
  box.appendChild(strip);
  if (state.watchingRevision?.slug === seg.slug) {
    const back = el('button', {
      class: 'ghost', text: '↩ back to the take in the film',
      onclick: () => { state.watchingRevision = null; renderInspector(); setPlayhead(state.playhead); },
    });
    box.appendChild(back);
  }
}

async function loadSceneRevisions(slug) {
  try {
    const { revisions } = await api(`${sceneApi(slug)}/revisions`);
    state.sceneRevisions.set(slug, revisions);
  } catch {
    state.sceneRevisions.set(slug, []);
  }
  if (state.selection?.kind === 'scene' && state.detail?.scenes?.[state.selection.index]?.slug === slug) renderInspector();
}

function watchRevision(slug, rev) {
  state.watchingRevision = rev.current ? null : { slug, revision: rev };
  const seg = (state.detail?.scenes ?? []).find((s) => s.slug === slug);
  stopPlayback();
  if (seg) setPlayhead(seg.filmOffset ?? 0);
  renderInspector();
  setPlayhead(state.playhead);
}

async function askForRevision(slug, rev, btn) {
  btn.disabled = true;
  try {
    await api(`${sceneApi(slug)}/revisions/${encodeURIComponent(rev.id)}/prefer`, { method: 'POST', body: {} });
    btn.textContent = '✓ asked the AI';
    await loadOverview();
    renderTree();
    renderTimeline();
  } catch (err) {
    btn.disabled = false;
    toastError(err);
  }
}

/* ----------------------------- advice section ---------------------------- */

/** Which advice belongs to the current selection. */
function adviceScope() {
  const sel = state.selection;
  if (filmIsSelected()) return { name: 'this film', pred: () => true };
  if (sel.kind === 'lane') {
    // The row, plus what is standing in it: advice on a clip IS advice about
    // that lane as far as reading the conversation goes, and splitting the two
    // would hide the caption note from the caption lane that carries it.
    const li = SINGLE_ROW_FAMILIES.includes(sel.family) ? 0 : sel.lane;
    const onRow = laneAdviceMatcher(sel.family, li);
    const members = new Set(SINGLE_ROW_FAMILIES.includes(sel.family)
      ? []
      : (laneRows(sel.family)[li] ?? []).map((it) => it.id));
    return {
      name: `the ${laneLabel(sel.family, li)} lane`,
      pred: (a) => onRow(a) || (a.target?.itemId ? members.has(a.target.itemId) : false),
    };
  }
  if (sel.kind === 'sequence') {
    const members = new Set(sequenceBands().find((b) => b.label === sel.sequence)?.segments.map((s) => s.slug ?? s.id) ?? []);
    return {
      name: `sequence “${sel.sequence}”`,
      pred: (a) => (a.target?.type === 'sequence' && a.target.sequence === sel.sequence)
        || members.has(a.target?.scene) || members.has(a.target?.itemId),
    };
  }
  if (sel.kind === 'scene') {
    const seg = state.detail?.scenes?.[sel.index];
    if (!seg) return { name: 'this film', pred: () => true };
    return { name: seg.name ?? seg.slug, pred: segmentAdviceMatcher(seg) };
  }
  // Named, not "this item": the scope line is the first thing the advice tab
  // says, and it has to be checkable against what you think you clicked.
  const key = { audio: 'audio', caption: 'captions', overlay: 'overlays' }[sel.kind];
  const item = key ? (state.film?.[key] ?? []).find((x) => x.id === sel.id) : null;
  // A caption's label already carries its own quotes — it IS the words.
  const label = item ? itemLabel(sel.kind, item) : null;
  const named = label && sel.kind !== 'caption' ? `“${label}”` : label;
  return {
    name: named ? `${sel.kind} ${named}` : 'this item',
    pred: (a) => a.target?.itemId === sel.id,
  };
}

function renderAdviceSection(box, { lead = false } = {}) {
  const scope = adviceScope();
  const scoped = (state.advice ?? []).filter(scope.pred);
  const open = scoped.filter((a) => a.status !== 'resolved');
  const openAnywhere = (state.advice ?? []).filter((a) => a.status !== 'resolved');
  if (!lead) box.appendChild(el('hr', { class: 'sep' }));
  // No advise button here. The toolbar's is the same call on the same
  // selection, it never moves, and it names its target — a second one two
  // hundred pixels away was a duplicate, not a convenience. The empty state
  // below names the gesture instead, which is what a first-time reader needs.
  box.appendChild(el('div', { class: 'adv-head-row' },
    el('h3', { text: open.length ? `advice · ${open.length} open` : 'advice' })));
  const scopeRow = el('div', { class: 'adv-scope-row' },
    el('span', { class: 'mono dim adv-scope', text: `on ${scope.name}` }));
  // This panel is one target's share of the conversation. The way out to the
  // whole of it belongs here, next to the words that say how narrow it is —
  // and in the same place whether or not this selection happens to hold all of
  // it, so it is somewhere the eye can learn.
  if ((state.advice ?? []).length) {
    scopeRow.appendChild(el('button', {
      class: 'linkish adv-see-all',
      text: `all advice (${state.advice.length}) →`,
      title: 'open the advice board — every piece of advice on this film, grouped by what it is about (Shift+A)',
      onclick: openAdviceBoard,
    }));
  }
  box.appendChild(scopeRow);

  if (scoped.length) {
    const ul = el('ul', { class: 'adv-list' });
    for (const a of scoped) ul.appendChild(adviceCard(a));
    box.appendChild(ul);
  } else {
    box.appendChild(el('p', {
      class: 'dim note',
      text: 'Nothing said about this yet. Press ✎ advise on the timeline toolbar (or A) — what you send is kept '
        + 'together with what you were watching.',
    }));
  }

  // Clearing the board. Without this, a typo or a note you thought better of
  // is re-served to every later AI run, forever.
  if (openAnywhere.length) {
    box.appendChild(el('button', {
      class: 'ghost danger adv-clear-all',
      text: `withdraw all ${openAnywhere.length} open across the film`,
      title: 'Closes every open item so the next AI run does not pick them up. '
        + 'The wording and evidence stay on record.',
      onclick: withdrawAllAdvice,
    }));
  }
}

/**
 * One entry, used by both readers of the same conversation: the inspector's
 * scoped section and the board. `onOpen` is what re-draws whichever list the
 * entry is in — sharing `state.openAdviceId` is deliberate, so expanding an
 * entry on the board expands the same one in the inspector.
 */
function adviceCard(a, { onOpen = rerenderAdvice } = {}) {
  const st = humanAdviceStatus(a);
  const li = el('li', { class: `adv${state.openAdviceId === a.id ? ' open' : ''}` });
  li.dataset.adviceId = a.id;
  li.appendChild(el('div', { class: 'adv-top' },
    el('span', { class: `adv-status ${st.cls}`, text: st.label }),
    el('span', { class: 'adv-when mono', text: fmtWhen(a.createdAt) })));
  li.appendChild(el('div', { class: 'adv-msg', text: a.message }));

  if (a.status === 'needs-clarification' && a.clarification) {
    const clar = el('div', { class: 'adv-clar' }, el('span', { class: 'q', text: 'AI asks' }),
      document.createTextNode(` ${a.clarification.question}`));
    li.appendChild(clar);
    const input = el('input', { placeholder: 'answer the AI…', maxlength: '4000' });
    const reply = el('div', { class: 'adv-reply' }, input, el('button', {
      class: 'ghost',
      text: 'reply',
      onclick: async (ev) => {
        ev.stopPropagation();
        const text = input.value.trim();
        if (!text) return;
        try {
          await api(`/api/films/${fid}/advice`, {
            method: 'POST',
            body: { message: text, target: a.target, followUpOf: a.id, observation: { source: 'none' } },
          });
          await loadOverview();
          rerenderAdvice();
        } catch (err) { toastError(err); }
      },
    }));
    reply.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    li.appendChild(reply);
  }

  // Taking one back. Only offered while it is still open — a resolved item is
  // the AI's answer, and withdrawing a question already answered would just
  // hide the answer.
  if (a.status !== 'resolved') {
    const undo = el('button', {
      class: 'ghost tiny-btn adv-withdraw',
      text: 'withdraw',
      title: 'Close this so the next AI run does not act on it. What you wrote stays on record.',
      onclick: (ev) => { ev.stopPropagation(); withdrawOneAdvice(a, ev.currentTarget); },
    });
    undo.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    li.appendChild(undo);
  }

  if (state.openAdviceId === a.id) hydrateAdviceDetail(li, a, onOpen);
  else li.addEventListener('click', () => { state.openAdviceId = a.id; onOpen(); });
  return li;
}

/** Both readers of the advice, redrawn together so they cannot disagree. */
function rerenderAdvice() {
  renderInspector();
  renderAdviceBoard();
  renderAdviseButton();
}

/** Withdraw one item. The request text and evidence are never deleted. */
async function withdrawOneAdvice(a, btn) {
  btn.disabled = true;
  btn.textContent = 'withdrawing…';
  try {
    await api(`/api/films/${fid}/advice/${encodeURIComponent(a.id)}/withdraw`, { method: 'POST', body: {} });
    await loadOverview();
    renderTree();
    renderTimeline();
    rerenderAdvice();
    renderProductionLine();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'withdraw';
    toastError(err);
  }
}

/** Withdraw every open item on the film, after one confirmation. */
async function withdrawAllAdvice() {
  const open = (state.advice ?? []).filter((x) => x.status !== 'resolved').length;
  if (!open) return;
  const ok = await askToConfirm({
    title: 'withdraw all advice',
    body: `Withdraw all ${open} open piece${open === 1 ? '' : 's'} of advice on this film? `
      + 'The next AI run will not pick them up. What you wrote stays on record.',
    ok: 'withdraw all',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api(`/api/films/${fid}/advice/withdraw-all`, { method: 'POST', body: {} });
    await loadOverview();
    renderTree();
    renderTimeline();
    rerenderAdvice();
    renderProductionLine();
    toast(`Withdrew ${r.count} piece${r.count === 1 ? '' : 's'} of advice.`, { kind: 'info' });
  } catch (err) { toastError(err); }
}

/** The AI's answer plus the before/after frames, fetched only when opened. */
async function hydrateAdviceDetail(li, a, onOpen = rerenderAdvice) {
  li.appendChild(el('div', { class: 'adv-when adv-close mono', text: 'close ×', onclick: (ev) => { ev.stopPropagation(); state.openAdviceId = null; onOpen(); } }));
  let full;
  try { full = await api(`/api/films/${fid}/advice/${encodeURIComponent(a.id)}`); }
  catch { return; }
  if (state.openAdviceId !== a.id) return;
  if (full.resolution) {
    li.appendChild(el('div', { class: 'adv-resolution' },
      el('b', { text: full.resolution.outcome.replace(/-/g, ' ') }),
      document.createTextNode(` — ${full.resolution.explanation}`)));
  }
  const shots = el('div', { class: 'adv-evidence' });
  for (const which of ['before', 'after']) {
    if (!full.evidence?.[which]?.image) continue;
    shots.appendChild(el('figure', {},
      el('img', { loading: 'lazy', src: `/api/films/${fid}/advice/${encodeURIComponent(a.id)}/evidence/${which}` }),
      el('figcaption', { text: which === 'before' ? 'what you saw' : 'after the change' })));
  }
  if (shots.children.length) li.appendChild(shots);
}

/** Jump the whole page to whatever a piece of advice was about. */
function focusAdvice(a) {
  const t = a.target ?? {};
  const segs = state.detail?.scenes ?? [];
  if (t.type === 'sequence') select({ kind: 'sequence', sequence: t.sequence });
  else if (t.type === 'lane') {
    // A row that has since been removed no longer exists to select; the film
    // is the honest fallback, and the entry still says which lane it was.
    select(ADVISABLE_FAMILIES.includes(t.family) && (t.lane ?? 0) < laneFamilyRows(t.family)
      ? { kind: 'lane', family: t.family, lane: t.lane ?? 0 }
      : { kind: 'film' });
  } else if (t.type === 'scene') {
    const i = segs.findIndex((s) => s.slug === t.scene);
    select(i >= 0 ? { kind: 'scene', index: i } : { kind: 'film' });
  } else if (t.type === 'footage') {
    const i = segs.findIndex((s) => s.id === t.itemId);
    select(i >= 0 ? { kind: 'scene', index: i } : { kind: 'film' });
  } else if (t.itemId) select({ kind: t.type, id: t.itemId });
  else select({ kind: 'film' });
  const frame = adviceFilmFrame(a);
  if (frame != null) { stopPlayback(); setPlayhead(frame); }
  state.openAdviceId = a.id;
  rerenderAdvice();
}

/* -------------------------- the toolbar control -------------------------- */

/**
 * Advising used to be reachable only from the foot of the inspector — which
 * meant scrolling past a scene's whole property sheet to say one sentence, and
 * on the config/audio/assets/outputs tabs meant no advise button at all. It is
 * the human half of the loop and it is always about a moment in the cut, so it
 * lives on the timeline toolbar, where it cannot move.
 *
 * The button names its target rather than just doing something: pressing an
 * "advise" that had drifted onto the wrong scene is the one mistake a shortcut
 * like this could introduce, and a label costs nothing.
 */
function renderAdviseButton() {
  const btn = $('#btn-advise');
  if (!btn) return;
  const chip = $('#advise-target');
  const sel = state.selection;
  const label = sel ? adviceScope().name : '';
  chip.textContent = label;
  chip.classList.toggle('hidden', !label);
  btn.title = sel
    ? `advise the AI on ${label} — at the playhead, with what you are watching (A)`
    : 'advise the AI — click the film, a lane, a sequence, a scene, a clip, audio, a caption or an overlay (A)';

  const all = state.advice ?? [];
  const open = all.filter((a) => a.status !== 'resolved').length;
  const boardBtn = $('#btn-advice-board');
  const count = $('#advice-board-count');
  count.textContent = open ? String(open) : '';
  count.classList.toggle('hidden', !open);
  boardBtn.classList.toggle('has-open', open > 0);
  boardBtn.classList.toggle('on', $('#advice-board')?.open === true);
  boardBtn.title = all.length
    ? `all advice on this film — ${open} open, ${all.length - open} answered (Shift+A)`
    : 'all advice on this film — nothing said yet (Shift+A)';
}

/* ------------------------------ advice board ----------------------------- */

/**
 * The whole conversation in one place. Grouped by what each piece is about and
 * ordered down the cut, because "what has been said about this film" is read
 * as a pass over the film, not as a mailbox.
 */
const BOARD_FILTERS = {
  open: (a) => a.status !== 'resolved',
  answered: (a) => a.status === 'resolved',
  all: () => true,
};

function adviceTargetLabel(a) {
  const t = a.target ?? {};
  const segs = state.detail?.scenes ?? [];
  if (t.type === 'sequence') return { kind: 'sequence', label: t.sequence };
  if (t.type === 'scene') {
    return { kind: 'scene', label: segs.find((s) => s.slug === t.scene)?.name ?? t.scene };
  }
  if (t.type === 'footage') {
    return { kind: 'footage', label: segs.find((s) => s.id === t.itemId)?.name ?? t.label ?? t.itemId };
  }
  if (t.type === 'film' || !t.type) return { kind: 'film', label: 'the whole film' };
  if (t.type === 'lane') {
    // The row as it reads now, so renumbering after a lane is removed does not
    // leave the board naming a row that is no longer there.
    return { kind: 'lane', label: `the ${t.family && ADVISABLE_FAMILIES.includes(t.family) ? laneLabel(t.family, t.lane ?? 0) : (t.label ?? 'lane')} lane` };
  }
  // The live item where it still exists, so a renamed clip reads as itself;
  // the label recorded with the advice where it has since been deleted.
  const key = { audio: 'audio', caption: 'captions', overlay: 'overlays' }[t.type];
  const item = key ? (state.film?.[key] ?? []).find((x) => x.id === t.itemId) : null;
  return { kind: t.type, label: item ? itemLabel(t.type, item) : (t.label ?? t.itemId ?? 'item') };
}

/** Stable identity for "the same thing", so a thread is not split in two. */
function adviceGroupKey(a) {
  const t = a.target ?? {};
  if (t.type === 'lane') return `lane:${t.family}:${t.lane ?? 0}`;
  return `${t.type ?? 'film'}:${t.sequence ?? t.scene ?? t.itemId ?? ''}`;
}

function adviceGroups(items) {
  const groups = new Map();
  for (const a of items) {
    const key = adviceGroupKey(a);
    if (!groups.has(key)) {
      const { kind, label } = adviceTargetLabel(a);
      groups.set(key, { key, kind, label, frame: adviceFilmFrame(a), items: [] });
    }
    const g = groups.get(key);
    g.items.push(a);
    // The earliest point in the film anything in this thread was said about.
    const f = adviceFilmFrame(a);
    if (f != null && (g.frame == null || f < g.frame)) g.frame = f;
  }
  // Down the cut. Anything that cannot be placed sorts last rather than at 0,
  // where it would look like a note on the first frame.
  return [...groups.values()].sort((x, y) => (x.frame ?? Infinity) - (y.frame ?? Infinity));
}

function openAdviceBoard() {
  const dlg = $('#advice-board');
  if (!dlg || dlg.open) { renderAdviceBoard(); return; }
  stopPlayback(); // reading the report is its own act; nothing runs on unseen
  dlg.showModal();
  renderAdviceBoard();
  renderAdviseButton();
}

function closeAdviceBoard() {
  const dlg = $('#advice-board');
  if (!dlg?.open) return;
  dlg.close();
  renderAdviseButton();
}

/** Leave the report for the moment in the film it is about. */
function goToAdvice(a) {
  closeAdviceBoard();
  focusAdvice(a);
}

function toggleAdviceBoard() {
  if ($('#advice-board')?.open) closeAdviceBoard(); else openAdviceBoard();
}

function renderAdviceBoard() {
  const dlg = $('#advice-board');
  if (!dlg?.open) return;
  const all = state.advice ?? [];
  const open = all.filter((a) => a.status !== 'resolved');
  $('#board-counts').textContent = all.length
    ? `${open.length} open · ${all.length - open.length} answered`
    : 'nothing said yet';

  for (const b of dlg.querySelectorAll('[data-board-filter]')) {
    b.classList.toggle('on', b.dataset.boardFilter === state.boardFilter);
  }

  const list = $('#board-list');
  // The board is meant to be left open while the AI works, and every event from
  // it rebuilds this list — an answer half-typed into a clarification must not
  // be retyped out from under the human. Restored by advice id, because the
  // input itself is a different node afterwards.
  const active = document.activeElement;
  const typing = active?.matches?.('.adv-reply input') && list.contains(active)
    ? { id: active.closest('.adv')?.dataset.adviceId, value: active.value, at: active.selectionStart }
    : null;
  list.innerHTML = '';
  const shown = all.filter(BOARD_FILTERS[state.boardFilter] ?? BOARD_FILTERS.all);
  if (!shown.length) {
    list.appendChild(el('li', {
      class: 'board-empty dim',
      text: !all.length
        ? 'Nothing said about this film yet. Select a sequence, scene or clip and press ✎ advise.'
        : state.boardFilter === 'open'
          ? 'Nothing open — the AI has answered everything on this film.'
          : 'Nothing answered yet.',
    }));
  }

  for (const g of adviceGroups(shown)) {
    const groupOpen = g.items.filter((a) => a.status !== 'resolved').length;
    const head = el('li', { class: 'board-group' },
      el('button', {
        class: 'board-target',
        title: 'go to it — closes the board and takes the film there',
        onclick: () => goToAdvice(g.items[0]),
      },
      el('span', { class: `board-kind k-${g.kind}`, text: g.kind }),
      el('span', { class: 'board-label', text: g.label }),
      el('span', { class: 'board-at mono dim', text: g.frame == null ? '—' : timecode(g.frame) }),
      groupOpen ? adviceBadge(groupOpen) : el('span', { class: 'board-done mono', text: '✓' })));
    list.appendChild(head);
    // Oldest first inside a thread: it is a conversation, and an answer that
    // came second must not print above the thing it answers.
    const thread = [...g.items].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
    for (const a of thread) {
      const card = adviceCard(a, { onOpen: rerenderAdvice });
      card.classList.add('board-adv');
      // Per entry, not just per target: two notes on the same scene were left
      // at different moments, and "go to it" means the one you are reading.
      const go = el('button', {
        class: 'ghost tiny-btn adv-goto',
        text: 'go to it ↗',
        title: 'closes the board, seeks to this moment and selects what it is about',
        onclick: (ev) => { ev.stopPropagation(); goToAdvice(a); },
      });
      go.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      card.appendChild(go);
      list.appendChild(card);
    }
  }

  if (typing?.id) {
    const back = list.querySelector(`.adv[data-advice-id="${CSS.escape(typing.id)}"] .adv-reply input`);
    if (back) {
      back.value = typing.value;
      back.focus();
      try { back.setSelectionRange(typing.at, typing.at); } catch { /* not a text field */ }
    }
  }

  const wipe = $('#btn-board-withdraw-all');
  wipe.classList.toggle('hidden', !open.length);
  wipe.textContent = `withdraw all ${open.length} open`;
  wipe.title = 'Closes every open item so the next AI run does not pick them up. '
    + 'The wording and evidence stay on record.';
}

/* ------------------------------ advice popup ----------------------------- */

function armAim() {
  state.aiming = true;
  $('#aim-banner').classList.remove('hidden');
  document.querySelector('.fe-frame').classList.add('aiming');
}
function disarmAim() {
  state.aiming = false;
  $('#aim-banner').classList.add('hidden');
  document.querySelector('.fe-frame').classList.remove('aiming');
}

/** The toolbar button: advise on the selection, or arm one targeting click. */
function startAdvice() {
  if (state.selection) return openAdviceDialog();
  armAim();
}

/**
 * Everything the request needs, derived from the selection — the human never
 * types an id, picks a target type, or chooses what has to be re-rendered.
 */
function currentAdviceTarget() {
  const sel = state.selection;
  const frame = Math.floor(state.playhead);
  const observedFrom = state.source === 'delivery' && state.pinnedDelivery
    ? { source: 'delivery', deliveryId: state.pinnedDelivery, filmFrame: frame, timeSeconds: Number((frame / fps()).toFixed(3)) }
    : { source: 'scene-preview', filmFrame: frame, timeSeconds: Number((frame / fps()).toFixed(3)) };

  if (sel?.kind === 'lane') {
    const li = SINGLE_ROW_FAMILIES.includes(sel.family) ? 0 : sel.lane;
    const label = laneLabel(sel.family, li);
    const n = laneContents(sel.family, li);
    return {
      // The label is recorded so a row that later goes away still reads as the
      // one the human clicked, exactly as a deleted clip's does.
      target: { type: 'lane', family: sel.family, lane: li, label, filmFrame: frame },
      observation: observedFrom,
      title: `The ${label} lane`,
      detail: `${n} item${n === 1 ? '' : 's'} in this row · at ${timecode(frame)}`,
    };
  }
  if (sel?.kind === 'sequence') {
    const band = sequenceBands().find((b) => b.label === sel.sequence);
    return {
      target: { type: 'sequence', sequence: sel.sequence },
      observation: observedFrom,
      title: `Sequence “${sel.sequence}”`,
      detail: band
        ? `${band.segments.length} segment${band.segments.length === 1 ? '' : 's'} from ${timecode(band.offset)}`
        : 'the whole sequence',
    };
  }
  if (sel?.kind === 'scene') {
    const seg = state.detail?.scenes?.[sel.index];
    if (seg?.kind === 'footage') {
      return {
        target: { type: 'footage', itemId: seg.id, label: seg.name, filmFrame: frame, sceneFrame: Math.max(0, frame - (seg.filmOffset ?? 0)) },
        observation: observedFrom,
        title: `Clip “${seg.name}”`,
        detail: `${seg.footage} · at ${timecode(frame)}`,
      };
    }
    if (seg) {
      const sceneFrame = Math.max(0, frame - (seg.filmOffset ?? 0));
      // Slug-compared the safe way — see syncVideo: a null audition and a
      // slugless segment both read `undefined`, and matching them is a crash.
      const watching = state.watchingRevision?.slug && state.watchingRevision.slug === seg.slug
        ? state.watchingRevision.revision : null;
      return {
        target: { type: 'scene', scene: seg.slug, sceneFrame, filmFrame: frame },
        observation: watching
          ? { source: 'revision-preview', revisionId: watching.id, sceneFrame, filmFrame: frame }
          : { ...observedFrom, sceneFrame, ...(state.revisions[seg.slug]?.currentRevisionId ? { revisionId: state.revisions[seg.slug].currentRevisionId } : {}) },
        title: `${seg.sequence ? `${seg.sequence} → ` : ''}${seg.name}`,
        detail: `scene ${seg.slug} · at ${timecode(frame)} (frame ${sceneFrame} of the scene)`
          + (watching ? ` · watching take ${watching.id}` : ''),
        scene: seg.slug,
      };
    }
  }
  if (sel && ['audio', 'caption', 'overlay'].includes(sel.kind)) {
    const key = { audio: 'audio', caption: 'captions', overlay: 'overlays' }[sel.kind];
    const item = (state.film?.[key] ?? []).find((x) => x.id === sel.id);
    const label = itemLabel(sel.kind, item);
    return {
      target: { type: sel.kind, itemId: sel.id, label, filmFrame: frame },
      observation: observedFrom,
      title: `${sel.kind} — ${label}`,
      detail: `at ${timecode(frame)} · advice names this exact ${sel.kind} item`,
    };
  }
  return {
    target: { type: 'film', filmFrame: frame },
    observation: observedFrom,
    title: state.film?.name ?? 'the film',
    detail: `the whole film · at ${timecode(frame)}`,
  };
}

function openAdviceDialog() {
  const ctx = currentAdviceTarget();
  state.adviceCtx = ctx;
  $('#adv-target-title').textContent = ctx.title;
  $('#adv-target-detail').textContent = ctx.detail;
  $('#advice-state').textContent = '';
  $('#advice-state').className = 'mono dim';
  $('#advice-text').value = '';

  // The previous take, right in the popup: "the last one was better" is the
  // single most common thing a human wants to say, and it should not require
  // finding a history panel first.
  const prev = $('#adv-prev-result');
  const body = $('#adv-prev-body');
  body.innerHTML = '';
  prev.classList.add('hidden');
  if (ctx.scene) {
    const list = state.sceneRevisions.get(ctx.scene);
    if (!list) loadSceneRevisions(ctx.scene).then(() => { if ($('#advice-dialog').open && state.adviceCtx?.scene === ctx.scene) fillPrevResult(ctx.scene); });
    else fillPrevResult(ctx.scene);
  }
  $('#advice-dialog').showModal();
  $('#advice-text').focus();
}

function fillPrevResult(slug) {
  const prev = $('#adv-prev-result');
  const body = $('#adv-prev-body');
  const list = state.sceneRevisions.get(slug) ?? [];
  const older = list.find((r) => !r.current);
  if (!older) { prev.classList.add('hidden'); return; }
  body.innerHTML = '';
  const thumb = el('div', { class: 'rev-thumb', title: 'the take before the current one' });
  if (older.hasContactSheet) {
    thumb.appendChild(el('img', { loading: 'lazy', src: `${sceneApi(slug)}/revisions/${encodeURIComponent(older.id)}/contact` }));
  } else thumb.appendChild(el('span', { class: 'no-thumb', text: '▶' }));
  body.appendChild(thumb);
  body.appendChild(el('div', { class: 'rev-body' },
    el('div', { class: 'rev-meta mono', text: `${fmtWhen(older.createdAt)} · ${older.frames}f` }),
    el('button', {
      class: 'ghost',
      text: 'ask AI to use this previous result',
      onclick: async (ev) => {
        await askForRevision(slug, older, ev.currentTarget);
        $('#advice-dialog').close();
      },
    })));
  prev.classList.remove('hidden');
}

async function sendAdvice() {
  const text = $('#advice-text').value.trim();
  const stateEl = $('#advice-state');
  if (!text) { stateEl.textContent = 'write something first'; stateEl.className = 'mono err'; return; }
  const ctx = state.adviceCtx ?? currentAdviceTarget();
  const btn = $('#btn-send-advice');
  btn.disabled = true;
  stateEl.textContent = 'sending…';
  stateEl.className = 'mono dim';
  try {
    await api(`/api/films/${fid}/advice`, {
      method: 'POST',
      body: {
        message: text,
        target: ctx.target,
        observation: ctx.observation,
        requestId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    $('#advice-dialog').close();
    toast('Advice sent — the AI picks it up at its next checkpoint.', { kind: 'info' });
    await loadOverview();
    renderTree();
    renderTimeline();
    rerenderAdvice();
    renderProductionLine();
  } catch (err) {
    stateEl.textContent = `failed: ${err.message}`;
    stateEl.className = 'mono err';
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ mode & source ---------------------------- */

function setSource(src) {
  const wanted = src === 'delivery' ? 'delivery' : 'preview';
  if (wanted === 'delivery' && !state.manifest) {
    toast('No built film yet — the AI has not assembled one.', { kind: 'info' });
    return;
  }
  if (state.source === wanted) return;
  stopPlayback();
  state.source = wanted;
  $('#btn-src-preview').classList.toggle('on', wanted === 'preview');
  $('#btn-src-delivery').classList.toggle('on', wanted === 'delivery');
  state.watchingRevision = null;
  renderHeader();
  renderTimeline();
  setPlayhead(Math.min(state.playhead, Math.max(0, totalFrames() - 1)));
}

/* -------------------------------- live feed ------------------------------ */

/**
 * The AI works in another process, so the page listens rather than polls.
 * Events are refetch triggers only — and they refetch the PRODUCTION side,
 * never the document, so an agent's activity can't overwrite the sentence the
 * human is in the middle of typing.
 */
let overviewRefetch = null;
function connectEvents() {
  const mine = (e) => e?.filmId === filmId || e?.type === 'activity' || e?.type === 'reset';
  const bump = () => {
    clearTimeout(overviewRefetch);
    overviewRefetch = setTimeout(async () => {
      await loadOverview();
      state.sceneRevisions.clear();
      renderProductionLine();
      renderUpdatedBanner();
      renderTree();
      renderTimeline();
      rerenderAdvice(); // the board is open often and must not go stale behind you
    }, 400);
  };
  // One stream for the whole app when embedded, our own when standalone —
  // studio-util decides, because ten open films must not mean ten sockets.
  StudioUtil.subscribeProduction(
    ['advice', 'revision', 'delivery', 'film-output', 'scene-output', 'activity', 'reset'],
    (e) => { if (mine(e)) bump(); },
  );
  // Heartbeats go stale on a clock, not on a disk write.
  setInterval(async () => {
    if (!state.status) return;
    try { state.status = await api(`/api/films/${fid}/status`); renderProductionLine(); } catch { /* transient */ }
  }, 60_000);
}

function wireProductionLoop() {
  $('#btn-aim-cancel').addEventListener('click', disarmAim);
  $('#btn-send-advice').addEventListener('click', sendAdvice);
  $('#btn-advise').addEventListener('click', startAdvice);
  $('#btn-advice-board').addEventListener('click', toggleAdviceBoard);
  $('#btn-board-close').addEventListener('click', closeAdviceBoard);
  $('#btn-board-withdraw-all').addEventListener('click', withdrawAllAdvice);
  for (const b of document.querySelectorAll('[data-board-filter]')) {
    b.addEventListener('click', () => { state.boardFilter = b.dataset.boardFilter; renderAdviceBoard(); });
  }
  // Escape dismisses a modal dialog without going through close(), so the
  // toolbar button has to learn about it from the dialog itself.
  $('#advice-board').addEventListener('close', renderAdviseButton);
  $('#btn-src-preview').addEventListener('click', () => setSource('preview'));
  $('#btn-src-delivery').addEventListener('click', () => setSource('delivery'));
  $('#btn-dismiss-updated').addEventListener('click', () => { state.updatedDismissed = true; renderUpdatedBanner(); });
  $('#btn-watch-latest').addEventListener('click', async () => {
    state.pinnedDelivery = state.latestDeliveryId;
    state.manifest = null;
    state.updatedDismissed = false;
    await loadOverview();
    $('#video-film').removeAttribute('src');
    $('#video-film').dataset.src = '';
    setSource('delivery');
    renderAll();
  });
  // Clicking the picture aims advice at exactly what is on screen.
  $('#fe-viewport').addEventListener('click', () => {
    if (!state.aiming) return; // a plain viewport click is not a selection gesture
    stopPlayback();
    const { index } = sceneAt(Math.floor(state.playhead));
    select(index >= 0 ? { kind: 'scene', index } : { kind: 'film' });
  });
}

/* ------------------------------ the document ----------------------------- */

/* What the shell needs to draw a tab and a status bar for this film. It asks;
 * this file never reaches up into the shell's DOM. Standalone — /film.html on
 * its own — registerDocument finds no shell and this is simply inert, which is
 * why a film still opens on a second monitor. */
const filmDoc = {
  kind: 'film',
  id: filmId,
  title: () => state.film?.name ?? filmId.split('/').pop(),
  status: () => {
    const out = [];
    const problems = state.detail?.problems ?? [];
    if (problems.length) {
      out.push({
        text: `⊗ ${problems.length} issue${problems.length === 1 ? '' : 's'}`,
        cls: 'err',
        title: 'what would stop a build — click for the list',
        onClick: () => $('#problems-panel').classList.toggle('hidden'),
      });
    }
    out.push({ text: filmId, cls: 'mono', title: state.film?.path ?? filmId });
    const line = $('#production-line');
    if (line?.textContent) {
      out.push({ text: line.textContent, cls: 'mono ' + (line.classList.contains('live') ? 'ok' : line.classList.contains('pending') ? 'accent' : '') });
    }
    const mix = $('#mix-state');
    if (mix?.textContent) out.push({ text: mix.textContent, cls: 'mono', align: 'right' });
    const save = $('#save-state');
    if (save?.textContent) {
      out.push({ text: save.textContent, align: 'right',
        cls: 'mono ' + (save.classList.contains('err') ? 'err' : save.classList.contains('dirty') ? 'accent' : '') });
    }
    return out;
  },
  /* Going behind a full-stage page must not leave the film playing. */
  suspend: () => { try { stopPlayback(); } catch { /* not up yet */ } },
  /* The tab is closing. `beforeunload` above guards the window, but browsers
   * do not run it for a subframe being removed — so inside the shell it is
   * this, or the last 700ms of edits go with the iframe. Flush now and let the
   * shell wait for the save it already knows how to wait for. */
  closing: async () => {
    if (!state.dirty && !state.saving) return;
    scheduleSave({ now: true });
    await waitForSaved();
  },
  /* On screen at last. A film that loaded behind a full-stage page had no
   * timeline width to fit against; this is where it gets one. */
  shown: () => {
    try {
      computeFit();
      if (applyFit()) renderTimeline();
      fitPlayerBox();
    } catch { /* not up yet */ }
  },
};

StudioUtil.registerDocument(filmDoc);

/* The shell's keys land wherever the focus is, and the focus is usually inside
 * a document — so every document binds them and hands them up. One binder for
 * all of them now; this used to be a per-file copy that only knew Ctrl+P. */
StudioUtil.bindShellKeys();

/* ------------------------ activity bar + the palette --------------------- */

$('#btn-explorer').addEventListener('click', toggleRail);
$('#btn-palette').addEventListener('click', () => StudioPalette.open('files'));
$('#sb-goto').addEventListener('click', () => StudioPalette.open('files'));

function syncExplorerIcon() {
  $('#btn-explorer').classList.toggle(
    'active', !document.querySelector('.fe-frame').classList.contains('rail-collapsed'));
}
syncExplorerIcon();

StudioPalette.register([
  { id: 'film.build', title: 'Film: Build', group: 'commands', run: () => $('#btn-build').click() },
  { id: 'film.advise', title: 'Film: Advise the AI on the Selection', group: 'commands', run: () => startAdvice() },
  { id: 'film.adviceBoard', title: 'Film: All Advice on This Film', group: 'commands', run: () => toggleAdviceBoard() },
  { id: 'film.newScene', title: 'Film: New Scene…', group: 'commands', run: () => $('#btn-new-scene').click() },
  // The keyboard route to a gesture that is otherwise made by dragging across
  // the sequences lane. It calls the function directly: there is no longer a
  // button on the page for it to press.
  { id: 'film.newSeq', title: 'Film: New Sequence from Selection', group: 'commands', run: () => createSequenceFromSelection() },
  { id: 'film.narration', title: 'Film: Add Narration…', group: 'commands', run: () => $('#btn-add-tts').click() },
  { id: 'film.audio', title: 'Film: Add Audio…', group: 'commands', run: () => $('#btn-add-audio').click() },
  { id: 'film.caption', title: 'Film: Add Caption at Playhead', group: 'commands', run: () => $('#btn-add-caption').click() },
  { id: 'film.footage', title: 'Film: Add Footage…', group: 'commands', run: () => $('#btn-add-footage').click() },
  { id: 'film.image', title: 'Film: Add Image…', group: 'commands', run: () => $('#btn-add-image').click() },
  { id: 'film.overlay', title: 'Film: Add Overlay…', group: 'commands', run: () => $('#btn-add-overlay').click() },
  { id: 'view.fit', title: 'Timeline: Fit the Whole Film', group: 'commands', run: () => zoomFit() },
  { id: 'view.rail', title: 'View: Toggle Side Bar', group: 'commands', run: () => $('#btn-explorer').click() },
  { id: 'edit.undo', title: 'Edit: Undo', group: 'commands', run: () => undo() },
  { id: 'edit.redo', title: 'Edit: Redo', group: 'commands', run: () => redo() },
  { id: 'src.preview', title: 'Player: Watch the Scenes as They Stand', group: 'commands', run: () => setSource('preview') },
  { id: 'src.delivery', title: 'Player: Watch the Last Built Film', group: 'commands', run: () => setSource('delivery') },
  ...['advice', 'scene', 'config', 'audio', 'assets', 'outputs'].map((t) => ({
    id: `insp.${t}`,
    title: `Inspector: ${t[0].toUpperCase()}${t.slice(1)}`,
    group: 'commands',
    when: () => state.selection?.kind === 'scene',
    run: () => { state.tab.scene = t; renderInspector(); },
  })),
]);

/* --------------------------------- name --------------------------------- */

$('#film-name').addEventListener('change', () => {
  // Asked before anything else: the empty-value branch below READS
  // `state.film.name`, so it throws in the boot window that mutate()'s own
  // guard would have caught (BUG-3). And the title must not be rewritten from
  // an edit that was refused — that is how the tab came to claim a name the
  // film never had.
  if (!filmReady()) return;
  const v = $('#film-name').value.trim();
  if (!v) { $('#film-name').value = state.film.name; return; }
  if (!mutate((film) => { film.name = v; }, { silent: true })) return;
  document.title = `${v} — Motion Studio`;
  StudioUtil.syncDocument();
});
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-reload').addEventListener('click', reloadFilm);

/* --------------------------------- boot --------------------------------- */

function renderAll() {
  renderHeader();
  computeFit();
  // Fit-zoom on first load. If the timeline has no width yet — mounted behind
  // a full-stage page — this does nothing and the ResizeObserver in the zoom
  // section finishes the job the moment it is on screen.
  applyFit();
  renderTimeline();
  renderTree();
  renderInspector();
  renderScenesRail();
  fitPlayerBox();
  setPlayhead(state.playhead);
  updateMixChip();
}

(async () => {
  if (!filmId) {
    document.body.innerHTML = '<p style="padding:40px" class="dim">No film id — open a film from the Studio (<a href="/">back</a>).</p>';
    return;
  }
  // BUG-3: until `refresh()` lands there is no film to edit, but every control
  // is already in the DOM with its listener attached. Say so and mean it — the
  // body is inert while `booting` is set (see film.css), so a keystroke cannot
  // be silently swallowed by a document that only LOOKS ready. The boot already
  // replaces the whole body on a load failure; this is the same gate for the
  // moments before that verdict exists.
  const frame = $('.fe-frame');
  frame?.setAttribute('inert', '');   // blocks focus AND pointer — see film.css
  setSaveState('loading…');
  wireProductionLoop();
  try {
    await refresh();
  } catch (err) {
    toastError(err);
    document.body.innerHTML = `<p style="padding:40px" class="dim">Could not load film: ${err.message} (<a href="/">back to the Studio</a>)</p>`;
    return;
  } finally {
    // Cleared on the failure path too: that path replaces the body outright, so
    // this is belt-and-braces against a future edit that stops doing so and
    // leaves the whole editor unclickable.
    frame?.removeAttribute('inert');
  }
  setSaveState('saved');
  connectEvents();
  // A deep link from anywhere else in the Studio lands on the exact thing.
  const qs = new URLSearchParams(location.search);
  if (qs.get('scene')) {
    const i = (state.detail?.scenes ?? []).findIndex((s) => s.slug === qs.get('scene'));
    if (i >= 0) { select({ kind: 'scene', index: i }); setPlayhead(state.detail.scenes[i].filmOffset ?? 0); }
  } else if (qs.get('sequence')) {
    select({ kind: 'sequence', sequence: qs.get('sequence') });
  }
  if (qs.get('advice')) {
    const a = state.advice.find((x) => x.id === qs.get('advice'));
    if (a) focusAdvice(a);
  }
})();
