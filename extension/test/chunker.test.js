import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_MAX_CHARS,
  DEFAULT_CHUNK_OPTIONS,
  chunkIndexForParagraph,
  chunkIndexForPosition,
  chunkParagraphs,
  nextParagraphChunk,
  paragraphStartChunk,
  splitIntoChunks,
  splitLongText,
  textToParagraphs,
} from '../src/shared/chunker.js';

const paras = (...texts) => texts.map((text, index) => ({ index, text }));
const sentence = (n) => `This is sentence number ${String(n).padStart(3, '0')} of the test.`; // 41 chars
const sentences = (from, count) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

test('defaults: 600 chars per chunk, 400 for the first, far below the backend limit', () => {
  assert.equal(BACKEND_MAX_CHARS, 3000, 'must match TtsController.MAX_CHARS');
  assert.equal(DEFAULT_CHUNK_OPTIONS.maxChars, 600);
  assert.equal(DEFAULT_CHUNK_OPTIONS.firstChunkMaxChars, 400);
  assert.throws(() => chunkParagraphs(paras('x'), { maxChars: 3001 }), RangeError);
});

test('short dialogue lines each become their own chunk', () => {
  const chunks = chunkParagraphs(paras('“You’re late.”', '“I’m on time.”', '“Then time is late.”', 'She shrugged.'));
  assert.deepEqual(
    chunks.map((c) => c.text),
    ['“You’re late.”', '“I’m on time.”', '“Then time is late.”', 'She shrugged.'],
  );
  assert.deepEqual(
    chunks.map((c) => c.paragraphIndexes),
    [[0], [1], [2], [3]],
  );
  for (const c of chunks) {
    assert.equal(c.part, 0);
    assert.equal(c.parts, 1);
    assert.equal(c.startOffset, 0);
    assert.equal(c.endOffset, c.text.length);
  }
});

test('paragraphs are never merged, chunks carry their paragraph index', () => {
  const chunks = chunkParagraphs(paras('Chapter 1', 'The Beginning', sentences(0, 5)));
  assert.deepEqual(
    chunks.map((c) => [c.index, c.paragraphIndex]),
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
  );
});

test('long paragraphs split on sentence boundaries with parts and offsets', () => {
  const long = sentences(0, 40); // 40*41+39 = 1679 chars
  const chunks = chunkParagraphs(paras('Short opener.', long));
  const pieces = chunks.filter((c) => c.paragraphIndex === 1);
  assert.equal(pieces.length, 3);
  pieces.forEach((c, k) => {
    assert.equal(c.part, k);
    assert.equal(c.parts, 3);
    assert.ok(c.text.length <= 600);
    assert.match(c.text, /test\.$/, 'ends on a sentence boundary');
    assert.equal(long.slice(c.startOffset, c.endOffset), c.text, 'offsets point into the paragraph');
  });
  assert.equal(pieces[0].startOffset, 0);
  assert.equal(pieces.at(-1).endOffset, long.length);
  assert.equal(pieces[1].startOffset, pieces[0].endOffset + 1, 'separated by one space');
});

test('offsets refer to the normalised paragraph text', () => {
  const [c] = chunkParagraphs([{ index: 0, text: '  Two   spaces\n here.  ' }]);
  assert.equal(c.text, 'Two spaces here.');
  assert.deepEqual([c.startOffset, c.endOffset], [0, 16]);
});

test('the first chunk is short for a fast start; the rest of that paragraph uses maxChars', () => {
  const p0 = sentences(0, 30); // ~1260 chars
  const chunks = chunkParagraphs(paras(p0, sentences(30, 3)));
  assert.ok(chunks[0].text.length <= 400, `first chunk ${chunks[0].text.length}`);
  assert.match(chunks[0].text, /test\.$/);
  const parts = chunks.filter((c) => c.paragraphIndex === 0);
  assert.ok(parts.slice(1).every((c) => c.text.length <= 600));
  assert.ok(parts.slice(1).some((c) => c.text.length > 400), 'later parts use the normal limit');
  assert.ok(parts.every((c) => c.parts === parts.length));
  assert.equal(parts.map((c) => c.text).join(' '), p0);
  assert.ok(parts.every((c) => p0.slice(c.startOffset, c.endOffset) === c.text));
});

