/* Motion Studio — Studio UI logic (vanilla JS, no build step).
 *
 * The preview iframe loads the project's real entry HTML from /preview/:id/
 * (same origin), and the transport drives it through the identical
 * window.setFrame(n) contract the headless renderer uses. */

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

const state = {
  projects: [],
  projectId: null,
  projectPath: null,
  config: null,
  frame: 0,
  playing: false,
  playTimer: null,
  events: null, // SSE
  jobId: null,
  jobTimer: null,
  frameReady: Promise.resolve(),
  settings: null,       // global settings (GET /api/settings)
  audioPreview: null,   // shared <audio> for asset auditioning
  audioDraft: [],       // staged config.audio edits (saved with one PATCH)
};

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
  } catch {
    $('#engine-status').innerHTML = 'engine <span class="err">unreachable</span>';
  }
}

/* ------------------------------ projects ------------------------------ */

let sortMode = localStorage.getItem('ms.sortMode') || 'name'; // 'name' | 'date'

function syncSortButtons() {
  $('#sort-name').classList.toggle('active', sortMode === 'name');
  $('#sort-date').classList.toggle('active', sortMode === 'date');
}
for (const mode of ['name', 'date']) {
  $(`#sort-${mode}`).addEventListener('click', () => {
    sortMode = mode;
    localStorage.setItem('ms.sortMode', mode);
    syncSortButtons();
    renderProjectList();
  });
}
syncSortButtons();

function renderProjectList() {
  const projects = [...state.projects];
  if (sortMode === 'name') projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  else projects.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1)); // newest first
  const ul = $('#project-list');
  ul.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.className = (p.id === state.projectId ? 'active ' : '') + (p.missing ? 'missing' : '');
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;
    name.title = p.name;
    const meta = document.createElement('span');
    meta.className = 'p-meta';
    meta.textContent = p.missing ? 'missing' : sortMode === 'date' ? (p.lastModified ?? '').slice(0, 10) : '';
    li.append(name, meta);
    if (!p.missing) li.addEventListener('click', () => selectProject(p.id));
    ul.appendChild(li);
  }
}

async function loadProjects() {
  const { projects } = await api('/api/projects');
  state.projects = projects;
  renderProjectList();
}

async function selectProject(id) {
  stopPlayback();
  stopAudition(); // a clip from the previous project would keep playing with its stop button gone
  stopJobPolling();
  if (!$('#vendors-page').classList.contains('hidden')) showVendorsPage(false); // picking a project leaves the vendors page
  state.events?.close();
  state.projectId = id;
  const proj = await api(`/api/projects/${id}`);
  state.config = proj.config;
  state.frame = 0;

  state.projectPath = proj.path;

  $('#empty-state').classList.add('hidden');
  $('#workbench').classList.remove('hidden');
  $('#project-title').textContent = proj.name;
  const sep = proj.path.includes('\\') ? '\\' : '/';
  const pathEl = $('#project-path');
  pathEl.textContent = proj.path;
  pathEl.title = proj.path;
  const assetsEl = $('#assets-path');
  assetsEl.textContent = proj.path + sep + 'assets';
  assetsEl.title = assetsEl.textContent;
  updateMeta();
  fillConfigForm();
  loadOutputs().catch(() => {});
  loadAssets().catch(() => {});
  loadAudioEditor().catch(() => {}); // resets any staged track edits from the previous project
  await loadProjects(); // refresh active highlight

  // Hot reload stream.
  const es = new EventSource(`/api/projects/${id}/events`);
  const dot = $('#hot-reload-dot');
  es.onopen = () => dot.classList.add('live');
  es.onmessage = () => {
    dot.classList.add('flash');
    setTimeout(() => dot.classList.remove('flash'), 400);
    reloadPreview({ refetchConfig: true });
  };
  es.onerror = () => dot.classList.remove('live');
  state.events = es;

  reloadPreview();
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

/* ------------------------------ preview ------------------------------- */

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
  $('#checker').style.display = state.config.output.transparent ? 'block' : 'none';
}

async function reloadPreview({ refetchConfig = false } = {}) {
  if (refetchConfig) {
    try {
      const proj = await api(`/api/projects/${state.projectId}`);
      state.config = proj.config;
      updateMeta();
      fillConfigForm();
    } catch { /* keep previous */ }
  }
  const iframe = $('#preview');
  const entry = state.config.entry || 'composition.html';
  iframe.src = `/preview/${state.projectId}/${entry}?t=${Date.now()}`;
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

/* ----------------------------- transport ------------------------------ */

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
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || !state.config) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stopPlayback() : startPlayback(); }
  if (e.code === 'ArrowLeft') { stopPlayback(); applyFrame(Math.max(0, state.frame - 1)); }
  if (e.code === 'ArrowRight') { stopPlayback(); applyFrame(Math.min(state.config.durationInFrames - 1, state.frame + 1)); }
});
window.addEventListener('resize', fitPreview);

