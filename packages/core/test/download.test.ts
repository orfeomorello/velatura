/**
 * The download, against a real HTTP server (no gigabytes: a few hundred bytes).
 *
 * The important case is the resume: when a download is interrupted, the
 * next attempt continues the partial file, and the checksum it returns must
 * cover the *whole* file, not only the bytes that arrived with the resume.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadFile } from '../src/hf.js';

const CONTENT = Buffer.from('Velatura — a local studio for SD.Next. '.repeat(200), 'utf8');
const SHA256 = createHash('sha256').update(CONTENT).digest('hex');

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d+)-/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const chunk = CONTENT.subarray(start);
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length),
        'content-range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}`,
      });
      res.end(chunk);
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(CONTENT.length),
    });
    res.end(CONTENT);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the download', () => {
  it('downloads a file and checks its checksum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-dl-'));
    const target = join(dir, 'model.safetensors');
    const result = await downloadFile('org/repo', 'abc123', 'model.safetensors', target, {
      mirror: base,
      expectedBytes: CONTENT.length,
    });
    expect(result.bytes).toBe(CONTENT.length);
    expect(result.sha256).toBe(SHA256);
    expect(result.resumed).toBe(false);
    expect((await readFile(target)).equals(CONTENT)).toBe(true);
  });

  it('resumes a partial download and the checksum still covers the whole file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-dl-'));
    const target = join(dir, 'model.safetensors');
    // the file was interrupted halfway: the partial file is on disk
    const half = Math.floor(CONTENT.length / 2);
    await writeFile(`${target}.part`, CONTENT.subarray(0, half));

    const result = await downloadFile('org/repo', 'abc123', 'model.safetensors', target, {
      mirror: base,
      expectedBytes: CONTENT.length,
    });
    expect(result.resumed).toBe(true);
    expect(result.bytes).toBe(CONTENT.length);
    // the bug: the hash used to cover only the resumed tail
    expect(result.sha256).toBe(SHA256);
    expect((await readFile(target)).equals(CONTENT)).toBe(true);
  });

  it('does not give the final name to a file whose checksum is wrong', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-dl-'));
    const target = join(dir, 'model.safetensors');
    // the manifest declares a checksum that the file does not have
    const wrong = '0'.repeat(64);
    await expect(
      downloadFile('org/repo', 'abc123', 'model.safetensors', target, {
        mirror: base,
        expectedBytes: CONTENT.length,
        expectedSha256: wrong,
      }),
    ).rejects.toThrow(/sha256 mismatch/);
    // the engine must never find a file that was not verified
    await expect(stat(target)).rejects.toThrow();
    // and the partial file is kept, so the download can be tried again
    expect((await stat(`${target}.part`)).isFile()).toBe(true);
  });

  it('keeps the partial file when the download stops early', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-dl-'));
    const target = join(dir, 'model.safetensors');
    await expect(
      downloadFile('org/repo', 'abc123', 'model.safetensors', target, {
        mirror: base,
        // the manifest says more than the file has: the download is short
        expectedBytes: CONTENT.length + 1000,
      }),
    ).rejects.toThrow(/stopped at/);
    // the partial file is still there, and the final one was not written
    expect((await stat(`${target}.part`)).isFile()).toBe(true);
    await expect(stat(target)).rejects.toThrow();
  });
});
