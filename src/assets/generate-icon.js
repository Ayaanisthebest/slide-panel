#!/usr/bin/env node
// Generates a macOS menu-bar template icon (transparent + black) at 1x and 2x.
// Run from anywhere: `node src/assets/generate-icon.js`
//
// Uses only Node built-ins (zlib) so the build has no extra dependencies.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Pixel art (16x16). "#" = opaque black, "." = transparent.
// A simple "side panel" glyph: rounded-ish rectangle with the left column
// filled in, evoking a sidebar that slides out.
const ART = [
  "................",
  "................",
  ".##############.",
  ".#............#.",
  ".#####........#.",
  ".#####........#.",
  ".#####........#.",
  ".#####........#.",
  ".#####........#.",
  ".#####........#.",
  ".#####........#.",
  ".#####........#.",
  ".#####........#.",
  ".#............#.",
  ".##############.",
  "................",
];

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// Encode a width x height image as PNG using color type 4 (grayscale + alpha).
// `pixels` is a Uint8Array of length width*height*2 ([gray, alpha, gray, alpha, ...]).
function encodePng(width, height, pixels) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 4; // color type: grayscale + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 2;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 2;
      const dst = y * (stride + 1) + 1 + x * 2;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pixelsFromArt(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const pixels = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const opaque = rows[y][x] === "#";
      const idx = (y * width + x) * 2;
      pixels[idx] = 0; // template images: gray is ignored, only alpha matters
      pixels[idx + 1] = opaque ? 255 : 0;
    }
  }
  return pixels;
}

function scaleArt(rows, factor) {
  const out = [];
  for (const row of rows) {
    let scaled = "";
    for (const ch of row) scaled += ch.repeat(factor);
    for (let i = 0; i < factor; i += 1) out.push(scaled);
  }
  return out;
}

const outDir = __dirname;
const w = ART[0].length;
const h = ART.length;

fs.writeFileSync(
  path.join(outDir, "iconTemplate.png"),
  encodePng(w, h, pixelsFromArt(ART))
);

const art2x = scaleArt(ART, 2);
fs.writeFileSync(
  path.join(outDir, "iconTemplate@2x.png"),
  encodePng(w * 2, h * 2, pixelsFromArt(art2x))
);

console.log(
  `Wrote iconTemplate.png (${w}x${h}) and iconTemplate@2x.png (${w * 2}x${h * 2}) to ${outDir}`
);
