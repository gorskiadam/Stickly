// feedback.js — how the app talks back: the toast, undo/redo, and
// screen-reader announcements. Shared by every UI module.

import { t } from './strings.js';
import { undo, redo, getHistoryVersion } from './store.js';
import { spring, SPRINGS } from './motion.js';

const TOAST_MS = 5200;

const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');
const toastButton = document.getElementById('toast-undo');
const toastLabel = document.getElementById('toast-label');
const toastKey = document.getElementById('toast-key');
const toastIcon = document.getElementById('toast-icon');
const toastTimer = document.getElementById('toast-timer');
const liveRegion = document.getElementById('live');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Small line icons for the toast, 16×16, by what just happened. */
const ICONS = {
  done: '<path d="m3.5 8.5 3 3 6-7"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  later: '<path d="M3 5h10M3 8h10M3 11h6"/><path d="m11 10.5 2 1.5-2 1.5"/>',
  undo: '<path d="M5.5 4 3 6.5 5.5 9"/><path d="M3 6.5h6.5a3 3 0 0 1 0 6H7"/>',
  redo: '<path d="M10.5 4 13 6.5 10.5 9"/><path d="M13 6.5H6.5a3 3 0 0 0 0 6H9"/>',
  back: '<path d="M8 13V4M4.5 7.5 8 4l3.5 3.5"/>',
  sweep: '<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.3 4.3 0 0 0 6.5 6.5z"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>',
  bell: '<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3M8 5.3v.1"/>',
};

/** What the toast's button does, and the history it was offered for. */
let toastAction = null;
let toastVersion = -1;
let leaving = null;

export function initFeedback() {
  toastButton.addEventListener('click', runToastAction);
  document.addEventListener('keydown', onUndoKey);
  // The time line drains while the toast is up (it waits while hovered or
  // focused, see styles.css); when it runs out, the toast goes.
  toastTimer.addEventListener('animationend', hideToast);
}

/**
 * Show a quiet message for about five seconds. With `action`, the toast gets a
 * button labeled `label` (or "Undo"). `icon` names what happened (done,
 * trash, later, undo, redo…). Most callers want offerUndo() instead.
 */
export function showToast(message, action = null, label = '', icon = 'info') {
  toastAction = action;
  toastVersion = getHistoryVersion();
  toastText.textContent = message;
  toastIcon.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ICONS.info}</svg>`;
  toastIcon.dataset.kind = icon;
  toastButton.hidden = !action;
  toastLabel.textContent = label || t('undo');
  // the keyboard shortcut, next to Undo and Redo
  toastKey.textContent = action === stepBack ? `${isMac ? '⌘' : 'Ctrl+'}Z` : action === stepForward ? (isMac ? '⇧⌘Z' : 'Ctrl+Y') : '';
  toastKey.hidden = !toastKey.textContent;

  leaving?.cancel();
  leaving = null;
  const wasOpen = toast.matches(':popover-open');
  // Re-showing lifts it above any open panel (the top layer is last-shown-first).
  if (wasOpen) toast.hidePopover();
  toast.showPopover();
  toast.classList.toggle('is-swapping', wasOpen);
  // restart the time line
  toastTimer.style.animation = 'none';
  void toastTimer.offsetWidth;
  toastTimer.style.animation = '';
  toastTimer.style.animationDuration = `${TOAST_MS}ms`;
  if (!wasOpen && !reducedMotion.matches) {
    const { easing, duration } = spring(SPRINGS.pop);
    toast.animate(
      [{ transform: 'translate(-50%, 18px) scale(0.94)', opacity: 0 }, { transform: 'translate(-50%, 0) scale(1)', opacity: 1 }],
      { duration, easing },
    );
  } else if (wasOpen && !reducedMotion.matches) {
    // a new message replaces the old one with a small nod
    toast.animate(
      [{ transform: 'translate(-50%, 0) scale(0.97)' }, { transform: 'translate(-50%, 0) scale(1)' }],
      spring(SPRINGS.pop),
    );
  }
  announce(message);
}

/** Say what just happened and offer to take it back. */
export function offerUndo(message, icon = 'undo') {
  showToast(message, stepBack, t('undo'), icon);
}

/** Undo the last change, then offer to redo it. */
export function stepBack() {
  if (undo()) showToast(t('undone'), stepForward, t('redo'), 'undo');
  else showToast(t('nothingToUndo'), null, '', 'info');
}

/** Redo the last undone change, then offer to undo it again. */
export function stepForward() {
  if (redo()) showToast(t('redone'), stepBack, t('undo'), 'redo');
}

/** Drop out of sight: down and away, then gone. */
function hideToast() {
  toastAction = null;
  if (!toast.matches(':popover-open') || leaving) return;
  if (reducedMotion.matches) { toast.hidePopover(); return; }
  leaving = toast.animate(
    [{ transform: 'translate(-50%, 0)', opacity: 1 }, { transform: 'translate(-50%, 14px) scale(0.97)', opacity: 0 }],
    { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
  );
  leaving.finished.then(() => {
    leaving = null;
    if (toast.matches(':popover-open')) toast.hidePopover();
    toast.getAnimations().forEach((a) => a.cancel());
  }, () => {});
}

function runToastAction() {
  const action = toastAction;
  // Undo/Redo only act on the change they were offered for. If anything else
  // changed since (a new note, say), the button is out of date: just close.
  const stale = (action === stepBack || action === stepForward) && getHistoryVersion() !== toastVersion;
  hideToast();
  if (action && !stale) action();
}

/**
 * Cmd/Ctrl+Z undoes and Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes, anywhere in the app.
 * Inside a field that holds text, the browser's own text undo keeps working.
 */
function onUndoKey(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const isUndo = key === 'z' && !event.shiftKey;
  const isRedo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey);
  if (!isUndo && !isRedo) return;
  if (hasOwnText(event.target)) return;

  event.preventDefault();
  if (isUndo) stepBack();
  else stepForward();
}

function hasOwnText(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return /^(INPUT|TEXTAREA)$/.test(target.tagName) && target.value !== '';
}

/** Tell screen-reader users something happened. */
export function announce(message) {
  liveRegion.textContent = '';
  // A fresh frame makes screen readers re-read a repeated message.
  requestAnimationFrame(() => { liveRegion.textContent = message; });
}

/** Is the user typing in a field? Single-key shortcuts must stay out of the way. */
export function isTyping(target) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
