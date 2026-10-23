import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { writeZip } from '../zip.mjs';

function readZip(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), time = buf.readUInt16LE(at + 12), date = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16), packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), external = buf.readUInt32LE(at + 38);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + packed));
    entries.push({ name, flags, method, time, date, crc, size, extra, comment, external, data });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

test('the same directory gives byte-identical, sorted, fixed-time archives (ledger 128)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sunmoon-zip-'));
  try {
    const dir = path.join(base, 'bundle');
    fs.mkdirSync(path.join(dir, 'app', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'z-last.txt'), 'last');
    fs.writeFileSync(path.join(dir, 'app', 'dist', 'cli.js'), 'export const x = 1;\n'.repeat(200));
    fs.writeFileSync(path.join(dir, 'bundle-manifest.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'empty'), '');
    const one = path.join(base, 'one.zip'), two = path.join(base, 'two.zip');
    assert.deepEqual(writeZip(dir, one), { entries: 4 });
    fs.utimesSync(path.join(dir, 'z-last.txt'), new Date(2020, 1, 1), new Date(2020, 1, 1)); // file times never matter
    writeZip(dir, two);
    assert.ok(fs.readFileSync(one).equals(fs.readFileSync(two)));
    const entries = readZip(one);
    assert.deepEqual(entries.map(e => e.name), ['app/dist/cli.js', 'bundle-manifest.json', 'empty', 'z-last.txt']);
    for (const e of entries) {
      assert.equal(e.method, 8); assert.equal(e.flags, 0x0800); assert.equal(e.time, 0); assert.equal(e.date, 0x21);
      assert.equal(e.extra, 0); assert.equal(e.comment, 0); assert.equal(e.external, 0);
      const original = fs.readFileSync(path.join(dir, e.name));
      assert.ok(e.data.equals(original)); assert.equal(e.size, original.length); assert.equal(e.crc, zlib.crc32(original));
    }
    assert.throws(() => writeZip(dir, one), /EEXIST/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
