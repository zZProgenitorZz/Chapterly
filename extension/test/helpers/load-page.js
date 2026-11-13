// Loads an HTML fixture into jsdom and evaluates the content scripts in the same
// order the service worker injects them (CONTENT_SCRIPT_FILES).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { CONTENT_SCRIPT_FILES } from '../../src/content/extractors/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function fixture(name) {
  return readFileSync(join(ROOT, 'test', 'fixtures', name), 'utf8');
}

/** @returns {{window: Window, document: Document, ns: object}} */
export function loadPage(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  for (const file of CONTENT_SCRIPT_FILES) {
    window.eval(readFileSync(join(ROOT, file), 'utf8'));
  }
  return { window, document: window.document, ns: window.ChapterlyContent };
}

/** Extracts like the service worker sees it: the result is cloned out of the page realm. */
export function extractFixture(name, url) {
  const page = loadPage(fixture(name), url);
  return { ...page, chapter: JSON.parse(JSON.stringify(page.ns.extract(page.document))) };
}
