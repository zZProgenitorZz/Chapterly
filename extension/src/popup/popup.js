// Popup: UI only. Reads state from the service worker and sends commands.
// Settings (voice, speed, auto-next) are saved to chrome.storage.sync; the service
// worker sees the change and applies it to the running player.

import { describeError, errorDetail } from '../shared/error-messages.js';
import { MessageType, PlayerCommand, Target, listen, toBackground } from '../shared/messages.js';
import { DEFAULTS, formatRate, getSettings, saveSettings, stepRate } from '../shared/settings.js';
import { fetchVoices, toErrorInfo } from '../player/tts-client.js';
import { describeVoice, parseVoiceKey, renderVoiceOptions } from '../shared/voices.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  title: $('title'),
  series: $('series'),
  extractor: $('extractor'),
  progress: $('progress'),
  provider: $('provider'),
  error: $('error'),
  errorText: $('error-text'),
  errorDetail: $('error-detail'),
  notice: $('notice'),
  resume: $('resume'),
  resumeText: $('resume-text'),
  resumeYes: $('resume-yes'),
  resumeNo: $('resume-no'),
  chapter: $('chapter'),
  chapterText: $('chapter-text'),
  nextChapter: $('next-chapter'),
  allowSite: $('allow-site'),
  readChapter: $('read-chapter'),
  read: $('read'),
  previous: $('previous'),
  toggle: $('toggle'),
  next: $('next'),
  stop: $('stop'),
  options: $('options'),
  voice: $('voice'),
  slower: $('slower'),
  rate: $('rate'),
  faster: $('faster'),
  autoNext: $('auto-next'),
  shortcuts: $('shortcuts'),
};

const STATUS_LABELS = {
  idle: 'Idle',
  loading: 'Loading…',
  buffering: 'Buffering…',
  playing: 'Playing',
  paused: 'Paused',
  error: 'Error',
};

const NOTICES = {
  NO_SELECTION: 'Select some text first',
  NO_CHAPTER_TEXT: 'No chapter text found on this page',
  CANNOT_ACCESS_PAGE: "Chapterly can't read this page (browser pages and the Web Store are off limits)",
  NO_TAB: 'No active tab',
};

const CHAPTER_NOTICES = {
  NO_PERMISSION: 'Allow Chapterly on this site to continue automatically',
  NO_CHAPTER_TEXT: 'No chapter text found on the next page',
  TIMEOUT: 'The next chapter did not finish loading within 20 seconds',
  NO_NEXT: 'This was the last chapter (no next chapter link found)',
};

let current = null;
let catalog = null; // GET /api/voices
let activeTab = null;
let originGranted = false;
let rate = DEFAULTS.playbackRate;

