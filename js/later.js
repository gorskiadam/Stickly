// later.js — the Later box: a small cardboard box in the corner, the trash
// can's counterpart. Notes put off for later go in through its flaps; it
// grows and opens a crack while a note is carried, swings its flaps wide when
// one is on its way, and folds them shut with a soft bump once the last one
// is in. Click it to look inside: the notes sit in the box as small stickies
// that can be edited (double-click or Enter), recolored, timed (type a
// number), sent to the wall, thrown in the trash, or dragged out onto the
// wall right where they should go.

import {
  getState, subscribe, hasSpace, promoteNote, promoteAll, removeNote,
  updateNote, setColor, setMinutes, COLORS, MINUTES_MAX,
} from './store.js';
import { dropIn } from './ui.js';
import { offerUndo, showToast, isTyping } from './feedback.js';
import { lift, inside, throwPath, flightFrames, expectBall, ballLanded, restingSpot, trashElement } from './trash.js';
import { crumpleShapes, creaseImage } from './paper.js';
import { dropZoneWidth } from './drag.js';
import { crumple, slap, boxOpen, boxClose, boxLand } from './sound.js';
import { t, formatMinutes } from './strings.js';

const box = document.getElementById('pile');
const boxCount = document.getElementById('pile-count');
const panel = document.getElementById('later');
const hint = document.getElementById('later-hint');
const countLine = document.getElementById('later-count');
const list = document.getElementById('later-list');
const emptyLine = document.getElementById('later-empty');
const tip = document.getElementById('later-tip');
const allButton = document.getElementById('later-all');
const allLabel = document.getElementById('later-all-label');
const wall = document.getElementById('wall');
const zone = document.getElementById('drop-zone-later');
const captureInput = document.getElementById('capture-input');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const DRAG_SLOP = 6;
/** How big a note is when it goes in through the flaps, in pixels. */
const FILED_SIZE = 30;

const ICON_UP = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4.5"/></svg>';

export function initLater() {
  subscribe(render);
  render(getState());
  box.addEventListener('click', toggle);
  box.addEventListener('animationend', () => box.classList.remove('is-bumped'));
  panel.addEventListener('toggle', (event) => {
    const open = event.newState === 'open';
    box.classList.toggle('is-looking', open);
    box.setAttribute('aria-expanded', String(open));
    if (open) boxOpen();
    else {
      boxClose();
      if (editing) finishEdit(true);
    }
  });
  list.addEventListener('click', onListClick);
  list.addEventListener('dblclick', onListDoubleClick);
  list.addEventListener('keydown', onListKey);
  list.addEventListener('pointerdown', onNoteDown);
  allButton.addEventListener('click', bringAll);
  window.addEventListener('resize', () => { if (panel.matches(':popover-open')) place(); });
}

function toggle() {
  if (panel.matches(':popover-open')) {
    panel.hidePopover();
    return;
  }
  render(getState(), true);
  panel.showPopover();
  place();
}

/** Sit just above the box, lined up with its right edge, with room for the
 *  box to grow and its flaps to open above it (not tucked under the panel). */
function place() {
  const rect = box.getBoundingClientRect();
  panel.style.right = `${Math.max(12, window.innerWidth - rect.right - 4)}px`;
  panel.style.bottom = `${window.innerHeight - rect.top + 12 + rect.height * 0.75}px`;
}

// ---------- The box itself ----------

let incoming = 0;
let closeTimer = 0;

/** While a note is being carried, the box opens a crack so it can be found too. */
export function setBoxAwake(awake) {
  box.classList.toggle('is-awake', awake);
  // the right edge frosts over too: drop there to put a note away for later
  zone.style.setProperty('--zone', `${dropZoneWidth()}px`);
  zone.classList.toggle('is-awake', awake);
  if (!awake) zone.classList.remove('is-hot');
}

/** A note is right over the box (or left it). */
export function setBoxOpen(open) {
  if (!open && incoming > 0) return;
  if (open && !box.classList.contains('is-open')) boxOpen();
  clearTimeout(closeTimer);
  box.classList.remove('is-closing');
  box.classList.toggle('is-open', open);
  zone.classList.toggle('is-hot', open && zone.classList.contains('is-awake'));
}

/**
 * Is a carried note over the box or the strip along the right edge? `x, y`
 * is the pointer, `center` the middle of the note: either one in counts.
 * The strip takes drops across all of its visible frost, not just its core.
 */
