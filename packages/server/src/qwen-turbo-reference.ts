/**
 * Pinned Qwen Turbo support metadata and local-path discovery.
 *
 * This module never downloads weights. The only separately managed support
 * asset is the tokenizer JSON; callers must request it after showing its
 * Qwen Research licence and SHA-256. Full local Diffusers snapshots are built
 * by qwen-profile-reference.ts from the selected, verified profile files.
 */
import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { verifyFile } from '@velatura/core';

export const QWEN_TURBO_MODEL_NAME = 'Qwen-Image-2.1-Turbo';
export const QWEN_TURBO_REPO = 'Qwen/Qwen-Image-2.1-Turbo';
export const QWEN_TURBO_REVISION = 'fc13ba1986fcb905854dc8de2f52eee395f49b5b';
export const QWEN_TURBO_SAMPLE_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568] as const;

export const QWEN_TURBO_TOKENIZER = {
  id: 'qwen-turbo-processor-tokenizer',
  repo: QWEN_TURBO_REPO,
  revision: QWEN_TURBO_REVISION,
  file: 'processor/tokenizer.json',
  sizeBytes: 11_422_650,
  sha256: 'be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506',
  license: 'qwen-research',
  licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/LICENSE',
} as const;

const SUPPORT_RELATIVE_PATH = join('processor', 'tokenizer.json');
const HUB_REPO_DIR = 'models--Qwen--Qwen-Image-2.1-Turbo';

export function qwenTurboDiffusersDir(dataDir: string): string {
  return resolve(dataDir, 'qwen21-turbo', 'diffusers');
}

/** Private Hugging Face cache used by SD.Next in the Velatura-managed session. */
export function qwenTurboHfCacheDir(dataDir: string): string {
  return resolve(dataDir, 'qwen21-turbo', 'hf-cache');
}

export function qwenTurboTokenizerPath(dataDir: string): string {
  return resolve(dataDir, 'qwen21-turbo', 'support', SUPPORT_RELATIVE_PATH);
}

export interface QwenTurboSupportState {
  ready: boolean;
  status: 'ready' | 'missing' | 'checksum-mismatch';
  id: string;
  label: string;
  repo: string;
  revision: string;
  file: string;
  sizeBytes: number;
  sha256: string;
  license: string;
  licenseUrl: string;
  path?: string;
  source?: string;
  partialBytes?: number;
  actualSha256?: string;
}

function hubCacheCandidates(roots: string[]): string[] {
  const out: string[] = [];
  const hubRoots = new Set<string>([
    ...roots,
    process.env.HF_HOME ?? '',
    process.env.HUGGINGFACE_HUB_CACHE ?? '',
    join(homedir(), '.cache', 'huggingface'),
    join(homedir(), '.cache', 'huggingface', 'hub'),
  ].filter(Boolean));
  for (const rootValue of hubRoots) {
    const root = resolve(rootValue);
    if (basename(root).toLowerCase() === HUB_REPO_DIR.toLowerCase()) {
      out.push(join(root, 'snapshots'));
      continue;
    }
    out.push(
      join(root, HUB_REPO_DIR, 'snapshots'),
      join(root, 'hub', HUB_REPO_DIR, 'snapshots'),
    );
  }
  return out;
}

