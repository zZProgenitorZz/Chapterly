// Page side of a reading session: highlights the paragraph being read and remembers
// which paragraph was right-clicked (for "Read from here"). Classic script (see
// cleaning.js); installs its listeners once per page even if injected repeatedly.
// Message strings mirror src/shared/messages.js (content scripts can't import it).
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});
  if (ns.highlightInstalled) return;
  ns.highlightInstalled = true;

  const CLASS = 'chapterly-reading';
  const STYLE_ID = 'chapterly-style';
  const P_ATTR = 'data-chapterly-p';
  const SENTENCE_HIGHLIGHT = 'chapterly-sentence';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.${CLASS} {
      background-color: rgba(255, 210, 80, 0.28) !important;
      box-shadow: 0 0 0 4px rgba(255, 210, 80, 0.28) !important;
      border-radius: 3px;
      transition: background-color 0.25s ease;
    }
    ::highlight(${SENTENCE_HIGHLIGHT}) {
      background-color: rgba(255, 170, 0, 0.35);
    }
    .chapterly-click [${P_ATTR}] {
      cursor: pointer;
    }
    .chapterly-click [${P_ATTR}]:hover {
      text-decoration: underline dotted rgba(127, 127, 127, 0.55);
      text-underline-offset: 3px;
    }`;
    (document.head ?? document.documentElement).appendChild(style);
  }

  // Long paragraphs are read in parts: mark the part being read (CSS Custom Highlight
  // API, no DOM changes). Skipped where the API is missing or the text can't be mapped.
  function highlightPart(chunk, els) {
    if (!globalThis.CSS?.highlights || typeof Highlight !== 'function') return;
    CSS.highlights.delete(SENTENCE_HIGHLIGHT);
    if (!chunk || !(chunk.parts > 1) || chunk.startOffset == null || !ns.textMap) return;
    const el = els.find((e) => (e.getAttribute(P_ATTR) ?? '').split(' ').includes(String(chunk.paragraphIndex)));
    if (!el) return;
    try {
      const range = ns.textMap.rangeFor(el, chunk.paragraphIndex, chunk.startOffset, chunk.endOffset);
      if (range) CSS.highlights.set(SENTENCE_HIGHLIGHT, new Highlight(range));
    } catch {
      // cosmetic only
    }
  }

  function elementsFor(indexes) {
    const found = new Set();
    for (const i of indexes) {
      const ref = ns.paragraphElements?.[i]?.deref?.();
      const el = ref?.isConnected ? ref : document.querySelector(`[${P_ATTR}~="${i}"]`);
      if (el) found.add(el);
    }
    return [...found];
  }

  function clear() {
    for (const el of document.querySelectorAll(`.${CLASS}`)) el.classList.remove(CLASS);
    globalThis.CSS?.highlights?.delete(SENTENCE_HIGHLIGHT);
  }

  /** @param chunk optional {paragraphIndex, parts, startOffset, endOffset} of the chunk being read */
  function highlight(indexes, chunk) {
    ensureStyle();
    clear();
    const els = elementsFor(indexes ?? []);
    for (const el of els) el.classList.add(CLASS);
    highlightPart(chunk, els);
    const first = els[0];
    if (!first) return 0;
    const rect = first.getBoundingClientRect();
    const offScreen = rect.bottom < 0 || rect.top > window.innerHeight * 0.85;
    if (offScreen) first.scrollIntoView({ block: rect.height > window.innerHeight * 0.7 ? 'start' : 'center', behavior: 'smooth' });
    return els.length;
  }

  document.addEventListener(
    'contextmenu',
    (event) => {
      const el = event.target?.closest?.(`[${P_ATTR}]`);
      ns.contextParagraph = el ? Math.min(...el.getAttribute(P_ATTR).split(' ').map(Number)) : null;
    },
    true,
  );

  ns.highlight = highlight;
  ns.clearHighlight = clear;

  if (!globalThis.chrome?.runtime?.onMessage) return; // tests (jsdom)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'content') return undefined;
    const { type, payload = {} } = message;
    // Session belongs to another page (tab navigated): ignore.
    if (payload.url && ns.extractedUrl && payload.url !== ns.extractedUrl) return undefined;
    switch (type) {
      case 'HIGHLIGHT':
        sendResponse({ ok: true, highlighted: highlight(payload.paragraphIndexes, payload) });
        return undefined;
      case 'CLEAR_HIGHLIGHT':
        clear();
        sendResponse({ ok: true });
        return undefined;
      case 'GET_CONTEXT_PARAGRAPH':
        sendResponse({ paragraphIndex: ns.contextParagraph ?? null });
        return undefined;
      default:
        return undefined;
    }
  });
})();
