// store.js — the single source of truth.
// Holds the state, saves it to localStorage on every change, and tells
// subscribers (the UI modules) when something changed. No DOM code lives here.
//
// State shape:
//   notes     notes on the wall, in order
//             each: { id, text (may hold line breaks), minutes (number | null),
//                     rot, color, pinned, createdAt,
//                     x, y (where it sits on the wall, px; null = not placed yet),
//                     z (stacking: higher sits on top),
//                     pile (id shared by notes stacked into one pile, or null) }
//             Notes in a pile share one x / y; the highest z is the top of the pile.
//   later     the quiet pile of everything that doesn't fit on the wall
//   settings  { theme: 'system' | 'light' | 'dark', limit: 3–9, lang: 'en' | 'pl' | null,
//               sound, name, view: 'wall' | 'today' | 'tomorrow', focusFullscreen,
//               clock: '12' | '24' | null }
//             (lang, clock null = follow the language)
//   tomorrow  { day, items } — notes put aside for `day`; on that day they
//             come onto the wall (or into Later when it's full)
//   lastDay   'YYYY-MM-DD' of the last day the user confirmed (for the new-day prompt)
//   done      { day, items } — the notes completed on `day`, newest first
//   trash     { day, items } — the notes deleted on `day`, newest first (the trash)

const STORAGE_KEY = 'stickly:v1';
const BACKUP_KEY = 'stickly:corrupt-backup';
const MAX_ROTATION_DEG = 1.5;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const LIMIT_MIN = 3;
export const LIMIT_MAX = 9;
const LIMIT_DEFAULT = 6;

/** Paper colors a note can have. The first is the default. */
export const COLORS = ['yellow', 'pink', 'blue', 'green'];

/** How many completed notes to remember per day. */
const DONE_LOG_MAX = 50;
/** How many deleted notes the trash keeps (today's only). */
const TRASH_MAX = 30;

/** The longest time a note can be given, in minutes (8 hours). */
export const MINUTES_MAX = 480;

/** How many steps Cmd+Z can go back. */
const HISTORY_MAX = 50;

/** The smaller settings, each checked before it's kept. */
const SETTING_RULES = {
  view: (v) => (v === 'today' || v === 'tomorrow' ? v : 'wall'),
  focusFullscreen: (v) => Boolean(v),
  clock: (v) => (v === '12' || v === '24' ? v : null),
};

/** Notes that came over from the Tomorrow list since anyone last asked (for the good-morning card). */
let arrivedCount = 0;

const listeners = new Set();
const saveErrorListeners = new Set();
let state = load();

/** Undo history: snapshots of the notes before each change, and the undone ones for redo. */
let past = [];
let future = [];
let historyVersion = 0;

// ---------- Reading ----------

export function getState() {
  return state;
}

/** Call `fn(state)` after every change. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Call `fn()` if saving ever fails (storage full or blocked). */
export function onSaveError(fn) {
  saveErrorListeners.add(fn);
}

/** Is there room for one more note on the wall? */
export function hasSpace() {
  return state.notes.length < state.settings.limit;
}

// ---------- Undo / redo ----------
// Every change to the notes saves a snapshot first, so Cmd+Z can step back
// through anything: adding, editing, moving, pinning, completing, deleting.

/**
 * Several changes as one step for Undo (acting on several selected notes):
 * between beginBatch() and endBatch() only the first change saves a snapshot.
 */
let batchDepth = 0;
let batchSaved = false;

export function beginBatch() {
  if (batchDepth++ === 0) batchSaved = false;
}

export function endBatch() {
  batchDepth = Math.max(0, batchDepth - 1);
}

/** Remember how things are, just before a change. */
function checkpoint() {
  if (batchDepth) {
    if (batchSaved) return;
    batchSaved = true;
  }
  past.push(snapshot());
  if (past.length > HISTORY_MAX) past.shift();
  future = [];
  historyVersion++;
}

/** Step back one change. Returns false if there is nothing to undo. */
export function undo() {
  if (!past.length) return false;
  future.push(snapshot());
  restore(past.pop());
  return true;
}

/** Redo the last undone change. Returns false if there is nothing to redo. */
export function redo() {
  if (!future.length) return false;
  past.push(snapshot());
  restore(future.pop());
  return true;
}