test('a sentence above the limit splits between words; one giant word is cut', () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
  for (const c of chunkParagraphs(paras(words))) {
    assert.ok(c.text.length <= 600);
    assert.match(c.text, /^word\d+( word\d+)*$/, 'no word is broken');
    assert.equal(words.slice(c.startOffset, c.endOffset), c.text);
  }
  assert.ok(chunkParagraphs(paras('x'.repeat(2500))).every((c) => c.text.length <= 600));
});

test('sentence splitting handles closing quotes and other terminators', () => {
  assert.deepEqual(splitLongText('"Run!" she said. Why? Because… it was late.', 20), ['"Run!" she said.', 'Why? Because…', 'it was late.']);
});

test('unspeakable paragraphs are skipped but indexes are kept', () => {
  const chunks = chunkParagraphs([
    { index: 5, text: 'Five.' },
    { index: 6, text: '***' },
    { index: 9, text: 'Nine.' },
  ]);
  assert.deepEqual(
    chunks.map((c) => [c.index, c.paragraphIndex]),
    [
      [0, 5],
      [1, 9],
    ],
  );
});

test('no chunk ever exceeds the backend limit', () => {
  const input = paras(...Array.from({ length: 60 }, (_, i) => sentences(i, (i * 7) % 90)));
  for (const c of chunkParagraphs(input)) assert.ok(c.text.length <= BACKEND_MAX_CHARS);
});

test('selection uses the same rules', () => {
  assert.deepEqual(textToParagraphs('First.\n\n  Second  line.\r\n***\n'), [
    { index: 0, text: 'First.' },
    { index: 1, text: 'Second line.' },
  ]);
  const chunks = splitIntoChunks('Line one.\nLine two.\nLine three.');
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[1], {
    index: 1,
    text: 'Line two.',
    paragraphIndexes: [1],
    paragraphIndex: 1,
    part: 0,
    parts: 1,
    startOffset: 0,
    endOffset: 9,
  });
  assert.deepEqual(splitIntoChunks('  \n\n '), []);
  assert.deepEqual(splitIntoChunks(undefined), []);
});

// ---------- lookups ----------

const doc = chunkParagraphs(paras('Intro line.', sentences(0, 40), 'Short.', sentences(50, 3)));
// chunks: 0 = p0, 1..3 = p1 parts, 4 = p2, 5 = p3

test('chunkIndexForPosition picks the part that contains the offset', () => {
  const [a, b, c] = [1, 2, 3].map((i) => doc[i]);
  assert.equal(chunkIndexForPosition(doc, 1, 0), 1);
  assert.equal(chunkIndexForPosition(doc, 1, a.endOffset - 1), 1);
  assert.equal(chunkIndexForPosition(doc, 1, a.endOffset), 2, 'the space between parts goes to the next part');
  assert.equal(chunkIndexForPosition(doc, 1, b.startOffset + 5), 2);
  assert.equal(chunkIndexForPosition(doc, 1, c.endOffset + 100), 3, 'past the end: last part');
  assert.equal(chunkIndexForPosition(doc, 1, null), 1, 'no offset: first part');
  assert.equal(chunkIndexForPosition(doc, 2, 3), 4);
});

test('chunkIndexForParagraph and missing paragraphs', () => {
  assert.equal(chunkIndexForParagraph(doc, 2), 4);
  assert.equal(chunkIndexForParagraph(doc, 99), -1);
  const gappy = chunkParagraphs([
    { index: 0, text: 'A.' },
    { index: 4, text: 'B.' },
  ]);
  assert.equal(chunkIndexForParagraph(gappy, 2), 1, 'next paragraph that has chunks');
  assert.equal(chunkIndexForPosition(gappy, 2, 10), 1);
});

test('next/previous paragraph lookups', () => {
  assert.equal(nextParagraphChunk(doc, 0), 1);
  assert.equal(nextParagraphChunk(doc, 2), 4, 'skips the remaining parts');
  assert.equal(nextParagraphChunk(doc, 5), -1);
  assert.equal(paragraphStartChunk(doc, 3), 1);
  assert.equal(paragraphStartChunk(doc, 4), 4);
});