/* ------------------------------- config ------------------------------- */

/* Which output fields each format actually consumes — mirrors core/formats.js.
 * Irrelevant fields are shown disabled rather than hidden, so the config tab
 * is a complete picture of project.json instead of a curated subset. */
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

function applyFormatCaps() {
  const f = $('#config-form');
  const caps = FORMAT_CAPS[f.format.value] ?? FORMAT_CAPS.mp4;
  for (const [field, on] of Object.entries({ crf: caps.crf, preset: caps.preset, pixFmt: caps.pixFmt, transparent: caps.transparent, audioLimiter: caps.audio })) {
    const el = f[field];
    el.disabled = !on;
    el.closest('label').classList.toggle('disabled', !on);
  }
  $('#format-note').textContent = FORMAT_NOTES[f.format.value] ?? '';
}

function fillConfigForm() {
  const f = $('#config-form');
  const c = state.config;
  const o = c.output;
  f.name.value = c.name;
  f.fps.value = c.fps;
  f.width.value = c.width;
  f.height.value = c.height;
  f.durationInFrames.value = c.durationInFrames;
  f.format.value = o.format;
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

$('#config-form').format.addEventListener('change', applyFormatCaps);

/** Everything in project.json the form cannot edit, shown rather than hidden. */
function fillConfigFacts() {
  const c = state.config;
  const dl = $('#config-facts');
  dl.innerHTML = '';
  const row = (k, v, dim = false) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dd.classList.toggle('dim', dim);
    dl.append(dt, dd);
  };
  row('entry', c.entry);
  row('schema', `v${c.schemaVersion ?? 1}`);
  row('audio tracks', String(c.audio?.length ?? 0), !c.audio?.length);
  const libs = c.libraries ?? [];
  row('libraries', libs.length ? libs.join(', ') : 'none', !libs.length);
  for (const [file, b] of Object.entries(c.libraryBuilds ?? {})) {
    row(`  ${file}`, `${b.version ?? 'unknown'} · ${b.sha256.slice(0, 12)}… · ${fmtBytes(b.bytes)}`, true);
  }
  $('#raw-config-body').textContent = JSON.stringify(c, null, 2);
}

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#config-msg');
  msg.textContent = '…';
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
    const { config } = await api(`/api/projects/${state.projectId}/config`, { method: 'PATCH', body: { patch } });
    state.config = config;
    updateMeta();
    fillConfigForm();
    msg.textContent = 'saved ✓';
    loadProjects();
    reloadPreview();
  } catch (err) {
    msg.textContent = err.message;
  }
  setTimeout(() => { msg.textContent = ''; }, 4000);
});

/* ------------------------------- render ------------------------------- */

function parseRange(text, total) {
  const t = text.trim();
  if (!t) return undefined;
  const m = /^(\d+)\s*[-–:]\s*(\d+)$/.exec(t);
  if (!m) throw new Error('range must look like 0-89');
  const range = [Number(m[1]), Number(m[2])];
  if (range[1] >= total) throw new Error(`end frame max is ${total - 1}`);
  return range;
}