export function canUndo() {
  return past.length > 0;
}

export function canRedo() {
  return future.length > 0;
}

/** Changes whenever the history moves; lets the toast tell if its Undo is still current. */
export function getHistoryVersion() {
  return historyVersion;
}

function snapshot() {
  return JSON.stringify({ notes: state.notes, later: state.later, done: state.done, trash: state.trash, tomorrow: state.tomorrow });
}

function restore(json) {
  const saved = JSON.parse(json);
  state.notes = saved.notes;
  state.later = saved.later;
  state.done = saved.done;
  if (saved.trash) state.trash = saved.trash;
  if (saved.tomorrow) state.tomorrow = saved.tomorrow;
  rebalance(state); // the wall limit may have changed since
  historyVersion++;
  commit();
}

// ---------- Notes ----------

/**
 * Add one note per item: onto the wall while there is room, then onto the Later pile.
 * With { tomorrow: true } they're put aside for tomorrow instead.
 * An item is a text, or { text, minutes }. Blank texts are skipped.
 * Returns [{ note, place: 'wall' | 'later' | 'tomorrow' }, …].
 */
export function addNotes(items, { tomorrow = false } = {}) {
  const valid = items
    .map((item) => (typeof item === 'string' ? { text: item } : item))
    .map((item) => ({ text: cleanText(item.text), minutes: cleanMinutes(item.minutes) }))
    .filter((item) => item.text);
  if (!valid.length) return [];

  checkpoint();
  if (tomorrow) readyTomorrow();
  const added = [];
  for (const { text: clean, minutes } of valid) {
    const note = {
      id: newId(), text: clean, minutes, rot: randomRotation(),
      color: COLORS[0], pinned: false, createdAt: Date.now(),
      x: null, y: null, z: topZ() + 1, pile: null,
    };
    const place = tomorrow ? 'tomorrow' : hasSpace() ? 'wall' : 'later';
    listFor(place).push(note);
    added.push({ note, place });
  }
  commit();
  return added;
}

/** Change a note's text. Returns true if something actually changed. */
export function updateNote(id, text) {
  const note = findNote(id); // on the wall or in Later
  const clean = cleanText(text);
  if (!note || !clean || note.text === clean) return false;
  checkpoint();
  note.text = clean;
  commit();
  return true;
}

/**
 * Pin or unpin a wall note. A pinned note moves to the front of the wall;
 * an unpinned one steps back behind the notes that are still pinned.
 * Pinned notes also stay when the wall is cleared for a new day.
 */
export function togglePin(id, spot = null) {
  const index = state.notes.findIndex((n) => n.id === id);
  if (index < 0) return;
  checkpoint();
  const [note] = state.notes.splice(index, 1);
  note.pinned = !note.pinned;
  if (note.pinned) note.z = topZ() + 1; // a fresh pin comes to the top of the stack
  // A fresh pin jumps to the first spot on the wall; whatever sat there takes its old place.
  if (note.pinned && spot) {
    const other = spot.swap && state.notes.find((n) => n.id === spot.swap);
    // a pile in the way moves as a whole
    if (other) for (const n of other.pile ? pileMembers(other.pile) : [other]) { n.x = note.x; n.y = note.y; }
    note.pile = null; // pinning takes a note off its pile
    note.x = Math.round(spot.x);
    note.y = Math.round(spot.y);
  }
  const stillPinned = state.notes.filter((n) => n.pinned).length;
  state.notes.splice(note.pinned ? 0 : stillPinned, 0, note);
  commit();
}

/** Set how long a note should take (minutes, or null for no time). */
export function setMinutes(id, minutes) {
  const note = findNote(id);
  const clean = cleanMinutes(minutes);
  if (!note || note.minutes === clean) return;
  checkpoint();
  note.minutes = clean;
  commit();
}

/** A note on the wall or in Later. */
export function findNote(id) {
  for (const list of [state.notes, state.later]) {
    const note = list.find((n) => n.id === id);
    if (note) return note;
  }
  return null;
}

// ---------- Tomorrow ----------
// Notes put aside for tomorrow. They wait in their own list, out of the way,
// and the first time Stickly is opened on that day they come onto the wall
// (into Later once the wall is full).

