/**
 * Placement strategies for a model file.
 *
 *  copy      — real copy (uses the filesystem copy, space is used)
 *  hardlink  — same volume, zero extra space, one file on disk (recommended)
 *  symlink   — zero space, needs dev mode / admin on Windows
 *  in-place  — no file operation at all: SD.Next is pointed at the folder
 */
import { constants } from 'node:fs';
import { copyFile, link, mkdir, rename, symlink, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { slotDir, slotPath } from './paths.js';
import type { PlacementMode, PlacementPlan, SdnextSlot } from './types.js';

/**
 * Are these two files the same one?
 *
 * The inode is a proof only when the filesystem gives one: on some systems
 * (Windows, network shares) it is always 0, and two different files would
 * look the same. A zero inode is therefore never a proof.
 */
export function isSameFile(
  a: { ino: number; dev: number },
  b: { ino: number; dev: number },
): boolean {
  if (a.ino === 0 || b.ino === 0) return false;
  return a.ino === b.ino && a.dev === b.dev;
}

export interface PlacementOptions {
  source: string;
  sdnextRoot: string;
  slot: SdnextSlot;
  mode: PlacementMode;
  /** keep the original file name instead of the manifest name */
  fileName?: string;
}

export async function planPlacement(opts: PlacementOptions): Promise<PlacementPlan> {
  const st = await stat(opts.source);
  const fileName = opts.fileName ?? basename(opts.source);
  if (opts.mode === 'in-place') {
    return {
      source: opts.source,
      target: opts.source,
      mode: 'in-place',
      sizeBytes: st.size,
      systemPath: { slot: opts.slot, path: dirname(opts.source) },
    };
  }
  return {
    source: opts.source,
    target: slotPath(opts.sdnextRoot, opts.slot, fileName),
    mode: opts.mode,
    sizeBytes: st.size,
  };
}

export interface ApplyResult {
  ok: boolean;
  path: string;
  bytes: number;
  method: PlacementMode;
  fallback?: string;
  error?: string;
}

async function copyWithProgress(
  source: string,
  target: string,
  onProgress?: (bytes: number, total: number) => void,
): Promise<number> {
  const st = await stat(source);
  let bytes = 0;
  const out = createWriteStream(target);
  await pipeline(
    createReadStream(source, { highWaterMark: 4 * 1024 * 1024 }),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        bytes += chunk.length;
        onProgress?.(bytes, st.size);
        yield chunk;
      }
    },
    out,
  );
  return bytes;
}

/**
 * There is already a file with this name in the folder.
 *
 * It is not automatically the file we wanted to place: it can be a partial
 * download, or a different model that happens to have the same name. We
 * compare it with the source and we say what we found, instead of
 * pretending the placement worked.
 */
async function describeExisting(plan: PlacementPlan, method: PlacementMode): Promise<ApplyResult> {
  const existing = await stat(plan.target).catch(() => undefined);
  const source = await stat(plan.source).catch(() => undefined);
  if (!existing || !source) {
    return { ok: true, path: plan.target, bytes: 0, method, fallback: 'already present' };
  }
  if (isSameFile(existing, source)) {
    return {
      ok: true,
      path: plan.target,
      bytes: 0,
      method,
      fallback: 'already there: it is the same file',
    };
  }
  if (existing.size !== source.size) {
    return {
      ok: false,
      path: plan.target,
      bytes: 0,
      method,
      error:
        `there is already a different file with this name ` +
        `(${existing.size} bytes on disk, ${source.size} in the source): it was left untouched`,
    };
  }
  return {
    ok: true,
    path: plan.target,
    bytes: 0,
    method,
    fallback: 'already there: a file of the same size, it was left untouched',
  };
}

export async function applyPlacement(
  plan: PlacementPlan,
  onProgress?: (bytes: number, total: number) => void,
): Promise<ApplyResult> {
  if (plan.mode === 'in-place') {
    return { ok: true, path: plan.source, bytes: 0, method: 'in-place' };
  }

  await mkdir(dirname(plan.target), { recursive: true });

  if (plan.mode === 'hardlink') {
    try {
      await link(plan.source, plan.target);
      return { ok: true, path: plan.target, bytes: 0, method: 'hardlink' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOSYS') {
        return {
          ok: false,
          path: plan.target,
          bytes: 0,
          method: 'hardlink',
          error: (err as Error).message,
        };
      }
      if (code === 'EEXIST') {
        return describeExisting(plan, 'hardlink');
      }
      // different volume or unsupported → fall back to a copy
      const bytes = await copyWithProgress(plan.source, plan.target, onProgress);
      return {
        ok: true,
        path: plan.target,
        bytes,
        method: 'copy',
        fallback: `hardlink impossible (${code})`,
      };
    }
  }

  if (plan.mode === 'symlink') {
    try {
      await symlink(plan.source, plan.target, 'file');
      return { ok: true, path: plan.target, bytes: 0, method: 'symlink' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return describeExisting(plan, 'symlink');
      }
      // Windows without developer mode → hardlink
      try {
        await link(plan.source, plan.target);
        return {
          ok: true,
          path: plan.target,
          bytes: 0,
          method: 'hardlink',
          fallback: `symlink impossible (${code})`,
        };
      } catch {
        const bytes = await copyWithProgress(plan.source, plan.target, onProgress);
        return {
          ok: true,
          path: plan.target,
          bytes,
          method: 'copy',
          fallback: `symlink impossible (${code})`,
        };
      }
    }
  }

  // copy
  const bytes = await copyWithProgress(plan.source, plan.target, onProgress);
  return { ok: true, path: plan.target, bytes, method: 'copy' };
}

/** System Paths override that SD.Next understands (settings → system paths). */
export function systemPathsOverride(root: string, entries: Array<{ slot: SdnextSlot; path: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    switch (e.slot) {
      case 'UNET':
        out.models = e.path;
        break;
      case 'Text-encoder':
        out.text_encoder = e.path;
        break;
      case 'VAE':
        out.vae = e.path;
        break;
      case 'Lora':
        out.lora = e.path;
        break;
    }
  }
  void root;
  return out;
}

/** Where the SD.Next configuration file lives, so we can patch System Paths. */
export function sdnextConfigPath(root: string): string {
  return join(root, 'config.json');
}

export { copyFile, constants, rename };
