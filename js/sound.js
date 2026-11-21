// sound.js — small sounds, synthesised on the spot (no audio files):
//   whoosh    a finished note curls and flies away
//   crumple   a note is balled up         slam       the bin's lid shuts
//   binOpen   the bin's lid swings open
//   chime     a Focus timer runs out
//   slap      a note is stuck down        pinClick   a pin goes in
// All of them respect the Sound setting.
//
// Browsers only let a page make sound after the user has interacted with it,
// and a context created outside a click can stay muted. So the context is
// made (and woken) on the very first tap, click or key press.

import { getState } from './store.js';

let context = null;
let noise = null;

/** The audio context, or null if sound is off or unsupported. */
function audio() {
  if (!getState().settings.sound) return null;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  context ||= new AudioContext();
  if (context.state === 'suspended') context.resume();
  return context;
}

function unlock() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  context ||= new AudioContext();
  if (context.state !== 'running') context.resume().catch(() => {});
}
for (const type of ['pointerdown', 'keydown', 'touchend']) {
  window.addEventListener(type, unlock, { capture: true, passive: true });
}

/** One second of white noise, made once and reused. */
function noiseBuffer(ctx) {
  if (noise) return noise;
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

/** A gain node that rises to `peak` and falls away: attack and release in seconds. */
function envelope(ctx, start, peak, attack, release) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + release);
  return gain;
}

/**
 * The fly-away: a crisp flick as the corner curls, then a rising whoosh
 * that drifts towards the side the note flies off to (direction 1 = right).
 */
export function whoosh(direction = 1) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;

  // the paper flick
  const flick = ctx.createBufferSource();
  flick.buffer = noiseBuffer(ctx);
  const bright = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 2800 });
  flick.connect(bright).connect(envelope(ctx, now, 0.22, 0.004, 0.05)).connect(ctx.destination);
  flick.start(now);
  flick.stop(now + 0.08);

  // the whoosh, as the note lifts off (matches the animation's timing)
  const start = now + 0.2;
  const air = ctx.createBufferSource();
  air.buffer = noiseBuffer(ctx);
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', Q: 0.8 });
  band.frequency.setValueAtTime(320, start);
  band.frequency.exponentialRampToValueAtTime(2400, start + 0.45);
  let chain = air.connect(band).connect(envelope(ctx, start, 0.3, 0.16, 0.36));
  if (ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(0, start);
    pan.pan.linearRampToValueAtTime(0.6 * Math.sign(direction || 1), start + 0.5);
    chain = chain.connect(pan);
  }
  chain.connect(ctx.destination);
  air.start(start);
  air.stop(start + 0.6);
}

/** A soft two-note chime: the Focus timer has run out. */
export function chime() {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  [[784, 0], [1175, 0.14]].forEach(([frequency, delay]) => {
    const tone = new OscillatorNode(ctx, { type: 'sine', frequency });
    tone.connect(envelope(ctx, now + delay, 0.16, 0.01, 1.4)).connect(ctx.destination);
    tone.start(now + delay);
    tone.stop(now + delay + 1.5);
  });
}

/**
 * Paper being balled up in the hands: not one burst but squeezes. Each
 * squeeze is a dense run of tiny dry crackles (the fibres snapping) over a
 * soft rustle of the sheet sliding against itself, with a short pause where
 * the hands give before squeezing harder. Lasts about `seconds`.
 */
