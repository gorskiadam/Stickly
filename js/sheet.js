// sheet.js — on a phone, panels slide up from the bottom as sheets (styles.css);
// pulling one down by its top closes it. It follows the finger, and springs
// back if let go too early.

/**
 * @param {HTMLElement} el                     the sheet
 * @param {object} options
 * @param {(event: PointerEvent) => boolean} options.grab   does this press start a pull? (on the sheet's top, say)
 * @param {() => void} options.close           close the sheet
 */
export function swipeToClose(el, { grab, close }) {
  let start = null;
  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || !grab(event)) return;
    start = { y: event.clientY, t: performance.now(), id: event.pointerId, moved: false };
  });
  el.addEventListener('pointermove', (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dy = Math.max(0, event.clientY - start.y);
    if (!start.moved && dy < 6) return;
    if (!start.moved) {
      start.moved = true;
      try { el.setPointerCapture(event.pointerId); } catch { /* gone */ }
    }
    el.style.transition = 'none';
    el.style.translate = `0 ${dy}px`;
  });
  const end = (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dy = Math.max(0, event.clientY - start.y);
    const fast = dy / Math.max(1, performance.now() - start.t) > 0.5;
    const moved = start.moved;
    start = null;
    if (!moved) return;
    el.style.transition = '';
    if (dy > 90 || (fast && dy > 30)) {
      el.style.translate = '0 100%';
      setTimeout(() => { close(); el.style.translate = ''; }, 220);
    } else {
      el.style.translate = '';
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Is the press on the top strip of the sheet (where its handle is)? */
export function onTopOf(el, event, height = 44) {
  return event.clientY - el.getBoundingClientRect().top < height;
}
