# Chapterly extension

A Chrome extension (Manifest V3) that reads web novel chapters aloud, or just selected text. It sends the text to the local Chapterly backend and plays back the MP3 it returns.

The extension is plain JavaScript with no bundler and no build step. It contains no secrets: the only thing it knows is the backend URL.

## Load it in Chrome

1. Start the backend from the repo root with `mvn spring-boot:run` (see the [root README](../README.md)).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this `extension/` folder.
3. Open a chapter page, open the toolbar popup and click **Read chapter**. To read only part of a page, select the text and use **Read selection**, or right-click it and choose **Read aloud with Chapterly**.

The first time you click **Read chapter** on a site, Chrome asks for permission to access that site. Only that one site is requested, never all sites.
- **If you deny it,** reading still works through `activeTab`: clicking the extension's button grants one-off access to the current tab.
- **Why the extension asks anyway:** `activeTab` access is lost once the tab navigates. A later step (auto next chapter) needs to inject into the next chapter page without another click. `chrome.permissions.contains` is the only record of what's granted; the extension stores nothing extra.

To change the backend URL, open the popup and click **Settings**. The default is `http://localhost:8080`.

## Choosing a voice

The voice list comes from the backend (`GET /api/voices`), grouped by provider:
- **Kokoro (local)** is the default. Its default voice is `af_heart`, "Heart (US, female)".
- **Microsoft Azure** voices, such as Brian, can be selected only when the backend has Azure credentials. Otherwise the group shows a single disabled "Not configured on the backend" entry.
- Each provider's default voice is marked "· default".

**Where to pick it:**
- **Settings (options page):** the **Voice** select. **Preview** plays "This is how chapters will sound with this voice." If the backend can't be reached, the page shows the error and keeps your stored choice.
- **Popup:** a compact voice select above the controls, so you can switch while reading.

The choice is saved in `chrome.storage.sync` as `provider` and `voice`. Every TTS request sends it to the backend, which tries that provider first.

**Fallback:** if the chosen provider is down, times out or is out of quota, the backend can answer with another provider's default voice. The popup then shows, for example, **Voice: Brian (Azure, fallback)** instead of **Voice: Heart (Kokoro)**.

**Switching mid-chapter:**
1. The service worker sees the settings change and sends `PLAYER_SET_VOICE` to the offscreen player.
2. The player stops the current audio, drops the prefetched chunks (they were made with the old voice) and restarts the **current chunk from its beginning** in the new voice.
3. If you were paused, it stays paused, with the new voice loaded.

Nothing overlaps, and no old-voice audio plays later. If Chrome closed the offscreen document during a long pause, the restored session uses the voice that's selected now.

The extension needs no extra host permissions for any of this: only the backend talks to Kokoro and Azure.

## How it works

```
popup ──READ_CHAPTER / READ_SELECTION / PLAYER_COMMAND──▶ service worker ──PLAYER_*──▶ offscreen document
  ▲                                                        │  │   ▲                    Player + AudioCache
  └──────────────────── PLAYER_STATE ──────────────────────┘  │   └─── PLAYER_EVENT ───┘     │
                                                              │                              ▼
                          executeScript(files) + extract()    │  HIGHLIGHT       POST {backend}/api/tts
                          ┌───────────────────────────────────┘
                          ▼
                  page: src/content/*   (extraction, highlight, "read from here")
```