/** The notes waiting for tomorrow, in order. */
export function tomorrowItems() {
  return state.tomorrow.day > today() ? state.tomorrow.items : [];
}

/** Make sure the Tomorrow list is for tomorrow (anything older has arrived first). */
function readyTomorrow() {
  arriveFrom(state);
  state.tomorrow.day = dayKey(addDay(new Date(), 1));
}

/** Their day has come: the notes put aside come onto the wall. Returns how many. */
function arriveFrom(target) {
  if (target.tomorrow.day > today() || !target.tomorrow.items.length) return 0;
  const items = target.tomorrow.items;
  target.tomorrow = { day: dayKey(addDay(new Date(), 1)), items: [] };
  arrivedCount += items.length;
  for (const note of items) {
    unplace(note);
    note.arrivedOn = today(); // kept when the wall is cleared for a fresh start today
    if (target.notes.length < target.settings.limit) target.notes.push(note);
    else target.later.push(note);
  }
  return items.length;
}

/** Bring today's notes from yesterday's Tomorrow list onto the wall (no undo: it's a new day). */
export function arriveTomorrow() {
  const count = arriveFrom(state);
  if (count) commit();
  return count;
}

/** How many notes came over from the Tomorrow list since last asked (then 0 again). */
export function takeArrived() {
  const count = arrivedCount;
  arrivedCount = 0;
  return count;
}

/** Put a note from the wall or Later aside for tomorrow. */
export function moveToTomorrow(id) {
  for (const list of [state.notes, state.later]) {
    const index = list.findIndex((n) => n.id === id);
    if (index < 0) continue;
    checkpoint();
    readyTomorrow();
    const [note] = list.splice(index, 1);
    note.pile = null;
    state.tomorrow.items.push(unplace(note));
    commit();
    return true;
  }
  return false;
}

/** Bring a note back from tomorrow to today: the wall if there's room, else Later. */
export function backToToday(id) {
  const index = tomorrowItems().findIndex((n) => n.id === id);
  if (index < 0) return null;
  checkpoint();
  const [note] = state.tomorrow.items.splice(index, 1);
  const place = hasSpace() ? 'wall' : 'later';
  note.z = topZ() + 1;
  if (place === 'wall') state.notes.push(unplace(note));
  else state.later.unshift(unplace(note));
  commit();
  return place;
}

/** Throw away a note waiting for tomorrow (it goes in the trash, as usual). */
export function removeTomorrow(id) {
  const index = tomorrowItems().findIndex((n) => n.id === id);
  if (index < 0) return false;
  checkpoint();
  const [note] = state.tomorrow.items.splice(index, 1);
  logTrash(note);
  commit();
  return true;
}

/** Change a waiting note's text or time. */
export function updateTomorrow(id, { text, minutes }) {
  const note = tomorrowItems().find((n) => n.id === id);
  if (!note) return;
  const clean = text === undefined ? note.text : cleanText(text);
  const length = minutes === undefined ? note.minutes : cleanMinutes(minutes);
  if (!clean || (clean === note.text && length === note.minutes)) return;
  checkpoint();
  note.text = clean;
  note.minutes = length;
  commit();
}

/** Move a waiting note up or down the list. */
export function reorderTomorrow(id, toIndex) {
  const items = tomorrowItems();
  const from = items.findIndex((n) => n.id === id);
  const to = clamp(toIndex, 0, items.length - 1);
  if (from < 0 || from === to) return;
  checkpoint();
  const [note] = items.splice(from, 1);
  items.splice(to, 0, note);
  commit();
}

/** Change a wall note's paper color. */
export function setColor(id, color) {
  const note = findNote(id); // on the wall or in Later
  if (!note || !COLORS.includes(color) || note.color === color) return;
  checkpoint();
  note.color = color;
  commit();
}

/**
 * Remove a note from the wall or the pile. Pass { done: true } when it was
 * completed (not just deleted) so it counts towards today's progress.
 * Returns { note, index, place, done } for undo.
 */
