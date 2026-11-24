// days.js — Wall, Today and Tomorrow: three ways to look at your notes.
//
// The switch in the top bar (V goes round them):
//   Wall      the board of sticky notes (ui.js).
//   Today     today's sticky notes, laid out neatly in a row-by-row board:
//             what's on the wall, then what's waiting in Later, then what's
//             done today (ticked, faded). Tick one off, open it in Focus, or
//             put it aside for tomorrow.
//   Tomorrow  sticky notes put aside for tomorrow. Anything typed while it's showing
//             goes here. Tomorrow morning they come onto the wall by
//             themselves (store.js). Bring one back to today, edit or delete it.

import {
  getState, subscribe, setSetting, doneItems, restoreDone, tomorrowItems, backToToday,
  removeTomorrow, updateTomorrow, reorderTomorrow, moveToTomorrow,
} from './store.js';
import { noteActions } from './ui.js';
import { offerUndo, announce, isTyping } from './feedback.js';
import { spring, SPRINGS } from './motion.js';
import { pick, slap } from './sound.js';
import { t, formatMinutes } from './strings.js';
import { todayKey, addDays, longDate } from './time.js';

const VIEWS = ['wall', 'today', 'tomorrow'];

const viewSwitch = document.getElementById('view-switch');
const todayView = document.getElementById('today-view');
const tomorrowView = document.getElementById('tomorrow-view');
const todayDate = document.getElementById('today-view-date');
const todaySummary = document.getElementById('today-view-summary');
const todayProgress = document.getElementById('today-view-progress');
const todayList = document.getElementById('today-list');
const laterBlock = document.getElementById('today-later');
const laterList = document.getElementById('today-later-list');
const doneBlock = document.getElementById('today-done');
const doneList = document.getElementById('today-done-list');
const todayEmpty = document.getElementById('today-empty');
const tomorrowDate = document.getElementById('tomorrow-view-date');
const tomorrowSummary = document.getElementById('tomorrow-view-summary');
const tomorrowList = document.getElementById('tomorrow-list');
const tomorrowEmpty = document.getElementById('tomorrow-empty');
const captureInput = document.getElementById('capture-input');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Row elements by key, reused between drawings so moves can glide. */
const rows = new Map();

export function initDays() {
  // The logo is the way home: back to the wall, back to the top.
  document.getElementById('brand')?.addEventListener('click', goHome);
  viewSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) setView(button.dataset.view);
  });
  todayView.addEventListener('click', onTodayClick);
  tomorrowView.addEventListener('click', onTomorrowClick);
  tomorrowView.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.day-row');
    if (row && !event.target.closest('button')) startEdit(row);
  });
  document.addEventListener('keydown', onKey);
  // scrolled down a list: the top bar frosts over (styles.css)
  window.addEventListener('scroll', () => document.body.classList.toggle('is-scrolled', window.scrollY > 6), { passive: true });
  subscribe(() => { if (current() !== 'wall') render(); });
  // past midnight the dates move on
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current() !== 'wall') render(); });

  const saved = getState().settings.view;
  apply(VIEWS.includes(saved) ? saved : 'wall', false);
}

// ---------- Switching ----------

function current() {
  return document.body.dataset.view || 'wall';
}

/** Show 'wall', 'today' or 'tomorrow'. Remembered for next time. */
export function setView(view) {
  if (!VIEWS.includes(view)) view = 'wall';
  if (view === current()) return;
  apply(view, true);
  if (getState().settings.view !== view) setSetting('view', view);
}

/** Tap the logo: the wall, scrolled to the top, with a little hop of the note. */
function goHome() {
  const mark = document.querySelector('#brand svg');
  mark?.animate([
    { transform: 'none' },
    { transform: 'translateY(-4px) rotate(-8deg) scale(1.1)' },
    { transform: 'none' },
  ], { duration: 420, easing: 'cubic-bezier(0.34, 1.5, 0.64, 1)' });
  document.dispatchEvent(new CustomEvent('stickly:home'));
  if (current() !== 'wall') setView('wall');
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, left: 0, behavior: smooth ? 'smooth' : 'auto' });
}

/** V: Wall → Today → Tomorrow → Wall. */
export function cycleView() {
  setView(VIEWS[(VIEWS.indexOf(current()) + 1) % VIEWS.length]);
}

