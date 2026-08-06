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
const { $, api, toast, toastError } = StudioUtil;
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
  sceneTab: 'scene',     // inspector tab for a selected scene: scene|config|audio|assets|outputs
  filmTab: 'film',       // inspector tab for the film itself: film|assets|outputs
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
  'sequences', 'audioTargetPeakDb', 'burnCaptions', 'outputFilename', 'deliverables'];

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
  state.undo.push(snapshot());
  if (state.undo.length > 100) state.undo.shift();
  state.redo.length = 0;
  fn(state.film);
  syncUndoButtons();
  scheduleSave({ now: structural });
  if (!silent) renderTimeline();
  invalidateMixIfAudioChanged();
}

/** Resolve once the pending save has landed (structural edits need the
 *  server-recomputed scene layout before continuing). */
async function waitForSaved() {
  while (state.dirty || state.saving) await new Promise((r) => setTimeout(r, 80));
}

let lastAudioJson = '';
function invalidateMixIfAudioChanged() {
  const cur = JSON.stringify(state.film?.audio ?? []);
  if (cur !== lastAudioJson) {
    lastAudioJson = cur;
    if (state.mix.url) URL.revokeObjectURL(state.mix.url);
    Object.assign(state.mix, { el: null, url: null, dirty: true, active: false });
    updateMixChip();
  }
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
  lastAudioJson = JSON.stringify(film.audio ?? []);
  adoptDetail(detail);
  $('#film-name').value = film.name;
  document.title = `${film.name} — Motion Studio`;
  StudioUtil.syncDocument();
  await loadAssets();
  await loadOverview();
  renderAll();
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
  renderProductionLine();
  renderUpdatedBanner();
}

$('#btn-problems').addEventListener('click', () => $('#problems-panel').classList.toggle('hidden'));

/* ------------------------------- preview ------------------------------- */

const videoEls = [$('#video-a'), $('#video-b')];
let activeVideo = null;

function fitPlayerBox() {
  const first = state.detail?.scenes.find((s) => !s.missing);
  const w = first?.width ?? 1920, h = first?.height ?? 1080;
  const box = $('#fe-viewport').getBoundingClientRect();
  const scale = Math.min((box.width - 2) / w, (box.height - 2) / h);
  const pb = $('#player-box');
  pb.style.width = `${Math.max(64, w * scale)}px`;
  pb.style.height = `${Math.max(36, h * scale)}px`;
  updateLayers(state.playhead);
}
window.addEventListener('resize', fitPlayerBox);

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
  if (v.dataset.src !== src) { v.dataset.src = src; v.src = src; }
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
    ph.classList.remove('hidden');
    ph.querySelector('.ph-name').textContent = scene ? scene.name : (totalFrames() ? 'gap' : 'no scenes yet');
    ph.querySelector('.ph-note').textContent = !scene ? 'add scenes with “+ scene”'
      : scene.kind === 'footage' ? 'footage file missing from the film’s assets/'
        : 'scene not rendered — render it to preview';
    return;
  }
  ph.classList.add('hidden');

  // Auditioning an older take substitutes ONLY that scene's picture, in place,
  // so the human compares it against the cut it actually sits in. Nothing is
  // written — asking for it back is advice, made from the inspector.
  const src = state.watchingRevision?.slug === scene.slug
    ? `${sceneApi(scene.slug)}/revisions/${encodeURIComponent(state.watchingRevision.revision.id)}/file`
    : sceneSrc(scene);
  let el = videoEls.find((v) => v.dataset.src === src);
  if (!el) {
    el = videoEls.find((v) => v !== activeVideo) ?? videoEls[0];
    el.dataset.src = src;
    el.src = src;
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
    }
    el.style.left = `${o.xPct ?? 0}%`;
    el.style.top = `${o.yPct ?? 0}%`;
    el.style.width = o.widthPct != null ? `${o.widthPct}%` : 'auto';
    el.style.opacity = String(o.opacity ?? 1);
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

  // Captions.
  const cap = $('#caption-layer');
  const active = (film.captions ?? []).filter((c) => frame >= c.fromFrame && frame < c.toFrame);
  cap.textContent = active.map((c) => c.text).join('\n');
  const style = film.captionStyle ?? {};
  cap.style.fontSize = `${(pb.clientHeight * (style.sizePct ?? 4.5)) / 100}px`;
  if ((style.position ?? 'bottom') === 'top') { cap.style.top = '4.5%'; cap.style.bottom = 'auto'; }
  else { cap.style.bottom = '4.5%'; cap.style.top = 'auto'; }
}

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

