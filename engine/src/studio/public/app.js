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
  config: null,
  frame: 0,
  playing: false,
  playTimer: null,
  events: null, // SSE
  jobId: null,
  jobTimer: null,
  frameReady: Promise.resolve(),
};

/* ------------------------------ prereqs ------------------------------- */

async function checkPrereqs() {
  try {
    const p = await api('/api/prereqs');
    const el = $('#engine-status');
    if (p.ok) {
      el.innerHTML = `engine <span class="ok">ready</span> · ffmpeg ${p.ffmpeg?.version ?? '?'}`;
    } else {
      el.innerHTML = `engine <span class="err">missing prereqs</span>`;
      const banner = $('#prereq-banner');
      banner.textContent = 'Prerequisites missing: ' + (p.problems || []).join(' · ');
      banner.classList.remove('hidden');
    }
  } catch {
    $('#engine-status').innerHTML = 'engine <span class="err">unreachable</span>';
  }
}

/* ------------------------------ projects ------------------------------ */

async function loadProjects() {
  const { projects } = await api('/api/projects');
  state.projects = projects;
  const ul = $('#project-list');
  ul.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.className = (p.id === state.projectId ? 'active ' : '') + (p.missing ? 'missing' : '');
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'p-meta';
    meta.textContent = p.missing ? 'missing' : '';
    li.append(name, meta);
    if (!p.missing) li.addEventListener('click', () => selectProject(p.id));
    ul.appendChild(li);
  }
}

async function selectProject(id) {
  stopPlayback();
  stopJobPolling();
  state.events?.close();
  state.projectId = id;
  const proj = await api(`/api/projects/${id}`);
  state.config = proj.config;
  state.frame = 0;

  $('#empty-state').classList.add('hidden');
  $('#workbench').classList.remove('hidden');
  $('#project-title').textContent = proj.name;
  updateMeta();
  fillConfigForm();
  loadOutputs().catch(() => {});
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

function fillConfigForm() {
  const f = $('#config-form');
  const c = state.config;
  f.name.value = c.name;
  f.fps.value = c.fps;
  f.width.value = c.width;
  f.height.value = c.height;
  f.durationInFrames.value = c.durationInFrames;
  f.format.value = c.output.format;
  f.crf.value = c.output.crf ?? '';
  f.transparent.checked = !!c.output.transparent;
}

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#config-msg');
  msg.textContent = '…';
  try {
    const patch = {
      name: f.name.value,
      fps: Number(f.fps.value),
      width: Number(f.width.value),
      height: Number(f.height.value),
      durationInFrames: Number(f.durationInFrames.value),
      output: {
        format: f.format.value,
        transparent: f.transparent.checked,
        ...(f.crf.value !== '' ? { crf: Number(f.crf.value) } : {}),
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

/* -------------------------------- tabs -------------------------------- */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    for (const body of document.querySelectorAll('.tab-body')) {
      body.classList.toggle('hidden', body.id !== `tab-${tab.dataset.tab}`);
    }
    if (tab.dataset.tab === 'outputs') loadOutputs().catch(() => {});
  });
}

/* ---------------------------- new project ----------------------------- */

$('#btn-new').addEventListener('click', () => $('#new-dialog').showModal());
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
loadProjects().catch((e) => console.error(e));