export function crumple(seconds = 0.56) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const length = Math.max(0.25, seconds);
  // squeezes: [start, end, loudness], as fractions of the whole (matches trash.js)
  const squeezes = [[0, 0.2, 0.75], [0.3, 0.55, 1], [0.64, 0.95, 0.85]];

  for (const [from, to, loud] of squeezes) {
    const start = now + from * length;
    const end = now + to * length;

    // the rustle: soft, mid-high noise swelling with the squeeze
    const rustle = ctx.createBufferSource();
    rustle.buffer = noiseBuffer(ctx);
    const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2400, Q: 0.6 });
    const swell = ctx.createGain();
    swell.gain.setValueAtTime(0.0001, start);
    swell.gain.exponentialRampToValueAtTime(0.05 * loud, start + (end - start) * 0.4);
    swell.gain.exponentialRampToValueAtTime(0.0001, end + 0.04);
    rustle.connect(band).connect(swell).connect(ctx.destination);
    rustle.start(start, Math.random() * 0.5);
    rustle.stop(end + 0.06);

    // the crackles: many tiny sharp clicks, densest in the middle of the squeeze
    const count = Math.round((end - start) * 170);
    for (let i = 0; i < count; i++) {
      const p = Math.random();
      const at = start + (end - start) * p;
      const strength = Math.sin(p * Math.PI) * (0.4 + Math.random() * 0.6) * loud;
      const grain = ctx.createBufferSource();
      grain.buffer = noiseBuffer(ctx);
      const color = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 1400 + Math.random() * 4500 });
      const env = ctx.createGain();
      const decay = 0.004 + Math.random() * 0.012;
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(0.02 + strength * 0.2, at + 0.0008);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      grain.connect(color).connect(env).connect(ctx.destination);
      grain.start(at, Math.random() * 0.9);
      grain.stop(at + decay + 0.01);
    }
  }
}

let lastOpen = 0;

/** The bin's lid swinging open: a light hinge tick and a soft hollow "tock". */
export function binOpen() {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (now - lastOpen < 0.4) return; // hovering in and out shouldn't chatter
  lastOpen = now;

  const tick = ctx.createBufferSource();
  tick.buffer = noiseBuffer(ctx);
  const bright = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3600, Q: 3 });
  tick.connect(bright).connect(envelope(ctx, now, 0.06, 0.001, 0.02)).connect(ctx.destination);
  tick.start(now, Math.random() * 0.5);
  tick.stop(now + 0.04);

  const tock = new OscillatorNode(ctx, { type: 'sine', frequency: 520 });
  tock.frequency.exponentialRampToValueAtTime(640, now + 0.08);
  tock.connect(envelope(ctx, now + 0.01, 0.07, 0.004, 0.1)).connect(ctx.destination);
  tock.start(now + 0.01);
  tock.stop(now + 0.14);
}

/** When the lid lands, in seconds (matches the lid-slam animation in styles.css). */
const SLAM_AT = 0.28; // the lid lands 36% into its 780 ms fall (styles.css, lid-slam)

/**
 * The bin eating: the ball lands with a soft paper thump, then the lid swings
 * shut: a short, solid "clunk" of a well-made pedal bin closing (a damped
 * knock with a little low body), and a faint second tap as it settles.
 * No ringing.
 */
export function slam() {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;

  // the ball landing inside
  const thump = new OscillatorNode(ctx, { type: 'sine', frequency: 150 });
  thump.frequency.exponentialRampToValueAtTime(70, now + 0.12);
  thump.connect(envelope(ctx, now, 0.12, 0.004, 0.12)).connect(ctx.destination);
  thump.start(now);
  thump.stop(now + 0.18);

  lidClose(ctx, now + SLAM_AT, 1);
  lidClose(ctx, now + SLAM_AT + 0.075, 0.28); // it settles on the rim
}

/** One knock of the lid on the rim: `strength` 0–1. */
function lidClose(ctx, at, strength) {
  // the contact: a dull, short knock (filtered noise, no high fizz)
  const knock = ctx.createBufferSource();
  knock.buffer = noiseBuffer(ctx);
  const dull = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 900, Q: 0.9 });
  const soft = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2400 });
  knock.connect(dull).connect(soft).connect(envelope(ctx, at, 0.32 * strength, 0.0015, 0.035)).connect(ctx.destination);
  knock.start(at, Math.random() * 0.5);
  knock.stop(at + 0.06);

  // the body: the bin's hollow, quickly damped
  const body = new OscillatorNode(ctx, { type: 'triangle', frequency: 230 });
  body.frequency.exponentialRampToValueAtTime(140, at + 0.07);
  const warm = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 700 });
  body.connect(warm).connect(envelope(ctx, at, 0.26 * strength, 0.002, 0.075)).connect(ctx.destination);
  body.start(at);
  body.stop(at + 0.11);

  // a low floor under it, felt more than heard
  const floor = new OscillatorNode(ctx, { type: 'sine', frequency: 85 });
  floor.connect(envelope(ctx, at, 0.18 * strength, 0.003, 0.09)).connect(ctx.destination);
  floor.start(at);
  floor.stop(at + 0.12);
}

