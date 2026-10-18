/**
 * The Linux installer, the two ways.
 *
 * One with a local archive (`--from`) and one with a download (`--url`):
 * they are different paths in the script, and the download one was broken
 * — it unpacked an empty name. The test that would have caught it is here
 * now.
 *
 * The test needs a shell, `tar` and a free port: it is skipped on Windows.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTarGz } from '../../../scripts/archive.mjs';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(dirname(here)));

// the test is about a Unix installer: it needs a shell and tar
const unix = process.platform !== 'win32';
const suite = unix ? describe : describe.skip;

const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const archiveName = `velatura-app-${version}.tar.gz`;

let server: Server;
let base = '';
let work: string;

beforeAll(async () => {
  // the bundle, packed exactly like a release
  execFileSync(process.execPath, [join(root, 'scripts', 'bundle.mjs')], { stdio: 'pipe' });
  work = await mkdtemp(join(tmpdir(), 'velatura-install-'));
  await createTarGz(join(root, 'release', 'app'), join(work, archiveName), 'app');

  // the checksums, like the ones published with a release
  const digest = createHash('sha256').update(await readFile(join(work, archiveName))).digest('hex');
  await writeFile(join(work, 'SHASUMS256.txt'), `${digest}  ${archiveName}\n`, 'utf8');

  server = createServer((req, res) => {
    const name = (req.url ?? '/').replace(/^\//, '');
    void readFile(join(work, name))
      .then((body) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404);
        res.end('not found');
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
}, 180_000);

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

suite('the installer', () => {
  it('installs the program from a local archive and creates a working command', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'velatura-home-')), 'home');
    await mkdir(home, { recursive: true });

    const { stdout: installerOutput } = await run(
      'bash',
      [
        join(root, 'installer', 'install.sh'),
        '--from',
        join(work, archiveName),
        '--node',
        process.execPath,
        '--no-launch',
        '--yes',
      ],
      { env: { ...process.env, HOME: home } },
    );
    expect(installerOutput).toContain('application checksum verified');

    const launcher = join(home, '.local', 'bin', 'velatura');
    expect((await stat(launcher)).isFile()).toBe(true);
    await chmod(launcher, 0o755);

    const { stdout } = await run(launcher, ['--version'], { env: { ...process.env, HOME: home } });
    const version = stdout.trim();
    expect(version).toBe('0.1.4');

    const { stdout: doctor } = await run(launcher, ['doctor'], { env: { ...process.env, HOME: home } });
    expect(doctor).toContain('manifest');
    expect(doctor).toContain('profiles');
  }, 180_000);

  it('refuses a local archive when its adjacent checksum does not match', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'velatura-home-')), 'home');
    const badDir = await mkdtemp(join(tmpdir(), 'velatura-bad-archive-'));
    await mkdir(home, { recursive: true });
    const badArchive = join(badDir, archiveName);
    await copyFile(join(work, archiveName), badArchive);
    await writeFile(join(badDir, 'SHASUMS256.txt'), `${'0'.repeat(64)}  ${archiveName}\n`, 'utf8');

    let output = '';
    try {
      await run(
        'bash',
        [join(root, 'installer', 'install.sh'), '--from', badArchive, '--node', process.execPath, '--no-launch', '--yes'],
        { env: { ...process.env, HOME: home } },
      );
    } catch (err) {
      output = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`;
    }

    expect(output).toContain('checksum mismatch for the application archive');
    await expect(stat(join(home, '.velatura', 'app'))).rejects.toThrow();
  }, 180_000);

  it('refuses a local archive if its adjacent checksum list is missing', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'velatura-home-')), 'home');
    const missingSumsDir = await mkdtemp(join(tmpdir(), 'velatura-missing-sums-'));
    await mkdir(home, { recursive: true });
    const localArchive = join(missingSumsDir, archiveName);
    await copyFile(join(work, archiveName), localArchive);

    let output = '';
    try {
      await run(
        'bash',
        [join(root, 'installer', 'install.sh'), '--from', localArchive, '--node', process.execPath, '--no-launch', '--yes'],
        { env: { ...process.env, HOME: home } },
      );
    } catch (err) {
      output = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`;
    }

    expect(output).toContain('local application checksum list not found');
    await expect(stat(join(home, '.velatura', 'app'))).rejects.toThrow();
  }, 180_000);

  it('uses the Node that is already on the machine, and downloads nothing', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'velatura-home-')), 'home');
    await mkdir(home, { recursive: true });

    // a Node on the machine: new enough, so nothing has to be downloaded
    const fakeBin = join(await mkdtemp(join(tmpdir(), 'velatura-node-')), 'bin');
    await mkdir(fakeBin, { recursive: true });
    const fakeNode = join(fakeBin, 'node');
    await writeFile(
      fakeNode,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v20.19.0; else exec "$VELATURA_TEST_REAL_NODE" "$@"; fi\n',
      'utf8',
    );
    await chmod(fakeNode, 0o755);

    const { stdout } = await run(
      'bash',
      [
        join(root, 'installer', 'install.sh'),
        '--from',
        join(work, archiveName),
        '--no-launch',
        '--yes',
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:${process.env.PATH}`,
          VELATURA_TEST_REAL_NODE: process.execPath,
        },
      },
    );

    // the Node of the machine was taken, and nothing was downloaded
    expect(stdout).toContain('using the Node already on this machine');
    expect(stdout).toContain('nothing was downloaded');
    expect(stdout).not.toContain('downloading node');

    // the launcher uses that same system Node successfully
    const launcher = join(home, '.local', 'bin', 'velatura');
    const { stdout: version } = await run(launcher, ['--version'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
        VELATURA_TEST_REAL_NODE: process.execPath,
      },
    });
    expect(version.trim()).toBe('0.1.4');

    // and no portable runtime was left behind
    await expect(stat(join(home, '.velatura', 'runtime'))).rejects.toThrow();
  }, 180_000);

  it('rejects an explicitly selected Node older than the minimum', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'velatura-home-')), 'home');
    await mkdir(home, { recursive: true });

    // a Node on the machine, but too old
    const fakeBin = join(await mkdtemp(join(tmpdir(), 'velatura-node-')), 'bin');
    await mkdir(fakeBin, { recursive: true });
    const fakeNode = join(fakeBin, 'node');
    await writeFile(fakeNode, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v18.20.0; fi\n', 'utf8');
    await chmod(fakeNode, 0o755);

    // An explicit --node choice must fail fast, before any archive or
    // runtime download is attempted.
    let output = '';
    try {
      const result = await run(
        'bash',
        [
          join(root, 'installer', 'install.sh'),
          '--from',
          join(work, archiveName),
          '--node',
          fakeNode,
          '--no-launch',
          '--yes',
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}:${process.env.PATH}`,
          },
        },
      );
      output = result.stdout;
    } catch (err) {
      output = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`;
    }

    // it said so, before trying to download anything
    expect(output).toContain('too old');
    expect(output).toContain('20.19');
  }, 180_000);

  it('removes everything it installed', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'velatura-home-')), 'home');
    await mkdir(home, { recursive: true });

    await run(
      'bash',
      [
        join(root, 'installer', 'install.sh'),
        '--from',
        join(work, archiveName),
        '--node',
        process.execPath,
        '--no-launch',
        '--yes',
      ],
      { env: { ...process.env, HOME: home } },
    );

    // it is there
    const launcher = join(home, '.local', 'bin', 'velatura');
    expect((await stat(launcher)).isFile()).toBe(true);
    expect((await stat(join(home, '.velatura', 'app', 'dist', 'velatura.js'))).isFile()).toBe(true);

    await run('bash', [join(root, 'installer', 'install.sh'), '--uninstall', '--yes'], {
      env: { ...process.env, HOME: home },
    });

    // and now it is not
    await expect(stat(launcher)).rejects.toThrow();
    await expect(stat(join(home, '.velatura'))).rejects.toThrow();
    // the line of the PATH is gone too
    const rc = await readFile(join(home, '.bashrc'), 'utf8').catch(() => '');
    expect(rc).not.toContain('Velatura');
    expect(rc).not.toContain('.local/bin');
  }, 180_000);

  it('installs the program by downloading it, and checks the checksum', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'velatura-home-')), 'home');
    await mkdir(home, { recursive: true });

    const { stdout: output } = await run(
      'bash',
      [
        join(root, 'installer', 'install.sh'),
        '--url',
        base,
        '--node',
        process.execPath,
        '--no-launch',
        '--yes',
      ],
      { env: { ...process.env, HOME: home } },
    );

    // the checksum of the archive was verified against the published list
    expect(output).toContain('checksum verified');

    const launcher = join(home, '.local', 'bin', 'velatura');
    expect((await stat(launcher)).isFile()).toBe(true);
    await chmod(launcher, 0o755);

    // and the program that was unpacked is the right one
    const installed = join(home, '.velatura', 'app', 'dist', 'velatura.js');
    expect((await stat(installed)).isFile()).toBe(true);
    const { stdout } = await run(launcher, ['--version'], { env: { ...process.env, HOME: home } });
    const version = stdout.trim();
    expect(version).toBe('0.1.4');
  }, 180_000);
});
