/**
 * The version of diffusers inside the environment of SD.Next.
 *
 * The layout of a virtual environment is not the same everywhere:
 * on Linux and macOS it is venv/lib/python3.11/site-packages,
 * on Windows it is venv/Lib/site-packages — there is no python3.11 level
 * there. The program has to find both.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDiffusersVersion, splitWildcard } from '../src/diffusers.js';

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'velatura-venv-'));
}

describe('the version of diffusers', () => {
  it('reads a wildcard in a path written with either separator', () => {
    // the path is built with join(), so it carries the separator of the
    // system: a backslash on Windows. The code must not assume a slash.
    const withSlash = '/home/jane/venv/Lib/site-packages/diffusers-*.dist-info/METADATA';
    const withBackslash = 'C:\\Users\\jane\\venv\\Lib\\site-packages\\diffusers-*.dist-info\\METADATA';

    const a = splitWildcard(withSlash)!;
    const b = splitWildcard(withBackslash)!;

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // the same pieces, whatever the separator
    expect(a.prefix).toBe(b.prefix);
    expect(a.suffix).toBe(b.suffix);
    expect(a.rest).toEqual(b.rest);
    expect(a.rest).toEqual(['METADATA']);
    expect(a.dir.endsWith('site-packages')).toBe(true);
    expect(b.dir.endsWith('site-packages')).toBe(true);
  });

  it('reads a wildcard in a path built the way Windows builds it', () => {
    // the path of Windows is simulated on every system, so the behaviour
    // is checked here too, and not only where Windows runs
    const candidate = win32.join(
      'C:\\Users\\jane',
      'venv',
      'Lib',
      'site-packages',
      'diffusers-*.dist-info',
      'METADATA',
    );
    const w = splitWildcard(candidate)!;
    expect(w).toBeDefined();
    expect(w.dir).toBe('C:\\Users\\jane\\venv\\Lib\\site-packages');
    expect(w.prefix).toBe('diffusers-');
    expect(w.suffix).toBe('.dist-info');
    expect(w.rest).toEqual(['METADATA']);
  });

  it('says nothing about a path without a wildcard', () => {
    expect(splitWildcard('/home/jane/venv/Lib/site-packages/diffusers/__init__.py')).toBeUndefined();
  });

  it('reads it from the layout of Linux and macOS', async () => {
    const root = await fixture();
    const dir = join(root, 'venv', 'lib', 'python3.11', 'site-packages', 'diffusers');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '__init__.py'), "__version__ = '0.35.1'\n", 'utf8');
    expect(await readDiffusersVersion(root)).toBe('0.35.1');
  });

  it('reads it from the layout of Windows, where there is no python level', async () => {
    const root = await fixture();
    const dir = join(root, 'venv', 'Lib', 'site-packages', 'diffusers');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '__init__.py'), "__version__ = '0.35.1'\n", 'utf8');
    expect(await readDiffusersVersion(root)).toBe('0.35.1');
  });

  it('reads it from the metadata of the package, on every system', async () => {
    const root = await fixture();
    const dir = join(root, 'venv', 'Lib', 'site-packages', 'diffusers-0.36.0.dist-info');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'METADATA'), 'Name: diffusers\nVersion: 0.36.0\n', 'utf8');
    expect(await readDiffusersVersion(root)).toBe('0.36.0');
  });

  it('says nothing when the environment does not exist yet', async () => {
    const root = await fixture();
    expect(await readDiffusersVersion(root)).toBeUndefined();
  });
});
