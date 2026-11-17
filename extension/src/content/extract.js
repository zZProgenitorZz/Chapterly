// Extraction entry point. Classic script (see cleaning.js).
// The service worker injects all CONTENT_SCRIPT_FILES, then calls
// globalThis.ChapterlyContent.extract() and gets a ChapterDocument back:
//   { url, title, seriesTitle, paragraphs: [{index, text}], nextChapterUrl,
//     prevChapterUrl, extractorId, charCount }
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});

  function pickExtractor(doc) {
    for (const site of ns.siteExtractors ?? []) {
      try {
        if (site.matches(doc.location, doc)) return site;
      } catch (err) {
        console.warn('[chapterly] extractor.matches failed', site.id, err);
      }
    }
    return ns.extractors.generic;
  }

  ns.extract = function extract(doc = document) {
    const { cleaning } = ns;
    cleaning.reset(doc);
    cleaning.markHidden(doc);

    let extractor = pickExtractor(doc);
    let raw = extractor.extract(doc);
    if (extractor.id !== 'generic' && (!raw?.paragraphs?.length)) {
      // The site layout probably changed; better generic text than nothing.
      extractor = ns.extractors.generic;
      raw = extractor.extract(doc);
    }

    const paragraphs = [];
    const elements = [];
    for (const p of raw.paragraphs) {
      const index = paragraphs.length;
      paragraphs.push({ index, text: p.text });
      const el = p.element ?? null;
      if (el) {
        const prev = el.getAttribute(cleaning.P_ATTR);
        el.setAttribute(cleaning.P_ATTR, prev ? `${prev} ${index}` : String(index));
      }
      elements.push(el ? new WeakRef(el) : null);
    }
    cleaning.clearIds(doc);
    ns.paragraphElements = elements;
    ns.paragraphTexts = paragraphs.map((p) => p.text); // click/highlight offsets refer to these

    const url = cleaning.stripHash(doc.location.href);
    ns.extractedUrl = url;
    return {
      url,
      title: raw.title || doc.title,
      seriesTitle: raw.seriesTitle ?? null,
      paragraphs,
      nextChapterUrl: raw.nextChapterUrl ?? null,
      prevChapterUrl: raw.prevChapterUrl ?? null,
      extractorId: extractor.id,
      charCount: paragraphs.reduce((n, p) => n + p.text.length, 0),
    };
  };
})();
