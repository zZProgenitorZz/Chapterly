// Generic extractor: Mozilla Readability (src/content/lib/Readability.js) on a clone
// of the page. Hidden elements are marked in the live DOM first and removed from
// the clone, so Readability never sees them. Classic script (see cleaning.js).
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});
  ns.extractors ??= {};

  ns.extractors.generic = {
    id: 'generic',
    matches: () => true,
    extract(doc) {
      const { cleaning, links } = ns;
      const liveById = cleaning.assignIds(doc);
      const clone = doc.cloneNode(true);
      for (const el of clone.querySelectorAll(`[${cleaning.HIDDEN_ATTR}]`)) el.remove();

      // `Readability` is a global defined by lib/Readability.js.
      const article = new Readability(clone, { keepClasses: true, serializer: (el) => el }).parse();

      const paragraphs = article?.content
        ? cleaning.collectParagraphs(article.content).map((p) => ({
            text: p.text,
            element: cleaning.toLive(p.element, liveById),
          }))
        : [];

      return {
        title: cleaning.normalizeText(article?.title || doc.title),
        seriesTitle: null,
        paragraphs,
        ...links.findChapterLinks(doc),
      };
    },
  };
})();
