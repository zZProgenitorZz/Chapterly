// Content-script injection. No direct chrome.* calls: `scripting` is chrome.scripting
// (or a fake in tests).
//
// Injections are versioned. After the extension is reloaded or updated, a tab still holds
// the previous version's content scripts: orphaned (chrome.runtime.id is gone) but with
// ChapterlyContent.extract defined and their install guards set, so a check for "extract
// exists" would skip injecting new files (floating-controls.js) and keep dead listeners.
// The service worker therefore stamps each injection with an instance id that is new for
// every extension load (see getInstanceId in service-worker.js), and only a matching
// stamp counts as "present".

/** Are this extension instance's content scripts in the tab's main frame (isolated world)? */
export async function contentScriptsPresent(scripting, tabId, instanceId) {
  if (!instanceId) return false;
  try {
    const [probe] = await scripting.executeScript({
      target: { tabId },
      func: (id) => typeof globalThis.ChapterlyContent?.extract === 'function' && globalThis.ChapterlyContent.instanceId === id,
      args: [instanceId],
    });
    return probe?.result === true;
  } catch {
    return false;
  }
}

/**
 * Runs in the page before a fresh injection: clears what an older version left behind so
 * the new scripts install their listeners and UI again. Self-contained (it is serialized
 * by executeScript).
 */
export function resetContentScripts() {
  const ns = globalThis.ChapterlyContent;
  if (!ns) return 0;
  let cleared = 0;
  for (const key of Object.keys(ns)) {
    if (/Installed$/.test(key) && ns[key]) {
      ns[key] = false; // pageControlsInstalled, floatingControlsInstalled, highlightInstalled, ...
      cleared++;
    }
  }
  delete ns.instanceId;
  // Old floating buttons and the old highlight style (the new version brings its own).
  for (const el of document.querySelectorAll('chapterly-controls, style#chapterly-style')) el.remove();
  return cleared;
}

/**
 * Injects the content scripts unless this extension instance's copy is already there (a
 * second "Read chapter", or a chapter prepared when the popup opened).
 * @returns {Promise<boolean>} true if the scripts were injected now
 */
export async function ensureContentScripts(scripting, tabId, files, instanceId) {
  if (await contentScriptsPresent(scripting, tabId, instanceId)) return false;
  await scripting.executeScript({ target: { tabId }, func: resetContentScripts });
  await scripting.executeScript({ target: { tabId }, files });
  await scripting.executeScript({
    target: { tabId },
    func: (id) => {
      (globalThis.ChapterlyContent ??= {}).instanceId = id;
    },
    args: [instanceId],
  });
  return true;
}
