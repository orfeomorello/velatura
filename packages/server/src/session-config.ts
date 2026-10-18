/**
 * Isolate SD.Next's config file for a Velatura-managed session.
 *
 * SD.Next may save options as part of a checkpoint load, even when the values
 * arrived in a per-generation override. A private copy keeps those in-memory
 * model selections out of the user's saved defaults. On an explicit Velatura
 * stop, non-model settings from the session are merged back while model/runtime
 * keys are restored to their original values.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const SESSION_ONLY_KEYS = [
  'sd_model_checkpoint',
  'sd_model_refiner',
  'sd_checkpoint_hash',
  'diffusers_pipeline',
  'sd_unet',
  'sd_unet_secondary',
  'sd_text_encoder',
  'te_shared_te',
  'sd_vae',
  'diffusers_dir',
  'hfcache_dir',
  'offline_mode',
  'sd_checkpoint_autoload',
  'sd_checkpoint_autodownload',
  'sdnq_quantize_weights',
] as const;

export interface IsolatedSdnextConfig {
  sourcePath: string;
  sessionPath: string;
  sessionDirectory: string;
  originalHash: string;
  originalConfig: Record<string, unknown>;
  originalMode?: number;
}

export interface PreparedSdnextConfig {
  args: string[];
  isolation: IsolatedSdnextConfig;
}

export type RestoreSessionConfigResult =
  | { status: 'restored'; path: string }
  | { status: 'concurrent-change'; path: string }
  | { status: 'skipped'; path: string; reason: string };

function digest(value: Buffer | undefined): string {
  const hash = createHash('sha256');
  if (value === undefined) hash.update('velatura:missing-config');
  else {
    hash.update('velatura:present:');
    hash.update(value);
  }
  return hash.digest('hex');
}

function readConfigArgument(args: string[], root: string): { sourcePath: string; remainingArgs: string[] } {
  let configValue: string | undefined;
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--config') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('SD.Next --config must be followed by a configuration file path.');
      configValue = value;
      index += 1;
    } else if (arg.startsWith('--config=')) {
      configValue = arg.slice('--config='.length);
      if (!configValue) throw new Error('SD.Next --config must be followed by a configuration file path.');
    } else {
      remainingArgs.push(arg);
    }
  }
  return {
    sourcePath: configValue
      ? isAbsolute(configValue) ? resolve(configValue) : resolve(root, configValue)
      : resolve(root, 'config.json'),
    remainingArgs,
  };
}

function parseConfig(raw: Buffer | undefined, path: string): Record<string, unknown> {
  if (!raw?.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Velatura cannot isolate SD.Next settings because its config file is not valid JSON: ${path} (${(error as Error).message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Velatura cannot isolate SD.Next settings because its config file is not a JSON object: ${path}`);
  }
  return value as Record<string, unknown>;
}

/** Copy the configured SD.Next settings file and point a managed process at the copy. */
export async function prepareIsolatedSdnextConfig(
  root: string,
  args: string[],
  velaturaConfigDir: string,
  sessionOverrides: Record<string, unknown> = {},
): Promise<PreparedSdnextConfig> {
  const { sourcePath, remainingArgs } = readConfigArgument(args, root);
  let originalBytes: Buffer | undefined;
  let originalMode: number | undefined;
  try {
    originalBytes = await readFile(sourcePath);
    originalMode = (await stat(sourcePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const originalConfig = parseConfig(originalBytes, sourcePath);
  for (const key of Object.keys(sessionOverrides)) {
    if (!SESSION_ONLY_KEYS.includes(key as (typeof SESSION_ONLY_KEYS)[number])) {
      throw new Error(`SD.Next session override "${key}" is not protected by the restore policy.`);
    }
  }
  const sessionDirectory = join(velaturaConfigDir, 'sdnext-session');
  await mkdir(sessionDirectory, { recursive: true });
  const sessionPath = join(sessionDirectory, `config-${randomUUID()}.json`);
  const sessionBytes = Object.keys(sessionOverrides).length
    ? Buffer.from(`${JSON.stringify({ ...originalConfig, ...sessionOverrides }, null, 2)}\n`)
    : originalBytes ?? Buffer.from('{}\n');
  await writeFile(sessionPath, sessionBytes, { flag: 'wx', mode: 0o600 });
  return {
    args: [...remainingArgs, '--config', sessionPath],
    isolation: {
      sourcePath,
      sessionPath,
      sessionDirectory,
      originalHash: digest(originalBytes),
      originalConfig,
      originalMode,
    },
  };
}

/** True when a reported SD.Next config path belongs to Velatura's isolated session folder. */
export function isVelaturaSessionConfigPath(configPath: string, velaturaConfigDir: string): boolean {
  const sessionDirectory = resolve(velaturaConfigDir, 'sdnext-session');
  const resolved = resolve(configPath);
  const prefix = `${sessionDirectory}${process.platform === 'win32' ? '\\' : '/'}`;
  const normalizedResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const normalizedPrefix = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  return normalizedResolved.startsWith(normalizedPrefix);
}

/**
 * Merge ordinary SD.Next setting changes back after an explicit stop, while
 * restoring every model/runtime selection to the values that existed before
 * Velatura started the session. If the user's original file changed meanwhile,
 * leave it untouched.
 */
export async function restoreIsolatedSdnextConfig(
  isolation: IsolatedSdnextConfig,
): Promise<RestoreSessionConfigResult> {
  let currentOriginal: Buffer | undefined;
  let originalFileMode = isolation.originalMode;
  try {
    currentOriginal = await readFile(isolation.sourcePath);
    const info = await lstat(isolation.sourcePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { status: 'skipped', path: isolation.sourcePath, reason: 'the original config is not a regular file' };
    }
    originalFileMode = info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'skipped', path: isolation.sourcePath, reason: (error as Error).message };
    }
  }
  if (digest(currentOriginal) !== isolation.originalHash) {
    return { status: 'concurrent-change', path: isolation.sourcePath };
  }

  let sessionConfig: Record<string, unknown>;
  try {
    sessionConfig = parseConfig(await readFile(isolation.sessionPath), isolation.sessionPath);
  } catch (error) {
    return { status: 'skipped', path: isolation.sourcePath, reason: (error as Error).message };
  }
  for (const key of SESSION_ONLY_KEYS) {
    if (Object.hasOwn(isolation.originalConfig, key)) sessionConfig[key] = isolation.originalConfig[key];
    else delete sessionConfig[key];
  }

  const temporaryPath = join(dirname(isolation.sourcePath), `.${basename(isolation.sourcePath)}.velatura-${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(isolation.sourcePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(sessionConfig, null, 2)}\n`, {
      flag: 'wx',
      mode: originalFileMode ?? 0o600,
    });
    await rename(temporaryPath, isolation.sourcePath);
    await rm(isolation.sessionPath, { force: true }).catch(() => undefined);
    return { status: 'restored', path: isolation.sourcePath };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return { status: 'skipped', path: isolation.sourcePath, reason: (error as Error).message };
  }
}

/** Return the configured file path reported by SD.Next, resolving relative paths against its root. */
export function resolveSdnextConfigArgument(value: unknown, root: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

/** Exposed for lifecycle cleanup when startup failed before the engine process existed. */
export async function discardIsolatedSdnextConfig(isolation: IsolatedSdnextConfig): Promise<boolean> {
  try {
    await rm(isolation.sessionPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Avoid an accidental success if the session file has been removed before launch. */
export function isolatedSdnextConfigExists(isolation: IsolatedSdnextConfig): boolean {
  return existsSync(isolation.sessionPath);
}