export function removeNote(id, { done = false } = {}) {
  for (const place of ['wall', 'later']) {
    const list = listFor(place);
    const index = list.findIndex((n) => n.id === id);
    if (index < 0) continue;
    checkpoint();
    const [note] = list.splice(index, 1);
    if (done) logDone(note);
    else logTrash(note);
    commit();
    return { note, index, place, done };
  }
  return null;
}

/** Throw several notes away in one go (a whole pile); one Undo brings them all back. */
export function removeNotes(ids) {
  const gone = state.notes.filter((n) => ids.includes(n.id));
  if (!gone.length) return 0;
  checkpoint();
  state.notes = state.notes.filter((n) => !ids.includes(n.id));
  for (const note of gone) logTrash(note);
  commit();
  return gone.length;
}

/** Move a wall note to a new position. */
export function moveNote(id, toIndex) {
  const from = state.notes.findIndex((n) => n.id === id);
  const to = clamp(toIndex, 0, state.notes.length - 1);
  if (from < 0 || from === to) return;
  checkpoint();
  const [note] = state.notes.splice(from, 1);
  state.notes.splice(to, 0, note);
  commit();
}

/**
 * Stick a wall note somewhere else (dragged or nudged). It ends up on top
 * of anything it overlaps.
 */
export function placeNote(id, x, y) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (note.x === rx && note.y === ry && note.z === topZ() && !note.pile) return;
  checkpoint();
  note.x = rx;
  note.y = ry;
  note.z = topZ() + 1;
  note.pile = null; // a note put down on its own leaves its pile
  commit();
}

// ---------- Piles ----------
// Drop a note on another and they stack into a neat pile. A pile moves as one;
// opened up (ui.js), each note can be taken back off it.

/** The notes in a pile, bottom first. */
export function pileMembers(pileId) {
  if (!pileId) return [];
  return state.notes.filter((n) => n.pile === pileId).sort((a, b) => (a.z || 0) - (b.z || 0));
}

/**
 * Put a note (or, if it is in a pile, its whole pile) on top of another note
 * or pile. Returns the pile's id, or null if nothing changed.
 */
export function stackNotes(id, ontoId) {
  const moving = state.notes.find((n) => n.id === id);
  const onto = state.notes.find((n) => n.id === ontoId);
  if (!moving || !onto || moving === onto || (moving.pile && moving.pile === onto.pile)) return null;
  checkpoint();
  const pileId = onto.pile || newId();
  onto.pile = pileId;
  let z = topZ();
  // the pile underneath comes up too, so the new pile is the top of the wall
  for (const n of pileMembers(pileId)) n.z = ++z;
  for (const n of moving.pile ? pileMembers(moving.pile) : [moving]) {
    delete n.spread; // a newcomer gets a fresh place when the pile is opened
    n.pile = pileId;
    n.x = onto.x;
    n.y = onto.y;
    n.z = ++z;
  }
  commit();
  return pileId;
}

/** Move a whole pile somewhere else on the wall; it comes to the top. */
export function movePile(pileId, x, y) {
  const members = pileMembers(pileId);
  if (!members.length) return;
  checkpoint();
  let z = topZ();
  for (const n of members) {
    n.x = Math.round(x);
    n.y = Math.round(y);
    n.z = ++z;
  }
  commit();
}

/** Spread a pile back out: the bottom note stays, the others get spots of their own. */
export function unstackPile(pileId) {
  const members = pileMembers(pileId);
  if (members.length < 2) return;
  checkpoint();
  members.forEach((n, i) => {
    n.pile = null;
    if (i > 0) unplace(n); // ui.js gives each the next free spot
  });
  commit();
}

/**
 * Arrange an open pile by hand: `spots` gives notes their place while the pile
 * is spread out ({ id → { x, y, z } }, x / y from where the pile sits). The
 * notes stay in the pile; closed up, it looks the same as before.
 */
export function arrangePile(pileId, spots) {
  const members = pileMembers(pileId);
  if (!members.length) return;
  checkpoint();
  for (const n of members) {
    const spot = cleanSpot(spots[n.id]);
    if (spot) n.spread = spot;
  }
  commit();
}

/** Take one note off its pile; it gets the next free spot on the wall. */
export function takeOffPile(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note?.pile) return false;
  checkpoint();
  note.pile = null;
  unplace(note);
  note.z = topZ() + 1;
  commit();
  return true;
}

