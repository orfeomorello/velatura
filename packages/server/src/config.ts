/**
 * Velatura configuration — stored in the user's home, never in the repo.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PlacementMode } from '@velatura/core';

export interface VelaturaConfig {
  /** path of the SD.Next installation */
  sdnextRoot?: string;
  /** base URL of a running SD.Next (defaults to 127.0.0.1:7860) */
  sdnextUrl?: string;
  /** port of the Velatura UI */
  port: number;
  /** active hardware profile */
  profileId: string;
  /** Hugging Face mirror (HF_ENDPOINT) */
  mirror?: string;
  /** local HF token — never leaves the machine */
  hfToken?: string;
  /** how model files are placed into SD.Next */
  placementMode: PlacementMode;
  /** open the browser automatically on `velatura serve` */
  openBrowser: boolean;
  /** true once the setup wizard has been completed */
  setupCompleted?: boolean;
  /** Legacy field retained for config-file compatibility; profile adaptation is disabled. */
  adaptToInstalled?: boolean;
}

export const DEFAULT_CONFIG: VelaturaConfig = {
  port: 7865,
  profileId: 'lowvram',
  placementMode: 'hardlink',
  openBrowser: true,
};

export function configDir(): string {
  // the installer points this at the folder where Velatura lives, so that
  // an installation is a single self-contained directory
  if (process.env.VELATURA_CONFIG_DIR) return process.env.VELATURA_CONFIG_DIR;
  const home = homedir();
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'velatura') : join(home, '.velatura');
  }
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'velatura') : join(home, '.velatura');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export async function loadConfig(): Promise<VelaturaConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<VelaturaConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: VelaturaConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Read the HF token from the standard local cache, if the user has one. */
export async function readLocalHfToken(): Promise<string | undefined> {
  const home = homedir();
  const candidates = [
    process.env.HF_TOKEN,
    join(home, '.cache', 'huggingface', 'token'),
    join(home, '.huggingface', 'token'),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      const raw = (await readFile(c, 'utf8')).trim();
      if (raw) return raw;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
