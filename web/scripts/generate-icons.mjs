// Génère les icônes PWA dans web/public/icons/ — Node pur (zlib), aucune dépendance.
// Usage : node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');

const BG = [26, 35, 126]; // #1a237e (accent)
const CARD_BACK = [232, 234, 246]; // #e8eaf6
const CARD = [255, 255, 255];
const BARS = [26, 35, 126];
const SS = 4; // supersampling 4x4 par pixel

// --- Encodeur PNG (RGBA 8 bits) ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filtre none
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Dessin : couverture anti-aliased par supersampling ---
// Rectangle arrondi : { cx, cy, w, h, r, rot? } en coordonnées "512".
function insideRRect(px, py, rr) {
  let x = px - rr.cx;
  let y = py - rr.cy;
  if (rr.rot) {
    const a = rr.rot;
    const rx = x * Math.cos(a) + y * Math.sin(a);
    const ry = -x * Math.sin(a) + y * Math.cos(a);
    x = rx;
    y = ry;
  }
  const hw = rr.w / 2;
  const hh = rr.h / 2;
  const qx = Math.abs(x) - (hw - rr.r);
  const qy = Math.abs(y) - (hh - rr.r);
  if (qx <= 0 && qy <= 0) return true; // zone centrale
  if (qx > rr.r || qy > rr.r) return false;
  const dx = Math.max(qx, 0);
  const dy = Math.max(qy, 0);
  return dx * dx + dy * dy <= rr.r * rr.r;
}

function coverage(px, py, rr) {
  let hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      if (insideRRect(px + (sx + 0.5) / SS - 0.5, py + (sy + 0.5) / SS - 0.5, rr)) hits++;
    }
  }
  return hits / (SS * SS);
}

function render(size, { maskable = false, opaqueSquare = false } = {}) {
  const s = 512 / size; // pixel canvas → espace de dessin 512
  const glyphScale = maskable ? 0.62 : 1; // zone sûre maskable : glyphe dans le carré central
  const bg = {
    cx: 256, cy: 256,
    w: opaqueSquare ? 512 : 512 - 44, // coins arrondis transparents pour "any"
    h: opaqueSquare ? 512 : 512 - 44,
    r: opaqueSquare ? 0 : 92,
  };
  const g = (v) => 256 + (v - 256) * glyphScale; // recentre le glyphe
  const layers = [
    // carte arrière, légèrement inclinée, qui dépasse en haut à droite
    { rr: { cx: g(318), cy: g(206), w: 212 * glyphScale, h: 268 * glyphScale, r: 26 * glyphScale, rot: 10 * (Math.PI / 180) }, color: CARD_BACK },
    // carte avant
    { rr: { cx: g(238), cy: g(292), w: 236 * glyphScale, h: 298 * glyphScale, r: 28 * glyphScale }, color: CARD },
    // lignes de "texte" sur la carte avant
    { rr: { cx: g(168), cy: g(194), w: 142 * glyphScale, h: 28 * glyphScale, r: 10 * glyphScale }, color: BARS },
    { rr: { cx: g(134), cy: g(258), w: 100 * glyphScale, h: 24 * glyphScale, r: 9 * glyphScale }, color: BARS },
    { rr: { cx: g(144), cy: g(310), w: 118 * glyphScale, h: 24 * glyphScale, r: 9 * glyphScale }, color: BARS },
  ];

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * s;
      const py = (y + 0.5) * s;
      let r = 0, gch = 0, b = 0, a = 0;
      const bgA = opaqueSquare ? 1 : coverage(px, py, bg);
      if (bgA > 0) { r = BG[0]; gch = BG[1]; b = BG[2]; a = bgA; }
      for (const { rr, color } of layers) {
        const cov = rr === undefined ? 0 : coverage(px, py, rr);
        if (cov > 0) {
          r = r * (1 - cov) + color[0] * cov;
          gch = gch * (1 - cov) + color[1] * cov;
          b = b * (1 - cov) + color[2] * cov;
          a = a + cov * (1 - a);
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(gch);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
const outputs = [
  ['icon-192.png', render(192)],
  ['icon-512.png', render(512)],
  ['icon-maskable-512.png', render(512, { maskable: true, opaqueSquare: true })],
  ['apple-touch-icon.png', render(180, { opaqueSquare: true })],
];
for (const [name, png] of outputs) {
  const file = join(outDir, name);
  writeFileSync(file, png);
  // Vérification : relire l'en-tête IHDR pour confirmer un PNG valide de la taille attendue.
  const sizeMatch = /^.*-(\d+)\.png$|^apple-touch-icon\.png$/.exec(name);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const expected = name === 'apple-touch-icon.png' ? 180 : Number(sizeMatch[1]);
  if (png[0] !== 0x89 || w !== expected || h !== expected) {
    throw new Error(`${name}: PNG invalide (${w}x${h}, attendu ${expected})`);
  }
  console.log(`${name} : ${w}x${h}, ${png.length} octets — OK`);
}
console.log(`Icônes écrites dans ${outDir}`);