/** A note pressed onto the wall: a soft, papery slap with a little body. */
export function slap() {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;

  const paper = ctx.createBufferSource();
  paper.buffer = noiseBuffer(ctx);
  const soft = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2200, Q: 0.5 });
  paper.connect(soft).connect(envelope(ctx, now, 0.24, 0.003, 0.07)).connect(ctx.destination);
  paper.start(now, Math.random() * 0.5);
  paper.stop(now + 0.1);

  const body = new OscillatorNode(ctx, { type: 'sine', frequency: 180 });
  body.frequency.exponentialRampToValueAtTime(90, now + 0.06);
  body.connect(envelope(ctx, now, 0.12, 0.002, 0.06)).connect(ctx.destination);
  body.start(now);
  body.stop(now + 0.1);
}

/** A pin going into the board: a tiny bright click and a dull tap under it. */
export function pinClick(pinning = true) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;

  const tick = ctx.createBufferSource();
  tick.buffer = noiseBuffer(ctx);
  const bright = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: pinning ? 4200 : 3200, Q: 2.5 });
  tick.connect(bright).connect(envelope(ctx, now, 0.2, 0.001, 0.025)).connect(ctx.destination);
  tick.start(now, Math.random() * 0.5);
  tick.stop(now + 0.05);

  const tap = new OscillatorNode(ctx, { type: 'triangle', frequency: pinning ? 900 : 700 });
  tap.frequency.exponentialRampToValueAtTime(pinning ? 420 : 520, now + 0.04);
  tap.connect(envelope(ctx, now + 0.012, 0.09, 0.002, 0.05)).connect(ctx.destination);
  tap.start(now + 0.012);
  tap.stop(now + 0.08);
}

/** A soft whoosh for the end-of-day sweep: lighter than the fly-away, pitch rising with `step`. */
export function sweep(step = 0) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const air = ctx.createBufferSource();
  air.buffer = noiseBuffer(ctx);
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', Q: 1 });
  band.frequency.setValueAtTime(500 + step * 60, now);
  band.frequency.exponentialRampToValueAtTime(2600 + step * 120, now + 0.3);
  air.connect(band).connect(envelope(ctx, now, 0.14, 0.08, 0.26)).connect(ctx.destination);
  air.start(now, Math.random() * 0.5);
  air.stop(now + 0.4);
}

/** A small rising pair of notes: "this one". */
export function pick() {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  [[660, 0], [990, 0.09]].forEach(([frequency, delay]) => {
    const tone = new OscillatorNode(ctx, { type: 'sine', frequency });
    tone.connect(envelope(ctx, now + delay, 0.1, 0.006, 0.35)).connect(ctx.destination);
    tone.start(now + delay);
    tone.stop(now + delay + 0.4);
  });
}

/**
 * Paper sliding: a pile fanning out (or gathering up). One soft, short swish
 * per sheet, each a little different, one after another.
 */
export function riffle(count = 3) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (let i = 0; i < Math.min(count, 8); i++) {
    const at = now + i * 0.05 + Math.random() * 0.012;
    const swish = ctx.createBufferSource();
    swish.buffer = noiseBuffer(ctx);
    const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1700 + Math.random() * 1100, Q: 0.7 });
    const soft = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5200 });
    swish.connect(band).connect(soft).connect(envelope(ctx, at, 0.045 * (1 - i * 0.06), 0.018, 0.075)).connect(ctx.destination);
    swish.start(at, Math.random() * 0.5);
    swish.stop(at + 0.12);
  }
}
