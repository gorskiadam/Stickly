// parse.js — brain dump: turn one blob of text into separate notes.
// Pure functions, no DOM.

/**
 * Words that mean "next note" when spoken. Written commas do not count: some
 * browsers add punctuation on their own, which would split "Tomorrow, call mum".
 */
const SPOKEN_SEPARATORS = {
  en: ['and then', 'comma', 'new line'],
  pl: ['a potem', 'i potem', 'przecinek', 'nowa linia'],
};

/** "- task", "* task", "• task", "1. task", "2) task", "[ ] task" */
const LIST_MARKER = /^\s*(?:[-*•–—]|\d+[.)]|\[[ xX]?\])\s+/;

/** Typed or pasted text: one note per line, list markers removed. */
export function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter(Boolean);
}

/** Dictated text: split on spoken separators, then tidy each piece. */
export function splitSpoken(text, lang) {
  const words = (SPOKEN_SEPARATORS[lang] || SPOKEN_SEPARATORS.en).join('|');
  // A separator word only counts as a whole word, never inside another one.
  const separator = new RegExp(`[;\\n]|(?<!\\p{L})(?:${words})(?!\\p{L})`, 'giu');
  return String(text)
    .split(separator)
    .map(tidySpoken)
    .filter(Boolean);
}

/** "  call mum. " → "Call mum" */
function tidySpoken(piece) {
  const clean = piece.trim().replace(/[.。]+$/, '').trim();
  return clean.charAt(0).toLocaleUpperCase() + clean.slice(1);
}

/**
 * A time typed at the end of a task: "Call mum 10m", "Report 1.5h", "Pranie 20 min".
 * Returns { text, minutes } with the time taken off the text, or minutes null.
 */
const DURATION = /\s+(\d{1,3}(?:[.,]\d+)?)\s*(m|min|mins|minutes?|minut[ay]?|h|hrs?|hours?|godz\.?|godzin[ay]?)\.?\s*$/i;

export function takeDuration(input) {
  const text = String(input).trim();
  const match = text.match(DURATION);
  if (!match) return { text, minutes: null };

  const amount = parseFloat(match[1].replace(',', '.'));
  const inHours = /^(h|hr|hrs|hour|hours|godz|godzin)/i.test(match[2]);
  const minutes = Math.round(inHours ? amount * 60 : amount);
  const rest = text.slice(0, match.index).trim();
  if (!rest || minutes < 1) return { text, minutes: null };
  return { text: rest, minutes };
}

