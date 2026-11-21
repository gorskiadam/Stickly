// ui.js — the wall: drawing notes and everything you can do to one.
//   1. Setup   2. Rendering + placing   3. Pin, colour, complete, delete
//   4. Taps + editing   5. Keyboard
// Notes sit wherever they were put: x / y on the wall, overlapping if you like.
// Drop one onto another and they stack into a neat pile; click a pile and it
// spreads out so every note shows (6. Piles).

import {
  getState, subscribe, updateNote, removeNote, placeNote, assignPlaces,
  togglePin, setColor, setMinutes, moveToLater, tidyUp, COLORS,
  pileMembers, stackNotes, movePile, unstackPile, removeNotes, moveToTomorrow,
} from './store.js';
import { flyAway, scrollBehavior, spring, SPRINGS } from './motion.js';
import { crumpleShapes, creaseImage } from './paper.js';
import { throwAway, tossTo, trashElement, setTrashOpen, setTrashAwake } from './trash.js';
import { initDrag, dropZoneWidth } from './drag.js';
import { offerUndo, showToast, isTyping } from './feedback.js';
import { whoosh, slap, pinClick, pick, riffle } from './sound.js';
import { t, formatMinutes } from './strings.js';

const wall = document.getElementById('wall');
const emptyLine = document.getElementById('empty');
const captureInput = document.getElementById('capture-input');

/** Note elements by id, reused between renders so animations never restart. */
const noteElements = new Map();

/** After the first render, any note that appears (added, undone, promoted) drops in. */
let firstRenderDone = false;

/** The + and − keys on a note change its time by this many minutes. */
const MINUTES_STEP = 5;

/** Shift+arrow moves a note this many pixels. */
const NUDGE_PX = 24;

/** Taps on the same note closer together than this count as a double / triple tap. */
const TAP_GAP_MS = 380;
/** A double tap waits this long for a third before it opens the editor. */
const EDIT_DELAY_MS = 260;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// 1. Setup ------------------------------------------------------------------

export function initUI() {
  subscribe(render);
  render(getState());

  wall.addEventListener('click', onWallClick);
  // Note shortcuts work on the focused note, or else on the note under the
  // mouse: no need to click it (or right-click it) first.
  document.addEventListener('keydown', onNoteKey);
  wall.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'mouse') hoveredNote = event.target.closest('.note');
  });
  wall.addEventListener('pointerleave', () => { hoveredNote = null; });
  window.addEventListener('resize', () => render(getState()));
  initDrag(wall, {
    onDrop: dropNote,
    onSwipe: (el, dx) => dismiss(el.dataset.id, 'done', dx),
    trash: trashElement(),
    onTrashHover: setTrashOpen,
    onTrash: (el) => {
      const pile = pileOf(el);
      if (pile) throwPile(pile);
      else dismiss(el.dataset.id, 'trash');
    },
    onDragging: setTrashAwake,
    group: carriedWith,
    stackTarget,
    onStackHover: showStackTarget,
    onStack: (el, target) => { if (stackNotes(el.dataset.id, target.dataset.id)) { slap(); settlePile(target); } },
  });
  initSpread();
}

// 2. Rendering --------------------------------------------------------------

function render(state) {
  const { notes, later } = state;
  // Notes that have never been placed get the next free spot first (this
  // re-renders straight away, with everything in place).
  const unplaced = notes.filter((n) => n.x == null || n.y == null);
  if (unplaced.length) {
    assignPlaces(findPlaces(notes, unplaced));
    return;
  }

  const ids = new Set(notes.map((n) => n.id));
  for (const id of noteElements.keys()) {
    if (!ids.has(id)) noteElements.delete(id);
  }

  // Remember where everything is, so notes that moved (undo, nudges, a
  // resized window) glide to their new place instead of jumping.
  const before = new Map([...wall.children].map((el) => [el, [el.offsetLeft, el.offsetTop, el.style.getPropertyValue('--rot')]]));
  const layout = pileLayout(notes);
  const next = notes.map((note) => noteElement(note, layout.get(note.id)));
  const current = [...wall.children];
  if (!sameOrder(current, next)) keepingFocus(() => wall.replaceChildren(...next));
  glide(before);

  wall.hidden = notes.length === 0;
  emptyLine.hidden = notes.length > 0;
  emptyLine.textContent = t(later.length ? 'emptyWithLater' : 'empty');
  fitWall();
  firstRenderDone = true;
}

function keepingFocus(mutate) {
  const focused = document.activeElement;
  mutate();
  if (focused && focused.isConnected && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
  }
}

