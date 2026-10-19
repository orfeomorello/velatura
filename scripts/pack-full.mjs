/**
 * Pack the whole release in a single file.
 *
 *   node scripts/pack-full.mjs velatura-0.1.5.zip release
 *
 * This is the archive for the people who download the release by hand: it
 * holds the program, the installers and the checksums, all together.
 * The installers download the smaller `velatura-app-<version>.zip`.
 *
 * The archive is written in Node (`scripts/archive.mjs`): `zip` does not
 * exist on Windows, and the release must build everywhere.
 */
import { rm } from 'node:fs/promises';
import { createZip } from './archive.mjs';

const [out, folder] = process.argv.slice(2);
if (!out || !folder) {
  console.error('usage: node scripts/pack-full.mjs <out.zip> <folder>');
  process.exit(1);
}

// the file must not contain itself
await rm(out, { force: true });
const bytes = await createZip(folder, out, '');
console.log(`  ${out.padEnd(32)} ${(bytes / 1e6).toFixed(2)} MB`);