function apply(view, animate) {
  const from = current();
  if (view === 'wall') delete document.body.dataset.view;
  else document.body.dataset.view = view;
  todayView.hidden = view !== 'today';
  tomorrowView.hidden = view !== 'tomorrow';
  for (const button of viewSwitch.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  viewSwitch.style.setProperty('--at', String(VIEWS.indexOf(view)));
  captureInput.placeholder = t(view === 'tomorrow' ? 'capturePlaceholderTomorrow' : 'capturePlaceholder');
  if (view !== 'wall') render(animate);
  if (animate) announce(viewName(view));
  if (!animate || reducedMotion.matches) return;
  window.scrollTo({ top: 0 });
  // the new view slides in from the side it sits on in the switch
  const direction = VIEWS.indexOf(view) > VIEWS.indexOf(from) ? 1 : -1;
  const shown = view === 'wall' ? document.getElementById('wall') : view === 'today' ? todayView : tomorrowView;
  shown.animate(
    [{ opacity: 0, transform: `translateX(${direction * 24}px)` }, { opacity: 1, transform: 'none' }],
    spring(SPRINGS.glide),
  );
}

// ---------- Drawing ----------

function render(entering = false) {
  if (current() === 'today') renderToday(entering);
  else if (current() === 'tomorrow') renderTomorrow(entering);
}

function renderToday(entering) {
  const { notes, later } = getState();
  const done = doneItems();
  todayDate.textContent = longDate(todayKey());
  const left = notes.reduce((sum, n) => sum + (n.minutes || 0), 0);
  todaySummary.textContent = [
    notes.length ? t('toDoCount', { n: notes.length }) : '',
    left ? t('timeLeft', { time: formatMinutes(left) }) : '',
    done.length ? t('doneCount', { n: done.length }) : '',
  ].filter(Boolean).join(' · ');
  const total = notes.length + done.length;
  todayProgress.style.setProperty('--done', total ? String(done.length / total) : '0');
  todayProgress.hidden = total === 0;

  const before = positions();
  fill(todayList, notes.map((n) => row(n, 'wall')));
  fill(laterList, later.map((n) => row(n, 'later')));
  fill(doneList, done.map((n) => row(n, 'done')));
  laterBlock.hidden = later.length === 0;
  doneBlock.hidden = done.length === 0;
  todayEmpty.hidden = notes.length + later.length + done.length > 0;
  settle(before, entering);
}

function renderTomorrow(entering) {
  const items = tomorrowItems();
  tomorrowDate.textContent = longDate(addDays(todayKey(), 1));
  const total = items.reduce((sum, n) => sum + (n.minutes || 0), 0);
  tomorrowSummary.textContent = [
    items.length ? t('tomorrowCount', { n: items.length }) : '',
    total ? formatMinutes(total) : '',
  ].filter(Boolean).join(' · ');
  const before = positions();
  fill(tomorrowList, items.map((n) => row(n, 'tomorrow')));
  tomorrowEmpty.hidden = items.length > 0;
  settle(before, entering);
}

/**
 * One note as a sticky: the same paper, color, tilt and curled corner as on
 * the wall, with its time on top, the text, and along the bottom a check to
 * tick it off and a few quiet actions.
 */
function row(note, kind) {
  const key = `${kind}:${note.id}`;
  let el = rows.get(key);
  if (!el) {
    el = document.createElement('li');
    el.className = 'day-row';
    el.dataset.key = key;
    el.tabIndex = 0;
    el.innerHTML = `
      <span class="day-sheet">
        <span class="day-time"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><path d="M6 3.4V6l1.7 1.1"/></svg><span></span></span>
        <span class="day-text"></span>
        <span class="day-foot">
          ${kind === 'tomorrow' ? '' : `<button class="day-check" type="button" tabindex="-1">${icon('<path d="m4 8.5 2.6 2.6L12 5.5"/>')}</button>`}
          <span class="day-actions">${actionsFor(kind)}</span>
        </span>
      </span>`;
    rows.set(key, el);
  }
  el.dataset.id = note.id;
  el.dataset.kind = kind;
  el.dataset.color = note.color;
  el.classList.toggle('is-pinned', Boolean(note.pinned));
  el.style.setProperty('--rot', `${note.rot || 0}deg`);
  if (!el.classList.contains('is-editing')) el.querySelector('.day-text').textContent = note.text;
  const time = el.querySelector('.day-time');
  time.hidden = !note.minutes;
  time.lastChild.textContent = note.minutes ? formatMinutes(note.minutes) : '';
  const check = el.querySelector('.day-check');
  if (check) check.setAttribute('aria-label', t(kind === 'done' ? 'putBackShort' : 'markDone'));
  for (const button of el.querySelectorAll('.day-act')) {
    button.setAttribute('aria-label', t(button.dataset.label));
    button.title = t(button.dataset.label);
  }
  el.setAttribute('aria-label', [note.text, note.minutes ? formatMinutes(note.minutes) : '', kind === 'done' ? t('done') : kind === 'later' ? t('later') : '']
    .filter(Boolean).join(', '));
  return el;
}

function actionsFor(kind) {
  const act = (name, label, path) => `<button class="day-act" type="button" tabindex="-1" data-act="${name}" data-label="${label}">${icon(path)}</button>`;
  const focus = act('focus', 'focus', '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>');
  const tomorrow = act('tomorrow', 'toTomorrow', '<path d="M6 3.5 10.5 8 6 12.5"/>');
  const today = act('today', 'backToTodayShort', '<path d="M10 3.5 5.5 8l4.5 4.5"/>');
  const trash = act('delete', 'delete', '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>');
  if (kind === 'done') return '';
  if (kind === 'tomorrow') return today + trash;
  return focus + tomorrow + trash;
}

/** Put rows in a list in order, reusing the ones already there. */
function fill(list, els) {
  const keys = new Set(els.map((el) => el.dataset.key));
  for (const el of [...list.children]) if (!keys.has(el.dataset.key)) el.remove();
  els.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null); });
  for (const [key, el] of rows) if (!el.isConnected) rows.delete(key);
}

