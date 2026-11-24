// trash.js — the grey trash can in the bottom-left corner, and the ways in:
//   throwAway(): a note crumples into a ball and is tossed into the can. Every way of
//                deleting a note ends like this.
//   tossTo():    a note shrinks and arcs onto another spot (the Later pile).
// The trash can grows and opens when something is on its way, then slams its
// lid shut once. While a note is dragged, a strip along the left edge also
// counts as the trash (see drag.js).

import { rotOf } from './motion.js';
import { crumple, slam, binOpen, thud } from './sound.js';
import { crumpleShapes, creaseImage } from './paper.js';
import { dropZoneWidth } from './drag.js';

const bin = document.getElementById('trash');
const zone = document.getElementById('drop-zone');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** How big the crumpled ball is, in pixels. */
const BALL_SIZE = 50;
/** How long a ball is in the air. */
const THROW_MS = 700;

export function trashElement() {
  return bin;
}

/** Lid open (something is coming) or closed. Stays open while balls are on their way. */
export function setTrashOpen(open) {
  if (!open && incoming > 0) return;
  if (open && !bin.classList.contains('is-open')) binOpen();
  bin.classList.toggle('is-open', open);
  zone.classList.toggle('is-hot', open && zone.classList.contains('is-awake'));
}

// ---------- Several at once ----------
// Every ball on its way is counted. The lid opens for the first one and stays
// open, upright, until the last one is in; each landing in between only
// thuds the can. A moment after the last one, the lid comes down once.

let incoming = 0;
let closeTimer = 0;
let slots = 0; // balls thrown in this round, so they heap up a little

/** A ball is on its way: open up (or stay open). Returns its place in the round. */
export function expectBall() {
  clearTimeout(closeTimer);
  incoming += 1;
  // the lid was coming down: catch it and swing it back up
  if (bin.classList.contains('is-chomping')) {
    bin.classList.remove('is-chomping');
    bin.querySelector('.trash-lid').getAnimations().forEach((a) => a.cancel());
  }
  setTrashOpen(true);
  return incoming - 1;
}

/** Where the next ball comes to rest: a little higher as they heap up, a little to one side. */
export function restingSpot(can, size) {
  const k = slots++;
  return {
    x: can.mouth.x + [0, -5, 5, -2, 3][k % 5],
    floor: can.floor - size / 2 - Math.min(10, k * 2.5),
  };
}

/** A ball hit the bottom. The last one in brings the lid down. */
export function ballLanded() {
  incoming = Math.max(0, incoming - 1);
  if (incoming > 0) {
    thump();
    return;
  }
  thud();
  thump();
  // a short beat, in case another is already being crumpled
  closeTimer = setTimeout(() => {
    if (incoming > 0) return;
    slots = 0;
    eat(false);
  }, ms(170));
}

/** The can takes a small knock (a ball landed, the lid is still open). */
function thump() {
  if (reducedMotion.matches) return;
  bin.querySelector('.trash-can').animate([
    { transform: 'none' },
    { transform: 'scale(1.04, 0.95)', offset: 0.3 },
    { transform: 'scale(0.99, 1.02)', offset: 0.65 },
    { transform: 'none' },
  ], { duration: 260, easing: 'ease-out' });
}

/** While any note is being dragged, the trash can stirs so it can be found. */
export function setTrashAwake(awake) {
  bin.classList.toggle('is-awake', awake);
  zone.style.setProperty('--zone', `${dropZoneWidth()}px`);
  zone.classList.toggle('is-awake', awake);
  document.body.classList.toggle('is-carrying', awake);
  if (!awake) zone.classList.remove('is-hot');
}

/**
 * Crumple a note into a ball and throw it into the trash.
 * The real note is hidden at once; a copy does the flying. Resolves on landing.
 */
