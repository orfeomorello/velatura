/**
 * Integrity checks: size + SHA-256, computed by streaming the file.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { VerifyResult } from './types.js';

export async function sha256File(
  path: string,
  onProgress?: (bytes: number, total: number) => void,
): Promise<string> {
  const st = await stat(path);
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
      onProgress?.(bytes, st.size);
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export async function verifyFile(
  path: string,
  expected: { sizeBytes?: number; sha256?: string },
  onProgress?: (bytes: number, total: number) => void,
): Promise<VerifyResult> {
  const st = await stat(path);
  const notes: string[] = [];

  let sizeOk = true;
  if (expected.sizeBytes !== undefined) {
    // tolerate a small difference: some repos report GiB-rounded sizes
    const delta = Math.abs(st.size - expected.sizeBytes);
    const tolerance = Math.max(1024, expected.sizeBytes * 0.005);
    sizeOk = delta <= tolerance;
    if (!sizeOk) {
      notes.push(
        `size mismatch: ${st.size} bytes on disk, ${expected.sizeBytes} expected (${delta} bytes off)`,
      );
    }
  }

  let actualSha256: string | undefined;
  let shaOk = false;
  if (expected.sha256) {
    actualSha256 = await sha256File(path, onProgress);
    shaOk = actualSha256.toLowerCase() === expected.sha256.toLowerCase();
    if (!shaOk) notes.push(`sha256 mismatch: got ${actualSha256}, expected ${expected.sha256}`);
  } else {
    notes.push('no known sha256 for this file — size and semantic checks only');
  }

  return {
    path,
    sizeBytes: st.size,
    expectedSizeBytes: expected.sizeBytes,
    sizeOk,
    expectedSha256: expected.sha256,
    actualSha256,
    shaOk,
    ok: sizeOk && (expected.sha256 ? shaOk : true),
    notes,
  };
}
