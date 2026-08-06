/* Motion Studio — the command palette and quick open, shared by both documents.
 *
 * Until v0.27 the workspace tree was the ONLY way to reach a film or a scene:
 * expand a workspace, expand a film, read down a list of twelve. That is fine at
 * three films and a hunt at thirty — and it is a hunt the document strip only
 * shortens for things already opened. VS Code's answer is that the tree is a
 * convenience and the keyboard is the interface, so:
 *
 *   Ctrl/Cmd+P        quick open — every film and scene on the machine, fuzzy
 *   Ctrl/Cmd+Shift+P  commands — whatever the host page registered
 *
 * Films come from one /api/workspaces call. Scenes are per-film, so they are
 * fetched lazily in the background the first time the palette opens and cached
 * for the page's life; typing works against whatever has arrived, and the list
 * refreshes as more does. A cold palette is therefore useful immediately rather
 * than blocking on twenty requests.
 *
 * Loaded as a classic script before app.js / film.js, which both declare their
 * own top-level `$` and `state` — hence the IIFE: one global, StudioPalette.
 */

(() => {
  'use strict';

  const enc = encodeURIComponent;
  const MAX_ROWS = 60;
  const FETCH_CONCURRENCY = 6;

  /* --------------------------- fuzzy matching --------------------------- */

  /* Subsequence match with a score, the shape every quick-open uses: all of the
   * query's characters in order, cheaper when they land on word starts and when
   * they run consecutively. Returns null for a miss so callers can filter. */
  function fuzzy(query, text) {
    if (!query) return { score: 0, hits: [] };
    // Never trust a candidate's label to exist. Filtering is not the place a
    // malformed row should surface, and one exists today: see loadScenes.
    if (typeof text !== 'string' || !text) return null;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    const hits = [];
    let score = 0;
    let ti = 0;
    let streak = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      if (ch === ' ') { streak = 0; continue; } // spaces separate terms, match nothing
      let found = -1;
      for (let i = ti; i < t.length; i++) {
        if (t[i] !== ch) continue;
        found = i;
        break;
      }
      if (found < 0) return null;
      const wordStart = found === 0 || /[^a-z0-9]/.test(t[found - 1]);
      streak = found === ti ? streak + 1 : 0;
      score += 1 + (wordStart ? 6 : 0) + streak * 3;
      hits.push(found);
      ti = found + 1;
    }
    // A short target that matched is a better answer than a long one.
    return { score: score - text.length * 0.04, hits };
  }

  /** Render text with the matched characters marked, without innerHTML. */
  function highlight(text, hits) {
    const frag = document.createDocumentFragment();
    const set = new Set(hits);
    let run = '';
    let runHit = false;
    const flush = () => {
      if (!run) return;
      if (runHit) {
        const span = document.createElement('span');
        span.className = 'pal-hit';
        span.textContent = run;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(run));
      }
      run = '';
    };
    for (let i = 0; i < text.length; i++) {
      const hit = set.has(i);
      if (hit !== runHit) { flush(); runHit = hit; }
      run += text[i];
    }
    flush();
    return frag;
  }

  /* ------------------------------- the index ------------------------------ */

  const index = { films: [], scenes: [], loaded: false, loadingScenes: false };
  const commands = []; // {id, title, group, detail, run, when}

  async function getJson(path) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }

  async function loadFilms() {
    const { workspaces } = await getJson('/api/workspaces');
    index.films = [];
    for (const ws of workspaces ?? []) {
      for (const f of ws.films ?? []) {
        index.films.push({ id: f.id, name: f.name || f.slug, workspace: ws.id, scenes: f.scenes ?? 0 });
      }
    }
    index.loaded = true;
  }

  /** Per-film scene lists, a few at a time, repainting as they land. */
  async function loadScenes(onProgress) {
    if (index.loadingScenes) return;
    index.loadingScenes = true;
    const queue = index.films.slice();
    const seen = new Set(index.scenes.map((s) => s.id));
    const worker = async () => {
      for (;;) {
        const film = queue.shift();
        if (!film) return;
        try {
          // `detail=scenes` is the compact projection — no composition bodies.
          const { sceneFolders } = await getJson(`/api/films/${enc(film.id)}?detail=scenes`);
          let added = false;
          for (const s of sceneFolders ?? []) {
            // A scene folder that is not on disk is not a place to navigate to.
            // Nameless rows are a live engine defect rather than a hypothetical:
            // store.listScenes() maps every play-order entry through describe(),
            // including footage segments, which have no slug — so any film with
            // footage yields one `<film>/undefined` row with no name. The film
            // page hides it by accident (its unlisted filter also holds
            // `undefined`); this guard is deliberate and stays either way.
            if (!s?.id || s.missing || !(s.name || s.slug)) continue;
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            index.scenes.push({ id: s.id, name: s.name || s.slug, film: film.name, filmId: film.id });
            added = true;
          }
          if (added) onProgress?.();
        } catch { /* a film whose document will not parse simply has no scenes here */ }
      }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
    index.loadingScenes = false;
    onProgress?.();
  }

  /* -------------------------------- the UI -------------------------------- */

  let host = null;      // {scrim, box, input, list, hint}
  let mode = 'files';   // 'files' | 'commands'
  let rows = [];        // the current candidate list
  let cursor = 0;

  /* Where the keyboard was before the palette took it. Closing used to remove
   * the focused input and restore nothing, so focus fell to <body> — and every
   * document shortcut (Space, the arrows, PageUp/PageDown, Ctrl+S) went dead
   * until the human clicked back into the film, with nothing to say why.
   * Measured: activeElement was the document iframe before Ctrl+P, and BODY
   * after Esc. */
  let returnFocusTo = null;

  function restoreFocus() {
    const el = returnFocusTo;
    returnFocusTo = null;
    // It may be gone — the chosen command can close the document it lived in —
    // in which case the active document is the right place to land.
    try {
      if (el && el.isConnected) { el.focus(); return; }
      document.querySelector('.editor-frame.on')?.focus();
    } catch { /* nothing focusable: the shell keeps the keyboard */ }
  }

  function close({ restore = true } = {}) {
    if (!host) return;
    host.scrim.remove();
    host.box.remove();
    host = null;
    rows = [];
    if (restore) restoreFocus();
  }

  function open(nextMode) {
    if (host && mode === nextMode) { host.input.select(); return; }
    // Swapping modes must not treat the palette's own input as the place to
    // return to, so the remembered element survives a mode swap untouched.
    if (host) close({ restore: false });
    else returnFocusTo = document.activeElement;
    mode = nextMode;

    const scrim = document.createElement('div');
    scrim.className = 'palette-scrim';
    scrim.addEventListener('pointerdown', close);

    const box = document.createElement('div');
    box.className = 'palette';
    const input = document.createElement('input');
    input.className = 'palette-input';
    input.spellcheck = false;
    input.placeholder = mode === 'files'
      ? 'Go to a film or scene by name…'
      : 'Type a command…';
    const list = document.createElement('ul');
    list.className = 'palette-list';
    // The cursor row already exists and already scrolls itself into view; this
    // only names for a screen reader what the code has always tracked.
    list.id = 'palette-list';
    list.setAttribute('role', 'listbox');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'palette-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', mode === 'files' ? 'Go to a film or scene' : 'Run a command');
    const hint = document.createElement('div');
    hint.className = 'palette-hint';
    hint.append(
      kbd('↑↓'), t(' move  '), kbd('Enter'), t(' open  '), kbd('Esc'), t(' dismiss  '),
      kbd(mode === 'files' ? 'Ctrl+Shift+P' : 'Ctrl+P'),
      t(mode === 'files' ? ' commands' : ' files'),
    );
    box.append(input, list, hint);
    document.body.append(scrim, box);
    host = { scrim, box, input, list, hint };

    input.addEventListener('input', () => { cursor = 0; paint(); });
    input.addEventListener('keydown', onKey);
    input.focus();

    // Films are one request; scenes stream in behind them.
    const repaint = () => { if (host) paint(); };
    (index.loaded ? Promise.resolve() : loadFilms())
      .then(() => { repaint(); if (mode === 'files') loadScenes(repaint); })
      .catch(repaint);
    paint();
  }

  const t = (text) => document.createTextNode(text);
  function kbd(text) {
    const k = document.createElement('kbd');
    k.textContent = text;
    return k;
  }

  function candidates() {
    if (mode === 'commands') {
      return commands
        .filter((c) => !c.when || c.when())
        .map((c) => ({ kind: 'command', icon: c.icon ?? '›', label: c.title, detail: c.detail ?? '', group: c.group ?? 'commands', run: c.run }));
    }
    const out = [];
    // Opening is the shell's job, not a navigation: picking a film here used to
    // take the whole window to the standalone /film.html page, closing every
    // other document to do it.
    for (const f of index.films) {
      out.push({
        kind: 'film', icon: '▶', label: f.name, detail: f.id, group: 'films',
        run: () => StudioUtil.openDocument({ kind: 'film', id: f.id, name: f.name }),
      });
    }
    for (const s of index.scenes) {
      out.push({
        kind: 'scene', icon: '◧', label: s.name, detail: s.film, group: 'scenes',
        run: () => StudioUtil.openDocument({ kind: 'scene', id: s.id, name: s.name }),
      });
    }
    return out;
  }

  function paint() {
    const q = host.input.value.trim();
    const scored = [];
    for (const c of candidates()) {
      const m = fuzzy(q, c.label);
      if (m) { scored.push({ ...c, score: m.score, hits: m.hits }); continue; }
      // A miss on the name can still be a hit on the path — worth less.
      const d = c.detail ? fuzzy(q, c.detail) : null;
      if (d) scored.push({ ...c, score: d.score - 8, hits: [] });
    }
    // Without a query, keep the natural order (films, then scenes, then
    // commands) rather than a meaningless score sort.
    if (q) scored.sort((a, b) => b.score - a.score);
    rows = scored.slice(0, MAX_ROWS);
    cursor = Math.min(cursor, Math.max(0, rows.length - 1));

    host.list.innerHTML = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'palette-empty';
      li.textContent = index.loaded ? 'No matching film, scene or command.' : 'Loading…';
      host.list.appendChild(li);
      return;
    }
    let group = null;
    rows.forEach((r, i) => {
      // Group headers only make sense in the unsorted (no-query) listing.
      if (!q && r.group !== group) {
        group = r.group;
        const head = document.createElement('li');
        head.className = 'palette-group';
        head.textContent = group;
        host.list.appendChild(head);
      }
      const li = document.createElement('li');
      li.className = 'palette-row' + (i === cursor ? ' on' : '');
      li.id = `palette-row-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === cursor ? 'true' : 'false');
      const ico = document.createElement('span');
      ico.className = 'pal-ico';
      ico.textContent = r.icon;
      const label = document.createElement('span');
      label.className = 'pal-label';
      label.appendChild(highlight(r.label, r.hits));
      const detail = document.createElement('span');
      detail.className = 'pal-detail';
      detail.textContent = r.detail;
      li.append(ico, label, detail);
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(i); });
      host.list.appendChild(li);
    });
    const on = host.list.querySelector('.palette-row.on');
    on?.scrollIntoView({ block: 'nearest' });
    // Focus stays in the input; this is what says which row it is pointing at.
    if (on?.id) host.input.setAttribute('aria-activedescendant', on.id);
    else host.input.removeAttribute('aria-activedescendant');
  }

  function choose(i) {
    const row = rows[i];
    if (!row) return;
    // Dismissing returns you where you were; CHOOSING should land you in what
    // you picked. So no restore here — run first, then take the keyboard to
    // whatever is now on screen, which for a film or scene is that document.
    close({ restore: false });
    try { row.run(); } catch (err) { console.error(err); }
    try { (document.querySelector('.editor-frame.on') ?? document.body).focus(); } catch { /* nothing to focus */ }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); choose(cursor); return; }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault(); cursor = rows.length ? (cursor + 1) % rows.length : 0; paint(); return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault(); cursor = rows.length ? (cursor - 1 + rows.length) % rows.length : 0; paint(); return;
    }
    // Swap modes without closing, the way VS Code does.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      open(e.shiftKey ? 'commands' : 'files');
    }
  }

  /* ------------------------------- host API ------------------------------- */

  /** Register commands the palette should offer on this page. */
  function register(list) {
    for (const c of list) {
      if (!c || typeof c.run !== 'function' || !c.title) continue;
      const at = commands.findIndex((x) => x.id === c.id);
      if (at >= 0) commands[at] = c; else commands.push(c);
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'p') return;
    // A dialog owns the keyboard while it is up.
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    open(e.shiftKey ? 'commands' : 'files');
  });

  window.StudioPalette = {
    register,
    open: (m = 'files') => open(m),
    close,
    isOpen: () => !!host,
    /** Let a page drop its cached scene list after creating or deleting one. */
    invalidate() { index.films = []; index.scenes = []; index.loaded = false; },
  };
})();
