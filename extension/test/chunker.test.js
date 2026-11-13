import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_MAX_CHARS,
  DEFAULT_CHUNK_OPTIONS,
  chunkParagraphs,
  splitIntoChunks,
  splitLongText,
  textToParagraphs,
} from '../src/shared/chunker.js';

const paras = (...texts) => texts.map((text, index) => ({ index, text }));
const sentence = (n) => `This is sentence number ${String(n).padStart(3, '0')} of the test.`; // 41 chars
// sentences(_, 9) = 377 chars (fits the 400-char first chunk), sentences(_, 6) = 251 chars
const sentences = (from, count) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

test('default maxChars stays well below the backend limit', () => {
  assert.equal(BACKEND_MAX_CHARS, 3000, 'must match TtsController.MAX_CHARS');
  assert.ok(DEFAULT_CHUNK_OPTIONS.maxChars <= BACKEND_MAX_CHARS / 2);
  assert.ok(DEFAULT_CHUNK_OPTIONS.firstChunkMaxChars < DEFAULT_CHUNK_OPTIONS.maxChars);
  assert.throws(() => chunkParagraphs(paras('x'), { maxChars: 3001 }), RangeError);
});

test('merges short consecutive paragraphs (dialogue) up to minChars', () => {
  const dialogue = paras(
    sentences(0, 9), // 377 chars: the whole first chunk
    '“You’re late.”',
    '“I’m on time.”',
    '“Then time is late.”',
    'She shrugged.',
    sentences(20, 8),
  );
  const chunks = chunkParagraphs(dialogue);
  assert.deepEqual(chunks[1].paragraphIndexes, [1, 2, 3, 4, 5]);
  assert.equal(chunks[1].text.split('\n')[0], '“You’re late.”');
  assert.equal(chunks.length, 2);
});

test('stops merging once a chunk reaches minChars', () => {
  const chunks = chunkParagraphs(paras(sentences(0, 9), 'Hi.', sentences(10, 6), sentences(20, 6)), { minChars: 200 });
  // "Hi." (< minChars) absorbs the next paragraph; that chunk then has >= 200 chars,
  // so the last paragraph starts a new chunk.
  assert.deepEqual(
    chunks.map((c) => c.paragraphIndexes),
    [[0], [1, 2], [3]],
  );
});

test('keeps the first chunk small', () => {
  const chunks = chunkParagraphs(paras(sentences(0, 30), sentences(30, 30)));
  assert.ok(chunks[0].text.length <= DEFAULT_CHUNK_OPTIONS.firstChunkMaxChars, `first chunk ${chunks[0].text.length}`);
  assert.ok(chunks[0].text.endsWith('test.'), 'first chunk ends on a sentence boundary');
  assert.deepEqual(chunks[0].paragraphIndexes, [0]);
  assert.deepEqual(chunks[1].paragraphIndexes, [0], 'the rest of paragraph 0 follows');
  for (const c of chunks.slice(1)) assert.ok(c.text.length <= DEFAULT_CHUNK_OPTIONS.maxChars);
});

test('short paragraphs merge into the first chunk only up to firstChunkMaxChars', () => {
  const chunks = chunkParagraphs(paras('Chapter 1', 'The Beginning', sentences(0, 20)));
  assert.deepEqual(chunks[0].paragraphIndexes, [0, 1]);
  assert.equal(chunks[0].text, 'Chapter 1\nThe Beginning');
});

test('splits paragraphs above maxChars on sentence boundaries, never mid-word', () => {
  const long = sentences(0, 80); // ~3100 chars
  const chunks = chunkParagraphs(paras(sentences(100, 5), long));
  const pieces = chunks.filter((c) => c.paragraphIndexes.includes(1));
  assert.ok(pieces.length >= 3);
  for (const c of pieces) {
    assert.ok(c.text.length <= DEFAULT_CHUNK_OPTIONS.maxChars, `${c.text.length}`);
    assert.match(c.text, /test\.$/);
  }
  assert.equal(
    pieces
      .map((c) => c.text)
      .join(' ')
      .replace(/^.*?\n/, ''),
    long,
  );
});

test('sentence splitting handles closing quotes and other terminators', () => {
  assert.deepEqual(splitLongText('"Run!" she said. Why? Because… it was late.', 20), ['"Run!" she said.', 'Why? Because…', 'it was late.']);
});

test('a sentence above the limit splits between words; one giant word is cut', () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  for (const c of chunkParagraphs(paras(words))) {
    assert.ok(c.text.length <= DEFAULT_CHUNK_OPTIONS.maxChars);
    assert.match(c.text, /^word\d+( word\d+)*$/, 'no word is broken');
  }
  const giant = chunkParagraphs(paras('x'.repeat(2500)));
  assert.ok(giant.every((c) => c.text.length <= DEFAULT_CHUNK_OPTIONS.maxChars));
});

test('no chunk ever exceeds the backend limit', () => {
  const input = paras(...Array.from({ length: 60 }, (_, i) => sentences(i, (i * 7) % 90)));
  for (const c of chunkParagraphs(input)) assert.ok(c.text.length <= BACKEND_MAX_CHARS);
});

test('chunks have sequential indexes and cover every speakable paragraph in order', () => {
  const input = paras('One.', '***', 'Two.', sentences(0, 40), 'Three.');
  const chunks = chunkParagraphs(input);
  assert.deepEqual(
    chunks.map((c) => c.index),
    chunks.map((_, i) => i),
  );
  const covered = [...new Set(chunks.flatMap((c) => c.paragraphIndexes))];
  assert.deepEqual(covered, [0, 2, 3, 4], '"***" is skipped');
});

test('keeps original paragraph indexes', () => {
  const chunks = chunkParagraphs([
    { index: 5, text: 'Five.' },
    { index: 9, text: 'Nine.' },
  ]);
  assert.deepEqual(chunks[0].paragraphIndexes, [5, 9]);
});

test('selection: text -> paragraphs -> chunks', () => {
  assert.deepEqual(textToParagraphs('First.\n\n  Second  line.\r\n***\n'), [
    { index: 0, text: 'First.' },
    { index: 1, text: 'Second line.' },
  ]);
  assert.deepEqual(splitIntoChunks('Hello, this is Brian.'), [
    { index: 0, text: 'Hello, this is Brian.', paragraphIndexes: [0] },
  ]);
  assert.deepEqual(splitIntoChunks('  \n\n '), []);
  assert.deepEqual(splitIntoChunks(undefined), []);
});
