/**
 * Minimal streaming .zip writer (no dependencies). Opens with a double-click on Mac, Windows and phones.
 * Files are added one at a time (each is read into memory, so it's meant for photos and small databases),
 * and anything that doesn't shrink is stored uncompressed (JPEGs).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Writable } from "node:stream";

interface Entry { name: Buffer; crc: number; size: number; csize: number; method: number; offset: number; time: number; date: number }

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  private offset = 0;
  private entries: Entry[] = [];
  constructor(private out: Writable) {}

  private write(b: Buffer) {
    this.offset += b.length;
    return new Promise<void>((resolve, reject) => {
      const ok = this.out.write(b, (err) => err && reject(err));
      if (ok) resolve();
      else this.out.once("drain", resolve);
    });
  }

  async add(name: string, data: Buffer, when = new Date()) {
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const { time, date } = dosTime(when);
    const e: Entry = { name: nameBuf, crc, size: data.length, csize: body.length, method: store ? 0 : 8, offset: this.offset, time, date };
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(e.csize, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    await this.write(Buffer.concat([h, nameBuf]));
    await this.write(body);
    this.entries.push(e);
  }

  async addFile(name: string, file: string) {
    const st = fs.statSync(file);
    await this.add(name, fs.readFileSync(file), st.mtime);
  }

  /** Add every file under dir as prefix/<relative path>. */
  async addDir(prefix: string, dir: string) {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!f.isFile()) continue;
      const full = path.join(f.parentPath, f.name);
      await this.addFile(path.posix.join(prefix, path.relative(dir, full).split(path.sep).join("/")), full);
      n++;
    }
    return n;
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    await new Promise<void>((resolve) => this.out.end(resolve));
    return { files: this.entries.length, bytes: this.offset };
  }
}

/** Read a zip written by ZipWriter (tests and restore checks). */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnl = buf.readUInt16LE(off + 26);
    const lel = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export interface ZipEntryInfo { name: string; method: number; csize: number; size: number; offset: number }

/** List a zip file's contents without loading it into memory. */
export function zipEntries(file: string): ZipEntryInfo[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (at < 0) throw new Error("Not a zip file");
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOff = tail.readUInt32LE(at + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out: ZipEntryInfo[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("Damaged zip file");
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      out.push({ name: cd.subarray(p + 46, p + 46 + nlen).toString("utf8"), method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42) });
      p += 46 + nlen + elen + clen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Read one entry's bytes from a zip file. */
export function extractEntry(file: string, e: ZipEntryInfo): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const h = Buffer.alloc(30);
    fs.readSync(fd, h, 0, 30, e.offset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`Damaged zip entry ${e.name}`);
    const data = Buffer.alloc(e.csize);
    fs.readSync(fd, data, 0, e.csize, e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28));
    const out = e.method === 8 ? zlib.inflateRawSync(data) : data;
    if ((zlib.crc32(out) >>> 0) !== (h.readUInt32LE(14) >>> 0)) throw new Error(`Checksum mismatch in ${e.name}`);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