export function isOverBox(x, y, center = null) {
  const edge = window.innerWidth - dropZoneWidth() * 1.2;
  if (x > edge || (center && center.x > edge)) return true;
  if (box.offsetParent === null) return false;
  const rect = box.getBoundingClientRect();
  const reach = 26;
  const near = (px, py) => px > rect.left - reach && px < rect.right + reach && py > rect.top - reach && py < rect.bottom + reach;
  return near(x, y) || Boolean(center && near(center.x, center.y));
}

export function boxElement() {
  return box;
}

function expectNote() {
  clearTimeout(closeTimer);
  incoming += 1;
  box.classList.remove('is-closing');
  if (!box.classList.contains('is-open')) boxOpen();
  box.classList.add('is-open');
}

/** A note is in. The last one in folds the flaps shut. */
function noteLanded() {
  incoming = Math.max(0, incoming - 1);
  bump();
  if (incoming > 0) return;
  closeTimer = setTimeout(closeFlaps, reducedMotion.matches ? 0 : 180);
}

function closeFlaps() {
  if (incoming > 0) return;
  boxClose();
  box.classList.add('is-closing');
  box.classList.remove('is-open');
  closeTimer = setTimeout(() => box.classList.remove('is-closing'), 420);
}

/** A soft cardboard bump; the stamp on the front shows the new count. */
function bump() {
  box.classList.remove('is-bumped');
  void box.offsetWidth; // restart the animation if it is already running
  box.classList.add('is-bumped');
}

/**
 * Something went into the box without being seen to (added while the wall
 * was full, put back from the trash): the flaps open, it settles, they close.
 */
export function bumpPile() {
  expectNote();
  setTimeout(() => { boxLand(); noteLanded(); }, reducedMotion.matches ? 0 : 260);
}

/**
 * Put a wall note in the box: it zooms out as it's picked up, then is tossed
 * in a lob, turning over and over as it flies and getting smaller, drops past
 * the open flaps behind the front of the box, and lands inside.
 * Resolves once it is in.
 */
export async function fileIntoBox(el) {
  expectNote(); // the flaps swing open while it's picked up
  const { flight, paper, start, rot, scale, width } = lift(el);
  paper.querySelectorAll('.note-time, .note-text, .note-foot').forEach((part) => {
    part.animate([{ opacity: 1 }, { opacity: 0.35 }], { duration: ms(260), fill: 'forwards' });
  });
  // 1. Zoom out: picked up off the wall, it shrinks back and tips a little.
  const picked = scale * 0.46;
  await paper.animate([
    { transform: `rotate(${rot}deg) scale(${scale})` },
    { transform: `rotate(${rot - 3}deg) scale(${scale * 1.04})`, offset: 0.18 },
    { transform: `rotate(${rot - 14}deg) scale(${picked})` },
  ], { duration: ms(320), easing: 'cubic-bezier(0.4, 0, 0.25, 1)', fill: 'forwards' }).finished;

  // 2. Toss: an ordinary lob, spinning as it goes, smaller and smaller.
  // 3. In: past the rim it goes behind the front of the box and lands.
  const into = inside(box.querySelector('.box-body'), 0.5);
  const end = FILED_SIZE / width;
  const spot = { x: into.mouth.x + [0, -6, 6, -3, 3][incoming % 5], floor: into.floor - FILED_SIZE / 2 };
  const path = throwPath(start, { x: spot.x, y: into.mouth.y });
  const land = path.landAt(spot.floor);
  const time = ms(path.duration * land * 1.05);
  const turns = start.x < spot.x ? 1 : -1; // it spins the way it's thrown
  into.layer.append(flight);
  paper.animate(
    [
      { transform: `rotate(${rot - 14}deg) scale(${picked})` },
      { transform: `rotate(${rot - 14 + turns * 200}deg) scale(${(picked + end) / 2})`, offset: 0.55 },
      { transform: `rotate(${rot - 14 + turns * 380}deg) scale(${end})` },
    ],
    { duration: time, easing: 'linear', fill: 'forwards' },
  );
  await flight.animate(flightFrames(path, start, land), { duration: time, easing: 'linear', fill: 'forwards' }).finished;
  boxLand();
  noteLanded();
  setTimeout(() => into.layer.remove(), ms(600));
}

// ---------- Inside the box ----------

