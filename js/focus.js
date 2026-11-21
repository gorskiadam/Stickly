// focus.js — the Focus view: one note, large, with a timer, and nothing else.
// For the moment when the whole wall is still too much to look at.
//
// It covers the whole window, and (unless turned off in Settings) the whole
// screen too: the browser's real full screen, so nothing else is in sight.
// F switches full screen on and off. ← and → move to the other notes on the
// wall without leaving; the line at the bottom says what's up next.
//
// A note with a time counts down from it (and chimes at zero, then keeps
// counting the overtime); a note without one counts up. Space starts and
// pauses. Each note keeps its own timer while the app is open, so stepping
// back to the wall and returning picks up where it left off.

import { getState, findNote } from './store.js';
import { spring, SPRINGS } from './motion.js';
import { completeNote } from './ui.js';
import { chime } from './sound.js';
import { announce } from './feedback.js';
import { t, formatMinutes } from './strings.js';
import { isTyping } from './feedback.js';

const dialog = document.getElementById('focus');
const noteEl = document.getElementById('focus-note');
const clockEl = document.getElementById('timer-clock');
const labelEl = document.getElementById('timer-label');
const fillEl = document.getElementById('timer-fill');
const toggleButton = document.getElementById('timer-toggle');
const doneButton = document.getElementById('focus-done');
const closeButton = document.getElementById('focus-close');
const fullButton = document.getElementById('focus-full');
const prevButton = document.getElementById('focus-prev');
const nextButton = document.getElementById('focus-next');
const whenLine = document.getElementById('focus-when');
const positionLine = document.getElementById('focus-position');
const upNextLine = document.getElementById('focus-up-next');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const canFullscreen = Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen);

/** Did the Focus view turn full screen on (so it should turn it off again)? */
let wentFullscreen = false;

const APP_TITLE = document.title;

/** Timers by note id: { totalMs (or null), elapsedMs, startedAt (or null), chimed }. */
const timers = new Map();

let currentId = null;
let tickTimer = 0;

export function initFocus() {
  // ui.js asks for the view with this event (F on a note, or its focus button).
  document.addEventListener('stickly:focus', (event) => open(event.detail.id));
  toggleButton.addEventListener('click', toggle);
  doneButton.addEventListener('click', finish);
  closeButton.addEventListener('click', () => dialog.close());
  fullButton.addEventListener('click', toggleFullscreen);
  prevButton.addEventListener('click', () => turn(-1));
  nextButton.addEventListener('click', () => turn(1));
  dialog.addEventListener('close', onClose);
  dialog.addEventListener('keydown', onKey);
  fullButton.hidden = !canFullscreen;
  document.addEventListener('fullscreenchange', () => {
    dialog.classList.toggle('is-fullscreen', Boolean(document.fullscreenElement));
    fullButton.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
  });
}

function open(id) {
  const note = findNote(id);
  if (!note) return;
  const already = dialog.open;
  show(note);
  if (already) return;
  dialog.showModal();
  toggleButton.focus();
  if (getState().settings.focusFullscreen && canFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => { wentFullscreen = true; }, () => { /* not allowed right now: the window will do */ });
  }
}

/** Put a note in the middle, with its own timer. */
function show(note) {
  currentId = note.id;
  noteEl.textContent = note.text;
  noteEl.dataset.color = note.color;

  const totalMs = note.minutes ? note.minutes * 60000 : null;
  const timer = timers.get(note.id);
  // A new timer, or the note's time was changed since: start over.
  if (!timer || timer.totalMs !== totalMs) {
    timers.set(note.id, { totalMs, elapsedMs: 0, startedAt: null, chimed: false });
  }
  // where it is on the wall
  whenLine.textContent = '';
  const wall = getState().notes;
  const index = wall.findIndex((n) => n.id === note.id);
  positionLine.textContent = index >= 0 && wall.length > 1 ? t('focusPosition', { i: index + 1, n: wall.length }) : '';
  prevButton.hidden = nextButton.hidden = !(index >= 0 && wall.length > 1);
  upNextLine.textContent = upNext(note);
  render();
}

