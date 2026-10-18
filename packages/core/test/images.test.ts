/**
 * The local image store.
 *
 * The rules that matter for the privacy: an image is written in the store
 * and nowhere else, and the delete only touches what really belongs to the
 * store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearImages,
  deleteImage,
  detectImageFormat,
  fileFingerprint,
  findPartials,
  imageFileName,
  imageStore,
  imagesDir,
  listImages,
  saveImage,
} from '../src/images.js';

/** a 1x1 png, the real thing */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'velatura-images-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the image store', () => {
  it('writes the picture inside the store and tells where', async () => {
    const path = await saveImage(dir, 'abcd1234-5678', 0, PNG, new Date('2026-10-16T10:00:00Z'));
    expect(path.startsWith(dir)).toBe(true);
    expect(path).toContain('2026-10-16');
    expect(path.endsWith('-1.png')).toBe(true);

    const images = await listImages(dir);
    expect(images).toHaveLength(1);
    expect(images[0]!.path).toBe(path);
    expect(images[0]!.sizeBytes).toBeGreaterThan(0);
  });

  it('gives a different name to every picture of a job', async () => {
    const first = await saveImage(dir, 'abcd1234-5678', 0, PNG);
    const second = await saveImage(dir, 'abcd1234-5678', 1, PNG);
    expect(first).not.toBe(second);
    expect((await listImages(dir)).length).toBe(2);
  });

  it('knows the real format of the data', () => {
    expect(detectImageFormat(PNG)).toBe('png');
    expect(detectImageFormat(JPEG)).toBe('jpg');
    expect(detectImageFormat('UklGRhIAAABXRUJQ')).toBe('webp');
    expect(detectImageFormat('something else')).toBe('bin');
  });

  it('writes the extension that matches the bytes', async () => {
    const path = await saveImage(dir, 'abcd1234-5678', 0, JPEG);
    expect(path.endsWith('.jpg')).toBe(true);
  });

  it('counts the pictures and the space they take', async () => {
    await saveImage(dir, 'abcd1234-5678', 0, PNG);
    await saveImage(dir, 'abcd1234-5678', 1, PNG);
    const store = await imageStore(dir);
    expect(store.dir).toBe(dir);
    expect(store.count).toBe(2);
    expect(store.totalBytes).toBeGreaterThan(0);
  });

  it('names the file after the day and the job', () => {
    const name = imageFileName('abcd1234-5678', 2, new Date('2026-10-16T23:59:59Z'));
    expect(name).toBe('2026-10-16/abcd1234-3.png');
  });
});

describe('the safe delete', () => {
  it('deletes a picture of the store', async () => {
    const path = await saveImage(dir, 'abcd1234-5678', 0, PNG);
    const result = await deleteImage(dir, path);
    expect(result.ok).toBe(true);
    expect(await listImages(dir)).toHaveLength(0);
  });

  it('refuses a file that is outside the store', async () => {
    const outside = join(dir, '..', 'not-mine.png');
    await writeFile(outside, PNG);
    const result = await deleteImage(dir, outside);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in the Velatura image folder/);
    // the file is still there
    const { stat } = await import('node:fs/promises');
    expect((await stat(outside)).isFile()).toBe(true);
    await rm(outside, { force: true });
  });

  it('refuses a file that is not an image', async () => {
    const other = join(dir, 'notes.txt');
    await writeFile(other, 'hello');
    const result = await deleteImage(dir, other);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only images/);
  });

  it('refuses a file that does not exist', async () => {
    const result = await deleteImage(dir, join(dir, 'nope.png'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('empties the whole store and leaves the folder', async () => {
    await saveImage(dir, 'abcd1234-5678', 0, PNG);
    await saveImage(dir, 'efgh5678-9012', 0, PNG);
    const cleared = await clearImages(dir);
    expect(cleared.deleted).toBe(2);
    expect(cleared.paths).toHaveLength(2);
    expect(await listImages(dir)).toHaveLength(0);
  });

  it('tells which files it deleted', async () => {
    const path = await saveImage(dir, 'abcd1234-5678', 0, PNG);
    const cleared = await clearImages(dir);
    expect(cleared.paths).toEqual([path]);
  });

  it('leaves no empty day folder behind', async () => {
    await saveImage(dir, 'abcd1234-5678', 0, PNG, new Date('2026-10-16T10:00:00Z'));
    await clearImages(dir);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('the interrupted downloads', () => {
  it('finds the .part files with their real size', async () => {
    const models = join(dir, 'UNET');
    await mkdir(models, { recursive: true });
    await writeFile(join(models, 'model.gguf.part'), '1234567890');
    await writeFile(join(models, 'model.gguf'), 'complete');
    const partials = await findPartials([models]);
    expect(partials).toHaveLength(1);
    expect(partials[0]!.sizeBytes).toBe(10);
    expect(partials[0]!.path.endsWith('.part')).toBe(true);
  });

  it('does not fail on a folder that does not exist', async () => {
    expect(await findPartials([join(dir, 'nope')])).toEqual([]);
  });
});

describe('the fingerprint', () => {
  it('recognises a file without reading all of it', async () => {
    const path = await saveImage(dir, 'abcd1234-5678', 0, PNG);
    const first = await fileFingerprint(path);
    expect(first).toBeTruthy();
    expect(first).toHaveLength(16);
    // the same file, the same fingerprint
    expect(await fileFingerprint(path)).toBe(first);
  });

  it('says nothing about a file that is not there', async () => {
    expect(await fileFingerprint(join(dir, 'nope.png'))).toBeUndefined();
  });
});

describe('the folder of the store', () => {
  it('is inside the Velatura folder', () => {
    // the separator is the one of the platform: the test must not assume
    // that the program runs on Linux
    const config = join(tmpdir(), 'velatura-home');
    expect(imagesDir(config)).toBe(join(config, 'images'));
    expect(imagesDir(config).endsWith(join('velatura-home', 'images'))).toBe(true);
  });
});
