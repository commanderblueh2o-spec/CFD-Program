// Colour maps. Default: single-hue sequential blue (dark surface: near-zero recedes to
// the surface, high values are light). Viridis offered for users who prefer it.

export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];

const RAMPS = {
  blue: ['#1d2a40', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb', '#eef5fe'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  // diverging, for differences (B − A): blue = thinner, dark neutral = no change, orange = thicker
  diverge: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#1f3350', '#2c2f36', '#4f3218', '#9a4f13', '#d95926', '#eba963', '#faead3'],
  cure: ['#1a2333', '#3b2a1a', '#6b3b12', '#9a4f13', '#c66a1c', '#e08a35', '#eba963', '#f3cb98', '#faead3'],
};

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const LUT = {};
for (const [name, stops] of Object.entries(RAMPS)) {
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (rgb.length - 1);
    const a = Math.min(rgb.length - 2, Math.floor(t)), f = t - a;
    for (let c = 0; c < 3; c++) lut[3 * i + c] = Math.round(rgb[a][c] * (1 - f) + rgb[a + 1][c] * f);
  }
  LUT[name] = lut;
}
export const COLORMAPS = Object.keys(RAMPS).filter((k) => k !== 'diverge');

export function colorAt(name, t) {
  const lut = LUT[name] || LUT.blue;
  const i = Math.max(0, Math.min(255, Math.round((isFinite(t) ? t : 0) * 255)));
  return [lut[3 * i], lut[3 * i + 1], lut[3 * i + 2]];
}

export function gradientCSS(name) {
  const stops = RAMPS[name] || RAMPS.blue;
  return `linear-gradient(to right, ${stops.map((c, i) => `${c} ${((i / (stops.length - 1)) * 100).toFixed(1)}%`).join(', ')})`;
}

export function niceRange(min, max) {
  if (!isFinite(min) || !isFinite(max)) return [0, 1];
  if (max - min < 1e-12) return [min - (Math.abs(min) * 0.1 || 0.5), max + (Math.abs(max) * 0.1 || 0.5)];
  return [min, max];
}

export function fmt(v, digits = 3) {
  if (v === null || v === undefined || !isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toPrecision(digits);
}