function cleanSpot(spot) {
  if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return null;
  return { x: Math.round(spot.x), y: Math.round(spot.y), z: Number.isFinite(spot.z) ? Math.round(spot.z) : 0 };
}

/** A pile needs two notes; one left on its own is just a note again (and forgets its place in it). */
function tidyPiles(target) {
  for (const n of target.later) n.pile = null;
  const counts = new Map();
  for (const n of target.notes) if (n.pile) counts.set(n.pile, (counts.get(n.pile) || 0) + 1);
  for (const n of target.notes) if (n.pile && counts.get(n.pile) < 2) n.pile = null;
  for (const n of [...target.notes, ...target.later]) if (!n.pile && 'spread' in n) delete n.spread;
}

/**
 * Give new notes their first spot on the wall. Not a change you'd want to
 * undo on its own (undoing the add removes the note), so no history step.
 * places: [{ id, x, y }]
 */
export function assignPlaces(places) {
  let changed = false;
  for (const { id, x, y } of places) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) continue;
    note.x = Math.round(x);
    note.y = Math.round(y);
    changed = true;
  }
  if (changed) commit();
}

/** Line every note up in a neat grid again, in wall order (pinned first). Undo puts them back. */
export function tidyUp() {
  if (!state.notes.length) return;
  checkpoint();
  state.notes.forEach(unplace); // ui.js gives each the next free spot, in order
  commit();
}

/** The highest stacking value on the wall. */
function topZ() {
  return state.notes.reduce((max, n) => Math.max(max, n.z || 0), 0);
}

/** Forget where a note was, so it gets a fresh free spot when it comes back. */
function unplace(note) {
  note.x = null;
  note.y = null;
  return note;
}

/** Send a wall note to the front of the Later pile, to free up the wall. */
export function moveToLater(id) {
  const index = state.notes.findIndex((n) => n.id === id);
  if (index < 0) return false;
  checkpoint();
  const [note] = state.notes.splice(index, 1);
  state.later.unshift(unplace(note));
  commit();
  return true;
}

/**
 * Bring a note from the Later box onto the wall, at `at` ({ x, y } on the
 * wall, where it was dropped) or the next free spot. False if there is no room.
 */
export function promoteNote(id, at = null) {
  const index = state.later.findIndex((n) => n.id === id);
  if (index < 0 || !hasSpace()) return false;
  checkpoint();
  const [note] = state.later.splice(index, 1);
  unplace(note);
  note.pile = null;
  if (at) {
    note.x = Math.max(0, Math.round(at.x));
    note.y = Math.max(0, Math.round(at.y));
    note.z = topZ() + 1;
  }
  state.notes.push(note);
  commit();
  return true;
}

/** Fill the wall from the Later box, oldest first, as far as there is room. Returns the ids moved. */
export function promoteAll() {
  if (!state.later.length || !hasSpace()) return [];
  checkpoint();
  const moved = [];
  while (state.later.length && hasSpace()) {
    const note = unplace(state.later.pop());
    note.pile = null;
    state.notes.push(note);
    moved.push(note.id);
  }
  commit();
  return moved;
}

/** Put a Later note in a new place in the box. */
export function reorderLater(id, toIndex) {
  const from = state.later.findIndex((n) => n.id === id);
  const to = Math.max(0, Math.min(state.later.length - 1, toIndex));
  if (from < 0 || from === to) return;
  checkpoint();
  const [note] = state.later.splice(from, 1);
  state.later.splice(to, 0, note);
  commit();
}

// ---------- Settings ----------

/** theme: 'system' | 'light' | 'dark' */
export function setTheme(theme) {
  state.settings.theme = theme;
  commit();
}

/**
 * How many notes the wall shows (3–9). Lowering it moves the extra notes to the
 * Later pile; raising it brings waiting notes back to fill the new space.
 */
export function setLimit(limit) {
  state.settings.limit = clamp(Math.round(limit), LIMIT_MIN, LIMIT_MAX);
  rebalance(state);
  while (hasSpace() && state.later.length) state.notes.push(unplace(state.later.shift()));
  commit();
}