function positions() {
  return new Map([...rows].map(([key, el]) => [el.dataset.id, el.isConnected ? el.getBoundingClientRect() : null]));
}

/**
 * Rows glide (on a spring) from where they were to where they are now; a
 * note ticked off slides down into Done. New rows rise in softly.
 */
function settle(before, entering) {
  if (reducedMotion.matches) return;
  let i = 0;
  for (const el of rows.values()) {
    if (!el.isConnected) continue;
    const to = el.getBoundingClientRect();
    const from = before.get(el.dataset.id);
    if (entering) {
      el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { ...spring(SPRINGS.settle), delay: i++ * 28, fill: 'backwards' });
    } else if (from && (Math.abs(from.top - to.top) > 1 || Math.abs(from.left - to.left) > 1)) {
      el.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], spring(SPRINGS.glide));
    } else if (!from) {
      el.animate([{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], spring(SPRINGS.pop));
    }
  }
}

// ---------- Doing things ----------

function onTodayClick(event) {
  const rowEl = event.target.closest('.day-row');
  if (!rowEl) return;
  const { id, kind } = rowEl.dataset;
  if (event.target.closest('.day-check')) {
    if (kind === 'done') putBack(id);
    else tick(rowEl, id);
    return;
  }
  const act = event.target.closest('.day-act')?.dataset.act;
  if (act) { run(act, rowEl, id); return; }
  if (kind !== 'done') noteActions.focus(id); // a tap on the row: focus on it
}

function onTomorrowClick(event) {
  const rowEl = event.target.closest('.day-row');
  if (!rowEl || rowEl.classList.contains('is-editing')) return;
  const act = event.target.closest('.day-act')?.dataset.act;
  if (act) run(act, rowEl, rowEl.dataset.id);
}

function run(act, rowEl, id) {
  if (act === 'focus') noteActions.focus(id);
  else if (act === 'tomorrow') leave(rowEl, 1).then(() => { if (moveToTomorrow(id)) offerUndo(t('movedToTomorrow'), 'later'); });
  else if (act === 'today') leave(rowEl, -1).then(() => bringBack(id));
  else if (act === 'delete') {
    if (rowEl.dataset.kind === 'tomorrow') leave(rowEl, 0).then(() => { if (removeTomorrow(id)) offerUndo(t('deleted'), 'trash'); });
    else leave(rowEl, 0).then(() => noteActions.remove(id));
  }
}

/** Tick a note off: the check fills, the text is struck through, and it slides down into Done. */
async function tick(rowEl, id) {
  if (rowEl.classList.contains('is-ticking')) return;
  rowEl.classList.add('is-ticking');
  pick();
  await wait(reducedMotion.matches ? 0 : 340);
  noteActions.done(id);
}

function putBack(id) {
  const place = restoreDone(id);
  if (place) { slap(); offerUndo(t(place === 'wall' ? 'restored' : 'addedToLater'), 'back'); }
}

function bringBack(id) {
  const place = backToToday(id);
  if (place) offerUndo(t(place === 'wall' ? 'restored' : 'addedToLater'), 'back');
}

