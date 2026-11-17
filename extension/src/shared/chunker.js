// Turns paragraphs into TTS chunks. Pure functions, no chrome.* APIs.
//
// Rules (paragraph-aligned, so "next" lands on the next paragraph):
// - every chunk belongs to exactly one paragraph; paragraphs are never merged;
// - a paragraph longer than maxChars is split on sentence boundaries into parts;
// - the very first chunk is at most firstChunkMaxChars, so audio starts fast.
//
// Chunk: {index, text, paragraphIndexes: [p], paragraphIndex: p, part, parts,
//         startOffset, endOffset}
// where the offsets are character offsets of the piece inside the normalised
// paragraph text (whitespace collapsed to single spaces, trimmed).

/** Hard limit of the backend (TtsController.MAX_CHARS). */
export const BACKEND_MAX_CHARS = 3000;

export const DEFAULT_CHUNK_OPTIONS = Object.freeze({
  maxChars: 600, // split longer paragraphs on sentence boundaries
  firstChunkMaxChars: 400, // small first chunk = fast start
});

// A sentence ends with . ! ? or … optionally followed by closing quotes/brackets, then space.
const SENTENCE_END = /(?<=[.!?…]+["'”’»)\]]*)\s+/u;
const SPEAKABLE = /[\p{L}\p{N}]/u;

/** The normalisation the offsets refer to (the extractor already produces this form). */
export function normalizeParagraphText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {{index: number, text: string}[]} paragraphs
 * @returns {{index, text, paragraphIndexes, paragraphIndex, part, parts, startOffset, endOffset}[]}
 */
export function chunkParagraphs(paragraphs, options = {}) {
  const { maxChars, firstChunkMaxChars } = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (maxChars > BACKEND_MAX_CHARS) throw new RangeError(`maxChars must be <= ${BACKEND_MAX_CHARS}`);
  const firstMax = Math.min(firstChunkMaxChars, maxChars);

  const chunks = [];
  for (const [i, p] of (paragraphs ?? []).entries()) {
    const text = normalizeParagraphText(p?.text);
    if (!SPEAKABLE.test(text)) continue;
    const paragraphIndex = p.index ?? i;

    let pieces;
    if (chunks.length === 0 && text.length > firstMax) {
      // Fast start: a short head, then the rest with the normal limit.
      const head = splitLongText(text, firstMax)[0];
      const rest = text.slice(text.indexOf(head) + head.length).trim();
      pieces = [head, ...(rest ? splitLongText(rest, maxChars) : [])];
    } else {
      pieces = text.length > maxChars ? splitLongText(text, maxChars) : [text];
    }

    let cursor = 0;
    for (const [part, piece] of pieces.entries()) {
      // Pieces are exact substrings of the normalised text, in order.
      const startOffset = text.indexOf(piece, cursor);
      const endOffset = startOffset + piece.length;
      cursor = endOffset;
      chunks.push({
        index: chunks.length,
        text: piece,
        paragraphIndexes: [paragraphIndex],
        paragraphIndex,
        part,
        parts: pieces.length,
        startOffset,
        endOffset,
      });
    }
  }
  return chunks;
}

/** Splits free text (a selection) into paragraphs on line breaks. */
export function textToParagraphs(text) {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map(normalizeParagraphText)
    .filter((p) => SPEAKABLE.test(p))
    .map((p, index) => ({ index, text: p }));
}

/** Selection: text -> paragraphs -> chunks (same rules as chapters). */
export function splitIntoChunks(text, options) {
  return chunkParagraphs(textToParagraphs(text), options);
}

/**
 * Packs whole sentences into pieces of at most maxChars. A sentence longer than
 * maxChars is split between words; only a single word longer than maxChars is cut.
 */
export function splitLongText(text, maxChars) {
  const out = [];
  let current = '';
  for (const sentence of text.split(SENTENCE_END).filter(Boolean)) {
    if (sentence.length > maxChars) {
      if (current) out.push(current);
      current = '';
      out.push(...splitOnSpaces(sentence, maxChars));
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      out.push(current);
      current = sentence;
    }
  }
  if (current) out.push(current);
  return out;
}

function splitOnSpaces(text, maxChars) {
  const out = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars; // a single "word" longer than maxChars
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---------- lookups (used for click-to-jump, remembered positions, paragraph skips) ----------

const paragraphOf = (chunk) => chunk.paragraphIndex ?? chunk.paragraphIndexes?.[0] ?? chunk.index;

/** First chunk of the paragraph, or of the next paragraph that has chunks; -1 if none. */
export function chunkIndexForParagraph(chunks, paragraphIndex) {
  return chunks.findIndex((c) => paragraphOf(c) >= paragraphIndex);
}

/**
 * The chunk that contains character `offset` of paragraph `paragraphIndex`.
 * An offset between two parts (the space between sentences) picks the next part;
 * offset null/undefined picks the paragraph's first chunk.
 */
export function chunkIndexForPosition(chunks, paragraphIndex, offset) {
  const first = chunkIndexForParagraph(chunks, paragraphIndex);
  if (first < 0) return chunks.length ? chunks.length - 1 : -1;
  if (paragraphOf(chunks[first]) !== paragraphIndex || offset == null || !Number.isFinite(offset)) return first;
  // Parts are in order: the first part that ends after the offset contains it
  // (or follows the gap the offset is in).
  let i = first;
  for (; i < chunks.length && paragraphOf(chunks[i]) === paragraphIndex; i++) {
    if (offset < (chunks[i].endOffset ?? Infinity)) return i;
  }
  return i - 1; // past the end: the paragraph's last part
}

/** Index of the first chunk of the next paragraph after chunk `index`, or -1. */
export function nextParagraphChunk(chunks, index) {
  const p = paragraphOf(chunks[index]);
  return chunks.findIndex((c, i) => i > index && paragraphOf(c) !== p);
}

/** Index of the first chunk of the paragraph containing chunk `index`. */
export function paragraphStartChunk(chunks, index) {
  const p = paragraphOf(chunks[index]);
  let i = index;
  while (i > 0 && paragraphOf(chunks[i - 1]) === p) i--;
  return i;
}