function clipFrames(track) {
  if (track.trimEndInFrames) return track.trimEndInFrames;
  const wave = state.waves.get(track.src);
  if (wave?.duration) return Math.max(1, Math.round(wave.duration * fps()));
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
  const total = naturalFrames(track) ?? clipFrames(track);
  const shownFrac = clamp(clipFrames(track) / total, 0, 1); // trim hides the tail
  const buckets = Math.floor(wave.peaks.length * shownFrac);
  for (let x = 0; x < W; x++) {
    const p = wave.peaks[Math.floor((x / W) * buckets)] ?? 0;
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

function row(cls, headText, laneWidth) {
  const r = document.createElement('div');
  r.className = `tl-row ${cls}`;
  const head = document.createElement('div');
  head.className = 'tl-head';
  head.textContent = headText;
  const lane = document.createElement('div');
  lane.className = 'lane';
  lane.style.width = `${laneWidth}px`;
  r.append(head, lane);
  return { row: r, head, lane };
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
    const { row: r, head, lane } = row('row-sequences', 'sequences', laneW);
    const addSeq = document.createElement('button');
    addSeq.className = 'lane-add';
    addSeq.textContent = '+';
    addSeq.title = 'group the selected segment onward into a new sequence';
    addSeq.addEventListener('click', createSequenceFromSelection);
    head.appendChild(addSeq);
    for (const band of sequenceBands()) lane.appendChild(sequenceBlock(band));
    inner.appendChild(r);
  }

  /* scenes */
  {
    const { row: r, head, lane } = row('row-scenes', 'scenes', laneW);
    const addScene = document.createElement('button');
    addScene.className = 'lane-add';
    addScene.textContent = '+';
    addScene.title = 'add scenes — drag one from the left rail, or create a new one there';
    addScene.addEventListener('click', revealScenesRail);
    head.appendChild(addScene);
    addCutlines(lane);
    (state.detail?.scenes ?? []).forEach((s, i) => lane.appendChild(sceneBlock(s, i)));
    inner.appendChild(r);
  }

  /* audio lanes */
  {
    const lanes = packLanes((state.film.audio ?? []).map((t) => ({
      item: t, start: t.startInFrames ?? 0, end: (t.startInFrames ?? 0) + clipFrames(t),
    })));
    if (!lanes.length) lanes.push([]);
    lanes.forEach((items, li) => {
      const { row: r, head, lane } = row('row-audio', lanes.length > 1 ? `audio ${li + 1}` : 'audio', laneW);
      if (li === 0) {
        const add = document.createElement('button');
        add.className = 'lane-add';
        add.textContent = '+';
        add.title = 'add audio at the playhead';
        add.addEventListener('click', openAudioDialog);
        head.appendChild(add);
      }
      addCutlines(lane);
      for (const { item } of items) lane.appendChild(audioBlock(item));
      inner.appendChild(r);
    });
  }

  /* captions */
  {
    const lanes = packLanes((state.film.captions ?? []).map((c) => ({ item: c, start: c.fromFrame, end: c.toFrame })));
    if (!lanes.length) lanes.push([]);
    lanes.forEach((items, li) => {
      const { row: r, head, lane } = row('row-captions', li ? `captions ${li + 1}` : 'captions', laneW);
      if (li === 0) {
        const add = document.createElement('button');
        add.className = 'lane-add';
        add.textContent = '+';
        add.title = 'add a caption at the playhead';
        add.addEventListener('click', addCaptionAtPlayhead);
        head.appendChild(add);
      }
      addCutlines(lane);
      for (const { item } of items) lane.appendChild(rangeBlock(item, 'caption'));
      inner.appendChild(r);
    });
  }

  /* overlays */
  {
    const lanes = packLanes((state.film.overlays ?? []).map((o) => ({ item: o, start: o.fromFrame, end: o.toFrame })));
    if (!lanes.length) lanes.push([]);
    lanes.forEach((items, li) => {
      const { row: r, head, lane } = row('row-overlays', li ? `overlay ${li + 1}` : 'overlay', laneW);
      if (li === 0) {
        const add = document.createElement('button');
        add.className = 'lane-add';
        add.textContent = '+';
        add.title = 'add an overlay at the playhead';
        add.addEventListener('click', openOverlayDialog);
        head.appendChild(add);
      }
      addCutlines(lane);
      for (const { item } of items) lane.appendChild(rangeBlock(item, 'overlay'));
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
  const name = document.createElement('span');
  name.className = 'seq-name';
  name.textContent = band.label ?? '—';
  el.appendChild(name);
  // Double-click zooms the band to the viewport — movement-to-movement is the
  // granularity a film is reviewed at, and an anonymous run is still a stretch
  // of film worth filling the screen with.
  el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); zoomToRange(band.offset, band.frames); });
  if (band.label) {
    const n = unresolvedCount((a) => a.target?.type === 'sequence' && a.target.sequence === band.label);
    if (n) el.appendChild(adviceBadge(n));
    el.title = `sequence “${band.label}” — ${band.segments.length} segment${band.segments.length === 1 ? '' : 's'}`
      + ' (double-click to zoom to it)'
      + `${state.film?.sequences?.[band.label]?.intent ? `\n${state.film.sequences[band.label].intent}` : ''}`;
    el.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      select({ kind: 'sequence', sequence: band.label });
      stopPlayback();
      setPlayhead(band.offset);
    });
  } else {
    el.title = 'not in a sequence yet — select a segment and use “+ seq”';
  }
  return el;
}