/** The note being edited in the box, if any: { id, item }. */
let editing = null;

function render(state, force = false) {
  const count = state.later.length;
  boxCount.textContent = count ? String(count) : '';
  box.setAttribute('aria-label', count ? t('laterCount', { n: count }) : t('later'));
  if (!force && !panel.matches(':popover-open')) return;
  if (editing && !force) return; // don't pull the text out from under the typing

  const space = hasSpace();
  const room = state.settings.limit - state.notes.length;
  hint.textContent = count ? t(space ? 'laterHintSpace' : 'laterHintFull') : t('laterSub');
  countLine.textContent = count ? String(count) : '';
  emptyLine.hidden = count > 0;
  tip.hidden = count === 0;
  allButton.hidden = count < 2 || !space;
  allLabel.textContent = count <= room ? t('allToWall') : t('someToWall', { n: room });

  const focused = document.activeElement?.closest?.('.box-note')?.dataset.id;
  list.replaceChildren(...state.later.map((note) => boxNote(note, space)));
  if (focused) list.querySelector(`[data-id="${focused}"] .box-note-paper`)?.focus({ preventScroll: true });
}

/** Each note keeps its own little tilt in the box. */
function tiltOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 7) - 3) * 0.9;
}

function boxNote(note, space) {
  const item = document.createElement('li');
  item.className = 'box-note';
  item.dataset.id = note.id;
  item.dataset.color = note.color;
  item.style.setProperty('--tilt', `${tiltOf(note.id)}deg`);

  const paper = document.createElement('div');
  paper.className = 'box-note-paper';
  paper.tabIndex = 0;
  paper.setAttribute('role', 'button');
  paper.setAttribute('aria-label', [note.text, note.minutes ? formatMinutes(note.minutes) : ''].filter(Boolean).join(', '));
  paper.setAttribute('aria-keyshortcuts', 'Enter W C Backspace');

  const time = document.createElement('p');
  time.className = 'box-note-time';
  if (note.minutes) time.innerHTML = `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><path d="M6 3.4V6l1.7 1.1"/></svg><span>${formatMinutes(note.minutes)}</span>`;
  const text = document.createElement('p');
  text.className = 'box-note-text';
  text.textContent = note.text;

  const tools = document.createElement('div');
  tools.className = 'box-note-tools';
  for (const color of COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'box-swatch';
    swatch.dataset.color = color;
    swatch.style.setProperty('--swatch', `var(--paper-${color})`);
    swatch.setAttribute('aria-pressed', String(note.color === color));
    swatch.setAttribute('aria-label', t('colorTo', { name: t(`color_${color}`) }));
    swatch.tabIndex = -1;
    tools.append(swatch);
  }
  const up = toolButton('later-up', ICON_UP, t('moveToWall', { text: note.text }));
  up.disabled = !space;
  const bin = toolButton('later-bin', ICON_TRASH, t('deleteNote', { text: note.text }));
  const actions = document.createElement('div');
  actions.className = 'box-note-actions';
  actions.append(up, bin);

  paper.append(time, text, tools, actions);
  item.append(paper);
  return item;
}

function toolButton(name, icon, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `box-tool ${name}`;
  button.innerHTML = icon;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.tabIndex = -1;
  return button;
}

// ---------- Actions ----------

function onListClick(event) {
  const item = event.target.closest('.box-note');
  if (!item || item.dataset.dragged) return;
  const { id } = item.dataset;
  const swatch = event.target.closest('.box-swatch');
  if (swatch) setColor(id, swatch.dataset.color);
  else if (event.target.closest('.later-up')) toWall(id);
  else if (event.target.closest('.later-bin')) toTrash(item);
}

function onListDoubleClick(event) {
  const item = event.target.closest('.box-note');
  if (item && !event.target.closest('button')) startEdit(item);
}