export async function throwAway(el) {
  const { flight, paper, start, rot, scale, width } = lift(el);
  const seed = Math.random() * 1e9;
  const shape = crumpleShapes(seed);
  const creases = document.createElement('span');
  creases.className = 'throw-creases';
  creases.style.backgroundImage = creaseImage(seed);
  paper.append(creases);

  // 1. Crumple where it is, the way hands do it: a first squeeze that folds
  //    the sheet, a little give, a harder squeeze, then packed into a ball.
  //    The creases deepen with each squeeze. The can opens, ready to catch it.
  const duration = ms(560);
  crumple(duration / 1000);
  expectBall();
  const ball = BALL_SIZE / width;
  const s = (k) => scale + (ball - scale) * k;
  const crumpling = paper.animate([
    { transform: `rotate(${rot}deg) scale(${scale})`, clipPath: shape.at(0) },
    { transform: `rotate(${rot + 5}deg) scale(${s(0.22)}, ${s(0.32)})`, clipPath: shape.at(0.3), offset: 0.2, easing: 'ease-out' },
    { transform: `rotate(${rot + 3}deg) scale(${s(0.18)}, ${s(0.26)})`, clipPath: shape.at(0.27), offset: 0.3, easing: 'ease-in' },
    { transform: `rotate(${rot - 9}deg) scale(${s(0.6)}, ${s(0.52)})`, clipPath: shape.at(0.64), offset: 0.55, easing: 'ease-out' },
    { transform: `rotate(${rot - 6}deg) scale(${s(0.55)}, ${s(0.5)})`, clipPath: shape.at(0.6), offset: 0.64, easing: 'ease-in' },
    { transform: `rotate(${rot - 24}deg) scale(${ball})`, clipPath: shape.at(1) },
  ], { duration, easing: 'cubic-bezier(0.4, 0, 0.3, 1)', fill: 'forwards' });
  creases.animate(
    [{ opacity: 0 }, { opacity: 0.55, offset: 0.22 }, { opacity: 0.85, offset: 0.58 }, { opacity: 1 }],
    { duration, fill: 'forwards' },
  );
  paper.querySelectorAll('.note-time, .note-text, .note-foot').forEach((part) => {
    part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms(260), fill: 'forwards' });
  });
  await crumpling.finished;

  // 2. Throw: an ordinary lob. It leaves the hand, rises a little, slows,
  //    and falls under gravity, faster and faster, dropping steeply past the
  //    open lid into the can. Sideways speed stays the same the whole way,
  //    the way a real ball flies; nothing swings or loops.
  // 3. In: past the rim it goes behind the can's front wall (out of sight,
  //    like a real can), keeps falling, and stops dead on the can's floor.
  //    That landing is what thumps the can and brings the lid down.
  const can = inside();
  const fit = Math.min(1, can.fit / BALL_SIZE); // squeezes through the opening
  const spot = restingSpot(can, BALL_SIZE * fit);
  const path = throwPath(start, { x: spot.x, y: can.mouth.y });
  const land = path.landAt(spot.floor);
  const time = ms(path.duration * land);
  can.layer.append(flight);
  paper.animate(
    [{ transform: `rotate(${rot - 24}deg) scale(${ball})` }, { transform: `rotate(${rot + 250}deg) scale(${ball * fit})` }],
    { duration: time, easing: 'linear', fill: 'forwards' },
  );
  await flight.animate(flightFrames(path, start, land), { duration: time, easing: 'linear', fill: 'forwards' }).finished;
  ballLanded(); // it hit the bottom: thump; the last one in brings the lid down
  // the ball stays in sight above the rim until the lid has covered it
  setTimeout(() => can.layer.remove(), ms(1100));
}

/**
 * Keyframes along a throw path, every frame of the way (so the speed changes
 * smoothly, as gravity has it), down to `end` (where it lands on the floor of
 * the can). `extra(u)` adds to each frame's transform.
 */
export function flightFrames(path, start, end = 1, extra = () => '') {
  const frames = [];
  const steps = Math.max(12, Math.round(56 * end));
  for (let k = 0; k <= steps; k++) {
    const u = (k / steps) * end;
    const { x, y } = path(u);
    frames.push({ transform: `translate(${(x - start.x).toFixed(1)}px, ${(y - start.y).toFixed(1)}px)${extra(u)}` });
  }
  return frames;
}

/**
 * The inside of the trash can, right now: a layer over the page with the
 * can's body cut out of it, so anything in the layer that falls below the
 * rim goes behind the can's front wall. Also where to aim (the mouth, a
 * touch right of the middle: the open lid stands upright on the left), where the
 * floor is, and how wide a ball can be to fit through.
 * The caller puts the flying balls in `layer` and removes it afterwards.
 */
export function inside(shape = bin.querySelector('.trash-can'), aim = 0.58) {
  const body = shape.getBoundingClientRect();
  const rim = body.top + 1;
  const left = body.left + 2;
  const right = body.right - 2;
  const layer = document.createElement('div');
  layer.className = 'throw-layer';
  // the whole screen, with a hole the shape of the can below its rim (evenodd)
  layer.style.clipPath = `polygon(evenodd, 0 0, 100vw 0, 100vw 100vh, 0 100vh, 0 0, ${left}px ${rim}px, ${right}px ${rim}px, ${right}px 100vh, ${left}px 100vh, ${left}px ${rim}px)`;
  document.body.append(layer);
  return {
    layer,
    mouth: { x: body.left + body.width * aim, y: rim }, // (the bin's: right of the upright lid)
    floor: body.bottom - 3,
    fit: (right - left) * 0.8,
  };
}

/** One slam of the lid, then the trash can shrinks back to its corner. */
export function eat(withThump = true) {
  slam(withThump);
  bin.classList.add('is-chomping');
  bin.classList.remove('is-open');
  const lid = bin.querySelector('.trash-lid');
  const finish = () => bin.classList.remove('is-chomping');
  if (reducedMotion.matches) finish();
  else lid.addEventListener('animationend', finish, { once: true });
}

