#!/usr/bin/env node
/**
 * Velatura CLI — `velatura serve | setup | doctor | models | shell`
 */
import { readDiffusersVersion } from './diffusers.js';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import {
  DEFAULT_PROFILES,
  JsonlStore,
  applyPlacement,
  downloadFile,
  findSdnextRoot,
  foreignInstallCandidates,
  knownFilesFor,
  loadProfiles,
  parseManifest,
  planPlacement,
  scanFile,
  scanForeignInstalls,
  slotDir,
  verifyFile,
  detectHardware,
  checkDiskSpace,
  clearImages,
  findPartials,
  imageStore,
  imagesDir,
  type Manifest,
  type PlacementMode,
  type SdnextSlot,
} from '@velatura/core';
import {
  buildServer,
  resolveManifestPath,
  resolveProfilesPath,
  velaturaLogDirectory,
  velaturaLogFile,
} from '@velatura/server';
import { configDir, configPath, loadConfig, saveConfig } from '@velatura/server';

const program = new Command();
// the options belong to the command that is being run: `velatura serve --port 7866`
// must not be swallowed by the root command
program.enablePositionalOptions();
program
  .name('velatura')
  .description('Velatura — simplified local interface for Qwen-Image 2.1 on SD.Next')
  .version('0.1.5');

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

async function readProfiles(): Promise<typeof DEFAULT_PROFILES> {
  const dir = resolveProfilesPath();
  return dir ? await loadProfiles(dir) : DEFAULT_PROFILES;
}

/** The manifest ids a profile needs, or undefined when there is no profile. */
async function profileManifestIds(profileId?: string): Promise<string[] | undefined> {
  if (!profileId) return undefined;
  const profiles = await readProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    console.error(`  Unknown profile "${profileId}". Known: ${profiles.map((p) => p.id).join(', ')}`);
    process.exitCode = 1;
    return [];
  }
  return profile.models.map((m) => m.manifestId);
}

