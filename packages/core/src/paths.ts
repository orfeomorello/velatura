/**
 * Where components live, inside SD.Next and inside other installations.
 *
 * Verified against the SD.Next startup log and the "Model-Loading" wiki:
 *   Available VAEs:    path="models\VAE"
 *   Available UNets:   path="models\UNET"
 *   Available TEs:     path="models\Text-encoder"
 *   Available LoRAs:   path="models\Lora"
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { SdnextSlot } from './types.js';

export const SLOT_DIRS: Record<SdnextSlot, string> = {
  UNET: 'UNET',
  'Text-encoder': 'Text-encoder',
  VAE: 'VAE',
  Lora: 'Lora',
};

export function sdnextModelsDir(root: string): string {
  return join(root, 'models');
}

export function slotDir(root: string, slot: SdnextSlot): string {
  return join(sdnextModelsDir(root), SLOT_DIRS[slot]);
}

export function slotPath(root: string, slot: SdnextSlot, fileName: string): string {
  return join(slotDir(root, slot), fileName);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Expand a leading home marker and make a user-entered root absolute. */
export function normalizeSdnextRootPath(
  input: string,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  const value = input.trim();
  if (!value || value === '~') return home;
  if (/^~[\\/]/.test(value)) return pathApi.resolve(home, value.slice(2));
  return pathApi.resolve(value);
}

/** Default, user-writable location for a new SD.Next installation. */
export function defaultSdnextRoot(
  platform: string = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  const userHome = platform === 'win32' ? (env.USERPROFILE || home) : home;
  return pathApi.join(userHome, 'sdnext');
}

/** Candidate folders where a SD.Next checkout may live. */
export function sdnextRootCandidates(
  platform: string = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix;
  const userHome = platform === 'win32' ? (env.USERPROFILE || home) : home;
  const roots = [
    pathApi.join(userHome, 'sdnext'),
    pathApi.join(userHome, 'SD.Next'),
    pathApi.join(userHome, 'Documents', 'sdnext'),
    pathApi.join(userHome, 'Documents', 'SD.Next'),
    pathApi.join(userHome, 'Desktop', 'sdnext'),
    pathApi.join(userHome, 'AI', 'sdnext'),
  ];

  if (platform === 'win32') {
    const drive = env.SystemDrive || 'C:';
    roots.push(
      pathApi.join(drive, 'sdnext'),
      pathApi.join(drive, 'AI', 'sdnext'),
      ...(env.PUBLIC ? [pathApi.join(env.PUBLIC, 'sdnext'), pathApi.join(env.PUBLIC, 'AI', 'sdnext')] : []),
    );
  } else {
    roots.push(
      pathApi.join(userHome, 'sdnext', 'sdnext'),
      pathApi.join(userHome, 'ComfyUI', 'sdnext'),
      '/opt/sdnext',
      '/opt/SD.Next',
      '/srv/sdnext',
    );
    if (platform === 'darwin') {
      roots.push(
        pathApi.join(userHome, 'Applications', 'sdnext'),
        pathApi.join(userHome, 'Applications', 'SD.Next'),
        '/Applications/sdnext',
        '/Applications/SD.Next',
      );
    }
  }

  const seen = new Set<string>();
  return roots.filter((root) => {
    const normalized = pathApi.normalize(root);
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The entrypoint that SD.Next uses on the current operating system. */
export function sdnextLauncherName(platform: string = process.platform): string {
  return platform === 'win32' ? 'webui.bat' : 'webui.sh';
}

/** Heuristic: does this folder contain the SD.Next launcher for this OS? */
export async function looksLikeSdnext(root: string): Promise<boolean> {
  return (await exists(join(root, sdnextLauncherName()))) && (await exists(join(root, 'launch.py')));
}

/** Folders that exist and can be shown as candidates in the setup wizard. */
export async function detectSdnextRootCandidates(): Promise<Array<{ root: string; looksRight: boolean }>> {
  const out: Array<{ root: string; looksRight: boolean }> = [];
  for (const root of sdnextRootCandidates()) {
    if (!(await exists(root))) continue;
    out.push({ root, looksRight: await looksLikeSdnext(root) });
  }
  return out;
}

export async function findSdnextRoot(explicit?: string): Promise<string | undefined> {
  if (explicit) {
    return (await looksLikeSdnext(explicit)) ? explicit : undefined;
  }
  for (const candidate of sdnextRootCandidates()) {
    if (await looksLikeSdnext(candidate)) return candidate;
  }
  return undefined;
}

/** Candidate folders of other local installations we can import from. */
export function foreignInstallCandidates(): Array<{ label: string; root: string }> {
  const home = homedir();
  const roots = [
    join(home, 'ComfyUI'),
    join(home, 'Documents', 'ComfyUI'),
    join(home, 'Desktop', 'ComfyUI'),
    join(home, 'comfyui'),
    join(home, 'AI', 'ComfyUI'),
    'C:\\ComfyUI',
    'C:\\AI\\ComfyUI',
    join(home, 'forge'),
    join(home, 'stable-diffusion-webui'),
  ];
  return roots.map((root) => ({ label: root.split(/[\\/]/).pop() ?? root, root }));
}

/** Sub-folders of a ComfyUI-like install that may hold our components. */
export const FOREIGN_SLOT_DIRS: Record<SdnextSlot, string[]> = {
  UNET: ['diffusion_models', 'unet', 'checkpoints'],
  'Text-encoder': ['text_encoders', 'clip', 'text_encoder'],
  VAE: ['vae'],
  Lora: ['loras', 'lora'],
};

export interface ForeignHit {
  install: string;
  path: string;
  fileName: string;
  sizeBytes: number;
}

export async function scanForeignInstalls(
  roots: Array<{ label: string; root: string }>,
  extensions = ['.gguf', '.safetensors'],
): Promise<ForeignHit[]> {
  const hits: ForeignHit[] = [];
  for (const { label, root } of roots) {
    const modelsDir = join(root, 'models');
    if (!(await exists(modelsDir))) continue;
    for (const dirs of Object.values(FOREIGN_SLOT_DIRS)) {
      for (const dir of dirs) {
        const full = join(modelsDir, dir);
        if (!(await exists(full))) continue;
        let entries: string[] = [];
        try {
          entries = await readdir(full);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!extensions.some((ext) => entry.toLowerCase().endsWith(ext))) continue;
          const p = join(full, entry);
          try {
            const st = await stat(p);
            if (!st.isFile()) continue;
            hits.push({ install: label, path: p, fileName: entry, sizeBytes: st.size });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return hits;
}

/** Read SD.Next's own config.json, when present, to honour custom paths. */
export async function readSdnextConfig(root: string): Promise<Record<string, unknown>> {
  const candidates = [join(root, 'config.json'), join(root, 'user', 'config.json')];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {};
}
