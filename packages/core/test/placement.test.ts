/**
 * The placement: a file that is already in the folder.
 *
 * "Already there" is not always "the file we wanted": it can be a partial
 * download, or another model with the same name. The result has to say
 * which one it is.
 */
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPlacement, isSameFile, planPlacement } from '../src/placement.js';

async function fixture(content: string): Promise<{ root: string; source: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'velatura-place-'));
  const root = join(dir, 'sdnext');
  const source = join(dir, 'source.safetensors');
  await mkdir(root, { recursive: true });
  await writeFile(source, content);
  return { root, source };
}

describe('the placement', () => {
  it('does not take a zero inode for a proof', () => {
    // on Windows and on network shares the inode is always 0: two
    // different files would look the same one
    expect(isSameFile({ ino: 0, dev: 0 }, { ino: 0, dev: 0 })).toBe(false);
    expect(isSameFile({ ino: 0, dev: 5 }, { ino: 0, dev: 5 })).toBe(false);
    expect(isSameFile({ ino: 0, dev: 5 }, { ino: 12, dev: 5 })).toBe(false);
    expect(isSameFile({ ino: 12, dev: 5 }, { ino: 0, dev: 5 })).toBe(false);
    // the real proof
    expect(isSameFile({ ino: 12, dev: 5 }, { ino: 12, dev: 5 })).toBe(true);
    expect(isSameFile({ ino: 12, dev: 5 }, { ino: 12, dev: 6 })).toBe(false);
    expect(isSameFile({ ino: 12, dev: 5 }, { ino: 13, dev: 5 })).toBe(false);
  });

  it('places a file that is not there yet', async () => {
    const { root, source } = await fixture('the model');
    const plan = await planPlacement({ source, sdnextRoot: root, slot: 'UNET', mode: 'hardlink' });
    const result = await applyPlacement(plan);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('hardlink');
    expect((await stat(result.path)).size).toBe('the model'.length);
  });

  it('recognises the same file when it is already there', async () => {
    const { root, source } = await fixture('the model');
    const plan = await planPlacement({ source, sdnextRoot: root, slot: 'UNET', mode: 'hardlink' });
    await applyPlacement(plan);
    // the second time the file is already in place: the same one
    const again = await applyPlacement(plan);
    expect(again.ok).toBe(true);
    expect(again.fallback).toContain('the same file');
  });

  it('refuses to call a different file "already present"', async () => {
    const { root, source } = await fixture('the model');
    const plan = await planPlacement({ source, sdnextRoot: root, slot: 'UNET', mode: 'hardlink' });
    // something else is already there, and it is not the same size
    await mkdir(join(root, 'models', 'UNET'), { recursive: true });
    await writeFile(plan.target, 'a partial download');
    const result = await applyPlacement(plan);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('different file');
    // the file that was there was not touched
    expect((await stat(plan.target)).size).toBe('a partial download'.length);
  });
});
