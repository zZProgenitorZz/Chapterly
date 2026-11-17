// Maps between the DOM and the normalised paragraph texts the extractor produced
// (cleaning.collectParagraphs). Classic script (see cleaning.js).
//
// An element tagged data-chapterly-p="3 4" owns paragraphs 3 and 4 (e.g. text split
// by <br>). segmentsOf(element) walks it with the same rules as collectParagraphs:
// <br> and nested blocks end a segment, hidden/note/UI elements are skipped. Each
// segment is matched to one of the element's paragraphs by comparing its normalised
// text with ns.paragraphTexts, so offsets are exact whenever the text matches.
//
// Approximation: when a segment can't be matched (the generic extractor sometimes
// maps a paragraph to a wrapper element whose live text differs from Readability's
// clone), positions fall back to the element's first paragraph without an offset,
// i.e. the start of that paragraph.
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});
  const { BLOCK_TAGS, SKIP_IN_CONTENT, HIDDEN_ATTR, P_ATTR, isNoteBlock, normalizeText } = ns.cleaning;

  const ZERO_WIDTH = /[​-‍⁠﻿]/;
  const WS = /\s/;

  /** [{raw, parts: [{node, start}]}] for the text the element itself owns. */
  function segmentsOf(element) {
    const segments = [];
    let current = { raw: '', parts: [] };
    const flush = () => {
      if (current.parts.length) segments.push(current);
      current = { raw: '', parts: [] };
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          current.parts.push({ node: child, start: current.raw.length });
          current.raw += child.data;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (tag === 'BR') {
          flush();
          continue;
        }
        if (SKIP_IN_CONTENT.has(tag) || child.hasAttribute(HIDDEN_ATTR) || isNoteBlock(child)) continue;
        if (BLOCK_TAGS.has(tag)) {
          flush(); // a nested block owns its own paragraphs
          continue;
        }
        walk(child);
      }
    };
    walk(element);
    flush();
    return segments;
  }

  function paragraphIndexesOf(element) {
    return (element.getAttribute(P_ATTR) ?? '').split(' ').filter(Boolean).map(Number);
  }

  /** Pairs each segment with its paragraph index (or null if its text matches none). */
  function matchedSegments(element, texts = ns.paragraphTexts ?? []) {
    const indexes = paragraphIndexesOf(element);
    const used = new Set();
    return segmentsOf(element).map((segment) => {
      const text = normalizeText(segment.raw);
      const paragraphIndex = indexes.find((i) => !used.has(i) && texts[i] === text) ?? null;
      if (paragraphIndex != null) used.add(paragraphIndex);
      return { ...segment, text, paragraphIndex };
    });
  }

  /** Length of the normalised form of raw.slice(0, rawOffset) (offset in normalised text). */
  function normalizedOffset(raw, rawOffset) {
    let n = 0;
    let pendingSpace = false;
    for (let i = 0; i < rawOffset && i < raw.length; i++) {
      const ch = raw[i];
      if (ZERO_WIDTH.test(ch)) continue;
      if (WS.test(ch)) {
        if (n > 0) pendingSpace = true; // leading whitespace is trimmed
        continue;
      }
      if (pendingSpace) n++;
      pendingSpace = false;
      n++;
    }
    // Whitespace at the end of the prefix becomes one space if more text follows.
    if (pendingSpace && /[^\s​-‍⁠﻿]/.test(raw.slice(rawOffset))) n++;
    return n;
  }

  /**
   * Raw offset for normalised offset `target` (inverse of normalizedOffset). When the
   * target is a collapsed whitespace run, a range start skips it (next character) and a
   * range end (`atEnd`) stops before it.
   */
  function rawOffsetFor(raw, target, atEnd = false) {
    let n = 0;
    let pendingSpace = false;
    let wsStart = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ZERO_WIDTH.test(ch)) continue;
      if (WS.test(ch)) {
        if (n > 0 && !pendingSpace) {
          pendingSpace = true;
          wsStart = i;
        }
        continue;
      }
      if (pendingSpace) {
        if (n === target) return atEnd ? wsStart : i;
        n++;
      }
      pendingSpace = false;
      if (n >= target) return i;
      n++;
    }
    return raw.length;
  }

  /**
   * Click/caret position -> {paragraphIndex, offset}. offset is the character offset in
   * the normalised paragraph text, or null when it can't be mapped exactly.
   */
  function positionFor(element, node, nodeOffset, texts) {
    const indexes = paragraphIndexesOf(element);
    if (!indexes.length) return null;
    const fallback = { paragraphIndex: indexes[0], offset: null };
    if (!node) return fallback;
    for (const segment of matchedSegments(element, texts)) {
      const part = segment.parts.find((p) => p.node === node);
      if (!part) continue;
      if (segment.paragraphIndex == null) return fallback;
      const raw = part.start + Math.min(nodeOffset, node.data.length);
      return { paragraphIndex: segment.paragraphIndex, offset: normalizedOffset(segment.raw, raw) };
    }
    return fallback;
  }

  /** DOM Range for [start, end) of a paragraph's normalised text, or null. */
  function rangeFor(element, paragraphIndex, start, end, texts) {
    const segment = matchedSegments(element, texts).find((s) => s.paragraphIndex === paragraphIndex);
    if (!segment) return null;
    const toPoint = (rawOffset) => {
      for (let k = segment.parts.length - 1; k >= 0; k--) {
        const part = segment.parts[k];
        if (part.start <= rawOffset) return [part.node, Math.min(rawOffset - part.start, part.node.data.length)];
      }
      return [segment.parts[0].node, 0];
    };
    const range = element.ownerDocument.createRange();
    range.setStart(...toPoint(rawOffsetFor(segment.raw, start)));
    range.setEnd(...toPoint(rawOffsetFor(segment.raw, end, true)));
    return range;
  }

  ns.textMap = { segmentsOf, matchedSegments, normalizedOffset, rawOffsetFor, positionFor, rangeFor, paragraphIndexesOf };
})();
