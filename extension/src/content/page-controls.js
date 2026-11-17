// Keyboard and click control of a reading session, on the page itself.
// Classic script (see cleaning.js); listeners are installed once per page.
//
// Active only while the service worker has told this page that a chapter session
// for this URL is running (PAGE_SESSION). Settings come from chrome.storage.sync:
// arrowKeysControl and clickToJump (defaults duplicated from src/shared/settings.js).
//
// Keys (no modifiers, not while typing): ArrowRight = next chunk, ArrowLeft = previous
// chunk, k = play/pause. Space is left alone (it scrolls the page). While a session is
// active Chapterly wins over the site's own arrow-key navigation.
//
// Click: a plain single click on a chapter paragraph jumps there. Not on links,
// buttons or form controls, not while selecting text, not on double clicks, not with
// modifier keys.
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});
  const P_ATTR = 'data-chapterly-p';
  const SETTINGS_DEFAULTS = { arrowKeysControl: true, clickToJump: true };
  const DOUBLE_CLICK_MS = 260; // wait this long so a double click (word select) can cancel the jump
  const INTERACTIVE =
    'a[href], button, input, select, textarea, label, summary, option, [role="button"], [role="link"], [contenteditable=""], [contenteditable="true"]';

  // ---------- pure decisions (tested in jsdom) ----------

  function isEditable(target) {
    if (!target || target.nodeType !== 1) return false;
    if (target.isContentEditable) return true;
    if (target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
    return false;
  }

  /** 'next' | 'previous' | 'toggle' | null for a keydown event. */
  function keyCommand(event, { active, arrowKeysControl }) {
    if (!active || !arrowKeysControl || event.defaultPrevented) return null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
    if (event.isComposing || isEditable(event.target)) return null;
    switch (event.key) {
      case 'ArrowRight':
        return 'next';
      case 'ArrowLeft':
        return 'previous';
      case 'k':
        return 'toggle';
      default:
        return null;
    }
  }

  /** The paragraph element a click may jump to, or null if the click should be ignored. */
  function jumpTarget(event, { active, clickToJump, selectionCollapsed = true }) {
    if (!active || !clickToJump || event.defaultPrevented) return null;
    if (event.button !== 0 || (event.detail ?? 1) > 1) return null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
    if (!selectionCollapsed) return null; // the user is selecting text
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (!target || target.closest(INTERACTIVE) || isEditable(target)) return null;
    return target.closest(`[${P_ATTR}]`);
  }

  /** Caret under the pointer: {node, offset} (text node) or null. */
  function caretAt(doc, x, y) {
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range?.startContainer) return { node: range.startContainer, offset: range.startOffset };
    return null;
  }

  /** {paragraphIndex, offset} for a click inside paragraph element `el`. */
  function clickPosition(el, caret) {
    const node = caret?.node?.nodeType === 3 && el.contains(caret.node) ? caret.node : null;
    return ns.textMap.positionFor(el, node, caret?.offset ?? 0);
  }

  ns.pageControls = { keyCommand, jumpTarget, caretAt, clickPosition, isEditable };

  // ---------- live wiring (extension only) ----------

  if (ns.pageControlsInstalled || !globalThis.chrome?.runtime?.onMessage) return;
  ns.pageControlsInstalled = true;

  const state = { active: false, ...SETTINGS_DEFAULTS };
  let pendingJump = null;

  const send = (type, payload) =>
    chrome.runtime.sendMessage({ target: 'background', type, payload: { url: ns.extractedUrl, ...payload } }).catch(() => {});

  function applyClasses() {
    const root = document.documentElement;
    root.classList.toggle('chapterly-session', state.active);
    root.classList.toggle('chapterly-click', state.active && state.clickToJump);
  }

  chrome.storage?.sync?.get(SETTINGS_DEFAULTS).then((s) => {
    Object.assign(state, s);
    applyClasses();
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (key in changes) state[key] = changes[key].newValue ?? SETTINGS_DEFAULTS[key];
    }
    applyClasses();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'content' || message.type !== 'PAGE_SESSION') return undefined;
    state.active = Boolean(message.payload?.active) && message.payload?.url === ns.extractedUrl;
    applyClasses();
    return undefined;
  });

  // Capture phase on window: runs before the site's own key handlers.
  window.addEventListener(
    'keydown',
    (event) => {
      const command = keyCommand(event, state);
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void send('PAGE_COMMAND', { command });
    },
    true,
  );

  document.addEventListener(
    'click',
    (event) => {
      if ((event.detail ?? 1) > 1) {
        clearTimeout(pendingJump); // second click of a double click: no jump
        pendingJump = null;
        return;
      }
      const el = jumpTarget(event, { ...state, selectionCollapsed: window.getSelection()?.isCollapsed ?? true });
      if (!el) return;
      const position = clickPosition(el, caretAt(document, event.clientX, event.clientY));
      if (!position) return;
      clearTimeout(pendingJump);
      pendingJump = setTimeout(() => {
        pendingJump = null;
        if (window.getSelection()?.isCollapsed === false) return;
        void send('PAGE_SEEK', position);
      }, DOUBLE_CLICK_MS);
    },
    true,
  );
  document.addEventListener('dblclick', () => clearTimeout(pendingJump), true);
})();
