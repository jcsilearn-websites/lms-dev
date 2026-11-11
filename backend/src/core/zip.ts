import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

// A streaming, store-only ZIP writer for bulk downloads (every submission of an assignment). Files that are
// already compressed (PDF, images, office files) gain nothing from deflate and it would cost CPU, so entries are
// STORED. Memory is flat: one chunk at a time flows from the storage stream to the response (backpressure comes
// from Readable.from); only the central directory (about 100 bytes per entry) is kept until the end.
//
// Sizes and the CRC are not known when a local header is written, so every entry uses a data descriptor (flag bit 3);
// names are UTF-8 (bit 11). ZIP64 is used for an entry of 4 GiB or more (its size is known up front from storage), and
// for the archive when it has 65,535 or more entries or its directory sits beyond 4 GiB. `forceZip64` writes the ZIP64
// form everywhere: the tests use it to check that form without a 4 GiB file.
//
// Names are NOT sanitized here (the caller uses core/filenames.ts), but they are CHECKED: a name that could climb out of
// the extraction folder is a bug, so it throws instead of being written.

export interface ZipEntry {
  /** Path inside the archive, `/` separated (folders are made of the segments). */
  name: string;
  /** The stored size in bytes (decides ZIP64 for the entry; the real byte count must equal it). */
  size: number;
  modified?: Date;
  /** The bytes; a missing object (null) aborts the archive. */
  open(): Promise<Readable | null>;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const U32 = 0xffffffff;
const U16 = 0xffff;
const FLAGS = 0x0808; // data descriptor + UTF-8 names

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Throws for any name that could escape the folder the archive is extracted into. */
export function assertSafeEntryName(name: string): void {
  if (name === '' || Buffer.byteLength(name) > U16) throw new ZipError('invalid entry name length');
  if (name.startsWith('/') || name.includes('\\') || CONTROL.test(name) || /^[a-zA-Z]:/.test(name))
    throw new ZipError('unsafe entry name');
  for (const segment of name.split('/'))
    if (segment === '' || segment === '.' || segment === '..')
      throw new ZipError('unsafe entry name');
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

interface Recorded {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  zip64: boolean;
  time: number;
  date: number;
}

async function* generate(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  forceZip64: boolean,
): AsyncGenerator<Buffer> {
  const recorded: Recorded[] = [];
  let offset = 0;
  const emit = (b: Buffer): Buffer => {
    offset += b.length;
    return b;
  };

  for await (const entry of entries) {
    assertSafeEntryName(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const zip64 = forceZip64 || entry.size >= U32;
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const start = offset;
    // local header: crc and sizes are zero (they follow in the data descriptor)
    const extra = zip64 ? Buffer.concat([u16(1), u16(16), u64(0), u64(0)]) : Buffer.alloc(0);
    yield emit(
      Buffer.concat([
        u32(0x04034b50),
        u16(zip64 ? 45 : 20),
        u16(FLAGS),
        u16(0),
        u16(time),
        u16(date),
        u32(0),
        u32(zip64 ? U32 : 0),
        u32(zip64 ? U32 : 0),
        u16(name.length),
        u16(extra.length),
        name,
        extra,
      ]),
    );

    const stream = await entry.open();
    if (!stream) throw new ZipError('an object of the archive is missing');
    let crc = 0;
    let size = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      crc = crc32(buf, crc);
      size += buf.length;
      yield emit(buf);
    }
    if (size >= U32 && !zip64) throw new ZipError('an entry grew past 4 GiB: its size was wrong');
    yield emit(
      Buffer.concat([
        u32(0x08074b50),
        u32(crc),
        zip64 ? u64(size) : u32(size),
        zip64 ? u64(size) : u32(size),
      ]),
    );
    recorded.push({ name, crc, size, offset: start, zip64, time, date });
  }

  const directoryStart = offset;
  for (const r of recorded) {
    const needOffset = r.offset >= U32;
    const fields: Buffer[] = [];
    if (r.zip64) fields.push(u64(r.size), u64(r.size));
    if (needOffset) fields.push(u64(r.offset));
    const extra = fields.length
      ? Buffer.concat([u16(1), u16(fields.reduce((n, f) => n + f.length, 0)), ...fields])
      : Buffer.alloc(0);
    yield emit(
      Buffer.concat([
        u32(0x02014b50),
        u16(0x032d), // made by: Unix, spec 4.5 (the external attributes below are Unix modes)
        u16(r.zip64 || needOffset ? 45 : 20),
        u16(FLAGS),
        u16(0),
        u16(r.time),
        u16(r.date),
        u32(r.crc),
        u32(r.zip64 ? U32 : r.size),
        u32(r.zip64 ? U32 : r.size),
        u16(r.name.length),
        u16(extra.length),
        u16(0),
        u16(0),
        u16(0),
        u32((0o100644 << 16) >>> 0),
        u32(needOffset ? U32 : r.offset),
        r.name,
        extra,
      ]),
    );
  }
  const directorySize = offset - directoryStart;
  const big = forceZip64 || recorded.length >= U16 || directoryStart >= U32 || directorySize >= U32;
  if (big) {
    const eocd64Offset = offset;
    yield emit(
      Buffer.concat([
        u32(0x06064b50),
        u64(44),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(recorded.length),
        u64(recorded.length),
        u64(directorySize),
        u64(directoryStart),
      ]),
    );
    yield emit(Buffer.concat([u32(0x07064b50), u32(0), u64(eocd64Offset), u32(1)]));
  }
  yield emit(
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(big ? U16 : recorded.length),
      u16(big ? U16 : recorded.length),
      u32(big ? U32 : directorySize),
      u32(big ? U32 : directoryStart),
      u16(0),
    ]),
  );
}

/** The archive as a byte stream. A failing entry destroys the stream (the download is cut: the client sees an incomplete file). */
export function zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  opts: { forceZip64?: boolean } = {},
): Readable {
  return Readable.from(generate(entries, opts.forceZip64 ?? false), { objectMode: false });
}
