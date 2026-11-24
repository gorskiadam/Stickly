// syncmerge.js — putting two devices' notes together, without losing either's work.
//
// It's a three-way merge, note by note: `base` is the copy both sides last
// agreed on, `local` is this device now, `remote` is what's in the cloud now.
// For every note:
//   changed on one side only → that side's version (a move, an edit, a delete)
//   changed on both sides    → the cloud's version, except that an edit always
//                              beats a delete (nothing you typed disappears)
// A note's "version" is where it is (wall, Later, Tomorrow, Done, trash) and
// everything about it. The order within each list follows whichever side
// each note came from. Days take the later of the two; the shared settings
// are merged one by one the same way as notes.
// No DOM, no Firebase: plain data in, plain data out.

/** The lists a note can be in, and how to reach each one. */
const LISTS = {
  notes: (d) => d.notes,
  later: (d) => d.later,
  tomorrow: (d) => d.tomorrow?.items,
  done: (d) => d.done?.items,
  trash: (d) => d.trash?.items,
};

/** Lists that belong to one day: items from an older day than the newest are dropped. */
const DAY_OF = {
  tomorrow: (d) => d.tomorrow?.day,
  done: (d) => d.done?.day,
  trash: (d) => d.trash?.day,
};

export const EMPTY = {
  notes: [], later: [], tomorrow: { day: '', items: [] },
  done: { day: '', items: [] }, trash: { day: '', items: [] }, lastDay: '', settings: {},
};

/** id → { list, index, note, key } for every note in a copy. */
function flatten(data) {
  const map = new Map();
  for (const [list, get] of Object.entries(LISTS)) {
    (get(data) || []).forEach((note, index) => {
      if (note && typeof note.id === 'string') map.set(note.id, { list, index, note, key: `${list}|${JSON.stringify(note)}` });
    });
  }
  return map;
}

const later = (a = '', b = '') => (a > b ? a : b);

export function merge(base, local, remote) {
  base ||= EMPTY;
  const B = flatten(base);
  const L = flatten(local);
  const R = flatten(remote);

  // the newest day of each day-bound list, and where each side stands
  const days = {};
  for (const [list, dayOf] of Object.entries(DAY_OF)) days[list] = later(dayOf(local), dayOf(remote));
  const sideDay = (data, list) => DAY_OF[list] ? DAY_OF[list](data) || '' : null;

  const picked = []; // { list, index, note, from }
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const b = B.get(id);
    const l = L.get(id);
    const r = R.get(id);
    const localChanged = l?.key !== b?.key;
    const remoteChanged = r?.key !== b?.key;
    let pick;
    let from;
    if (!remoteChanged) { pick = l; from = local; }
    else if (!localChanged) { pick = r; from = remote; }
    else if (!r) { pick = l; from = local; }   // edited here, deleted there: keep the edit
    else { pick = r; from = remote; }          // both changed: the cloud's copy
    if (!pick) continue;
    // a Done / trash / Tomorrow item from a day that has passed on the other side
    if (DAY_OF[pick.list] && sideDay(from, pick.list) !== days[pick.list]) continue;
    picked.push({ ...pick, from: from === local ? 0 : 1 });
  }

  const listOf = (name) => picked
    .filter((p) => p.list === name)
    .sort((a, b) => a.index - b.index || a.from - b.from)
    .map((p) => p.note);

  // settings, field by field
  const settings = {};
  const keys = new Set([...Object.keys(local.settings || {}), ...Object.keys(remote.settings || {})]);
  for (const key of keys) {
    const was = JSON.stringify(base.settings?.[key]);
    const here = local.settings?.[key];
    settings[key] = JSON.stringify(here) !== was ? here : remote.settings?.[key];
  }

  return {
    notes: listOf('notes'),
    later: listOf('later'),
    tomorrow: { day: days.tomorrow, items: listOf('tomorrow') },
    done: { day: days.done, items: listOf('done') },
    trash: { day: days.trash, items: listOf('trash') },
    lastDay: later(local.lastDay, remote.lastDay),
    settings,
  };
}

/** Are two copies the same? */
export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
