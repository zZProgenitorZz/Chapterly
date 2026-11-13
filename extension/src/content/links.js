// Next/previous chapter link detection. Classic script (see cleaning.js).
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});
  const { absoluteUrl, stripHash, normalizeText, HIDDEN_ATTR } = ns.cleaning;

  const NEXT_RE = /\bnext\b|›|»|→/i;
  const PREV_RE = /\bprev(?:ious)?\b|‹|«|←/i;
  const COMMENTS_RE = /comment|respond|reply|disqus/i;

  function relLink(doc, rels) {
    const here = stripHash(doc.location?.href ?? doc.baseURI);
    for (const rel of rels) {
      for (const el of doc.querySelectorAll(`link[rel~="${rel}" i][href], a[rel~="${rel}" i][href]`)) {
        const url = absoluteUrl(el.getAttribute('href'), doc.baseURI);
        if (url && stripHash(url) !== here) return url;
      }
    }
    return null;
  }

  function label(a) {
    return normalizeText([a.textContent, a.getAttribute('aria-label'), a.getAttribute('title')].filter(Boolean).join(' '));
  }

  function inComments(a) {
    for (let e = a.parentElement; e && e !== a.ownerDocument.body; e = e.parentElement) {
      if (COMMENTS_RE.test(`${e.id} ${typeof e.className === 'string' ? e.className : ''}`)) return true;
    }
    return false;
  }

  /** Best anchor whose label matches `want` (and not `avoid`), preferring same-origin links. */
  function anchorLink(doc, want, avoid) {
    const here = stripHash(doc.location?.href ?? doc.baseURI);
    const origin = new URL(here).origin;
    let best = null;
    for (const a of doc.querySelectorAll('a[href]')) {
      if (a.closest(`[${HIDDEN_ATTR}]`)) continue;
      const text = label(a);
      if (!text || text.length > 40 || !want.test(text) || avoid.test(text)) continue;
      const url = absoluteUrl(a.getAttribute('href'), doc.baseURI);
      if (!url || stripHash(url) === here) continue;
      let score = 0;
      if (new URL(url).origin === origin) score += 10;
      if (/chapter/i.test(text)) score += 3;
      if (/chapter|ch[-_]?\d|\/\d+/i.test(url)) score += 1;
      if (inComments(a)) score -= 6;
      if (!best || score > best.score) best = { url, score };
    }
    return best?.url ?? null;
  }

  /** rel="next"/"prev" first, then anchor text, preferring same-origin links. */
  function findChapterLinks(doc) {
    return {
      nextChapterUrl: relLink(doc, ['next']) ?? anchorLink(doc, NEXT_RE, PREV_RE),
      prevChapterUrl: relLink(doc, ['prev', 'previous']) ?? anchorLink(doc, PREV_RE, NEXT_RE),
    };
  }

  ns.links = { findChapterLinks, relLink, anchorLink };
})();
