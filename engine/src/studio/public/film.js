/* Motion Studio — Film Editor (vanilla JS, no build step).
 *
 * Edits ONE saved film (/film.html?id=<filmId>, the id a "ws/film" slug path
 * sent URL-encoded as one segment): an ordered scene list plus master audio /
 * caption / overlay tracks, persisted through PATCH /api/films/:id. Scenes
 * and assets belong to the film's own folder (scenes/, assets/, out/); a
 * scene's full id is `${filmId}/${slug}`. The timeline is the document; every
 * block is data first (film.audio[n], film.captions[n], …) and pixels second.
 *
 * Preview honesty:
 *  - Video plays the scenes' REAL rendered outputs back to back (two <video>
 *    elements double-buffer across cuts).
 *  - Master audio auditions through POST /api/films/:id/preview-audio — the
 *    build's exact ffmpeg mix (gains, fades, trims, sidechain ducking,
 *    limiter). A WebAudio approximation of that graph would lie about
 *    ducking, so we don't approximate.
 *  - Overlays and captions are drawn as DOM layers, geometrically identical
 *    to what the finishing pass burns in.
 */

'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { data });
  return data;
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------- toasts -------------------------------- */

function toast(input, { kind = 'error', timeoutMs = null } = {}) {
  let el = $('#toasts');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toasts';
    document.body.appendChild(el);
  }
  const err = input instanceof Error ? input : null;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  const code = err?.data?.code;
  if (code) {
    const badge = document.createElement('span');
    badge.className = 'toast-code mono';
    badge.textContent = code;
    t.appendChild(badge);
  }
  const body = document.createElement('span');
  body.className = 'toast-body';
  body.textContent = err ? err.message : String(input);
  t.appendChild(body);
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '✕';
  close.addEventListener('click', () => t.remove());
  t.appendChild(close);
  el.appendChild(t);
  const ttl = timeoutMs ?? (kind === 'error' ? null : 5000);
  if (ttl) setTimeout(() => t.remove(), ttl);
}
const toastError = (e) => toast(e, { kind: 'error' });

/* -------------------------------- state -------------------------------- */

const HEAD_W = 128;   // sticky track-header column (matches .tl-head width)
const TAIL_PX = 220;  // slack after the last frame so end-of-film blocks stay grabbable
const FALLBACK_CLIP_FRAMES = 90; // audio block length until the clip is decoded

const filmId = new URLSearchParams(location.search).get('id');

const state = {
  film: null,        // the editable document (what PATCH sends)
  detail: null,      // server-resolved reality: scene layout, problems, fps…
  assets: [],        // the film's own assets (media bin)
  pxf: 1,            // pixels per frame (zoom)
  pxfFit: 1,
  snap: true,
  playhead: 0,       // float frames
  playing: false,
  play: { t0: 0, frame0: 0, raf: 0 },
  selection: null,   // {kind:'scene',index} | {kind:'audio'|'caption'|'overlay', id} | null
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
  sceneFolders: [],      // scenes rail: the film's scene folders (incl. unlisted)
  overlayEls: new Map(), // overlay id -> preview element
};

const fps = () => state.detail?.fps || 30;
const totalFrames = () => state.detail?.totalFrames || 0;
// Ids are slug paths ("ws/film", "ws/film/scene") sent as ONE encoded segment.
const fid = encodeURIComponent(filmId ?? '');
const sceneApi = (slug) => `/api/scenes/${encodeURIComponent(`${filmId}/${slug}`)}`;
const assetUrl = (rel) => `/api/films/${fid}/asset?path=${encodeURIComponent(rel)}`;
const sceneSrc = (s) => `${sceneApi(s.slug)}/output?file=${encodeURIComponent(s.outputFile)}`;
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
  'audioTargetPeakDb', 'burnCaptions', 'outputFilename'];

function snapshot() {
  return JSON.parse(JSON.stringify(Object.fromEntries(EDITABLE.map((k) => [k, state.film[k]]))));
}

