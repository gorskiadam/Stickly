// newday.js — the fresh start. The first time Stickly is opened on a new day,
// a quiet card says good morning (or afternoon, or evening) with the date.
//   • If yesterday's finished notes never got their end-of-day sweep, it
//     offers to end yesterday now.
//   • If there are notes left from before, it asks: keep them, or start fresh?
//   • Otherwise it's just a hello, and one button to start the day.

import { getState, isNewDay, markToday, clearAll, doneBeforeToday, arriveTomorrow, takeArrived } from './store.js';
import { offerUndo, showToast } from './feedback.js';
import { endTheDay } from './sweep.js';
import { greeting, formatDay } from './daytime.js';
import { t } from './strings.js';

const dialog = document.getElementById('newday');
const dateLine = document.getElementById('newday-date');
const greetingLine = document.getElementById('newday-greeting');
const yesterdayBox = document.getElementById('newday-yesterday');
const doneLine = document.getElementById('newday-done');
const endButton = document.getElementById('newday-end');
const question = document.getElementById('newday-text');
const arrivedLine = document.getElementById('newday-arrived');

/** Notes put aside for today that just came onto the wall. */
let arrived = 0;
const actions = document.getElementById('newday-actions');
const keepButton = document.getElementById('newday-keep');
const freshButton = document.getElementById('newday-fresh');
const goButton = document.getElementById('newday-go');

export function initNewDay() {
  keepButton.addEventListener('click', keep);
  goButton.addEventListener('click', keep);
  freshButton.addEventListener('click', startFresh);
  endButton.addEventListener('click', endYesterday);
  dialog.addEventListener('cancel', markToday); // Escape means "keep"

  check();
  // The app may have been left open overnight; say hello when the user comes back to it.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
}

function check() {
  arriveTomorrow(); // left open overnight: today's notes come over now
  arrived += takeArrived();
  if (dialog.open || document.querySelector('.sweep')) return;
  if (isNewDay()) { ask(); return; }
  // not a new day for the card, but some notes just came over: say so quietly
  if (arrived) { showToast(t(arrived === 1 ? 'arrivedOne' : 'arrivedMany', { n: arrived }), null, '', 'later'); arrived = 0; }
}

function ask() {
  const now = new Date();
  dateLine.textContent = formatDay(now);
  greetingLine.textContent = greeting(now);
  arrivedLine.hidden = !arrived;
  arrivedLine.textContent = arrived ? t(arrived === 1 ? 'arrivedOne' : 'arrivedMany', { n: arrived }) : '';
  arrived = 0;

  // Yesterday's finished notes, still waiting for their sweep.
  const finished = doneBeforeToday().length;
  yesterdayBox.hidden = finished === 0;
  doneLine.textContent = t(finished === 1 ? 'yesterdayOpenOne' : 'yesterdayOpen', { n: finished });

  // Notes left from before: keep them or start fresh. None: just start the day.
  const { notes, later } = getState();
  const leftovers = notes.length + later.length > 0;
  question.hidden = !leftovers;
  actions.hidden = !leftovers;
  goButton.hidden = leftovers;

  if (!dialog.open) dialog.showModal();
  (leftovers ? keepButton : goButton).focus();
}

/** Run yesterday's sweep, then come back to the card for the rest. */
async function endYesterday() {
  const items = [...doneBeforeToday()];
  if (!items.length) return;
  dialog.close();
  await endTheDay({ items, yesterday: true });
  ask();
}

function keep() {
  markToday();
  dialog.close();
}

function startFresh() {
  clearAll();
  dialog.close();
  offerUndo(t('wallCleared'), 'sweep');
}