function originPattern(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}/*` : null;
  } catch {
    return null;
  }
}

function render(state, event) {
  current = state;
  const status = state?.status ?? 'idle';
  const hasSession = Boolean(state?.sessionId);
  const busy = status === 'playing' || status === 'loading' || status === 'buffering';
  const chapter = state?.chapter ?? null;
  const finished = Boolean(state?.finished) || event === 'sessionFinished';

  els.status.dataset.status = chapter?.phase === 'loading' ? 'loading' : status;
  els.status.textContent =
    chapter?.phase === 'loading' ? 'Next chapter…' : finished && status === 'idle' ? 'Finished' : STATUS_LABELS[status] ?? status;

  els.title.textContent = hasSession ? state.title || 'Selected text' : 'Nothing loaded';
  const extractorId = state?.meta?.extractorId;
  els.extractor.textContent = hasSession && extractorId && extractorId !== 'selection' ? extractorId : '';
  els.series.textContent = hasSession ? state.meta?.seriesTitle ?? '' : '';
  els.progress.textContent = hasSession && state.total ? `${state.index + 1} / ${state.total}` : '';
  // Display only: width of the progress bar.
  const fraction = hasSession && state.total ? (state.index + 1) / state.total : 0;
  document.body.style.setProperty('--progress', String(Math.min(1, Math.max(0, fraction))));
  els.provider.textContent = hasSession ? describeVoice(state, catalog) : '';
  els.provider.classList.toggle('fallback', Boolean(state?.fallback));

  const showError = status === 'error' && state.error;
  els.error.hidden = !showError;
  if (showError) {
    const message = describeError(state.error);
    els.errorText.textContent =
      state.error.chunkIndex != null ? `Chunk ${state.error.chunkIndex + 1} failed: ${message}` : message;
    els.errorDetail.textContent = errorDetail(state.error);
  }

  renderChapterBox(state, chapter, finished);

  els.toggle.textContent = busy ? 'Pause' : status === 'error' ? 'Retry' : 'Play';
  els.toggle.dataset.action = busy ? 'pause' : status === 'error' ? 'retry' : 'play'; // picks the icon (CSS)
  els.toggle.disabled = !hasSession;
  els.stop.disabled = !hasSession || status === 'idle';
  els.previous.disabled = !hasSession;
  els.next.disabled = !hasSession || state.index + 1 >= state.total;
}

/** "Chapter finished" + Next chapter button, auto-next progress and problems. */
function renderChapterBox(state, chapter, finished) {
  const nextUrl = chapter?.url ?? state?.meta?.nextChapterUrl ?? null;
  let text = '';
  let showNext = false;
  let showAllow = false;
  if (chapter?.phase === 'loading') {
    text = 'Loading the next chapter…';
  } else if (chapter?.phase === 'stopped') {
    text = CHAPTER_NOTICES[chapter.notice] ?? 'Could not continue with the next chapter';
    showAllow = chapter.notice === 'NO_PERMISSION';
    showNext = chapter.notice === 'TIMEOUT' && Boolean(nextUrl);
  } else if (finished && state?.meta?.kind === 'chapter' && state.status === 'idle') {
    text = 'Chapter finished';
    showNext = Boolean(nextUrl);
  }
  els.chapter.hidden = !text;
  els.chapterText.textContent = text;
  els.nextChapter.hidden = !showNext;
  els.allowSite.hidden = !showAllow;
  els.allowSite.dataset.pattern = showAllow ? originPattern(nextUrl) ?? '' : '';
}

function renderRate(value) {
  rate = value;
  els.rate.textContent = formatRate(value);
}

function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = !text;
}

async function command(cmd, extra = {}) {
  const state = await toBackground(MessageType.PLAYER_COMMAND, { command: cmd, ...extra });
  if (state && 'status' in state) render(state);
  return state;
}

function handleReadResult(result) {
  els.resume.hidden = true;
  if (result?.ok) return;
  if (result?.choice) {
    // A remembered position for this chapter: resume (default) or start over.
    const { paragraphIndex, paragraphNumber, paragraphCount } = result.choice;
    els.resumeText.textContent = `You stopped at paragraph ${paragraphNumber} of ${paragraphCount}.`;
    els.resumeYes.textContent = `Resume from paragraph ${paragraphNumber}`;
    els.resumeYes.onclick = () => sendRead(MessageType.READ_CHAPTER, { start: 'resume', paragraphIndex });
    els.resumeNo.onclick = () => sendRead(MessageType.READ_CHAPTER, { start: 'top' });
    els.resume.hidden = false;
    els.resumeYes.focus();
    return;
  }
  showNotice(NOTICES[result?.error] ?? (result?.error ? `Could not start reading: ${result.error}` : 'Could not start reading'));
}

els.readChapter.addEventListener('click', () => {
  showNotice('');
  const tab = activeTab;
  // Ask for this site's permission on first use, synchronously inside the click
  // (permissions.request needs the user gesture). Extraction itself works through
  // activeTab either way; the permission lets auto-next inject into the next chapter.
  const pattern = originPattern(tab?.url);
  if (pattern && !originGranted) {
    chrome.permissions.request({ origins: [pattern] }).then(
      (granted) => (originGranted = granted),
      () => {},
    );
  }
  sendRead(MessageType.READ_CHAPTER, { start: 'ask' });
});

els.read.addEventListener('click', () => {
  showNotice('');
  sendRead(MessageType.READ_SELECTION);
});

function sendRead(type, extra = {}) {
  els.resume.hidden = true;
  activeTabReady
    .then(() => toBackground(type, { tabId: activeTab?.id, ...extra }))
    .then(handleReadResult, (err) => showNotice(`Could not start reading: ${err.message}`));
}

els.toggle.addEventListener('click', () => {
  const status = current?.status ?? 'idle';
  if (status === 'playing' || status === 'loading' || status === 'buffering') return command(PlayerCommand.PAUSE);
  if (status === 'paused') return command(PlayerCommand.RESUME);
  return command(PlayerCommand.PLAY);
});

