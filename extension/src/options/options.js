import { DEFAULTS, getSettings, saveSettings } from '../shared/settings.js';

const form = document.getElementById('form');
const input = document.getElementById('backendUrl');
const message = document.getElementById('message');

function show(text, kind) {
  message.textContent = text;
  message.dataset.kind = kind;
}

async function save(url) {
  try {
    const saved = await saveSettings({ backendUrl: url });
    input.value = saved.backendUrl;
    show('Saved', 'ok');
  } catch (err) {
    show(err.message, 'error');
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void save(input.value);
});

document.getElementById('reset').addEventListener('click', () => save(DEFAULTS.backendUrl));

getSettings().then((s) => {
  input.value = s.backendUrl;
});
