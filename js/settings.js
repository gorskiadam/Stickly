// settings.js — the settings popover, in small groups:
//   you (name, theme) · wall (how many notes, 12 or 24 h clock) · focus
//   (full screen) · sound and language · backup (save everything to a
//   file, or bring a file back).

import {
  getState, subscribe, setTheme, setLimit, setLang, setSound, setName, setSetting,
  exportData, importData, LIMIT_MIN, LIMIT_MAX,
} from './store.js';
import { uses12h, download } from './time.js';
import { offerUndo, showToast } from './feedback.js';
import { t, formatMinutes } from './strings.js';
import { getLang, applyStrings } from './strings.js';

const $ = (id) => document.getElementById(id);
const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];
const clockRadios = radios('clock');
const focusRadios = radios('focusfull');

const root = document.documentElement;
const themeRadios = [...document.querySelectorAll('input[name="theme"]')];
const langRadios = [...document.querySelectorAll('input[name="lang"]')];
const soundRadios = [...document.querySelectorAll('input[name="sound"]')];
const limitValue = document.getElementById('limit-value');
const limitDown = document.getElementById('limit-down');
const limitUp = document.getElementById('limit-up');
const nameInput = document.getElementById('name-input');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/** The language the page's static text is currently in. */
let shownLang = null;

export function initSettings() {
  subscribe(render);
  render(getState());

  themeRadios.forEach((radio) => radio.addEventListener('change', () => setTheme(radio.value)));
  langRadios.forEach((radio) => radio.addEventListener('change', () => setLang(radio.value)));
  soundRadios.forEach((radio) => radio.addEventListener('change', () => setSound(radio.value === 'on')));
  // The name is saved a moment after typing stops, and when leaving the field.
  let nameTimer = 0;
  nameInput.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => setName(nameInput.value), 400);
  });
  nameInput.addEventListener('change', () => { clearTimeout(nameTimer); setName(nameInput.value); });
  nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') nameInput.blur(); });
  limitDown.addEventListener('click', () => setLimit(getState().settings.limit - 1));
  limitUp.addEventListener('click', () => setLimit(getState().settings.limit + 1));
  clockRadios.forEach((radio) => radio.addEventListener('change', () => setSetting('clock', radio.value)));
  focusRadios.forEach((radio) => radio.addEventListener('change', () => setSetting('focusFullscreen', radio.value === 'on')));
  $('data-export').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`stickly-backup-${stamp}.json`, exportData(), 'application/json');
    showToast(t('backupSaved'), null, '', 'info');
  });
  $('data-import').addEventListener('click', () => $('data-file').click());
  $('data-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (importData(await file.text())) offerUndo(t('backupRestored'), 'back');
    else showToast(t('backupUnreadable'), null, '', 'info');
  });
  systemDark.addEventListener('change', () => applyTheme(getState().settings.theme));
}

function render(state) {
  const { theme, limit } = state.settings;
  applyTheme(theme);
  themeRadios.forEach((radio) => { radio.checked = radio.value === theme; });

  // Static text is refilled only when the language actually changes.
  const lang = getLang();
  if (lang !== shownLang) {
    shownLang = lang;
    applyStrings();
  }
  langRadios.forEach((radio) => { radio.checked = radio.value === lang; });
  soundRadios.forEach((radio) => { radio.checked = (radio.value === 'on') === state.settings.sound; });

  if (document.activeElement !== nameInput) nameInput.value = state.settings.name || '';
  const { focusFullscreen } = state.settings;
  clockRadios.forEach((radio) => { radio.checked = (radio.value === '12') === uses12h(); });
  focusRadios.forEach((radio) => { radio.checked = (radio.value === 'on') === focusFullscreen; });
  limitValue.textContent = limit;
  limitDown.disabled = limit <= LIMIT_MIN;
  limitUp.disabled = limit >= LIMIT_MAX;
}

/** 'system' follows the device; 'light' / 'dark' force it via <html data-theme>. */
function applyTheme(theme) {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;

  const dark = theme === 'dark' || (theme === 'system' && systemDark.matches);
  themeColorMeta.content = dark ? '#0E0E0E' : '#F7F5F0';
}
