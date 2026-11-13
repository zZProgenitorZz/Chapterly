import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFixture, fixture, loadPage } from './helpers/load-page.js';

const RR_URL = 'https://www.royalroad.com/fiction/99999/the-clockwork-orchard/chapter/1000002/2-the-lantern-market';
const BLOG_URL = 'https://novels.example/sky-forge-chapter-14/';
const NOTES_URL = 'https://novelplaceholder.example/novel/salt-and-starlight/chapter-7';

const allText = (chapter) => chapter.paragraphs.map((p) => p.text).join('\n');

// ---------- Royal Road ----------

test('royalroad: site extractor is picked on royalroad.com', () => {
  const { chapter } = extractFixture('royalroad-chapter.html', RR_URL);
  assert.equal(chapter.extractorId, 'royalroad');
  assert.equal(chapter.title, '2. The Lantern Market');
  assert.equal(chapter.seriesTitle, 'The Clockwork Orchard');
  assert.equal(chapter.url, RR_URL);
});

test('royalroad: story paragraphs only, in order, inline formatting flattened', () => {
  const { chapter } = extractFixture('royalroad-chapter.html', RR_URL);
  const texts = chapter.paragraphs.map((p) => p.text);
  assert.equal(texts.length, 12);
  assert.deepEqual(texts.slice(0, 2), ['Chapter 002', 'The Lantern Market'], '<br> inside <p> splits paragraphs');
  assert.match(texts[2], /^The lantern market opened/);
  assert.equal(texts[4], '“You’re late,” said the old clockmaker.');
  assert.equal(texts[9], 'Three gears for the gate, she reminded herself. One for the well, and one for the way back.');
  assert.equal(texts.at(-1), 'She tucked the key into her boot and walked, not ran, toward the river.');
  assert.deepEqual(
    chapter.paragraphs.map((p) => p.index),
    texts.map((_, i) => i),
  );
});

test('royalroad: excludes hidden anti-piracy text, author notes, nav, comments, footer', () => {
  const text = allText(extractFixture('royalroad-chapter.html', RR_URL).chapter);
  for (const marker of ['ANTI-PIRACY', 'BEFORE-NOTE', 'AFTER-NOTE', 'Discord', 'COMMENT', 'FOOTER', 'Previous', 'Best Rated']) {
    assert.ok(!text.includes(marker), `"${marker}" must not be read`);
  }
});

test('royalroad: next/prev from rel links, absolute', () => {
  const { chapter } = extractFixture('royalroad-chapter.html', RR_URL);
  assert.equal(chapter.nextChapterUrl, 'https://www.royalroad.com/fiction/99999/the-clockwork-orchard/chapter/1000003/3-rust-and-rain');
  assert.equal(chapter.prevChapterUrl, 'https://www.royalroad.com/fiction/99999/the-clockwork-orchard/chapter/1000001/1-seeds-of-brass');
});