/** Group the selected segment and every following one into a named sequence. */
function createSequenceFromSelection() {
  const sel = state.selection;
  const from = sel?.kind === 'scene' ? sel.index : 0;
  const seg = state.detail?.scenes?.[from];
  if (!seg) return toast('Add a scene or clip first.', { kind: 'error' });
  const name = prompt('Name this sequence (it groups from the selected segment onward):');
  if (!name || !name.trim()) return;
  const label = name.trim().slice(0, 80);
  mutate((film) => {
    for (let i = from; i < film.scenes.length; i++) film.scenes[i].sequence = label;
    film.sequences = { ...(film.sequences ?? {}), [label]: film.sequences?.[label] ?? {} };
  }, { structural: true, silent: true });
  for (let i = from; i < state.detail.scenes.length; i++) state.detail.scenes[i].sequence = label;
  select({ kind: 'sequence', sequence: label });
  renderAll();
}

function renameSequence(oldLabel) {
  const name = prompt(`Rename sequence “${oldLabel}” to:`, oldLabel);
  if (!name || !name.trim() || name.trim() === oldLabel) return;
  const label = name.trim().slice(0, 80);
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
  const el = baseBlock('audio', t.id, start * state.pxf, frames * state.pxf, `blk-audio${t.duck ? ' duck' : ''}`);

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
  label.textContent = `${t.duck ? '⤓ ' : ''}${t.label || t.src.replace(/^assets\//, '')}${t.gainDb ? ` · ${t.gainDb > 0 ? '+' : ''}${t.gainDb}dB` : ''}`;
  el.appendChild(label);

  // Move.
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target.classList.contains('grip')) return;
    const orig = t.startInFrames ?? 0;
    let next = orig;
    pointerDrag(ev, {
      onMove: (d, e2) => {
        el.classList.add('dragging');
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
        if (!moved || next === orig) return;
        mutate((film) => {
          const tr = film.audio.find((x) => x.id === t.id);
          if (tr) tr.startInFrames = next;
        });
        if (state.selection?.kind === 'audio' && state.selection.id === t.id) renderInspector();
      },
    });
  });

  // Right grip = trim.
  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.title = 'trim the clip end';
  grip.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    const origFrames = frames;
    let nextTrim;
    pointerDrag(ev, {
      onMove: (d, e2) => {
        const nat = naturalFrames(t);
        let f2 = Math.max(1, Math.round(origFrames + d));
        if (nat) f2 = Math.min(f2, nat);
        const se = snapFrame(start + f2, { kind: 'audio', id: t.id });
        if (se.snapped !== null && se.f > start) f2 = se.f - start;
        showSnapline(se.snapped);
        nextTrim = (nat && f2 >= nat - 2) ? null : f2; // release ≈ untrimmed
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
    pointerDrag(ev, {
      onMove: (d, e2) => {
        el.classList.add('dragging');
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
        if (!moved || next === orig) return;
        mutate(() => {
          const it = list().find((x) => x.id === item.id);
          if (it) { it.toFrame = next + len; it.fromFrame = next; }
        });
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
  renderTree();
  renderInspector();
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
  else if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); startAdvice(); }
  else if (e.code === 'Escape') { if (state.aiming) disarmAim(); else select(null); }
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
 * True while the inspector is showing one of the shared scene panels rather
 * than the scene's own summary. Those panels are focused editing surfaces, so
 * the versions and advice sections stand down for them — the `scene` tab that
 * carries both is one click away.
 */
function isDeepSceneTab() {
  if (state.inspectorMode === 'build') return false;
  if (state.selection?.kind !== 'scene' || state.sceneTab === 'scene') return false;
  return state.detail?.scenes?.[state.selection.index]?.kind !== 'footage';
}

/** The film's own deep panels, on the same rule: focused work stands the
 *  versions and advice sections down until you come back to the first tab. */
function isDeepFilmTab() {
  return state.inspectorMode !== 'build' && !state.selection && state.filmTab !== 'film';
}

const isDeepInspectorTab = () => isDeepSceneTab() || isDeepFilmTab();

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
  if (!sel) renderFilmInspector(box);
  else if (sel.kind === 'sequence') renderSequenceInspector(box, sel.sequence);
  else if (sel.kind === 'scene') renderSceneInspector(box, sel.index);
  else if (sel.kind === 'audio') renderAudioInspector(box, sel.id);
  else if (sel.kind === 'caption') renderCaptionInspector(box, sel.id);
  else if (sel.kind === 'overlay') renderOverlayInspector(box, sel.id);
  if (!isDeepInspectorTab()) {
    renderVersionsSection(box);
    renderAdviceSection(box);
  }
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

const FILM_TABS = [
  ['film', 'this film: its facts, caption style and platform versions'],
  ['assets', 'files in the film’s own assets/ folder — master audio, overlays, footage'],
  ['outputs', 'what this film has built'],
];

function filmTabStrip() {
  const nav = el('nav', { class: 'tabs insp-tabs' });
  for (const [name, title] of FILM_TABS) {
    nav.appendChild(el('button', {
      class: 'tab' + (state.filmTab === name ? ' active' : ''),
      text: name,
      title,
      onclick: () => { state.filmTab = name; renderInspector(); },
    }));
  }
  return nav;
}

function renderFilmInspector(box) {
  box.appendChild(filmTabStrip());
  if (state.filmTab !== 'film') {
    const panels = ensureFilmPanels();
    panels.show(state.filmTab);
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
      state.sceneTab = 'scene';
      scenePanelsSceneId = null;
      try { await refresh(); } catch (err) { toastError(err); }
    },
  });
  return scenePanels;
}

const SCENE_TABS = [
  ['scene', 'this take: its facts, its versions, and the advice on it'],
  ['config', 'composition and output settings — the scene’s own scene.json'],
  ['audio', 'audio tracks inside this scene (the film’s master audio is on the timeline)'],
  ['assets', 'files in this scene’s assets/ folder'],
  ['outputs', 'what this scene has rendered'],
];

function sceneTabStrip() {
  const nav = el('nav', { class: 'tabs insp-tabs' });
  for (const [name, title] of SCENE_TABS) {
    nav.appendChild(el('button', {
      class: 'tab' + (state.sceneTab === name ? ' active' : ''),
      text: name,
      title,
      onclick: () => { state.sceneTab = name; renderInspector(); },
    }));
  }
  return nav;
}

function mountScenePanels(box, s) {
  const panels = ensureScenePanels();
  const sceneId = `${filmId}/${s.slug}`;
  if (scenePanelsSceneId !== sceneId) {
    scenePanelsSceneId = sceneId;
    panels.setTarget({ kind: 'scene', id: sceneId })
      .then(() => panels.show(state.sceneTab))
      .catch((err) => { scenePanelsSceneId = null; toastError(err); });
  }
  panels.show(state.sceneTab);
  box.appendChild(panels.root);
}

function renderSceneInspector(box, index) {
  const s = state.detail.scenes[index];
  if (!s) return renderFilmInspector(box);
  if (s.kind === 'footage') return renderFootageInspector(box, index, s);
  box.appendChild(sceneTabStrip());
  if (state.sceneTab !== 'scene') return mountScenePanels(box, s);
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
      if (tr) { tr.src = srcSel.value; delete tr.trimEndInFrames; }
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
  const trim = numInput(t.trimEndInFrames ?? '', { min: 1, onCommit: (v) => mutate((film) => { const tr = film.audio.find((x) => x.id === id); if (!tr) return; if (v) tr.trimEndInFrames = v; else delete tr.trimEndInFrames; }) });
  trim.placeholder = 'full';
  box.appendChild(el('div', { class: 'insp-row' }, labelled('start (frames)', start), labelled('trim end (frames)', trim)));

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

{
  const stored = Number(localStorage.getItem(INSP_KEY));
  if (Number.isFinite(stored) && stored > 0) setInspectorWidth(stored);

  $('#insp-grip')?.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = $('#inspector').getBoundingClientRect().width;
    document.body.classList.add('resizing-insp');
    const move = (e2) => { setInspectorWidth(startW - (e2.clientX - startX)); fitPlayerBox(); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-insp');
      const w = setInspectorWidth($('#inspector').getBoundingClientRect().width);
      try { localStorage.setItem(INSP_KEY, String(w)); }
      catch { /* private mode / quota: the width is a convenience, never a blocker */ }
      fitPlayerBox();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // The clamp is a fraction of the window, so a shrunk window must re-clamp or
  // the inspector eats the stage.
  window.addEventListener('resize', () => setInspectorWidth($('#inspector').getBoundingClientRect().width));
}

/* --------------------------------- zoom --------------------------------- */

/* `fitMeasured` is false when the timeline has no box yet — a document mounted
 * behind another tab, or one whose editor stack was display:none while a
 * full-stage page was up. Fitting to that gives the 0.005 floor, which is the
 * whole film squeezed into a hundred pixels. Callers must not latch a fit they
 * did not actually measure. */
function computeFit() {
  const sc = $('#tl-scroll');
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
  const name = prompt('Name for the new scene:');
  if (!name || !name.trim()) return;
  try {
    await waitForSaved(); // the server appends to the play order it reads from disk
    await api(`/api/films/${fid}/scenes`, { method: 'POST', body: { name: name.trim() } });
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
  const name = prompt('Name for the duplicate:', `${sourceName ?? slug} (copy)`);
  if (name === null || !name.trim()) return;
  try {
    await waitForSaved(); // the server appends to the play order it reads from disk
    const clone = await api(`/api/films/${fid}/scenes/${encodeURIComponent(slug)}/clone`, {
      method: 'POST', body: { name: name.trim() },
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

function revealScenesRail() {
  document.querySelector('.fe-frame').classList.remove('rail-collapsed');
  const rail = $('#fe-scenes');
  rail.classList.remove('pulse');
  void rail.offsetWidth; // restart the animation
  rail.classList.add('pulse');
}
$('#btn-scenes-collapse').addEventListener('click', () => {
  document.querySelector('.fe-frame').classList.toggle('rail-collapsed');
  syncExplorerIcon();
});

/* ---- audio ---- */

function pickListForAssets(ulSel, kinds, onPick) {
  const ul = $(ulSel);
  ul.innerHTML = '';
  const files = state.assets.filter((a) => kinds.includes(a.kind));
  if (!files.length) {
    ul.innerHTML = '<li class="pick-empty">nothing here yet — upload a file above</li>';
    return;
  }
  for (const a of files) {
    const li = document.createElement('li');
    if (a.kind === 'image') li.appendChild(el('img', { class: 'pk-thumb', src: assetUrl(a.path) }));
    li.append(
      el('span', { class: 'pk-name mono', text: a.path.replace(/^assets\//, '') }),
      el('span', { class: 'pk-meta', text: a.bytes > 1e6 ? `${(a.bytes / 1e6).toFixed(1)} MB` : `${Math.round(a.bytes / 1e3)} kB` }),
    );
    li.addEventListener('click', () => onPick(a));
    ul.appendChild(li);
  }
}

function openAudioDialog() {
  pickListForAssets('#audio-pick', ['audio'], (a) => {
    mutate((film) => film.audio.push({
      id: uuid(), src: a.path, startInFrames: Math.round(state.playhead), gainDb: 0,
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
    mutate((film) => film.audio.push({ id: uuid(), src: a.path, startInFrames: Math.round(state.playhead), gainDb: 0 }));
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

function openOverlayDialog() {
  pickListForAssets('#overlay-pick', ['image', 'video'], (a) => {
    mutate((film) => film.overlays.push({
      id: uuid(), src: a.path,
      fromFrame: Math.round(state.playhead),
      toFrame: Math.min(Math.round(state.playhead) + fps() * 3, Math.max(totalFrames(), Math.round(state.playhead) + fps() * 3)),
      xPct: 4, yPct: 6, widthPct: 28, opacity: 1,
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
  const cap = { id: uuid(), text: 'Caption', fromFrame: from, toFrame: from + fps() * 3 };
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

$('#btn-add-scene').addEventListener('click', revealScenesRail);

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
function renderTree() {
  const box = $('#fe-tree');
  if (!box || !state.detail) return;
  box.innerHTML = '';
  const sel = state.selection;

  const rootRow = el('div', {
    class: `tree-row tree-film${sel ? '' : ' selected'}`,
    onpointerdown: () => select(null),
  },
  el('span', { class: 'tree-twist', text: '▾' }),
  el('span', { class: 'tree-name', text: state.film?.name ?? 'film' }),
  el('span', { class: 'tree-meta mono', text: state.detail.totalFrames ? timecode(state.detail.totalFrames) : '—' }));
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
      el('span', { class: 'tree-dot' }),
      el('span', { class: 'tree-name', text: seg.missing ? `⚠ ${seg.slug ?? seg.footage}` : seg.name }),
      el('span', { class: 'tree-meta mono', text: `${seg.durationInFrames ?? 0}f` }));
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
  box.appendChild(el('h3', { text: 'sequence' }));
  box.appendChild(el('div', { class: 'insp-title', text: label }));
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
  row.appendChild(el('button', { class: 'ghost', text: 'rename…', onclick: () => renameSequence(label) }));
  row.appendChild(el('button', { class: 'ghost danger', text: 'ungroup', onclick: () => ungroupSequence(label) }));
  box.appendChild(row);
}

/* ---------------------------- versions section --------------------------- */

/**
 * Every promoted render is archived, so a scene has takes. Previewing one
 * changes nothing; asking for one back is ADVICE — Studio never repoints
 * production, because that decision is the director's.
 */
function renderVersionsSection(box) {
  const sel = state.selection;
  if (sel?.kind !== 'scene') return;
  const seg = state.detail?.scenes?.[sel.index];
  if (!seg || seg.kind === 'footage' || seg.missing) return;
  const summary = state.revisions[seg.slug];
  if (!summary?.count) return;

  box.appendChild(el('hr', { class: 'sep' }));
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
  if (!sel) return { name: 'this film', pred: () => true };
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
  return { name: 'this item', pred: (a) => a.target?.itemId === sel.id };
}

function renderAdviceSection(box) {
  const scope = adviceScope();
  const scoped = (state.advice ?? []).filter(scope.pred);
  const open = scoped.filter((a) => a.status !== 'resolved');
  const openAnywhere = (state.advice ?? []).filter((a) => a.status !== 'resolved');
  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('div', { class: 'adv-head-row' },
    el('h3', { text: open.length ? `advice · ${open.length} open` : 'advice' }),
    // The only "advise" button on the page. With nothing selected it arms one
    // targeting click instead of guessing what you meant.
    el('button', { class: 'primary tiny-btn', text: '✎ advise', onclick: startAdvice })));
  box.appendChild(el('div', { class: 'mono dim adv-scope', text: `on ${scope.name}` }));

  if (scoped.length) {
    const ul = el('ul', { class: 'adv-list' });
    for (const a of scoped) ul.appendChild(adviceCard(a));
    box.appendChild(ul);
  } else {
    box.appendChild(el('p', {
      class: 'dim note',
      text: 'Nothing said about this yet. What you send is kept together with what you were watching.',
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

function adviceCard(a) {
  const st = humanAdviceStatus(a);
  const li = el('li', { class: `adv${state.openAdviceId === a.id ? ' open' : ''}` });
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
          renderInspector();
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

  if (state.openAdviceId === a.id) hydrateAdviceDetail(li, a);
  else li.addEventListener('click', () => { state.openAdviceId = a.id; renderInspector(); });
  return li;
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
    renderInspector();
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
  const ok = confirm(
    `Withdraw all ${open} open piece${open === 1 ? '' : 's'} of advice on this film?\n\n`
    + 'The next AI run will not pick them up. What you wrote stays on record.',
  );
  if (!ok) return;
  try {
    const r = await api(`/api/films/${fid}/advice/withdraw-all`, { method: 'POST', body: {} });
    await loadOverview();
    renderTree();
    renderTimeline();
    renderInspector();
    renderProductionLine();
    toast(`Withdrew ${r.count} piece${r.count === 1 ? '' : 's'} of advice.`, { kind: 'info' });
  } catch (err) { toastError(err); }
}

/** The AI's answer plus the before/after frames, fetched only when opened. */
async function hydrateAdviceDetail(li, a) {
  li.appendChild(el('div', { class: 'adv-when adv-close mono', text: 'close ×', onclick: (ev) => { ev.stopPropagation(); state.openAdviceId = null; renderInspector(); } }));
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
  else if (t.type === 'scene') {
    const i = segs.findIndex((s) => s.slug === t.scene);
    select(i >= 0 ? { kind: 'scene', index: i } : null);
  } else if (t.type === 'footage') {
    const i = segs.findIndex((s) => s.id === t.itemId);
    select(i >= 0 ? { kind: 'scene', index: i } : null);
  } else if (t.itemId) select({ kind: t.type, id: t.itemId });
  else select(null);
  const frame = adviceFilmFrame(a);
  if (frame != null) { stopPlayback(); setPlayhead(frame); }
  state.openAdviceId = a.id;
  renderInspector();
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
      const watching = state.watchingRevision?.slug === seg.slug ? state.watchingRevision.revision : null;
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
    renderInspector();
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
  const source = new EventSource('/api/events');
  const mine = (e) => {
    try { const d = JSON.parse(e.data); return d?.filmId === filmId || d?.type === 'activity'; }
    catch { return false; }
  };
  const bump = () => {
    clearTimeout(overviewRefetch);
    overviewRefetch = setTimeout(async () => {
      await loadOverview();
      state.sceneRevisions.clear();
      renderProductionLine();
      renderUpdatedBanner();
      renderTree();
      renderTimeline();
      renderInspector();
    }, 400);
  };
  for (const type of ['advice', 'revision', 'delivery', 'film-output', 'scene-output', 'activity']) {
    source.addEventListener(type, (e) => { if (mine(e)) bump(); });
  }
  source.addEventListener('reset', bump);
  source.onerror = () => { /* EventSource reconnects on its own */ };
  // Heartbeats go stale on a clock, not on a disk write.
  setInterval(async () => {
    if (!state.status) return;
    try { state.status = await api(`/api/films/${fid}/status`); renderProductionLine(); } catch { /* transient */ }
  }, 60_000);
}

function wireProductionLoop() {
  $('#btn-aim-cancel').addEventListener('click', disarmAim);
  $('#btn-send-advice').addEventListener('click', sendAdvice);
  $('#btn-src-preview').addEventListener('click', () => setSource('preview'));
  $('#btn-src-delivery').addEventListener('click', () => setSource('delivery'));
  $('#btn-new-sequence').addEventListener('click', createSequenceFromSelection);
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
    select(index >= 0 ? { kind: 'scene', index } : null);
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

/* The shell owns Ctrl+P, but the keystroke lands wherever the focus is — and
 * the focus is usually inside a document. Hand it up rather than swallowing it. */
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'p') return;
  if (document.querySelector('dialog[open]')) return;
  const shell = StudioUtil.shell();
  if (!shell) return;
  e.preventDefault();
  shell.openPalette(e.shiftKey ? 'commands' : 'files');
});

/* ------------------------ activity bar + the palette --------------------- */

$('#btn-explorer').addEventListener('click', () => $('#btn-scenes-collapse').click());
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
  { id: 'film.newScene', title: 'Film: New Scene…', group: 'commands', run: () => $('#btn-new-scene').click() },
  { id: 'film.newSeq', title: 'Film: New Sequence from Selection', group: 'commands', run: () => $('#btn-new-sequence').click() },
  { id: 'film.narration', title: 'Film: Add Narration…', group: 'commands', run: () => $('#btn-add-tts').click() },
  { id: 'film.audio', title: 'Film: Add Audio…', group: 'commands', run: () => $('#btn-add-audio').click() },
  { id: 'film.caption', title: 'Film: Add Caption at Playhead', group: 'commands', run: () => $('#btn-add-caption').click() },
  { id: 'film.footage', title: 'Film: Add Footage…', group: 'commands', run: () => $('#btn-add-footage').click() },
  { id: 'film.overlay', title: 'Film: Add Overlay…', group: 'commands', run: () => $('#btn-add-overlay').click() },
  { id: 'view.fit', title: 'Timeline: Fit the Whole Film', group: 'commands', run: () => zoomFit() },
  { id: 'view.rail', title: 'View: Toggle Side Bar', group: 'commands', run: () => $('#btn-explorer').click() },
  { id: 'edit.undo', title: 'Edit: Undo', group: 'commands', run: () => undo() },
  { id: 'edit.redo', title: 'Edit: Redo', group: 'commands', run: () => redo() },
  { id: 'src.preview', title: 'Player: Watch the Scenes as They Stand', group: 'commands', run: () => setSource('preview') },
  { id: 'src.delivery', title: 'Player: Watch the Last Built Film', group: 'commands', run: () => setSource('delivery') },
  ...['scene', 'config', 'audio', 'assets', 'outputs'].map((t) => ({
    id: `insp.${t}`,
    title: `Inspector: ${t[0].toUpperCase()}${t.slice(1)}`,
    group: 'commands',
    when: () => state.selection?.kind === 'scene',
    run: () => { state.sceneTab = t; renderInspector(); },
  })),
]);

/* --------------------------------- name --------------------------------- */

$('#film-name').addEventListener('change', () => {
  const v = $('#film-name').value.trim();
  if (!v) { $('#film-name').value = state.film.name; return; }
  mutate((film) => { film.name = v; }, { silent: true });
  document.title = `${v} — Motion Studio`;
  StudioUtil.syncDocument();
});
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

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
  wireProductionLoop();
  try {
    await refresh();
  } catch (err) {
    toastError(err);
    document.body.innerHTML = `<p style="padding:40px" class="dim">Could not load film: ${err.message} (<a href="/">back to the Studio</a>)</p>`;
    return;
  }
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