/** "Up next: Call the dentist" — the next note on the wall. */
function upNext(note) {
  const wall = getState().notes;
  const index = wall.findIndex((n) => n.id === note.id);
  const after = wall[(index + 1) % wall.length];
  return after && after.id !== note.id ? t('upNext', { text: after.text.split('\n')[0] }) : '';
}

/** ← / →: the previous or next note on the wall, sliding in from that side. */
function turn(direction) {
  const wall = getState().notes;
  if (wall.length < 2) return;
  const timer = timers.get(currentId);
  if (timer?.startedAt) pause(timer); // the one left behind waits
  const index = wall.findIndex((n) => n.id === currentId);
  const next = wall[(index + direction + wall.length) % wall.length];
  show(next);
  if (!reducedMotion.matches) {
    noteEl.animate(
      [{ transform: `translateX(${direction * 60}px) rotate(${direction * 3 - 1}deg)`, opacity: 0 }, { transform: 'rotate(-1deg)', opacity: 1 }],
      spring(SPRINGS.settle),
    );
  }
}

function toggleFullscreen() {
  if (!canFullscreen) return;
  if (document.fullscreenElement) {
    wentFullscreen = false;
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => { wentFullscreen = true; }, () => {});
  }
}

/**
 * Space starts or pauses (unless a button has focus, which handles it).
 * ← → other notes, D done, F full screen.
 */
function onKey(event) {
  if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === ' ' && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault();
    toggle();
  } else if (key === 'arrowleft' || key === 'arrowright') {
    event.preventDefault();
    turn(key === 'arrowright' ? 1 : -1);
  } else if (key === 'd') {
    event.preventDefault();
    finish();
  } else if (key === 'f') {
    event.preventDefault();
    toggleFullscreen();
  }
}

function toggle() {
  const timer = timers.get(currentId);
  if (!timer) return;
  if (timer.startedAt) pause(timer);
  else timer.startedAt = Date.now();
  render();
}

function pause(timer) {
  timer.elapsedMs = elapsed(timer);
  timer.startedAt = null;
}

function elapsed(timer) {
  return timer.elapsedMs + (timer.startedAt ? Date.now() - timer.startedAt : 0);
}

/** Leaving the view pauses its timer. */
function onClose() {
  const timer = timers.get(currentId);
  if (timer?.startedAt) pause(timer);
  clearInterval(tickTimer);
  tickTimer = 0;
  document.title = APP_TITLE;
  if (wentFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  wentFullscreen = false;
}

/** Close the view, then let the note fly off the wall behind it. */
function finish() {
  const id = currentId;
  dialog.close();
  timers.delete(id);
  completeNote(id);
}

// ---------- Drawing ----------

function render() {
  const timer = timers.get(currentId);
  if (!timer) return;

  const running = Boolean(timer.startedAt);
  const spent = elapsed(timer);
  const { totalMs } = timer;
  const left = totalMs === null ? null : totalMs - spent;

  clockEl.textContent = totalMs === null
    ? clock(spent)
    : (left < 0 ? `+${clock(-left)}` : clock(left));
  dialog.classList.toggle('is-over', left !== null && left < 0);
  dialog.classList.toggle('is-running', running);
  fillEl.style.width = totalMs ? `${Math.min(spent / totalMs, 1) * 100}%` : '0%';
  labelEl.textContent = totalMs ? t('timerOf', { time: formatMinutes(totalMs / 60000) }) : t('timerOpen');
  toggleButton.textContent = t(running ? 'timerPause' : (spent > 0 ? 'timerResume' : 'timerStart'));

  // The tab title shows the time, so it can be seen from another tab.
  document.title = running ? `${clockEl.textContent} · ${APP_TITLE}` : APP_TITLE;

  if (left !== null && left <= 0 && !timer.chimed) {
    timer.chimed = true;
    chime();
    announce(t('timesUp'));
  }

  if (running && !tickTimer) tickTimer = setInterval(render, 250);
  if (!running && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = 0;
  }
}

/** 312000 → "05:12"; an hour or more → "1:05:12". */
function clock(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
