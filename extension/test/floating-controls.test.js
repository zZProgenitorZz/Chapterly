import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './helpers/load-page.js';
import { flush } from './helpers/fakes.js';
import { controlsStateFrom, createControlsNotifier } from '../src/background/controls-state.js';

const URL_1 = 'https://novels.test/story/chapter-1';
const VIEWPORT = { width: 1000, height: 700 };
const SIZE = { width: 150, height: 40 };
const plain = (o) => JSON.parse(JSON.stringify(o)); // out of the jsdom realm

function fakeEvent() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), fire: (...args) => [...listeners].forEach((fn) => fn(...args)) };
}

function fakeChrome({ sync = {}, local = {}, respond = () => undefined } = {}) {
  const sent = [];
  return {
    sent,
    local,
    runtime: {
      onMessage: fakeEvent(),
      sendMessage: async (message) => {
        sent.push(message);
        return respond(message);
      },
    },
    storage: {
      onChanged: fakeEvent(),
      sync: { get: async (defaults) => ({ ...defaults, ...sync }) },
      local: {
        get: async (key) => (key in local ? { [key]: local[key] } : {}),
        set: async (items) => Object.assign(local, items),
      },
    },
  };
}

async function setup({ enabled = false, active = false, anchor, respond, viewport = { ...VIEWPORT } } = {}) {
  const page = loadPage('<!doctype html><html><body><p data-chapterly-p="0">Some chapter text.</p></body></html>', URL_1);
  const { window, document, ns } = page;
  ns.extractedUrl = URL_1;
  const chrome = fakeChrome({
    sync: { floatingControls: enabled },
    local: anchor ? { floatingControlsPosition: anchor } : {},
    respond,
  });
  const ctl = ns.floatingControls.createController({ doc: document, win: window, chrome, viewport: () => viewport, measure: () => SIZE });
  await ctl.start();
  if (active) chrome.runtime.onMessage.fire({ target: 'content', type: 'PAGE_SESSION', payload: { url: URL_1, active: true } });
  await flush(1);
  const $ = (sel) => ctl.root?.querySelector(sel);
  const visible = () => Boolean(ctl.host) && ctl.host.style.display !== 'none';
  const commands = () => chrome.sent.filter((m) => m.type === 'PAGE_COMMAND').map((m) => m.payload.command);
  const pointer = (type, target, x, y) =>
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  const click = (target, detail = 1) => target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true, detail }));
  return { ...page, chrome, ctl, $, visible, commands, pointer, click, viewport };
}

// ---------- visibility ----------

test('hidden by default: no host element is even created', async () => {
  const { ctl, document, visible } = await setup({ active: true });
  assert.equal(visible(), false);
  assert.equal(ctl.host, null);
  assert.equal(document.querySelector('chapterly-controls'), null);
});

test('shown when the setting is on and this page has the active session', async () => {
  const { ctl, document, visible, $ } = await setup({ enabled: true, active: true });
  assert.equal(visible(), true);
  const host = document.querySelector('chapterly-controls');
  assert.equal(host.parentNode, document.documentElement, 'appended to <html>, not <body>');
  assert.match(host.style.cssText, /position: fixed/);
  assert.equal(host.style.zIndex, '2147483647');
  assert.equal(host.shadowRoot, null, 'closed shadow root');
  assert.ok($('.pill'));
  assert.deepEqual(
    [...ctl.root.querySelectorAll('button')].map((b) => [b.getAttribute('aria-label'), b.title]),
    [
      ['Previous (←)', 'Previous (←)'],
      ['Play (k)', 'Play (k)'],
      ['Next (→)', 'Next (→)'],
    ],
  );
});

test('not shown without an active session, or for another page', async () => {
  const { chrome, visible } = await setup({ enabled: true });
  assert.equal(visible(), false);
  chrome.runtime.onMessage.fire({ target: 'content', type: 'PAGE_SESSION', payload: { url: 'https://novels.test/other', active: true } });
  assert.equal(visible(), false);
});

