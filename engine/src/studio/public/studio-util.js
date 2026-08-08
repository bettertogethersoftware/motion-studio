/* Motion Studio — the handful of helpers every Studio document needs.
 *
 * Split out in v0.27 when the scene workbench left index.html to become its own
 * document: three files now want the same transport and the same toast, and
 * copying forty lines three times is how they drift.
 *
 * Deliberately NOT here: `el()`. app.js and film.js have had different
 * signatures for it since v0.20 — `el(tag, className, text)` against
 * `el(tag, attrs, ...children)` — and unifying them is a rename across six
 * thousand lines for no behaviour. Each page keeps its own.
 *
 * Loaded as a classic script before every page's own, so pages start with:
 *   const { $, api, enc, toast, toastError } = StudioUtil;
 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const enc = encodeURIComponent;

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

  /* Errors used to go through alert(): blocking, and it flattened the engine's
   * structured EngineError (code + a message that already contains the fix and
   * the available alternatives) down to one modal line. Toasts keep the page
   * usable, show the error code as a badge, and stay up long enough to read a
   * multi-sentence fix. Errors persist until dismissed; info fades. */
  /* Errors have no TTL, so a retrying render can stack them without bound.
   * Keep the newest few: a wall of identical failures buries the UI it is
   * reporting on, and nobody reads the fifth copy. */
  const MAX_TOASTS = 5;

  function toastContainer() {
    let el = $('#toasts');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toasts';
      // The app's primary feedback channel announced nothing. `polite` and not
      // `assertive`: a failed render is worth saying, not worth interrupting a
      // word mid-syllable.
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  }

  function toast(input, { kind = 'error', timeoutMs = null } = {}) {
    const err = input instanceof Error ? input : null;
    const message = err ? err.message : String(input);
    const code = err?.data?.code ?? null;

    /* A document that is not the active tab is `visibility: hidden` — it still
     * has a layout, so a toast raised there renders perfectly and is seen by
     * nobody, forever, since errors never expire. Start a render, switch tabs,
     * and a failure reported nothing at all. So an embedded document hands its
     * toasts up to the shell, which shows them over whatever IS on screen and
     * labels them with the document they came from. Standalone on a second
     * monitor there is no shell, and the local path below is still right. */
    const s = shell();
    if (s?.docToast) {
      try {
        s.docToast({ kind, code, message, timeoutMs, doc: window.StudioDoc ?? null });
        return null;
      } catch { /* shell mid-navigation: fall through and show it here */ }
    }

    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    if (code) {
      const badge = document.createElement('span');
      badge.className = 'toast-code mono';
      badge.textContent = code;
      el.appendChild(badge);
    }
    const body = document.createElement('span');
    body.className = 'toast-body';
    body.textContent = message;
    el.appendChild(body);

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.textContent = '✕';
    close.title = 'dismiss';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);

    const host = toastContainer();
    host.appendChild(el);
    while (host.children.length > MAX_TOASTS) host.firstElementChild.remove();
    const ttl = timeoutMs ?? (kind === 'error' ? null : 5000);
    if (ttl) setTimeout(() => el.remove(), ttl);
    return el;
  }

  const toastError = (err) => toast(err, { kind: 'error' });

  /* -------------------------------- asking -------------------------------- */

  /* `prompt()` and `confirm()` block the page, cannot be styled, and — the
   * reason they had to go — encode a real choice as OK-versus-Cancel: the
   * asset rename asked "OK: repoint the audio tracks / Cancel: leave them
   * pointing at a missing file" in a box with two unlabelled buttons.
   *
   * Both helpers below build their <dialog> once, lazily, in whatever document
   * calls them, so film.html and the panels module get them without a copy of
   * the markup each. index.html's static `#text-prompt-dialog` predates this
   * and is adopted rather than duplicated. */

  function dialogHost() {
    return document.body;
  }

  let textDialog = null;
  function textPromptDialog() {
    if (textDialog) return textDialog;
    const existing = $('#text-prompt-dialog');
    if (existing) { textDialog = existing; return textDialog; }
    const dlg = document.createElement('dialog');
    dlg.id = 'text-prompt-dialog';
    dlg.innerHTML = `
      <form id="text-prompt-form" method="dialog">
        <h2 id="text-prompt-title"></h2>
        <p class="dim note" id="text-prompt-note"></p>
        <label><span id="text-prompt-label"></span> <input id="text-prompt-input" name="value" required></label>
        <label class="check hidden" id="text-prompt-check-row">
          <input id="text-prompt-check" type="checkbox"> <span id="text-prompt-check-label"></span>
        </label>
        <p class="dim note hidden" id="text-prompt-check-note"></p>
        <div class="fieldrow right">
          <button type="button" data-close="text-prompt-dialog" class="ghost">cancel</button>
          <button type="submit" class="primary" id="text-prompt-ok">ok</button>
        </div>
      </form>`;
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    dialogHost().appendChild(dlg);
    textDialog = dlg;
    return dlg;
  }

  /**
   * One reusable name-entry dialog, in place of `prompt()`.
   *
   * Resolves to the trimmed string — or, when `checkbox` is given, to
   * `{ value, checked }` — and to null if dismissed, so a caller reads the same
   * way `prompt()` did. The optional checkbox is what a chained `confirm()`
   * used to be: a second question with its own words, answered in the same box.
   */
  function askForText({ title, label, note = '', value = '', ok = 'ok', checkbox = null }) {
    const dlg = textPromptDialog();
    const form = dlg.querySelector('#text-prompt-form');
    const input = dlg.querySelector('#text-prompt-input');
    const check = dlg.querySelector('#text-prompt-check');
    const checkRow = dlg.querySelector('#text-prompt-check-row');
    const checkNote = dlg.querySelector('#text-prompt-check-note');
    dlg.querySelector('#text-prompt-title').textContent = title;
    dlg.querySelector('#text-prompt-label').textContent = label;
    const noteEl = dlg.querySelector('#text-prompt-note');
    noteEl.textContent = note;
    noteEl.classList.toggle('hidden', !note);
    dlg.querySelector('#text-prompt-ok').textContent = ok;
    input.value = value;
    // The checkbox row exists only in the lazily built dialog; index.html's
    // static copy has no checkbox, and no caller there asks for one.
    if (checkRow) {
      checkRow.classList.toggle('hidden', !checkbox);
      checkNote.classList.toggle('hidden', !checkbox?.note);
      if (checkbox) {
        dlg.querySelector('#text-prompt-check-label').textContent = checkbox.label;
        checkNote.textContent = checkbox.note ?? '';
        check.checked = checkbox.checked ?? false;
      }
    }
    return new Promise((resolve) => {
      const done = (v) => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        resolve(v);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim();
        dlg.close();
        if (!v) return done(null);
        done(checkbox ? { value: v, checked: !!check?.checked } : v);
      };
      const onClose = () => done(null);
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      input.select();
    });
  }

  let confirmDialog = null;
  /**
   * `confirm()`, with buttons that say what they do. Resolves true/false; Esc
   * and the cancel button are the same answer, which is the safe one.
   */
  function askToConfirm({ title, body = '', ok = 'ok', danger = false }) {
    if (!confirmDialog) {
      const dlg = document.createElement('dialog');
      dlg.id = 'confirm-dialog';
      dlg.innerHTML = `
        <form id="confirm-form" method="dialog">
          <h2 id="confirm-title"></h2>
          <p class="dialog-body" id="confirm-body"></p>
          <div class="fieldrow right">
            <button type="button" data-close="confirm-dialog" class="ghost">cancel</button>
            <button type="submit" class="primary" id="confirm-ok">ok</button>
          </div>
        </form>`;
      dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
      dialogHost().appendChild(dlg);
      confirmDialog = dlg;
    }
    const dlg = confirmDialog;
    const form = dlg.querySelector('#confirm-form');
    const okBtn = dlg.querySelector('#confirm-ok');
    dlg.querySelector('#confirm-title').textContent = title;
    dlg.querySelector('#confirm-body').textContent = body;
    okBtn.textContent = ok;
    okBtn.className = danger ? 'ghost danger' : 'primary';
    return new Promise((resolve) => {
      let answer = false;
      const done = () => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        resolve(answer);
      };
      const onSubmit = (e) => { e.preventDefault(); answer = true; dlg.close(); };
      const onClose = () => done();
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      okBtn.focus();
    });
  }

  /* ------------------------------ embedding ------------------------------ */

  /* A document is either the whole page (opened directly, or on a second
   * monitor) or one tab inside the shell. It has to know which: embedded, the
   * shell owns the activity bar, the status bar and the tab strip, and what
   * would have been a navigation becomes "open that as another tab". */
  const shell = () => {
    try {
      return window.parent !== window && window.parent.StudioShell ? window.parent.StudioShell : null;
    } catch { return null; } // cross-origin: not our shell, so not embedded
  };

  /**
   * The shell that would host a document opened from here: this window when it
   * IS the shell, otherwise the parent's when we are a document inside it.
   *
   * Deliberately separate from shell(): that one answers "am I embedded?", and
   * the Studio shell must never answer yes to that about itself.
   */
  const hostShell = () => window.StudioShell ?? shell();

  /**
   * Call once a document knows what it is. Marks <html> so the stylesheets can
   * drop the chrome the shell provides, and registers the document with the
   * shell so its tab title and status items can be read.
   */
  function registerDocument(doc) {
    window.StudioDoc = doc;
    const s = shell();
    document.documentElement.classList.toggle('embedded', !!s);
    s?.documentReady(doc);
    return s;
  }

  /** Tell the shell this document's title or status items changed. */
  function syncDocument() {
    shell()?.syncDocument(window.StudioDoc);
  }

  /**
   * Open a film or scene. With a shell in reach — this window's, or the parent's
   * when we are a document inside it — that is another tab, which is the whole
   * point of the shell. Without one (a document opened standalone on a second
   * monitor) it navigates to the shell carrying a deep link, so you land in the
   * app with the thing open rather than on another lone page.
   */
  function openDocument({ kind, id, name }) {
    const s = hostShell();
    if (s) { s.openDocument({ kind, id, name }); return; }
    location.href = kind === 'film' ? `/?film=${enc(id)}` : `/?scene=${enc(id)}`;
  }

  /* ---------------------------- production feed --------------------------- */

  /** Every event type `/api/events` emits. Subscribing to all of them is cheap. */
  const PRODUCTION_EVENTS = [
    'film', 'film-output', 'delivery', 'advice', 'revision', 'scene-output', 'activity', 'reset',
  ];

  /**
   * Listen to the production stream — an agent's work in another process.
   *
   * Embedded, this rides the SHELL's one connection instead of opening another.
   * That is not tidiness: the server speaks HTTP/1.1, where a browser allows
   * about six sockets per origin, and an SSE stream holds one open forever. Ten
   * open films used to mean ten streams, which is the whole budget — the last
   * documents' feeds and then the shell's own fetches queue behind them. One
   * stream, fanned out, keeps the budget at one.
   *
   * @param {string[]} types  event types to receive
   * @param {Function} fn     (event) => void — the parsed event, `type` included
   * @returns {Function} unsubscribe
   */
  function subscribeProduction(types, fn) {
    const s = shell();
    if (s?.subscribeEvents) {
      try { return s.subscribeEvents(types, fn); }
      catch { /* shell mid-navigation: fall through to our own connection */ }
    }
    let src;
    try { src = new EventSource('/api/events'); }
    catch { return () => {}; }
    for (const t of types) {
      src.addEventListener(t, (e) => {
        let data = { type: t };
        try { data = { ...JSON.parse(e.data), type: t }; } catch { /* keep the bare type */ }
        try { fn(data); } catch { /* one bad handler must not kill the feed */ }
      });
    }
    src.onerror = () => { /* EventSource reconnects on its own */ };
    return () => src.close();
  }

  /* --------------------------- shell shortcuts --------------------------- */

  /**
   * The keys the SHELL owns, bound identically wherever focus happens to be.
   *
   * Focus normally sits inside a document's iframe, so a handler on the shell
   * alone reaches nothing — which is why film.js and scene.js each grew their
   * own copy of a Ctrl+P forwarder. This is that forwarder, once, for every
   * shortcut instead of one: the shell calls it and dispatches locally, a
   * document calls it and hands the keystroke up through `hostShell()`.
   *
   * Deliberately Alt- and Ctrl+K-based. `Ctrl+W`, `Ctrl+Tab` and
   * `Ctrl+PageUp/PageDown` are reserved by the browser: keydown fires,
   * preventDefault is ignored, and Ctrl+W would close the browser tab along
   * with the document. `Ctrl+K` is free, and the chord is VS Code's own.
   */
  const SHELL_KEYS = [
    { id: 'palette', match: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === 'p' },
    { id: 'commands', match: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === 'p' },
    { id: 'closeDoc', match: (e) => e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'w' },
    { id: 'prevDoc', match: (e) => e.altKey && e.code === 'PageUp' },
    { id: 'nextDoc', match: (e) => e.altKey && e.code === 'PageDown' },
    { id: 'nthDoc', match: (e) => e.altKey && /^Digit[0-9]$/.test(e.code), arg: (e) => Number(e.code.slice(5)) },
  ];
  const mod = (e) => e.ctrlKey || e.metaKey;

  /** Chord state: Ctrl+K arms, the next keystroke completes or cancels it. */
  let chordArmed = false;

  function bindShellKeys() {
    window.addEventListener('keydown', (e) => {
      // A dialog owns the keyboard while it is up, and the palette is its own
      // input — neither should have shortcuts fired out from under it.
      if (document.querySelector('dialog[open]')) return;

      if (chordArmed) {
        chordArmed = false;
        if (e.key.toLowerCase() === 'w') { e.preventDefault(); fire('closeDoc'); }
        return; // anything else cancels the chord and is swallowed, as in VS Code
      }
      if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault(); chordArmed = true;
        setTimeout(() => { chordArmed = false; }, 2000); // don't arm forever
        return;
      }

      for (const k of SHELL_KEYS) {
        if (!k.match(e)) continue;
        if (!hostShell()) return;   // standalone: leave the key to the browser
        e.preventDefault();
        fire(k.id, k.arg?.(e));
        return;
      }
    });
  }

  function fire(id, arg) {
    const s = hostShell();
    if (!s) return;
    try {
      if (id === 'palette') s.openPalette('files');
      else if (id === 'commands') s.openPalette('commands');
      else s.shellCommand?.(id, arg);
    } catch { /* shell mid-navigation */ }
  }

  /* ------------------------------- tree keyboard ---------------------------- */

  /**
   * Give a tree a keyboard and real semantics (U-10). Two documents have one
   * each — the Explorer's workspace tree and the film document's structure
   * tree — and they are the same job done twice, which is exactly the
   * condition that produced the duplicated toast() this file exists to delete.
   *
   * **Roving tabindex, not a tab stop per row.** One Tab reaches the tree and
   * the arrows move inside it. Per-row `tabindex="0"` would cost 24 Tab presses
   * to cross a 24-scene film, which is a worse keyboard than none.
   *
   * **Both trees are FLAT in the DOM** — rows are siblings and nesting is
   * indentation — so depth is stated with `aria-level` rather than by wrapping
   * children in `role="group"`. That is a real choice: the wrapper version is
   * the textbook ARIA tree, and it would mean restructuring both renderers and
   * every CSS rule keyed on their row classes, to say something `aria-level`
   * already says correctly.
   *
   * `sync()` is called after every repaint. Both trees rebuild wholesale, so it
   * also restores the roving position by KEY rather than by index: a row that
   * survived a rebuild under a different position is still the row you were on.
   *
   * @param {Element} container
   * @param {object} o
   * @param {() => Element[]} o.rows     focusable rows, in visual order
   * @param {(row) => number} o.level    1-based depth for aria-level
   * @param {(row) => boolean|null} o.expanded  null when the row does not expand
   * @param {(row, expand: boolean) => void} o.toggle
   * @param {(row) => void} o.open       Enter, and the double-purpose of ArrowRight
   * @param {(row) => string} o.key      identity that survives a repaint
   */
  function treeNav(container, o) {
    if (!container) return { sync() {} };
    container.setAttribute('role', 'tree');
    let currentKey = null;
    // Which row focus was last on, so a rebuild can be told apart from the user
    // deliberately leaving. Both renderers start with `innerHTML = ''`, which
    // destroys the focused node and drops focus to <body> BEFORE sync() runs —
    // so "is focus inside the container" is already false by the time we could
    // ask, and expanding a film with the keyboard would silently strand you.
    // Was focus ours when the repaint began? Asked BEFORE the wipe, not after:
    // both renderers start with `innerHTML = ''`, which destroys the focused
    // node and drops focus to <body>, so by the time sync() could look the
    // answer is always "no" and expanding a film would strand the keyboard.
    // This is the shape the film inspector already uses (captureFocus /
    // restoreFocus) rather than a second invention.
    let heldFocus = false;

    container.addEventListener('focusin', (e) => {
      // The roving position follows focus however it ARRIVED — clicking a row
      // or tabbing into one moves it too, or the next repaint restores to
      // wherever the arrows last were and the keyboard jumps somewhere else.
      const row = e.target.closest?.('[role="treeitem"]');
      if (row) currentKey = o.key(row);
    });

    const rowsNow = () => o.rows().filter(Boolean);
    const indexOfCurrent = (rows) => {
      const i = rows.findIndex((r) => o.key(r) === currentKey);
      return i === -1 ? 0 : i;
    };

    function focusRow(rows, i, { moveFocus = true } = {}) {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!row) return;
      currentKey = o.key(row);
      for (const r of rows) r.tabIndex = r === row ? 0 : -1;
      if (moveFocus) row.focus();
    }

    container.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;      // shell chords stay the shell's
      const rows = rowsNow();
      if (!rows.length) return;
      const row = e.target.closest?.('[role="treeitem"]');
      if (!row || !rows.includes(row)) return;
      const i = rows.indexOf(row);
      const expanded = o.expanded(row);

      switch (e.key) {
        case 'ArrowDown': focusRow(rows, i + 1); break;
        case 'ArrowUp': focusRow(rows, i - 1); break;
        case 'Home': focusRow(rows, 0); break;
        case 'End': focusRow(rows, rows.length - 1); break;
        case 'Enter': o.open(row); return;                  // no preventDefault: the row decides
        case 'ArrowRight':
          if (expanded === false) o.toggle(row, true);
          else focusRow(rows, i + 1);
          break;
        case 'ArrowLeft':
          if (expanded === true) { o.toggle(row, false); break; }
          // Otherwise step OUT: the nearest row above at a shallower level.
          for (let j = i - 1; j >= 0; j--) {
            if (o.level(rows[j]) < o.level(row)) { focusRow(rows, j); break; }
          }
          break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();   // the film document binds bare arrows to the playhead
    });

    return {
      /** Call at the top of a repaint, before the rows are replaced. */
      capture() {
        heldFocus = container.contains(document.activeElement);
      },
      sync() {
        const rows = rowsNow();
        // Ours before the repaint, or ours right now (a sync with no repaint).
        const hadFocus = heldFocus || container.contains(document.activeElement);
        heldFocus = false;
        for (const row of rows) {
          row.setAttribute('role', 'treeitem');
          row.setAttribute('aria-level', String(o.level(row)));
          const ex = o.expanded(row);
          if (ex === null) row.removeAttribute('aria-expanded');
          else row.setAttribute('aria-expanded', String(ex));
          row.tabIndex = -1;
        }
        if (!rows.length) return;
        // Keep focus inside the tree across a rebuild that replaced the node it
        // was on — otherwise expanding a film drops you back to <body>, which
        // is the palette bug (U-11) in a different costume.
        focusRow(rows, indexOfCurrent(rows), { moveFocus: hadFocus });
      },
    };
  }

  window.StudioUtil = {
    $, enc, api, toast, toastError, askForText, askToConfirm,
    shell, hostShell, registerDocument, syncDocument, openDocument,
    bindShellKeys, subscribeProduction, PRODUCTION_EVENTS, treeNav,
  };
})();