$('#btn-render').addEventListener('click', async () => {
  try {
    const body = {
      workers: Number($('#rd-workers').value),
      frameRange: parseRange($('#rd-range').value, state.config.durationInFrames),
    };
    const job = await api(`/api/projects/${state.projectId}/render`, { method: 'POST', body });
    trackJob(job.jobId);
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-still').addEventListener('click', async () => {
  try {
    const res = await api(`/api/projects/${state.projectId}/still`, { method: 'POST', body: { frame: state.frame } });
    loadOutputs();
    const a = $('#job-download');
    $('#job-card').classList.remove('hidden');
    a.classList.remove('hidden');
    a.textContent = `⤓ ${res.outputPath.split(/[\\/]/).pop()} (frame ${res.frame})`;
    a.href = `/api/projects/${state.projectId}/output?file=${encodeURIComponent(res.outputPath.split(/[\\/]/).pop())}&download=1`;
  } catch (err) {
    alert(err.message);
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
      const { logs } = await api(`/api/jobs/${jobId}/logs?tail=40`);
      $('#job-logs').textContent = logs.map((l) => `[${l.level}] ${l.message}`).join('\n');

      if (['done', 'error', 'cancelled'].includes(s.state)) {
        stopJobPolling();
        $('#btn-cancel').disabled = true;
        $('#job-eta').textContent = '';
        if (s.state === 'done') {
          $('#job-bar').style.width = '100%';
          const file = s.outputPath.split(/[\\/]/).pop();
          const a = $('#job-download');
          a.classList.remove('hidden');
          a.textContent = `⤓ ${file}`;
          a.href = `/api/projects/${state.projectId}/output?file=${encodeURIComponent(file)}&download=1`;
        }
        loadOutputs().catch(() => {});
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

/* ------------------------------- outputs ------------------------------ */

const fmtBytes = (n) => (n == null ? '—' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB');

async function loadOutputs() {
  const { files } = await api(`/api/projects/${state.projectId}/outputs`);
  const ul = $('#output-list');
  ul.innerHTML = '';
  if (!files.length) {
    ul.innerHTML = '<li class="dim">no outputs yet — render something</li>';
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    if (f.dir) {
      li.innerHTML = `<span>${f.name}/ <span class="dim">(png sequence)</span></span><span class="size">folder</span>`;
    } else {
      const a = document.createElement('a');
      a.textContent = f.name;
      a.href = `/api/projects/${state.projectId}/output?file=${encodeURIComponent(f.name)}&download=1`;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = fmtBytes(f.bytes);
      li.append(a, size);
    }
    ul.appendChild(li);
  }
}

/* ---------------------------- audition player --------------------------- */

/* One player shared by the assets and audio tabs: starting a clip stops
 * whatever was playing, clicking the same clip again stops it, and every
 * button falls back to ▶ when playback ends, errors, or is superseded.
 * Deliberately one function — the two tabs previously had their own copies
 * and the audio tab's could start a clip but never stop it. */

const auditionButtons = () => document.querySelectorAll('.audition-btn');

function resetAuditionButtons() {
  for (const b of auditionButtons()) {
    b.textContent = '▶';
    b.classList.remove('playing');
  }
}

/** Re-mark the ⏸ after a list re-renders, so a clip playing from the assets
 *  tab still shows a stop control on its row in the audio tab (and vice versa). */
function syncAuditionButtons() {
  const cur = state.audioPreview;
  const playing = cur && !cur.paused ? cur.dataset.src : null;
  for (const b of auditionButtons()) {
    const on = !!playing && b.dataset.src === playing;
    b.textContent = on ? '⏸' : '▶';
    b.classList.toggle('playing', on);
  }
}

function stopAudition() {
  state.audioPreview?.pause();
  state.audioPreview = null;
  resetAuditionButtons();
}

function toggleAudition(relPath, btn) {
  const src = (relPath ?? '').trim();
  const cur = state.audioPreview;
  // Second click on the clip that is currently playing = stop.
  if (cur && !cur.paused && cur.dataset.src === src) {
    stopAudition();
    return;
  }
  stopAudition();
  if (!src) return; // a track row with no path yet

  const audio = new Audio(assetPreviewUrl(src));
  audio.dataset.src = src;
  audio.addEventListener('ended', resetAuditionButtons);
  audio.addEventListener('error', resetAuditionButtons); // typo'd path: don't strand a ⏸
  audio.play().catch(resetAuditionButtons);
  state.audioPreview = audio;
  btn.textContent = '⏸';
  btn.classList.add('playing');
}

/* -------------------------------- audio -------------------------------- */

/* config.audio is the only part of project.json with real structure, and it
 * was previously invisible in the UI — you had to hand-edit JSON to see what a
 * film's timeline was. Edits are staged in state.audioDraft and written with
 * one PATCH, so a half-typed path never reaches disk. */

function audioRow(track, index) {
  const li = document.createElement('li');

  const src = document.createElement('input');
  src.className = 'mono t-src';
  src.value = track.src ?? '';
  src.placeholder = 'assets/music.mp3';
  src.setAttribute('list', 'audio-asset-options');
  src.spellcheck = false;
  src.addEventListener('input', () => { state.audioDraft[index].src = src.value; markAudioDirty(); });

  const start = document.createElement('input');
  start.type = 'number';
  start.className = 'mono t-num';
  start.min = '0';
  start.value = track.startInFrames ?? 0;
  start.title = 'start frame';
  start.addEventListener('input', () => {
    state.audioDraft[index].startInFrames = start.value === '' ? 0 : Number(start.value);
    markAudioDirty();
    updateAudioSeconds(li, state.audioDraft[index]);
  });

  const gain = document.createElement('input');
  gain.type = 'number';
  gain.className = 'mono t-num';
  gain.step = '0.5';
  gain.value = track.gainDb ?? 0;
  gain.title = 'gain in dB';
  gain.addEventListener('input', () => {
    state.audioDraft[index].gainDb = gain.value === '' ? 0 : Number(gain.value);
    markAudioDirty();
  });

  const play = document.createElement('button');
  play.className = 'ghost a-btn audition-btn';
  play.textContent = '▶';
  play.title = 'audition this file';
  play.addEventListener('click', () => toggleAudition(state.audioDraft[index].src, play));
  // Nothing to audition until the row has a path.
  const syncPlayEnabled = () => {
    play.disabled = !src.value.trim();
    play.dataset.src = src.value.trim();
  };
  src.addEventListener('input', syncPlayEnabled);
  syncPlayEnabled();

  const del = document.createElement('button');
  del.className = 'ghost a-btn danger';
  del.textContent = 'remove';
  del.addEventListener('click', () => {
    state.audioDraft.splice(index, 1);
    renderAudioList();
    markAudioDirty();
  });

  const at = document.createElement('span');
  at.className = 't-at dim mono';

  li.append(
    labelled('src', src), labelled('start', start), at,
    labelled('gain dB', gain), play, del,
  );
  updateAudioSeconds(li, track);
  return li;
}

function labelled(text, input) {
  const l = document.createElement('label');
  l.className = text === 'src' ? 'grow' : '';
  l.textContent = text;
  l.appendChild(input);
  return l;
}

function updateAudioSeconds(li, track) {
  const fps = state.config?.fps ?? 30;
  li.querySelector('.t-at').textContent = `= ${((track.startInFrames ?? 0) / fps).toFixed(2)}s`;
}

function markAudioDirty() {
  $('#audio-msg').textContent = 'unsaved changes';
  $('#audio-msg').classList.add('warn');
}

function renderAudioList() {
  const ul = $('#audio-list');
  ul.innerHTML = '';
  if (!state.audioDraft.length) {
    ul.innerHTML = '<li class="dim">no audio tracks — add one, or leave empty for a silent render</li>';
  } else {
    state.audioDraft.forEach((t, i) => ul.appendChild(audioRow(t, i)));
  }
  syncAuditionButtons();
  const caps = FORMAT_CAPS[state.config?.output?.format] ?? FORMAT_CAPS.mp4;
  $('#audio-note').textContent = caps.audio
    ? 'Paths are project-relative. Tracks mix without normalization and are trimmed/padded to the video length.'
    : `Note: ${state.config.output.format} cannot carry audio — these tracks are skipped at render time with a warning in the logs.`;
}

async function loadAudioEditor() {
  state.audioDraft = structuredClone(state.config.audio ?? []);
  $('#audio-msg').textContent = '';
  $('#audio-msg').classList.remove('warn');
  renderAudioList();
  // Offer the project's audio assets as autocomplete for src.
  try {
    const { files } = await api(`/api/projects/${state.projectId}/assets`);
    const dl = $('#audio-asset-options');
    dl.innerHTML = '';
    for (const f of files.filter((x) => x.kind === 'audio')) {
      const opt = document.createElement('option');
      opt.value = f.path;
      dl.appendChild(opt);
    }
  } catch { /* autocomplete is a nicety */ }
}

$('#btn-add-track').addEventListener('click', () => {
  state.audioDraft.push({ src: '', startInFrames: 0, gainDb: 0 });
  renderAudioList();
  markAudioDirty();
  $('#audio-list').querySelector('li:last-child .t-src')?.focus();
});

$('#btn-save-audio').addEventListener('click', async () => {
  const msg = $('#audio-msg');
  const tracks = state.audioDraft.filter((t) => t.src.trim());
  msg.classList.remove('warn');
  msg.textContent = '…';
  try {
    const { config } = await api(`/api/projects/${state.projectId}/config`, {
      method: 'PATCH',
      body: { patch: { audio: tracks } },
    });
    state.config = config;
    state.audioDraft = structuredClone(config.audio ?? []);
    renderAudioList();
    fillConfigFacts();
    loadAssets().catch(() => {}); // track edits change the assets tab's ♫ badges
    msg.textContent = `saved ✓ (${tracks.length} track${tracks.length === 1 ? '' : 's'})`;
    setTimeout(() => { msg.textContent = ''; }, 4000);
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('warn');
  }
});

/* ------------------------------- assets ------------------------------- */

const assetPreviewUrl = (rel) =>
  `/preview/${state.projectId}/${rel.split('/').map(encodeURIComponent).join('/')}`;

const KIND_GLYPH = { image: '🖼', audio: '♫', font: 'Aa', data: '⧉' };

async function loadAssets() {
  const { files } = await api(`/api/projects/${state.projectId}/assets`);
  const ul = $('#asset-list');
  ul.innerHTML = '';
  if (!files.length) {
    ul.innerHTML = '<li class="dim">no assets yet — upload files, or drop them into the assets/ folder on disk</li>';
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');

    const thumb = document.createElement('span');
    thumb.className = 'a-thumb';
    if (f.kind === 'image') {
      const img = document.createElement('img');
      img.src = `${assetPreviewUrl(f.path)}?t=${f.mtime}`;
      img.alt = '';
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else if (f.kind === 'audio') {
      const play = document.createElement('button');
      play.className = 'a-play audition-btn';
      play.title = 'audition';
      play.textContent = '▶';
      play.dataset.src = f.path;
      play.addEventListener('click', () => toggleAudition(f.path, play));
      thumb.appendChild(play);
    } else {
      thumb.textContent = KIND_GLYPH[f.kind] ?? '⧉';
    }

    const name = document.createElement('span');
    name.className = 'a-name mono';
    name.textContent = f.path.replace(/^assets\//, '');
    name.title = f.path;

    const size = document.createElement('span');
    size.className = 'a-size dim mono';
    size.textContent = fmtBytes(f.bytes);

    // Referenced-by badge, so the consequence of deleting is visible before
    // the click rather than only in the confirm dialog.
    const badge = document.createElement('span');
    if (f.audioRefs) {
      badge.className = 'a-ref mono';
      badge.textContent = `♫ ${f.audioRefs}`;
      badge.title = `used by ${f.audioRefs} audio track${f.audioRefs === 1 ? '' : 's'}`;
    }

    const actions = document.createElement('span');
    actions.className = 'a-actions';
    const mkBtn = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'ghost a-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    actions.append(
      mkBtn('copy', 'copy the project-relative path (use this in your composition)', (e) => {
        copyText(f.path);
        flashButton(e.target, '✓ copied');
      }),
      mkBtn('rename', 'rename or move within assets/', async () => {
        const to = prompt('New path (must stay under assets/):', f.path);
        if (!to || to === f.path) return;
        // Moving a file out from under an audio track breaks it just as badly
        // as deleting it, and here the repair is unambiguous.
        let updateAudio = false;
        if (f.audioRefs) {
          updateAudio = confirm(
            `${f.audioRefs} audio track${f.audioRefs === 1 ? '' : 's'} reference ${f.path}.\n\n` +
            'OK: point them at the new path.\n' +
            'Cancel: leave them pointing at the old (now missing) file.',
          );
        }
        try {
          const res = await api(`/api/projects/${state.projectId}/asset/rename`, {
            method: 'POST',
            body: { from: f.path, to, updateAudio },
          });
          await afterAssetMutation(res);
        } catch (err) { alert(err.message); }
      }),
      mkBtn('delete', 'delete this asset', () => openAssetDeleteDialog(f)),
    );
    const dl = document.createElement('a');
    dl.className = 'a-btn download-link';
    dl.textContent = '⤓';
    dl.title = 'download';
    dl.href = `/api/projects/${state.projectId}/asset?path=${encodeURIComponent(f.path)}&download=1`;
    actions.appendChild(dl);

    li.append(thumb, name, badge, size, actions);
    ul.appendChild(li);
  }
  syncAuditionButtons();
}

/* An asset delete/rename can also rewrite config.audio, so the endpoints
 * return the new config when they touched it. Adopting it here keeps the
 * audio tab, the config tab's facts and the raw JSON view in step without a
 * second round trip. */
async function afterAssetMutation(result) {
  if (result?.config) {
    state.config = result.config;
    state.audioDraft = structuredClone(result.config.audio ?? []);
    updateMeta();
    fillConfigForm();
    renderAudioList();
  }
  await loadAssets();
}

function openAssetDeleteDialog(f) {
  const dlg = $('#asset-delete-dialog');
  $('#asset-delete-summary').textContent = `Delete ${f.path}?`;
  const refBox = $('#asset-delete-refs');
  refBox.classList.toggle('hidden', !f.audioRefs);
  if (f.audioRefs) {
    $('#asset-delete-count').textContent =
      `${f.audioRefs} audio track${f.audioRefs === 1 ? '' : 's'} in this project reference it.`;
    const ul = $('#asset-delete-list');
    ul.innerHTML = '';
    for (const t of (state.config?.audio ?? []).filter((t) => (t.src ?? '').toLowerCase() === f.path.toLowerCase())) {
      const li = document.createElement('li');
      li.textContent = `${t.src} · start ${t.startInFrames ?? 0}f · ${t.gainDb ?? 0} dB`;
      ul.appendChild(li);
    }
    $('#asset-delete-form').updateAudio.checked = true;
  }
  dlg.dataset.path = f.path;
  dlg.dataset.refs = String(f.audioRefs ?? 0);
  dlg.showModal();
}

$('#btn-asset-delete-cancel').addEventListener('click', () => $('#asset-delete-dialog').close());
$('#asset-delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dlg = $('#asset-delete-dialog');
  const path = dlg.dataset.path;
  const updateAudio = Number(dlg.dataset.refs) > 0 && e.target.updateAudio.checked;
  try {
    const res = await api(
      `/api/projects/${state.projectId}/asset?path=${encodeURIComponent(path)}${updateAudio ? '&updateAudio=1' : ''}`,
      { method: 'DELETE' },
    );
    dlg.close();
    await afterAssetMutation(res);
  } catch (err) {
    alert(err.message);
  }
});

async function uploadAssets(fileList) {
  const errors = [];
  for (const file of fileList) {
    try {
      const res = await fetch(
        `/api/projects/${state.projectId}/asset?path=${encodeURIComponent('assets/' + file.name)}`,
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
  if (errors.length) alert('Some uploads failed:\n' + errors.join('\n'));
}

$('#btn-upload').addEventListener('click', () => $('#asset-file-input').click());
$('#asset-file-input').addEventListener('change', (e) => {
  if (e.target.files.length) uploadAssets([...e.target.files]);
  e.target.value = '';
});
{
  const zone = $('#tab-assets');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dropping'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropping'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dropping');
    if (e.dataTransfer.files.length) uploadAssets([...e.dataTransfer.files]);
  });
}
$('#btn-copy-assets-path').addEventListener('click', (e) => {
  copyText($('#assets-path').textContent);
  flashButton(e.target, '✓');
});

/* --------------------------- project actions --------------------------- */

$('#btn-copy-path').addEventListener('click', (e) => {
  copyText(state.projectPath ?? '');
  flashButton(e.target, '✓');
});

$('#btn-delete-project').addEventListener('click', () => {
  const proj = state.projects.find((p) => p.id === state.projectId);
  $('#delete-summary').textContent = `Delete "${proj?.name ?? state.projectId}"?`;
  $('#delete-form').deleteFiles.checked = false;
  $('#delete-dialog').showModal();
});
$('#btn-delete-cancel').addEventListener('click', () => $('#delete-dialog').close());
$('#delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const deleteFiles = e.target.deleteFiles.checked ? 1 : 0;
  try {
    await api(`/api/projects/${state.projectId}?deleteFiles=${deleteFiles}`, { method: 'DELETE' });
    $('#delete-dialog').close();
    stopPlayback();
    stopJobPolling();
    state.events?.close();
    state.projectId = null;
    state.projectPath = null;
    state.config = null;
    $('#workbench').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    await loadProjects();
  } catch (err) {
    alert(err.message);
  }
});

/* --------------------------- collapsible panel -------------------------- */

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

/* --------------------------- collapsible rail --------------------------- */

function setRailCollapsed(collapsed) {
  $('#frame').classList.toggle('rail-collapsed', collapsed);
  const btn = $('#btn-collapse');
  btn.textContent = collapsed ? '»' : '«';
  btn.title = collapsed ? 'expand sidebar' : 'collapse sidebar';
  localStorage.setItem('ms.railCollapsed', collapsed ? '1' : '');
  fitPreview(); // the stage just changed width
}
$('#btn-collapse').addEventListener('click', () =>
  setRailCollapsed(!$('#frame').classList.contains('rail-collapsed')));
if (localStorage.getItem('ms.railCollapsed') === '1') setRailCollapsed(true);

/* ---------------------------- global settings --------------------------- */

async function loadSettings() {
  const data = await api('/api/settings');
  state.settings = data.settings;
  state.environment = data.environment;
  const w = $('#rd-workers');
  if (!w.dataset.touched) w.value = String(data.settings.render.defaultWorkers);
  return data;
}
$('#rd-workers').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });

$('#btn-settings').addEventListener('click', async () => {
  try {
    const { settings, environment } = await loadSettings();
    const f = $('#settings-form');
    f.fps.value = settings.newProjectDefaults.fps;
    f.width.value = settings.newProjectDefaults.width;
    f.height.value = settings.newProjectDefaults.height;
    f.durationInFrames.value = settings.newProjectDefaults.durationInFrames;
    f.defaultWorkers.value = String(settings.render.defaultWorkers);
    f.ffmpegPath.value = settings.ffmpeg.path ?? '';
    f.ffmpegCrf.value = settings.ffmpeg.defaultCrf ?? '';
    f.ffmpegPreset.value = settings.ffmpeg.defaultPreset ?? '';
    const fp = environment.ffmpeg;
    $('#ffmpeg-probe').innerHTML = fp?.found
      ? `<span class="ok">✓ ${fp.version}</span> via ${fp.source}`
      : `<span class="err">✗ not found</span> (${fp?.effectivePath ?? 'ffmpeg'})`;
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
    row('data dir', environment.dataDir);
    row('projects root', environment.projectsRoot);
    row('settings file', environment.settingsPath);
    for (const [k, v] of Object.entries(environment.env)) row(k, v);
    $('#settings-dialog').showModal();
  } catch (err) {
    alert(err.message);
  }
});
$('#btn-settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#settings-msg');
  msg.textContent = '…';
  try {
    const patch = {
      newProjectDefaults: {
        fps: Number(f.fps.value),
        width: Number(f.width.value),
        height: Number(f.height.value),
        durationInFrames: Number(f.durationInFrames.value),
      },
      render: { defaultWorkers: Number(f.defaultWorkers.value) },
      ffmpeg: {
        path: f.ffmpegPath.value.trim() || null,
        defaultCrf: f.ffmpegCrf.value === '' ? null : Number(f.ffmpegCrf.value),
        defaultPreset: f.ffmpegPreset.value || null,
      },
    };
    const { settings } = await api('/api/settings', { method: 'PATCH', body: { patch } });
    state.settings = settings;
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

/* ----------------------------- speech vendors --------------------------- */

/* v0.17. Narration used to have exactly one source — the Windows speech exe —
 * so there was nothing to choose and nothing to show. With Azure AI Speech
 * alongside it, "which vendor speaks" is a real setting, and it is global: the
 * agents connected over MCP narrate through whatever is picked here.
 *
 * The page is data-driven from GET /api/vendors, but each card's *options* are
 * hand-written markup, because they genuinely differ — an exe path is not a
 * region, and only one of the two has 500 voices worth of filtering. */

const vendorState = {
  report: null,        // the speech report
  music: null,         // the music report
  voices: { system: [], azure: [] },
  preview: null,       // the <audio> auditioning a voice/instrument sample
  formatsFilled: false,
  programsFilled: false,
};

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

function showVendorsPage(on) {
  $('#vendors-page').classList.toggle('hidden', !on);
  if (on) {
    stopAudition();
    $('#workbench').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    stopPlayback();
  } else {
    stopVendorPreview();
    $('#empty-state').classList.toggle('hidden', !!state.projectId);
    $('#workbench').classList.toggle('hidden', !state.projectId);
    if (state.projectId) fitPreview();
  }
}

$('#btn-vendors').addEventListener('click', () => {
  const opening = $('#vendors-page').classList.contains('hidden');
  showVendorsPage(opening);
  if (opening) loadVendors().catch((err) => setVendorMsg(err.message, true));
});
$('#btn-vendors-close').addEventListener('click', () => showVendorsPage(false));
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

  for (const v of data.speech.vendors) paintVendor(v, data.speech);
  paintMusic(data.music);

  // The environment block answers "why is it saying that" without a terminal.
  const { environment } = await api('/api/settings');
  const vendorKeys = Object.keys(environment.env)
    .filter((k) => /SPEECH|TTS_VENDOR|TTS_EXE|MUSIC_VENDOR|SOUNDFONT|FLUIDSYNTH|MIDI_EXE/.test(k));
  defList($('#vendors-env'), vendorKeys.map((k) => [k, environment.env[k]]));

  await Promise.all(data.speech.vendors
    .filter((v) => v.available)
    .map((v) => loadVendorVoices(v.id).catch(() => {})));
}

function paintVendor(v, report) {
  const pill = vendorEl.status(v.id);
  const active = report.active === v.id;
  pill.textContent = v.available ? `ready · ${v.voiceCount} voices` : 'unavailable';
  pill.className = `pill ${v.available ? 'done' : 'error'}`;

  const radio = vendorEl.card(v.id).querySelector('input[name="active-vendor"]');
  radio.checked = active;
  vendorEl.card(v.id).classList.toggle('active', active);

  const err = vendorEl.error(v.id);
  err.classList.toggle('hidden', !v.error);
  err.textContent = v.error ?? '';

  const c = v.config ?? {};
  if (v.id === 'system') {
    defList(vendorEl.facts(v.id), [
      ['executable', withSource(c.exePath, c.exeSource)],
      ['voices', v.available ? String(v.voiceCount) : null],
      ['active', active ? `yes (from ${report.activeSource})` : 'no'],
    ]);
  } else {
    defList(vendorEl.facts(v.id), [
      ['api key', c.keyConfigured ? `${c.keyMasked}  ← ${c.keySource}` : null],
      ['region', withSource(c.region, c.regionSource)],
      ['endpoint', c.endpoint],
      ['voices', v.available ? `${v.voiceCount} · ${v.locales.length} locales` : null],
      ['active', active ? `yes (from ${report.activeSource})` : 'no'],
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
    const active = report.active === v.id;
    pill.textContent = v.available ? 'ready' : 'unavailable';
    pill.className = `pill ${v.available ? 'done' : 'error'}`;

    const card = vendorEl.card(v.id);
    card.querySelector('input[name="active-music-vendor"]').checked = active;
    card.classList.toggle('active', active);

    const err = vendorEl.error(v.id);
    err.classList.toggle('hidden', !v.error);
    err.textContent = v.error ?? '';

    const c = v.config ?? {};
    if (v.id === 'node') {
      defList(vendorEl.facts(v.id), [
        ['soundfont', c.soundfont],
        ['library', c.library],
        ['render', v.available ? `${c.sampleRate} Hz · gain ${c.gain}` : null],
        ['active', active ? `yes (from ${report.activeSource})` : 'no'],
      ]);
    } else {
      defList(vendorEl.facts(v.id), [
        ['midi exe', c.midiExe],
        ['fluidsynth', c.fluidsynth],
        ['soundfont', c.soundfont],
        ['active', active ? `yes (from ${report.activeSource})` : 'no'],
      ]);
    }
  }

  const s = report.settings ?? {};
  $('#mu-soundfont').value = s.node?.soundfont ?? '';
  $('#mu-samplerate').value = String(s.node?.sampleRate ?? 44100);
  $('#mu-gain').value = s.node?.gain ?? 1.575;
  $('#mu-target').value = s.targetPeakDb === null || s.targetPeakDb === undefined ? '' : String(s.targetPeakDb);
}

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
  // Only the Azure vendor has a stored default voice; the exe vendor's select
  // is a scratch control for the test line.
  const configured = vendor === 'azure' ? vendorState.report?.settings?.azure?.voice : null;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = vendor === 'azure' ? '(auto — first neural en-US voice)' : '(first installed voice)';
  sel.appendChild(none);
  for (const v of data.voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.locale
      ? `${v.name}${v.gender ? ` · ${v.gender.toLowerCase()}` : ''}${v.styles?.length ? ` · ${v.styles.length} styles` : ''}`
      : v.name;
    sel.appendChild(o);
  }
  if (configured && data.voices.some((v) => v.name === configured)) sel.value = configured;
  else if (configured && vendor === 'azure') {
    // Configured voice filtered out of view: keep it selectable so saving the
    // page doesn't silently drop it.
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

// Each capability's cards highlight independently — one active speech vendor
// and one active music vendor, not one active card on the page.
for (const group of ['active-vendor', 'active-music-vendor']) {
  for (const radio of document.querySelectorAll(`input[name="${group}"]`)) {
    radio.addEventListener('change', () => {
      for (const input of document.querySelectorAll(`input[name="${group}"]`)) {
        input.closest('.vendor-card').classList.toggle('active', input.checked);
      }
    });
  }
}

$('#btn-vendors-save').addEventListener('click', async () => {
  setVendorMsg('saving…');
  try {
    const vendor = document.querySelector('input[name="active-vendor"]:checked')?.value ?? 'system';
    const musicVendor = document.querySelector('input[name="active-music-vendor"]:checked')?.value ?? 'node';
    const regionInput = $('#az-region');
    const patch = {
      tts: {
        vendor,
        azure: {
          // A disabled field is env-controlled: leave the stored value alone
          // instead of writing the env value into settings.json.
          ...(regionInput.disabled ? {} : { region: regionInput.value.trim() || null }),
          voice: vendorEl.voice('azure').value || null,
          outputFormat: $('#az-format').value,
          style: $('#az-style').value || null,
        },
      },
      music: {
        vendor: musicVendor,
        targetPeakDb: $('#mu-target').value === '' ? null : Number($('#mu-target').value),
        node: {
          soundfont: $('#mu-soundfont').value.trim() || null,
          sampleRate: Number($('#mu-samplerate').value),
          gain: Number($('#mu-gain').value),
        },
      },
    };
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
  stopAudition(); // never two clips at once

  const music = kind === 'music';
  const vendor = music
    ? (document.querySelector('input[name="active-music-vendor"]:checked')?.value ?? 'node')
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
for (const kind of ['system', 'azure', 'music']) {
  const btn = vendorEl.testBtn(kind);
  btn.dataset.idleLabel = btn.textContent; // "▶ test" / "▶ listen"
  btn.addEventListener('click', () => testVendor(kind));
}

/* -------------------------------- tabs -------------------------------- */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    // Picking a tab while collapsed means you want to see it.
    if ($('#workbench').classList.contains('panel-collapsed')) setPanelCollapsed(false);
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    for (const body of document.querySelectorAll('.tab-body')) {
      body.classList.toggle('hidden', body.id !== `tab-${tab.dataset.tab}`);
    }
    if (tab.dataset.tab === 'outputs') loadOutputs().catch(() => {});
    if (tab.dataset.tab === 'assets') loadAssets().catch(() => {});
    if (tab.dataset.tab === 'audio') loadAudioEditor().catch(() => {});
  });
}

/* ---------------------------- new project ----------------------------- */

$('#btn-new').addEventListener('click', () => {
  const d = state.settings?.newProjectDefaults;
  if (d) {
    const f = $('#new-form');
    f.width.value = d.width;
    f.height.value = d.height;
    f.fps.value = d.fps;
    f.durationInFrames.value = d.durationInFrames;
  }
  $('#new-dialog').showModal();
});
$('#btn-new-cancel').addEventListener('click', () => $('#new-dialog').close());
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const proj = await api('/api/projects', {
      method: 'POST',
      body: {
        name: f.name.value,
        width: Number(f.width.value),
        height: Number(f.height.value),
        fps: Number(f.fps.value),
        durationInFrames: Number(f.durationInFrames.value),
      },
    });
    $('#new-dialog').close();
    f.reset();
    await loadProjects();
    selectProject(proj.id);
  } catch (err) {
    alert(err.message);
  }
});

/* -------------------------------- boot -------------------------------- */

checkPrereqs();
loadSettings().catch(() => {});
loadProjects().catch((e) => console.error(e));
