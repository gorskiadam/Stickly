// whatnow.js — the "What now?" chip in the top bar, and the page's
// single-key shortcuts: W what now, T tidy up, E end the day, B the trash,
// , settings (N for a new note lives in capture.js; V switches between
// Wall, Today and Tomorrow in days.js).
//
// For when you freeze in front of a full wall. It doesn't just roll a dice:
// it looks at the day and picks the note that makes most sense right now,
// and says why, in a small card under the chip. It reads times written in
// the notes ("gym at 6"), words that sound urgent, pins, how long a note has
// waited, what fits before the next timed note, and the time of day (see
// rank()). Another goes down the list, and the ones passed over wait their
// turn for a while; Focus opens the note in the Focus view.

import { getState, subscribe, doneItems } from './store.js';
import { highlightNote, tidyWall } from './ui.js';
import { endTheDay } from './sweep.js';
import { announce, isTyping } from './feedback.js';
import { spring, SPRINGS } from './motion.js';
import { pick } from './sound.js';
import { t, formatMinutes, getLang } from './strings.js';
import { nowMinutes, formatClock, todayKey, uses12h } from './time.js';

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
  const passed = ranked[at]?.note.id;
  if (passed) skipped.set(passed, { count: (skipped.get(passed)?.count || 0) + 1, at: Date.now() });
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

/** Notes passed over with Another lately: id → { count, at }. Asked again
 *  within two hours, they wait their turn behind the rest. */
const skipped = new Map();
const SKIP_MEMORY_MS = 2 * 60 * 60 * 1000;

/**
 * Every wall note, best first, each with the reason it's suggested.
 *
 * Each note collects signals (points and a reason): a time written in it
 * that's coming up or just went by, words that sound urgent, a pin, the days
 * it has waited, whether it fits in the gap before the next timed note, and
 * how it suits the time of day (big ones in the morning, light ones in the
 * evening). The strongest signal gives the reason; the others add a little.
 */
