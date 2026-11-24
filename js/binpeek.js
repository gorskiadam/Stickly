// binpeek.js — look inside the bin. Click it: the lid opens and today's
// deleted notes tumble out as small crumpled balls in a little glass tray.
// Hover a ball (or focus it) and it opens up in the air above, just enough to
// read, then folds back up when you move away. Drag a ball out onto the wall
// and it unfolds back into a note right there; click (or Enter) puts it back
// in the next free spot.

import { subscribe, trashItems, restoreTrash, emptyTrash, emptyTrashForGood } from './store.js';
import { uncrumple } from './ui.js';
import { bumpPile } from './later.js';
import { offerUndo } from './feedback.js';
import { crumple, binOpen } from './sound.js';
import { crumpleShapes, creaseImage } from './paper.js';
import { expectBall, ballLanded, restingSpot, throwPath, flightFrames, inside } from './trash.js';
import { t, formatMinutes } from './strings.js';

const bin = document.getElementById('trash');
const panel = document.getElementById('bin-peek');
const tray = document.getElementById('bin-balls');
const emptyLine = document.getElementById('bin-empty');
const hint = document.getElementById('bin-hint');
const clearButton = document.getElementById('bin-clear');
const countLine = document.getElementById('bin-count');
const preview = document.getElementById('ball-preview');
const previewPaper = preview.querySelector('.ball-preview-paper');
const previewTime = preview.querySelector('.ball-preview-time');
const previewText = preview.querySelector('.ball-preview-text');
const previewCreases = preview.querySelector('.ball-preview-creases');
const wall = document.getElementById('wall');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const DRAG_SLOP = 6;

export function initBinPeek() {
  bin.addEventListener('click', toggle);
  // The bin empties itself at 11:55 pm (checked every half minute, and on return).
  autoEmpty();
  setInterval(autoEmpty, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoEmpty(); });
  panel.addEventListener('toggle', (event) => {
    const open = event.newState === 'open';
    bin.classList.toggle('is-looking', open);
    bin.setAttribute('aria-expanded', String(open));
    if (open) binOpen();
    else hidePreview(true);
  });
  tray.addEventListener('pointerover', (event) => {
    const el = event.target.closest('.bin-ball');
    if (el && event.pointerType !== 'touch') showPreview(el);
  });
  tray.addEventListener('pointerout', (event) => {
    const el = event.target.closest('.bin-ball');
    if (el && !el.contains(event.relatedTarget)) hidePreview();
  });
  tray.addEventListener('focusin', (event) => {
    const el = event.target.closest('.bin-ball');
    if (el && el.matches(':focus-visible')) showPreview(el);
  });
  tray.addEventListener('focusout', () => hidePreview());
  tray.addEventListener('pointerdown', onBallDown);
  tray.addEventListener('click', onBallClick);
  clearButton.addEventListener('click', emptyAll);
  subscribe(() => { if (panel.matches(':popover-open')) fill(false); });
  window.addEventListener('resize', () => { if (panel.matches(':popover-open')) place(); });
}

function toggle() {
  if (panel.matches(':popover-open')) {
    panel.hidePopover();
    return;
  }
  fill(true);
  panel.showPopover();
  place();
}

/** Sit just above the bin, lined up with its left edge, with room for the
 *  can to grow and its lid to swing open above it (not tucked under the panel). */
function place() {
  const box = bin.getBoundingClientRect();
  panel.style.left = `${Math.max(12, box.left - 4)}px`;
  panel.style.bottom = `${window.innerHeight - box.top + 12 + box.height * 0.75}px`;
}

/** One ball per deleted note. `tumble` makes them pop up out of the bin. */
function fill(tumble) {
  const items = trashItems();
  emptyLine.hidden = items.length > 0;
  hint.hidden = items.length === 0;
  clearButton.hidden = items.length === 0;
  countLine.textContent = items.length ? t(items.length === 1 ? 'binCountOne' : 'binCountMany', { n: items.length }) : '';
  balls.clear();
  items.forEach((note) => balls.set(note.id, note));
  tray.replaceChildren(...items.map(ball));
  if (!tumble || reducedMotion.matches) return;
  [...tray.children].forEach((el, i) => {
    el.animate(
      [
        { transform: `translateY(60px) rotate(${el.dataset.spin}deg) scale(0.3)`, opacity: 0 },
        { transform: `translateY(-8px) rotate(${el.dataset.spin * 0.6}deg) scale(1.05)`, opacity: 1, offset: 0.7 },
        { transform: `rotate(${el.dataset.spin * 0.5}deg)`, opacity: 1 },
      ],
      { duration: 420, delay: 60 + i * 45, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)', fill: 'backwards' },
    );
  });
}

/** The notes behind the balls on show, by id. */
const balls = new Map();

/** Each ball keeps its own wrinkles for as long as it is in the bin. */
const seeds = new Map();
function seedOf(id) {
  if (!seeds.has(id)) seeds.set(id, Math.random() * 1e9);
  return seeds.get(id);
}

