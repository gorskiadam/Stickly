// sweep.js — the end-of-day sweep, a small closing ritual.
// Today's finished notes appear as a little stack in the middle of the page,
// then fly off one by one, and a quiet card says how the day went.
// The "Done today" list is cleared (with undo); notes still on the wall stay.

import { doneItems, clearDone } from './store.js';
import { offerUndo } from './feedback.js';
import { sweep as sweepSound, chime } from './sound.js';
import { t, formatMinutes } from './strings.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/** At most this many notes fly; the summary still counts them all. */
const MAX_SHOWN = 12;

let running = false;

/**
 * Run the sweep. By default it ends today; the good-morning card passes
 * yesterday's finished notes with `yesterday: true`. Resolves when the
 * summary card is closed.
 */
export async function endTheDay({ items = doneItems(), yesterday = false } = {}) {
  if (running) return;
  running = true;
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  const layer = document.createElement('div');
  layer.className = 'sweep';
  document.body.append(layer);
  let cleared = false;
  let isClosed = false;
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    if (cleared) offerUndo(t('doneCleared'), 'done');
    layer.classList.add('is-closing');
    setTimeout(() => layer.remove(), ms(220));
    document.removeEventListener('keydown', onKey);
    running = false;
    finish();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  if (items.length) await flyOff(layer, [...items].slice(0, MAX_SHOWN).reverse());
  // The finished notes have flown off for good: today's done list is emptied.
  cleared = clearDone() > 0;
  showSummary(layer, items, close, yesterday);
  return closed;
}

/** Stack the notes (oldest at the bottom), then send them off one at a time. */
async function flyOff(layer, notes) {
  const stack = document.createElement('div');
  stack.className = 'sweep-stack';
  layer.append(stack);

  const cards = notes.map((note, i) => {
    const card = document.createElement('div');
    card.className = 'sweep-note';
    card.dataset.color = note.color;
    card.textContent = note.text;
    card.style.setProperty('--tilt', `${(Math.random() - 0.5) * 10}deg`);
    card.style.setProperty('--lift', `${-i * 2}px`);
    stack.append(card);
    card.animate(
      [{ transform: `translateY(-30px) rotate(var(--tilt)) scale(1.05)`, opacity: 0 }, { transform: `translateY(var(--lift)) rotate(var(--tilt))`, opacity: 1 }],
      { duration: ms(260), delay: ms(i * 60), easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' },
    );
    return card;
  });
  await wait(ms(380 + notes.length * 60));

  // Top of the stack first, alternating sides, a little quicker each time.
  const flights = [];
  for (let i = cards.length - 1, step = 0; i >= 0; i--, step++) {
    const card = cards[i];
    const side = step % 2 ? -1 : 1;
    sweepSound(step);
    flights.push(card.animate(
      [
        { transform: `translateY(var(--lift)) rotate(var(--tilt))`, opacity: 1 },
        { transform: `translate(${side * 14}px, -14px) rotate(calc(var(--tilt) + ${side * -4}deg)) scale(1.04)`, opacity: 1, offset: 0.25 },
        { transform: `translate(${side * 520}px, -380px) rotate(${side * 38}deg) scale(0.7)`, opacity: 0 },
      ],
      { duration: ms(620), easing: 'cubic-bezier(0.5, 0, 0.75, 0.4)', fill: 'forwards' },
    ).finished);
    await wait(ms(Math.max(240, 400 - step * 18)));
  }
  await Promise.all(flights);
  stack.remove();
}

function showSummary(layer, items, close, yesterday) {
  const minutes = items.reduce((sum, n) => sum + (n.minutes || 0), 0);
  const card = document.createElement('div');
  card.className = 'sweep-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'sweep-title');

  const count = document.createElement('p');
  count.className = 'sweep-count';
  count.textContent = String(items.length);
  const title = document.createElement('p');
  title.id = 'sweep-title';
  title.className = 'sweep-title';
  title.textContent = items.length
    ? t(items.length === 1 ? `sweepOne${yesterday ? 'Yesterday' : ''}` : `sweepMany${yesterday ? 'Yesterday' : ''}`, { n: items.length })
    : t('sweepNone');
  card.append(...(items.length ? [count] : []), title);

  if (minutes) {
    const time = document.createElement('p');
    time.className = 'sweep-time';
    time.textContent = t('sweepTime', { time: formatMinutes(minutes) });
    card.append(time);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button-primary';
  button.textContent = t('sweepClose');
  button.addEventListener('click', close);
  card.append(button);

  layer.append(card);
  layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
  if (items.length) chime();
  button.focus({ preventScroll: true });
}

function wait(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function ms(value) {
  return reducedMotion.matches ? 0 : value;
}