function rank() {
  const { notes } = getState();
  const now = nowMinutes();
  const hour = Math.floor(now / 60);
  const doneToday = doneItems().length;
  const today = todayKey();
  const timed = notes.map((note) => ({ note, at: clockIn(note.text, now) })).filter((x) => x.at != null);
  // the next timed note still ahead (within the next two hours): a gap to fill
  const next = timed.filter((x) => x.at - now > 15 && x.at - now <= 120).sort((a, b) => a.at - b.at)[0];
  // in a pile, only the note on top is in reach
  const tops = new Map();
  for (const n of notes) if (n.pile && (!tops.has(n.pile) || n.z > tops.get(n.pile).z)) tops.set(n.pile, n);

  const scored = notes.map((note) => {
    const signals = [];
    const add = (points, key, vars) => signals.push({ points, key, vars });
    const ageDays = (Date.now() - note.createdAt) / 86_400_000;
    const at = timed.find((x) => x.note === note)?.at ?? null;

    if (at != null) {
      const until = at - now;
      if (until >= -10 && until <= 10) add(100, 'whyNow', { time: formatClock(at) });
      else if (until > 10 && until <= 90) add(92, 'whySoon', { time: formatClock(at), mins: formatMinutes(until) });
      else if (until < -10 && until >= -180) add(82, 'whyMissed', { time: formatClock(at) });
      else if (until > 90) add(5, 'whyLaterToday', { time: formatClock(at) }); // later today: not yet
    }
    if (URGENT.test(note.text)) add(72, 'whyUrgent');
    if (note.pinned) add(64, 'whyPinned');
    if (note.arrivedOn === today) add(56, 'whyPlanned');
    if (ageDays >= 2) add(44 + Math.min(16, ageDays * 2), 'whyWaiting', { since: since(note.createdAt) });
    if (next && next.note !== note && note.minutes && note.minutes <= next.at - now - 5) {
      add(66, 'whyFits', { text: short(next.note.text), length: formatMinutes(note.minutes) });
    }
    if (note.minutes) {
      const morning = hour >= 5 && hour < 12;
      const evening = hour >= 18 || hour < 5;
      if (morning && note.minutes >= 45) add(40, 'whyFresh2');
      if (evening && note.minutes <= 20) add(42, 'whyEvening');
      if (evening && note.minutes > 60) add(-14, null);
      if (note.minutes <= 15) add(doneToday ? 30 : 38, doneToday ? 'whyQuick' : 'whyStart', { length: formatMinutes(note.minutes) });
    }
    if (note.pile && tops.get(note.pile) !== note) add(-8, null);
    const skip = skipped.get(note.id);
    if (skip && Date.now() - skip.at < SKIP_MEMORY_MS) add(-12 * skip.count, null);

    const reasons = signals.filter((x) => x.key).sort((a, b) => b.points - a.points);
    const best = reasons[0];
    const penalties = signals.filter((x) => !x.key).reduce((sum, x) => sum + x.points, 0);
    const extra = reasons.slice(1).reduce((sum, x) => sum + x.points * 0.15, 0);
    const score = (best?.points ?? 20) + extra + penalties + Math.random() * 3; // a little chance, so it never feels canned
    let why = best ? t(best.key, best.vars) : t('whyFresh');
    // say how long it takes, when the reason doesn't already
    if (note.minutes && !SAYS_LENGTH.has(best?.key)) why += ` · ${formatMinutes(note.minutes)}`;
    return { note, why, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/** Reasons that already say how long the note takes, or are about the clock (two times would muddle it). */
const SAYS_LENGTH = new Set(['whyQuick', 'whyStart', 'whyFits', 'whyNow', 'whySoon', 'whyMissed']);

/** Words that mean it can't wait (English and Polish). */
const URGENT = /(?<!\p{L})(urgent|asap|a\.s\.a\.p|today|tonight|deadline|due|overdue|before \d|pilne|pilnie|dziś|dzisiaj|na dziś|termin|na już|zaraz)(?!\p{L})|!{1,}\s*$/iu;

/**
 * A time written in a note, as minutes after midnight today: "at 6",
 * "6:30 pm", "18:00", "noon", "o 18", "o 7:30", "w południe". A bare "at 6"
 * on a 12-hour clock means the evening (1 to 7 o'clock), the morning from 8 to 11.
 */
export function clockIn(text, now = nowMinutes()) {
  const s = String(text).toLowerCase();
  if (/(?<!\p{L})(noon|midday|południe|w południe)(?!\p{L})/u.test(s)) return 12 * 60;
  let m = s.match(/(?<![\d:])(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?!\p{L})/u)
    || s.match(/(?<!\p{L})(?:at|@|by|o|na|około|ok\.)\s*(\d{1,2})(?:[:.](\d{2}))?(?![\d\p{L}%])/u)
    || s.match(/(?<![\d:.])(\d{1,2})[:](\d{2})(?![\d])/u);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const half = m[3] ? m[3][0] : null;
  if (h > 23 || min > 59) return null;
  if (half === 'p' && h < 12) h += 12;
  else if (half === 'a' && h === 12) h = 0;
  else if (!half && h >= 1 && h <= 7 && uses12h()) h += 12; // on a 12-hour clock, "gym at 6" is an evening
  return h * 60 + min;
}

/** A note's text, cut short to fit in a reason. */
function short(text) {
  const one = text.split('\n')[0].trim();
  return one.length > 26 ? `${one.slice(0, 25).trimEnd()}…` : one;
}

/** "Monday", or "Nov 12" for longer ago. */
function since(time) {
  const locale = getLang() === 'pl' ? 'pl-PL' : 'en-US';
  const days = (Date.now() - time) / 86_400_000;
  return new Intl.DateTimeFormat(locale, days < 6 ? { weekday: 'long' } : { month: 'short', day: 'numeric' }).format(new Date(time));
}
