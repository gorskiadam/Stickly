// capture.js — the capture bar: the one place new notes come from.
//
// Type the task and press Enter: it goes straight onto the wall, with no time
// (unless you typed one, like "… 10m"). Shift+Enter adds a line.
// Want a time? Press Tab instead (or tap the clock), and a second step appears:
//   The text slides away and a row of lengths slides in (None, 5 min … 2 h).
//      ← → move between them, ↑ ↓ fine-tune by 5 minutes (Shift: 1), digits
//      type a number, Backspace means "no time". The line above says when it
//      would be done if started now. Enter adds the note; Esc goes back.
// On the Tomorrow view, what's added is put aside for tomorrow instead.
// Pasting several lines skips step 2: each line becomes its own note at once.

import { addNotes, MINUTES_MAX } from './store.js';
import { formatClock, nowMinutes } from './time.js';
import { dropIn } from './ui.js';
import { bumpPile } from './later.js';
import { announce, isTyping, showToast } from './feedback.js';
import { spring, SPRINGS } from './motion.js';
import { splitLines, splitSpoken, takeDuration } from './parse.js';
import { createDictation, speechSupported } from './speech.js';
import { t, getLang, getSpeechLocale, formatMinutes } from './strings.js';

/** The bar grows with its text up to this height (about four lines). */
const MAX_INPUT_HEIGHT = 126;
/** Where the time picker starts when the text says nothing about time. */
const DEFAULT_MINUTES = 15;
/** The lengths offered as chips (0 = no time). */
const PRESETS = [0, 5, 15, 30, 45, 60, 90, 120];
/** ↑ / ↓ change the time by this much (Shift: 1 minute). */
const TUNE_STEP = 5;
/** Delay between notes settling when several arrive at once. */
const STAGGER_MS = 70;
/** The fill line under the picker is full at this many minutes. */
const FILL_FULL_AT = 60;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const form = document.getElementById('capture');
const field = document.getElementById('capture-field');
const textStep = document.getElementById('step-text');
const timeStep = document.getElementById('step-time');
const input = document.getElementById('capture-input');
const mic = document.getElementById('mic');
const timeOpen = document.getElementById('time-open');
const timeOpenLabel = document.getElementById('time-open-label');
const textAdd = document.getElementById('text-add');
const taskPreview = document.getElementById('time-task');
const picker = document.getElementById('time-picker');
const presetsEl = document.getElementById('time-presets');
const endsEl = document.getElementById('time-ends');
const lessButton = document.getElementById('time-less');
const moreButton = document.getElementById('time-more');
const addButton = document.getElementById('time-add');

/** The task waiting for its time, and the time chosen so far (0 = no time). */
let pendingText = '';
let minutes = DEFAULT_MINUTES;


/** Digits typed in the picker ("1", "5" → 15), cleared after a short pause. */
let typedDigits = '';
let digitsTimer = 0;

let dictation = null;

export function initCapture() {
  form.addEventListener('submit', (event) => event.preventDefault());
  input.addEventListener('keydown', onTextKey);
  input.addEventListener('input', () => { fitInput(); showHasText(); });
  timeOpen.addEventListener('click', () => askForTime(input.value));
  textAdd.addEventListener('click', () => { addNow(input.value); input.focus({ preventScroll: true }); });
  // Clicking anywhere on the bar's glass puts the cursor in it.
  textStep.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, textarea')) return;
    event.preventDefault();
    input.focus();
  });
  input.addEventListener('paste', onPaste);

  picker.addEventListener('keydown', onPickerKey);
  lessButton.addEventListener('click', () => changeMinutes(-TUNE_STEP));
  moreButton.addEventListener('click', () => changeMinutes(TUNE_STEP));
  presetsEl.addEventListener('click', (event) => {
    const chip = event.target.closest('.time-chip');
    if (!chip) return;
    const value = Number(chip.dataset.minutes);
    setMinutes(value, Math.sign(value - minutes));
    picker.focus({ preventScroll: true });
  });
  addButton.addEventListener('click', () => addPending(minutes || null));

  document.addEventListener('keydown', onShortcut);
  initMic();
  followKeyboard();

  // The autofocus attribute is skipped on some reloads; make sure typing just works.
  input.focus({ preventScroll: true });
}

