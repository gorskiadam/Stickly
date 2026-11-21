// menu.js — Stickly's own right-click menu.
//
// On a note: edit, done, focus, pin, color, time, move to tomorrow, move to Later, delete.
// Anywhere else on the page: new note, undo, redo, theme, settings.
// In text (the capture bar, a note being edited) the browser's own menu stays,
// so copy and paste keep working. The ContextMenu key and Shift+F10 open it
// for the focused note; arrow keys move through it; Esc closes it.

import { getState, setColor, setTheme, canUndo, canRedo, doneItems, COLORS } from './store.js';
import { noteActions, tidyWall } from './ui.js';
import { askWhatNow } from './whatnow.js';
import { endTheDay } from './sweep.js';
import { cycleView } from './days.js';
import { stepBack, stepForward } from './feedback.js';
import { t, formatMinutes } from './strings.js';

const menu = document.getElementById('menu');
const captureInput = document.getElementById('capture-input');
const settingsPanel = document.getElementById('settings');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

/** Small line icons for the menu, 16×16. */
const ICONS = {
  edit: '<path d="M10.5 3.5 12.5 5.5M4 12l.6-2.6 6.6-6.6 2 2-6.6 6.6z"/>',
  done: '<path d="m3.5 8.5 3 3 6-7"/>',
  focus: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  pin: '<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>',
  later: '<path d="M3 5h10M3 8h10M3 11h6"/><path d="m11 10.5 2 1.5-2 1.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  add: '<path d="M8 3.5v9M3.5 8h9"/>',
  undo: '<path d="M5.5 4 3 6.5 5.5 9"/><path d="M3 6.5h6.5a3 3 0 0 1 0 6H7"/>',
  redo: '<path d="M10.5 4 13 6.5 10.5 9"/><path d="M13 6.5H6.5a3 3 0 0 0 0 6H9"/>',
  theme: '<circle cx="8" cy="8" r="5"/><path d="M8 3a5 5 0 0 0 0 10z" fill="currentColor"/>',
  tidy: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  spark: '<path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4M3.6 3.6l1.6 1.6M10.8 10.8l1.6 1.6M12.4 3.6l-1.6 1.6M5.2 10.8l-1.6 1.6"/>',
  moon: '<path d="M12.5 10A5 5 0 0 1 6 3.5a5 5 0 1 0 6.5 6.5z"/>',
  tomorrow: '<path d="M2.5 11.5h11M4.5 11.5a3.5 3.5 0 0 1 7 0M8 3.5v2M3.6 6.2l1.2 1M12.4 6.2l-1.2 1"/>',
  settings: '<path d="M3 5.5h5.5M11.5 5.5H13M3 10.5h1.5M7.5 10.5H13"/><circle cx="10" cy="5.5" r="1.5"/><circle cx="6" cy="10.5" r="1.5"/>',
};

export function initMenu() {
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('keydown', onMenuKey);
  menu.addEventListener('keydown', onNavigate);
  menu.addEventListener('click', onClick);
}

// The menu is a manual popover: it stays open after the right button is let
// go, and only closes on a click (inside or out), Escape, or the window
// changing. (The browser's own light dismiss counted the right button's
// release as a click outside, so the button had to be held down.)
function onOutsidePress(event) {
  if (!menu.contains(event.target)) close();
}
function onEscape(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  close();
}
function watchForDismiss(on) {
  const method = on ? 'addEventListener' : 'removeEventListener';
  document[method]('pointerdown', onOutsidePress, true);
  document[method]('keydown', onEscape, true);
  window[method]('resize', close);
  window[method]('blur', close);
  window[method]('scroll', close, true);
}

// ---------- Opening ----------

function onContextMenu(event) {
  const target = event.target;
  // Text keeps the browser's menu (copy, paste, spelling).
  if (target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
  // Inside dialogs and other panels, leave things alone too.
  if (target.closest('dialog, [popover]:not(#menu)')) return;

  event.preventDefault();
  const note = target.closest('.note');
  const fromKeyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
  const anchor = fromKeyboard && note ? cornerOf(note) : { x: event.clientX, y: event.clientY };
  open(note ? noteItems(note.dataset.id) : pageItems(), anchor);
}

/** Shift+F10 on a focused note (the ContextMenu key fires a contextmenu event by itself). */
function onMenuKey(event) {
  if (event.key !== 'F10' || !event.shiftKey) return;
  const note = document.activeElement?.closest?.('.note');
  if (!note) return;
  event.preventDefault();
  open(noteItems(note.dataset.id), cornerOf(note));
}

function cornerOf(el) {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width * 0.6, y: box.top + box.height * 0.4 };
}

/** Fill the menu, show it at `anchor`, kept inside the window, and focus the first item. */
function open(items, anchor) {
  menu.replaceChildren(...items);
  if (menu.matches(':popover-open')) menu.hidePopover();
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.showPopover();

  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(anchor.x, window.innerWidth - width - 8);
  const top = anchor.y + height > window.innerHeight - 8 ? Math.max(8, anchor.y - height) : anchor.y;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  // It grows out of the corner nearest the pointer.
  menu.style.transformOrigin = `${anchor.x > left + width / 2 ? 'right' : 'left'} ${top < anchor.y ? 'bottom' : 'top'}`;
  focusables()[0]?.focus({ preventScroll: true });
  watchForDismiss(true);
}

