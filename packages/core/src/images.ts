/**
 * The local image store.
 *
 * The images Velatura makes are written here, on this machine, and nowhere
 * else. The interface shows the real path of every file, so the user
 * always knows where the pictures are — and can delete them safely.
 */
import { createHash, randomFillSync } from 'node:crypto';
import { readdir, rm, stat, writeFile, mkdir, open } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const SHRED_CHUNK_BYTES = 256 * 1024;

/**
 * Overwrite a file's contents in place with zeros + random bytes, flush to disk,
 * and truncate to 0 bytes. Safe even when another process holds the file open
 * in append/log mode (such as `sdnext.log` on Windows).
 */
export async function secureWipeInPlace(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return false;
  const handle = await open(path, 'r+').catch(() => undefined);
  if (!handle) return false;
  try {
    const size = info.size;
    if (size > 0) {
      const buf = Buffer.alloc(Math.min(size, SHRED_CHUNK_BYTES));
      // Pass 1: zeros
      let offset = 0;
      while (offset < size) {
        const len = Math.min(buf.length, size - offset);
        await handle.write(buf, 0, len, offset);
        offset += len;
      }
      await handle.sync().catch(() => undefined);
      // Pass 2: random bytes
      offset = 0;
      while (offset < size) {
        const len = Math.min(buf.length, size - offset);
        randomFillSync(buf, 0, len);
        await handle.write(buf, 0, len, offset);
        offset += len;
      }
      await handle.sync().catch(() => undefined);
    }
    await handle.truncate(0);
    await handle.sync().catch(() => undefined);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Overwrite a file's contents (zeros + random bytes), truncate to 0, and remove it.
 */
export async function secureShredFile(path: string): Promise<boolean> {
  await secureWipeInPlace(path);
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface StoredImage {
  /** the absolute path on this machine */
  path: string;
  /** the name to show */
  name: string;
  sizeBytes: number;
  /** when it was written */
  modifiedAt: string;
  /** the job it comes from */
  jobId?: string;
}

export interface ImageStore {
  /** the folder where the images are written */
  dir: string;
  /** how many images are there, and how much they take */
  count: number;
  totalBytes: number;
  images: StoredImage[];
}

/** The folder of the local store, inside the Velatura folder. */
export function imagesDir(configDir: string): string {
  return join(configDir, 'images');
}

/**
 * The format of the data that came from the engine.
 *
 * SD.Next usually answers with PNG, but not always: the extension has to
 * match the bytes, or the file will not open in a picture viewer.
 */
export function detectImageFormat(base64: string): 'png' | 'jpg' | 'webp' | 'bin' {
  const head = base64.slice(0, 16);
  if (head.startsWith('iVBORw0KGgo')) return 'png';
  if (head.startsWith('/9j/')) return 'jpg';
  if (head.startsWith('UklGR')) return 'webp';
  return 'bin';
}

/** A safe file name for an image: the date and the job, nothing else. */
export function imageFileName(
  jobId: string,
  index: number,
  createdAt: Date,
  format: 'png' | 'jpg' | 'webp' | 'bin' = 'png',
): string {
  const day = createdAt.toISOString().slice(0, 10);
  return `${day}/${jobId.slice(0, 8)}-${index + 1}.${format}`;
}

/**
 * Write one image of a job.
 *
 * The data is the base64 that came from the engine: it is written as it
 * is, because re-encoding it would lose what the model produced.
 */
export async function saveImage(
  dir: string,
  jobId: string,
  index: number,
  base64: string,
  createdAt = new Date(),
): Promise<string> {
  const relativePath = imageFileName(jobId, index, createdAt, detectImageFormat(base64));
  const target = join(dir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  const buffer = Buffer.from(base64, 'base64');
  await writeFile(target, buffer);
  return target;
}

/** Every image in the store, newest first. */
export async function listImages(dir: string): Promise<StoredImage[]> {
  const out: StoredImage[] = [];
  const walk = async (current: string): Promise<void> => {
    const names = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of names) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.(png|jpe?g|webp|bin)$/i.test(entry.name)) continue;
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      out.push({
        path,
        name: entry.name,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        jobId: entry.name.split('-')[0],
      });
    }
  };
  await walk(dir);
  out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return out;
}

/** The state of the store: how many images, how much space. */
export async function imageStore(dir: string): Promise<ImageStore> {
  const images = await listImages(dir);
  return {
    dir,
    count: images.length,
    totalBytes: images.reduce((sum, image) => sum + image.sizeBytes, 0),
    images,
  };
}

/**
 * Securely overwrite and delete an image, but only if it really is inside the store.
 */
export async function deleteImage(dir: string, path: string): Promise<{ ok: boolean; error?: string }> {
  const root = resolve(dir);
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) {
    return { ok: false, error: 'that file is not in the Velatura image folder' };
  }
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) {
    return { ok: false, error: 'that file does not exist' };
  }
  if (!/\.(png|jpe?g|webp|bin)$/i.test(target)) {
    return { ok: false, error: 'only images can be deleted here' };
  }
  try {
    await secureWipeInPlace(target);
    await rm(target, { force: true });
  } catch (err) {
    // on Windows a file that another program has open cannot be deleted
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === 'EPERM' || code === 'EBUSY'
          ? 'the file is open in another program: close it and try again'
          : `the file could not be deleted: ${(err as Error).message}`,
    };
  }
  return { ok: true };
}

/**
 * Delete every image of the store. The folder itself stays.
 *
 * The paths of the deleted files come back too: the caller has to know
 * which ones are gone, to release the copies it holds in memory.
 */
export async function clearImages(dir: string): Promise<{ deleted: number; paths: string[] }> {
  const images = await listImages(dir);
  const paths: string[] = [];
  for (const image of images) {
    const result = await deleteImage(dir, image.path);
    if (result.ok) paths.push(image.path);
  }
  const deleted = paths.length;
  // the empty day folders go too: nothing is left of the pictures
  const days = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const path = join(dir, day.name);
    const left = await readdir(path).catch(() => [] as string[]);
    if (!left.length) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
  return { deleted, paths };
}

/** The partial files of the interrupted downloads, with their real paths. */
export async function findPartials(dirs: string[]): Promise<Array<{ path: string; sizeBytes: number }>> {
  const out: Array<{ path: string; sizeBytes: number }> = [];
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.part')) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile()) out.push({ path, sizeBytes: info.size });
    }
  }
  return out;
}

/** A short fingerprint of a file, to recognise it without reading it all. */
export async function fileFingerprint(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  // the first 64 kB are enough to recognise a file
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  const head = Buffer.alloc(65536);
  let read = 0;
  try {
    read = (await handle.read(head, 0, head.length, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  if (!read) return undefined;
  const hash = createHash('sha256');
  hash.update(head.subarray(0, read));
  hash.update(String(info.size));
  return hash.digest('hex').slice(0, 16);
}

