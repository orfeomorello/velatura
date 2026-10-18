/**
 * The version of diffusers inside the environment of SD.Next.
 *
 * The layout of a virtual environment is not the same everywhere:
 * on Linux and macOS it is venv/lib/python3.11/site-packages,
 * on Windows it is venv/Lib/site-packages — there is no python3.11
 * level there. Both are read.
 *
 * Every path here is built with join(), so it carries the separator of
 * the system: a backslash on Windows. The code must never assume a
 * slash.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Wildcard {
  /** the folder that holds the name with the wildcard */
  dir: string;
  /** the beginning of the name */
  prefix: string;
  /** the end of the name */
  suffix: string;
  /** the rest of the path, after the name */
  rest: string[];
}

/**
 * Read a path whose name holds a wildcard, e.g.
 * `…/site-packages/diffusers-*.dist-info/METADATA`.
 *
 * The path can be written with either separator: the folders of a
 * virtual environment are different on Linux and on Windows, and a
 * path built with join() carries the separator of the system.
 */
export function splitWildcard(candidate: string): Wildcard | undefined {
  const star = candidate.indexOf('*');
  if (star === -1) return undefined;

  // the name that holds the wildcard: from the separator before it to
  // the separator after it
  let start = star;
  while (start > 0 && !/[\\/]/.test(candidate[start - 1]!)) start--;
  let end = star;
  while (end < candidate.length && !/[\\/]/.test(candidate[end]!)) end++;

  const name = candidate.slice(start, end);
  const after = candidate.slice(end + 1);
  return {
    // the folder is taken as it is written: the root ('/home' or 'C:')
    // must not be lost. The separator at the end is not kept.
    dir: candidate.slice(0, start).replace(/[\\/]+$/, ''),
    prefix: name.slice(0, star - start),
    suffix: name.slice(star - start + 1),
    rest: after ? after.split(/[\\/]/) : [],
  };
}

export async function readDiffusersVersion(root: string): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const lib of ['lib', 'Lib']) {
    const base = join(root, 'venv', lib);

    // the level of the python version: venv/lib/python3.11/site-packages
    let entries: string[] = [];
    try {
      entries = await readdir(base);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.startsWith('python')) {
        candidates.push(join(base, entry, 'site-packages', 'diffusers', '__init__.py'));
        candidates.push(join(base, entry, 'site-packages', 'diffusers-*.dist-info', 'METADATA'));
      }
    }

    // no python level at all: venv/Lib/site-packages, the layout of Windows
    candidates.push(join(base, 'site-packages', 'diffusers', '__init__.py'));
    candidates.push(join(base, 'site-packages', 'diffusers-*.dist-info', 'METADATA'));
  }

  for (const candidate of candidates) {
    const wildcard = splitWildcard(candidate);
    if (wildcard) {
      let names: string[] = [];
      try {
        names = await readdir(wildcard.dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith(wildcard.prefix) || !name.endsWith(wildcard.suffix)) continue;
        const text = await readFile(join(wildcard.dir, name, ...wildcard.rest), 'utf8').catch(() => '');
        const match = text.match(/^Version:\s*(.+)$/m);
        if (match) return match[1]!.trim();
      }
      continue;
    }
    const text = await readFile(candidate, 'utf8').catch(() => '');
    const match = text.match(/__version__\s*=\s*['"]([^'"]+)['"]/);
    if (match) return match[1]!;
  }
  return undefined;
}