function ball(note) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'bin-ball';
  el.dataset.id = note.id;
  el.dataset.color = note.color;
  // Each ball is crumpled a little differently, and settles a little lower or higher.
  const seed = seedOf(note.id);
  const spin = Math.round(((seed % 1000) / 1000 - 0.5) * 80);
  el.dataset.spin = String(spin);
  el.style.rotate = `${spin * 0.5}deg`;
  el.style.setProperty('--sink', `${Math.round((seed % 7) - 3)}px`);
  el.setAttribute('aria-label', t('putBack', { text: note.text }));
  const paper = document.createElement('span');
  paper.className = 'bin-ball-paper';
  paper.style.clipPath = crumpleShapes(seed).at(1);
  paper.style.backgroundImage = `${creaseImage(seed)}, radial-gradient(circle at 36% 30%, rgba(255, 255, 255, 0.4), transparent 50%), radial-gradient(circle at 66% 74%, rgba(0, 0, 0, 0.3), transparent 62%)`;
  el.append(paper);
  return el;
}

// ---------- Peeking: a ball opens up in the air ----------

const PREVIEW_SIZE = 168;
let peeking = null; // the ball being shown

function showPreview(el) {
  if (el.classList.contains('is-lifted') || emptying) return;
  const note = balls.get(el.dataset.id);
  if (!note) return;
  if (peeking && peeking !== el) peeking.classList.remove('is-peeking');
  peeking = el;
  el.classList.add('is-peeking');

  previewPaper.dataset.color = note.color;
  previewTime.textContent = note.minutes ? formatMinutes(note.minutes) : '';
  previewText.textContent = note.text;
  const seed = seedOf(note.id);
  previewCreases.style.backgroundImage = creaseImage(seed);

  // Open in the air above the tray, over its own ball, kept inside the window.
  const box = el.getBoundingClientRect();
  const panelTop = panel.getBoundingClientRect().top;
  const left = Math.min(Math.max(10, box.left + box.width / 2 - PREVIEW_SIZE / 2), window.innerWidth - PREVIEW_SIZE - 10);
  const top = Math.max(10, panelTop - PREVIEW_SIZE - 14);
  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
  if (!preview.matches(':popover-open')) preview.showPopover();

  // From the ball, where it sits, to a flat little note: pulled open in two tugs.
  const dx = box.left + box.width / 2 - (left + PREVIEW_SIZE / 2);
  const dy = box.top + box.height / 2 - (top + PREVIEW_SIZE / 2);
  const ballScale = box.width / PREVIEW_SIZE;
  const spin = Number(el.dataset.spin) || 0;
  const shape = crumpleShapes(seed);
  const tilt = ((seed % 5) - 2) * 0.8;
  const time = reducedMotion.matches ? 0 : 420;
  previewPaper.getAnimations().forEach((a) => a.cancel());
  previewPaper.animate([
    { transform: `translate(${dx}px, ${dy}px) rotate(${spin * 0.5}deg) scale(${ballScale})`, clipPath: shape.at(1) },
    { transform: `translate(${dx * 0.4}px, ${dy * 0.45}px) rotate(${spin * 0.2}deg) scale(0.6, 0.66)`, clipPath: shape.at(0.55), offset: 0.45 },
    { transform: `translate(${dx * 0.32}px, ${dy * 0.36}px) rotate(${spin * 0.15}deg) scale(0.63, 0.68)`, clipPath: shape.at(0.5), offset: 0.55 },
    { transform: `rotate(${tilt}deg)`, clipPath: shape.at(0) },
  ], { duration: time, easing: 'cubic-bezier(0.3, 0.6, 0.3, 1)', fill: 'forwards' });
  previewCreases.getAnimations().forEach((a) => a.cancel());
  previewCreases.animate([{ opacity: 1 }, { opacity: 0.3 }], { duration: time, fill: 'forwards' });
  for (const part of [previewTime, previewText]) {
    part.getAnimations().forEach((a) => a.cancel());
    part.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: time, fill: 'forwards' });
  }
}

/** Fold the open note back into its ball (or just put it away, `now`). */
function hidePreview(now = false) {
  const el = peeking;
  peeking = null;
  el?.classList.remove('is-peeking');
  if (!preview.matches(':popover-open')) return;
  if (now || !el || !el.isConnected || reducedMotion.matches) {
    preview.hidePopover();
    return;
  }
  const box = el.getBoundingClientRect();
  const left = parseFloat(preview.style.left);
  const top = parseFloat(preview.style.top);
  const dx = box.left + box.width / 2 - (left + PREVIEW_SIZE / 2);
  const dy = box.top + box.height / 2 - (top + PREVIEW_SIZE / 2);
  const seed = seedOf(el.dataset.id);
  const shape = crumpleShapes(seed);
  const spin = Number(el.dataset.spin) || 0;
  const current = getComputedStyle(previewPaper);
  previewPaper.getAnimations().forEach((a) => a.cancel());
  const folding = previewPaper.animate([
    { transform: current.transform === 'none' ? 'none' : current.transform, clipPath: current.clipPath === 'none' ? shape.at(0) : current.clipPath },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) rotate(${spin * 0.3}deg) scale(0.5)`, clipPath: shape.at(0.6), offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) rotate(${spin * 0.5}deg) scale(${box.width / PREVIEW_SIZE})`, clipPath: shape.at(1) },
  ], { duration: 240, easing: 'cubic-bezier(0.5, 0, 0.7, 0.4)', fill: 'forwards' });
  for (const part of [previewTime, previewText]) {
    part.getAnimations().forEach((a) => a.cancel());
    part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' });
  }
  folding.finished.then(() => {
    // Another ball may have been hovered in the meantime.
    if (!peeking && preview.matches(':popover-open')) preview.hidePopover();
  }, () => {});
}

