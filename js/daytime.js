// daytime.js — what time of day it is, in words, and today's date.
// The greeting, with the user's name, stands big above the notes, and
// today's date sits under it in smaller type. The good-morning card
// (newday.js) uses both.
//
//   5:00–11:59   Good morning
//   12:00–16:59  Good afternoon
//   17:00–19:59  Good evening
//   20:00–4:59   Winding down

import { t, getLang } from './strings.js';
import { getState } from './store.js';

const longDate = document.getElementById('today-long');
const shortDate = document.getElementById('today-short');
const dateBox = document.getElementById('today');
const greetingLine = document.getElementById('greeting');

/** The string key for the greeting that fits this hour. */
export function greetingKey(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'greetMorning';
  if (hour >= 12 && hour < 17) return 'greetAfternoon';
  if (hour >= 17 && hour < 20) return 'greetEvening';
  return 'greetLate';
}

/** "Good evening, Adam" (or just "Good evening" with no name set). */
export function greeting(date = new Date()) {
  const name = getState().settings.name;
  return name ? `${t(greetingKey(date))}, ${name}` : t(greetingKey(date));
}

/** "Thursday, November 19" (or "Thu, Nov 19" with `short`), in the app's language. */
export function formatDay(date = new Date(), short = false) {
  const locale = getLang() === 'pl' ? 'pl-PL' : 'en-US';
  return new Intl.DateTimeFormat(locale, short
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
}

/** Keep the date in the top bar current (it may be left open past midnight). */
export function initToday() {
  const update = () => {
    const now = new Date();
    longDate.textContent = formatDay(now);
    shortDate.textContent = formatDay(now, true);
    dateBox.title = greeting(now);
    greetingLine.textContent = greeting(now);
  };
  update();
  // Check again at the top of every minute.
  setTimeout(() => {
    update();
    setInterval(update, 60_000);
  }, 60_000 - (Date.now() % 60_000));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
  return update;
}
