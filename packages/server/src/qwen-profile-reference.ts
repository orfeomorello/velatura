/**
 * Assemble a complete local Qwen-Image 2.1 Turbo Diffusers model directory.
 *
 * SD.Next's public `dev` branch has a native pre-quantized SDNQ loader that
 * discovers `quantization_config` in the component configs. Low therefore
 * gets a complete, pinned SDNQ snapshot; Full gets the matching BF16 Turbo
 * snapshot. No Hub snapshot downloader, base-model download, or network access
 * is used here. Weight files are only hard-linked (or copied across volumes)
 * from the profile's already-verified SD.Next component folders.
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { checkDiskSpace, verifyFile } from '@velatura/core';
import { PROCESSOR_CHAT_TEMPLATE } from './qwen-turbo-chat-template.js';
import {
  QWEN_TURBO_BF16_TEXT_ENCODER_CONFIG,
  QWEN_TURBO_TEXT_ENCODER_GENERATION_CONFIG,
  QWEN_TURBO_BF16_TRANSFORMER_CONFIG,
  QWEN_TURBO_BF16_VAE_CONFIG,
  QWEN_TURBO_MODEL_INDEX,
  QWEN_TURBO_PROCESSOR_CONFIG,
  QWEN_TURBO_SCHEDULER_CONFIG,
  QWEN_TURBO_TOKENIZER_CONFIG,
} from './qwen-turbo-reference-metadata.js';
import {
  QWEN_TURBO_SDNQ_TEXT_ENCODER_CONFIG,
  QWEN_TURBO_SDNQ_TEXT_ENCODER_GENERATION_CONFIG,
  QWEN_TURBO_SDNQ_TRANSFORMER_CONFIG,
  QWEN_TURBO_SDNQ_VAE_CONFIG,
} from './qwen-turbo-sdnq-config.js';
import { QWEN_TURBO_TOKENIZER, qwenTurboDiffusersDir, qwenTurboTokenizerPath } from './qwen-turbo-reference.js';

export type QwenTurboVariant = 'sdnq-uint4' | 'bf16';

export const QWEN_TURBO_SDNQ_BASE_NAME = 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4';
export const QWEN_TURBO_BF16_BASE_NAME = 'Velatura-Qwen-Image-2.1-Turbo-BF16';

export const QWEN_TURBO_VARIANTS = {
  'sdnq-uint4': {
    baseName: QWEN_TURBO_SDNQ_BASE_NAME,
    repo: 'OzzyGT/Qwen_Image_2_1_Turbo_sdnq_dynamic_4bit',
    revision: '05c2f7737886dff796a8c0f592383f641b73c8dd',
    label: 'Turbo SDNQ UINT4',
  },
  bf16: {
    baseName: QWEN_TURBO_BF16_BASE_NAME,
    repo: 'Comfy-Org/Qwen-Image-2.1',
    revision: 'a8342359c61979b06a8dafb1a47991fe1f30e994',
    label: 'Turbo BF16',
  },
} as const;

const MARKER_NAME = '.velatura-qwen-turbo-model.json';
const COMPONENT_LAYOUT = {
  dit: 'transformer/diffusion_pytorch_model.safetensors',
  textEncoder: 'text_encoder/model.safetensors',
  vae: 'vae/diffusion_pytorch_model.safetensors',
  tokenizer: 'processor/tokenizer.json',
} as const;

const VERIFIED_FILES = new Map<string, { fingerprint: string; sha256: string }>();

export function qwenTurboBaseName(variant: QwenTurboVariant): string {
  return QWEN_TURBO_VARIANTS[variant].baseName;
}

export function qwenTurboVariantFromBaseName(baseName: string | undefined): QwenTurboVariant | undefined {
  if (baseName === QWEN_TURBO_SDNQ_BASE_NAME) return 'sdnq-uint4';
  if (baseName === QWEN_TURBO_BF16_BASE_NAME) return 'bf16';
  return undefined;
}

export function isManagedQwenTurboBaseName(baseName: string | undefined): boolean {
  return qwenTurboVariantFromBaseName(baseName) !== undefined;
}

export function qwenTurboModelPath(dataDir: string, variant: QwenTurboVariant): string {
  return join(qwenTurboDiffusersDir(dataDir), qwenTurboBaseName(variant));
}

export interface PinnedQwenComponent {
  path: string;
  expected: { sizeBytes?: number; sha256?: string };
}

export interface PrepareQwenTurboReferenceOptions {
  dataDir: string;
  sdnextRoot?: string;
  variant: QwenTurboVariant;
  components: {
    dit: PinnedQwenComponent;
    textEncoder: PinnedQwenComponent;
    vae: PinnedQwenComponent;
  };
  /** Verified tokenizer path from getQwenTurboSupportState. */
  tokenizerPath: string;
  /** Diagnostic hook; events contain paths and byte counts, never prompts or images. */
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface PreparedQwenTurboReferenceResult {
  referenceDir: string;
  diffusersDir: string;
  baseName: string;
  variant: QwenTurboVariant;
  files: Record<'dit' | 'textEncoder' | 'vae' | 'tokenizer', string>;
  sha256: Record<'dit' | 'textEncoder' | 'vae' | 'tokenizer', string>;
  placement: Record<'dit' | 'textEncoder' | 'vae' | 'tokenizer', 'hardlink' | 'copy' | 'reused'>;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function configFiles(variant: QwenTurboVariant): Record<string, unknown> {
  const quantized = variant === 'sdnq-uint4';
  return {
    'model_index.json': QWEN_TURBO_MODEL_INDEX,
    'scheduler/scheduler_config.json': QWEN_TURBO_SCHEDULER_CONFIG,
    'processor/processor_config.json': QWEN_TURBO_PROCESSOR_CONFIG,
    'processor/tokenizer_config.json': QWEN_TURBO_TOKENIZER_CONFIG,
    'processor/chat_template.jinja': `${PROCESSOR_CHAT_TEMPLATE}\n`,
    'text_encoder/config.json': quantized ? QWEN_TURBO_SDNQ_TEXT_ENCODER_CONFIG : QWEN_TURBO_BF16_TEXT_ENCODER_CONFIG,
    'text_encoder/generation_config.json': quantized
      ? QWEN_TURBO_SDNQ_TEXT_ENCODER_GENERATION_CONFIG
      : QWEN_TURBO_TEXT_ENCODER_GENERATION_CONFIG,
    'transformer/config.json': quantized ? QWEN_TURBO_SDNQ_TRANSFORMER_CONFIG : QWEN_TURBO_BF16_TRANSFORMER_CONFIG,
    'vae/config.json': quantized ? QWEN_TURBO_SDNQ_VAE_CONFIG : QWEN_TURBO_BF16_VAE_CONFIG,
  };
}

function fingerprint(info: Awaited<ReturnType<typeof stat>>): string {
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.birthtimeMs}:${info.ino}:${info.dev}`;
}

async function rememberVerifiedFile(path: string, sha256: string): Promise<void> {
  const realPath = await realpath(path);
  const info = await stat(realPath);
  const key = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  VERIFIED_FILES.set(key, { fingerprint: fingerprint(info), sha256 });
}

async function verifyPinnedFile(
  path: string,
  expected: { sizeBytes?: number; sha256?: string },
  label: string,
  onProgress?: (bytes: number, total: number) => void,
): Promise<{ realPath: string; sizeBytes: number; sha256: string; reused: boolean }> {
  if (!expected.sha256 || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes! <= 0) {
    throw new Error(`${label} is missing its pinned size or SHA-256; Velatura will not assemble an unverified model file.`);
  }
  const realPath = await realpath(path);
  const info = await stat(realPath);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${realPath}`);
  const key = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  const currentFingerprint = fingerprint(info);
  const cached = VERIFIED_FILES.get(key);
  if (cached?.fingerprint === currentFingerprint && cached.sha256.toLowerCase() === expected.sha256.toLowerCase()) {
    return { realPath, sizeBytes: info.size, sha256: cached.sha256, reused: true };
  }
  const result = await verifyFile(realPath, expected, onProgress);
  if (!result.ok || !result.actualSha256) {
    throw new Error(`${label} failed its pinned integrity check: ${result.notes.join('; ') || 'checksum unavailable'}`);
  }
  VERIFIED_FILES.set(key, { fingerprint: currentFingerprint, sha256: result.actualSha256 });
  return { realPath, sizeBytes: result.sizeBytes, sha256: result.actualSha256, reused: false };
}