/** Sounds on or off (the fly-away whoosh and the timer chime). */
export function setSound(on) {
  state.settings.sound = Boolean(on);
  commit();
}

/** What to call the user in the greeting ('' for no name). */
export function setName(name) {
  state.settings.name = String(name).replace(/\s+/g, ' ').trim().slice(0, 40);
  commit();
}

/** Change one of the smaller settings (see SETTING_RULES). */
export function setSetting(key, value) {
  const rule = SETTING_RULES[key];
  if (!rule) return;
  state.settings[key] = rule(value);
  commit();
}

/** lang: 'en' | 'pl' — used for the interface and for dictation. */
export function setLang(lang) {
  state.settings.lang = lang === 'pl' ? 'pl' : 'en';
  commit();
}

// ---------- New day ----------

/** True on the first open of a day after the one last confirmed. */
export function isNewDay() {
  return state.lastDay !== today();
}

/** The user has seen today (kept their notes, or had none). */
export function markToday() {
  state.lastDay = today();
  commit();
}

/** Start fresh: clear everything except pinned notes (and the ones set aside for today). Undo brings it all back. */
export function clearAll() {
  checkpoint();
  const keep = (n) => n.pinned || n.arrivedOn === today();
  state.notes = state.notes.filter(keep);
  state.later = state.later.filter(keep);
  state.lastDay = today();
  commit();
}

// ---------- Progress ----------

/** The notes completed today, newest first. */
export function doneItems() {
  return state.done.day === today() ? state.done.items : [];
}

/** How many were completed on the last day the app was used (for the new-day prompt). */
/** Finished notes from an earlier day that never got their end-of-day sweep. */
export function doneBeforeToday() {
  return state.done.day !== today() ? state.done.items : [];
}

export function doneLastDay() {
  const { day, items } = state.done;
  return day !== today() && day === state.lastDay ? items.length : 0;
}

/**
 * Not done after all: put a completed note back. It returns to the wall if
 * there is room, otherwise to the Later pile. Returns 'wall' | 'later' | null.
 */
export function restoreDone(id) {
  const index = doneItems().findIndex((n) => n.id === id);
  if (index < 0) return null;
  checkpoint();
  const [note] = state.done.items.splice(index, 1);
  unplace(note);
  const place = hasSpace() ? 'wall' : 'later';
  if (place === 'wall') state.notes.push(note);
  else state.later.unshift(note);
  commit();
  return place;
}

// ---------- The trash ----------

/** The notes deleted today, newest first. */
export function trashItems() {
  return state.trash.day === today() ? state.trash.items : [];
}

/**
 * Take a note back out of the trash. With x / y it lands right there on the
 * wall; without, it gets the next free spot. If the wall is full it goes to
 * the Later pile. Returns 'wall' | 'later' | null.
 */
export function restoreTrash(id, x = null, y = null) {
  const index = trashItems().findIndex((n) => n.id === id);
  if (index < 0) return null;
  checkpoint();
  const [note] = state.trash.items.splice(index, 1);
  unplace(note);
  const place = hasSpace() ? 'wall' : 'later';
  if (place === 'wall') {
    if (x != null && y != null) { note.x = Math.round(x); note.y = Math.round(y); }
    note.z = topZ() + 1;
    state.notes.push(note);
  } else {
    state.later.unshift(note);
  }
  commit();
  return place;
}

/** Throw away everything in today's trash for good (undo still brings it back). */
export function emptyTrash() {
  if (!trashItems().length) return 0;
  checkpoint();
  const count = state.trash.items.length;
  state.trash.items = [];
  commit();
  return count;
}

/** The nightly clear-out (11:55 pm): no undo, it's a new day soon. */
export function emptyTrashForGood() {
  if (!state.trash.items.length) return;
  state.trash.items = [];
  commit();
}

function logTrash(note) {
  if (state.trash.day !== today()) state.trash = { day: today(), items: [] };
  state.trash.items.unshift({ ...note, pile: null }); // back from the trash, it comes on its own
  state.trash.items.length = Math.min(state.trash.items.length, TRASH_MAX);
}

/** Clear today's "Done today" list (end of the day). Undo brings it back. */
export function clearDone() {
  if (!state.done.items.length) return 0;
  checkpoint();
  const count = state.done.items.length;
  state.done.items = [];
  commit();
  return count;
}

