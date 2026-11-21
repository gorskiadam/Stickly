// motion.js — the few physical animations, in one place.
// Everything goes through duration(), so "reduce motion" turns it all off.

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const EASE_OUT = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

// ---------- Springs ----------
// Real things don't move on a curve someone picked; they're pushed by a
// force and slowed by friction. spring() works out how a mass on a spring
// settles and turns it into a CSS linear() easing, so a note lands with the
// small give of paper being pressed onto a wall, instead of a canned ease.

const springCache = new Map();
const hasLinear = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)');

/**
 * { easing, duration } for a spring from 0 to 1.
 * stiffness: how hard it pulls; damping: how quickly it calms down.
 */
export function spring({ stiffness = 260, damping = 24, mass = 1 } = {}) {
  const key = `${stiffness}/${damping}/${mass}`;
  if (springCache.has(key)) return springCache.get(key);
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const at = (t) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  };
  // how long until it is still (within a tenth of a percent)
  let end = 0.1;
  for (let t = 0.05; t < 3; t += 1 / 120) {
    end = t;
    if (Math.abs(1 - at(t)) < 0.001 && Math.abs(1 - at(t + 0.05)) < 0.001) break;
  }
  const steps = 44;
  const points = [];
  for (let i = 0; i <= steps; i++) points.push(+at((i / steps) * end).toFixed(4));
  points[steps] = 1;
  const result = {
    easing: hasLinear ? `linear(${points.join(', ')})` : EASE_OUT,
    duration: Math.round(end * 1000),
  };
  springCache.set(key, result);
  return result;
}

/** Springs used across the app: a soft settle, a lively pop, a heavy glide. */
export const SPRINGS = {
  settle: { stiffness: 320, damping: 26 },  // a note pressed onto the wall
  pop: { stiffness: 420, damping: 24 },     // small things appearing (toast, card)
  glide: { stiffness: 170, damping: 24 },   // notes sliding to a new place
};

// The stylesheet uses the same springs (var(--spring-settle) and friends).
for (const name of Object.keys(SPRINGS)) {
  document.documentElement.style.setProperty(`--spring-${name}`, spring(SPRINGS[name]).easing);
}

function duration(ms) {
  return reducedMotion.matches ? 0 : ms;
}

/** 'smooth' normally, 'auto' (instant) when the user asked for less motion. */
export function scrollBehavior() {
  return reducedMotion.matches ? 'auto' : 'smooth';
}

/** A note's resting tilt as a CSS angle, e.g. "-0.8deg". */
export function rotOf(el) {
  return el.style.getPropertyValue('--rot') || '0deg';
}

/**
 * Run `mutate` (which changes the layout), then glide every element from where
 * it was to where it now is, instead of letting it jump. `skip` is left alone.
 */
export function flip(elements, mutate, skip = null) {
  const before = elements.map((el) => [el, el.offsetLeft, el.offsetTop]);
  mutate();

  for (const [el, x, y] of before) {
    if (el === skip || !el.isConnected) continue;
    const dx = x - el.offsetLeft;
    const dy = y - el.offsetTop;
    if (!dx && !dy) continue;
    const rot = rotOf(el);
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) rotate(${rot})` }, { transform: `rotate(${rot})` }],
      { duration: duration(spring(SPRINGS.glide).duration), easing: spring(SPRINGS.glide).easing },
    );
  }
}

/**
 * A finished note leaves the wall: its corner curls right up, then the whole
 * note lifts and flies away. `fromX` continues a swipe and sets the direction.
 */
export function flyAway(el, fromX = 0) {
  const rot = parseFloat(rotOf(el)) || 0;
  const side = fromX < 0 ? -1 : 1;
  const frame = (x, y, r, scale) => `translate(${x}px, ${y}px) rotate(${r}deg) scale(${scale})`;

  return finished(el.animate(
    [
      // --fold is the size of the curled corner (see styles.css)
      { transform: frame(fromX, 0, rot, 1), '--fold': '24px', opacity: 1, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
      { transform: frame(fromX, -8, rot - 2 * side, 1.03), '--fold': '104px', opacity: 1, offset: 0.36, easing: 'cubic-bezier(0.5, 0, 0.9, 0.6)' },
      { transform: frame(fromX + 190 * side, -330, rot + 26 * side, 0.7), '--fold': '150px', opacity: 0 },
    ],
    { duration: duration(680), fill: 'forwards' },
  ));
}

/** Quietly fade a deleted note. */
export function fadeOut(el) {
  const rot = rotOf(el);
  return finished(el.animate(
    [
      { transform: `rotate(${rot}) scale(1)`, opacity: 1 },
      { transform: `rotate(${rot}) scale(0.96)`, opacity: 0 },
    ],
    { duration: duration(140), easing: 'ease-out', fill: 'forwards' },
  ));
}

/** Let go of a dragged or swiped note: glide from its inline transform back to rest. */
export function settle(el) {
  const from = el.style.transform;
  el.style.transform = '';
  if (!from) return Promise.resolve();
  const { easing, duration: time } = spring(SPRINGS.settle);
  return finished(el.animate(
    [{ transform: from }, { transform: `rotate(${rotOf(el)})` }],
    { duration: duration(time), easing },
  ));
}

/** Resolve when an animation ends, even if it was cancelled. */
function finished(animation) {
  return animation.finished.catch(() => {});
}