| Part | File(s) | Role |
|---|---|---|
| Service worker | `src/background/service-worker.js` | The coordinator. See the list below. It keeps nothing important in memory. |
| Session store | `src/shared/session-store.js` | `getActiveSession`, `saveActiveSession` and `updatePosition`, backed by `chrome.storage.session`. Also holds the latest player snapshot and the restore logic. |
| Content scripts | `src/content/*` | Extract the chapter (ChapterDocument), clean it, highlight the paragraph being read, and remember which paragraph was right-clicked. |
| Chunker | `src/shared/chunker.js` | `chunkParagraphs(paragraphs)` returns `[{index, text, paragraphIndexes}]`. It's a pure function. |
| Offscreen document | `src/offscreen/*` | Owns playback with two `<audio>` elements. It fetches audio itself; audio never passes through runtime messaging. |
| Player | `src/player/player.js` | Plays a session. See the list below. |
| AudioCache | `src/player/audio-cache.js` | Prefetching. See the list below. |
| TTS client | `src/player/tts-client.js` | `fetchSpeech(text, {baseUrl, signal, provider, voice})` returns `{blob, provider, voice, fallback}`, read from the `X-TTS-*` headers. `fetchVoices(baseUrl)` gets the voice list. Errors are typed and include the provider from the error body. The client timeout is 45 seconds, above the backend's 30-second Kokoro timeout. |
| Voices | `src/shared/voices.js`, `src/shared/error-messages.js` | Builds the grouped voice `<select>` and the "Voice: …" line, and turns errors into text that names the provider (for example "Kokoro is not running. Start the Kokoro server on localhost:8880."). |
| Popup, options | `src/popup/*`, `src/options/*` | The UI and the backend URL setting. |

**Service worker:**
- Context menus, offscreen document lifecycle (`ensureOffscreen()`), page injection, command routing, page highlight and the badge.
- Badge: `▶` while playing, `!` on error, `✓` when the chapter is finished.

**Player:**
- `load({sessionId, title, chunks, startIndex, startTime})`.
- Commands: `play`, `pause`, `stop`, `seekToChunk`, `next`, `previous`. `previous` restarts the current chunk if you're more than 3 seconds in; otherwise it goes back one chunk.
- `playbackRate` is a field, defaulting to 1, and applies to both audio elements.
- States: `idle`, `loading`, `buffering`, `playing`, `paused`, `error`.

**AudioCache:**
- Keeps up to 2 chunks requested ahead of the current one, with at most 2 requests in flight.
- Retries a failed request once after 1 second.
- Aborts requests that a seek made unnecessary, and revokes object URLs for chunks more than 1 behind.

### Reading a chapter

1. **Inject.** The popup's **Read chapter** sends `READ_CHAPTER`. The service worker injects `CONTENT_SCRIPT_FILES` with `chrome.scripting.executeScript({files})`, then calls `ChapterlyContent.extract()` in the page. These are classic scripts, not modules, so they share the `globalThis.ChapterlyContent` namespace.
2. **Extract.** `extract()` builds a **ChapterDocument**: `{url, title, seriesTitle, paragraphs: [{index, text}], nextChapterUrl, prevChapterUrl, extractorId, charCount}`. Steps:
   1. It removes marks from any earlier run.
   2. It marks hidden elements and note blocks in the *live* DOM (`data-chapterly-hidden`).
   3. It picks the first site extractor whose `matches(location, document)` is true, falling back to the generic extractor.
   4. It tags each paragraph's live element with `data-chapterly-p="<index>"` so it can be highlighted.
3. **Check.** If there are fewer than 3 paragraphs or under 500 characters, the popup shows "No chapter text found on this page".
4. **Chunk and store.** The paragraphs become chunks: short paragraphs (such as dialogue) merge up to 200 characters, long ones split on sentence boundaries at 1200 characters, and the first chunk is at most 400 characters so audio starts quickly. The session (`{sessionId, tabId, url, title, extractorId, nextChapterUrl, prevChapterUrl, chunks, currentIndex}`) is saved as `activeSession` in `chrome.storage.session`.
5. **Play.** The offscreen Player plays the chunks. While element A plays chunk *i*, element B already holds chunk *i+1*, so on `ended` B starts at once. If *i+1* isn't ready yet, the status becomes `buffering`.
6. **Follow along.** On every `chunkStarted`, the service worker:
   - stores `currentIndex`,
   - sends `HIGHLIGHT {paragraphIndexes}` to the tab, which highlights those paragraphs and scrolls them into view only if they're off screen.
   - On `sessionFinished`, it logs the event and sets the badge to `✓`. This is the hook for auto-next-chapter later.
