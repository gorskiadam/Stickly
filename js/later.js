// later.js — the "Later" pile: a small stack in the corner showing only a count,
// and the panel that opens from it to bring notes onto the wall.

import { getState, subscribe, hasSpace, promoteNote, removeNote } from './store.js';
import { dropIn } from './ui.js';
import { offerUndo } from './feedback.js';
import { t } from './strings.js';

const pile = document.getElementById('pile');
const pileCount = document.getElementById('pile-count');
const panel = document.getElementById('later');
const hint = document.getElementById('later-hint');
const list = document.getElementById('later-list');
const captureInput = document.getElementById('capture-input');

const ICON_UP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

export function initLater() {
  subscribe(render);
  render(getState());
  list.addEventListener('click', onListClick);
  pile.addEventListener('animationend', () => pile.classList.remove('is-bumped'));
}

/** A small lift of the pile, so a note sent there is seen to land. */
export function bumpPile() {
  pile.classList.remove('is-bumped');
  void pile.offsetWidth; // restart the animation if it is already running
  pile.classList.add('is-bumped');
}

// ---------- Rendering ----------

function render(state) {
  const count = state.later.length;
  pile.hidden = count === 0;
  pileCount.textContent = `+${count}`;
  pile.setAttribute('aria-label', t('laterCount', { n: count }));
  if (count === 0) closePanel();

  const space = hasSpace();
  hint.textContent = t(space ? 'laterHintSpace' : 'laterHintFull');
  list.replaceChildren(...state.later.map((note) => laterItem(note, space)));
}

function laterItem(note, space) {
  const item = document.createElement('li');
  item.className = 'later-item';
  item.dataset.id = note.id;
  item.style.setProperty('--paper', `var(--paper-${note.color})`);

  const promote = document.createElement('button');
  promote.type = 'button';
  promote.className = 'later-promote';
  promote.disabled = !space;
  promote.setAttribute('aria-label', t('moveToWall', { text: note.text }));
  promote.innerHTML = `<span class="later-text"></span>${ICON_UP}`;
  promote.querySelector('.later-text').textContent = note.text;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'later-remove';
  remove.setAttribute('aria-label', t('deleteNote', { text: note.text }));
  remove.innerHTML = ICON_REMOVE;

  item.append(promote, remove);
  return item;
}

// ---------- Actions ----------

function onListClick(event) {
  const item = event.target.closest('.later-item');
  if (!item) return;
  const { id } = item.dataset;

  if (event.target.closest('.later-promote')) promote(id);
  else if (event.target.closest('.later-remove')) remove(id);
}

function promote(id) {
  if (!promoteNote(id)) return;
  dropIn(id);
  keepFocusInPanel();
}

function remove(id) {
  const removed = removeNote(id);
  if (!removed) return;
  keepFocusInPanel();
  offerUndo(t('deleted'), 'trash');
}

/** The list was redrawn; put focus on the next thing the user can act on. */
function keepFocusInPanel() {
  if (!panel.matches(':popover-open')) {
    captureInput.focus({ preventScroll: true });
    return;
  }
  const next = list.querySelector('.later-promote:not(:disabled)') || list.querySelector('.later-remove');
  if (next) next.focus({ preventScroll: true });
}

function closePanel() {
  if (panel.matches(':popover-open')) panel.hidePopover();
}
