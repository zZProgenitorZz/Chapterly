// Floating previous / play-pause / next buttons on the reading page, so reading can be
// controlled with the mouse while the popup is closed. Classic script (see cleaning.js);
// installs once per page.
//
// Shown only while all of these hold: the setting floatingControls is on (chrome.storage.sync,
// default off), the service worker said this page's chapter session is active (PAGE_SESSION),
// and the page is not in fullscreen. Hidden in print. The host element is created only when
// the buttons are first shown; it lives in a closed shadow root, so the site's CSS can't
// break it and ours can't touch the site.
//
// Buttons send the same PAGE_COMMAND as the arrow keys (page-controls.js). The play/pause icon
// and status follow CONTROLS_STATE messages from the service worker.
//
// The pill can be dragged anywhere (by the grip, or anywhere with a 4px threshold). Its place
// is stored per device in chrome.storage.local as the nearest corner and the distance to it,
// so it stays put when the window is resized. Double-click the grip to reset.
//
// Orphan-safe: after the extension is reloaded or updated, chrome.runtime.id is gone; the
// widget then removes its own element and ignores everything (the new version brings its own).
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});

  const SETTING = 'floatingControls';
  const POSITION_KEY = 'floatingControlsPosition';
  const MARGIN = 8; // px kept free between the pill and the viewport edges
  const DRAG_THRESHOLD = 4; // px; less is a click
  const DEFAULT_ANCHOR = Object.freeze({ corner: 'bottom-right', dx: 24, dy: 24 });
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const FALLBACK_SIZE = { width: 148, height: 42 }; // before layout (and in jsdom)
  const BUSY = new Set(['playing', 'loading', 'buffering']);

  // ---------- pure position maths (tested in jsdom) ----------

  /** Keeps a {left, top} box of `size` inside the viewport, `margin` px from every edge. */
  function clampPosition({ left, top }, size, viewport, margin = MARGIN) {
    const maxLeft = Math.max(margin, viewport.width - size.width - margin);
    const maxTop = Math.max(margin, viewport.height - size.height - margin);
    return {
      left: Math.round(Math.min(Math.max(left, margin), maxLeft)),
      top: Math.round(Math.min(Math.max(top, margin), maxTop)),
    };
  }

  function normalizeAnchor(anchor) {
    if (!anchor || !CORNERS.includes(anchor.corner)) return { ...DEFAULT_ANCHOR };
    const dx = Number(anchor.dx);
    const dy = Number(anchor.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { ...DEFAULT_ANCHOR };
    return { corner: anchor.corner, dx: Math.max(0, dx), dy: Math.max(0, dy) };
  }

  /** {corner, dx, dy} -> {left, top} for this viewport, clamped. */
  function positionFromAnchor(anchor, size, viewport, margin = MARGIN) {
    const { corner, dx, dy } = normalizeAnchor(anchor);
    const left = corner.endsWith('left') ? dx : viewport.width - size.width - dx;
    const top = corner.startsWith('top') ? dy : viewport.height - size.height - dy;
    return clampPosition({ left, top }, size, viewport, margin);
  }

  /** {left, top} -> the nearest corner and the distance to it. */
  function anchorFromPosition({ left, top }, size, viewport) {
    const right = viewport.width - size.width - left;
    const bottom = viewport.height - size.height - top;
    const horizontal = left + size.width / 2 <= viewport.width / 2 ? 'left' : 'right';
    const vertical = top + size.height / 2 <= viewport.height / 2 ? 'top' : 'bottom';
    return {
      corner: `${vertical}-${horizontal}`,
      dx: Math.max(0, Math.round(horizontal === 'left' ? left : right)),
      dy: Math.max(0, Math.round(vertical === 'top' ? top : bottom)),
    };
  }

  // ---------- look ----------

  const ICONS = {
    grip: '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.3"/><circle cx="6" cy="2" r="1.3"/><circle cx="2" cy="7" r="1.3"/><circle cx="6" cy="7" r="1.3"/><circle cx="2" cy="12" r="1.3"/><circle cx="6" cy="12" r="1.3"/></svg>',
    previous: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3.5" width="2" height="9" rx="1"/><path d="M13 3.9v8.2a.6.6 0 0 1-.9.5L6 8.5a.6.6 0 0 1 0-1l6.1-4.1a.6.6 0 0 1 .9.5Z"/></svg>',
    next: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="11" y="3.5" width="2" height="9" rx="1"/><path d="M3 3.9v8.2a.6.6 0 0 0 .9.5L10 8.5a.6.6 0 0 0 0-1L3.9 3.4a.6.6 0 0 0-.9.5Z"/></svg>',
    play: '<svg class="icon-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.6v8.8a.7.7 0 0 0 1.05.6l7-4.4a.7.7 0 0 0 0-1.2l-7-4.4a.7.7 0 0 0-1.05.6Z"/></svg>',
    pause: '<svg class="icon-pause" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="2.8" height="9" rx="1"/><rect x="9.2" y="3.5" width="2.8" height="9" rx="1"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    @media print { :host { display: none !important; } }
    .pill {
      display: flex; align-items: center; gap: 4px;
      height: 40px; padding: 0 5px 0 4px; box-sizing: border-box;
      border-radius: 999px;
      background: rgba(12, 10, 20, 0.78);
      -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 12px 32px -12px rgba(0, 0, 0, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      color: #f4f2fb;
      font: 500 12px/1 system-ui, -apple-system, 'Segoe UI', sans-serif;
      user-select: none; -webkit-user-select: none;
      touch-action: none;
    }
    .pill.dragging { cursor: grabbing; box-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(167, 139, 250, 0.35); }
    .grip {
      display: grid; place-items: center; width: 16px; height: 30px;
      color: rgba(244, 242, 251, 0.45); cursor: grab; touch-action: none;
    }
    .grip:hover { color: rgba(244, 242, 251, 0.8); }
    .pill.dragging .grip { cursor: grabbing; }
    .grip svg { width: 6px; height: 11px; fill: currentColor; }
    button {
      all: unset; box-sizing: border-box; position: relative;
      display: grid; place-items: center; width: 30px; height: 30px;
      border-radius: 50%; cursor: pointer; color: #f4f2fb;
      transition: background-color 0.2s cubic-bezier(.2,.7,.2,1), transform 0.2s cubic-bezier(.2,.7,.2,1);
    }
    button svg { width: 14px; height: 14px; fill: currentColor; }
    button:hover { background: rgba(255, 255, 255, 0.09); }
    button:active { transform: scale(0.94); }
    button:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
    .play { background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff; box-shadow: 0 6px 16px -6px rgba(139, 92, 246, 0.9); }
    .play:hover { background: linear-gradient(135deg, #a78bfa, #8b5cf6); }
    .play .icon-pause { display: none; }
    .play[data-playing='true'] .icon-pause { display: block; }
    .play[data-playing='true'] .icon-play { display: none; }
    /* loading / buffering: thin pulsing ring */
    .play::after {
      content: ''; position: absolute; inset: -3px; border-radius: 50%;
      border: 1.5px solid rgba(167, 139, 250, 0.85); opacity: 0; pointer-events: none;
    }
    .pill[data-status='loading'] .play::after,
    .pill[data-status='buffering'] .play::after { opacity: 1; animation: ring 1.4s cubic-bezier(.2,.7,.2,1) infinite; }
    @keyframes ring { 0% { transform: scale(0.92); opacity: 0.95; } 100% { transform: scale(1.18); opacity: 0; } }
    /* error: rose dot (the title carries the message) */
    .dot {
      display: none; position: absolute; top: 1px; right: 1px; width: 7px; height: 7px;
      border-radius: 50%; background: #fb7185; box-shadow: 0 0 0 2px rgba(12, 10, 20, 0.9);
    }
    .pill[data-status='error'] .dot { display: block; }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
      button:active { transform: none; }
      .pill[data-status='loading'] .play::after,
      .pill[data-status='buffering'] .play::after { animation: none; opacity: 0.9; }
    }
  `;

  // ---------- controller ----------

  /**
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {Window} deps.win
   * @param {object} deps.chrome chrome.* (runtime, storage) or a fake
   * @param {() => {width, height}} [deps.viewport] viewport size (tests)
   * @param {() => {width, height}} [deps.measure] pill size (tests)
   */
  function createController({ doc, win, chrome, viewport, measure }) {
    const state = {
      enabled: false, // the setting
      active: false, // PAGE_SESSION for this page
      fullscreen: Boolean(doc.fullscreenElement),
      player: { status: 'idle', index: 0, total: 0, error: null },
      anchor: { ...DEFAULT_ANCHOR },
      position: null, // {left, top} while shown
    };
    let host = null;
    let root = null;
    const ui = {};
    let drag = null; // {pointerId, startX, startY, left, top, threshold, moved}
    let suppressClickUntil = 0;
    let dead = false;

    /** True (and the widget removed) once this copy's extension context is gone. */
    function orphaned() {
      if (dead) return true;
      if (chrome.runtime?.id) return false;
      dead = true;
      host?.remove();
      host = null;
      root = null;
      return true;
    }

    const getViewport =
      viewport ??
      (() => ({
        width: doc.documentElement.clientWidth || win.innerWidth,
        height: doc.documentElement.clientHeight || win.innerHeight,
      }));
    const getSize =
      measure ??
      (() => {
        const rect = host?.getBoundingClientRect();
        return rect?.width ? { width: rect.width, height: rect.height } : { ...FALLBACK_SIZE };
      });

    const send = (type, payload) =>
      Promise.resolve(chrome.runtime.sendMessage({ target: 'background', type, payload: { url: ns.extractedUrl, ...payload } })).catch(() => undefined);

    // ----- DOM -----

    function build() {
      host = doc.createElement('chapterly-controls');
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0; display: none;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style>
        <div class="pill" role="toolbar" aria-label="Chapterly reading controls" data-status="idle">
          <span class="grip" title="Drag to move · double-click to reset">${ICONS.grip}</span>
          <button type="button" class="previous" data-command="previous" aria-label="Previous (←)" title="Previous (←)">${ICONS.previous}</button>
          <button type="button" class="play" data-command="toggle" aria-label="Play/pause (k)" title="Play/pause (k)">${ICONS.play}${ICONS.pause}<span class="dot"></span></button>
          <button type="button" class="next" data-command="next" aria-label="Next (→)" title="Next (→)">${ICONS.next}</button>
        </div>`;
      ui.pill = root.querySelector('.pill');
      ui.grip = root.querySelector('.grip');
      ui.play = root.querySelector('.play');
      ui.buttons = [...root.querySelectorAll('button')];

      // Nothing inside the widget reaches the page (click-to-jump, site handlers).
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart']) {
        root.addEventListener(type, (e) => e.stopPropagation());
      }
      // A drag must never end in a click.
      ui.pill.addEventListener(
        'click',
        (e) => {
          if (orphaned()) return;
          if (Date.now() < suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        true,
      );
      for (const button of ui.buttons) {
        button.addEventListener('click', (e) => {
          if (orphaned()) return;
          void send('PAGE_COMMAND', { command: button.dataset.command });
          if (e.detail > 0) button.blur(); // mouse: don't keep focus (Space/Enter would repeat it)
        });
      }
      ui.pill.addEventListener('pointerdown', onPointerDown);
      ui.pill.addEventListener('pointermove', onPointerMove);
      ui.pill.addEventListener('pointerup', onPointerEnd);
      ui.pill.addEventListener('pointercancel', onPointerEnd);
      ui.grip.addEventListener('dblclick', () => {
        state.anchor = { ...DEFAULT_ANCHOR };
        void saveAnchor();
        placeFromAnchor();
      });
      doc.documentElement.appendChild(host);
      renderPlayer();
    }

    function renderPlayer() {
      if (!ui.pill) return;
      const { status, error } = state.player;
      ui.pill.dataset.status = status;
      ui.play.dataset.playing = String(BUSY.has(status));
      const label = BUSY.has(status) ? 'Pause (k)' : 'Play (k)';
      ui.play.title = status === 'error' && error ? `Error: ${error}` : label;
      ui.play.setAttribute('aria-label', status === 'error' && error ? `Play (k). Error: ${error}` : label);
    }

    function applyPosition(position) {
      state.position = position;
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
    }

    function placeFromAnchor() {
      if (!host || host.style.display === 'none') return;
      applyPosition(positionFromAnchor(state.anchor, getSize(), getViewport()));
    }

    // ----- visibility -----

    function shouldShow() {
      return state.enabled && state.active && !state.fullscreen;
    }

    function update() {
      if (orphaned()) return;
      const show = shouldShow();
      if (show && !host) build();
      if (!host) return;
      host.style.display = show ? 'block' : 'none';
      if (show) placeFromAnchor();
    }

    // ----- dragging -----

    function onPointerDown(e) {
      if (orphaned()) return;
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      const onGrip = ui.grip.contains(e.target);
      const pos = state.position ?? { left: 0, top: 0 };
      drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, left: pos.left, top: pos.top, threshold: onGrip ? 0 : DRAG_THRESHOLD, moved: false };
      if (onGrip) e.preventDefault(); // no text selection / focus change from the grip
    }

    function onPointerMove(e) {
      if (!drag || (drag.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) <= drag.threshold) return; // grip: any movement; elsewhere: 4px
        drag.moved = true;
        ui.pill.classList.add('dragging');
        try {
          ui.pill.setPointerCapture?.(drag.pointerId);
        } catch {
          // no active pointer (synthetic events)
        }
      }
      applyPosition(clampPosition({ left: drag.left + dx, top: drag.top + dy }, getSize(), getViewport()));
    }

    function onPointerEnd(e) {
      if (!drag || (drag.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
      const moved = drag.moved;
      drag = null;
      ui.pill.classList.remove('dragging');
      if (!moved) return; // a press without movement: the click goes through
      suppressClickUntil = Date.now() + 400;
      state.anchor = anchorFromPosition(state.position, getSize(), getViewport());
      void saveAnchor(); // on drag end only
    }

    function saveAnchor() {
      return Promise.resolve(chrome.storage?.local?.set({ [POSITION_KEY]: state.anchor })).catch(() => {});
    }

    // ----- inputs -----

    function setEnabled(enabled) {
      state.enabled = Boolean(enabled);
      update();
    }

    function setSession(active) {
      const was = state.active;
      state.active = Boolean(active);
      update();
      if (state.active && !was) void requestState();
    }

    function setPlayerState(next) {
      state.player = {
        status: next?.status ?? 'idle',
        index: next?.index ?? 0,
        total: next?.total ?? 0,
        error: next?.error ?? null,
      };
      renderPlayer();
    }

    async function requestState() {
      const response = await send('GET_CONTROLS_STATE', {});
      if (response?.status) setPlayerState(response);
    }

    function onMessage(message) {
      if (message?.target !== 'content' || orphaned()) return undefined;
      const payload = message.payload ?? {};
      if (message.type === 'PAGE_SESSION') {
        setSession(Boolean(payload.active) && payload.url === ns.extractedUrl);
      } else if (message.type === 'CONTROLS_STATE') {
        if (payload.url === ns.extractedUrl) setPlayerState(payload);
      }
      return undefined; // never hold the channel
    }

    function onStorageChanged(changes, area) {
      if (orphaned()) return;
      if (area === 'sync' && SETTING in changes) setEnabled(changes[SETTING].newValue);
      if (area === 'local' && POSITION_KEY in changes) {
        state.anchor = normalizeAnchor(changes[POSITION_KEY].newValue);
        placeFromAnchor();
      }
    }

    function onResize() {
      if (orphaned()) return;
      placeFromAnchor(); // same corner and distance, clamped into the new viewport
    }

    function onFullscreenChange() {
      state.fullscreen = Boolean(doc.fullscreenElement);
      update();
    }

    async function start() {
      chrome.runtime?.onMessage?.addListener(onMessage);
      chrome.storage?.onChanged?.addListener(onStorageChanged);
      win.addEventListener('resize', onResize);
      win.visualViewport?.addEventListener('resize', onResize);
      doc.addEventListener('fullscreenchange', onFullscreenChange);
      const [sync, local] = await Promise.all([
        Promise.resolve(chrome.storage?.sync?.get({ [SETTING]: false })).catch(() => null),
        Promise.resolve(chrome.storage?.local?.get(POSITION_KEY)).catch(() => null),
      ]);
      state.anchor = normalizeAnchor(local?.[POSITION_KEY]);
      setEnabled(sync?.[SETTING] ?? false);
      void requestState(); // once on injection
      return api;
    }

    const api = {
      start,
      state,
      setEnabled,
      setSession,
      setPlayerState,
      onMessage,
      onStorageChanged,
      onResize,
      onFullscreenChange,
      get host() {
        return host;
      },
      get root() {
        return root; // closed shadow root: exposed for tests only
      },
    };
    return api;
  }

  ns.floatingControls = { clampPosition, positionFromAnchor, anchorFromPosition, normalizeAnchor, createController, DEFAULT_ANCHOR, POSITION_KEY };

  // ---------- live wiring (extension only) ----------

  if (ns.floatingControlsInstalled || !globalThis.chrome?.runtime?.onMessage) return;
  ns.floatingControlsInstalled = true;
  void createController({ doc: document, win: window, chrome: globalThis.chrome }).start();
})();