async function hardlinkOrCopy(source: string, destination: string): Promise<'hardlink' | 'copy'> {
  const resolvedSource = await realpath(source);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await link(resolvedSource, destination);
    return 'hardlink';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw error;
    const sourceInfo = await stat(resolvedSource);
    const space = await checkDiskSpace(destination, sourceInfo.size, 0.05);
    if (!space.ok) {
      throw new Error(
        `Velatura cannot create the local Qwen reference copy at ${destination}: ${space.problem ?? 'not enough free disk space'}. The installed source model has been left unchanged.`,
      );
    }
    const { copyFile } = await import('node:fs/promises');
    await copyFile(resolvedSource, destination);
    return 'copy';
  }
}

async function readMarker(referenceDir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const path = join(referenceDir, MARKER_NAME);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function markerMatches(
  marker: Record<string, unknown> | undefined,
  variant: QwenTurboVariant,
  sha256: Record<'dit' | 'textEncoder' | 'vae' | 'tokenizer', string>,
): boolean {
  const expected = QWEN_TURBO_VARIANTS[variant];
  if (
    !marker || marker.format !== 2 || marker.variant !== variant ||
    marker.repo !== expected.repo || marker.revision !== expected.revision || marker.baseName !== expected.baseName
  ) return false;
  const pinned = marker.sha256;
  if (!pinned || typeof pinned !== 'object' || Array.isArray(pinned)) return false;
  const hashes = pinned as Record<string, unknown>;
  return Object.entries(sha256).every(([role, value]) => hashes[role] === value);
}

async function existingReference(
  options: PrepareQwenTurboReferenceOptions,
  referenceDir: string,
  diffusersDir: string,
  sourceChecks: Record<'dit' | 'textEncoder' | 'vae' | 'tokenizer', { realPath: string; sizeBytes: number; sha256: string; reused: boolean }>,
): Promise<PreparedQwenTurboReferenceResult | undefined> {
  if (!existsSync(referenceDir)) return undefined;
  const marker = await readMarker(referenceDir);
  const sha256 = {
    dit: sourceChecks.dit.sha256,
    textEncoder: sourceChecks.textEncoder.sha256,
    vae: sourceChecks.vae.sha256,
    tokenizer: sourceChecks.tokenizer.sha256,
  };
  if (!markerMatches(marker, options.variant, sha256)) {
    throw new Error(
      `A folder already exists at the managed Qwen model path, but it does not match this pinned profile or its ownership marker: ${referenceDir}. Velatura will not overwrite it.`,
    );
  }
  const files = Object.fromEntries(
    Object.entries(COMPONENT_LAYOUT).map(([role, relative]) => [role, join(referenceDir, relative)]),
  ) as PreparedQwenTurboReferenceResult['files'];
  for (const role of Object.keys(files) as Array<keyof typeof files>) {
    const expected = { sizeBytes: sourceChecks[role].sizeBytes, sha256: sourceChecks[role].sha256 };
    const checked = await verifyPinnedFile(files[role], expected, `Managed ${role}`);
    if (checked.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
      throw new Error(`The managed Qwen ${role} file no longer matches the pinned profile: ${files[role]}`);
    }
  }
  const placement = { dit: 'reused', textEncoder: 'reused', vae: 'reused', tokenizer: 'reused' } as const;
  return { referenceDir, diffusersDir, baseName: qwenTurboBaseName(options.variant), variant: options.variant, files, sha256, placement };
}

async function ensureSdnextDiffusersLink(sdnextRoot: string | undefined, referenceDir: string, baseName: string): Promise<void> {
  if (!sdnextRoot) return;
  try {
    const modelsDiffusers = join(sdnextRoot, 'models', 'Diffusers');
    await mkdir(modelsDiffusers, { recursive: true });
    const linkPath = join(modelsDiffusers, baseName);
    if (!existsSync(linkPath)) {
      await symlink(referenceDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch {
    // Non-fatal: isolated session config also sets diffusers_dir
  }
}

/**
 * Provision an SD.Next-readable, self-contained Diffusers pipeline from exactly
 * the three components selected by the active profile plus the checked tokenizer.
 */
export async function prepareQwenTurboReference(
  options: PrepareQwenTurboReferenceOptions,
): Promise<PreparedQwenTurboReferenceResult> {
  const variantInfo = QWEN_TURBO_VARIANTS[options.variant];
  const diffusersDir = qwenTurboDiffusersDir(options.dataDir);
  const referenceDir = qwenTurboModelPath(options.dataDir, options.variant);
  const normalizedRoot = resolve(diffusersDir);
  const normalizedReference = resolve(referenceDir);
  const pathKey = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  const rootKey = pathKey(normalizedRoot);
  const refKey = pathKey(normalizedReference);
  if (!refKey.startsWith(`${rootKey}${process.platform === 'win32' ? '\\' : sep}`)) {
    throw new Error('The managed Qwen model path escaped Velatura app data.');
  }
  await mkdir(diffusersDir, { recursive: true });

  const checks = {
    dit: await verifyPinnedFile(options.components.dit.path, options.components.dit.expected, 'Qwen Turbo transformer', (bytes, total) => {
      options.onEvent?.({ action: 'verify-progress', role: 'dit', bytes, total });
    }),
    textEncoder: await verifyPinnedFile(options.components.textEncoder.path, options.components.textEncoder.expected, 'Qwen Turbo text encoder', (bytes, total) => {
      options.onEvent?.({ action: 'verify-progress', role: 'textEncoder', bytes, total });
    }),
    vae: await verifyPinnedFile(options.components.vae.path, options.components.vae.expected, 'Qwen Turbo VAE', (bytes, total) => {
      options.onEvent?.({ action: 'verify-progress', role: 'vae', bytes, total });
    }),
    tokenizer: await verifyPinnedFile(options.tokenizerPath, QWEN_TURBO_TOKENIZER, 'Qwen Turbo tokenizer', (bytes, total) => {
      options.onEvent?.({ action: 'verify-progress', role: 'tokenizer', bytes, total });
    }),
  };
  const sha256 = { dit: checks.dit.sha256, textEncoder: checks.textEncoder.sha256, vae: checks.vae.sha256, tokenizer: checks.tokenizer.sha256 };
  const existing = await existingReference(options, referenceDir, diffusersDir, checks);
  if (existing) {
    await ensureSdnextDiffusersLink(options.sdnextRoot, referenceDir, existing.baseName);
    options.onEvent?.({ action: 'reused', referenceDir, variant: options.variant, baseName: existing.baseName });
    return existing;
  }

  options.onEvent?.({ action: 'assembly-started', referenceDir, variant: options.variant, baseName: variantInfo.baseName });
  const stagingDir = `${referenceDir}.staging-${process.pid}-${Date.now()}`;
  await rm(stagingDir, { recursive: true, force: true });
  const placements: Record<'dit' | 'textEncoder' | 'vae' | 'tokenizer', 'hardlink' | 'copy' | 'reused'> = {
    dit: 'reused', textEncoder: 'reused', vae: 'reused', tokenizer: 'reused',
  };
  try {
    await mkdir(stagingDir, { recursive: true });
    for (const [relative, contents] of Object.entries(configFiles(options.variant))) {
      const target = join(stagingDir, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, typeof contents === 'string' ? contents : json(contents), 'utf8');
    }
    const sources = {
      dit: checks.dit.realPath,
      textEncoder: checks.textEncoder.realPath,
      vae: checks.vae.realPath,
      tokenizer: checks.tokenizer.realPath,
    };
    for (const role of Object.keys(COMPONENT_LAYOUT) as Array<keyof typeof COMPONENT_LAYOUT>) {
      const target = join(stagingDir, COMPONENT_LAYOUT[role]);
      placements[role] = await hardlinkOrCopy(sources[role], target);
      const expected = { sizeBytes: checks[role].sizeBytes, sha256: checks[role].sha256 };
      if (placements[role] === 'copy') {
        const verifiedCopy = await verifyPinnedFile(target, expected, `Copied Qwen ${role}`);
        if (verifiedCopy.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
          throw new Error(`The copied Qwen ${role} did not match the verified source file.`);
        }
      } else {
        await rememberVerifiedFile(target, expected.sha256);
      }
    }
    const markerData = {
      format: 2,
      variant: options.variant,
      baseName: variantInfo.baseName,
      repo: variantInfo.repo,
      revision: variantInfo.revision,
      sdnextTarget: 'master',
      sha256,
      sizes: {
        dit: checks.dit.sizeBytes,
        textEncoder: checks.textEncoder.sizeBytes,
        vae: checks.vae.sizeBytes,
        tokenizer: checks.tokenizer.sizeBytes,
      },
      sources,
      createdBy: 'Velatura',
    };
    await writeFile(join(stagingDir, MARKER_NAME), json(markerData), { flag: 'wx' });
    await rename(stagingDir, referenceDir);
    for (const role of Object.keys(COMPONENT_LAYOUT) as Array<keyof typeof COMPONENT_LAYOUT>) {
      await rememberVerifiedFile(join(referenceDir, COMPONENT_LAYOUT[role]), sha256[role]);
    }
    await ensureSdnextDiffusersLink(options.sdnextRoot, referenceDir, variantInfo.baseName);
    options.onEvent?.({ action: 'created', referenceDir, variant: options.variant, baseName: variantInfo.baseName, placement: placements });
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const files = Object.fromEntries(
    Object.entries(COMPONENT_LAYOUT).map(([role, relative]) => [role, join(referenceDir, relative)]),
  ) as PreparedQwenTurboReferenceResult['files'];
  return { referenceDir, diffusersDir, baseName: variantInfo.baseName, variant: options.variant, files, sha256, placement: placements };
}

/** True only for an owned, correctly indexed managed Qwen Turbo reference. */
export async function hasManagedQwenTurboReference(dataDir: string, variant: QwenTurboVariant): Promise<boolean> {
  const referenceDir = qwenTurboModelPath(dataDir, variant);
  const marker = await readMarker(referenceDir);
  const hashes = marker?.sha256;
  const hashRecord = hashes && typeof hashes === 'object' && !Array.isArray(hashes)
    ? hashes as Record<string, unknown>
    : undefined;
  const hasPinnedHashes = ['dit', 'textEncoder', 'vae', 'tokenizer'].every((role) =>
    typeof hashRecord?.[role] === 'string' && /^[a-f0-9]{64}$/i.test(hashRecord[role] as string),
  );
  if (
    !marker || marker.format !== 2 || marker.variant !== variant || marker.createdBy !== 'Velatura' ||
    !hashRecord || !hasPinnedHashes ||
    !markerMatches(marker, variant, hashRecord as Record<'dit' | 'textEncoder' | 'vae' | 'tokenizer', string>)
  ) return false;
  try {
    const modelIndex = JSON.parse(await readFile(join(referenceDir, 'model_index.json'), 'utf8')) as Record<string, unknown>;
    if (modelIndex._class_name !== 'QwenImage21Pipeline') return false;
    if (JSON.stringify(modelIndex.sample_sigmas) !== JSON.stringify([1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568])) return false;
    const sizes = marker.sizes && typeof marker.sizes === 'object' && !Array.isArray(marker.sizes)
      ? marker.sizes as Record<string, unknown>
      : {};
    for (const [role, relative] of Object.entries(COMPONENT_LAYOUT)) {
      const info = await stat(join(referenceDir, relative));
      if (!info.isFile() || info.size !== sizes[role]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove only the two managed reference folders, after verifying their ownership markers. */
export async function removeManagedQwenTurboReferences(dataDir: string): Promise<string[]> {
  const deleted: string[] = [];
  for (const variant of Object.keys(QWEN_TURBO_VARIANTS) as QwenTurboVariant[]) {
    const path = qwenTurboModelPath(dataDir, variant);
    const marker = await readMarker(path);
    if (!marker || marker.format !== 2 || marker.variant !== variant || marker.createdBy !== 'Velatura') continue;
    await rm(path, { recursive: true, force: true });
    deleted.push(path);
  }
  return deleted;
}

/** Exposed for tests: a short stable id for a set of pinned component hashes. */
export function qwenTurboReferenceFingerprint(sha256: Record<string, string>): string {
  const stable = Object.keys(sha256).sort().map((key) => `${key}:${sha256[key]}`).join('\n');
  return createHash('sha256').update(stable).digest('hex');
}

/** Basename used when describing a model component in logs and diagnostics. */
export function qwenComponentFileName(path: string): string {
  return basename(path);
}