function logDone(note) {
  if (state.done.day !== today()) state.done = { day: today(), items: [] };
  state.done.items.unshift({ ...note, pile: null });
  state.done.items.length = Math.min(state.done.items.length, DONE_LOG_MAX);
}

// ---------- Persistence ----------

function commit() {
  tidyPiles(state);
  save();
  listeners.forEach((fn) => fn(state));
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // Storage full or blocked (private mode). The app keeps working in memory,
    // and the user is told so they are not surprised after a refresh.
    console.warn('Stickly: could not save', err);
    saveErrorListeners.forEach((fn) => fn());
  }
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyState();
    return sanitize(JSON.parse(raw));
  } catch (err) {
    // Unreadable data: keep a copy so nothing is silently destroyed, start clean.
    console.warn('Stickly: saved data was unreadable, starting fresh', err);
    try { if (raw) localStorage.setItem(BACKUP_KEY, raw); } catch { /* ignore */ }
    return emptyState();
  }
}

function emptyState() {
  return {
    version: 1,
    notes: [],
    later: [],
    settings: {
      theme: 'system', limit: LIMIT_DEFAULT, lang: null, sound: true, name: '',
      view: 'wall', focusFullscreen: true, clock: null,
    },
    tomorrow: { day: dayKey(addDay(new Date(), 1)), items: [] },
    lastDay: today(),
    done: { day: today(), items: [] },
    trash: { day: today(), items: [] },
  };
}

/** Rebuild a trustworthy state from whatever was stored, dropping bad pieces. */
function sanitize(data) {
  if (!data || typeof data !== 'object') throw new Error('not an object');

  const clean = emptyState();
  const seen = new Set();
  clean.notes = sanitizeNotes(data.notes, seen);
  clean.later = sanitizeNotes(data.later, seen);

  const settings = data.settings || {};
  if (settings.theme === 'light' || settings.theme === 'dark') clean.settings.theme = settings.theme;
  if (Number.isFinite(settings.limit)) {
    clean.settings.limit = clamp(Math.round(settings.limit), LIMIT_MIN, LIMIT_MAX);
  }
  if (settings.lang === 'en' || settings.lang === 'pl') clean.settings.lang = settings.lang;
  if (settings.sound === false) clean.settings.sound = false;
  if (typeof settings.name === 'string') clean.settings.name = settings.name.trim().slice(0, 40);
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (key in settings) clean.settings[key] = rule(settings[key]);
  }
  if (DAY_PATTERN.test(data.lastDay)) clean.lastDay = data.lastDay;

  const done = data.done || {};
  if (DAY_PATTERN.test(done.day)) {
    clean.done = { day: done.day, items: sanitizeNotes(done.items, seen).slice(0, DONE_LOG_MAX) };
  }
  const trash = data.trash || {};
  if (DAY_PATTERN.test(trash.day)) {
    clean.trash = { day: trash.day, items: sanitizeNotes(trash.items, seen).slice(0, TRASH_MAX) };
  }

  const tomorrow = data.tomorrow || {};
  if (DAY_PATTERN.test(tomorrow.day)) {
    clean.tomorrow = { day: tomorrow.day, items: sanitizeNotes(tomorrow.items, seen).map((n) => ({ ...n, pile: null })) };
  }

  rebalance(clean);
  arriveFrom(clean); // opened on the day they were put aside for: onto the wall
  tidyPiles(clean);
  return clean;
}

function sanitizeNotes(list, seen) {
  const result = [];
  for (const n of Array.isArray(list) ? list : []) {
    if (!n || typeof n.text !== 'string' || !n.text.trim()) continue;
    const id = typeof n.id === 'string' && !seen.has(n.id) ? n.id : newId();
    seen.add(id);
    result.push({
      id,
      text: cleanText(n.text),
      minutes: cleanMinutes(n.minutes),
      color: COLORS.includes(n.color) ? n.color : COLORS[0],
      pinned: n.pinned === true,
      rot: Number.isFinite(n.rot) ? clamp(n.rot, -MAX_ROTATION_DEG, MAX_ROTATION_DEG) : randomRotation(),
      createdAt: Number.isFinite(n.createdAt) ? n.createdAt : Date.now(),
      x: Number.isFinite(n.x) ? n.x : null,
      y: Number.isFinite(n.y) ? n.y : null,
      z: Number.isFinite(n.z) ? n.z : 0,
      pile: typeof n.pile === 'string' && n.pile ? n.pile.slice(0, 40) : null,
      ...(n.pile && cleanSpot(n.spread) ? { spread: cleanSpot(n.spread) } : {}),
      ...(DAY_PATTERN.test(n.arrivedOn) ? { arrivedOn: n.arrivedOn } : {}),
    });
  }
  return result;
}