test('hides when the setting goes off, when the session moves elsewhere, and in fullscreen', async () => {
  const { chrome, ctl, document, visible } = await setup({ enabled: true, active: true });
  chrome.storage.onChanged.fire({ floatingControls: { newValue: false } }, 'sync');
  assert.equal(visible(), false, 'setting off');
  chrome.storage.onChanged.fire({ floatingControls: { newValue: true } }, 'sync');
  assert.equal(visible(), true, 'setting on again: immediately');

  chrome.runtime.onMessage.fire({ target: 'content', type: 'PAGE_SESSION', payload: { url: URL_1, active: false } });
  assert.equal(visible(), false, 'another session started');
  chrome.runtime.onMessage.fire({ target: 'content', type: 'PAGE_SESSION', payload: { url: URL_1, active: true } });
  assert.equal(visible(), true);

  Object.defineProperty(document, 'fullscreenElement', { value: document.body, configurable: true });
  ctl.onFullscreenChange();
  assert.equal(visible(), false, 'fullscreen');
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
  ctl.onFullscreenChange();
  assert.equal(visible(), true);
});

test('print styles hide the widget', async () => {
  const { ctl } = await setup({ enabled: true, active: true });
  assert.match(ctl.root.querySelector('style').textContent, /@media print\s*{\s*:host\s*{\s*display:\s*none !important/);
});

// ---------- buttons ----------

test('buttons send the same PAGE_COMMAND as the page keys, with this page URL', async () => {
  const { chrome, $, click, commands } = await setup({ enabled: true, active: true });
  click($('.previous'));
  click($('.play'));
  click($('.next'));
  assert.deepEqual(commands(), ['previous', 'toggle', 'next']);
  const message = chrome.sent.find((m) => m.type === 'PAGE_COMMAND');
  assert.equal(message.target, 'background');
  assert.equal(message.payload.url, URL_1);
});

test('clicks inside the widget never reach the page', async () => {
  const { document, window, $, click, pointer } = await setup({ enabled: true, active: true });
  const seen = [];
  for (const type of ['click', 'pointerdown', 'mousedown', 'dblclick']) document.addEventListener(type, () => seen.push(type));
  pointer('pointerdown', $('.next'), 900, 650);
  $('.next').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, composed: true }));
  click($('.next'));
  $('.grip').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, composed: true }));
  assert.deepEqual(seen, []);
});

test('a mouse click blurs the button; keyboard activation keeps focus', async () => {
  const { ctl, $, click } = await setup({ enabled: true, active: true });
  const next = $('.next');
  next.focus();
  assert.equal(ctl.root.activeElement, next);
  click(next, 0); // Enter/Space: detail 0
  assert.equal(ctl.root.activeElement, next);
  click(next, 1); // mouse
  assert.notEqual(ctl.root.activeElement, next);
});

// ---------- dragging ----------

test('a press that moves less than 4px is a click; more is a drag without a click', async () => {
  const { chrome, ctl, $, pointer, click, commands } = await setup({ enabled: true, active: true });
  // Default place: bottom-right, 24px from both edges.
  assert.deepEqual(plain(ctl.state.position), { left: 1000 - 150 - 24, top: 700 - 40 - 24 });

  const next = $('.next');
  pointer('pointerdown', next, 900, 650);
  pointer('pointermove', next, 902, 652); // 2.8px
  pointer('pointerup', next, 902, 652);
  click(next);
  assert.deepEqual(commands(), ['next'], 'below the threshold: a normal click');
  assert.deepEqual(plain(ctl.state.position), { left: 826, top: 636 }, 'not moved');
  assert.equal(chrome.local.floatingControlsPosition, undefined, 'nothing saved');

  pointer('pointerdown', next, 900, 650);
  pointer('pointermove', next, 760, 520);
  assert.equal($('.pill').classList.contains('dragging'), true);
  pointer('pointermove', next, 750, 500);
  assert.equal(chrome.local.floatingControlsPosition, undefined, 'not saved while moving');
  pointer('pointerup', next, 750, 500);
  click(next);
  assert.deepEqual(commands(), ['next'], 'the drag did not click');
  assert.deepEqual(plain(ctl.state.position), { left: 676, top: 486 });
  await flush(1);
  assert.deepEqual(plain(chrome.local.floatingControlsPosition), { corner: 'bottom-right', dx: 174, dy: 174 }, 'saved on drag end');
});

