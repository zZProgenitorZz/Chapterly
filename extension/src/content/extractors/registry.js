// Registry of site extractors (ES module, imported by the service worker and tests).
//
// Content scripts are injected with chrome.scripting.executeScript({files}), which
// runs classic scripts, not modules. So each site file registers itself on
// globalThis.ChapterlyContent.siteExtractors, and this list decides which files are
// injected and in which order (= match priority; the generic extractor is the fallback).
//
// Adding a site: create src/content/extractors/<id>.js (copy royalroad.js) and add
// its id here.
export const SITE_EXTRACTORS = [
  'royalroad',
];

export const CONTENT_SCRIPT_FILES = [
  'src/content/lib/Readability.js',
  'src/content/cleaning.js',
  'src/content/links.js',
  'src/content/extractors/generic.js',
  ...SITE_EXTRACTORS.map((id) => `src/content/extractors/${id}.js`),
  'src/content/extract.js',
  'src/content/highlight.js',
];
