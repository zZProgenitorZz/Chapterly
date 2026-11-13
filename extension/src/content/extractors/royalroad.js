// Royal Road (royalroad.com) chapter pages. Classic script (see cleaning.js).
// Selectors verified against a live chapter page on 2026-11-13:
//   chapter title   .fic-header h1            (h2 in the same header = fiction title)
//   story text      .chapter-inner.chapter-content
//   author's notes  .author-note-portlet      (siblings of the content, before/after)
//   next / prev     <link rel="next|prev">, else .nav-buttons a ("Next Chapter")
//   anti-piracy     a <span> inside the content with a random class hidden by a
//                   <style> rule (display:none); handled by cleaning.markHidden.
(() => {
  const ns = (globalThis.ChapterlyContent ??= {});
  ns.siteExtractors ??= [];

  const extractor = {
    id: 'royalroad',
    matches: (location, doc) =>
      /(^|\.)royalroad\.com$/i.test(location.hostname) && Boolean(doc.querySelector('.chapter-content')),
    extract(doc) {
      const { cleaning, links } = ns;
      const content = doc.querySelector('.chapter-inner.chapter-content') ?? doc.querySelector('.chapter-content');
      const text = (el) => cleaning.normalizeText(el?.textContent);

      const navLink = (re) => {
        const a = [...doc.querySelectorAll('.nav-buttons a[href]')].find((el) => re.test(text(el)));
        return a ? cleaning.absoluteUrl(a.getAttribute('href'), doc.baseURI) : null;
      };

      return {
        title: text(doc.querySelector('.fic-header h1')) || doc.title.split(' - ')[0].trim(),
        seriesTitle: text(doc.querySelector('.fic-header h2')) || null,
        paragraphs: cleaning.collectParagraphs(content), // live elements: highlight works directly
        nextChapterUrl: links.relLink(doc, ['next']) ?? navLink(/\bnext\b/i),
        prevChapterUrl: links.relLink(doc, ['prev', 'previous']) ?? navLink(/\bprev(ious)?\b/i),
      };
    },
  };

  // Re-injection safe: replace an earlier registration with the same id.
  ns.siteExtractors = ns.siteExtractors.filter((x) => x.id !== extractor.id).concat(extractor);
})();
