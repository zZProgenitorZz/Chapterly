// Turns paragraphs into TTS chunks. Pure functions, no chrome.* APIs.

/** Hard limit of the backend (TtsController.MAX_CHARS). */
export const BACKEND_MAX_CHARS = 3000;

export const DEFAULT_CHUNK_OPTIONS = Object.freeze({
  minChars: 200, // merge short consecutive paragraphs (dialogue) until a chunk has this many chars
  maxChars: 1200, // split longer paragraphs on sentence boundaries
  firstChunkMaxChars: 400, // small first chunk = fast start
});

// A sentence ends with . ! ? or … optionally followed by closing quotes/brackets, then space.
const SENTENCE_END = /(?<=[.!?…]+["'”’»)\]]*)\s+/u;
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * @param {{index: number, text: string}[]} paragraphs
 * @returns {{index: number, text: string, paragraphIndexes: number[]}[]}
 */
export function chunkParagraphs(paragraphs, options = {}) {
  const { minChars, maxChars, firstChunkMaxChars } = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (maxChars > BACKEND_MAX_CHARS) throw new RangeError(`maxChars must be <= ${BACKEND_MAX_CHARS}`);
  const firstMax = Math.min(firstChunkMaxChars, maxChars);

  // Units: paragraphs (or sentence-packed pieces of long ones), each <= maxChars.
  const units = [];
  for (const [i, p] of (paragraphs ?? []).entries()) {
    const text = String(p?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!SPEAKABLE.test(text)) continue;
    const paragraphIndex = p.index ?? i;
    for (const piece of text.length > maxChars ? splitLongText(text, maxChars) : [text]) {
      units.push({ text: piece, paragraphIndex });
    }
  }

  const chunks = [];
  let current = null;
  const close = () => {
    if (!current) return;
    chunks.push({ index: chunks.length, text: current.text, paragraphIndexes: current.paragraphIndexes });
    current = null;
  };

  while (units.length > 0) {
    const unit = units.shift();
    const limit = chunks.length === 0 ? firstMax : maxChars;

    if (!current) {
      if (unit.text.length > limit) {
        // Only possible for the first chunk: take a short head, requeue the rest.
        const [head, ...rest] = splitLongText(unit.text, limit);
        current = { text: head, paragraphIndexes: [unit.paragraphIndex] };
        close();
        if (rest.length) units.unshift({ text: rest.join(' '), paragraphIndex: unit.paragraphIndex });
        continue;
      }
      current = { text: unit.text, paragraphIndexes: [unit.paragraphIndex] };
      continue;
    }

    const merged = `${current.text}\n${unit.text}`;
    if (current.text.length < minChars && merged.length <= limit) {
      current.text = merged;
      if (current.paragraphIndexes.at(-1) !== unit.paragraphIndex) current.paragraphIndexes.push(unit.paragraphIndex);
    } else {
      close();
      units.unshift(unit);
    }
  }
  close();
  return chunks;
}

/** Splits free text (a selection) into paragraphs on line breaks. */
export function textToParagraphs(text) {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => SPEAKABLE.test(p))
    .map((p, index) => ({ index, text: p }));
}

/** Selection (step 2 API): text -> chunks. */
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
