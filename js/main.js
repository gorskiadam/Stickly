// main.js — entry point. Modules are wired together here and nowhere else.

import { initFeedback, showToast } from './feedback.js';
import { onSaveError, subscribe } from './store.js';
import { t } from './strings.js';
import { initSettings } from './settings.js';
import { initUI } from './ui.js';
import { initLater } from './later.js';
import { initCapture } from './capture.js';
import { initNewDay } from './newday.js';
import { initToday } from './daytime.js';
import { initDone } from './done.js';
import { initFocus } from './focus.js';
import { initBinPeek } from './binpeek.js';
import { initWhatNow } from './whatnow.js';
import { initMenu } from './menu.js';
import { initDays } from './days.js';
import { initSync } from './sync.js';

initFeedback();
const updateToday = initToday();
subscribe(() => updateToday()); // follows a change of language
initSettings();
initUI();
initLater();
initBinPeek();
initWhatNow();
initMenu();
initDone();
initFocus();
initDays();
initCapture();
initSync();
initNewDay(); // last: its prompt sits on top of a fully drawn wall

// Never lose notes silently: say so if the browser refuses to save.
let warnedAboutSaving = false;
onSaveError(() => {
  if (warnedAboutSaving) return;
  warnedAboutSaving = true;
  showToast(t('saveFailed'));
});

// Offline support and "install to home screen".
if ('serviceWorker' in navigator) {
  // A newer version took over while the app was open: offer to switch to it.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      showToast(t('updated'), () => window.location.reload(), t('reload'), 'info');
    });
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Stickly: offline support is unavailable', err);
    });
  });
}