7. **Long pauses.** Chrome closes the offscreen document after about 30 seconds without audio. When you press play again, the service worker recreates it and reloads the stored session at `currentIndex`, from the paused position if it has one.
8. **Read from here.** While a chapter session is active, right-clicking a paragraph and choosing **Chapterly: read from here** jumps to the chunk that contains that paragraph.

### Cleaning (`src/content/cleaning.js`)

These rules apply to every extractor:
- **Invisible text is skipped.** This covers `display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`, "sr-only" clipping, zero-size boxes with hidden overflow, and elements pushed off the page. Some sites inject hidden anti-piracy sentences; Royal Road does this with a randomly named class hidden from a `<style>` block. Visibility is checked on the live page *before* the clone is made for Readability.
- **Note blocks are dropped.** These are elements whose class or id contains `author-note`, `authors-note`, `translator`, `a/n`, `notes`, and similar.
- **Note paragraphs are dropped.** These start with "A/N", "Author's note", "TL note", "T/N", "TN:", and similar.
- **Promo lines are dropped.** These are lines that are only Patreon, Discord or Ko-fi links or calls to action.
- **Nav text is dropped.** For example: "Previous Chapter | Table of Contents | Next Chapter".
- **Whitespace is normalised.** `<br>` breaks become separate paragraphs, and anything with no letters or digits (such as `***`) is skipped.

Next and previous chapter links come from `rel="next"`/`rel="prev"` first. Failing that, they come from anchor text (`next`, `›`, `»`, `→` and the reverse), preferring same-origin links and ignoring links inside comment sections.

### Adding a site extractor

1. Create `src/content/extractors/<id>.js`, using `royalroad.js` as a template. It registers `{id, matches(location, doc), extract(doc)}` on `ChapterlyContent.siteExtractors`. `extract` returns `{title, seriesTitle, paragraphs: [{text, element}], nextChapterUrl, prevChapterUrl}`. Use `ns.cleaning.collectParagraphs(container)` for the paragraphs so the shared cleaning rules apply and `element` is the live element used for highlighting.
2. Add `'<id>'` to `SITE_EXTRACTORS` in `src/content/extractors/registry.js`. That list decides which files are injected and in what order; first match wins. If a site extractor finds no paragraphs, for example because the site changed its layout, `extract()` falls back to the generic extractor.
3. Save a trimmed copy of a real chapter page as `test/fixtures/<id>-chapter.html`. Replace the story text with placeholder text and keep the real structure and class names. Then add tests to `test/extract.test.js`.

**Royal Road selectors** (checked against a live chapter page on 2026-11-13):

| What | Selector |
|---|---|
| Chapter title | `.fic-header h1` |
| Fiction title | `.fic-header h2` |
| Story text | `.chapter-inner.chapter-content` |
| Author's notes | `.author-note-portlet`, placed before and after the content |
| Next/previous | `<link rel="next"/"prev">`, falling back to the `.nav-buttons a` "Next Chapter" / "Previous Chapter" buttons |

### Third-party code

