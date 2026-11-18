import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentScriptsPresent, ensureContentScripts, resetContentScripts } from '../src/background/inject.js';
import { CONTENT_SCRIPT_FILES } from '../src/content/extractors/registry.js';
import { evalContentScripts, loadPage } from './helpers/load-page.js';
import { flush } from './helpers/fakes.js';

const URL_1 = 'https://novels.test/story/chapter-1';
const HTML = '<!doctype html><html><body><p data-chapterly-p="0">Some chapter text.</p></body></html>';

/** chrome.* as a content script sees it. runtime.id undefined = orphaned. */
function pageChrome() {
  const listeners = [];
  const sent = [];
  return {
    sent,
    fire: (message) => listeners.forEach((fn) => fn(message, {}, () => {})),
    runtime: {
      id: 'ext-1',
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (message) => {
        sent.push(message);
        return undefined;
      },
    },
    storage: {
      sync: { get: async (defaults) => ({ ...defaults }) },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };
}

/** chrome.scripting that runs funcs and files in a jsdom page, serialized like Chrome does. */
function pageScripting(window) {
  const calls = [];
  return {
    calls,
    async executeScript({ func, args = [], files }) {
      if (files) {
        calls.push('files');
        evalContentScripts(window, files);
        return [{}];
      }
      calls.push(func.name || 'func');
      const fn = window.eval(`(${func.toString()})`);
      return [{ result: fn(...args) }];
    },
  };
}

// ---------- versioned injection ----------

test('contentScriptsPresent: only when the instance id matches this extension load', async () => {
  const { window } = loadPage(HTML, URL_1);
  const scripting = pageScripting(window);
  assert.equal(await contentScriptsPresent(scripting, 1, 'new'), false, 'scripts there, but no stamp');
  window.ChapterlyContent.instanceId = 'old';
  assert.equal(await contentScriptsPresent(scripting, 1, 'new'), false, 'stamp of an older load');
  window.ChapterlyContent.instanceId = 'new';
  assert.equal(await contentScriptsPresent(scripting, 1, 'new'), true);
  assert.equal(await contentScriptsPresent(scripting, 1, undefined), false, 'no id yet');
  window.close();
});

test('a page without content scripts gets them injected and stamped', async () => {
  const { window } = loadPage(HTML, URL_1, { scripts: false });
  const scripting = pageScripting(window);
  assert.equal(await ensureContentScripts(scripting, 1, CONTENT_SCRIPT_FILES, 'id-A'), true);
  assert.equal(window.ChapterlyContent.instanceId, 'id-A');
  assert.equal(typeof window.ChapterlyContent.extract, 'function');
  assert.equal(await ensureContentScripts(scripting, 1, CONTENT_SCRIPT_FILES, 'id-A'), false, 'second time: present');
  assert.equal(scripting.calls.filter((c) => c === 'files').length, 1);
  window.close();
});

test('after an extension reload the old scripts are replaced: guards reset, old buttons removed, new listeners installed', async () => {
  // The tab holds the previous version: orphaned scripts with their install guards set.
  const chrome = pageChrome();
  const { window, document } = loadPage(HTML, URL_1, { before: (w) => (w.chrome = chrome) });
  const ns = window.ChapterlyContent;
  ns.instanceId = 'old-load';
  document.documentElement.appendChild(document.createElement('chapterly-controls')); // old floating buttons
  const oldStyle = document.createElement('style');
  oldStyle.id = 'chapterly-style';
  document.head.appendChild(oldStyle);
  assert.equal(ns.pageControlsInstalled, true);
  assert.equal(ns.floatingControlsInstalled, true);
  const oldLive = ns.pageControlsLive;

  const scripting = pageScripting(window);
  assert.equal(await ensureContentScripts(scripting, 1, CONTENT_SCRIPT_FILES, 'new-load'), true);
  assert.deepEqual(scripting.calls, ['func', 'resetContentScripts', 'files', 'func'], 'probe, reset, inject, stamp');
  assert.equal(ns.instanceId, 'new-load');
  assert.equal(document.querySelectorAll('chapterly-controls').length, 0, 'old host removed');
  assert.equal(document.getElementById('chapterly-style'), null, 'old highlight style removed');
  assert.equal(ns.pageControlsInstalled, true, 'the new page-controls installed itself again');
  assert.equal(ns.floatingControlsInstalled, true);
  assert.notEqual(ns.pageControlsLive, oldLive, 'new listeners, not the old ones');
  window.close();
});

test('resetContentScripts clears every *Installed guard', () => {
  const { window } = loadPage(HTML, URL_1, { scripts: false });
  window.ChapterlyContent = { pageControlsInstalled: true, floatingControlsInstalled: true, highlightInstalled: true, somethingElseInstalled: true, extract() {}, instanceId: 'x' };
  const cleared = window.eval(`(${resetContentScripts.toString()})`)();
  assert.equal(cleared, 4);
  const ns = window.ChapterlyContent;
  assert.deepEqual(
    [ns.pageControlsInstalled, ns.floatingControlsInstalled, ns.highlightInstalled, ns.somethingElseInstalled],
    [false, false, false, false],
  );
  assert.equal(ns.instanceId, undefined);
  window.close();
});

// ---------- orphan-safe listeners ----------

/**
 * A page whose content scripts run with a connected (fake) chrome and have the active
 * session. Waits for their async setup before the test and before closing the page, so
 * nothing runs against a closed jsdom window.
 */
async function withLivePage(run) {
  const chrome = pageChrome();
  const page = loadPage(HTML, URL_1, { before: (w) => (w.chrome = chrome) });
  page.ns.extractedUrl = URL_1;
  chrome.fire({ target: 'content', type: 'PAGE_SESSION', payload: { url: URL_1, active: true } });
  const key = (k) => {
    const event = new page.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    page.document.body.dispatchEvent(event);
    return event;
  };
  await flush(2);
  try {
    await run({ ...page, chrome, key });
  } finally {
    await flush(2);
    page.window.close(); // also stops the 1 s leave check
  }
}

test('page keys work while connected; an orphaned handler does not swallow them', () =>
  withLivePage(({ chrome, key }) => {
    const commands = () => chrome.sent.filter((m) => m.type === 'PAGE_COMMAND').map((m) => m.payload.command);
    const live = key('ArrowRight');
    assert.equal(live.defaultPrevented, true);
    assert.deepEqual(commands(), ['next']);

    chrome.runtime.id = undefined; // extension reloaded: this copy is orphaned
    const orphan = key('ArrowRight');
    assert.equal(orphan.defaultPrevented, false, 'the key reaches the site / the new version');
    assert.deepEqual(commands(), ['next'], 'nothing sent');
  }));

test('an orphaned floating widget removes itself', async () => {
  const chrome = pageChrome();
  const { window, document, ns } = loadPage(HTML, URL_1);
  ns.extractedUrl = URL_1;
  chrome.storage.sync.get = async (d) => ({ ...d, floatingControls: true });
  const ctl = ns.floatingControls.createController({ doc: document, win: window, chrome });
  await ctl.start();
  ctl.setSession(true);
  assert.ok(document.querySelector('chapterly-controls'));
  chrome.runtime.id = undefined;
  ctl.onResize();
  assert.equal(document.querySelector('chapterly-controls'), null);
  ctl.setSession(true);
  assert.equal(document.querySelector('chapterly-controls'), null, 'not built again');
  await flush(2);
  window.close();
});

// ---------- leaving the page (content side) ----------

test('pagehide sends PAGE_LEAVING once while the page has the session', () =>
  withLivePage(({ window, chrome }) => {
    window.dispatchEvent(new window.Event('pagehide'));
    window.dispatchEvent(new window.Event('pagehide'));
    const leaving = chrome.sent.filter((m) => m.type === 'PAGE_LEAVING');
    assert.equal(leaving.length, 1);
    assert.deepEqual({ ...leaving[0].payload }, { url: URL_1 });
    assert.equal(leaving[0].target, 'background');
  }));

test('an SPA URL change sends PAGE_LEAVING; a #hash change does not', () =>
  withLivePage(({ window, ns, chrome }) => {
    window.history.pushState({}, '', `${URL_1}#comments`);
    ns.pageControlsLive.checkUrl();
    assert.equal(chrome.sent.filter((m) => m.type === 'PAGE_LEAVING').length, 0, 'same page');
    assert.equal(ns.pageControlsLive.watching, true, 'the 1 s check runs while active');

    window.history.pushState({}, '', 'https://novels.test/story/chapter-2');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    assert.equal(chrome.sent.filter((m) => m.type === 'PAGE_LEAVING').length, 1);
    assert.equal(ns.pageControlsLive.active, false, 'this page no longer has the session');
    assert.equal(ns.pageControlsLive.watching, false, 'check stopped');
  }));

test('nothing is sent and nothing is watched without an active session', () =>
  withLivePage(({ window, ns, chrome }) => {
    chrome.fire({ target: 'content', type: 'PAGE_SESSION', payload: { url: URL_1, active: false } });
    assert.equal(ns.pageControlsLive.watching, false);
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(chrome.sent.filter((m) => m.type === 'PAGE_LEAVING').length, 0);
  }));
