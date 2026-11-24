// done.js — visible progress: a small counter in the top bar, and the list of
// what was finished today (with a way to put a note back).

import { getState, subscribe, doneItems, restoreDone } from './store.js';
import { dropIn } from './ui.js';
import { bumpPile } from './later.js';
import { t } from './strings.js';

const chip = document.getElementById('done-chip');
const chipText = document.getElementById('done-count');
const panel = document.getElementById('done-panel');
const list = document.getElementById('done-list');

const ICON_BACK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4 2.5 7.5 6 11M3 7.5h6.5a4 4 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -2.5)"/></svg>';

export function initDone() {
  subscribe(render);
  render(getState());
  list.addEventListener('click', onListClick);
  // The day may have rolled over while the app sat open.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render(getState());
  });
}

function render() {
  const items = doneItems();
  chip.hidden = items.length === 0;
  chipText.textContent = t('doneChip', { n: items.length });
  // on a phone the chip shows just the tick and the number (styles.css)
  chip.dataset.n = String(items.length);
  chip.setAttribute('aria-label', chipText.textContent);
  if (!items.length && panel.matches(':popover-open')) panel.hidePopover();
  list.replaceChildren(...items.map(doneItem));
}

function doneItem(note) {
  const item = document.createElement('li');
  item.className = 'done-item';
  item.dataset.id = note.id;

  const text = document.createElement('span');
  text.className = 'done-text';
  text.textContent = note.text;

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'done-back';
  back.setAttribute('aria-label', t('putBack', { text: note.text }));
  back.innerHTML = ICON_BACK;

  item.append(text, back);
  return item;
}

function onListClick(event) {
  const item = event.target.closest('.done-item');
  if (!item || !event.target.closest('.done-back')) return;

  const place = restoreDone(item.dataset.id);
  if (place === 'wall') dropIn(item.dataset.id);
  else if (place === 'later') bumpPile();
  list.querySelector('.done-back')?.focus({ preventScroll: true });
}
