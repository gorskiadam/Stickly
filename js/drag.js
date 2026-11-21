// drag.js — pointer gestures on the wall.
//   Mouse:  press and move            → pick the note up and stick it anywhere
//   Touch:  long-press, then move     → the same
//           quick sideways swipe      → complete the note
//   Either: drop it on the trash, or anywhere along the left edge → throw it away
//           drop it onto another note → the two stack into a pile
// A pile is picked up and moved as one. Notes can go anywhere on the wall.
// Vertical touch movement is left alone so the page still scrolls.

import { settle, rotOf, spring, SPRINGS } from './motion.js';

const LONG_PRESS_MS = 350;
const MOUSE_SLOP = 6;        // px the mouse must travel before a drag starts
const TOUCH_SLOP = 10;       // px a finger may wobble during a long-press
const SWIPE_DISTANCE = 80;   // px sideways to count as "done"
const TRASH_REACH = 28;      // px around the trash can that still count as "over it"

/**
 * How far in from the left edge a drop throws a note away (about 5 cm on a
 * laptop screen, less on a phone so it doesn't eat half the wall).
 */
export function dropZoneWidth() {
  return Math.round(Math.min(190, window.innerWidth * 0.15));
}

/**
 * @param {HTMLElement} wall
 * @param {object} handlers
 * @param {(el: HTMLElement, x: number, y: number) => void} handlers.onDrop  dropped on the wall at (x, y), wall px
 * @param {(el: HTMLElement, dx: number) => void} handlers.onSwipe
 * @param {HTMLElement} handlers.trash                          the trash can, a drop target
 * @param {(over: boolean) => void} handlers.onTrashHover       the dragged note is over the trash or the edge (or left it)
 * @param {(el: HTMLElement) => void} handlers.onTrash          dropped on the trash or the edge
 * @param {(active: boolean) => void} handlers.onDragging       a drag started or ended
 * @param {(el: HTMLElement) => HTMLElement[]} handlers.group    the notes that move with it (its pile), itself included
 * @param {(el: HTMLElement, group: HTMLElement[]) => HTMLElement | null} handlers.stackTarget  the note it would stack onto
 * @param {(target: HTMLElement | null) => void} handlers.onStackHover  hovering over a note to stack onto (or not any more)
 * @param {(el: HTMLElement, target: HTMLElement) => void} handlers.onStack  dropped onto another note
 */