function onListKey(event) {
  const item = event.target.closest('.box-note');
  if (!item || event.metaKey || event.ctrlKey || event.altKey) return;
  if (item.classList.contains('is-editing')) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEdit(false); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finishEdit(true); }
    return;
  }
  if (isTyping(event.target)) return;
  const { id } = item.dataset;
  const key = event.key;
  if (/^[0-9]$/.test(key)) { event.preventDefault(); typeMinutes(item, key); return; }
  if (typed.id && (key === 'Enter' || key === 'Escape')) {
    event.preventDefault();
    event.stopPropagation();
    endTyping(key === 'Enter');
    return;
  }
  if (typed.id) endTyping(true);

  const note = getState().later.find((n) => n.id === id);
  const actions = {
    enter: () => startEdit(item),
    w: () => toWall(id),
    c: () => note && setColor(id, COLORS[(COLORS.indexOf(note.color) + 1) % COLORS.length]),
    '+': () => note && setMinutes(id, (note.minutes || 0) + 5),
    '=': () => note && setMinutes(id, (note.minutes || 0) + 5),
    '-': () => note && setMinutes(id, (note.minutes || 0) - 5 || null),
    backspace: () => toTrash(item),
    delete: () => toTrash(item),
    arrowright: () => step(item, 1),
    arrowdown: () => step(item, columns()),
    arrowleft: () => step(item, -1),
    arrowup: () => step(item, -columns()),
  };
  const action = actions[key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  action();
}

function columns() {
  return getComputedStyle(list).gridTemplateColumns.split(' ').length || 1;
}

function step(item, by) {
  const items = [...list.children];
  const next = items[items.indexOf(item) + by];
  next?.querySelector('.box-note-paper').focus();
}

/** Out of the box and onto the wall, in the next free spot (or `at`). */
function toWall(id, at = null) {
  if (!hasSpace()) {
    showToast(t('laterHintFull'), null, '', 'later');
    return false;
  }
  if (!promoteNote(id, at)) return false;
  dropIn(id);
  if (!getState().later.length) setTimeout(() => panel.hidePopover(), 300);
  else keepFocus();
  return true;
}

function bringAll() {
  const moved = promoteAll();
  moved.forEach((id, i) => dropIn(id, i * 70));
  if (moved.length) offerUndo(t(moved.length === 1 ? 'movedToWallOne' : 'movedToWallMany', { n: moved.length }), 'back');
  if (!getState().later.length) panel.hidePopover();
}

/**
 * Throw a note from the box into the trash: it crumples where it is, and the
 * ball flies across to the can the same way any deleted note does.
 */
async function toTrash(item) {
  const { id } = item.dataset;
  const note = getState().later.find((n) => n.id === id);
  if (!note || item.classList.contains('is-leaving')) return;
  item.classList.add('is-leaving');
  const rect = item.getBoundingClientRect();
  const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const can = trashElement();
  const canVisible = can.offsetParent !== null && !reducedMotion.matches;

  const seed = Math.random() * 1e9;
  const shape = crumpleShapes(seed);
  crumple(0.3);
  if (canVisible) expectBall();
  await item.animate([
    { transform: 'none', clipPath: shape.at(0) },
    { transform: 'scale(0.5)', clipPath: shape.at(1), opacity: 1 },
  ], { duration: ms(260), easing: 'cubic-bezier(0.4, 0, 0.3, 1)', fill: 'forwards' }).finished;

  keepFocus(item);
  if (removeNote(id)) offerUndo(t('deleted'), 'trash');
  if (!getState().later.length) panel.hidePopover();
  if (!canVisible) return;

  // a ball from where it was, into the can
  const ball = document.createElement('span');
  ball.className = 'bin-ball is-flying';
  ball.dataset.color = note.color;
  const ballPaper = document.createElement('span');
  ballPaper.className = 'bin-ball-paper';
  ballPaper.style.clipPath = shape.at(1);
  ballPaper.style.backgroundImage = `${creaseImage(seed)}, radial-gradient(circle at 36% 30%, rgba(255, 255, 255, 0.4), transparent 50%), radial-gradient(circle at 66% 74%, rgba(0, 0, 0, 0.3), transparent 62%)`;
  ball.append(ballPaper);
  ball.style.left = `${from.x}px`;
  ball.style.top = `${from.y}px`;
  // let the can finish growing before aiming at it
  await new Promise((resolve) => setTimeout(resolve, 120));
  const into = inside();
  into.layer.append(ball);
  const fit = Math.min(1, into.fit / 50);
  const spot = restingSpot(into, 50 * fit);
  const path = throwPath(from, { x: spot.x, y: into.mouth.y });
  const land = path.landAt(spot.floor);
  await ball.animate(
    flightFrames(path, from, land, (u) => ` rotate(${(u * 260).toFixed(1)}deg) scale(${(1 - (1 - fit) * Math.min(1, u)).toFixed(3)})`),
    { duration: path.duration * land, easing: 'linear', fill: 'forwards' },
  ).finished.catch(() => {});
  ballLanded();
  setTimeout(() => into.layer.remove(), 1100);
}

