/**
 * The temporary folders of the tests.
 *
 * Every test writes in a folder of its own, under the temporary folder of
 * the system. Without this, a test run leaves hundreds of empty folders
 * behind: on a laptop, that is clutter nobody asked for.
 *
 * The list is taken before the run and compared after: only the folders
 * created by this run are removed, and nothing that belongs to another
 * process is touched.
 */
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** the prefixes our tests use */
const PREFIXES = [
  'velatura-test-',
  'velatura-dl-',
  'velatura-jsonl-',
  'velatura-profiles-',
  'velatura-disk-',
  'velatura-place-',
  'velatura-lora-',
  'velatura-images-',
  'velatura-empty-',
  'velatura-sdnext-',
  'velatura-install-',
];

let before = new Set<string>();

async function current(): Promise<Set<string>> {
  const names = await readdir(tmpdir()).catch(() => [] as string[]);
  return new Set(names.filter((name) => PREFIXES.some((prefix) => name.startsWith(prefix))));
}

export async function setup(): Promise<void> {
  before = await current();
}

export async function teardown(): Promise<void> {
  const after = await current();
  for (const name of after) {
    if (before.has(name)) continue;
    await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => undefined);
  }
}
