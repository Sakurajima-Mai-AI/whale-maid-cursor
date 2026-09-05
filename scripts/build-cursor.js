#!/usr/bin/env node
/**
 * build-cursor.js - dependency-free (Node built-ins only) cursor asset builder
 * for the DeepSeek Harness "custom cursor" plugin.
 *
 * Pipeline:
 *   1. Decode any common PNG (RGB/RGBA/gray/gray+alpha/palette, 8/16-bit, non-interlaced).
 *   2. Remove a solid background (default: white) by border-connected flood fill,
 *      then peel anti-aliased fringe pixels.
 *   3. Crop to the opaque bounding box.
 *   4. Resample (area average, premultiplied alpha) so the art fits inside
 *      MAX_SIZE pixels on its longer side.
 *   5. Guess a hotspot (x = body axis, y = lowest central-band opaque row = "feet").
 *   6. Write:
 *        assets/cursor.png        - transparent cursor image (what the browser shows)
 *        assets/cursor-meta.json  - build metadata incl. hotspot
 *        assets/preview.png       - checkerboard preview with hotspot marker
 *        plugin/client.js         - self-contained Client plugin code (paste into code.client)
 *
 * Usage:
 *   node scripts/build-cursor.js
 *   node scripts/build-cursor.js --size 64 --hotspot 30,60 --tol 30
 *   node scripts/build-cursor.js --no-bg          # input is already transparent
 *
 * License: MIT
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const PLUGIN = path.join(ROOT, 'plugin');

const CONFIG = {
  input: path.join(ASSETS, 'source.png'),
  outputPng: path.join(ASSETS, 'cursor.png'),
  outputMeta: path.join(ASSETS, 'cursor-meta.json'),
  outputPreview: path.join(ASSETS, 'preview.png'),
  outputClient: path.join(PLUGIN, 'client.js'),
  maxSize: 48,
  removeBg: true,
  bgColor: [255, 255, 255],
  bgTolerance: 36,
  erodePasses: [190, 235],
  opaqueAlpha: 24,
  hotspot: null,
};

function parseArgs(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--size') CONFIG.maxSize = parseInt(argv[++i], 10);
    else if (a === '--tol') CONFIG.bgTolerance = parseInt(argv[++i], 10);
    else if (a === '--no-bg') CONFIG.removeBg = false;
    else if (a === '--hotspot') {
      const [x, y] = argv[++i].split(',').map((s) => parseInt(s, 10));
      CONFIG.hotspot = [x, y];
    } else if (a === '--bg') {
      const p = argv[++i].split(',');
      CONFIG.bgColor = [parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, parseInt(p[2], 10) || 0];
    } else if (a === '--help') {
      console.log('Usage: node scripts/build-cursor.js [--size N] [--hotspot x,y] [--tol N] [--bg R,G,B] [--no-bg]');
      process.exit(0);
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file');
  const chunks = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const idat = chunks.filter((c) => c.type === 'IDAT');
  if (!ihdr || idat.length === 0) throw new Error('Missing IHDR/IDAT');
  const d = ihdr.data;
  const width = d.readUInt32BE(0);
  const height = d.readUInt32BE(4);
  const bitDepth = d[8];
  const colorType = d[9];
  const interlace = d[12];
  if (interlace !== 0) throw new Error('Interlaced (Adam7) PNG not supported');
  let channels;
  if (colorType === 0) channels = 1;
  else if (colorType === 2) channels = 3;
  else if (colorType === 3) channels = 1;
  else if (colorType === 4) channels = 2;
  else if (colorType === 6) channels = 4;
  else throw new Error('Unsupported color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat.map((c) => c.data)));
  const rowLen = 1 + Math.ceil((width * channels * bitDepth) / 8);
  if (raw.length < rowLen * height) throw new Error('Truncated IDAT data');
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const filtered = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const prev = y > 0 ? filtered.subarray((y - 1) * rowLen, y * rowLen) : null;
    const cur = filtered.subarray(y * rowLen, (y + 1) * rowLen);
    const src = raw.subarray(y * rowLen, (y + 1) * rowLen);
    const ft = src[0];
    cur[0] = ft;
    for (let x = 1; x < rowLen; x++) {
      const left = x - bpp >= 1 ? cur[x - bpp] : 0;
      const up = prev ? prev[x] : 0;
      const ul = prev && x - bpp >= 1 ? prev[x - bpp] : 0;
      let val = src[x];
      if (ft === 1) val += left;
      else if (ft === 2) val += up;
      else if (ft === 3) val += (left + up) >> 1;
      else if (ft === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        val += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      } else if (ft !== 0) throw new Error('Bad filter ' + ft);
      cur[x] = val & 0xff;
    }
  }
  const plte = chunks.find((c) => c.type === 'PLTE');
  const trns = chunks.find((c) => c.type === 'tRNS');
  let palette = null;
  let palAlpha = null;
  if (colorType === 3) {
    if (!plte) throw new Error('Palette image without PLTE');
    palette = [];
    for (let i = 0; i + 2 < plte.data.length; i += 3) palette.push([plte.data[i], plte.data[i + 1], plte.data[i + 2]]);
    if (trns) {
      palAlpha = new Array(palette.length).fill(255);
      for (let i = 0; i < trns.data.length && i < palette.length; i++) palAlpha[i] = trns.data[i];
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  const rowPixels = Math.ceil((width * channels * bitDepth) / 8);
  for (let y = 0; y < height; y++) {
    const row = filtered.subarray(y * rowLen + 1, y * rowLen + 1 + rowPixels);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      if (colorType === 6) {
        if (bitDepth === 8) { r = row[x * 4]; g = row[x * 4 + 1]; b = row[x * 4 + 2]; a = row[x * 4 + 3]; }
        else { const p = x * 8; r = row[p]; g = row[p + 2]; b = row[p + 4]; a = row[p + 6]; }
      } else if (colorType === 2) {
        if (bitDepth === 8) { r = row[x * 3]; g = row[x * 3 + 1]; b = row[x * 3 + 2]; }
        else { const p = x * 6; r = row[p]; g = row[p + 2]; b = row[p + 4]; }
      } else if (colorType === 0) {
        let v;
        if (bitDepth === 8) v = row[x];
        else if (bitDepth === 16) v = row[x * 2];
        else {
          const bits = bitDepth;
          const byte = row[(x * bits) >> 3];
          const shift = 8 - bits - ((x * bits) & 7);
          v = (byte >> shift) & ((1 << bits) - 1);
          v = Math.round((v * 255) / ((1 << bits) - 1));
        }
        r = g = b = v;
      } else if (colorType === 4) {
        if (bitDepth === 8) { const v = row[x * 2]; r = g = b = v; a = row[x * 2 + 1]; }
        else { const p = x * 4; const v = row[p]; r = g = b = v; a = row[p + 2]; }
      } else if (colorType === 3) {
        const bits = bitDepth;
        let idx;
        if (bits === 8) idx = row[x];
        else {
          const byte = row[(x * bits) >> 3];
          const shift = 8 - bits - ((x * bits) & 7);
          idx = (byte >> shift) & ((1 << bits) - 1);
        }
        const pc = palette[idx] || [0, 0, 0];
        r = pc[0]; g = pc[1]; b = pc[2];
        if (palAlpha) a = palAlpha[idx] !== undefined ? palAlpha[idx] : 255;
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { width, height, rgba };
}

function nearBg(r, g, b, tol, bg) {
  return Math.abs(r - bg[0]) <= tol && Math.abs(g - bg[1]) <= tol && Math.abs(b - bg[2]) <= tol;
}

function removeBackground(width, height, rgba, tol, bg, erodePasses, opaqueAlpha) {
  const idx = (x, y) => (y * width + x) * 4;
  const stack = new Int32Array(width * height * 2);
  let sp = 0;
  const seed = (x, y) => {
    const i = idx(x, y);
    const a = rgba[i + 3];
    if (a <= 16) return;
    if (!nearBg(rgba[i], rgba[i + 1], rgba[i + 2], tol, bg)) return;
    rgba[i + 3] = 0;
    stack[sp++] = x;
    stack[sp++] = y;
  };
  for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
  for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }
  while (sp > 0) {
    const y = stack[--sp];
    const x = stack[--sp];
    if (x > 0) seed(x - 1, y);
    if (x < width - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < height - 1) seed(x, y + 1);
  }
  for (const min of erodePasses) {
    const drop = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y);
        if (rgba[i + 3] < opaqueAlpha) continue;
        const m = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
        if (m < min) continue;
        const t =
          (x > 0 && rgba[idx(x - 1, y) + 3] === 0) ||
          (x < width - 1 && rgba[idx(x + 1, y) + 3] === 0) ||
          (y > 0 && rgba[idx(x, y - 1) + 3] === 0) ||
          (y < height - 1 && rgba[idx(x, y + 1) + 3] === 0);
        if (t) drop[y * width + x] = 1;
      }
    }
    for (let p = 0; p < width * height; p++) if (drop[p]) rgba[p * 4 + 3] = 0;
  }
  // dark background: conservative fringe cleanup only — never eat the character's
  // own dark colors (navy dress etc.). Just remove very-dark pixels (pure black
  // anti-aliasing residue, <=30) that border the transparency, max two rounds.
  const lum = (bg[0] + bg[1] + bg[2]) / 3;
  if (lum < 128) {
    for (let round = 0; round < 2; round++) {
      const drop = new Uint8Array(width * height);
      let hits = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = idx(x, y);
          if (rgba[i + 3] < opaqueAlpha) continue;
          if (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) > 30) continue;
          const border = (x > 0 && rgba[idx(x - 1, y) + 3] === 0) ||
                         (x < width - 1 && rgba[idx(x + 1, y) + 3] === 0) ||
                         (y > 0 && rgba[idx(x, y - 1) + 3] === 0) ||
                         (y < height - 1 && rgba[idx(x, y + 1) + 3] === 0);
          if (border) { drop[y * width + x] = 1; hits++; }
        }
      }
      if (!hits) break;
      for (let p = 0; p < width * height; p++) if (drop[p]) rgba[p * 4 + 3] = 0;
    }
  }
}

function opaqueBounds(width, height, rgba, alphaMin) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= alphaMin) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

function cropImage(width, height, rgba, b) {
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    rgba.copy(out, y * w * 4, (b.y0 + y) * width * 4 + b.x0 * 4, (b.y0 + y) * width * 4 + (b.x0 + w) * 4);
  }
  return { width: w, height: h, rgba: out };
}

function resizeContain(img, maxSize) {
  const scale = Math.min(maxSize / img.width, maxSize / img.height);
  const ow = Math.max(1, Math.round(img.width * scale));
  const oh = Math.max(1, Math.round(img.height * scale));
  const srcW = img.width;
  const srcH = img.height;
  const dst = Buffer.alloc(ow * oh * 4);
  const xRatio = srcW / ow;
  const yRatio = srcH / oh;
  for (let dy = 0; dy < oh; dy++) {
    const y0f = dy * yRatio;
    const y1f = (dy + 1) * yRatio;
    const sy0 = Math.floor(y0f);
    const sy1 = Math.min(srcH - 1, Math.ceil(y1f) - 1);
    for (let dx = 0; dx < ow; dx++) {
      const x0f = dx * xRatio;
      const x1f = (dx + 1) * xRatio;
      const sx0 = Math.floor(x0f);
      const sx1 = Math.min(srcW - 1, Math.ceil(x1f) - 1);
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        const wy = Math.min(y1f, sy + 1) - Math.max(y0f, sy);
        if (wy <= 0) continue;
        for (let sx = sx0; sx <= sx1; sx++) {
          const wx = Math.min(x1f, sx + 1) - Math.max(x0f, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const si = (sy * srcW + sx) * 4;
          const a = img.rgba[si + 3];
          if (a === 0) continue;
          sr += img.rgba[si] * a * w;
          sg += img.rgba[si + 1] * a * w;
          sb += img.rgba[si + 2] * a * w;
          sa += a * w;
        }
      }
      const o = (dy * ow + dx) * 4;
      if (sa > 0) {
        dst[o] = Math.min(255, Math.round(sr / sa));
        dst[o + 1] = Math.min(255, Math.round(sg / sa));
        dst[o + 2] = Math.min(255, Math.round(sb / sa));
        dst[o + 3] = Math.min(255, Math.round(sa));
      }
    }
  }
  return { width: ow, height: oh, rgba: dst };
}

function computeHotspot(img, opaqueAlpha) {
  const { width: w, height: h, rgba } = img;
  let sx = 0, sn = 0;
  const topLimit = Math.max(1, Math.round(h * 0.35));
  for (let y = 0; y < topLimit; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] >= opaqueAlpha) { sx += x; sn++; }
    }
  }
  const axisX = sn > 0 ? sx / sn : w / 2;
  const band = Math.max(3, Math.round(w * 0.24));
  let hy = h - 1;
  outer: for (let y = h - 1; y >= 0; y--) {
    for (let x = Math.max(0, Math.round(axisX - band)); x <= Math.min(w - 1, Math.round(axisX + band)); x++) {
      if (rgba[(y * w + x) * 4 + 3] >= opaqueAlpha) { hy = y; break outer; }
    }
  }
  return { x: Math.round(axisX), y: hy };
}

function encodePng(width, height, rgba) {
  const rowLen = 1 + width * 4;
  const raw = Buffer.alloc(rowLen * height);
  const rowBuf = Buffer.alloc(width * 4);
  const cand = [];
  for (let f = 0; f < 5; f++) cand.push(Buffer.alloc(rowLen));
  const filteredRow = (ft, row, prev, out) => {
    out[0] = ft;
    for (let x = 0; x < width * 4; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = prev ? prev[x] : 0;
      const ul = prev && x >= 4 ? prev[x - 4] : 0;
      let v = row[x];
      if (ft === 1) v -= left;
      else if (ft === 2) v -= up;
      else if (ft === 3) v -= (left + up) >> 1;
      else if (ft === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v -= pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      out[x + 1] = v & 0xff;
    }
    let cost = 0;
    for (let x = 1; x <= width * 4; x++) cost += out[x] < 128 ? out[x] : 256 - out[x];
    return cost;
  };
  for (let y = 0; y < height; y++) {
    rgba.copy(rowBuf, 0, y * width * 4, (y + 1) * width * 4);
    const prev = y > 0 ? raw.subarray((y - 1) * rowLen + 1, y * rowLen) : null;
    let best = 0;
    let bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = filteredRow(f, rowBuf, prev, cand[f]);
      if (c < bestCost) { bestCost = c; best = f; }
    }
    cand[best].copy(raw, y * rowLen);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'latin1');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function nearestScale(img, factor) {
  const w = img.width * factor;
  const h = img.height * factor;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / factor);
      const si = (sy * img.width + sx) * 4;
      const o = (y * w + x) * 4;
      out[o] = img.rgba[si];
      out[o + 1] = img.rgba[si + 1];
      out[o + 2] = img.rgba[si + 2];
      out[o + 3] = img.rgba[si + 3];
    }
  }
  return { width: w, height: h, rgba: out };
}

function makePreview(cursor, hotspot, factor) {
  const m = factor * 4;
  const pw = cursor.width * factor + m * 2;
  const ph = cursor.height * factor + m * 2;
  const out = Buffer.alloc(pw * ph * 4);
  const square = factor * 3;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      const cx = Math.floor(x / square);
      const cy = Math.floor(y / square);
      const light = (cx + cy) % 2 === 0;
      const v = light ? 226 : 244;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  const big = nearestScale(cursor, factor);
  const ox = m;
  const oy = m;
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const si = (y * big.width + x) * 4;
      const a = big.rgba[si + 3];
      if (a === 0) continue;
      const di = ((oy + y) * pw + (ox + x)) * 4;
      const sa = a / 255;
      out[di] = Math.round(big.rgba[si] * sa + out[di] * (1 - sa));
      out[di + 1] = Math.round(big.rgba[si + 1] * sa + out[di + 1] * (1 - sa));
      out[di + 2] = Math.round(big.rgba[si + 2] * sa + out[di + 2] * (1 - sa));
      out[di + 3] = 255;
    }
  }
  const hx = ox + hotspot.x * factor;
  const hy = oy + hotspot.y * factor;
  const arm = factor;
  const setPx = (px, py) => {
    if (px < 0 || py < 0 || px >= pw || py >= ph) return;
    const i = (py * pw + px) * 4;
    out[i] = 255; out[i + 1] = 0; out[i + 2] = 255; out[i + 3] = 255;
  };
  for (let d = -arm; d <= arm; d++) { setPx(hx + d, hy); setPx(hx, hy + d); }
  return { width: pw, height: ph, rgba: out };
}

function generateClient(meta) {
  const L = [];
  L.push('// DeepSeek Harness "custom cursor" plugin - CLIENT half.');
  L.push('// Generated by scripts/build-cursor.js - do not edit by hand.');
  L.push('// Requires the matching HOST half (plugin/host.js), which serves');
  L.push('// assets/cursor.png at the URL referenced below.');
  L.push('// Rebuild:  node scripts/build-cursor.js');
  L.push('');
  L.push('// ---- Tunables -----------------------------------------------------------');
  L.push('// Hotspot inside the cursor image, in pixels from its top-left corner.');
  L.push('const HOTSPOT = { x: ' + meta.hotspot.x + ', y: ' + meta.hotspot.y + ' };');
  L.push('// HTTP path registered by plugin/host.js (keep in sync with its ROUTE).');
  L.push("const CURSOR_URL = '/.dsh-cursor/cursor.png';");
  L.push('// Set false to disable the custom cursor without uninstalling the plugin.');
  L.push('const ENABLED = true;');
  L.push('// Optional extra CSS appended after the cursor rules, e.g.:');
  L.push('//   "a, button, input, textarea, [role=button] { cursor: pointer !important; }"');
  L.push("const EXTRA_RULES = '';");
  L.push('');
  L.push('return {');
  L.push('  apply(ctx) {');
  L.push('    if (!ENABLED) return;');
  L.push("    const cur = 'url(\\\"' + CURSOR_URL + '\\\") ' + HOTSPOT.x + ' ' + HOTSPOT.y + ', auto';");
  L.push("    const css = '*{cursor:' + cur + ' !important}' +");
  L.push("              'html,body{cursor:' + cur + ' !important}' +");
  L.push("              (EXTRA_RULES ? EXTRA_RULES : '');");
  L.push('    styles.insert(css);');
  L.push('  },');
  L.push('};');
  L.push('');
  return L.join('\n');
}

function main() {
  parseArgs(process.argv);
  const SIZES = [32, 48, 64, 96];
  const STATES = [
    { name: 'idle',   src: path.join(ASSETS, 'states', 'idle', 'source.png'),   buddyOnly: false },
    { name: 'typing', src: path.join(ASSETS, 'states', 'typing', 'source.png'), buddyOnly: false },
    { name: 'busy',   src: path.join(ASSETS, 'states', 'busy', 'source.png'),   buddyOnly: false },
    { name: 'angry',  src: path.join(ASSETS, 'states', 'angry', 'source.png'),  buddyOnly: true },
    { name: 'shy',    src: path.join(ASSETS, 'states', 'shy', 'source.png'),    buddyOnly: true },
  ];
  const BUDDY_SRC = path.join(ASSETS, 'buddy', 'source.png');
  const BUDDY_MAX = 480;
  const manifest = { states: {}, buddy: null };

  const detectBg = (img) => {
    let sr = 0, sg = 0, sb = 0, n = 0;
    const step = 6;
    const probe = (x, y) => {
      const o = (y * img.width + x) * 4;
      if (img.rgba[o + 3] < 128) return;
      sr += img.rgba[o]; sg += img.rgba[o + 1]; sb += img.rgba[o + 2]; n++;
    };
    for (let x = 0; x < img.width; x += step) { probe(x, 0); probe(x, img.height - 1); }
    for (let y = step; y < img.height - 1; y += step) { probe(0, y); probe(img.width - 1, y); }
    if (n === 0) return null;
    const cr = sr / n, cg = sg / n, cb = sb / n;
    let dr = 0, dg = 0, db = 0;
    for (let x = 0; x < img.width; x += step) {
      const o = (x) * 4; const o2 = ((img.height - 1) * img.width + x) * 4;
      const pr = [o, o2];
    }
    for (let y = 0; y < img.height; y += step) {
      const o3 = (y * img.width) * 4; const o4 = (y * img.width + img.width - 1) * 4;
      const pr2 = [o3, o4];
    }
    // simpler deviation pass over same probes
    let dev = 0, m = 0;
    const devProbe = (x, y) => {
      const o = (y * img.width + x) * 4;
      if (img.rgba[o + 3] < 128) return;
      m++;
      dev += Math.abs(img.rgba[o] - cr) + Math.abs(img.rgba[o + 1] - cg) + Math.abs(img.rgba[o + 2] - cb);
    };
    for (let x = 0; x < img.width; x += step) { devProbe(x, 0); devProbe(x, img.height - 1); }
    for (let y = step; y < img.height - 1; y += step) { devProbe(0, y); devProbe(img.width - 1, y); }
    const avgDev = m > 0 ? dev / (m * 3) : 0;
    if (avgDev > 34) return Object.assign([], CONFIG.bgColor);
    return [Math.round(cr), Math.round(cg), Math.round(cb)];
  };

  const processArt = (srcPath) => {
    if (!fs.existsSync(srcPath)) return null;
    const buf = fs.readFileSync(srcPath);
    const img = decodePng(buf);
    console.log('  source ' + srcPath + ' : ' + img.width + 'x' + img.height + ' (' + buf.length + ' B)');
    let removedBg = null;
    if (CONFIG.removeBg) {
      removedBg = detectBg(img);
      if (removedBg) {
        console.log('    detected bg: rgb(' + removedBg[0] + ',' + removedBg[1] + ',' + removedBg[2] + ')');
        removeBackground(img.width, img.height, img.rgba, CONFIG.bgTolerance, removedBg, CONFIG.erodePasses, CONFIG.opaqueAlpha);
      }
    }
    const bbox = opaqueBounds(img.width, img.height, img.rgba, CONFIG.opaqueAlpha);
    if (!bbox) { console.log('  -> fully transparent after processing; skipped'); return null; }
    const cropped = cropImage(img.width, img.height, img.rgba, bbox);
    return { cropped: cropped, srcSize: { width: img.width, height: img.height, bytes: buf.length }, bbox: bbox, removedBg: removedBg };
  };

  const emitState = (stateName, cropped, dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const out = [];
    for (const S of SIZES) {
      const r = resizeContain(cropped, S);
      const p = encodePng(r.width, r.height, r.rgba);
      const file = 'cursor-' + S + '.png';
      fs.writeFileSync(path.join(dir, file), p);
      out.push({ size: S, file: file, width: r.width, height: r.height });
      console.log('    wrote ' + path.join(dir, file) + ' (' + r.width + 'x' + r.height + ', ' + p.length + ' B)');
    }
    return out;
  };

  console.log('=== cursor states ===');
  let idleCropped = null;
  const processedArts = {};
  for (const st of STATES) {
    if (st.buddyOnly) continue;
    let art = processArt(st.src);
    if (!art && st.name !== 'idle') {
      console.log('  state "' + st.name + '" has no source art -> reusing idle art as placeholder');
      if (idleCropped) art = { cropped: idleCropped, srcSize: null, bbox: null };
    }
    if (!art) {
      console.error('FATAL: idle source missing: ' + st.src);
      process.exit(1);
    }
    const sizes = emitState(st.name, art.cropped, path.join(ASSETS, 'states', st.name));
    manifest.states[st.name] = { source: st.src, sizes: sizes };
    if (st.name === 'idle') {
      idleCropped = art.cropped;
      // legacy single-art outputs
      for (const s of sizes) {
        const legacy = path.join(ASSETS, 'cursor-' + s.size + '.png');
        fs.copyFileSync(path.join(ASSETS, 'states', 'idle', s.file), legacy);
      }
    }
    processedArts[st.name] = art.cropped;
  }

  console.log('=== buddy (one image per state/mood) ===');
  fs.mkdirSync(path.join(ASSETS, 'buddy'), { recursive: true });
  const buddyStates = {};
  for (const st of STATES) {
    let bart = st.buddyOnly ? processArt(st.src) : (processedArts[st.name] ? { cropped: processedArts[st.name] } : processArt(st.src));
    if (!bart && idleCropped) bart = { cropped: idleCropped };
    if (!bart) continue;
    const r = resizeContain(bart.cropped, BUDDY_MAX);
    const file = st.name + '.png';
    fs.writeFileSync(path.join(ASSETS, 'buddy', file), encodePng(r.width, r.height, r.rgba));
    buddyStates[st.name] = { file: file, width: r.width, height: r.height };
    console.log('    wrote assets/buddy/' + file + ' (' + r.width + 'x' + r.height + ')');
  }
  manifest.buddy = { states: buddyStates };

  fs.writeFileSync(path.join(ASSETS, 'states-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote assets/states-manifest.json');

  // legacy meta + preview (idle reference)
  if (idleCropped) {
    const ref = resizeContain(idleCropped, CONFIG.maxSize);
    const hotspot = CONFIG.hotspot ? { x: CONFIG.hotspot[0], y: CONFIG.hotspot[1] } : computeHotspot(ref, CONFIG.opaqueAlpha);
    hotspot.x = Math.max(0, Math.min(ref.width - 1, hotspot.x));
    hotspot.y = Math.max(0, Math.min(ref.height - 1, hotspot.y));
    const meta = {
      note: 'multi-state build. Per-state sizes live in assets/states-manifest.json.',
      reference: { maxSize: CONFIG.maxSize, width: ref.width, height: ref.height },
      idleHotspotRef: hotspot,
    };
    fs.writeFileSync(CONFIG.outputMeta, JSON.stringify(meta, null, 2) + '\n');
    const factor = Math.max(4, Math.floor(480 / Math.max(ref.width, ref.height)));
    fs.writeFileSync(CONFIG.outputPreview, encodePng(makePreview(ref, hotspot, factor).width, makePreview(ref, hotspot, factor).height, makePreview(ref, hotspot, factor).rgba));
    console.log('wrote legacy cursor-meta.json + preview.png (idle reference)');
  }
  console.log('');
  console.log('Done. Multi-state assets ready.');
}

function opaqueCount(width, height, rgba, alphaMin) {
  let n = 0;
  for (let p = 0; p < width * height; p++) if (rgba[p * 4 + 3] >= alphaMin) n++;
  return n;
}

main();