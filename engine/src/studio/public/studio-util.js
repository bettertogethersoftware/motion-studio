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

  window.StudioUtil = {
    $, enc, api, toast, toastError,
    shell, hostShell, registerDocument, syncDocument, openDocument,
  };
})();