test('dragging by the grip starts at once and stays inside the viewport', async () => {
  const { ctl, $, pointer } = await setup({ enabled: true, active: true });
  const grip = $('.grip');
  pointer('pointerdown', grip, 830, 650);
  pointer('pointermove', grip, 831, 650); // 1px on the grip already drags
  assert.deepEqual(plain(ctl.state.position), { left: 827, top: 636 });
  pointer('pointermove', grip, -900, -900);
  assert.deepEqual(plain(ctl.state.position), { left: 8, top: 8 }, '8px margin top-left');
  pointer('pointermove', grip, 5000, 5000);
  assert.deepEqual(plain(ctl.state.position), { left: 1000 - 150 - 8, top: 700 - 40 - 8 }, '8px margin bottom-right');
  pointer('pointerup', grip, 5000, 5000);
});

test('double-clicking the grip resets to the default place', async () => {
  const { chrome, ctl, window, $ } = await setup({ enabled: true, active: true, anchor: { corner: 'top-left', dx: 40, dy: 60 } });
  assert.deepEqual(plain(ctl.state.position), { left: 40, top: 60 });
  $('.grip').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, composed: true }));
  await flush(1);
  assert.deepEqual(plain(ctl.state.position), { left: 826, top: 636 });
  assert.deepEqual(plain(chrome.local.floatingControlsPosition), { corner: 'bottom-right', dx: 24, dy: 24 });
});

test('a stored position is restored, and kept relative to its corner on resize', async () => {
  const { ctl, viewport } = await setup({ enabled: true, active: true, anchor: { corner: 'bottom-left', dx: 30, dy: 50 } });
  assert.deepEqual(plain(ctl.state.position), { left: 30, top: 700 - 40 - 50 });
  viewport.height = 500; // window got smaller
  ctl.onResize();
  assert.deepEqual(plain(ctl.state.position), { left: 30, top: 500 - 40 - 50 }, 'same distance to the bottom-left corner');
  viewport.width = 120; // narrower than the pill + margins: pinned to the margin
  ctl.onResize();
  assert.equal(ctl.state.position.left, 8);
});

// ---------- position maths ----------

test('corner and offset maths: save and restore round-trip, also after a resize', async () => {
  const { ns } = await setup();
  const { anchorFromPosition, positionFromAnchor, clampPosition, normalizeAnchor } = ns.floatingControls;
  const cases = [
    [{ left: 20, top: 30 }, { corner: 'top-left', dx: 20, dy: 30 }],
    [{ left: 700, top: 30 }, { corner: 'top-right', dx: 150, dy: 30 }],
    [{ left: 20, top: 600 }, { corner: 'bottom-left', dx: 20, dy: 60 }],
    [{ left: 700, top: 600 }, { corner: 'bottom-right', dx: 150, dy: 60 }],
  ];
  for (const [position, anchor] of cases) {
    assert.deepEqual(plain(anchorFromPosition(position, SIZE, VIEWPORT)), anchor, anchor.corner);
    assert.deepEqual(plain(positionFromAnchor(anchor, SIZE, VIEWPORT)), position, `${anchor.corner} back`);
  }
  // After a resize the distance to the corner is kept.
  assert.deepEqual(plain(positionFromAnchor({ corner: 'top-right', dx: 150, dy: 30 }, SIZE, { width: 1400, height: 900 })), { left: 1100, top: 30 });
  assert.deepEqual(plain(positionFromAnchor({ corner: 'bottom-right', dx: 150, dy: 60 }, SIZE, { width: 1400, height: 900 })), { left: 1100, top: 800 });
  // Clamped when the stored distance no longer fits.
  assert.deepEqual(plain(positionFromAnchor({ corner: 'top-left', dx: 2000, dy: 2000 }, SIZE, VIEWPORT)), { left: 842, top: 652 });
  assert.deepEqual(plain(clampPosition({ left: -5, top: 9999 }, SIZE, VIEWPORT)), { left: 8, top: 652 });
  // Garbage in storage falls back to the default.
  assert.deepEqual(plain(normalizeAnchor({ corner: 'middle', dx: 1, dy: 1 })), { corner: 'bottom-right', dx: 24, dy: 24 });
  assert.deepEqual(plain(normalizeAnchor(null)), { corner: 'bottom-right', dx: 24, dy: 24 });
});

// ---------- player state ----------

