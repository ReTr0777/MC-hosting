/*
 * A tar reader and writer, small enough to not be worth a dependency.
 *
 * Two build steps need tar and neither needs much of it: the frp release for Linux
 * ships as .tar.gz and we want one file out of it, and the portable node bundle has
 * to go out as .tar.gz because a zip cannot carry the executable bit — frpc and
 * start.sh both need it, and telling every user to chmod two files by hand is a
 * worse answer than 80 lines here.
 *
 * ustar format only. That is what tar produces by default and all this reads or
 * writes, so anything exotic (long names, sparse files, pax records) is rejected
 * rather than mishandled.
 */
import zlib from 'zlib';

const BLOCK = 512;

/** Header field offsets, per the ustar spec. */
const NAME = 0;
const SIZE = 124;
const CHKSUM = 148;
const TYPE = 156;
const PREFIX = 345;

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function readOctal(buf, offset, length) {
  const text = readString(buf, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

/**
 * Yields the regular files in an uncompressed tar buffer.
 *
 * Directories and everything else are skipped: the callers want file contents and
 * would have to filter these out themselves otherwise.
 */
export function* readTar(buf) {
  let offset = 0;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);

    // Two zero blocks end the archive; one is enough to know we are past the entries.
    if (header.every((b) => b === 0)) return;

    const size = readOctal(header, SIZE, 12);
    const type = String.fromCharCode(header[TYPE]);
    const prefix = readString(header, PREFIX, 155);
    const name = readString(header, NAME, 100);
    const dataStart = offset + BLOCK;

    // '0' and the historical '\0' both mean a regular file.
    if (type === '0' || type === '\0') {
      yield {
        name: prefix ? `${prefix}/${name}` : name,
        data: buf.subarray(dataStart, dataStart + size),
      };
    }

    // Entry data is padded out to a whole number of blocks.
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
}

/** Reads a .tar.gz and returns the first file whose path satisfies `match`. */
export function extractFromTarGz(gzBuffer, match) {
  for (const entry of readTar(zlib.gunzipSync(gzBuffer))) {
    if (match(entry.name)) return Buffer.from(entry.data);
  }
  return null;
}

function octalField(value, length) {
  // One position is reserved for the trailing NUL that closes the field.
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(name, size, mode, mtime, type) {
  const buf = Buffer.alloc(BLOCK);

  /*
   * Long paths would need the prefix field or a GNU extension. Nothing this packs
   * comes close to 100 characters, so refusing is honest and keeps the writer small
   * — a silently truncated path would produce an archive that unpacks wrong.
   */
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`Path too long for a ustar header (max 100 bytes): ${name}`);
  }

  buf.write(name, NAME, 'utf8');
  buf.write(octalField(mode, 8), 100);
  buf.write(octalField(0, 8), 108); // uid
  buf.write(octalField(0, 8), 116); // gid
  buf.write(octalField(size, 12), SIZE);
  buf.write(octalField(mtime, 12), 136);
  buf.write(type, TYPE);
  buf.write('ustar\0', 257);
  buf.write('00', 263);

  /*
   * The checksum is computed with its own field read as spaces, then written into
   * that field. Six octal digits, a NUL and a space is the layout every tar accepts.
   */
  buf.fill(' ', CHKSUM, CHKSUM + 8);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', CHKSUM);

  return buf;
}

/**
 * Builds a gzipped tar from `entries`, each `{ name, data, mode }`.
 *
 * Paths are stored as given, so callers pass them already prefixed with the
 * directory the archive should unpack into.
 */
export function createTarGz(entries) {
  const mtime = Math.floor(Date.now() / 1000);
  const chunks = [];

  for (const entry of entries) {
    const data = entry.data;
    chunks.push(header(entry.name, data.length, entry.mode ?? 0o644, mtime, '0'));
    chunks.push(data);

    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding));
  }

  // The archive ends with two zero blocks.
  chunks.push(Buffer.alloc(BLOCK * 2));

  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}
