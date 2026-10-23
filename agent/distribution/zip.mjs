// Deterministic ZIP for the Windows package (ledger 128): entries sorted by path, every timestamp
// fixed at 1980-01-01 00:00 (the DOS epoch), no extra fields, plain attributes, UTF-8 names,
// deflate level 9. The same directory gives the same bytes with the same zlib (recorded in the receipt).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { inventory } from './bundle.mjs';

const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 00:00:00
const UTF8 = 0x0800, DEFLATE = 8, VERSION = 20;

export function writeZip(directory, zipFile) {
  const files = inventory(directory);
  if (files.length > 0xffff) throw new Error('Too many entries for a ZIP without ZIP64');
  const fd = fs.openSync(zipFile, 'wx');
  const central = [];
  let offset = 0;
  const write = buffer => { fs.writeSync(fd, buffer); offset += buffer.length; };
  try {
    for (const file of files) {
      const data = fs.readFileSync(path.join(directory, file.path));
      const packed = zlib.deflateRawSync(data, { level: 9 });
      const name = Buffer.from(file.path, 'utf8');
      const crc = zlib.crc32(data);
      if (data.length > 0xfffffffe || packed.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('File too large for a ZIP without ZIP64');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(VERSION, 4); local.writeUInt16LE(UTF8, 6);
      local.writeUInt16LE(DEFLATE, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const at = offset;
      write(local); write(name); write(packed);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(VERSION, 4); entry.writeUInt16LE(VERSION, 6);
      entry.writeUInt16LE(UTF8, 8); entry.writeUInt16LE(DEFLATE, 10); entry.writeUInt16LE(DOS_TIME, 12);
      entry.writeUInt16LE(DOS_DATE, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20);
      entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28);
      // extra, comment, disk, internal attributes stay 0; external attributes 0 = plain file
      entry.writeUInt32LE(at, 42);
      central.push(entry, name);
    }
    const start = offset;
    for (const part of central) write(part);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    write(end);
  } finally { fs.closeSync(fd); }
  return { entries: files.length };
}
