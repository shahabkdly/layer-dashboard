'use strict';
/* Store-only ZIP writer (no compression, no dependencies).
   It lets the desktop app hand a .gdb FOLDER to the page as if the user had zipped it,
   which is what GDAL-WASM reads through /vsizip/. Folders are small enough that skipping
   compression is the right trade: it is instant and the bytes never leave the machine. */
const fs = require('fs');
const path = require('path');

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/* every file under dir, as paths relative to dir's parent (so "Name.gdb/a0000001.gdbtable") */
function walk(dir, base, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
  }
  return out;
}

/** Zip a folder into a Buffer. Throws if it holds more than maxBytes. */
function zipFolder(dir, maxBytes = 2 * 1024 ** 3) {
  const files = walk(dir, path.dirname(dir));
  if (!files.length) throw new Error('That folder is empty.');
  const total = files.reduce((s, f) => s + fs.statSync(f.abs).size, 0);
  if (total > maxBytes) throw new Error(`That folder holds ${(total / 1e9).toFixed(1)} GB, which is too large to open this way.`);

  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.abs), name = Buffer.from(f.rel, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);   // UTF-8 names
    lh.writeUInt16LE(0, 8);                                                                  // stored
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { zipFolder };