async function tokenizerCandidates(dataDir: string, roots: string[]): Promise<Array<{ path: string; source: string }>> {
  const direct: Array<{ path: string; source: string }> = [
    { path: qwenTurboTokenizerPath(dataDir), source: 'Velatura support data' },
    {
      path: join(qwenTurboDiffusersDir(dataDir), 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4', SUPPORT_RELATIVE_PATH),
      source: 'Velatura-managed SDNQ profile reference',
    },
    {
      path: join(qwenTurboDiffusersDir(dataDir), 'Velatura-Qwen-Image-2.1-Turbo-BF16', SUPPORT_RELATIVE_PATH),
      source: 'Velatura-managed BF16 profile reference',
    },
  ];
  for (const root of roots) {
    direct.push(
      { path: join(root, SUPPORT_RELATIVE_PATH), source: 'existing local Qwen processor files' },
      { path: join(root, QWEN_TURBO_MODEL_NAME, SUPPORT_RELATIVE_PATH), source: 'existing local Qwen Turbo model' },
      { path: join(root, 'models', 'Diffusers', QWEN_TURBO_MODEL_NAME, SUPPORT_RELATIVE_PATH), source: 'existing SD.Next Diffusers files' },
    );
  }
  for (const snapshotsPath of hubCacheCandidates(roots)) {
    let snapshots: string[] = [];
    try {
      snapshots = await readdir(snapshotsPath);
    } catch {
      continue;
    }
    for (const snapshot of snapshots) {
      direct.push({
        path: join(snapshotsPath, snapshot, SUPPORT_RELATIVE_PATH),
        source: 'existing Hugging Face cache',
      });
    }
  }
  const deduped = new Map<string, { path: string; source: string }>();
  for (const candidate of direct) {
    const key = process.platform === 'win32' ? resolve(candidate.path).toLowerCase() : resolve(candidate.path);
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  return [...deduped.values()];
}

/** Find an already downloaded tokenizer first; every candidate is SHA-256 checked. */
export async function getQwenTurboSupportState(
  dataDir: string,
  searchRoots: string[] = [],
): Promise<QwenTurboSupportState> {
  const base = {
    id: QWEN_TURBO_TOKENIZER.id,
    label: 'Qwen Turbo tokenizer support file',
    repo: QWEN_TURBO_TOKENIZER.repo,
    revision: QWEN_TURBO_TOKENIZER.revision,
    file: QWEN_TURBO_TOKENIZER.file,
    sizeBytes: QWEN_TURBO_TOKENIZER.sizeBytes,
    sha256: QWEN_TURBO_TOKENIZER.sha256,
    license: QWEN_TURBO_TOKENIZER.license,
    licenseUrl: QWEN_TURBO_TOKENIZER.licenseUrl,
  };
  let mismatch: { path: string; sha256: string } | undefined;
  for (const candidate of await tokenizerCandidates(dataDir, searchRoots)) {
    let path: string;
    try {
      path = await realpath(candidate.path);
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    try {
      const result = await verifyFile(path, QWEN_TURBO_TOKENIZER);
      if (result.ok) return { ...base, ready: true, status: 'ready', path, source: candidate.source };
      mismatch ??= { path, sha256: result.actualSha256 ?? 'unavailable' };
    } catch {
      // A file may disappear while a cache is being cleaned; try the next candidate.
    }
  }
  let partialBytes: number | undefined;
  try {
    partialBytes = (await stat(`${qwenTurboTokenizerPath(dataDir)}.part`)).size;
  } catch {
    /* no partial file */
  }
  if (mismatch) {
    return {
      ...base,
      ready: false,
      status: 'checksum-mismatch',
      path: mismatch.path,
      actualSha256: mismatch.sha256,
      partialBytes,
    };
  }
  return { ...base, ready: false, status: 'missing', partialBytes };
}

/** Derive likely places where a user may already have the small processor file. */
export function qwenTurboSearchRoots(
  sdnextRoot?: string,
  originalDiffusersDir?: unknown,
  originalHfCacheDir?: unknown,
): string[] {
  const roots: string[] = [];
  if (sdnextRoot) {
    roots.push(
      sdnextRoot,
      join(sdnextRoot, 'models', 'Diffusers'),
      join(sdnextRoot, 'models', 'huggingface'),
      join(sdnextRoot, 'models', 'huggingface', 'hub'),
    );
  }
  for (const configuredPath of [originalDiffusersDir, originalHfCacheDir]) {
    if (typeof configuredPath === 'string' && configuredPath.trim()) {
      roots.push(isAbsolute(configuredPath) ? configuredPath : resolve(sdnextRoot ?? process.cwd(), configuredPath));
    }
  }
  if (process.env.HF_HOME) roots.push(process.env.HF_HOME);
  if (process.env.HUGGINGFACE_HUB_CACHE) roots.push(process.env.HUGGINGFACE_HUB_CACHE);
  return [...new Set(roots.map((item) => resolve(item)))];
}

/** Resolve API-listed SD.Next VAE component paths that may be relative to its root. */
export function resolveSdnextComponentPath(filename: string | undefined, sdnextRoot: string): string | undefined {
  if (!filename?.trim()) return undefined;
  const raw = filename.trim();
  const candidates = isAbsolute(raw)
    ? [resolve(raw)]
    : [resolve(sdnextRoot, raw), resolve(sdnextRoot, 'models', 'VAE', basename(raw)), resolve(sdnextRoot, 'models', 'VAE', raw)];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return undefined;
}
