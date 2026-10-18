/**
 * The installers, checked without running them.
 *
 * The Linux one is executed by another test (it needs a shell and `tar`).
 * The Windows one cannot be executed here, but it can be *read*: the
 * mistakes that break an installation are visible in the text — a missing
 * checksum, a launcher that points nowhere, a path that needs the
 * administrator.
 *
 * These checks run on every system, so a Windows machine that runs
 * `npm test` really checks the PowerShell installer.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(dirname(here)));
const psPath = join(root, 'installer', 'install.ps1');
const shPath = join(root, 'installer', 'install.sh');

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('the Windows installer', () => {
  it('is a PowerShell script with the expected switches', async () => {
    const text = await readFile(psPath, 'utf8');
    for (const flag of ['$From', '$Url', '$Dir', '$Node', '$NoLaunch', '$Yes']) {
      expect(text).toContain(flag);
    }
    expect(text).toContain('[CmdletBinding()]');
    expect(text).toContain('param(');
  });

  it('verifies the checksum of the Node runtime it downloads', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('Get-FileHash -Algorithm SHA256');
    expect(text).toContain('SHASUMS256.txt');
    expect(text).toContain('checksum mismatch');
    expect(text).toContain('could not download the official Node checksum list');
    expect(text).not.toContain('checksum was not checked');
    // the version of the runtime is pinned, not "latest"
    expect(text).toMatch(/\$NodeVersion = 'v\d+\.\d+\.\d+'/);
  });

  it('reuses a compatible system Node before downloading a portable runtime', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('$MinNodeMajor = 20');
    expect(text).toContain('$MinNodeMinor = 19');
    expect(text).toContain('function Find-SystemNode');
    expect(text).toContain('Get-Command node');
    expect(text).toContain("Write-Info 'nothing was downloaded'");
    expect(text.indexOf('$systemNode = Find-SystemNode')).toBeLessThan(
      text.indexOf('Write-Info "downloading $archiveName"'),
    );
  });

  it('extracts the verified Windows Node ZIP from its versioned top-level folder', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('$nodeFolder = Join-Path $unpack "node-$NodeVersion-win-$($arch)"');
    expect(text).toContain("$extractedNode = Join-Path $nodeFolder 'node.exe'");
    expect(text).toContain('Move-Item -Path $nodeFolder -Destination $runtimeDir');
  });

  it('creates a command the user can run', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('velatura.cmd');
    // the launcher points at the installed program and keeps the data inside
    expect(text).toContain('dist\\velatura.js');
    expect(text).toContain('VELATURA_CONFIG_DIR');
    // and it is put on the user PATH, without asking for the administrator
    expect(text).toContain("GetEnvironmentVariable('Path', 'User')");
    expect(text).not.toMatch(/RunAs|-Verb\s+runas/i);
  });

  it('checks Windows system and user locations for a complete SD.Next checkout', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('webui.bat');
    expect(text).toContain('launch.py');
    expect(text).toContain('$env:SystemDrive');
    expect(text).toContain('The setup wizard will check this folder');
  });

  it('does not lose a file extension in a string', async () => {
    const text = await readFile(psPath, 'utf8');
    // In a double-quoted string, a variable followed by a dot is a property
    // access: "velatura-app-$Version.zip" asks for the .zip property of the
    // version, which does not exist, and the extension disappears from the
    // URL. The safe form is the subexpression: "$($Version).zip".
    for (const literal of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      // the subexpressions are put aside: they are the safe form
      const masked = literal[1]!.replace(/\$\([^)]*\)/g, 'S');
      const trap = /\$[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+/.exec(masked);
      expect(trap, `the string "${literal[0]}" reads a property of a variable`).toBeNull();
    }
  });

  it('can remove what it installed', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('[switch] $Uninstall');
    expect(text).toContain('Velatura is not on this machine any more');
  });

  it('writes the launcher for cmd.exe with CRLF line endings and no byte order mark', async () => {
    const text = await readFile(psPath, 'utf8');
    // a batch file with LF line endings is read badly by cmd.exe
    expect(text).toContain('WriteAllText');
    expect(text).toContain('ASCIIEncoding');
    expect(text).toContain('`r`n');
  });

  it('selects one exact file entry from each Node and application checksum list', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('$parts[1] -eq $archiveName');
    expect(text).toContain('Select-Object -First 1');
    expect(text.split('\n').filter((line) => line.includes('$sumLine =')).length).toBe(2);
    expect(text).toContain('Node runtime checksum verified');
  });

  it('verifies downloaded and local application archives before unpacking', async () => {
    const text = await readFile(psPath, 'utf8');
    expect(text).toContain('SHASUMS256.txt');
    expect(text).toContain("$checksumPath = Join-Path (Split-Path -Parent $fromPath) 'SHASUMS256.txt'");
    expect(text).toContain('local application checksum list not found');
    expect(text).toContain('Get-FileHash -Algorithm SHA256 -Path $archive');
    expect(text).toContain('checksum mismatch for the application archive');
  });

  it('has no PowerShell trap in it', async () => {
    const text = await readFile(psPath, 'utf8');
    // "$variable:" is read as a drive-qualified variable and fails at run time
    for (const match of text.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*:/g)) {
      expect(match[0]).toBe('$env:');
    }
    // the brackets balance
    for (const [open, close] of [
      ['{', '}'],
      ['(', ')'],
      ['[', ']'],
    ]) {
      expect(count(text, open)).toBe(count(text, close));
    }
    // the here-strings are closed
    expect(count(text, "@'")).toBe(count(text, "'@"));
  });
});

describe('the Linux and macOS installer', () => {
  it('can remove what it installed', async () => {
    const text = await readFile(shPath, 'utf8');
    expect(text).toContain('--uninstall');
    expect(text).toContain('Velatura is not on this machine any more');
    expect(text).toContain('rm -rf \"$INSTALL_DIR\"');
  });

  it('writes a shell launcher that points to the installed program and data', async () => {
    const text = await readFile(shPath, 'utf8');
    expect(text).toContain('cat > "$LAUNCHER"');
    expect(text).toContain('VELATURA_CONFIG_DIR');
    expect(text).toContain('exec "$NODE_BIN"');
  });

  it('verifies the private Node runtime against the official checksum list', async () => {
    const text = await readFile(shPath, 'utf8');
    expect(text).toContain('SHASUMS256.txt');
    expect(text).toContain('Node runtime checksum verified');
    expect(text).toContain('could not verify the Node runtime checksum');
    expect(text).not.toContain('checksum was not checked');
    expect(text).toContain('awk -v f=');
  });

  it('verifies downloaded and local application archives before unpacking', async () => {
    const text = await readFile(shPath, 'utf8');
    expect(text).toContain('SHASUMS256.txt');
    expect(text).toContain('CHECKSUM_FILE="$(dirname "$FROM")/SHASUMS256.txt"');
    expect(text).toContain('local application checksum list not found');
    // the checksum is computed with sha256_of: macOS has no sha256sum
    expect(text).toContain('sha256_of "$APP_ARCHIVE"');
    expect(text).toContain('shasum -a 256');
    expect(text).toContain('checksum mismatch for the application archive');
  });

  it('reuses a compatible system Node before downloading a portable runtime', async () => {
    const text = await readFile(shPath, 'utf8');
    expect(text).toContain('MIN_NODE="20.19"');
    expect(text).toContain('node_is_new_enough');
    expect(text).toContain('find_system_node');
    expect(text).toContain('nothing was downloaded');
    expect(text.indexOf('SYSTEM_NODE="$(find_system_node || true)"')).toBeLessThan(
      text.indexOf('say "downloading $(basename "$ARCHIVE")"'),
    );
  });

  it('is a valid shell script', async () => {
    const text = await readFile(shPath, 'utf8');
    expect(text.startsWith('#!')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    // the same contract as the Windows one
    expect(text).toContain('--from');
    expect(text).toContain('--url');
    expect(text).toContain('--node');
    expect(text).toContain('--no-launch');
    expect(text).toContain('sha256sum');
    expect(text).toContain('velatura');
  });
});