`src/content/lib/Readability.js` is [Mozilla Readability](https://github.com/mozilla/readability) 0.6.0, vendored unchanged under the Apache License 2.0. The license header is kept in the file, and the full license is in `src/content/lib/Readability.LICENSE.md`. The generic extractor runs it on `document.cloneNode(true)`, after removing the hidden and note elements that were marked on the live page.

## Tests

You need Node 20 or newer. The only dev dependency is jsdom 26, which is pinned because jsdom 27 and later need a newer Node 22 than 22.11.

```bash
cd extension
npm install
npm test
```

Test files:
- `extract.test.js`: extraction on fixtures in `test/fixtures/`. The fixtures are a Royal Road chapter, a WordPress-style translation blog, and a page with hidden anti-piracy text, author's notes and `<br>`-separated text. The tests cover:
  - which paragraphs are picked,
  - exclusion of notes, hidden text, promo and navigation,
  - next/prev detection,
  - mapping paragraphs to live elements.

  The content scripts are evaluated in jsdom in the same order they are injected. jsdom's `getComputedStyle` only sees inline styles and `<style>` tags, so the hidden fixture text uses `<style>` classes.
- `chunker.test.js`: merging, splitting, the first-chunk limit, and `maxChars` staying well below the backend's 3000-character limit.
- `audio-cache.test.js`: the prefetch window, the in-flight limit, abort on seek, URL revocation and retry. Uses a mock fetch.
- `player.test.js`: uses fake audio elements. Covers:
  - gapless hand-over between the two elements, buffering, and resuming;
  - the error after a retry, naming the chunk;
  - next/previous/stop with no stray audio, and `playbackRate`;
  - `setVoice`: the cache is cleared, the current chunk restarts in the new voice, paused stays paused, and late responses in the old voice are ignored.
- `session-store.test.js`: `updatePosition`, and restoring after the offscreen document was closed, including the voice.
- `tts-client.test.js`: sends the provider and voice, reads the new headers, and covers `fetchVoices` (the happy path and typed errors).
- `settings.test.js`: the new defaults (Kokoro, `af_heart`) and voice validation.
- `error-messages.test.js`: error texts that name the provider.
- `voices.test.js`: the voice `<select>` grouping and the "Voice: …" line.

### Manual test checklist

Run these with the backend running at `http://localhost:8080`.

- [ ] **Load unpacked:** no errors on the extension's card or in the service worker console.
- [ ] **Royal Road chapter:**
  - Click **Read chapter**. Chrome asks for royalroad.com access once.
  - The popup shows the chapter title, `royalroad` and `1 / N`. Audio starts after about one short request.
  - The paragraph being read is highlighted and scrolls into view.
  - Author's notes, the hidden anti-piracy sentence and comments are not read.
  - There are no audible gaps between chunks.
- [ ] **A site handled by the generic extractor** (for example a WordPress translation blog): the popup shows `generic`. Only the chapter is read, without the nav links, translator notes or comments.
- [ ] **A page that isn't a chapter** (for example a search page): the popup shows "No chapter text found on this page".
- [ ] **Pause for more than a minute, then play:** reading resumes at the same chunk.
- [ ] **⏭ / ⏮ / ⏹ while the next chunk is still loading:** reading lands on the right chunk, and there's no stray or overlapping audio. ⏹ clears the highlight.
- [ ] **Read from here:** right-click a paragraph further down and choose **Chapterly: read from here**.
- [ ] **End of chapter:** the badge shows `✓`, and the service worker console logs "session finished" with the next chapter URL.
- [ ] **Backend stopped:** the popup shows "Chunk n failed: Backend not reachable at …" and the badge shows `!`. Start the backend again and press **Retry**; reading continues from that chunk.
- [ ] **Read selection** still works as in step 2.

**Voices:**
- [ ] **Kokoro running, Azure not configured:**
  - Chapters read with Kokoro `af_heart`, and the popup shows "Voice: Heart (Kokoro)".
  - In Settings, the Microsoft Azure group shows only a disabled "Not configured on the backend".
- [ ] **Kokoro stopped** (`docker stop kokoro`):
  - Without Azure, the popup shows "Chunk n failed: Kokoro is not running. Start the Kokoro server on localhost:8880."
  - With Azure configured and fallback on, reading continues with Brian, and the popup shows "Voice: Brian (Azure, fallback)".
- [ ] **Switch voice mid-chapter** in the popup:
  - The current chunk restarts in the new voice right away, with no overlap and no old-voice chunks later.
  - Doing it while paused keeps it paused.
- [ ] **Azure configured:** pick Brian in Settings and press **Preview**, then read a chapter. It reads with Brian.