test('state rendering: playing shows pause, loading shows the ring, error shows the dot with the message', async () => {
  const { chrome, $ } = await setup({ enabled: true, active: true });
  const show = (payload) => chrome.runtime.onMessage.fire({ target: 'content', type: 'CONTROLS_STATE', payload: { url: URL_1, index: 3, total: 10, ...payload } });

  show({ status: 'playing' });
  assert.equal($('.play').dataset.playing, 'true', 'pause icon');
  assert.equal($('.play').title, 'Pause (k)');

  show({ status: 'paused' });
  assert.equal($('.play').dataset.playing, 'false', 'play icon');

  show({ status: 'loading' });
  assert.equal($('.pill').dataset.status, 'loading', 'ring (CSS on data-status)');
  assert.match(ctlCss($), /\[data-status='loading'\] \.play::after/);

  show({ status: 'error', error: 'Kokoro is not running.' });
  assert.equal($('.pill').dataset.status, 'error');
  assert.equal($('.play').title, 'Error: Kokoro is not running.');
  assert.match(ctlCss($), /\[data-status='error'\] \.dot \{ display: block/);

  show({ status: 'playing', url: 'https://novels.test/other' });
  assert.equal($('.pill').dataset.status, 'error', 'state for another page is ignored');
});

const ctlCss = ($) => $('style').textContent;

test('asks for the state once on injection and when the session becomes active', async () => {
  const { chrome, $ } = await setup({
    enabled: true,
    active: true,
    respond: (m) => (m.type === 'GET_CONTROLS_STATE' ? { ok: true, status: 'paused', index: 4, total: 9, error: null } : undefined),
  });
  const asks = chrome.sent.filter((m) => m.type === 'GET_CONTROLS_STATE');
  assert.equal(asks.length, 2, 'on start and on PAGE_SESSION active');
  assert.equal(asks[0].payload.url, URL_1);
  assert.equal($('.pill').dataset.status, 'paused');
});

test('reduced motion turns the pulse and press animation off', async () => {
  const { $ } = await setup({ enabled: true, active: true });
  assert.match(ctlCss($), /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
});

// ---------- service worker: CONTROLS_STATE only on change ----------

test('CONTROLS_STATE is sent only when the status or index changed', () => {
  const sent = [];
  const notifier = createControlsNotifier((tabId, payload) => sent.push({ tabId, ...payload }));
  const session = { sessionId: 's1', kind: 'chapter', tabId: 7, url: URL_1 };
  const state = (status, index, extra = {}) => ({ sessionId: 's1', status, index, total: 10, ...extra });

  assert.equal(notifier.notify(session, state('loading', 0)), true);
  assert.equal(notifier.notify(session, state('loading', 0, { position: 2 })), false, 'nothing relevant changed');
  assert.equal(notifier.notify(session, state('playing', 0)), true, 'status changed');
  assert.equal(notifier.notify(session, state('playing', 0)), false);
  assert.equal(notifier.notify(session, state('playing', 1)), true, 'index changed');
  assert.equal(notifier.notify(session, state('playing', 1), { force: true }), true, 'forced');
  notifier.reset();
  assert.equal(notifier.notify(session, state('playing', 1)), true, 'after reset (PAGE_SESSION active)');
  assert.deepEqual(sent[0], { tabId: 7, url: URL_1, status: 'loading', index: 0, total: 10, error: null });
  assert.equal(sent.length, 5);
});

test('no CONTROLS_STATE for selection sessions or another session\'s state', () => {
  const sent = [];
  const notifier = createControlsNotifier((tabId, payload) => sent.push(payload));
  assert.equal(notifier.notify({ sessionId: 's', kind: 'selection', tabId: 1, url: 'u' }, { sessionId: 's', status: 'playing' }), false);
  assert.equal(notifier.notify({ sessionId: 's', kind: 'chapter', tabId: 1, url: 'u' }, { sessionId: 'other', status: 'playing' }), false);
  assert.equal(notifier.notify(null, { sessionId: 's' }), false);
  assert.equal(sent.length, 0);
});

test('the error text for the floating buttons is the readable message', () => {
  const s = controlsStateFrom({
    status: 'error',
    index: 2,
    total: 5,
    error: { kind: 'BackendError', reason: 'UNAVAILABLE', provider: 'kokoro', message: 'Kokoro server not reachable at http://localhost:8880. Is it running?' },
  });
  assert.deepEqual(s, { status: 'error', index: 2, total: 5, error: 'Kokoro is not running. Start the Kokoro server on localhost:8880.' });
  assert.equal(controlsStateFrom({ status: 'playing', error: { message: 'old' } }).error, null);
});
