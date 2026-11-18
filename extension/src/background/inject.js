// Content-script injection. No direct chrome.* calls: `scripting` is chrome.scripting
// (or a fake in tests).

/** Is ChapterlyContent.extract already defined in the tab's main frame (isolated world)? */
export async function contentScriptsPresent(scripting, tabId) {
  try {
    const [probe] = await scripting.executeScript({
      target: { tabId },
      func: () => typeof globalThis.ChapterlyContent?.extract === 'function',
    });
    return probe?.result === true;
  } catch {
    return false;
  }
}

/**
 * Injects the content scripts unless they are already there (a second "Read chapter", or a
 * chapter that was prepared when the popup opened). Saves re-evaluating Readability and the
 * extractors, which can take a noticeable moment on large pages.
 * @returns {Promise<boolean>} true if the scripts were injected now
 */
export async function ensureContentScripts(scripting, tabId, files) {
  if (await contentScriptsPresent(scripting, tabId)) return false;
  await scripting.executeScript({ target: { tabId }, files });
  return true;
}