async function readManifest(): Promise<Manifest | undefined> {
  const path = resolveManifestPath();
  if (!path) return undefined;
  try {
    return parseManifest(await readFile(path, 'utf8'));
  } catch (err) {
    console.error(`manifest error: ${(err as Error).message}`);
    return undefined;
  }
}

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''} `)).trim();
  rl.close();
  return answer || fallback;
}

// ---------------------------------------------------------------- serve ----

interface ServeOptions {
  port?: string;
  sdnext?: string;
  open?: boolean;
}

/**
 * The file that tells a second instance where the first one is.
 * It lives in the user's own folder, with the token of this session.
 */
function sessionFile(): string {
  return join(configDir(), 'session.json');
}

async function writeSession(url: string, port: number, token: string): Promise<void> {
  try {
    await writeFile(
      sessionFile(),
      `${JSON.stringify({ url, port, token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(sessionFile(), 0o600).catch(() => undefined);
  } catch {
    /* not fatal */
  }
}

async function readSession(): Promise<{ url: string; port: number; token: string } | undefined> {
  try {
    const raw = JSON.parse(await readFile(sessionFile(), 'utf8')) as { url?: string; port?: number; token?: string };
    if (raw.url) return { url: raw.url, port: raw.port ?? 0, token: raw.token ?? '' };
  } catch {
    /* no session */
  }
  return undefined;
}

async function serve(options: ServeOptions): Promise<void> {
  const built = await buildServer({
    port: options.port ? Number(options.port) : undefined,
    sdnextRoot: options.sdnext,
    logger: false,
  });
  const host = '127.0.0.1';
  try {
    await built.app.listen({ host, port: built.config.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      const running = await readSession();
      console.error('');
      if (running) {
        console.error('  Velatura is already running. Here is its address:');
        console.error(`  ${running.url}`);
        console.error('');
        if (options.open !== false) openBrowser(running.url);
      } else {
        console.error(`  The port ${built.config.port} is already in use by something else.`);
        console.error('  To use another port:  velatura serve --port 7866');
        console.error('');
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const address = built.app.server.address();
  const port = typeof address === 'object' && address ? address.port : built.config.port;
  const url = `http://${host}:${port}/#token=${built.token}`;
  console.log('');
  console.log('  Velatura');
  console.log(`  UI:      ${url}`);
  console.log(`  Engine:  ${built.sdnextUrl()}`);
  console.log(`  Config:  ${configPath()}`);
  console.log(`  Logs:    ${built.logFile}`);
  built.diagnostics.info('server.listening', { port, profileId: built.config.profileId });
  console.log('');
  // machine readable line: the optional native shell reads this
  console.log(`VELATURA_URL=${url}`);
  await writeSession(url, port, built.token);
  if (options.open !== false) openBrowser(url);

  const shutdown = async () => {
    built.diagnostics.info('server.shutdown.started');
    await built.app.close();
    await built.diagnostics.flush();
    await rm(sessionFile(), { force: true }).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

program
  .command('serve')
  .description('start Velatura and open it in your browser')
  .option('-p, --port <port>', 'port for the Velatura UI', '7865')
  .option('-s, --sdnext <path>', 'path of the SD.Next installation')
  .option('--no-open', 'do not open the browser')
  .action(serve);

// `velatura` without arguments simply starts the studio
program
  .option('-p, --port <port>', 'port for the Velatura UI')
  .option('-s, --sdnext <path>', 'path of the SD.Next installation')
  .option('--no-open', 'do not open the browser')
  .action(async (options: { port?: string; sdnext?: string; open?: boolean }) => {
    await serve(options);
  });

// ---------------------------------------------------------------- setup ----
program
  .command('setup')
  .description('guided setup: find SD.Next, choose a profile, fetch the models')
  .option('-s, --sdnext <path>', 'path of the SD.Next installation')
  .option('-p, --profile <id>', 'profile to use (lowvram, full)')
  .option('-y, --yes', 'do not ask anything')
  .action(async (options: { sdnext?: string; profile?: string; yes?: boolean }) => {
    const config = await loadConfig();
    let root = options.sdnext ?? config.sdnextRoot ?? (await findSdnextRoot());

    console.log('\n  Velatura setup\n');
    if (!root) {
      console.log('  SD.Next was not found automatically.');
      root = await ask('  Path of the SD.Next installation', join(homedir(), 'sdnext'));
    }
    console.log(`  SD.Next: ${root}`);
    config.sdnextRoot = root;

    if (options.profile) {
      const profiles = await readProfiles();
      const profile = profiles.find((p) => p.id === options.profile);
      if (!profile) {
        console.error(`  Unknown profile "${options.profile}". Known: ${profiles.map((p) => p.id).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      config.profileId = profile.id;
      console.log(`  Profile: ${profile.label} (${profile.description ?? ''})`);
    }
    await saveConfig(config);

    const manifest = await readManifest();
    if (!manifest) {
      console.log('  No manifest found — run from the repository or set VELATURA_MANIFEST.');
      return;
    }

    console.log('\n  Check-list\n');
    for (const entry of manifest.models) {
      const dir = slotDir(root, entry.dest);
      const installed = knownFilesFor(entry).some(() => existsSync(join(dir, entry.file)));
      console.log(
        `   ${installed ? '✓' : '·'} ${entry.label.padEnd(42)} ${entry.role.padEnd(13)} → ${entry.dest}`,
      );
    }
    console.log('\n  Missing files can be downloaded with `velatura models fetch`, or placed by hand —');
    console.log('  the app tells you the exact file name and the exact folder.\n');
  });

program
  .command('export')
  .description('write the file names, folders and licences of a profile to a text file')
  .option('-p, --profile <id>', 'profile id (lowvram, full)')
  .option('-o, --out <file>', 'where to write it', 'velatura-setup.md')
  .action(async (options: { profile?: string; out: string }) => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    const manifest = await readManifest();
    const profiles = await readProfiles();
    const profile = profiles.find((p) => p.id === (options.profile ?? config.profileId));
    if (!profile || !manifest) {
      console.error('  Unknown profile or missing manifest.');
      process.exitCode = 1;
      return;
    }
    const target = root ?? '<your SD.Next folder>';
    const lines: string[] = [];
    lines.push(`# Velatura — ${profile.label}`, '', profile.description ?? '', '');
    lines.push(`SD.Next folder: \`${target}\``, '', '## Files to place', '');
    for (const item of profile.models) {
      const entry = manifest.models.find((m) => m.id === item.manifestId);
      if (!entry) continue;
      const fileName = (item.file ?? entry.file).split('/').pop();
      lines.push(`### ${entry.label} (${item.role})`);
      lines.push(`- file: \`${fileName}\``);
      lines.push(`- folder: \`${target}/models/${entry.dest}/\``);
      lines.push(`- from: ${entry.repo} @ ${entry.revision.slice(0, 12)}`);
      if (entry.sizeBytes) lines.push(`- size: ${(entry.sizeBytes / 1e9).toFixed(2)} GB`);
      if (entry.sha256) lines.push(`- sha256: \`${entry.sha256}\``);
      lines.push(`- licence: ${entry.license}${entry.licenseUrl ? ` — ${entry.licenseUrl}` : ''}`, '');
    }
    lines.push('## Generation settings', '');
    lines.push(`- steps: ${profile.steps}`);
    lines.push(`- resolution: ${profile.resolution}`);
    if (profile.sampling) {
      lines.push(`- sampler: ${profile.sampling.samplerName}`);
      lines.push(`- guidance (cfg): ${profile.sampling.cfgScale}`);
    }
    lines.push('', 'When every file is in place, run `velatura doctor`.', '');
    await writeFile(resolve(options.out), lines.join('\n'), 'utf8');
    console.log(`  Written: ${resolve(options.out)}`);
  });

// --------------------------------------------------------------- doctor ----
program
  .command('doctor')
  .description('check the environment and report what is missing')
  .action(async () => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    const manifest = await readManifest();

    console.log('\n  Velatura doctor\n');
    console.log(`   node            ${process.version}`);
    console.log(`   platform        ${process.platform} ${process.arch}`);
    console.log(`   config          ${configPath()}${existsSync(configPath()) ? '' : ' (not created yet)'}`);
    console.log(`   Velatura log   ${velaturaLogFile()}`);
    console.log(`   SD.Next         ${root ?? 'NOT FOUND'}`);
    if (root) {
      for (const slot of ['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]) {
        const dir = slotDir(root, slot);
        console.log(`     ${slot.padEnd(14)} ${dir}${existsSync(dir) ? '' : '  (missing)'}`);
      }
    }
    console.log(`   manifest        ${resolveManifestPath() ?? 'NOT FOUND'}`);
    console.log(`   install         ${configDir()}`);
    console.log(`   profiles        ${DEFAULT_PROFILES.map((p) => p.id).join(', ')}`);
    console.log(`   manifest items  ${manifest?.models.length ?? 0}`);

    // the hardware: VRAM decides the profile (a fresh look: this is a diagnosis)
    const hardware = await detectHardware({ fresh: true });
    for (const gpu of hardware.gpus) {
      console.log(
        `   GPU             ${gpu.vendor} ${gpu.name}${gpu.vramGb ? ` · ${gpu.vramGb} GB VRAM` : ' · VRAM unknown'}`,
      );
    }
    if (!hardware.gpus.length) console.log('   GPU             not detected');
    console.log(`   memory          ${hardware.totalMemGb} GB`);

    // the profile in use and its solver
    const profiles = await readProfiles();
    const profile = profiles.find((p) => p.id === config.profileId) ?? profiles[0];
    if (profile) {
      console.log(
        `   profile         ${profile.id} · ${profile.steps} steps · ${profile.vramGb} GB VRAM · emphasis ${profile.emphasis}`,
      );
      console.log(
        `   solver          ${profile.sampling?.samplerName ?? 'Default'}` +
          (profile.sampling?.schedulersSigma ? ` · sigmas ${profile.sampling.schedulersSigma}` : ' · sigmas: the model default'),
      );
    }

    // the version of diffusers inside the SD.Next environment
    if (root) {
      const diffusers = await readDiffusersVersion(root);
      console.log(`   diffusers       ${diffusers ?? 'not found (the venv may not be created yet)'}`);
    }

    // the files of the active profile: size and checksum
    if (root && manifest && profile) {
      console.log('\n   Files of the active profile:');
      for (const item of profile.models) {
        const entry = manifest.models.find((m) => m.id === item.manifestId);
        if (!entry) continue;
        const fileName = (item.file ?? entry.file).split('/').pop()!;
        const path = join(slotDir(root, entry.dest as SdnextSlot), fileName);
        if (!existsSync(path)) {
          console.log(`     · ${fileName.padEnd(42)} not installed`);
          continue;
        }
        const verification = await verifyFile(path, { sizeBytes: entry.sizeBytes, sha256: entry.sha256 });
        console.log(
          `     ${verification.ok ? '✓' : '✗'} ${fileName.padEnd(42)} ${verification.ok ? 'verified' : verification.notes.join('; ')}`,
        );
      }
    }

    const foreign = await scanForeignInstalls(foreignInstallCandidates());
    if (foreign.length > 0) {
      console.log(`\n   Found ${foreign.length} model file(s) in other local installations:`);
      for (const hit of foreign.slice(0, 10)) {
        const scan = await scanFile(hit.path);
        const mark = scan.compatible ? '✓' : '✗';
        console.log(
          `     ${mark} ${hit.install}/${hit.fileName}  — ${scan.role}, ${scan.family ?? 'unknown family'}` +
            (scan.reasons.length ? `  (${scan.reasons[0]})` : ''),
        );
      }
    }
    console.log('');
  });

// --------------------------------------------------------------- models ----
const models = program.command('models').description('model manager');

models
  .command('list')
  .description('show the manifest and what is already installed')
  .option('-p, --profile <id>', 'only the files of this profile')
  .action(async (options: { profile?: string }) => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    const manifest = await readManifest();
    if (!manifest) {
      console.error('  No manifest found.');
      return;
    }
    const only = await profileManifestIds(options.profile);
    console.log('');
    for (const entry of manifest.models) {
      if (only && !only.includes(entry.id)) continue;
      const state = root
        ? knownFilesFor(entry).map((f) => join(slotDir(root, entry.dest), f)).find((p) => existsSync(p))
        : undefined;
      console.log(`  ${state ? '✓' : '·'} ${entry.id.padEnd(26)} ${entry.label}`);
      console.log(`      ${entry.repo}@${entry.revision.slice(0, 8)} → ${entry.dest}/${entry.file.split('/').pop()}`);
      console.log(`      licence: ${entry.license}${entry.sizeBytes ? ` · ${(entry.sizeBytes / 1e9).toFixed(2)} GB` : ''}`);
      if (state) {
        const verification = await verifyFile(state, {
          sizeBytes: entry.sizeBytes,
          sha256: entry.sha256,
        });
        console.log(`      installed: ${state} — ${verification.ok ? 'verified' : verification.notes.join('; ')}`);
      }
    }
    console.log('');
  });

models
  .command('scan')
  .description('inspect model files and tell what they are')
  .argument('[path]', 'file or folder to scan')
  .action(async (target?: string) => {
    const paths: string[] = [];
    if (target) paths.push(resolve(target));
    else {
      const config = await loadConfig();
      const root = config.sdnextRoot ?? (await findSdnextRoot());
      if (root) for (const slot of ['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]) {
        paths.push(slotDir(root, slot));
      }
      paths.push(...foreignInstallCandidates().map((c) => c.root));
    }
    const show = async (path: string) => {
      const scan = await scanFile(path);
      console.log(
        `  ${scan.compatible ? '✓' : '✗'} ${scan.role.padEnd(13)} ${scan.family ?? '—'} ${scan.quant ?? '—'}  ${path}`,
      );
      if (scan.variant) console.log(`      variant: ${scan.variant}`);
      if (scan.hasVision) console.log('      it carries the vision tower (editing will work)');
      for (const reason of scan.reasons) console.log(`      ! ${reason}`);
    };

    for (const p of paths) {
      if (!existsSync(p)) continue;
      // a single file is scanned directly; a folder is walked
      if (statSync(p).isFile()) {
        await show(p);
        continue;
      }
      const hits = await scanForeignInstalls([{ label: p, root: p }]);
      for (const hit of hits) await show(hit.path);
    }
  });

models
  .command('import')
  .description('place existing model files into the right SD.Next folder')
  .argument('[path]', 'the file to place')
  .option('--from <folder>', 'a folder: every model file inside it is placed')
  .option('-p, --profile <id>', 'only the files of this profile')
  .option('--slot <slot>', 'UNET | Text-encoder | VAE | Lora')
  .option('--mode <mode>', 'copy | hardlink | symlink | in-place', 'hardlink')
  .action(
    async (
      path: string | undefined,
      options: { from?: string; profile?: string; slot?: SdnextSlot; mode: PlacementMode },
    ) => {
      const config = await loadConfig();
      const root = config.sdnextRoot ?? (await findSdnextRoot());
      if (!root) {
        console.error('  SD.Next is not configured. Run `velatura setup` first.');
        process.exitCode = 1;
        return;
      }
      const target = options.from ?? path;
      if (!target) {
        console.error('  Give a file, or a folder with --from.');
        process.exitCode = 1;
        return;
      }
      const source = resolve(target);
      if (!existsSync(source)) {
        console.error(`  ${source} does not exist.`);
        process.exitCode = 1;
        return;
      }

      const manifest = await readManifest();
      const only = await profileManifestIds(options.profile);
      const wanted = only
        ? manifest?.models.filter((m) => only.includes(m.id)).map((m) => m.file.split('/').pop()!) ?? []
        : undefined;

      // the roles the profile needs: a community quantisation with another
      // name is accepted when it plays the same role
      const roles = only
        ? (await readProfiles())
            .find((p) => p.id === options.profile)
            ?.models.map((m) => m.role) ?? []
        : [];

      // a folder: take every model file inside it
      const files: string[] = [];
      if (statSync(source).isDirectory()) {
        for (const name of await readdir(source)) {
          if (!/\.(gguf|safetensors|ckpt|pt|pth|bin|safetensor)$/i.test(name)) continue;
          const full = join(source, name);
          if (wanted) {
            const byName = wanted.some((w) => w.toLowerCase() === name.toLowerCase());
            const byRole = roles.length
              ? (await scanFile(full).catch(() => undefined))?.role !== undefined &&
                roles.includes((await scanFile(full))!.role)
              : false;
            if (!byName && !byRole) continue;
          }
          files.push(full);
        }
        if (!files.length) {
          console.error(
            wanted
              ? `  No file of the profile "${options.profile}" is in ${source}.`
              : `  No model file in ${source}.`,
          );
          process.exitCode = 1;
          return;
        }
      } else {
        files.push(source);
      }

      for (const file of files) {
        const scan = await scanFile(file);
        console.log(
          `  ${scan.name}: ${scan.role}${scan.family ? ` · ${scan.family}` : ''}${scan.quant ? ` · ${scan.quant}` : ''}`,
        );
        for (const reason of scan.reasons) console.log(`  ! ${reason}`);

        // the folder comes from the manifest, so the name decides the slot
        const entry = manifest?.models.find((m) =>
          m.file.split('/').pop()!.toLowerCase() === scan.name.toLowerCase(),
        );
        const slot =
          options.slot ??
          (entry?.dest as SdnextSlot | undefined) ??
          slotForRole(scan.role);

        const plan = await planPlacement({
          source: file,
          sdnextRoot: root,
          slot,
          mode: options.mode,
        });
        const result = await applyPlacement(plan);
        console.log(
          `  ${result.ok ? '✓' : '✗'} ${result.method} → ${result.path}${result.fallback ? ` (${result.fallback})` : ''}`,
        );
      }
    },
  );

/** The version of diffusers inside the SD.Next environment, if it is there. */

/** The SD.Next folder a role belongs to. */
function slotForRole(role: string): SdnextSlot {
  switch (role) {
    case 'text-encoder':
      return 'Text-encoder';
    case 'vae':
      return 'VAE';
    case 'lora':
      return 'Lora';
    default:
      return 'UNET';
  }
}

models
  .command('bundle')
  .description('download every file a profile needs, checking the checksum')
  .argument('[profile]', 'profile id (lowvram, full)')
  .option('--yes', 'do not ask for confirmation')
  .action(async (profileId: string | undefined, options: { yes?: boolean }) => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    if (!root) {
      console.error('  SD.Next is not configured. Run `velatura setup` first.');
      process.exitCode = 1;
      return;
    }
    const manifest = await readManifest();
    const profiles = await readProfiles();
    const profile = profiles.find((p) => p.id === (profileId ?? config.profileId));
    if (!profile || !manifest) {
      console.error('  Unknown profile or missing manifest.');
      process.exitCode = 1;
      return;
    }
    console.log(`\n  ${profile.label} — ${profile.description ?? ''}\n`);
    const licences = new Set<string>();
    for (const item of profile.models) {
      const entry = manifest.models.find((m) => m.id === item.manifestId);
      if (!entry) continue;
      licences.add(`${entry.license}${entry.licenseUrl ? ` (${entry.licenseUrl})` : ''}`);
    }
    console.log(`  Licence: ${[...licences].join(', ')}`);
    const total = profile.models.reduce((sum, item) => {
      const entry = manifest.models.find((m) => m.id === item.manifestId);
      return sum + (entry?.sizeBytes ?? 0);
    }, 0);
    console.log(`  Download size: about ${(total / 1e9).toFixed(2)} GB`);
    if (!options.yes) {
      const answer = await ask('  Download everything? (yes/no)', 'no');
      if (!/^y/i.test(answer)) {
        console.log('  Nothing was downloaded.');
        return;
      }
    }
    // the space is checked once, for the whole bundle
    const space = await checkDiskSpace(join(root, 'models', 'UNET', 'bundle'), total);
    if (!space.ok) {
      console.error(`  ${space.problem}`);
      process.exitCode = 1;
      return;
    }

    for (const item of profile.models) {
      const entry = manifest.models.find((m) => m.id === item.manifestId);
      if (!entry) continue;
      const fileName = (item.file ?? entry.file).split('/').pop()!;
      const target = join(slotDir(root, entry.dest), fileName);
      if (existsSync(target)) {
        console.log(`  = ${fileName} — already there`);
        continue;
      }
      const live = process.stdout.isTTY === true;
      if (live) process.stdout.write(`  ↓ ${fileName} … `);
      const result = await downloadFile(entry.repo, entry.revision, fileName, target, {
        mirror: config.mirror,
        token: config.hfToken,
        expectedSha256: entry.sha256,
        onProgress: (bytes, totalBytes) => {
          if (live && totalBytes) {
            process.stdout.write(
              `\r  ↓ ${fileName} — ${(bytes / 1e9).toFixed(2)} / ${(totalBytes / 1e9).toFixed(2)} GB`,
            );
          }
        },
      });
      const ok = !entry.sha256 || result.sha256.toLowerCase() === entry.sha256.toLowerCase();
      if (live) process.stdout.write('\r');
      console.log(`  ${ok ? '✓' : '✗'} ${fileName} — ${(result.bytes / 1e9).toFixed(2)} GB${ok ? '' : ' (sha256 mismatch!)'}`);
      if (!ok) process.exitCode = 1;
    }
    console.log('');
  });

models
  .command('fetch')
  .description('download one file of the manifest and check its SHA-256')
  .argument('[manifestId]', 'the id shown by `velatura models list`')
  .option('-p, --profile <id>', 'download every file of this profile')
  .option('--resume', 'continue a partial download (always on)')
  .option('--force', 'download it again even if it is already there')
  .action(async (manifestId: string | undefined, options: { profile?: string; force?: boolean }) => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    if (!root) {
      console.error('  SD.Next is not configured. Run `velatura setup` first.');
      process.exitCode = 1;
      return;
    }
    const manifest = await readManifest();
    if (!manifest) {
      console.error('  The manifest is missing.');
      process.exitCode = 1;
      return;
    }
    const only = await profileManifestIds(options.profile);
    const entries = manifestId
      ? manifest.models.filter((m) => m.id === manifestId)
      : only
        ? manifest.models.filter((m) => only.includes(m.id))
        : [];
    if (!entries.length) {
      console.error(
        `  Nothing to fetch. Give an id (\`velatura models list\`) or a profile (--profile lowvram).`,
      );
      process.exitCode = 1;
      return;
    }
    for (const entry of entries) {
      await fetchOne(entry, root, config, options.force === true);
    }
  });

/** Download one manifest entry and check its checksum. */
async function fetchOne(
  entry: { id: string; label: string; license: string; licenseUrl?: string; file: string; repo: string; revision: string; sha256?: string; sizeBytes?: number; dest: string },
  root: string,
  config: { mirror?: string; hfToken?: string },
  force: boolean,
): Promise<void> {
    const fileName = entry.file.split('/').pop()!;
    const target = join(slotDir(root, entry.dest as SdnextSlot), fileName);
    if (existsSync(target) && !force) {
      console.log(`  = ${fileName} is already there (use --force to download it again)`);
      return;
    }
    console.log(`  ${entry.label} — ${entry.license}${entry.licenseUrl ? ` (${entry.licenseUrl})` : ''}`);
    console.log(`  → ${target}`);
    // the progress is drawn only on a terminal: piped, it would be a mess
    const live = process.stdout.isTTY === true;
    if (live) process.stdout.write('  ↓ downloading');
    const result = await downloadFile(entry.repo, entry.revision, entry.file, target, {
      mirror: config.mirror,
      token: config.hfToken,
      expectedSha256: entry.sha256,
      onProgress: (bytes, total) => {
        if (live && total) {
          process.stdout.write(`\r  ↓ ${(bytes / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`);
        }
      },
    });
    if (live) process.stdout.write('\r');
    const ok = !entry.sha256 || result.sha256.toLowerCase() === entry.sha256.toLowerCase();
    console.log(`  ${ok ? '✓' : '✗'} ${fileName} — ${(result.bytes / 1e9).toFixed(2)} GB, sha256 ${result.sha256.slice(0, 16)}…`);
    if (!ok) {
      console.error(`  ! the checksum does not match the manifest (${entry.sha256})`);
      process.exitCode = 1;
    }
}

models
  .command('verify')
  .description('check the installed files: size and SHA-256')
  .argument('[manifestId]', 'check only this one')
  .option('-p, --profile <id>', 'check only the files of this profile')
  .action(async (manifestId: string | undefined, options: { profile?: string }) => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    const manifest = await readManifest();
    if (!root || !manifest) {
      console.error('  SD.Next is not configured, or the manifest is missing.');
      process.exitCode = 1;
      return;
    }
    const only = await profileManifestIds(options.profile);
    const entries = manifestId
      ? manifest.models.filter((m) => m.id === manifestId)
      : only
        ? manifest.models.filter((m) => only.includes(m.id))
        : manifest.models;
    if (entries.length === 0) {
      console.error(`  Unknown id "${manifestId}".`);
      process.exitCode = 1;
      return;
    }
    let bad = 0;
    console.log('');
    for (const entry of entries) {
      const candidates = knownFilesFor(entry).map((f) => join(slotDir(root, entry.dest), f.split('/').pop()!));
      const found = candidates.find((p) => existsSync(p));
      if (!found) {
        console.log(`  · ${entry.id.padEnd(24)} missing`);
        continue;
      }
      const result = await verifyFile(found, { sizeBytes: entry.sizeBytes, sha256: entry.sha256 });
      if (result.ok) {
        console.log(`  ✓ ${entry.id.padEnd(24)} ${(result.sizeBytes / 1e9).toFixed(2)} GB — verified`);
      } else {
        bad += 1;
        console.log(`  ✗ ${entry.id.padEnd(24)} ${found}`);
        for (const note of result.notes) console.log(`      ! ${note}`);
      }
    }
    console.log(bad === 0 ? '\n  everything that is installed is correct\n' : `\n  ${bad} file(s) are not what they should be\n`);
    if (bad > 0) process.exitCode = 1;
  });

/** The folder where the program is installed: the manifest is the anchor. */
function appFolder(): string {
  const manifest = resolveManifestPath();
  if (manifest) return dirname(dirname(manifest));
  return resolve(dirname(dirname(fileURLToPath(import.meta.url))), '..', '..');
}

program
  .command('files')
  .description('show where everything is on this machine, and delete what you want')
  .option('--clear-images', 'delete the pictures of the local store')
  .option('--clear-partials', 'delete the partial files of the interrupted downloads')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(async (options: { clearImages?: boolean; clearPartials?: boolean; yes?: boolean }) => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    const store = await imageStore(imagesDir(configDir()));

    console.log('\n  Where Velatura writes\n');
    console.log(`    program       ${appFolder()}`);
    console.log(`    settings      ${configPath()}`);
    console.log(`    history       ${join(configDir(), 'history.jsonl')}`);
    console.log(`    Velatura log  ${velaturaLogFile()}`);
    console.log(`    log folder    ${velaturaLogDirectory()}`);
    console.log(`    pictures      ${store.dir}`);
    console.log(`    engine        ${root ?? 'not configured'}`);

    console.log(`\n  Pictures: ${store.count} file(s), ${(store.totalBytes / 1e6).toFixed(1)} MB`);
    for (const image of store.images.slice(0, 20)) {
      console.log(`    ${image.path}`);
    }
    if (store.images.length > 20) console.log(`    … and ${store.images.length - 20} more`);

    if (root) {
      const dirs = (['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]).map((slot) =>
        slotDir(root, slot),
      );
      const partials = await findPartials(dirs);
      if (partials.length) {
        console.log(`\n  Interrupted downloads (${partials.length}):`);
        for (const partial of partials) {
          console.log(`    ${partial.path} — ${(partial.sizeBytes / 1e9).toFixed(2)} GB`);
        }
      }
    }

    if (options.clearImages) {
      if (!options.yes) {
        const answer = await ask('\n  Delete every picture?', 'no');
        if (!/^y/i.test(answer)) {
          console.log('  Nothing was deleted.');
          return;
        }
      }
      const cleared = await clearImages(imagesDir(configDir()));
      console.log(`  Deleted ${cleared.deleted} picture(s).`);
    }

    if (options.clearPartials && root) {
      if (!options.yes) {
        const answer = await ask('\n  Delete the interrupted downloads?', 'no');
        if (!/^y/i.test(answer)) {
          console.log('  Nothing was deleted.');
          return;
        }
      }
      const dirs = (['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]).map((slot) =>
        slotDir(root, slot),
      );
      let deleted = 0;
      for (const partial of await findPartials(dirs)) {
        await rm(partial.path, { force: true }).catch(() => undefined);
        deleted += 1;
      }
      console.log(`  Deleted ${deleted} partial file(s).`);
    }
    console.log('');
  });

program
  .command('forget')
  .description('delete what Velatura stored on this machine')
  .option('--models', 'also delete the model files it placed')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(async (options: { models?: boolean; yes?: boolean }) => {
    const config = await loadConfig();
    const root = config.sdnextRoot ?? (await findSdnextRoot());
    const manifest = await readManifest();

    console.log('\n  This will delete:');
    console.log(`    ${configPath()}`);
    console.log(`    ${join(configDir(), 'history.jsonl')}`);
    console.log(`    ${join(configDir(), 'session.json')}`);
    console.log(`    ${velaturaLogDirectory()} (the diagnostic logs)`);
    console.log(`    ${imagesDir(configDir())} (the pictures)`);
    if (options.models) {
      if (!root || !manifest) {
        console.error('  SD.Next is not configured: there is nothing to delete.');
        process.exitCode = 1;
        return;
      }
      console.log('\n  And the model files:');
      for (const entry of manifest.models) {
        for (const file of knownFilesFor(entry)) {
          const path = join(slotDir(root, entry.dest), file.split('/').pop()!);
          if (existsSync(path)) console.log(`    ${path}`);
        }
      }
    } else {
      console.log('\n  (the model files are not touched: add --models to delete them too)');
    }

    if (!options.yes) {
      const answer = await ask('\n  Delete them? (yes/no)', 'no');
      if (!/^y/i.test(answer)) {
        console.log('  Nothing was deleted.');
        return;
      }
    }

    await clearImages(imagesDir(configDir()));
    await rm(velaturaLogDirectory(), { recursive: true, force: true }).catch(() => undefined);
    for (const file of [configPath(), join(configDir(), 'history.jsonl'), join(configDir(), 'session.json')]) {
      await rm(file, { force: true }).catch(() => undefined);
    }
    if (options.models && root && manifest) {
      for (const entry of manifest.models) {
        for (const file of knownFilesFor(entry)) {
          const path = join(slotDir(root, entry.dest), file.split('/').pop()!);
          if (existsSync(path)) await rm(path, { force: true }).catch(() => undefined);
        }
      }
    }
    console.log('\n  Done. The next start will be a first start again.\n');
  });

program
  .command('history')
  .description('show the jobs of the last sessions')
  .option('-n, --limit <n>', 'how many', '20')
  .action(async (options: { limit: string }) => {
    const store = new JsonlStore<{ id: string; state: string; createdAt: string; error?: string; request?: { prompt: string } }>(
      join(dirname(configPath()), 'history.jsonl'),
    );
    const jobs = await store.read(Number(options.limit));
    if (jobs.length === 0) {
      console.log('\n  No jobs recorded yet.\n');
      return;
    }
    console.log('');
    for (const job of jobs.reverse()) {
      const prompt = (job.request?.prompt ?? '').slice(0, 60);
      console.log(`  ${job.state.padEnd(9)} ${job.createdAt}  ${prompt}${job.error ? `  ! ${job.error}` : ''}`);
    }
    console.log('');
  });

// ---------------------------------------------------------------- shell ----
program
  .command('shell')
  .description('open the optional native window (tinyjs)')
  .action(async () => {
    const root = resolve(process.cwd());
    const dist = join(root, 'apps', 'desktop', 'dist');
    if (!existsSync(dist)) {
      console.error(
        '  The native shell is not built. It is optional — `velatura serve` works with your browser.\n' +
          '  Build it with: npm run build:desktop',
      );
      process.exitCode = 1;
      return;
    }
    const child = spawn('tinyjs', ['run', dist], { stdio: 'inherit' });
    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