export function initDrag(wall, { onDrop, onSwipe, trash, onTrashHover, onTrash, onDragging, group, stackTarget, onStackHover, onStack }) {
  /** The gesture in progress, or null. */
  let g = null;

  wall.addEventListener('pointerdown', onDown);
  // Once we own the gesture, stop the browser from scrolling with it.
  wall.addEventListener('touchmove', (e) => {
    if (g && g.mode !== 'pending') e.preventDefault();
  }, { passive: false });

  function onDown(e) {
    if (g || e.button !== 0) return;
    const el = e.target.closest('.note');
    if (!el || e.target.closest('button') || el.matches('.is-editing, .is-leaving')) return;

    g = {
      el,
      pointerId: e.pointerId,
      touch: e.pointerType !== 'mouse',
      mode: 'pending', // 'pending' → 'dragging' | 'swiping'
      startX: e.pageX, startY: e.pageY,
      x: e.pageX, y: e.pageY,
      // Where inside the note it was grabbed, so it doesn't jump under the pointer.
      grabX: e.pageX - el.offsetLeft, grabY: e.pageY - el.offsetTop,
      rot: rotOf(el),
      overTrash: false,
      target: null, // a note to stack onto
      group: [el],
      timer: 0,
      // the paper swinging as it's carried: angle (deg) and its speed
      swing: 0, swingSpeed: 0, lift: 1, tip: 0,
      lastX: e.pageX, lastT: performance.now(), frame: 0,
    };
    if (g.touch) g.timer = setTimeout(startDrag, LONG_PRESS_MS);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  function onMove(e) {
    if (!g || e.pointerId !== g.pointerId) return;
    g.x = e.pageX;
    g.y = e.pageY;
    const dx = g.x - g.startX;
    const dy = g.y - g.startY;

    if (g.mode === 'pending') decideMode(dx, dy);
    if (!g) return;

    if (g.mode === 'dragging') {
      const over = isOverTrash(e.clientX, e.clientY);
      if (over !== g.overTrash) {
        g.overTrash = over;
        for (const el of g.group) el.classList.toggle('is-over-trash', over); // it shrinks, ready to be thrown
        onTrashHover(over);
      }
      const target = over ? null : stackTarget(g.el, g.group);
      if (target !== g.target) {
        g.target = target;
        onStackHover(target);
      }
    } else if (g.mode === 'swiping') {
      g.el.style.transform = `translateX(${dx}px) rotate(${g.rot})`;
    }
  }

  /** Work out what the first few pixels of movement mean. */
  function decideMode(dx, dy) {
    const distance = Math.hypot(dx, dy);
    if (!g.touch) {
      if (distance > MOUSE_SLOP) startDrag();
    } else if (Math.abs(dx) > TOUCH_SLOP && Math.abs(dx) > Math.abs(dy)) {
      clearTimeout(g.timer);
      g.mode = 'swiping';
    } else if (distance > TOUCH_SLOP) {
      end(); // the user is scrolling
    }
  }

  /** Over the trash can itself, or anywhere in the strip along the left edge. */
  function isOverTrash(x, y) {
    if (x < dropZoneWidth()) return true;
    const box = trash.getBoundingClientRect();
    return x > box.left - TRASH_REACH && x < box.right + TRASH_REACH &&
      y > box.top - TRASH_REACH && y < box.bottom + TRASH_REACH;
  }

  function startDrag() {
    if (!g) return;
    g.mode = 'dragging';
    onDragging(true);
    g.group = group(g.el);
    // the rest of a pile comes along, in its own order, just under the held note
    g.group.forEach((el, i) => {
      el.dataset.rot = rotOf(el);
      if (el !== g.el) { el.classList.add('is-carried'); el.style.zIndex = String(9000 + i); }
    });
    g.el.classList.add('is-dragging');
    try { g.el.setPointerCapture(g.pointerId); } catch { /* pointer already gone */ }
    // Grabbed near the top, the bottom swings out behind; near the bottom, hardly at all.
    const height = g.el.offsetHeight || 1;
    g.lever = 0.35 + 0.65 * Math.max(-0.5, Math.min(1, (height / 2 - g.grabY) / (height / 2)));
    g.lastT = performance.now();
    g.lastX = g.x;
    g.frame = requestAnimationFrame(carry);
  }

  /**
   * Every frame while carried: the note lifts off the wall, and swings a
   * little with the speed it's moved at, like a sheet of paper held by one
   * spot: a damped pendulum chasing the angle the motion pushes it to.
   */
  function carry(now) {
    if (!g || g.mode !== 'dragging') return;
    const dt = Math.min(48, Math.max(1, now - g.lastT)) / 1000;
    const vx = (g.x - g.lastX) / dt; // px/s
    g.lastX = g.x;
    g.lastT = now;
    const push = reduced() ? 0 : Math.max(-11, Math.min(11, vx * 0.006 * g.lever));
    const accel = (push - g.swing) * 170 - g.swingSpeed * 15;
    g.swingSpeed += accel * dt;
    g.swing += g.swingSpeed * dt;
    // lifting off the wall, or shrinking and tipping over the trash
    const ease = 1 - Math.exp(-dt * 16);
    g.lift += ((g.overTrash ? 0.6 : 1.05) - g.lift) * ease;
    g.tip += ((g.overTrash ? -8 : 0) - g.tip) * ease;
    placeUnderPointer();
    g.frame = requestAnimationFrame(carry);
  }

  function placeUnderPointer() {
    // the same move for the held note and anything carried with it
    const dx = g.x - g.startX;
    const dy = g.y - g.startY;
    const turn = (g.swing + g.tip).toFixed(2);
    for (const el of g.group) {
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${el.dataset.rot}) rotate(${turn}deg) scale(${g.lift.toFixed(3)})`;
    }
  }

  function onUp(e) {
    if (!g || e.pointerId !== g.pointerId) return;
    const { el, mode, overTrash, target, group: carried, swing, lift } = g;
    const dx = g.x - g.startX;
    const dy = g.y - g.startY;
    const x = g.x - g.grabX;
    const y = g.y - g.grabY;
    end();

    if (mode === 'dragging') swallowNextClick(); // a drop is not a tap
    if (mode === 'dragging' && target) onStackHover(null);
    if (mode === 'dragging' && overTrash) { release(carried); onTrash(el); }
    else if (mode === 'dragging' && target) { putDown(carried, dx, dy); onStack(el, target); }
    else if (mode === 'dragging') drop(el, x, y, carried, dx, dy, swing, lift);
    else if (mode === 'swiping' && Math.abs(dx) >= SWIPE_DISTANCE) onSwipe(el, dx);
    else if (mode === 'swiping') settle(el);
  }

  function onCancel(e) {
    if (!g || e.pointerId !== g.pointerId) return;
    const { el, mode, overTrash, target, group: carried } = g;
    end();
    if (overTrash) onTrashHover(false);
    if (target) onStackHover(null);
    if (mode === 'dragging') {
      release(carried);
      for (const one of carried) settle(one).then(() => one.classList.remove('is-dragging'));
    } else if (mode === 'swiping') settle(el);
  }

  /**
   * Stick it down right where it was let go: still swinging a little and
   * lifted, it's pressed flat onto the wall and settles with a spring.
   */
  function drop(el, x, y, carried, dx, dy, swing = 0, lift = 1.05) {
    putDown(carried.filter((one) => one !== el), dx, dy);
    release([el]);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const rot = rotOf(el);
    const from = `rotate(${rot}) rotate(${swing.toFixed(2)}deg) scale(${lift.toFixed(3)})`;
    el.style.transform = '';
    onDrop(el, x, y);
    const { easing, duration } = spring(SPRINGS.settle);
    el.animate(
      [{ transform: from }, { transform: `rotate(${rot})` }],
      { duration: reduced() ? 0 : duration, easing },
    ).finished.finally(() => el.classList.remove('is-dragging'));
  }

  /** Leave notes where they were carried to (the wall then glides them into place). */
  function putDown(notes, dx, dy) {
    for (const one of notes) {
      one.style.left = `${one.offsetLeft + dx}px`;
      one.style.top = `${one.offsetTop + dy}px`;
      one.style.transform = '';
      release([one]);
      one.classList.remove('is-dragging');
    }
  }

  /** Done carrying: back to their own stacking (ui.js sets it on the next render). */
  function release(notes) {
    for (const one of notes) {
      one.classList.remove('is-over-trash', 'is-carried');
      delete one.dataset.rot;
    }
  }

  function end() {
    clearTimeout(g.timer);
    cancelAnimationFrame(g.frame);
    if (g.mode === 'dragging') onDragging(false);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    g = null;
  }
}

function reduced() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The click that follows letting go of a drag shouldn't count as a tap on the note. */
function swallowNextClick() {
  const swallow = (event) => event.stopPropagation();
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}