// ---------- Step 1: the text ----------

/**
 * Enter adds the note right away, with no time; Tab moves on to choose one.
 * Shift+Enter starts a new line inside the note. An empty bar leaves Tab alone,
 * so keyboard users can still move on to the notes.
 */
function onTextKey(event) {
  if (event.isComposing) return;
  if (event.key === 'Tab' && !event.shiftKey && !event.altKey && input.value.trim()) {
    event.preventDefault();
    askForTime(input.value);
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    addNow(input.value);
  } else if (event.key === 'Escape' && !input.value) {
    // Step out of the empty bar, so single-letter shortcuts reach the wall.
    event.preventDefault();
    input.blur();
  }
}

/** Add what was typed straight away. A time typed at the end ("… 10m") is kept. */
function addNow(raw) {
  const { text, minutes: typed } = takeDuration(raw);
  if (!text.trim()) return;
  dictation?.stop();
  capture([{ text, minutes: typed ?? null }]);
  setInput('');
  // The text flows off to the right and the bar is ready again.
  if (!reducedMotion.matches) {
    input.animate(
      [{ transform: 'translateX(-14px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 260, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    );
  }
}

/**
 * The bar shows the Enter / Tab hint, the clock and the add button only once
 * there is something to add. A time typed at the end ("Run 20m") shows up on
 * the clock, so it's clear it was understood.
 */
function showHasText() {
  const has = Boolean(input.value.trim());
  field.classList.toggle('has-text', has);
  timeOpen.hidden = !has;
  textAdd.hidden = !has;
  const typed = has ? takeDuration(input.value).minutes : null;
  // "Run 20m" shows "20 min" on the clock
  const label = typed ? formatMinutes(typed) : '';
  timeOpenLabel.textContent = label;
  timeOpen.classList.toggle('has-time', Boolean(label));
}

/** Take the typed task to step 2. A time typed at the end ("… 10m") is used as the start. */
function askForTime(raw) {
  const { text, minutes: typed } = takeDuration(raw);
  if (!text.trim()) return;
  dictation?.stop();

  pendingText = text;
  taskPreview.textContent = text.replace(/\s*\n\s*/g, ' · ');
  setMinutes(typed ?? DEFAULT_MINUTES, 0);
  slide(textStep, timeStep, 1);
  picker.focus({ preventScroll: true });
  announce(t('howLong'));
}

function setInput(text) {
  input.value = text;
  fitInput();
  showHasText();
}

/** Grow or shrink the bar to fit what has been typed. */
function fitInput() {
  input.style.height = '';
  const needed = input.scrollHeight;
  if (needed > input.offsetHeight + 1) input.style.height = `${Math.min(needed, MAX_INPUT_HEIGHT)}px`;
  input.style.overflowY = needed > MAX_INPUT_HEIGHT ? 'auto' : '';
}

/** Pasting several lines is a brain dump: each line becomes its own note, no times asked. */
function onPaste(event) {
  const pasted = event.clipboardData.getData('text/plain');
  if (!/\n/.test(pasted.trim())) return; // a single line pastes normally

  event.preventDefault();
  const before = input.value.slice(0, input.selectionStart);
  const after = input.value.slice(input.selectionEnd);
  const items = splitLines(before + pasted + after).map(toItem);
  if (capture(items)) setInput('');
}

// ---------- Step 2: the time ----------

function onPickerKey(event) {
  const fine = event.shiftKey ? 1 : TUNE_STEP;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    changeMinutes(event.key === 'ArrowUp' ? fine : -fine);
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    stepPreset(event.key === 'ArrowRight' ? 1 : -1);
  } else if (event.key === 'PageUp' || event.key === 'PageDown') {
    event.preventDefault();
    changeMinutes(event.key === 'PageUp' ? 30 : -30);
  } else if (/^\d$/.test(event.key)) {
    event.preventDefault();
    typeDigit(event.key);
  } else if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    setMinutes(0, -1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    addPending(minutes || null);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    backToText();
  }
}

function changeMinutes(delta) {
  setMinutes(minutes + delta, Math.sign(delta));
}

/** ← / →: to the next chip that way, from wherever the time is now. */
function stepPreset(direction) {
  const next = direction > 0
    ? PRESETS.find((p) => p > minutes) ?? PRESETS.at(-1)
    : [...PRESETS].reverse().find((p) => p < minutes) ?? 0;
  setMinutes(next, direction);
}

/** Typing "2" then "5" quickly sets 25 minutes. */
function typeDigit(digit) {
  clearTimeout(digitsTimer);
  typedDigits = (typedDigits + digit).slice(-3);
  digitsTimer = setTimeout(() => { typedDigits = ''; }, 900);
  const value = Number(typedDigits);
  setMinutes(value, Math.sign(value - minutes));
}

/** A length's short name on a chip: "15 min", "1 h", "1½ h". */
function chipLabel(value) {
  if (!value) return t('noTime');
  if (value < 60) return t('minutesShort', { n: value });
  if (value % 60 === 30) return `${Math.floor(value / 60)}½ h`;
  if (value % 60 === 0) return `${value / 60} h`;
  return formatMinutes(value);
}

/** Draw the chips: the presets, plus the chosen length if it's in between. */
function drawChips(direction) {
  const values = PRESETS.includes(minutes) ? PRESETS : [...PRESETS, minutes].sort((a, b) => a - b);
  const chips = values.map((value) => {
    const chip = presetsEl.querySelector(`[data-minutes="${value}"]`) || Object.assign(document.createElement('button'), {
      type: 'button', tabIndex: -1, className: 'time-chip',
    });
    chip.dataset.minutes = String(value);
    chip.textContent = chipLabel(value);
    chip.classList.toggle('is-custom', !PRESETS.includes(value));
    chip.setAttribute('aria-pressed', String(value === minutes));
    return chip;
  });
  presetsEl.replaceChildren(...chips);
  const chosen = presetsEl.querySelector('[aria-pressed="true"]');
  if (!chosen) return;
  // the chosen chip stays in view on a narrow bar
  chosen.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  if (direction && !reducedMotion.matches) {
    chosen.animate([{ transform: 'scale(0.9)' }, { transform: 'scale(1)' }], spring(SPRINGS.pop));
  }
}

/** Show a new length; `direction` (+1 / −1 / 0) is which way it moved. */
function setMinutes(value, direction) {
  minutes = Math.max(0, Math.min(MINUTES_MAX, Math.round(value)));
  const label = minutes ? formatMinutes(minutes) : t('noTime');

  drawChips(direction);
  field.style.setProperty('--fill-ratio', String(Math.min(minutes / FILL_FULL_AT, 1)));
  picker.setAttribute('aria-valuenow', String(minutes));
  picker.setAttribute('aria-valuetext', label);
  lessButton.disabled = minutes === 0;
  moreButton.disabled = minutes === MINUTES_MAX;
  showEnds();
}

/** The line above the chips: when it would be done if started now. */
function showEnds() {
  if (document.body.dataset.view === 'tomorrow') { endsEl.textContent = t('forTomorrow'); return; }
  endsEl.textContent = minutes ? t('doneBy', { time: formatClock(nowMinutes() + minutes) }) : t('openEnded');
}

/** Add the waiting task with this many minutes (or null), and reset the bar. */
function addPending(chosen) {
  if (!pendingText) return;
  capture([{ text: pendingText, minutes: chosen }]);
  pendingText = '';
  setInput('');
  slide(timeStep, textStep, 1); // the task flows on to the right, the bar is ready again
  input.focus({ preventScroll: true });
}

/** Esc: back to the text, keeping what was typed. */
function backToText() {
  pendingText = '';
  slide(timeStep, textStep, -1);
  input.focus({ preventScroll: true });
}

/**
 * Swap the visible step. The old one slides out in `direction` (1 = right)
 * while the new one slides in behind it from the other side.
 */
function slide(from, to, direction) {
  const duration = reducedMotion.matches ? 0 : 1;
  from.inert = true;
  to.inert = false;
  to.hidden = false;
  field.dataset.step = to === timeStep ? 'time' : 'text';

  from.getAnimations().forEach((a) => a.cancel());
  to.getAnimations().forEach((a) => a.cancel());
  from.animate(
    [{ transform: 'none', opacity: 1 }, { transform: `translateX(${direction * 72}px)`, opacity: 0 }],
    { duration: 240 * duration, easing: 'cubic-bezier(0.4, 0, 0.7, 0.2)', fill: 'forwards' },
  ).finished.then(() => {
    if (!from.inert) return; // it came back in the meantime
    from.hidden = true;
    from.getAnimations().forEach((a) => a.cancel());
  }, () => {});
  to.animate(
    [{ transform: `translateX(${direction * -40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 320 * duration, delay: 80 * duration, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' },
  );
}

// ---------- Adding ----------

/** Create notes and show where each one went. Returns false if there was nothing to add. */
function capture(items) {
  const forTomorrow = document.body.dataset.view === 'tomorrow';
  const added = addNotes(items, { tomorrow: forTomorrow });
  if (!added.length) return false;
  if (forTomorrow) {
    announce(added.length > 1 ? t('notesAdded', { n: added.length }) : t('addedTomorrow'));
    return true;
  }

  const onWall = added.filter((a) => a.place === 'wall');
  onWall.forEach((a, i) => dropIn(a.note.id, i * STAGGER_MS));
  if (onWall.length < added.length) bumpPile();

  if (added.length > 1) announce(t('notesAdded', { n: added.length }));
  else announce(t(onWall.length ? 'noteAdded' : 'addedToLater'));
  return true;
}

/** One typed line → a note: its text, and its time if one was typed at the end. */
const toItem = (line) => takeDuration(line);

/** `N` or `/` anywhere jumps to the capture bar. */
function onShortcut(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
  if (field.dataset.step === 'time') return; // the picker is using the keyboard
  if (event.key === '/' || event.key.toLowerCase() === 'n') {
    event.preventDefault();
    input.focus();
  }
}

// ---------- Phone keyboard ----------

/**
 * On phones the on-screen keyboard can cover a bar fixed to the bottom.
 * Measure how much of the page it hides and lift the bar by that much
 * (CSS reads --keyboard).
 */
function followKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const update = () => {
    const zoomed = viewport.scale > 1.01; // pinch-zoom also shrinks the viewport
    const hidden = zoomed ? 0 : window.innerHeight - viewport.height - viewport.offsetTop;
    document.documentElement.style.setProperty('--keyboard', `${Math.max(0, Math.round(hidden))}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
}

// ---------- Voice ----------

const MIC_ERRORS = { denied: 'micDenied', network: 'micNetwork', 'no-mic': 'micMissing', failed: 'micFailed' };

/**
 * The mic only exists where the browser can dictate. Tap it and say the task:
 * the words appear in the bar as you speak, then it moves on to the time.
 * Saying "and then" between tasks adds them all at once instead.
 */
function initMic() {
  if (!speechSupported()) return;

  dictation = createDictation({
    getLocale: getSpeechLocale,
    onInterim: (text) => { if (text) setInput(text); },
    onFinal: (text) => {
      const pieces = splitSpoken(text, getLang());
      if (pieces.length > 1) {
        setInput('');
        capture(pieces.map(toItem));
      } else if (pieces.length === 1) {
        setInput(pieces[0]);
        askForTime(pieces[0]);
      }
    },
    onChange: showListening,
    onError: (kind) => showToast(t(MIC_ERRORS[kind] || 'micFailed')),
  });

  mic.hidden = false;
  field.classList.add('has-mic');
  mic.addEventListener('click', () => {
    input.focus({ preventScroll: true });
    dictation.toggle();
  });
}

function showListening(listening) {
  field.classList.toggle('is-listening', listening);
  mic.setAttribute('aria-pressed', String(listening));
  mic.setAttribute('aria-label', t(listening ? 'stopDictating' : 'dictate'));
  input.placeholder = t(listening ? 'listening' : 'capturePlaceholder');
}
