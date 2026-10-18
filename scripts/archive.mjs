/**
 * The archives of the release, written without any external tool.
 *
 * The old script called `tar` and `zip`: `zip` does not exist on Windows,
 * and a release that only builds on a machine with the right tools is a
 * release that half the people who want it cannot produce.
 *
 * Here the two formats are written directly:
 *
 *   ZIP  — the format Windows wants (the installer unpacks it with
 *          Expand-Archive). Deflated, with a central directory.
 *   tar.gz — the format Linux and macOS want. A tar stream, gzipped.
 *
 * Both are written from the same file list, so the two archives always
 * hold exactly the same files.
 */
import { deflateRawSync, gzipSync } from 'node:zlib';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// --------------------------------------------------------------- crc32 ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** The CRC-32 of a buffer, as the ZIP format wants it. */
export function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** The date and the time in the format of DOS, that the ZIP header uses. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// ---------------------------------------------------------- the listing ----
/**
 * @typedef {object} ArchiveEntry
 * @property {string} name    the name inside the archive, with forward slashes
 * @property {boolean} directory
 * @property {Buffer} [data]  the content, for a file
 * @property {Date} mtime
 * @property {number} mode    the mode, in the Unix sense
 */

/**
 * Read a folder and return everything under it, folders first.
 *
 * The names are relative to the folder and always use `/`: the ZIP format
 * wants it that way, and it is what makes the archive readable on every
 * system.
 */
export async function listFolder(root, prefix = '') {
  /** @type {ArchiveEntry[]} */
  const entries = [];
  const walk = async (folder, name) => {
    const items = await readdir(folder, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(folder, item.name);
      const inside = name ? `${name}/${item.name}` : item.name;
      const info = await stat(full);
      if (item.isDirectory()) {
        entries.push({
          name: `${inside}/`,
          directory: true,
          mtime: info.mtime,
          mode: 0o755,
        });
        await walk(full, inside);
      } else if (item.isFile()) {
        entries.push({
          name: inside,
          directory: false,
          data: await readFile(full),
          mtime: info.mtime,
          mode: (info.mode & 0o777) || 0o644,
        });
      }
    }
  };
  await walk(root, prefix);
  return entries;
}

// ----------------------------------------------------------------- zip ----
/**
 * Write a ZIP file.
 *
 * The layout is the one every tool expects: a local header and the data
 * for every file, then the central directory, then the end record.
 */
export async function createZip(sourceDir, outFile, prefix = '') {
  const entries = await listFolder(sourceDir, prefix);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(entry.mtime);

    if (entry.directory) {
      // a folder: no data, the method is "stored"
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6); // the name is UTF-8
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(0, 14); // crc
      header.writeUInt32LE(0, 18); // compressed size
      header.writeUInt32LE(0, 22); // size
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28);
      chunks.push(header, name);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(0x031e, 4); // made by: Unix
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(date, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeUInt32LE(0, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt16LE(0, 30);
      record.writeUInt16LE(0, 32);
      record.writeUInt16LE(0, 34);
      record.writeUInt16LE(0, 36);
      record.writeUInt32LE(((0o040755 << 16) >>> 0) | 0x10, 38);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);
      offset += header.length + name.length;
      continue;
    }

    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    // if the deflated form is bigger, store it: the format allows it
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE((((entry.mode | 0o100000) << 16) >>> 0), 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...chunks, centralBuffer, end]);
  await writeFile(outFile, archive);
  return archive.length;
}

// ------------------------------------------------------------- tar.gz ----
function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** Build the tar stream of a list of entries. */
function buildTar(entries) {
  const chunks = [];

  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write(octal(entry.mode, 8), 100, 8, 'ascii');
    header.write(octal(0, 8), 108, 8, 'ascii');
    header.write(octal(0, 8), 116, 8, 'ascii');
    const size = entry.directory ? 0 : entry.data.length;
    header.write(octal(size, 12), 124, 12, 'ascii');
    header.write(octal(Math.floor(entry.mtime.getTime() / 1000), 12), 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii'); // the checksum field, as spaces
    header.write(entry.directory ? '5' : '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    // the checksum is computed with its own field read as spaces
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(octal(sum, 8), 148, 8, 'ascii');

    chunks.push(header);
    if (!entry.directory) {
      const data = entry.data;
      const padding = (512 - (data.length % 512)) % 512;
      chunks.push(data, Buffer.alloc(padding));
    }
  }

  // two empty blocks: the end of the archive
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/** Write a gzipped tar: the archive Linux and macOS expect. */
export async function createTarGz(sourceDir, outFile, prefix = '') {
  const entries = await listFolder(sourceDir, prefix);
  const gz = gzipSync(buildTar(entries), { level: 9 });
  await writeFile(outFile, gz);
  return gz.length;
}
