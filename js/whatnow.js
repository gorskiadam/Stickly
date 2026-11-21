// whatnow.js — the "What now?" chip in the top bar, and the page's
// single-key shortcuts: W what now, T tidy up, E end the day, B the trash,
// , settings (N for a new note lives in capture.js; V switches between
// Wall, Today and Tomorrow in days.js).
//
// For when you freeze in front of a full wall. It doesn't just roll a dice:
// it looks at the day and picks the note that makes most sense right now,
// and says why, in a small card under the chip:
//   1. a pinned note;
//   2. the note that has waited longest (two days or more);
//   3. a quick win (15 minutes or less);
//   4. otherwise any note, for a fresh start.
// Another goes down the list; Focus opens the note in the Focus view.

import { getState, subscribe, doneItems } from './store.js';
import { highlightNote, tidyWall } from './ui.js';
import { endTheDay } from './sweep.js';
import { announce, isTyping } from './feedback.js';
import { spring, SPRINGS } from './motion.js';
import { pick } from './sound.js';
import { t, formatMinutes, getLang } from './strings.js';

const button = document.getElementById('what-now');
const endDayButton = document.getElementById('end-day');
const donePanel = document.getElementById('done-panel');
const card = document.getElementById('whatnow-card');
const textLine = document.getElementById('whatnow-text');
const whyLine = document.getElementById('whatnow-why');
const startButton = document.getElementById('whatnow-start');
const anotherButton = document.getElementById('whatnow-another');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** The ranked suggestions for this opening of the card, and where we are in them. */
let ranked = [];
let at = 0;

export function initWhatNow() {
  // Worth offering once there is something to choose between.
  const render = (state) => { button.hidden = state.notes.length < 1; };
  subscribe(render);
  render(getState());

  button.addEventListener('click', () => (card.matches(':popover-open') ? another() : askWhatNow()));
  startButton.addEventListener('click', start);
  anotherButton.addEventListener('click', another);
  endDayButton.addEventListener('click', () => {
    if (donePanel.matches(':popover-open')) donePanel.hidePopover();
    endTheDay();
  });
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    if (document.querySelector('dialog[open], .sweep')) return;
    if (document.querySelector('#menu:popover-open')) return; // the menu has the keyboard
    const key = event.key.toLowerCase();
    if (key === 'w') { event.preventDefault(); card.matches(':popover-open') ? another() : askWhatNow(); }
    else if (key === 't') {
      if (document.body.dataset.view && document.body.dataset.view !== 'wall') return; // the wall isn't on show
      event.preventDefault();
      tidyWall();
    }
    else if (key === 'e' && !event.shiftKey) {
      if (!doneItems().length) return;
      event.preventDefault();
      if (donePanel.matches(':popover-open')) donePanel.hidePopover();
      endTheDay();
    } else if (key === 'b') {
      event.preventDefault();
      document.getElementById('trash').click();
    } else if (key === ',') {
      event.preventDefault();
      document.getElementById('settings').togglePopover();
    }
  });
}

/** Open the card with the best pick for right now. */
export function askWhatNow() {
  ranked = rank();
  at = 0;
  if (!ranked.length) return;
  if (!card.matches(':popover-open')) card.showPopover();
  showPick(0);
  startButton.focus({ preventScroll: true });
}

function another() {
  if (!ranked.length) return askWhatNow();
  at = (at + 1) % ranked.length;
  showPick(1);
}

function start() {
  const chosen = ranked[at];
  card.hidePopover();
  if (chosen) document.dispatchEvent(new CustomEvent('stickly:focus', { detail: { id: chosen.note.id } }));
}

/** Show suggestion `at`; `direction` 1 slides the new one in from the right. */
function showPick(direction) {
  const { note, why } = ranked[at];
  textLine.textContent = note.text;
  whyLine.textContent = why;
  anotherButton.hidden = ranked.length < 2;
  pick();
  if (!reducedMotion.matches) {
    const from = direction ? 'translateX(18px)' : 'translateY(-6px) scale(0.97)';
    for (const el of [textLine, whyLine]) {
      el.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], spring(SPRINGS.settle));
    }
  }
  highlightNote(note.id);
  announce(t('whatNowPicked', { text: note.text }) + '. ' + why);
}

/** Every wall note, best first, each with the reason it's suggested. */
function rank() {
  const notes = getState().notes;
  const scored = notes.map((note) => {
    const ageDays = (Date.now() - note.createdAt) / 86_400_000;
    let score = Math.random() * 4; // a little chance, so it never feels canned
    let why = t('whyFresh');
    const consider = (points, reason) => { if (points > score - Math.random() * 4) { score = points + Math.random() * 4; why = reason; } };
    if (note.pinned) consider(50, t('whyPinned'));
    if (ageDays >= 2) consider(40 + Math.min(10, ageDays), t('whyWaiting', { since: since(note.createdAt) }));
    if (note.minutes && note.minutes <= 15) consider(30, t('whyQuick', { length: formatMinutes(note.minutes) }));
    return { note, why, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/** "Monday", or "Nov 12" for longer ago. */
function since(time) {
  const locale = getLang() === 'pl' ? 'pl-PL' : 'en-US';
  const days = (Date.now() - time) / 86_400_000;
  return new Intl.DateTimeFormat(locale, days < 6 ? { weekday: 'long' } : { month: 'short', day: 'numeric' }).format(new Date(time));
}