test('royalroad: falls back to the nav buttons when there are no rel links', () => {
  const html = fixture('royalroad-chapter.html').replace(/<link rel="(?:next|prev)"[^>]*>/g, '');
  const { ns, document } = loadPage(html, RR_URL);
  const chapter = ns.extract(document);
  assert.match(chapter.nextChapterUrl, /\/chapter\/1000003\//);
  assert.match(chapter.prevChapterUrl, /\/chapter\/1000001\//);
});

test('royalroad: paragraphs map to their live elements for highlighting', () => {
  const { document } = extractFixture('royalroad-chapter.html', RR_URL);
  const first = document.querySelector('.chapter-content p');
  assert.equal(first.getAttribute('data-chapterly-p'), '0 1', 'both lines of the heading paragraph');
  const juggler = [...document.querySelectorAll('[data-chapterly-p]')].find((el) => el.textContent.includes('juggler'));
  assert.equal(juggler.getAttribute('data-chapterly-p'), '10');
  assert.equal(document.querySelectorAll('[data-chapterly-id]').length, 0, 'temporary ids are removed');
});

test('royalroad extractor only matches royalroad.com', () => {
  const { chapter } = extractFixture('royalroad-chapter.html', 'https://mirror.example/fiction/1/chapter/2');
  assert.equal(chapter.extractorId, 'generic');
});

// ---------- generic (Readability) ----------

test('generic: blog chapter body only', () => {
  const { chapter } = extractFixture('generic-blog-chapter.html', BLOG_URL);
  assert.equal(chapter.extractorId, 'generic');
  assert.match(chapter.title, /Chapter 14: The Iron Choir/);
  const texts = chapter.paragraphs.map((p) => p.text);
  assert.equal(texts.length, 9);
  assert.match(texts[0], /^The bells of the forge city did not ring/);
  assert.equal(texts[7], '“Sing,” she said.');
  assert.match(texts.at(-1), /^So he sang\./);
});

test('generic: excludes nav line, TL note, translator block, Patreon promo, comments, sidebar', () => {
  const text = allText(extractFixture('generic-blog-chapter.html', BLOG_URL).chapter);
  for (const marker of ['Previous Chapter', 'Table of Contents', 'TL Note', 'Translator’s rant', 'Patreon', 'COMMENT', 'SIDEBAR', 'FOOTER', 'Posted on']) {
    assert.ok(!text.includes(marker), `"${marker}" must not be read`);
  }
});

test('generic: next/prev by anchor text, same origin preferred over an external "Next ›"', () => {
  const { chapter } = extractFixture('generic-blog-chapter.html', BLOG_URL);
  assert.equal(chapter.nextChapterUrl, 'https://novels.example/sky-forge-chapter-15/');
  assert.equal(chapter.prevChapterUrl, 'https://novels.example/sky-forge-chapter-13/');
});

test('generic: paragraphs map back to live <p> elements', () => {
  const { document } = extractFixture('generic-blog-chapter.html', BLOG_URL);
  const mapped = [...document.querySelectorAll('[data-chapterly-p]')];
  assert.equal(mapped.length, 9);
  assert.ok(mapped.every((el) => el.tagName === 'P' && el.closest('.entry-content')));
});

// ---------- hidden text and notes ----------

test('hidden text (style classes, inline style) is never read', () => {
  const text = allText(extractFixture('hidden-and-notes.html', NOTES_URL).chapter);
  for (const marker of ['HIDDEN-1', 'HIDDEN-2', 'HIDDEN-3', 'HIDDEN-4']) assert.ok(!text.includes(marker), marker);
});

test('author/translator notes, promo links and nav text are dropped', () => {
  const text = allText(extractFixture('hidden-and-notes.html', NOTES_URL).chapter);
  for (const marker of ['A/N', 'Author’s note', "Author's note", 'T/N', 'NOTE-BLOCK', 'Discord', 'Ko-fi', 'Previous Chapter', 'FOOTER', 'Latest']) {
    assert.ok(!text.includes(marker), `"${marker}" must not be read`);
  }
});

test('<br><br>-separated text becomes separate paragraphs', () => {
  const { chapter } = extractFixture('hidden-and-notes.html', NOTES_URL);
  const texts = chapter.paragraphs.map((p) => p.text);
  assert.equal(texts.length, 6);
  assert.match(texts[0], /^The tide went out/);
  assert.match(texts[2], /^On the third day/);
  assert.equal(texts.at(-1), 'From the other side, very softly, someone knocked back.');
});

test('rel="next" <link> and rel="prev" <a> are used for chapter links', () => {
  const { chapter } = extractFixture('hidden-and-notes.html', NOTES_URL);
  assert.equal(chapter.nextChapterUrl, 'https://novelplaceholder.example/novel/salt-and-starlight/chapter-8');
  assert.equal(chapter.prevChapterUrl, 'https://novelplaceholder.example/novel/salt-and-starlight/chapter-6');
});

test('hidden nodes are marked in the live DOM', () => {
  const { document } = extractFixture('hidden-and-notes.html', NOTES_URL);
  assert.equal(document.querySelector('.x9q2z').getAttribute('data-chapterly-hidden'), '');
  assert.equal(document.querySelector('.authors-note').getAttribute('data-chapterly-hidden'), 'note');
});

test('re-extracting the same page is idempotent', () => {
  const { ns, document, chapter } = extractFixture('royalroad-chapter.html', RR_URL);
  const again = JSON.parse(JSON.stringify(ns.extract(document)));
  assert.deepEqual(again.paragraphs, chapter.paragraphs);
  assert.equal(document.querySelectorAll('[data-chapterly-p]').length, 11);
});

// ---------- cleaning heuristics ----------

test('note-paragraph and nav heuristics', () => {
  const { ns } = loadPage('<!doctype html><body></body>', 'https://x.example/');
  const noise = (text) => ns.cleaning.isNoiseParagraph({ text, element: null });
  for (const t of ['A/N: thanks', "Author's note: hi", 'Authors note - hi', 'TL Note: pun', 'T/N: pun', '[A/N: late]', 'TL: hi', 'Previous Chapter | Next Chapter', '« Prev | Index | Next »', '***', 'Join our Discord for updates']) {
    assert.ok(noise(t), `noise: ${t}`);
  }
  for (const t of ['An old man walked in.', 'Next, she opened the door.', 'Annie nodded.', 'Notes from the war were burned.', 'The next chapter of her life began.']) {
    assert.ok(!noise(t), `story: ${t}`);
  }
});