/** The list was redrawn: keep the keyboard on a note in the box. */
function keepFocus(leaving = null) {
  if (!panel.matches(':popover-open')) {
    captureInput.focus({ preventScroll: true });
    return;
  }
  requestAnimationFrame(() => {
    const items = [...list.children].filter((el) => el !== leaving);
    const next = items[0]?.querySelector('.box-note-paper');
    if (next) next.focus({ preventScroll: true });
  });
}

// ---------- Editing in the box ----------

function startEdit(item) {
  if (editing) finishEdit(true);
  const text = item.querySelector('.box-note-text');
  editing = { id: item.dataset.id, item };
  item.classList.add('is-editing');
  text.contentEditable = 'plaintext-only';
  if (text.contentEditable !== 'plaintext-only') text.contentEditable = 'true';
  text.setAttribute('role', 'textbox');
  text.setAttribute('aria-multiline', 'true');
  text.focus();
  const range = document.createRange();
  range.selectNodeContents(text);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  text.addEventListener('blur', () => finishEdit(true), { once: true });
}

function finishEdit(save) {
  if (!editing) return;
  const { id, item } = editing;
  editing = null;
  const text = item.querySelector('.box-note-text');
  const value = text.innerText;
  text.removeAttribute('contenteditable');
  item.classList.remove('is-editing');
  const note = getState().later.find((n) => n.id === id);
  if (save && value.trim()) updateNote(id, value);
  else if (note) text.textContent = note.text;
  render(getState());
  list.querySelector(`[data-id="${id}"] .box-note-paper`)?.focus({ preventScroll: true });
}

// ---------- Typing a time onto a note in the box ----------

const typed = { id: null, digits: '', timer: 0, tag: null };

function typeMinutes(item, digit) {
  const { id } = item.dataset;
  if (typed.id && typed.id !== id) endTyping(true);
  if (typed.id !== id) {
    typed.id = id;
    typed.digits = '';
    typed.tag = document.createElement('span');
    typed.tag.className = 'note-typed';
    item.append(typed.tag);
  }
  typed.digits = (typed.digits + digit).replace(/^0+(?=\d)/, '').slice(-3);
  const minutes = Math.min(MINUTES_MAX, Number(typed.digits));
  typed.tag.textContent = minutes ? formatMinutes(minutes) : t('noTime');
  clearTimeout(typed.timer);
  typed.timer = setTimeout(() => endTyping(true), 900);
}

function endTyping(save) {
  clearTimeout(typed.timer);
  const { id, digits, tag } = typed;
  typed.id = null;
  typed.digits = '';
  typed.tag = null;
  tag?.remove();
  if (save && id && digits) {
    const minutes = Math.min(MINUTES_MAX, Number(digits));
    setMinutes(id, minutes > 0 ? minutes : null);
  }
}

// ---------- Dragging a note out onto the wall ----------

function onNoteDown(event) {
  const item = event.target.closest('.box-note');
  if (!item || event.button !== 0 || item.classList.contains('is-editing') || event.target.closest('button')) return;
  const start = { x: event.clientX, y: event.clientY };
  let ghost = null;

  const move = (e) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_SLOP) return;
      ghost = item.cloneNode(true);
      ghost.classList.add('is-ghost');
      document.body.append(ghost);
      item.classList.add('is-lifted');
    }
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
    ghost.classList.toggle('is-out', !panel.contains(document.elementFromPoint(e.clientX, e.clientY)));
  };

  const up = (e) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!ghost) return;
    item.dataset.dragged = '1'; // the click that follows is not a tap
    setTimeout(() => { delete item.dataset.dragged; }, 0);
    const out = ghost.classList.contains('is-out') && e.type === 'pointerup';
    ghost.remove();
    item.classList.remove('is-lifted');
    if (!out) return;
    // the note lands centred where it was let go
    const size = parseFloat(getComputedStyle(wall).getPropertyValue('--note-size')) || 196;
    const wallBox = wall.getBoundingClientRect();
    if (toWall(item.dataset.id, { x: e.clientX - wallBox.left - size / 2, y: e.clientY - wallBox.top - size / 2 })) slap();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function ms(value) {
  return reducedMotion.matches ? 0 : value;
}