/** Shrink a note and arc it onto `targetEl` (used to send a note to Later). */
export async function tossTo(el, targetEl) {
  const { flight, paper, start, rot, scale, width } = lift(el);
  const box = targetEl.getBoundingClientRect();
  const target = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const end = (box.width * 0.9) / width;

  paper.animate(
    [{ transform: `rotate(${rot}deg) scale(${scale})` }, { transform: `rotate(${rot - 8}deg) scale(${end})`, opacity: 0.6 }],
    { duration: ms(560), easing: 'cubic-bezier(0.3, 0, 0.3, 1)', fill: 'forwards' },
  );
  await arc(flight, start, target, ms(560));
  flight.remove();
}

// ---------- Helpers ----------

/**
 * Hide the real note and put a free-flying copy of its paper exactly where it is.
 * Returns the copy and where it started.
 */
export function lift(el) {
  const box = el.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const rot = parseFloat(rotOf(el)) || 0;
  // A note being dragged is shown smaller; keep that size for the throw.
  const scale = Math.min(1.1, box.width / (width * Math.cos((rot * Math.PI) / 180) + height * Math.abs(Math.sin((rot * Math.PI) / 180))));

  const flight = document.createElement('div');
  flight.className = 'throw';
  flight.style.left = `${start.x}px`;
  flight.style.top = `${start.y}px`;

  const paper = el.querySelector('.note-paper').cloneNode(true);
  paper.classList.add('throw-paper');
  paper.style.width = `${width}px`;
  paper.style.height = `${height}px`;
  paper.style.margin = `${-height / 2}px 0 0 ${-width / 2}px`;
  // The paper's color and corner come from the note around it; carry them over.
  const style = getComputedStyle(el);
  for (const name of ['--paper', '--radius', '--fold']) paper.style.setProperty(name, style.getPropertyValue(name));

  flight.append(paper);
  document.body.append(flight);
  el.style.visibility = 'hidden';
  return { flight, paper, start, rot, scale, width, height };
}

/** Move `flight` along a throwing arc from `start` to `target` (viewport points). */
function arc(flight, start, target, duration) {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const height = Math.min(280, 80 + Math.hypot(dx, dy) * 0.3);
  const frames = [];
  for (let i = 0; i <= 20; i++) {
    const p = i / 20;
    frames.push({ transform: `translate(${dx * p}px, ${dy * p - height * 4 * p * (1 - p)}px)` });
  }
  return flight.animate(frames, { duration, easing: 'cubic-bezier(0.32, 0.1, 0.6, 1)', fill: 'forwards' }).finished;
}

/**
 * The way a ball is thrown into the trash: plain projectile motion. Sideways
 * it moves at one steady speed; up and down it's gravity: it rises, slows,
 * and falls faster and faster. The lob is made high enough that it comes
 * down steeply at the end, so it drops into the can past the open lid
 * instead of flying into it. `i` lifts each of several balls a little more.
 * Returns u (0 = thrown, 1 = at the rim; more carries on falling) → { x, y },
 * with `duration` (ms) from how far it falls.
 */
export function throwPath(from, to, i = 0) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // y = from.y + b·u + a·u²: a parabola through both ends that just reaches `top`
  const solve = (rise) => {
    const b = -2 * (rise + Math.sqrt(Math.max(0, rise * rise + rise * dy)));
    return { b, a: dy - b };
  };
  // start with a soft lob, and raise it until the fall at the end is steep
  // (at least twice as fast down as sideways), so it clears the lid
  const highest = Math.max(20, from.y - 30);
  let rise = Math.min(highest, 50 + Math.abs(dx) * 0.12 + i * 6);
  let { a, b } = solve(rise);
  while (b + 2 * a < 2 * Math.abs(dx) && rise < highest) {
    rise = Math.min(highest, rise + 20);
    ({ a, b } = solve(rise));
  }
  const gravity = 3000; // px/s² on screen: sets how long it's in the air
  const duration = Math.round(Math.min(1000, Math.max(460, Math.sqrt((2 * a) / gravity) * 1000)));
  const fn = (u) => ({
    // past the rim it's inside the can: the walls take the sideways speed away
    x: u <= 1 ? from.x + dx * u : to.x, // inside the can it falls straight down
    y: from.y + b * u + a * u * u,
  });
  fn.duration = duration;
  /** When (u, past 1) it reaches height `y` on the way down: the floor of the can. */
  fn.landAt = (y) => {
    const c = from.y - y;
    const root = Math.sqrt(Math.max(0, b * b - 4 * a * c));
    return Math.max(1, (-b + root) / (2 * a));
  };
  return fn;
}



function ms(value) {
  return reducedMotion.matches ? 0 : value;
}
