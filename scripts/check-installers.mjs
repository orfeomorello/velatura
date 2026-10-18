/**
 * Static checks for the installers.
 *
 * The Linux script is checked with the real shell. The Windows one cannot
 * be executed here, so it is checked for the mistakes that are easy to
 * make and hard to see: unbalanced brackets, PowerShell's "$var:" trap
 * (it reads as a drive-qualified variable), and a here-string that was
 * never closed.
 *
 * The shell is called with a *relative* path, made of forward slashes:
 * a path of Windows (`C:\…\install.sh`) is read by the shell of Git as
 * `C:…install.sh`, and the check would fail for a reason that has
 * nothing to do with the script.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const add = (file, message) => problems.push({ file, message });

// ---------------------------------------------------------------- Linux ----
// the syntax of the shell script is checked with the shell itself: where
// there is no shell (Windows without Git), the check is simply not
// possible, and the text checks below still apply
const sh = join(root, 'installer', 'install.sh');
let bashFound = true;
try {
  execFileSync('bash', ['-n', 'installer/install.sh'], { cwd: root, stdio: 'pipe' });
  console.log('  install.sh   syntax ok');
} catch (err) {
  if (err.code === 'ENOENT') {
    bashFound = false;
    console.log('  install.sh   no shell here: the syntax was not checked');
  } else {
    const detail = (err.stderr?.toString() || err.message).trim().split('\n')[0];
    add('install.sh', `the shell refused the file: ${detail}`);
  }
}

// the same text checks, on every system
const shText = await readFile(sh, 'utf8');
for (const needle of [
  'set -euo pipefail',
  '--from',
  '--url',
  '--node',
  '--no-launch',
  'sha256sum',
  'sha256_of',
  'webui.sh',
  'launch.py',
  'no SD.Next startup script was found',
  'then asks before it clones',
  'Node runtime checksum verified',
]) {
  if (!shText.includes(needle)) add('install.sh', `"${needle}" is missing`);
}
if (problems.every((p) => p.file !== 'install.sh')) console.log('  install.sh   text checks ok');

// -------------------------------------------------------------- Windows ----
const ps = join(root, 'installer', 'install.ps1');
const text = await readFile(ps, 'utf8');

const count = (needle) => text.split(needle).length - 1;
const pairs = [
  ['{', '}'],
  ['(', ')'],
  ['[', ']'],
];
for (const [open, close] of pairs) {
  const a = count(open);
  const b = count(close);
  if (a !== b) add('install.ps1', `${open}…${close} unbalanced (${a} vs ${b})`);
}

for (const needle of [
  'webui.bat',
  'launch.py',
  'SystemDrive',
  'No SD.Next startup script was found',
  'then asks you to confirm before it clones',
  'Node runtime checksum verified',
  'Find-SystemNode',
]) {
  if (!text.includes(needle)) add('install.ps1', `\"${needle}\" is missing`);
}

// "$variable:" is parsed as a drive-qualified variable and fails at run time
for (const match of text.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*:/g)) {
  if (match[0] === '$env:') continue; // the environment scope is legitimate
  add('install.ps1', `"${match[0]}" would be read as a drive-qualified variable`);
}

// here-strings must be closed
if (count("@'") !== count("'@")) add('install.ps1', 'an here-string is not closed');

console.log(`  install.ps1  ${problems.some((p) => p.file === 'install.ps1') ? 'problems found' : 'static checks ok'}`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem.file}: ${problem.message}`);
  process.exit(1);
}