function setSaveState(text, cls = '') {
  const el = $('#save-state');
  el.textContent = text;
  el.className = `mono ${cls || 'dim'}`;
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
    const { film, detail } = await api(`/api/films/${fid}`, { method: 'PATCH', body: { patch: JSON.parse(sent) } });
    // Only adopt the server's film if nothing changed while the PATCH was in
    // flight — otherwise the response would clobber keystrokes.
    if (JSON.stringify(snapshot()) === sent) {
      state.film = film;
      state.dirty = false;
      setSaveState('saved ✓');
    }
    adoptDetail(detail);
    renderTimeline(); // scene offsets / problems may have moved
  } catch (err) {
    setSaveState('save failed', 'err');
    toastError(err);
  } finally {
    state.saving = false;
    if (state.dirty) scheduleSave();
  }
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
  const { film, detail, sceneFolders } = await api(`/api/films/${fid}`);
  state.film = film;
  state.sceneFolders = sceneFolders ?? [];
  lastAudioJson = JSON.stringify(film.audio ?? []);
  adoptDetail(detail);
  $('#film-name').value = film.name;
  document.title = `${film.name} — Motion Studio Film Editor`;
  await loadAssets();
  renderAll();
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
  btn.textContent = `⚠ ${problems.length} issue${problems.length === 1 ? '' : 's'}`;
  const HARD = new Set(['scene_missing', 'signature_mismatch', 'format_not_concatenatable', 'asset_missing', 'mixed_scene_audio']);
  const ul = $('#problems-list');
  ul.innerHTML = '';
  for (const p of problems) {
    const li = document.createElement('li');
    li.textContent = p.message;
    li.classList.toggle('hard', HARD.has(p.code));
    ul.appendChild(li);
  }
  if (!problems.length) $('#problems-panel').classList.add('hidden');
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

function syncVideo(frame) {
  const { scene, index } = sceneAt(frame);
  const ph = $('#scene-placeholder');
  if (!scene || !scene.rendered) {
    videoEls.forEach((v) => { v.classList.remove('active'); v.pause(); });
    activeVideo = null;
    ph.classList.remove('hidden');
    ph.querySelector('.ph-name').textContent = scene ? scene.name : (totalFrames() ? 'gap' : 'no scenes yet');
    ph.querySelector('.ph-note').textContent = scene ? 'scene not rendered — render it to preview' : 'add scenes with “+ scene”';
    return;
  }
  ph.classList.add('hidden');

  const src = sceneSrc(scene);
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
  el.className = 'mono';
  if (!hasAudio) { el.textContent = ''; return; }
  if (m.building) { el.textContent = '⏳ mixing audio…'; el.classList.add('building'); }
  else if (m.url && !m.dirty) { el.textContent = '♪ master mix ready'; el.classList.add('ready'); }
  else { el.textContent = '♪ mix on next play'; el.classList.add('dim'); }
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
  for (const el of state.overlayEls.values()) el.pause?.();
}

function tick(now) {
  if (!state.playing) return;
  let f;
  if (state.mix.active && state.mix.el && !state.mix.el.ended) {
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

  /* scenes */
  {
    const { row: r, head, lane } = row('row-scenes', 'scenes', laneW);
    const add = document.createElement('button');
    add.className = 'lane-add';
    add.textContent = '+';
    add.title = 'add scenes — drag one from the left rail, or create a new one there';
    add.addEventListener('click', revealScenesRail);
    head.appendChild(add);
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

  /* playhead */
  const ph = document.createElement('div');
  ph.className = 'tl-playhead';
  ph.id = 'tl-playhead';
  ph.style.left = `${HEAD_W + state.playhead * state.pxf}px`;
  inner.appendChild(ph);

  sc.scrollLeft = keepScroll.left;
  sc.scrollTop = keepScroll.top;
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
  const el = baseBlock('scene', index, x, w, 'blk-scene');
  if (!s.rendered) el.classList.add('unrendered');
  const mismatch = (state.detail.problems ?? []).some((p) => p.code === 'signature_mismatch' && p.sceneId === s.sceneId);
  if (mismatch) el.classList.add('mismatch');

  const dot = document.createElement('span');
  dot.className = 'sc-status';
  dot.title = s.missing ? 'scene folder missing' : s.rendered ? 'rendered' : 'not rendered yet';
  const label = document.createElement('span');
  label.className = 'blk-label';
  label.textContent = s.missing ? `⚠ missing (${s.slug})` : s.name;
  const dur = document.createElement('span');
  dur.className = 'sc-dur';
  const job = state.sceneJobs.get(s.slug);
  dur.textContent = job && !['done', 'error', 'cancelled'].includes(job.state)
    ? `render ${job.percent ?? 0}%`
    : `${s.durationInFrames ?? 0}f`;
  el.append(dot, label, dur);

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
  for (const b of document.querySelectorAll('.blk')) {
    const on = !!sel && sel.kind === b.dataset.kind
      && String(sel.kind === 'scene' ? sel.index : sel.id) === b.dataset.id;
    b.classList.toggle('selected', on);
  }
  renderInspector();
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stopPlayback() : startPlayback(); }
  else if (e.code === 'ArrowLeft') { stopPlayback(); setPlayhead(Math.floor(state.playhead) - (e.shiftKey ? 10 : 1)); }
  else if (e.code === 'ArrowRight') { stopPlayback(); setPlayhead(Math.floor(state.playhead) + (e.shiftKey ? 10 : 1)); }
  else if (e.code === 'Home') { stopPlayback(); setPlayhead(0); }
  else if (e.code === 'End') { stopPlayback(); setPlayhead(totalFrames() - 1); }
  else if (e.key === '+' || e.key === '=') zoomBy(1.3);
  else if (e.key === '-') zoomBy(1 / 1.3);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) { e.preventDefault(); deleteSelection(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); scheduleSave({ now: true }); }
  else if (e.code === 'Escape') select(null);
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

function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  if (state.inspectorMode === 'build') return renderBuildInspector(box);
  const sel = state.selection;
  if (!sel) return renderFilmInspector(box);
  if (sel.kind === 'scene') return renderSceneInspector(box, sel.index);
  if (sel.kind === 'audio') return renderAudioInspector(box, sel.id);
  if (sel.kind === 'caption') return renderCaptionInspector(box, sel.id);
  if (sel.kind === 'overlay') return renderOverlayInspector(box, sel.id);
}

