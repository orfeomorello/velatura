/**
 * Build the release bundle: the app, platform archives and checksums.
 *
 *   release/
 *     app/                         ← the unpacked application bundle
 *     velatura-app-<version>.tar.gz ← Linux and macOS
 *     velatura-app-<version>.zip    ← Windows
 *     install.sh
 *     install.ps1
 *     SHASUMS256.txt
 *
 * The archives hold the same files for every platform: the program is
 * plain JavaScript. The installer reuses system Node 20.19+ when available,
 * otherwise it installs a checksum-verified portable runtime.
 *
 * The archives are written in Node itself (scripts/archive.mjs): no `tar`,
 * no `zip`, no 7-Zip. A release must build on the machine of whoever
 * wants to publish it, and `zip` does not exist on Windows.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTarGz, createZip } from './archive.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = join(root, 'release');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const appDir = join(release, 'app');
const tgzName = `velatura-app-${version}.tar.gz`;
const zipName = `velatura-app-${version}.zip`;
const tgz = join(release, tgzName);
const zip = join(release, zipName);
const full = join(root, `velatura-${version}.zip`);
const staging = join(root, `.release-stage-${version}`);

console.log('  building the bundle…');
execFileSync(process.execPath, [join(root, 'scripts', 'bundle.mjs')], { stdio: 'inherit' });

// The installers travel with the release.
for (const name of ['install.sh', 'install.ps1']) {
  await copyFile(join(root, 'installer', name), join(release, name));
}

console.log('  packing platform archives…');
await createTarGz(appDir, tgz, 'app');
await createZip(appDir, zip, 'app');

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

const lines = [];
for (const name of [tgzName, zipName]) {
  const path = join(release, name);
  const size = (await stat(path)).size;
  const digest = await sha256(path);
  lines.push(`${digest}  ${name}`);
  console.log(`  ${name.padEnd(36)} ${(size / 1e6).toFixed(2)} MB  ${digest.slice(0, 12)}…`);
}
await writeFile(join(release, 'SHASUMS256.txt'), `${lines.join('\n')}\n`, 'utf8');

// Build the convenience archive from only this version. Older releases may
// remain in release/ for reference, but must not be nested into the new zip.
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  await cp(appDir, join(staging, 'app'), { recursive: true });
  for (const name of ['install.sh', 'install.ps1', 'SHASUMS256.txt', tgzName, zipName]) {
    await copyFile(join(release, name), join(staging, name));
  }
  await rm(full, { force: true });
  await createZip(staging, full, '');
  const fullSize = (await stat(full)).size;
  console.log(`  ${`velatura-${version}.zip`.padEnd(36)} ${(fullSize / 1e6).toFixed(2)} MB`);

  // Keep the inner checksum list usable by the installers, and publish a
  // separate list outside the full ZIP so that the full ZIP can be hashed
  // without a self-referential checksum.
  const fullHash = await sha256(full);
  const releaseChecksums = [`${fullHash}  velatura-${version}.zip`, ...lines];
  await writeFile(join(root, 'SHASUMS256.txt'), `${releaseChecksums.join('\n')}\n`, 'utf8');
  console.log(`  full archive SHA-256          ${fullHash}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

await mkdir(appDir, { recursive: true });
console.log(`\n  release ready in ${release}`);
