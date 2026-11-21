const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { detect, readText, writeText, encode } = require('../src/textfile');
const { tempWorkspace } = require('./helpers');

const text = 'Café “quoted” — €5\nsecond line\n';
const samples = {
  utf8: Buffer.from(text, 'utf8'),
  utf8bom: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]),
  utf16le: Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]),
  utf16be: (() => { const b = Buffer.from(text, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xFE, 0xFF]), b]); })(),
  cp1252: Buffer.from([0x43, 0x61, 0x66, 0xE9, 0x20, 0x93, 0x71, 0x75, 0x6F, 0x74, 0x65, 0x64, 0x94, 0x20, 0x97, 0x20, 0x80, 0x35, 0x0A,
    ...Buffer.from('second line\n', 'latin1')]),
};

for (const [enc, bytes] of Object.entries(samples)) {
  test(`${enc}: detected, decoded and written back byte-for-byte`, async () => {
    const dir = tempWorkspace(); const p = path.join(dir, 'f.txt');
    fs.writeFileSync(p, bytes);
    assert.strictEqual(detect(bytes), enc);
    const f = await readText(p);
    assert.strictEqual(f.text, text);
    await writeText(p, f.text, f.encoding);
    assert.ok(fs.readFileSync(p).equals(bytes));
  });
}
test('binary files are reported, not decoded', async () => {
  const dir = tempWorkspace(); const p = path.join(dir, 'x.bin');
  fs.writeFileSync(p, Buffer.from([1, 2, 0, 3]));
  assert.deepStrictEqual(await readText(p), { binary: true, size: 4 });
});
test('Windows-1252 refuses characters it cannot store', () => {
  assert.throws(() => encode('emoji 😀', 'cp1252'), /Windows-1252/);
});