// ---------- Emptying ----------

/** From 11:55 pm the day's bin is emptied for good, quietly. */
function autoEmpty() {
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < 23 * 60 + 55) return;
  if (!trashItems().length || emptying) return;
  if (panel.matches(':popover-open')) panel.hidePopover();
  emptyTrashForGood();
}

let emptying = false;

/**
 * Empty the bin: the tray closes and the lid opens wide. Each ball is
 * tossed, one just after another, in a curve: up and out to the right,
 * over the top, then back down to the left and in through the open lid.
 * The lid slams once when the last one is in.
 */
async function emptyAll() {
  if (emptying || !trashItems().length) return;
  emptying = true;
  hidePreview(true);

  // Lift copies of the balls off the tray, exactly where they are.
  const flyers = [...tray.children].map((el) => {
    const box = el.getBoundingClientRect();
    const copy = el.cloneNode(true);
    copy.classList.add('is-flying');
    copy.style.rotate = ''; // the spin goes into the flight instead
    copy.style.left = `${box.left + box.width / 2}px`;
    copy.style.top = `${box.top + box.height / 2}px`;
    document.body.append(copy);
    return { copy, from: { x: box.left + box.width / 2, y: box.top + box.height / 2 }, spin: Number(el.dataset.spin) || 0 };
  });
  panel.hidePopover();
  flyers.forEach(() => expectBall());
  crumple(0.3);
  // the can grows and opens first, so the balls aim at where it ends up
  await new Promise((resolve) => setTimeout(resolve, reducedMotion.matches ? 0 : 340));
  const can = inside();

  const flights = flyers.map(({ copy, from, spin }, i) => {
    can.layer.append(copy);
    // the same throw as a single note: a lob that drops past the lid, goes
    // behind the can's front wall and stops on its floor (a little higher
    // each time, as they heap up). The lid stays open until the last is in.
    const fit = Math.min(1, can.fit / 50);
    const spot = restingSpot(can, 50 * fit);
    const path = throwPath(from, { x: spot.x, y: can.mouth.y }, i);
    const land = path.landAt(spot.floor);
    const time = reducedMotion.matches ? 0 : path.duration * 0.9 * land;
    const frames = flightFrames(path, from, land, (u) => ` rotate(${(spin + u * 240).toFixed(1)}deg) scale(${(1 - (1 - fit) * Math.min(1, u)).toFixed(3)})`);
    return copy.animate(frames, {
      duration: time,
      delay: reducedMotion.matches ? 0 : i * 110,
      easing: 'linear',
      fill: 'forwards',
    }).finished.catch(() => {}).then(() => ballLanded());
  });
  await Promise.all(flights);
  setTimeout(() => can.layer.remove(), reducedMotion.matches ? 0 : 1100);

  emptyTrash();
  offerUndo(t('binEmptied'), 'trash');
  emptying = false;
}

// ---------- Getting a note back ----------

function onBallClick(event) {
  const el = event.target.closest('.bin-ball');
  if (!el || el.dataset.dragged) return;
  putBack(el.dataset.id, null);
}

/** Restore a note, at a wall position or (null) the next free spot. */
function putBack(id, at) {
  const place = at ? restoreTrash(id, at.x, at.y) : restoreTrash(id);
  if (place === 'wall') uncrumple(id);
  else if (place === 'later') bumpPile();
  if (place) offerUndo(t(place === 'wall' ? 'restored' : 'addedToLater'), 'back');
  if (!trashItems().length) setTimeout(() => panel.hidePopover(), 500);
}

/** Press a ball and pull it out: a copy follows the pointer until it is let go. */
function onBallDown(event) {
  const el = event.target.closest('.bin-ball');
  if (!el || event.button !== 0) return;
  const start = { x: event.clientX, y: event.clientY };
  let ghost = null;

  const move = (e) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_SLOP) return;
      hidePreview(true);
      ghost = el.cloneNode(true);
      ghost.classList.add('is-ghost');
      document.body.append(ghost);
      el.classList.add('is-lifted');
      crumple();
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
    el.dataset.dragged = '1'; // the click that follows is not a "put back"
    setTimeout(() => { delete el.dataset.dragged; }, 0);
    const out = ghost.classList.contains('is-out') && e.type === 'pointerup';
    ghost.remove();
    el.classList.remove('is-lifted');
    if (!out) return;
    // Centre the unfolded note on the spot where the ball was dropped.
    const size = parseFloat(getComputedStyle(wall).getPropertyValue('--note-size')) || 196;
    putBack(el.dataset.id, { x: e.pageX - size / 2, y: e.pageY - size / 2 });
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