function renderFilmInspector(box) {
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

  box.appendChild(el('hr', { class: 'sep' }));
  box.appendChild(el('p', { class: 'dim note', text: 'Select a block on the timeline to edit it. Drag blocks to move, drag edges to trim, Del to remove.' }));
}

function renderSceneInspector(box, index) {
  const s = state.detail.scenes[index];
  if (!s) return renderFilmInspector(box);
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
    row1.appendChild(el('a', { class: 'ghost', href: `/?scene=${encodeURIComponent(s.sceneId)}`, target: '_blank', text: 'open scene ↗', style: 'text-decoration:none' }));
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
  box.appendChild(el('p', { class: 'dim note', text: 'Each scene is its own folder inside the film, stitched losslessly — open it, edit the composition, re-render, and the film picks the new output up automatically. Removing a scene only drops it from the play order; the folder stays in the rail as unlisted.' }));
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

/* --------------------------------- zoom --------------------------------- */

function computeFit() {
  const sc = $('#tl-scroll');
  state.pxfFit = Math.max(0.005, (sc.clientWidth - HEAD_W - TAIL_PX / 2) / Math.max(1, totalFrames()));
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
function zoomBy(factor) { setPxf(state.pxf * factor); }
$('#btn-zoom-in').addEventListener('click', () => zoomBy(1.3));
$('#btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));
$('#btn-zoom-fit').addEventListener('click', () => { computeFit(); setPxf(state.pxfFit, 0); });
$('#zoom-slider').addEventListener('input', (e) => {
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

/* The scenes rail: every scene folder in the film, one drag away from the
 * play order. Folders the document lists are flagged "in film" (a scene
 * plays once, so they are inert); folders on disk the play order does not
 * reference are `unlisted` and can be dragged in (or appended with +).
 * "+ new scene" scaffolds a fresh folder — the server appends it. */

function sceneCompat(f) {
  // Compatibility against the film's established signature (first scene wins).
  const d = state.detail;
  if (!d?.signature || f.missing) return { ok: true };
  const s = d.scenes.find((x) => x.slug === f.slug && !x.missing);
  if (s) return { ok: s.signature === d.signature, sig: s.signature };
  // Unlisted folder: resolution/fps/format are known; alpha and pixFmt only
  // resolve server-side after adding — flagged then if wrong.
  return { ok: d.signature.startsWith(`${f.width}x${f.height}@${f.fps}/${f.format}/`) ? null : false };
}

function renderScenesRail() {
  const ul = $('#fe-scene-list');
  if (!ul || !state.film) return;
  ul.innerHTML = '';
  const rows = state.sceneFolders ?? [];
  if (!rows.length) {
    ul.innerHTML = '<li class="pick-empty">no scenes yet — start with “+ new scene” below</li>';
    return;
  }
  const listedSlugs = new Set(state.film.scenes.map((s) => s.slug));
  for (const f of rows) {
    const li = document.createElement('li');
    const listed = listedSlugs.has(f.slug);
    if (listed) li.classList.add('listed');
    li.title = listed
      ? 'in the play order — select its block on the timeline'
      : 'drag onto the timeline to place, or + to append';
    const compat = sceneCompat(f);
    if (compat.ok === false || f.missing) li.classList.add('incompat');
    const name = el('span', { class: 'sr-name', text: f.name ?? f.slug });
    li.appendChild(name);
    if (!listed && !f.missing) {
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
    meta.appendChild(el('span', {
      class: `sr-flag${listed ? '' : ' unlisted'}`,
      text: listed ? 'in film' : 'unlisted',
    }));
    li.appendChild(meta);
    if (!listed && !f.missing) li.addEventListener('pointerdown', (ev) => dragSceneFromRail(ev, f));
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
  mutate((film) => film.scenes.splice(index, 0, { slug }), { structural: true, silent: true });
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

function revealScenesRail() {
  document.querySelector('.fe-frame').classList.remove('rail-collapsed');
  const rail = $('#fe-scenes');
  rail.classList.remove('pulse');
  void rail.offsetWidth; // restart the animation
  rail.classList.add('pulse');
}
$('#btn-scenes-collapse').addEventListener('click', () => {
  document.querySelector('.fe-frame').classList.toggle('rail-collapsed');
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

  const name = el('input', { id: 'bi-filename', placeholder: 'film', spellcheck: 'false' });
  name.value = f.outputFilename ?? 'film';
  box.appendChild(el('div', { class: 'insp-row' }, labelled('output filename', name)));

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

  const go = el('button', { class: 'primary', id: 'bi-go', text: 'assemble →', style: 'width:100%' });
  go.addEventListener('click', startBuild);
  box.appendChild(go);

  // Job card — same ids the poller writes into.
  const job = el('div', { class: 'job-card', id: 'build-job' });
  job.innerHTML =
    '<div class="job-line"><span id="bj-state" class="pill">—</span>' +
    '<span id="bj-phase" class="mono dim"></span><span id="bj-eta" class="mono dim"></span>' +
    '<button id="bj-cancel" class="ghost danger">cancel</button></div>' +
    '<div class="bar"><div id="bj-bar" class="bar-fill"></div></div>' +
    '<pre id="bj-logs" class="logs"></pre>' +
    '<div id="bj-levels" class="levels hidden"></div>' +
    '<a id="bj-download" class="download hidden" href="#">⤓ download film</a>';
  if (!state.buildJobId) job.classList.add('hidden');
  box.appendChild(job);
  $('#bj-cancel').addEventListener('click', () => {
    if (state.buildJobId) api(`/api/jobs/${state.buildJobId}/cancel`, { method: 'POST' }).catch(() => {});
  });
  if (state.lastBuild) updateBuildUI(state.lastBuild.status, state.lastBuild.logs);
}

async function startBuild() {
  try {
    const body = {
      outputFilename: $('#bi-filename').value.trim() || 'film',
      audioTargetPeakDb: $('#bi-target').value === '' ? null : Number($('#bi-target').value),
      burnCaptions: $('#bi-burn').checked,
    };
    const submitted = await api(`/api/films/${fid}/build`, { method: 'POST', body });
    state.film.outputFilename = body.outputFilename;
    state.film.audioTargetPeakDb = body.audioTargetPeakDb;
    state.film.burnCaptions = body.burnCaptions;
    state.buildJobId = submitted.jobId;
    state.lastBuild = null;
    $('#build-job')?.classList.remove('hidden');
    $('#bj-download')?.classList.add('hidden');
    $('#bj-levels')?.classList.add('hidden');
    pollBuild();
  } catch (err) { toastError(err); }
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

/* --------------------------------- name --------------------------------- */

$('#film-name').addEventListener('change', () => {
  const v = $('#film-name').value.trim();
  if (!v) { $('#film-name').value = state.film.name; return; }
  mutate((film) => { film.name = v; }, { silent: true });
  document.title = `${v} — Motion Studio Film Editor`;
});
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

/* --------------------------------- boot --------------------------------- */

function renderAll() {
  renderHeader();
  computeFit();
  // Fit-zoom on first load — and again when the film gains its first scene,
  // because a fit computed against zero frames is meaningless.
  if (!state._zoomInit || (state._zoomInitFrames === 0 && totalFrames() > 0)) {
    state.pxf = clamp(state.pxfFit, 0.002, 24);
    state._zoomInit = true;
    state._zoomInitFrames = totalFrames();
    setZoomSlider();
  }
  renderTimeline();
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
  try {
    await refresh();
  } catch (err) {
    toastError(err);
    document.body.innerHTML = `<p style="padding:40px" class="dim">Could not load film: ${err.message} (<a href="/">back to the Studio</a>)</p>`;
  }
})();