/** Anything beyond the wall limit goes to the front of the Later pile. */
function rebalance(target) {
  const overflow = target.notes.splice(target.settings.limit);
  target.later.unshift(...overflow);
}

/** Everything, as text for a backup file. */
export function exportData() {
  return JSON.stringify({ app: 'stickly', exportedAt: new Date().toISOString(), ...state }, null, 2);
}

/** Replace everything with a backup. Undo brings the old notes back. Returns false if unreadable. */
export function importData(text) {
  let clean;
  try { clean = sanitize(JSON.parse(text)); } catch { return false; }
  checkpoint();
  state.notes = clean.notes;
  state.later = clean.later;
  state.done = clean.done;
  state.trash = clean.trash;
  state.tomorrow = clean.tomorrow;
  state.settings = { ...clean.settings, lang: clean.settings.lang ?? state.settings.lang };
  rebalance(state);
  commit();
  return true;
}

// ---------- Sync ----------
// sync.js keeps the notes the same on every device. These two are its way in:
// what gets shared, and how a merged copy from the cloud comes back.
// Look and feel (theme, sound, which view is up) stay per device.

/** The settings that follow you to every device. */
const SYNCED_SETTINGS = ['limit', 'name', 'lang', 'clock'];

/** Everything that is shared between devices, as a plain copy. */
export function syncData() {
  const settings = {};
  for (const key of SYNCED_SETTINGS) settings[key] = state.settings[key];
  return JSON.parse(JSON.stringify({
    notes: state.notes, later: state.later, tomorrow: state.tomorrow,
    done: state.done, trash: state.trash, lastDay: state.lastDay, settings,
  }));
}

/**
 * Take in a merged copy from sync. It is checked like anything loaded from
 * storage. Undo starts over: the old steps belong to another version.
 */
export function applySynced(data) {
  let clean;
  try {
    clean = sanitize({ ...data, settings: { ...state.settings, ...(data.settings || {}) } });
  } catch {
    return false;
  }
  state.notes = clean.notes;
  state.later = clean.later;
  state.tomorrow = clean.tomorrow;
  state.done = clean.done;
  state.trash = clean.trash;
  state.lastDay = clean.lastDay;
  for (const key of SYNCED_SETTINGS) state.settings[key] = clean.settings[key];
  past = [];
  future = [];
  historyVersion++;
  commit();
  return true;
}

// Another tab changed the data: adopt it so the two tabs never overwrite each other.
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  state = load();
  past = []; // the other tab's history is not ours to undo
  future = [];
  historyVersion++;
  listeners.forEach((fn) => fn(state));
});

// ---------- Helpers ----------

function listFor(place) {
  if (place === 'tomorrow') return state.tomorrow.items;
  return place === 'wall' ? state.notes : state.later;
}

/** A whole number of minutes from 1 to MINUTES_MAX, or null for "no time". */
function cleanMinutes(value) {
  const minutes = Math.round(Number(value));
  return Number.isFinite(minutes) && minutes >= 1 ? Math.min(minutes, MINUTES_MAX) : null;
}

/**
 * Tidy a note's text: line breaks are kept (a note can have a few lines),
 * but stray spaces, runs of blank lines and empty edges are removed.
 */
function cleanText(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Today's local date as 'YYYY-MM-DD'. */
function today() {
  return dayKey(new Date());
}

/** The same time `days` days later. */
function addDay(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** A date as 'YYYY-MM-DD' (local time). */
export function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function randomRotation() {
  const deg = (Math.random() * 2 - 1) * MAX_ROTATION_DEG;
  return Math.round(deg * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
