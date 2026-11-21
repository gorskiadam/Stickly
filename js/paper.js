// paper.js — what crumpled paper looks like. Shared by the throw into the bin
// (trash.js), the balls inside it (binpeek.js) and a note unfolding (ui.js).
//
// A sheet is drawn as an outline with the same number of points at every
// stage, so the browser can morph it: a flat square, a sheet squeezed in the
// hand, a lumpy ball. Over it lies a pattern of faceted creases: a jittered
// grid of triangles, each lit or shaded a little differently, like paper that
// was really balled up and pulled open again.

/** Points along each side of the square outline. */
const PER_SIDE = 7;
const POINTS = PER_SIDE * 4;

/** A small seeded random generator, so one sheet keeps the same wrinkles. */
export function seeded(seed = Math.random() * 1e9) {
  let s = Math.floor(seed) % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** The flat sheet: the points walk round the square, clockwise from the top left. */
function squarePoints() {
  const pts = [];
  for (let i = 0; i < PER_SIDE; i++) pts.push([i / PER_SIDE, 0]);
  for (let i = 0; i < PER_SIDE; i++) pts.push([1, i / PER_SIDE]);
  for (let i = 0; i < PER_SIDE; i++) pts.push([1 - i / PER_SIDE, 1]);
  for (let i = 0; i < PER_SIDE; i++) pts.push([0, 1 - i / PER_SIDE]);
  return pts;
}

/** The ball: the same points pulled in round the middle, lumpy and uneven. */
function ballPoints(rand) {
  const pts = [];
  for (let i = 0; i < POINTS; i++) {
    // the square's points, measured as angles from the centre
    const [x, y] = squarePoints()[i];
    const angle = Math.atan2(y - 0.5, x - 0.5);
    // knobbly: every other point dents in, a few bulge out
    const r = 0.37 + (i % 2 ? -0.025 : 0.015) + (rand() - 0.5) * 0.06;
    pts.push([0.5 + Math.cos(angle) * r, 0.5 + Math.sin(angle) * r]);
  }
  return pts;
}

const toPolygon = (pts) => `polygon(${pts.map(([x, y]) => `${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%`).join(', ')})`;

/**
 * Outlines for one sheet, from flat (0) to a ball (1). Between them the edges
 * buckle: points are pushed in and out at random, more as the squeeze goes on.
 * Returns { at(amount) } giving a CSS clip-path polygon.
 */
export function crumpleShapes(seed) {
  const rand = seeded(seed);
  const flat = squarePoints();
  const ball = ballPoints(rand);
  // how each point buckles while being squeezed: fixed per sheet
  const buckle = flat.map(() => [(rand() - 0.5) * 0.22, (rand() - 0.5) * 0.22]);
  return {
    at(amount) {
      if (amount <= 0) return toPolygon(flat);
      if (amount >= 1) return toPolygon(ball);
      // strongest buckling half-way; it smooths out again into the ball
      const wobble = Math.sin(amount * Math.PI) * 1.1;
      // ease: the edges give way quickly, then the middle packs tight
      const k = 1 - (1 - amount) ** 1.6;
      return toPolygon(flat.map(([x, y], i) => [
        x + (ball[i][0] - x) * k + buckle[i][0] * wobble,
        y + (ball[i][1] - y) * k + buckle[i][1] * wobble,
      ]));
    },
  };
}

/** Flat and ball outlines that any sheet can use (for CSS-only shapes). */
export const FLAT = toPolygon(squarePoints());

/**
 * The crease pattern: an SVG of lit and shaded facets, as a CSS background
 * image. `depth` (0–1) sets how hard it was crumpled.
 */
export function creaseImage(seed, depth = 1) {
  const rand = seeded(seed);
  const n = 6; // facets across
  const size = 120;
  const step = size / n;
  // a grid of points, shaken out of line (the edges stay put)
  const grid = [];
  for (let row = 0; row <= n; row++) {
    grid.push([]);
    for (let col = 0; col <= n; col++) {
      const edge = row === 0 || col === 0 || row === n || col === n;
      const jx = edge ? 0 : (rand() - 0.5) * step * 0.9;
      const jy = edge ? 0 : (rand() - 0.5) * step * 0.9;
      grid[row].push([col * step + jx, row * step + jy]);
    }
  }
  // light comes from the top left: a facet tilted towards it is brighter
  const facet = (a, b, c) => {
    const nx = (b[1] - a[1]) * (c[0] - a[0]) - (c[1] - a[1]) * (b[0] - a[0]);
    const tilt = Math.tanh(nx / (step * step)) * 0.5 + (rand() - 0.5) * 0.9;
    const alpha = Math.min(0.3, Math.abs(tilt) * 0.32 * depth + 0.02);
    const fill = tilt > 0 ? '#fff' : '#000';
    const shade = tilt > 0 ? alpha * 1.1 : alpha * 0.8;
    return `<path d='M${a.map(round)}L${b.map(round)}L${c.map(round)}Z' fill='${fill}' fill-opacity='${shade.toFixed(3)}'/>`;
  };
  let paths = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const p = grid[row][col];
      const q = grid[row][col + 1];
      const r = grid[row + 1][col + 1];
      const s = grid[row + 1][col];
      // split each cell along a random diagonal, like real folds
      if (rand() > 0.5) paths += facet(p, q, r) + facet(p, r, s);
      else paths += facet(p, q, s) + facet(q, r, s);
    }
  }
  // a few sharp ridge lines where the paper folded hardest
  let ridges = '';
  for (let i = 0; i < 4; i++) {
    const a = grid[1 + Math.floor(rand() * (n - 1))][Math.floor(rand() * (n + 1))];
    const b = grid[Math.floor(rand() * (n + 1))][1 + Math.floor(rand() * (n - 1))];
    ridges += `<path d='M${a.map(round)}L${b.map(round)}' stroke='#fff' stroke-opacity='${(0.22 * depth).toFixed(2)}' stroke-width='0.7'/>`;
  }
  // a slight blur takes the hard edge off the facets: paper, not cut glass
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}' preserveAspectRatio='none'><filter id='s'><feGaussianBlur stdDeviation='0.6'/></filter><g filter='url(#s)'>${paths}</g>${ridges}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const round = (v) => Math.round(v * 10) / 10;
