/**
 * The archives of the release.
 *
 * They are written in Node, without `tar` and without `zip`, so that a
 * release can be built on any machine — including Windows, where `zip`
 * does not exist.
 *
 * The test reads the archives back with a *separate* reader, written from
 * the format itself: if the writer and the reader shared a mistake, the
 * test would pass on a broken archive. Here the files are also compared
 * byte by byte with the folder they come from.
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTarGz, createZip, crc32 } from './archive.mjs';

let work: string;
let source: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'velatura-archive-'));
  source = join(work, 'app');
  await mkdir(join(source, 'dist'), { recursive: true });
  await mkdir(join(source, 'empty folder'), { recursive: true });
  await writeFile(join(source, 'dist', 'velatura.js'), 'console.log("velatura");\n');
  await writeFile(join(source, 'manifest.txt'), 'a'.repeat(5000));
  await writeFile(join(source, 'empty.txt'), '');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/**
 * Read a ZIP archive: the central directory, and the content of a file.
 * Written from the format, on purpose not sharing code with the writer.
 */
function readZip(buffer: Buffer): Map<string, Buffer> {
  // the end of the central directory is at the end of the file
  let end = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  expect(end, 'the end of the central directory').toBeGreaterThan(-1);

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();

  for (let i = 0; i < count; i += 1) {
    expect(buffer.readUInt32LE(offset), 'the central directory header').toBe(0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (!name.endsWith('/')) {
      // the local header tells where the data starts
      expect(buffer.readUInt32LE(localOffset), 'the local header').toBe(0x04034b50);
      const localName = buffer.readUInt16LE(localOffset + 26);
      const localExtra = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const raw = buffer.subarray(start, start + compressed);
      const data = method === 8 ? inflateRawSync(raw) : raw;
      expect(data.length, `the size of ${name}`).toBe(size);
      expect(crc32(data), `the checksum of ${name}`).toBe(checksum);
      files.set(name, data);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Read a tar archive: the headers, and the content of a file. */
function readTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // the end of the archive
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeField = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8);
    const type = String.fromCharCode(header[156]);
    const start = offset + 512;
    if (type !== '5') {
      files.set(name, buffer.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('the archives of the release', () => {
  it('writes a zip that any reader can open', async () => {
    const out = join(work, 'app.zip');
    await createZip(source, out, 'app');
    const files = readZip(await readFile(out));

    expect([...files.keys()].sort()).toEqual([
      'app/dist/velatura.js',
      'app/empty.txt',
      'app/manifest.txt',
    ]);
    // the content is the same, byte by byte
    expect(files.get('app/dist/velatura.js')?.toString()).toBe('console.log("velatura");\n');
    expect(files.get('app/manifest.txt')?.length).toBe(5000);
    expect(files.get('app/empty.txt')?.length).toBe(0);
  });

  it('keeps the folders in the zip, with the forward slash', async () => {
    const out = join(work, 'app.zip');
    await createZip(source, out, 'app');
    const text = (await readFile(out)).toString('latin1');
    expect(text).toContain('app/dist/');
    expect(text).toContain('app/empty folder/');
    // a backslash in the names would break the extraction on other systems
    const names = [...readZip(await readFile(out)).keys()];
    expect(names.every((name) => !name.includes('\\'))).toBe(true);
  });

  it('writes a tar.gz that tar can open', async () => {
    const out = join(work, 'app.tar.gz');
    await createTarGz(source, out, 'app');
    const files = readTar(gunzipSync(await readFile(out)));

    expect([...files.keys()].sort()).toEqual([
      'app/dist/velatura.js',
      'app/empty.txt',
      'app/manifest.txt',
    ]);
    expect(files.get('app/dist/velatura.js')?.toString()).toBe('console.log("velatura");\n');
    expect(files.get('app/manifest.txt')?.length).toBe(5000);
  });

  it('writes the same files in the two archives', async () => {
    const zipOut = join(work, 'app.zip');
    const tarOut = join(work, 'app.tar.gz');
    await createZip(source, zipOut, 'app');
    await createTarGz(source, tarOut, 'app');
    const inZip = [...readZip(await readFile(zipOut)).keys()].sort();
    const inTar = [...readTar(gunzipSync(await readFile(tarOut))).keys()].sort();
    expect(inZip).toEqual(inTar);
  });

  it('computes the checksum the ZIP format asks for', () => {
    // the well-known value of the CRC-32 of "123456789"
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});