/** A row slides out sideways (direction 1 right, −1 left, 0 just fades). */
function leave(rowEl, direction) {
  if (reducedMotion.matches) return Promise.resolve();
  rowEl.classList.add('is-leaving');
  return rowEl.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${direction * 40}px) scale(${direction ? 1 : 0.97})` }],
    { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
  ).finished.catch(() => {});
}

// ---------- Editing a note for tomorrow ----------

function startEdit(rowEl) {
  if (rowEl.dataset.kind !== 'tomorrow' || rowEl.classList.contains('is-editing')) return;
  const text = rowEl.querySelector('.day-text');
  rowEl.classList.add('is-editing');
  try { text.contentEditable = 'plaintext-only'; } catch { text.contentEditable = 'true'; }
  text.focus();
  const range = document.createRange();
  range.selectNodeContents(text);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  const finish = (save) => {
    text.removeEventListener('keydown', onEditKey);
    text.removeEventListener('blur', onBlur);
    text.removeAttribute('contenteditable');
    rowEl.classList.remove('is-editing');
    const value = text.innerText.trim();
    const note = tomorrowItems().find((n) => n.id === rowEl.dataset.id);
    if (save && value && note && value !== note.text) updateTomorrow(note.id, { text: value });
    else if (note) text.textContent = note.text;
  };
  const onEditKey = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true); rowEl.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); rowEl.focus(); }
  };
  const onBlur = () => finish(true);
  text.addEventListener('keydown', onEditKey);
  text.addEventListener('blur', onBlur);
}

// ---------- Keys ----------

function onKey(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || isTyping(event.target)) return;
  if (document.querySelector('dialog[open], .sweep, #menu:popover-open')) return;
  const key = event.key.toLowerCase();
  if (key === 'v' && !event.altKey) { event.preventDefault(); cycleView(); return; }
  if (current() === 'wall') return;
  const rowEl = event.target.closest?.('.day-row');
  if (!rowEl) return;
  const { id, kind } = rowEl.dataset;
  const list = rowEl.parentElement;
  if (key.startsWith('arrow')) {
    event.preventDefault();
    const forward = key === 'arrowdown' || key === 'arrowright';
    if (event.altKey && kind === 'tomorrow') {
      const index = [...list.children].indexOf(rowEl);
      reorderTomorrow(id, index + (forward ? 1 : -1));
      requestAnimationFrame(() => rows.get(`tomorrow:${id}`)?.focus());
      return;
    }
    // ← → the next note along; ↑ ↓ the note above or below on the board
    const all = [...document.querySelectorAll(`#${current()}-view .day-row`)];
    if (key === 'arrowleft' || key === 'arrowright') { all[all.indexOf(rowEl) + (forward ? 1 : -1)]?.focus(); return; }
    const box = rowEl.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const candidates = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return forward ? r.top > box.bottom - 4 : r.bottom < box.top + 4;
    });
    const nearest = (els) => els.sort((p, q) => {
      const a = p.getBoundingClientRect(); const c = q.getBoundingClientRect();
      return (Math.abs(a.top - box.top) - Math.abs(c.top - box.top)) * 4 + Math.abs(a.left + a.width / 2 - x) - Math.abs(c.left + c.width / 2 - x);
    })[0];
    nearest(candidates)?.focus();
    return;
  }
  if (event.altKey) return;
  if (kind === 'tomorrow') {
    if (key === 'enter') { event.preventDefault(); startEdit(rowEl); }
    else if (key === 't') { event.preventDefault(); run('today', rowEl, id); }
    else if (key === 'backspace' || key === 'delete') { event.preventDefault(); run('delete', rowEl, id); }
    return;
  }
  if (kind === 'done') {
    if (key === 'd' || key === ' ' || key === 'enter') { event.preventDefault(); putBack(id); }
    return;
  }
  if (key === 'd' || key === ' ') { event.preventDefault(); tick(rowEl, id); }
  else if (key === 'f' || key === 'enter') { event.preventDefault(); noteActions.focus(id); }
  else if (key === 'm') { event.preventDefault(); run('tomorrow', rowEl, id); }
  else if (key === 'backspace' || key === 'delete') { event.preventDefault(); run('delete', rowEl, id); }
}

// ---------- Helpers ----------

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function icon(path) {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/** The view's name, for screen readers. */
function viewName(view) {
  return t(view === 'today' ? 'viewToday' : view === 'tomorrow' ? 'viewTomorrow' : 'viewWall');
}
