// Shared cleaning for every extractor. Classic script (injected with
// chrome.scripting.executeScript({files})), so it shares state through the
// globalThis.ChapterlyContent namespace instead of ES module imports.
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});

  const HIDDEN_ATTR = 'data-chapterly-hidden'; // live element is not visible
  const ID_ATTR = 'data-chapterly-id'; // temporary: maps clone elements back to live ones
  const P_ATTR = 'data-chapterly-p'; // space-separated paragraph indexes, used for highlighting

  // Never contain readable story text.
  const NON_CONTENT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED']);
  // Skipped inside a content container (UI, forms, page chrome).
  const SKIP_IN_CONTENT = new Set([
    ...NON_CONTENT_TAGS, 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'FORM', 'NAV', 'ASIDE', 'FOOTER', 'HEADER', 'IMG', 'VIDEO', 'AUDIO',
  ]);
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DD', 'DT', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'SECTION',
    'ARTICLE', 'MAIN', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'HR', 'CENTER', 'ADDRESS', 'DETAILS', 'SUMMARY',
  ]);

  // class/id of author's/translator's note blocks.
  const NOTE_BLOCK_RE = /author-?s?-?notes?|authors?[_ ]notes?|translator|(?:^|[\s_-])(?:tl|tn|an)-?notes?(?:$|[\s_-])|(?:^|[\s_-])notes?(?:$|[\s_-])|\ba\/n\b/i;
  // Paragraphs that open an author's/translator's note.
  const NOTE_PARAGRAPH_RE =
    /^[[(]?\s*(?:(?:a|t|e)\/n\b|(?:tl|tn|an)\s*:|tl\s*notes?\b|(?:author|translator|editor)(?:['’]s|s)?\s+notes?\b)/i;
  const PROMO_HOST_RE = /patreon\.com|discord\.(?:gg|com)|ko-?fi\.com/i;
  const PROMO_TEXT_RE = /\b(?:patreon|discord|ko-?fi)\b/i;
  const NAV_SEPARATORS = /[|·•/\\\-–—«»‹›<>←→[\]():]+/g;
  const NAV_WORDS = new Set([
    'previous', 'prev', 'next', 'chapter', 'chapters', 'table', 'of', 'contents', 'toc', 'index', 'home', 'back', 'to', 'main', 'page', 'list', 'novel',
  ]);
  const NAV_KEY_WORDS = new Set(['previous', 'prev', 'next', 'toc', 'index', 'contents']);
  const SPEAKABLE_RE = /[\p{L}\p{N}]/u;

  function normalizeText(text) {
    return String(text ?? '')
      .replace(/[​-‍⁠﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function classAndId(el) {
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute?.('class') ?? '';
    return `${el.id ?? ''} ${cls}`.trim();
  }

  function isNoteBlock(el) {
    const s = classAndId(el);
    return s.length > 0 && NOTE_BLOCK_RE.test(s);
  }

  // ---------- visibility ----------

  function hasLayout(doc) {
    // jsdom (tests) has no layout engine: every rect is 0x0. Skip geometry checks there.
    return doc.documentElement.getBoundingClientRect().height > 0;
  }

  function isHidden(el, win, layout) {
    const s = win.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
    if (s.opacity !== '' && Number.parseFloat(s.opacity) === 0) return true;
    if (s.fontSize && Number.parseFloat(s.fontSize) === 0) return true;
    if (/^rect\(/.test(s.clip ?? '')) {
      const nums = (s.clip.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      if (nums.length === 4 && nums.every((n) => n <= 1)) return true; // "sr-only" style clipping
    }
    if (layout && s.display !== 'contents') {
      const r = el.getBoundingClientRect();
      if ((r.width === 0 || r.height === 0) && s.overflow !== 'visible') return true;
      const sx = win.scrollX ?? 0;
      const sy = win.scrollY ?? 0;
      if (r.right + sx <= 0 || r.bottom + sy <= 0) return true; // pushed off-page (left:-9999px)
    }
    return false;
  }

  // A "note" class on a huge block is more likely a site wrapper than a note.
  const MAX_NOTE_BLOCK_CHARS = 3000;

  /**
   * Marks elements to exclude with data-chapterly-hidden: "" for elements that are not
   * visible in the live page, "note" for author's/translator's note blocks. Must run on
   * the live DOM (computed styles) before cloning: Readability rewrites the clone and
   * drops classes (a note <div> wrapping one <p> becomes just the <p>).
   */
  function markHidden(doc) {
    const win = doc.defaultView;
    const root = doc.body;
    if (!root || !win) return 0;
    const layout = hasLayout(doc);
    let count = 0;
    const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */, {
      acceptNode(el) {
        if (NON_CONTENT_TAGS.has(el.tagName.toUpperCase())) return 2; // REJECT subtree
        const text = el.textContent ?? '';
        if (!SPEAKABLE_RE.test(text)) return 2;
        if (isHidden(el, win, layout)) {
          el.setAttribute(HIDDEN_ATTR, '');
          count++;
          return 2;
        }
        if (text.length <= MAX_NOTE_BLOCK_CHARS && isNoteBlock(el)) {
          el.setAttribute(HIDDEN_ATTR, 'note');
          count++;
          return 2;
        }
        return 1; // ACCEPT
      },
    });
    while (walker.nextNode());
    return count;
  }

  /** Gives block elements a temporary id so clone elements can be mapped back. */
  function assignIds(doc) {
    const live = [];
    for (const el of doc.body?.querySelectorAll('*') ?? []) {
      if (!BLOCK_TAGS.has(el.tagName.toUpperCase())) continue;
      el.setAttribute(ID_ATTR, String(live.length));
      live.push(el);
    }
    return live;
  }

  /** Maps an element from a clone to the live element with the same (or nearest ancestor) id. */
  function toLive(el, liveById) {
    for (let e = el; e && e.getAttribute; e = e.parentElement) {
      const id = e.getAttribute(ID_ATTR);
      if (id != null && liveById[Number(id)]) return liveById[Number(id)];
    }
    return null;
  }

  /** Removes every attribute and class Chapterly added to the page. */
  function reset(doc) {
    for (const attr of [HIDDEN_ATTR, ID_ATTR, P_ATTR]) {
      for (const el of doc.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    }
    for (const el of doc.querySelectorAll('.chapterly-reading')) el.classList.remove('chapterly-reading');
  }

  function clearIds(doc) {
    for (const el of doc.querySelectorAll(`[${ID_ATTR}]`)) el.removeAttribute(ID_ATTR);
  }

  // ---------- paragraphs ----------

  /**
   * Walks a content container and returns [{text, element}] where element is the
   * nearest block ancestor of the text. Hidden elements and note blocks are skipped,
   * <br> starts a new paragraph, and noise (notes, promo, nav) is filtered out.
   */
  function collectParagraphs(container) {
    const out = [];
    if (!container) return out;
    let buffer = [];
    let owner = container;

    const flush = () => {
      const text = normalizeText(buffer.join(''));
      buffer = [];
      if (text) out.push({ text, element: owner });
    };

    const walk = (node, blockOwner) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (buffer.length === 0) owner = blockOwner;
          buffer.push(child.data);
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
          flush();
          walk(child, child);
          flush();
        } else {
          walk(child, blockOwner);
        }
      }
    };

    walk(container, container);
    flush();
    return out.filter((p) => !isNoiseParagraph(p));
  }

  function isNavText(text) {
    const tokens = text.toLowerCase().replace(NAV_SEPARATORS, ' ').split(/\s+/).filter(Boolean);
    return (
      tokens.length >= 2 &&
      tokens.length <= 12 &&
      tokens.every((t) => NAV_WORDS.has(t)) &&
      tokens.some((t) => NAV_KEY_WORDS.has(t))
    );
  }

  function isPromo({ text, element }) {
    if (text.length > 240) return false;
    if (PROMO_HOST_RE.test(text)) return true;
    const links = element?.querySelectorAll ? [...element.querySelectorAll('a[href]')] : [];
    const promoLinks = links.filter((a) => PROMO_HOST_RE.test(a.getAttribute('href') ?? ''));
    if (promoLinks.length === 0) return PROMO_TEXT_RE.test(text) && /\b(?:support|join|check out|become|donate)\b/i.test(text);
    const linkText = normalizeText(links.map((a) => a.textContent).join(' '));
    // Only links (or a short call to action around promo links).
    return linkText.length >= text.length * 0.6 || text.length < 120;
  }

  function isNoiseParagraph(p) {
    const { text } = p;
    if (!SPEAKABLE_RE.test(text)) return true;
    if (NOTE_PARAGRAPH_RE.test(text)) return true;
    if (isNavText(text)) return true;
    return isPromo(p);
  }

  function absoluteUrl(href, base) {
    if (!href) return null;
    try {
      const url = new URL(href, base);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function stripHash(url) {
    return String(url).split('#')[0];
  }

  ns.cleaning = {
    HIDDEN_ATTR,
    ID_ATTR,
    P_ATTR,
    BLOCK_TAGS,
    SKIP_IN_CONTENT,
    normalizeText,
    isNoteBlock,
    isHidden,
    markHidden,
    assignIds,
    toLive,
    reset,
    clearIds,
    collectParagraphs,
    isNoiseParagraph,
    isNavText,
    absoluteUrl,
    stripHash,
  };
})();