els.previous.addEventListener('click', () => command(PlayerCommand.PREVIOUS));
els.next.addEventListener('click', () => command(PlayerCommand.NEXT));
els.stop.addEventListener('click', () => command(PlayerCommand.STOP));

els.nextChapter.addEventListener('click', () => {
  toBackground(MessageType.NEXT_CHAPTER).catch((err) => showNotice(err.message));
});

els.allowSite.addEventListener('click', () => {
  const pattern = els.allowSite.dataset.pattern;
  if (!pattern) return;
  chrome.permissions.request({ origins: [pattern] }).then((granted) => {
    if (granted) return toBackground(MessageType.NEXT_CHAPTER);
    return undefined;
  }, () => {});
});

// ---------- settings: voice, speed, auto-next ----------

els.voice.addEventListener('change', () => {
  const selection = parseVoiceKey(els.voice.value);
  if (!selection) return;
  saveSettings(selection).catch((err) => showNotice(err.message));
});

const saveRate = (value) => saveSettings({ playbackRate: value }).then((s) => renderRate(s.playbackRate));
els.slower.addEventListener('click', () => saveRate(stepRate(rate, -1)));
els.faster.addEventListener('click', () => saveRate(stepRate(rate, 1)));
els.rate.addEventListener('click', () => saveRate(DEFAULTS.playbackRate));

els.autoNext.addEventListener('change', () => {
  saveSettings({ autoNextChapter: els.autoNext.checked }).catch((err) => showNotice(err.message));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if ('playbackRate' in changes) renderRate(changes.playbackRate.newValue ?? DEFAULTS.playbackRate);
  if ('autoNextChapter' in changes) els.autoNext.checked = Boolean(changes.autoNextChapter.newValue);
});

async function loadSettings() {
  const settings = await getSettings();
  renderRate(settings.playbackRate);
  els.autoNext.checked = settings.autoNextChapter;
  const selection = { provider: settings.provider, voice: settings.voice };
  try {
    catalog = await fetchVoices(settings.backendUrl, { apiToken: settings.apiToken });
    renderVoiceOptions(els.voice, catalog, selection, { markDefault: false });
    els.voice.disabled = false;
    if (current) render(current); // labels for the "Voice:" line
  } catch (err) {
    renderVoiceOptions(els.voice, null, selection); // keep showing the stored choice
    els.voice.disabled = true;
    els.voice.title = describeError(toErrorInfo(err));
  }
}

/** Footer hint with the actual shortcut keys (the user may have changed them). */
async function loadShortcuts() {
  const commands = await chrome.commands?.getAll?.().catch(() => []) ?? [];
  const key = (name) => commands.find((c) => c.name === name)?.shortcut || null;
  const parts = [];
  if (key('play-pause')) parts.push(`${key('play-pause')} play/pause`);
  if (key('previous-paragraph') || key('next-paragraph')) {
    parts.push(`${[key('previous-paragraph'), key('next-paragraph')].filter(Boolean).join(' / ')} paragraph`);
  }
  parts.push('On the page: ← → and k, click a paragraph to jump');
  els.shortcuts.textContent = parts.join(' · ');
}

els.options.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

listen(Target.POPUP, ({ type, payload }) => {
  if (type === MessageType.PLAYER_STATE) render(payload.state, payload.event);
  return { ok: true };
});

// Look these up now so the click handler can call permissions.request synchronously.
const activeTabReady = chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  activeTab = tab ?? null;
  const pattern = originPattern(tab?.url);
  originGranted = pattern ? await chrome.permissions.contains({ origins: [pattern] }).catch(() => false) : false;
});

void loadSettings();
void loadShortcuts();

const initialState = command(PlayerCommand.GET_STATE).catch((err) => {
  console.error('[chapterly:popup]', err);
  render(null);
  return null;
});

const stripHash = (url) => String(url ?? '').split('#')[0];

// Warm start: on a page that isn't being read, let the service worker extract the chapter
// and fetch its first chunk now, so "Read chapter" starts at once. Only on sites Chapterly
// may already access; nothing plays and the current session is untouched.
Promise.all([activeTabReady, initialState]).then(([, state]) => {
  if (activeTab?.id == null || !originGranted || !originPattern(activeTab.url)) return;
  if (state?.sessionId && state.meta?.kind === 'chapter' && stripHash(state.meta.url) === stripHash(activeTab.url)) return;
  toBackground(MessageType.PREPARE_CHAPTER, { tabId: activeTab.id }).catch(() => {});
});
