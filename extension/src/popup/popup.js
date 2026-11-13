// Popup: UI only. Reads state from the service worker and sends commands.

import { describeError, errorDetail } from '../shared/error-messages.js';
import { MessageType, PlayerCommand, Target, listen, toBackground } from '../shared/messages.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  title: $('title'),
  extractor: $('extractor'),
  progress: $('progress'),
  provider: $('provider'),
  error: $('error'),
  errorText: $('error-text'),
  errorDetail: $('error-detail'),
  notice: $('notice'),
  readChapter: $('read-chapter'),
  read: $('read'),
  previous: $('previous'),
  toggle: $('toggle'),
  next: $('next'),
  stop: $('stop'),
  options: $('options'),
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

let current = null;
let activeTab = null;
let originGranted = false;

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

  els.status.dataset.status = status;
  els.status.textContent = event === 'sessionFinished' ? 'Finished' : STATUS_LABELS[status] ?? status;

  els.title.textContent = hasSession ? state.title || 'Selected text' : 'Nothing loaded';
  const extractorId = state?.meta?.extractorId;
  els.extractor.textContent = hasSession && extractorId && extractorId !== 'selection' ? extractorId : '';
  els.progress.textContent = hasSession && state.total ? `${state.index + 1} / ${state.total}` : '';
  els.provider.textContent = state?.provider ? `Voice: ${state.provider}` : '';

  const showError = status === 'error' && state.error;
  els.error.hidden = !showError;
  if (showError) {
    const message = describeError(state.error);
    els.errorText.textContent =
      state.error.chunkIndex != null ? `Chunk ${state.error.chunkIndex + 1} failed: ${message}` : message;
    els.errorDetail.textContent = errorDetail(state.error);
  }

  els.toggle.textContent = busy ? 'Pause' : status === 'error' ? 'Retry' : 'Play';
  els.toggle.disabled = !hasSession;
  els.stop.disabled = !hasSession || status === 'idle';
  els.previous.disabled = !hasSession;
  els.next.disabled = !hasSession || state.index + 1 >= state.total;
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
  if (result?.ok) return;
  showNotice(NOTICES[result?.error] ?? (result?.error ? `Could not start reading: ${result.error}` : 'Could not start reading'));
}

els.readChapter.addEventListener('click', () => {
  showNotice('');
  const tab = activeTab;
  // Ask for this site's permission on first use, synchronously inside the click
  // (permissions.request needs the user gesture). Extraction itself works through
  // activeTab either way; the permission lets step 5 inject into the next chapter.
  const pattern = originPattern(tab?.url);
  if (pattern && !originGranted) {
    chrome.permissions.request({ origins: [pattern] }).then(
      (granted) => (originGranted = granted),
      () => {},
    );
  }
  sendRead(MessageType.READ_CHAPTER);
});

els.read.addEventListener('click', () => {
  showNotice('');
  sendRead(MessageType.READ_SELECTION);
});

function sendRead(type) {
  activeTabReady
    .then(() => toBackground(type, { tabId: activeTab?.id }))
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

command(PlayerCommand.GET_STATE).catch((err) => {
  console.error('[chapterly:popup]', err);
  render(null);
});
