// Text file I/O that keeps a file's encoding. Edits must not silently convert a UTF-16 or
// Windows-1252 file (both common on Windows) to UTF-8, and Rewind must restore the original bytes.
const fsp = require('fs/promises');
const path = require('path');

// Windows-1252 bytes 0x80-0x9F -> Unicode (undefined bytes map to the same C1 code point, as browsers do).
const CP1252_HIGH = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
  0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
const CP1252_REVERSE = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

/** Encoding names: 'utf8', 'utf8bom', 'utf16le', 'utf16be', 'cp1252'. */
function detect(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf8bom';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf16be';
  if (isBinary(buf)) return 'binary';
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return 'utf8'; } catch { return 'cp1252'; }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function decode(buf, enc) {
  switch (enc) {
    case 'utf8bom': return buf.subarray(3).toString('utf8');
    case 'utf16le': return buf.subarray(2).toString('utf16le');
    case 'utf16be': { const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))); b.swap16(); return b.toString('utf16le'); }
    case 'cp1252': {
      let s = '';
      for (const byte of buf) s += String.fromCharCode(byte >= 0x80 && byte <= 0x9F ? CP1252_HIGH[byte - 0x80] : byte);
      return s;
    }
    default: return buf.toString('utf8');
  }
}

/** Encode text in the given encoding. Throws if a character can't be represented (Windows-1252). */
function encode(text, enc) {
  switch (enc) {
    case 'utf8bom': return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
    case 'utf16le': return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
    case 'utf16be': { const b = Buffer.from(text, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xFE, 0xFF]), b]); }
    case 'cp1252': {
      const out = Buffer.alloc(text.length);
      let i = 0;
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        let b;
        if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) b = cp;
        else if (CP1252_REVERSE.has(cp)) b = CP1252_REVERSE.get(cp);
        else throw new Error(`the file is Windows-1252 encoded and can't store the character "${ch}" (U+${cp.toString(16).toUpperCase().padStart(4, '0')}). Use a character that exists in Windows-1252, or convert the file to UTF-8 first.`);
        out[i++] = b;
      }
      return out.subarray(0, i);
    }
    default: return Buffer.from(text, 'utf8');
  }
}

/** Reads a file as text. Returns { text, encoding } or { binary: true, size }. Throws if missing. */
async function readText(p) {
  const buf = await fsp.readFile(p);
  const encoding = detect(buf);
  if (encoding === 'binary') return { binary: true, size: buf.length };
  return { text: decode(buf, encoding), encoding };
}

/** Writes text in the given encoding (default UTF-8), creating parent folders. */
async function writeText(p, text, encoding = 'utf8') {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, encode(text, encoding));
}

module.exports = { detect, decode, encode, readText, writeText, isBinary };