function glide(before) {
  for (const [el, [x, y, fromRot]] of before) {
    if (!el.isConnected || el.matches('.is-dragging, .is-leaving')) continue;
    const dx = x - el.offsetLeft;
    const dy = y - el.offsetTop;
    const rot = el.style.getPropertyValue('--rot');
    if (!dx && !dy && fromRot === rot) continue;
    // slid by a spring: it gets going, overshoots a hair and settles, like a
    // sheet pushed across the wall. Further to go is a softer spring.
    const far = Math.hypot(dx, dy) > 420;
    const { easing, duration } = spring(far ? { stiffness: 120, damping: 20 } : SPRINGS.glide);
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) rotate(${fromRot || rot})` }, { transform: `rotate(${rot})` }],
      { duration: reducedMotion.matches ? 0 : duration, easing },
    );
  }
}

/** The wall is as tall as the screen, or taller if a note was put further down. */
function fitWall() {
  const lowest = [...wall.children].reduce((max, el) => Math.max(max, el.offsetTop + el.offsetHeight), 0);
  wall.style.minHeight = lowest ? `${Math.max(window.innerHeight, lowest + 140)}px` : '';
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((el, i) => el === b[i]);
}

// ---------- Placing new notes ----------

/** The size of a note right now (it is smaller on phones). */
function noteSize() {
  return parseFloat(getComputedStyle(wall).getPropertyValue('--note-size')) || 196;
}

/**
 * The tidy spots a new note can take: a centred grid like a fresh wall,
 * kept clear of the throw-away strip on the left and the bar at the bottom.
 */
function gridSpots() {
  const size = noteSize();
  const wide = window.innerWidth >= 720;
  const gap = wide ? 40 : 22;
  const left = wide ? dropZoneWidth() + 16 : 16;
  const room = window.innerWidth - left - 16;
  const columns = Math.max(1, Math.min(wide ? 3 : 2, Math.floor((room + gap) / (size + gap))));
  const rows = Math.ceil(getState().settings.limit / columns);
  const width = columns * size + (columns - 1) * gap;
  const height = rows * size + (rows - 1) * gap;
  const x0 = Math.max(left, (window.innerWidth - width) / 2);
  const top = 158; // below the greeting and the date
  const bottom = 150; // the capture bar
  const y0 = Math.max(top, top + (window.innerHeight - top - bottom - height) / 2);

  const spots = [];
  for (let row = 0; row < rows + 2; row++) {
    for (let col = 0; col < columns; col++) {
      spots.push({ x: x0 + col * (size + gap), y: y0 + row * (size + gap) });
    }
  }
  return spots;
}

/** The first grid spot, and the note (other than `id`) sitting on it, if any. */
function firstSpot(id) {
  const spot = gridSpots()[0];
  const size = noteSize();
  const occupant = getState().notes.find((n) => n.id !== id && n.x != null &&
    Math.abs(n.x - spot.x) < size * 0.6 && Math.abs(n.y - spot.y) < size * 0.6);
  return { x: spot.x, y: spot.y, swap: occupant?.id || null };
}

/** First free grid spot for each unplaced note; if all are taken, a gentle cascade. */
function findPlaces(notes, unplaced) {
  const size = noteSize();
  const placed = notes.filter((n) => n.x != null && n.y != null);
  const taken = placed.map((n) => ({ x: n.x, y: n.y }));
  const spots = gridSpots();
  const isFree = (spot) => taken.every((p) => Math.abs(p.x - spot.x) > size * 0.6 || Math.abs(p.y - spot.y) > size * 0.6);
  // a pile takes one spot, all its notes together
  const pileSpots = new Map(placed.filter((n) => n.pile).map((n) => [n.pile, { x: n.x, y: n.y }]));

  return unplaced.map((note, i) => {
    if (note.pile && pileSpots.has(note.pile)) return { id: note.id, ...pileSpots.get(note.pile) };
    const spot = spots.find(isFree) || { x: spots[0].x + 28 * (i + 1), y: spots[0].y + 28 * (i + 1) };
    taken.push(spot);
    if (note.pile) pileSpots.set(note.pile, spot);
    return { id: note.id, ...spot };
  });
}

/** Keep a note on screen if the window got narrower since it was put there. */
function clampX(x) {
  return Math.max(8, Math.min(x, window.innerWidth - noteSize() - 8));
}

function isNote(el) {
  return el.classList.contains('note');
}

/** Get (or build) the element for a note and bring it up to date. */
function noteElement(note, place = null) {
  const el = noteElements.get(note.id) || buildNoteElement(note.id);
  el.style.setProperty('--rot', `${place ? place.rot : note.rot}deg`);
  if (!el.classList.contains('is-dragging')) {
    el.style.left = `${place?.spread ? place.x : clampX(note.x) + (place?.dx || 0)}px`;
    el.style.top = `${place?.spread ? place.y : Math.max(8, note.y) + (place?.dy || 0)}px`;
  }
  el.style.zIndex = String(place?.spread ? place.z : note.z || 0);
  el.classList.toggle('in-pile', Boolean(place));
  el.classList.toggle('is-pile-top', Boolean(place && place.depth === 0 && !place.spread));
  el.classList.toggle('is-spread', Boolean(place?.spread));
  el.dataset.pileDx = place && !place.spread ? place.dx : 0;
  el.dataset.pileDy = place && !place.spread ? place.dy : 0;
  const count = el.querySelector('.pile-count');
  count.hidden = !(place && place.depth === 0 && !place.spread);
  count.textContent = place ? String(place.count) : '';
  el.dataset.color = note.color;
  el.classList.toggle('is-pinned', note.pinned);
  if (!el.classList.contains('is-editing')) {
    el.querySelector('.note-text').textContent = note.text;
  }
  const time = el.querySelector('.note-time');
  time.hidden = !note.minutes;
  time.lastChild.textContent = note.minutes ? formatMinutes(note.minutes) : '';
  labelNote(el, note);
  if (place && place.depth === 0 && !place.spread) {
    el.setAttribute('aria-label', t('pileLabel', { text: el.getAttribute('aria-label'), n: place.count }));
  }
  return el;
}

function buildNoteElement(id) {
  const el = document.createElement('li');
  el.className = 'note';
  el.dataset.id = id;
  el.tabIndex = 0;
  el.setAttribute('aria-describedby', 'note-help');
  // The inner buttons are for pointer and screen-reader users; the keyboard
  // uses D / P / C / F on the focused note, so they stay out of the Tab order.
  el.innerHTML = `
    <div class="note-paper">
      <p class="note-time" hidden aria-hidden="true"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="6" cy="6" r="4.8"/><path d="M6 3.4V6l1.7 1.1"/></svg><span></span></p>
      <p class="note-text"></p>
      <div class="note-foot">
        ${COLORS.map(swatchHtml).join('')}
        <button class="note-focus" type="button" tabindex="-1">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>
        </button>
      </div>
    </div>
    <button class="note-pin" type="button" tabindex="-1">
      <svg viewBox="0 0 32 40" width="32" height="40" aria-hidden="true"><use href="#pin"/></svg>
    </button>
    <button class="note-peel" type="button" tabindex="-1"></button>
    <span class="pile-count" hidden aria-hidden="true"></span>`;

  el.addEventListener('animationend', (event) => {
    if (event.target !== el) return;
    el.classList.remove('is-new');
    el.style.animationDelay = '';
  });
  wireEditing(el);
  noteElements.set(id, el);
  if (firstRenderDone) el.classList.add('is-new');
  return el;
}

function swatchHtml(color) {
  return `<button class="note-swatch" type="button" tabindex="-1" data-color="${color}"></button>`;
}

/** Accessible names, in the current language. */
function labelNote(el, note) {
  const text = note.minutes ? `${note.text}, ${formatMinutes(note.minutes)}` : note.text;
  el.setAttribute('aria-label', note.pinned ? t('pinnedNote', { text }) : text);

  const pin = el.querySelector('.note-pin');
  pin.setAttribute('aria-label', t(note.pinned ? 'unpin' : 'pin'));
  pin.setAttribute('aria-pressed', String(note.pinned));
  el.querySelector('.note-peel').setAttribute('aria-label', t('markDone'));
  el.querySelector('.note-focus').setAttribute('aria-label', t('focus'));

  for (const swatch of el.querySelectorAll('.note-swatch')) {
    const { color } = swatch.dataset;
    swatch.setAttribute('aria-label', t('colorTo', { name: t(`color_${color}`) }));
    swatch.setAttribute('aria-pressed', String(color === note.color));
  }
}

/**
 * Play the soft "settle onto the wall" animation for a note that just arrived.
 * `delay` (ms) staggers several notes arriving together.
 * Returns its element, or null if the note is not on the wall.
 */
export function dropIn(id, delay = 0) {
  const el = noteElements.get(id);
  if (!el) return null;
  el.style.animationDelay = `${delay}ms`;
  el.classList.add('is-new');
  el.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  return el;
}

// 3. Pin, colour, complete, delete ------------------------------------------

function onWallClick(event) {
  const target = event.target;

  const el = target.closest('.note');
  if (!el) return;
  const { id } = el.dataset;
  const swatch = target.closest('.note-swatch');

  // A pile opens up when clicked; its notes are used once they're spread out.
  const pile = pileOf(el);
  if (pile) { openSpread(pile); return; }

  if (target.closest('.note-peel')) dismiss(id, 'done');
  else if (target.closest('.note-pin')) pin(el);
  else if (target.closest('.note-focus')) openFocus(id);
  else if (swatch) setColor(id, swatch.dataset.color);
  else if (!el.matches('.is-editing, .is-leaving')) countTap(el, event);
}

/**
 * Pin or unpin a note. A fresh pin goes in with a click and a small animation,
 * and the note glides to the first spot on the wall (the note that was there
 * swaps into its old place).
 */
function pin(el) {
  const id = el.dataset.id;
  const pinning = !el.classList.contains('is-pinned');
  pinClick(pinning);
  togglePin(id, pinning ? firstSpot(id) : null);
  if (!el.classList.contains('is-pinned')) return;
  el.classList.add('is-pinning');
  setTimeout(() => el.classList.remove('is-pinning'), 300);
}

/** Ask for the one-note Focus view (focus.js listens for this). */
function openFocus(id) {
  document.dispatchEvent(new CustomEvent('stickly:focus', { detail: { id } }));
}

/** Complete a note from outside the wall (used by the Focus view). */
export function completeNote(id) {
  return dismiss(id, 'done');
}

/** Send a wall note to the Later pile: it shrinks and arcs onto the pile. */
async function sendToLater(id) {
  const el = noteElements.get(id);
  const pile = document.getElementById('pile');
  if (!el || el.classList.contains('is-leaving')) return;
  el.classList.add('is-leaving');
  if (el.contains(document.activeElement)) focusNeighbour(el);
  // The pile is hidden while empty; show it first so there is somewhere to land.
  pile.hidden = false;
  await tossTo(el, pile);
  if (moveToLater(id)) offerUndo(t('movedToLater'), 'later');
}

/** Slide every note back into a neat grid (the usual glide does the moving). */
export function tidyWall() {
  tidyUp();
}

/**
 * Point at a note: it comes into view, gets focus and gives a small "this
 * one" wiggle (used by "What now?"). Does nothing while the Day view is up.
 */
export function highlightNote(id) {
  const el = noteElements.get(id);
  if (!el || onOtherView()) return;
  el.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  wiggle(el);
}

/** A gentle "this one" wiggle, lifting the note above its neighbours for a moment. */
function wiggle(el) {
  const rot = parseFloat(el.style.getPropertyValue('--rot')) || 0;
  const r = (d, s = 1) => `rotate(${rot + d}deg) scale(${s})`;
  el.classList.add('is-picked');
  el.animate(
    [
      { transform: r(0) },
      { transform: r(-4, 1.06), offset: 0.15 },
      { transform: r(4, 1.06), offset: 0.32 },
      { transform: r(-3, 1.05), offset: 0.5 },
      { transform: r(2, 1.04), offset: 0.68 },
      { transform: r(-1, 1.02), offset: 0.84 },
      { transform: r(0) },
    ],
    { duration: reducedMotion.matches ? 0 : 900, easing: 'ease-in-out' },
  ).finished.finally(() => setTimeout(() => el.classList.remove('is-picked'), 1600));
}

/**
 * A note pulled out of the bin: it starts as a small crumpled ball and
 * unfolds into a flat note where it was dropped.
 */
export function uncrumple(id) {
  const el = noteElements.get(id);
  if (!el) return;
  el.classList.remove('is-new');
  const rot = el.style.getPropertyValue('--rot');
  const seed = Math.random() * 1e9;
  const shape = crumpleShapes(seed);
  const creases = document.createElement('span');
  creases.className = 'throw-creases';
  creases.style.backgroundImage = creaseImage(seed);
  creases.style.opacity = '1';
  creases.style.borderRadius = 'var(--radius)';
  el.querySelector('.note-paper').append(creases);
  const time = reducedMotion.matches ? 0 : 640;
  // Pulled open in two tugs; the creases stay a moment, then the paper settles flat.
  el.animate([
    { transform: `rotate(${rot}) rotate(-30deg) scale(0.24)`, clipPath: shape.at(1) },
    { transform: `rotate(${rot}) rotate(8deg) scale(0.62, 0.7)`, clipPath: shape.at(0.55), offset: 0.4 },
    { transform: `rotate(${rot}) rotate(4deg) scale(0.66, 0.72)`, clipPath: shape.at(0.5), offset: 0.5 },
    { transform: `rotate(${rot}) rotate(-2deg) scale(1.02)`, clipPath: shape.at(0.12), offset: 0.82 },
    { transform: `rotate(${rot})`, clipPath: shape.at(0) },
  ], { duration: time, easing: 'cubic-bezier(0.3, 0.6, 0.3, 1)' });
  creases.animate([{ opacity: 1 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0 }], { duration: time * 1.6, fill: 'forwards' })
    .finished.finally(() => creases.remove());
  slap();
}

/** Everything the right-click menu can do to a note (see menu.js). */
export const noteActions = {
  edit: (id) => { const el = noteElements.get(id); if (el) startEdit(el); },
  done: (id) => dismiss(id, 'done'),
  focus: (id) => openFocus(id),
  pin: (id) => { const el = noteElements.get(id); if (el) pin(el); },
  nudge: (id, direction) => nudgeMinutes(id, direction),
  later: (id) => sendToLater(id),
  remove: (id) => dismiss(id, 'delete'),
  tomorrow: (id) => sendToTomorrow(id),
};

/** Is Today or Tomorrow showing (so the wall is out of sight)? */
function onOtherView() {
  const view = document.body.dataset.view;
  return Boolean(view) && view !== 'wall';
}

/**
 * Put a note aside for tomorrow: on the wall it shrinks and arcs up onto the
 * Tomorrow tab in the top bar; it comes back onto the wall tomorrow morning.
 */
export async function sendToTomorrow(id) {
  const el = noteElements.get(id);
  const tab = document.querySelector('#view-switch [data-view="tomorrow"]');
  if (el && !onOtherView() && !el.classList.contains('is-leaving') && tab) {
    el.classList.add('is-leaving');
    if (el.contains(document.activeElement)) focusNeighbour(el);
    await tossTo(el, tab);
    tab.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: reducedMotion.matches ? 0 : 320, easing: 'ease-out' });
  }
  if (moveToTomorrow(id)) offerUndo(t('movedToTomorrow'), 'later');
}


/**
 * Take a note off the wall and offer undo.
 * kind 'done'   curls it up and lets it fly away (fromX continues a swipe);
 *      'delete' and 'trash' crumple it into a ball and throw it in the bin.
 */
async function dismiss(id, kind, fromX = 0) {
  const el = noteElements.get(id);
  // Not on show (in Later, or Today / Tomorrow is up): no animation, just do it.
  if (!el || onOtherView()) {
    if (removeNote(id, { done: kind === 'done' })) offerUndo(t(kind === 'done' ? 'done' : 'deleted'), kind === 'done' ? 'done' : 'trash');
    return;
  }
  if (el.classList.contains('is-leaving')) return;

  el.classList.add('is-leaving');
  if (el.contains(document.activeElement)) focusNeighbour(el);
  if (kind === 'done') whoosh(fromX < 0 ? -1 : 1);
  const leave = { done: () => flyAway(el, fromX), delete: () => throwAway(el), trash: () => throwAway(el) };
  await leave[kind]();

  if (removeNote(id, { done: kind === 'done' })) offerUndo(t(kind === 'done' ? 'done' : 'deleted'), kind === 'done' ? 'done' : 'trash');
}

/** Give a note more or less time with + and −. Below 5 minutes it has no time. */
function nudgeMinutes(id, direction) {
  const note = getState().notes.find((n) => n.id === id);
  if (!note) return;
  const current = note.minutes || 0;
  // Snap to the 5-minute grid first, so 7 → 10 → 15, and 7 → 5 → none.
  const snapped = direction > 0
    ? Math.floor(current / MINUTES_STEP) * MINUTES_STEP + MINUTES_STEP
    : Math.ceil(current / MINUTES_STEP) * MINUTES_STEP - MINUTES_STEP;
  setMinutes(id, snapped > 0 ? snapped : null);
}

function focusNeighbour(el) {
  const next = el.nextElementSibling;
  const previous = el.previousElementSibling;
  const target = (next && isNote(next) && next) || (previous && isNote(previous) && previous) || captureInput;
  target.focus({ preventScroll: true });
}

// 4. Taps + editing ---------------------------------------------------------
// Two taps (or a double-click) open the note for editing; three send it
// into the bin, crumpled. The editor waits a moment so a third tap can still come.

let taps = { el: null, count: 0, at: 0, x: 0, y: 0 };
let editTimer = 0;

function countTap(el, event) {
  const now = performance.now();
  const same = taps.el === el && now - taps.at < TAP_GAP_MS &&
    Math.hypot(event.clientX - taps.x, event.clientY - taps.y) < 30;
  taps = { el, count: same ? taps.count + 1 : 1, at: now, x: event.clientX, y: event.clientY };

  clearTimeout(editTimer);
  if (taps.count === 2) {
    editTimer = setTimeout(() => startEdit(el), EDIT_DELAY_MS);
  } else if (taps.count >= 3) {
    taps.count = 0;
    dismiss(el.dataset.id, 'delete');
  }
}

function startEdit(el) {
  if (el.matches('.is-editing, .is-leaving')) return;
  const text = el.querySelector('.note-text');

  el.classList.add('is-editing');
  makeEditable(text);
  text.setAttribute('role', 'textbox');
  text.setAttribute('aria-multiline', 'true');
  text.setAttribute('aria-label', t('editNote'));
  text.focus({ preventScroll: true });
  placeCaretAtEnd(text);
}

/** Plain text only where the browser supports it; paste is cleaned up either way. */
function makeEditable(text) {
  try { text.contentEditable = 'plaintext-only'; } catch { text.contentEditable = 'true'; }
}

function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * While editing, Enter starts a new line (a note can have a few).
 * Clicking away or Cmd/Ctrl+Enter saves; Escape cancels.
 */
function wireEditing(el) {
  const text = el.querySelector('.note-text');

  text.addEventListener('keydown', (event) => {
    if (!el.classList.contains('is-editing')) return;
    if (event.key === 'Escape') { event.preventDefault(); finishEdit(el, false); el.focus(); }
    if (event.key !== 'Enter') return;
    if (event.metaKey || event.ctrlKey) { event.preventDefault(); finishEdit(el, true); el.focus(); }
    else if (text.contentEditable !== 'plaintext-only') {
      // Older browsers would insert markup here; ask for a plain line break instead.
      event.preventDefault();
      document.execCommand('insertLineBreak');
    }
  });
  text.addEventListener('blur', () => finishEdit(el, true));
  text.addEventListener('paste', (event) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text/plain').replace(/\r/g, '');
    document.execCommand('insertText', false, pasted);
  });
}

function finishEdit(el, save) {
  if (!el.classList.contains('is-editing')) return;
  el.classList.remove('is-editing');

  const text = el.querySelector('.note-text');
  const id = el.dataset.id;
  const value = text.innerText; // innerText keeps the line breaks as typed
  text.removeAttribute('contenteditable');
  text.removeAttribute('role');
  text.removeAttribute('aria-multiline');
  text.removeAttribute('aria-label');
  text.scrollTop = 0;

  // Show the stored text again; a successful save re-renders with the new one.
  const stored = getState().notes.find((n) => n.id === id);
  if (stored) text.textContent = stored.text;

  if (!save) return;
  if (!value.trim()) dismiss(id, 'delete'); // emptied on purpose: delete, with undo
  else updateNote(id, value);
}

// 5. Keyboard ---------------------------------------------------------------

/** Shortcuts on a focused note. */
/** The note under the mouse, if any (a target for shortcuts). */
let hoveredNote = null;

/**
 * Which note a key press is for: the focused one, or else the one under the
 * mouse, as long as nothing else has the keyboard (typing, a dialog, a panel).
 */
function shortcutTarget(event) {
  const target = event.target;
  // the wall is out of sight on Today and Tomorrow: its notes take no keys
  if (onOtherView()) return null;
  if (target instanceof HTMLElement && isNote(target)) return { el: target, focused: true };
  if (isTyping(target)) return null;
  if (!hoveredNote || !hoveredNote.isConnected || hoveredNote.classList.contains('is-leaving')) return null;
  // Only when the keyboard isn't busy somewhere else.
  if (target !== document.body && target !== document.documentElement && !wall.contains(target)) return null;
  if (document.querySelector('dialog[open], .sweep, [popover]:popover-open:not(#toast):not(#ball-preview)')) return null;
  return { el: hoveredNote, focused: false };
}

function onNoteKey(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const found = shortcutTarget(event);
  if (!found) return;
  const { el } = found;

  const id = el.dataset.id;
  const key = event.key;

  if (key.startsWith('Arrow')) {
    if (!found.focused && !event.shiftKey) return; // plain arrows scroll the page
    event.preventDefault();
    if (event.shiftKey) nudgePlace(el, key);
    else focusByArrow(el, key);
    return;
  }

  const actions = {
    enter: () => (pileOf(el) ? openSpread(pileOf(el)) : startEdit(el)),
    d: () => dismiss(id, 'done'),
    p: () => pin(el),
    c: () => cycleColor(el),
    f: () => openFocus(id),
    '+': () => nudgeMinutes(id, 1),
    '=': () => nudgeMinutes(id, 1),
    '-': () => nudgeMinutes(id, -1),
    l: () => sendToLater(id),
    m: () => sendToTomorrow(id),
    backspace: () => dismiss(id, 'delete'),
    delete: () => dismiss(id, 'delete'),
  };
  const action = actions[key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  action();
}

const DIRECTIONS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Shift+arrow: slide the note a little that way. */
function nudgePlace(el, key) {
  const [dx, dy] = DIRECTIONS[key];
  placeNote(el.dataset.id, el.offsetLeft + dx * NUDGE_PX, el.offsetTop + dy * NUDGE_PX);
}

/** Arrow: go to the nearest note in that direction (notes can be anywhere now). */
function focusByArrow(el, key) {
  const [dx, dy] = DIRECTIONS[key];
  const centre = (n) => [n.offsetLeft + n.offsetWidth / 2, n.offsetTop + n.offsetHeight / 2];
  const [x, y] = centre(el);
  let best = null;
  let bestScore = Infinity;
  for (const other of wall.children) {
    if (other === el || !isNote(other)) continue;
    const [ox, oy] = centre(other);
    const along = (ox - x) * dx + (oy - y) * dy;      // how far in the right direction
    const across = Math.abs((ox - x) * dy + (oy - y) * dx); // how far off to the side
    if (along <= 10) continue;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = other; }
  }
  if (best) best.focus();
  else if (key === 'ArrowDown') captureInput.focus(); // below the lowest note is the capture bar
}

// 6. Piles ------------------------------------------------------------------
// Notes dropped onto each other stack into a neat pile: the top note flat,
// the ones under it peeking out a little, each at its own slight angle, with
// a count on the corner. Drag the pile and it moves as one. Click it and the
// notes spread out over a dimmed wall so all of them can be read and used;
// drag one out to take it off the pile. Escape or a click outside closes it.

/** How the notes under the top one sit: tilt and offset, by depth. */
const PILE_TILT = [0, -3.4, 2.8, -1.9];
const PILE_STEP = { x: 4, y: 7 };

const spreadLayer = document.getElementById('pile-spread');
const spreadCount = document.getElementById('pile-spread-count');
let spreadPile = null;
let stackHighlight = null;

/** The pile a note is in, if it is closed up (an open pile's notes act on their own). */
function pileOf(el) {
  const note = getState().notes.find((n) => n.id === el.dataset.id);
  return note?.pile && note.pile !== spreadPile ? note.pile : null;
}

/** Where each piled note goes: { id → { dx, dy, rot, depth, count } or, spread out, { x, y, z } }. */
function pileLayout(notes) {
  const layout = new Map();
  const piles = new Map();
  for (const n of notes) if (n.pile) piles.set(n.pile, [...(piles.get(n.pile) || []), n]);
  if (spreadPile && (piles.get(spreadPile)?.length || 0) < 2) closeSpread(false);

  for (const [pileId, members] of piles) {
    // top of the pile first
    members.sort((a, b) => (b.z || 0) - (a.z || 0));
    if (pileId === spreadPile) {
      spreadSpots(members).forEach((spot, i) => layout.set(members[i].id, { ...spot, spread: true, depth: i, count: members.length, rot: members[i].rot }));
      continue;
    }
    members.forEach((n, depth) => {
      const d = Math.min(depth, PILE_TILT.length - 1);
      layout.set(n.id, {
        dx: d * PILE_STEP.x,
        dy: d * PILE_STEP.y,
        rot: depth === 0 ? n.rot : PILE_TILT[d],
        depth,
        count: members.length,
      });
    });
  }
  return layout;
}

/** An open pile: its notes in rows over the visible part of the wall, around where the pile is. */
function spreadSpots(members) {
  const size = noteSize();
  const gap = window.innerWidth >= 720 ? 28 : 14;
  const box = wall.getBoundingClientRect();
  // the part of the wall on screen, in wall coordinates, clear of the bar above and the capture bar below
  const view = {
    left: -box.left + 16,
    right: -box.left + window.innerWidth - 16,
    top: -box.top + 126,
    bottom: -box.top + window.innerHeight - 110,
  };
  const columns = Math.max(1, Math.min(members.length, Math.floor((view.right - view.left + gap) / (size + gap))));
  const rows = Math.ceil(members.length / columns);
  const width = columns * size + (columns - 1) * gap;
  const height = rows * size + (rows - 1) * gap;
  const anchor = members[0];
  const x0 = Math.max(view.left, Math.min(anchor.x + size / 2 - width / 2, view.right - width));
  const y0 = Math.max(view.top, Math.min(anchor.y + size / 2 - height / 2, view.bottom - height));
  return members.map((n, i) => {
    const row = Math.floor(i / columns);
    const inRow = Math.min(columns, members.length - row * columns);
    const shift = ((columns - inRow) * (size + gap)) / 2; // a short last row sits in the middle
    return { x: x0 + shift + (i % columns) * (size + gap), y: y0 + row * (size + gap), z: 9600 + members.length - i };
  });
}

function initSpread() {
  spreadLayer.addEventListener('click', (event) => {
    if (event.target.closest('#pile-unstack')) {
      const pile = spreadPile;
      closeSpread(false);
      unstackPile(pile);
      riffle(4);
    } else if (!event.target.closest('.pile-bar') || event.target.closest('#pile-close')) closeSpread();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !spreadPile || isTyping(event.target)) return;
    if (document.querySelector('[popover]:popover-open:not(#toast):not(#ball-preview), dialog[open]')) return;
    event.preventDefault();
    closeSpread();
  });
}

/** Spread a pile out so every note in it shows. */
function openSpread(pileId) {
  if (spreadPile === pileId) return;
  const count = pileMembers(pileId).length;
  if (count < 2) return;
  spreadPile = pileId;
  spreadCount.textContent = t('pileCount', { n: count });
  spreadLayer.hidden = false;
  spreadLayer.classList.remove('is-closing');
  riffle(count);
  render(getState());
  // the top note gets the keyboard, ready for Enter, D, Backspace…
  const top = noteElements.get(pileMembers(pileId).at(-1).id);
  top?.focus({ preventScroll: true });
}

/** Gather an open pile back up. */
function closeSpread(rerender = true) {
  if (!spreadPile) return;
  const pile = spreadPile;
  spreadPile = null;
  spreadLayer.classList.add('is-closing');
  setTimeout(() => { if (!spreadPile) spreadLayer.hidden = true; }, reducedMotion.matches ? 0 : 220);
  if (!rerender) return;
  riffle(Math.min(3, pileMembers(pile).length));
  render(getState());
  const top = pileMembers(pile).at(-1);
  if (top) noteElements.get(top.id)?.focus({ preventScroll: true });
}

/** A closed pile is picked up whole; anything else on its own. */
function carriedWith(el) {
  const pile = pileOf(el);
  if (!pile) return [el];
  return pileMembers(pile).map((n) => noteElements.get(n.id)).filter(Boolean);
}

/** The note (top of its pile) whose middle the dragged note is over, if any. */
function stackTarget(el, carried) {
  if (spreadPile) return null;
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  let best = null;
  for (const other of wall.children) {
    if (carried.includes(other) || !isNote(other) || other.classList.contains('is-leaving')) continue;
    const r = other.getBoundingClientRect();
    const inset = r.width * 0.22;
    if (x < r.left + inset || x > r.right - inset || y < r.top + inset || y > r.bottom - inset) continue;
    if (!best || Number(other.style.zIndex) > Number(best.style.zIndex)) best = other;
  }
  if (!best) return null;
  const pile = pileOf(best);
  return pile ? noteElements.get(pileMembers(pile).at(-1).id) : best;
}

/** The note about to be stacked on lifts a little to meet it. */
function showStackTarget(target) {
  stackHighlight?.classList.remove('is-stack-target');
  stackHighlight = target;
  target?.classList.add('is-stack-target');
}

/** A small press as the pile takes the new note. */
function settlePile(target) {
  const pile = pileOf(target);
  const top = pile && noteElements.get(pileMembers(pile).at(-1).id);
  if (!top) return;
  const rot = top.style.getPropertyValue('--rot');
  top.animate(
    [{ transform: `rotate(${rot}) scale(1.03)` }, { transform: `rotate(${rot}) scale(0.985)`, offset: 0.55 }, { transform: `rotate(${rot})` }],
    { duration: reducedMotion.matches ? 0 : 240, easing: 'ease-out' },
  );
}

/** Put a dragged note down; a whole pile moves as one, keeping its shape. */
function dropNote(el, x, y) {
  slap();
  const pile = pileOf(el);
  if (pile) movePile(pile, x - Number(el.dataset.pileDx || 0), y - Number(el.dataset.pileDy || 0));
  else placeNote(el.dataset.id, x, y);
}

/** A whole pile dragged to the trash: each note crumples and goes in, top first. One Undo. */
async function throwPile(pileId) {
  const members = pileMembers(pileId);
  const els = members.map((n) => noteElements.get(n.id)).filter(Boolean).reverse();
  els.forEach((el) => el.classList.add('is-leaving'));
  if (els.some((el) => el.contains(document.activeElement))) captureInput.focus({ preventScroll: true });
  await Promise.all(els.map((el, i) => new Promise((resolve) => setTimeout(resolve, reducedMotion.matches ? 0 : i * 140)).then(() => throwAway(el))));
  const count = removeNotes(members.map((n) => n.id));
  if (count) offerUndo(t('deletedMany', { n: count }), 'trash');
}
