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

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.${CLASS} {
      background-color: rgba(255, 210, 80, 0.28) !important;
      box-shadow: 0 0 0 4px rgba(255, 210, 80, 0.28) !important;
      border-radius: 3px;
      transition: background-color 0.25s ease;
    }`;
    (document.head ?? document.documentElement).appendChild(style);
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
  }

  function highlight(indexes) {
    ensureStyle();
    clear();
    const els = elementsFor(indexes ?? []);
    for (const el of els) el.classList.add(CLASS);
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
        sendResponse({ ok: true, highlighted: highlight(payload.paragraphIndexes) });
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