function close() {
  watchForDismiss(false);
  if (menu.matches(':popover-open')) menu.hidePopover();
}

// ---------- What is in it ----------

function noteItems(id) {
  const note = getState().notes.find((n) => n.id === id);
  if (!note) return [];
  const act = noteActions;

  return [
    item('edit', t('edit'), 'Enter', () => act.edit(id)),
    item('done', t('done'), 'D', () => act.done(id)),
    item('focus', t('focusTitle'), 'F', () => act.focus(id)),
    item('pin', t(note.pinned ? 'unpinShort' : 'pinShort'), 'P', () => act.pin(id)),
    separator(),
    colorRow(note),
    timeRow(note),
    separator(),
    item('tomorrow', t('toTomorrow'), 'M', () => act.tomorrow(id)),
    item('later', t('toLater'), 'L', () => act.later(id)),
    item('trash', t('delete'), '⌫', () => act.remove(id), 'is-danger'),
  ];
}

function pageItems() {
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && systemDark.matches);
  return [
    item('add', t('newNote'), 'N', () => captureInput.focus()),
    item('spark', t('whatNow'), 'W', askWhatNow, '', getState().notes.length === 0),
    item('tidy', t('tidyUp'), 'T', tidyWall, '', getState().notes.length === 0),
    item('moon', t('endDay'), 'E', () => endTheDay(), '', doneItems().length === 0),
    item('tomorrow', t('switchView'), 'V', cycleView),
    separator(),
    item('undo', t('undo'), `${MOD}Z`, stepBack, '', !canUndo()),
    item('redo', t('redo'), isMac ? '⇧⌘Z' : 'Ctrl+Y', stepForward, '', !canRedo()),
    separator(),
    item('theme', t(dark ? 'lightTheme' : 'darkTheme'), '', () => toggleTheme(dark)),
    item('settings', t('settings'), ',', () => settingsPanel.showPopover()),
  ];
}

/** Flip the theme; if that matches the system, just follow the system again. */
function toggleTheme(isDark) {
  const next = isDark ? 'light' : 'dark';
  setTheme(next === (systemDark.matches ? 'dark' : 'light') ? 'system' : next);
}

/** One menu row: icon, label, shortcut. Runs `action` after the menu closes. */
function item(icon, label, shortcut, action, extraClass = '', disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `menu-item ${extraClass}`.trim();
  button.setAttribute('role', 'menuitem');
  button.disabled = disabled;
  button.innerHTML = `${svg(ICONS[icon])}<span class="menu-label"></span><kbd class="menu-key"></kbd>`;
  button.querySelector('.menu-label').textContent = label;
  button.querySelector('.menu-key').textContent = shortcut;
  button.menuAction = action;
  return button;
}

/** Paper colors, as a row of swatches. Picking one keeps the menu open. */
function colorRow(note) {
  const row = document.createElement('div');
  row.className = 'menu-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('colour'));
  row.innerHTML = `<span class="menu-row-label">${t('colour')}</span>`;
  for (const color of COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'menu-swatch';
    swatch.dataset.color = color;
    swatch.setAttribute('role', 'menuitemradio');
    swatch.setAttribute('aria-checked', String(note.color === color));
    swatch.setAttribute('aria-label', t('colorTo', { name: t(`color_${color}`) }));
    swatch.menuAction = () => {
      setColor(note.id, color);
      row.querySelectorAll('.menu-swatch').forEach((s) => s.setAttribute('aria-checked', String(s === swatch)));
    };
    swatch.keepOpen = true;
    row.append(swatch);
  }
  return row;
}

/** The note's time, with − and + (5 minutes a step). Keeps the menu open. */
function timeRow(note) {
  const row = document.createElement('div');
  row.className = 'menu-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('time'));
  const value = document.createElement('span');
  value.className = 'menu-time';

  const show = () => {
    const current = getState().notes.find((n) => n.id === note.id);
    value.textContent = current?.minutes ? formatMinutes(current.minutes) : t('noTime');
  };
  const stepButton = (text, label, direction) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-step';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.menuAction = () => { noteActions.nudge(note.id, direction); show(); };
    button.keepOpen = true;
    return button;
  };

  row.innerHTML = `<span class="menu-row-label">${t('time')}</span>`;
  row.append(stepButton('−', t('lessTime5'), -1), value, stepButton('+', t('moreTime5'), 1));
  show();
  return row;
}

function separator() {
  const line = document.createElement('hr');
  line.className = 'menu-sep';
  return line;
}

function svg(paths) {
  return `<svg class="menu-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// ---------- Using it ----------

function onClick(event) {
  const button = event.target.closest('button');
  if (!button || button.disabled || !button.menuAction) return;
  if (button.keepOpen) {
    button.menuAction();
    return;
  }
  close();
  button.menuAction();
}

function focusables() {
  return [...menu.querySelectorAll('button:not(:disabled)')];
}

/** Up and down move through the menu; Home and End jump to its ends. */
function onNavigate(event) {
  const items = focusables();
  const index = items.indexOf(document.activeElement);
  const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
  if (!(event.key in moves)) return;
  event.preventDefault();
  const next = (moves[event.key] + items.length) % items.length;
  items[next]?.focus();
}
