import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFixture } from './helpers/load-page.js';
import { chunkIndexForPosition, chunkParagraphs } from '../src/shared/chunker.js';

const RR_URL = 'https://www.royalroad.com/fiction/99999/the-clockwork-orchard/chapter/1000002/2-the-lantern-market';
const NOTES_URL = 'https://novelplaceholder.example/novel/salt-and-starlight/chapter-7';
/** Copy out of the jsdom realm so deepStrictEqual compares plain objects. */
const plain = (o) => (o == null ? o : { ...o });
const ON = { active: true, arrowKeysControl: true, clickToJump: true };

function rr() {
  return extractFixture('royalroad-chapter.html', RR_URL);
}

/** First text node under `root` that contains `needle`. */
function textNode(document, root, needle) {
  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.includes(needle)) return n;
  throw new Error(`no text node with ${needle}`);
}

const key = (key, target, extra = {}) => ({ key, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
const click = (target, extra = {}) => ({ button: 0, detail: 1, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

// ---------- keyboard ----------

test('arrow keys and k control reading while a session is active', () => {
  const { ns, document } = rr();
  const { keyCommand } = ns.pageControls;
  const body = document.body;
  assert.equal(keyCommand(key('ArrowRight', body), ON), 'next');
  assert.equal(keyCommand(key('ArrowLeft', body), ON), 'previous');
  assert.equal(keyCommand(key('k', body), ON), 'toggle');
  assert.equal(keyCommand(key(' ', body), ON), null, 'Space scrolls the page');
  assert.equal(keyCommand(key('ArrowDown', body), ON), null);
});

test('keys are ignored without a session, with the setting off, with modifiers, and while typing', () => {
  const { ns, document } = rr();
  const { keyCommand } = ns.pageControls;
  const body = document.body;
  assert.equal(keyCommand(key('ArrowRight', body), { ...ON, active: false }), null, 'no session on this page');
  assert.equal(keyCommand(key('ArrowRight', body), { ...ON, arrowKeysControl: false }), null, 'setting off');
  for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    assert.equal(keyCommand(key('ArrowRight', body, { [mod]: true }), ON), null, mod);
  }
  document.body.insertAdjacentHTML(
    'beforeend',
    '<input id="i"><textarea id="t"></textarea><select id="s"></select><div id="ce" contenteditable="true"><span id="inner">x</span></div>',
  );
  for (const id of ['i', 't', 's', 'ce', 'inner']) {
    assert.equal(keyCommand(key('ArrowLeft', document.getElementById(id)), ON), null, id);
  }
  assert.equal(keyCommand(key('k', body, { isComposing: true }), ON), null, 'IME composition');
});

// ---------- click to jump ----------

test('a plain click on a paragraph targets it; links, buttons and forms are ignored', () => {
  const { ns, document } = rr();
  const { jumpTarget } = ns.pageControls;
  const p = document.querySelector('[data-chapterly-p~="7"]');
  assert.equal(jumpTarget(click(textNode(document, p, 'small key')), ON), p, 'click on text (text node target)');
  assert.equal(jumpTarget(click(p), ON), p);

  p.insertAdjacentHTML('beforeend', ' <a href="/x" id="lnk">a <b id="in-link">link</b></a> <button id="btn">b</button> <input id="inp">');
  for (const id of ['lnk', 'in-link', 'btn', 'inp']) assert.equal(jumpTarget(click(document.getElementById(id)), ON), null, id);

  const outside = document.querySelector('.page-footer');
  assert.equal(jumpTarget(click(outside), ON), null, 'not a chapter paragraph');
});

test('no jump while selecting, on double click, with modifiers, other buttons, or settings off', () => {
  const { ns, document } = rr();
  const { jumpTarget } = ns.pageControls;
  const p = document.querySelector('[data-chapterly-p~="7"]');
  assert.equal(jumpTarget(click(p), { ...ON, selectionCollapsed: false }), null, 'text selection');
  assert.equal(jumpTarget(click(p, { detail: 2 }), ON), null, 'double click');
  assert.equal(jumpTarget(click(p, { ctrlKey: true }), ON), null, 'modifier');
  assert.equal(jumpTarget(click(p, { button: 1 }), ON), null, 'middle button');
  assert.equal(jumpTarget(click(p), { ...ON, clickToJump: false }), null, 'setting off');
  assert.equal(jumpTarget(click(p), { ...ON, active: false }), null, 'no session');
});

test('clicked word -> exact offset in the normalised paragraph -> chunk containing it', () => {
  const { ns, document, chapter } = rr();
  const p9 = document.querySelector('[data-chapterly-p~="9"]'); // <em>Three gears…</em> <strong>One for the well…</strong>
  const text = chapter.paragraphs[9].text;
  const node = textNode(document, p9, 'One for the well');
  const pos = ns.pageControls.clickPosition(p9, { node, offset: node.data.indexOf('well') });
  assert.deepEqual(plain(pos), { paragraphIndex: 9, offset: text.indexOf('well') });

  // Split paragraph 9 into sentence parts and check the click lands in the second one.
  const chunks = chunkParagraphs(chapter.paragraphs, { maxChars: 60, firstChunkMaxChars: 60 });
  const parts = chunks.filter((c) => c.paragraphIndex === 9);
  assert.equal(parts.length, 2);
  assert.equal(chunkIndexForPosition(chunks, pos.paragraphIndex, pos.offset), parts[1].index);
  const first = ns.pageControls.clickPosition(p9, { node: textNode(document, p9, 'Three gears'), offset: 2 });
  assert.equal(chunkIndexForPosition(chunks, first.paragraphIndex, first.offset), parts[0].index);
});

test('a click without a usable caret picks the paragraph start', () => {
  const { ns, document } = rr();
  const p = document.querySelector('[data-chapterly-p~="7"]');
  assert.deepEqual(plain(ns.pageControls.clickPosition(p, null)), { paragraphIndex: 7, offset: null });
  const elsewhere = document.querySelector('.page-footer').firstChild;
  assert.deepEqual(plain(ns.pageControls.clickPosition(p, { node: elsewhere, offset: 3 })), { paragraphIndex: 7, offset: null });
});

test('<br>-separated text: the right paragraph and offset despite whitespace, hidden spans and notes', () => {
  const { ns, document, chapter } = extractFixture('hidden-and-notes.html', NOTES_URL);
  const div = document.getElementById('chapter-text');
  assert.equal(div.getAttribute('data-chapterly-p'), '0 1 2 3 4 5');
  const node = textNode(document, div, 'stood a door');
  const pos = ns.pageControls.clickPosition(div, { node, offset: node.data.indexOf('seabed') });
  assert.equal(pos.paragraphIndex, 3);
  assert.equal(pos.offset, chapter.paragraphs[3].text.indexOf('seabed'));

  const last = textNode(document, div, 'knocked back');
  const end = ns.pageControls.clickPosition(div, { node: last, offset: last.data.indexOf('back') });
  assert.deepEqual(plain(end), { paragraphIndex: 5, offset: chapter.paragraphs[5].text.indexOf('back') });

  const note = textNode(document, div, 'A/N: sorry');
  assert.deepEqual(plain(ns.pageControls.clickPosition(div, { node: note, offset: 2 })), { paragraphIndex: 0, offset: null }, 'dropped note: approximate');
});

test('normalised <-> raw offsets and sentence ranges round-trip', () => {
  const { ns, document, chapter } = extractFixture('hidden-and-notes.html', NOTES_URL);
  const { textMap } = ns;
  assert.equal(textMap.normalizedOffset('  a \n  b', 7), 2, '"a b": b is at 2');
  assert.equal(textMap.rawOffsetFor('  a \n  b', 2), 7);
  const div = document.getElementById('chapter-text');
  const text = chapter.paragraphs[2].text;
  const start = text.indexOf('past the last');
  const end = text.indexOf('ago,') + 4;
  const range = textMap.rangeFor(div, 2, start, end);
  assert.equal(range.toString().replace(/\s+/g, ' '), text.slice(start, end));
});
