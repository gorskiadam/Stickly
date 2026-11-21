// time.js — dates and the clock, in words. No DOM except download().

import { getState, dayKey } from './store.js';
import { getLang } from './strings.js';

export function todayKey() {
  return dayKey(new Date());
}

/** A day `offset` days from `day` ('YYYY-MM-DD'). */
export function addDays(day, offset) {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + offset));
}

/** 'YYYY-MM-DD' → a Date at local midnight. */
export function dateOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Minutes after midnight, right now. */
export function nowMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Does this person read the clock in 12 hours? (US English: yes; Polish: no.) */
export function uses12h() {
  const chosen = getState().settings.clock;
  if (chosen) return chosen === '12';
  return getLang() !== 'pl';
}

/** 930 → "3:30 PM" (or "15:30"). */
export function formatClock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  if (!uses12h()) return `${h}:${mm}`;
  return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Saturday, November 21" for a day, in the app's language. */
export function longDate(day) {
  return new Intl.DateTimeFormat(getLang() === 'pl' ? 'pl-PL' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(day));
}

/** Hand the user a file to save. */
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
