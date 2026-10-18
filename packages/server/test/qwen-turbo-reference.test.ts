import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@velatura/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@velatura/core')>();
  return {
    ...actual,
    verifyFile: vi.fn(async (path: string, expected: { sizeBytes?: number; sha256?: string }, onProgress?: (bytes: number, total: number) => void) => {
      // Keep the fixed upstream tokenizer hash out of this unit test's 11.4 MB fixture.
      if (expected.sha256 === 'be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506') {
        onProgress?.(expected.sizeBytes ?? 11_422_650, expected.sizeBytes ?? 11_422_650);
        return {
          path,
          sizeBytes: expected.sizeBytes ?? 11_422_650,
          expectedSizeBytes: expected.sizeBytes,
          sizeOk: true,
          expectedSha256: expected.sha256,
          actualSha256: expected.sha256,
          shaOk: true,
          ok: true,
          notes: [],
        };
      }
      return actual.verifyFile(path, expected, onProgress);
    }),
  };
});

import {
  QWEN_TURBO_MODEL_NAME,
  QWEN_TURBO_SAMPLE_SIGMAS,
  QWEN_TURBO_TOKENIZER,
  getQwenTurboSupportState,
  qwenTurboDiffusersDir,
  qwenTurboHfCacheDir,
  qwenTurboSearchRoots,
  qwenTurboTokenizerPath,
} from '../src/qwen-turbo-reference.js';
import {
  QWEN_TURBO_VARIANTS,
  hasManagedQwenTurboReference,
  prepareQwenTurboReference,
  qwenTurboModelPath,
  qwenTurboReferenceFingerprint,
  removeManagedQwenTurboReferences,
} from '../src/qwen-profile-reference.js';

async function fixture(dataDir: string, variant: 'sdnq-uint4' | 'bf16') {
  const root = join(dataDir, 'sdnext');
  const names = variant === 'sdnq-uint4'
    ? {
        dit: ['models', 'UNET', 'diffusion_pytorch_model.safetensors'],
        textEncoder: ['models', 'Text-encoder', 'model.safetensors'],
        vae: ['models', 'VAE', 'diffusion_pytorch_model.safetensors'],
      }
    : {
        dit: ['models', 'UNET', 'qwen_image_2.1_turbo_bf16.safetensors'],
        textEncoder: ['models', 'Text-encoder', 'qwen3vl_8b_bf16.safetensors'],
        vae: ['models', 'VAE', 'qwen_image_2.1_vae_bf16.safetensors'],
      };
  const components = {} as Record<'dit' | 'textEncoder' | 'vae', { path: string; expected: { sizeBytes: number; sha256: string } }>;
  for (const role of ['dit', 'textEncoder', 'vae'] as const) {
    const path = join(root, ...names[role]);
    await mkdir(join(path, '..'), { recursive: true });
    const bytes = Buffer.from(`${variant}:${role}:test-only component`);
    await writeFile(path, bytes);
    components[role] = {
      path,
      expected: {
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  }
  const tokenizerPath = join(dataDir, 'test-tokenizer.json');
  // The hash is mocked, but managed-reference validation still checks the pinned byte size.
  await writeFile(tokenizerPath, Buffer.alloc(QWEN_TURBO_TOKENIZER.sizeBytes));
  return { components, tokenizerPath };
}

describe('Qwen Turbo pinned metadata and local reference builder', () => {
  it('pins the official eight-step Turbo schedule and tokenizer identity', () => {
    expect(QWEN_TURBO_MODEL_NAME).toBe('Qwen-Image-2.1-Turbo');
    expect(QWEN_TURBO_SAMPLE_SIGMAS).toEqual([
      1.0,
      0.978453,
      0.95418,
      0.926626,
      0.89508,
      0.845148,
      0.704534,
      0.414568,
    ]);
    expect(QWEN_TURBO_TOKENIZER).toMatchObject({
      repo: 'Qwen/Qwen-Image-2.1-Turbo',
      revision: 'fc13ba1986fcb905854dc8de2f52eee395f49b5b',
      file: 'processor/tokenizer.json',
      sizeBytes: 11_422_650,
      sha256: 'be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506',
      license: 'qwen-research',
    });
    expect(QWEN_TURBO_VARIANTS['sdnq-uint4']).toMatchObject({
      baseName: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
      revision: '05c2f7737886dff796a8c0f592383f641b73c8dd',
    });
    expect(QWEN_TURBO_VARIANTS.bf16).toMatchObject({
      baseName: 'Velatura-Qwen-Image-2.1-Turbo-BF16',
      revision: 'a8342359c61979b06a8dafb1a47991fe1f30e994',
    });
  });

  it('keeps tokenizer support and profile references under Velatura data', () => {
    const dataDir = join(tmpdir(), 'velatura-data');
    expect(qwenTurboDiffusersDir(dataDir)).toBe(join(dataDir, 'qwen21-turbo', 'diffusers'));
    expect(qwenTurboHfCacheDir(dataDir)).toBe(join(dataDir, 'qwen21-turbo', 'hf-cache'));
    expect(qwenTurboModelPath(dataDir, 'sdnq-uint4')).toBe(
      join(dataDir, 'qwen21-turbo', 'diffusers', 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4'),
    );
    expect(qwenTurboModelPath(dataDir, 'bf16')).toBe(
      join(dataDir, 'qwen21-turbo', 'diffusers', 'Velatura-Qwen-Image-2.1-Turbo-BF16'),
    );
    expect(qwenTurboTokenizerPath(dataDir)).toBe(
      join(dataDir, 'qwen21-turbo', 'support', 'processor', 'tokenizer.json'),
    );
  });

  it('reports the pinned tokenizer support file as missing without downloading it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'velatura-qwen-support-'));
    try {
      const state = await getQwenTurboSupportState(dataDir, []);
      expect(state).toMatchObject({
        ready: false,
        status: 'missing',
        sizeBytes: 11_422_650,
        sha256: QWEN_TURBO_TOKENIZER.sha256,
        license: 'qwen-research',
      });
      expect(state.path).toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('normalizes local search roots and includes the original SD.Next hfcache_dir', () => {
    const base = join(tmpdir(), 'sdnext-search-root');
    const roots = qwenTurboSearchRoots(base, 'models/Custom-Diffusers', 'models/huggingface');
    expect(roots).toContain(base);
    expect(roots).toContain(join(base, 'models', 'Diffusers'));
    expect(roots).toContain(join(base, 'models', 'huggingface'));
    expect(roots).toContain(join(base, 'models', 'Custom-Diffusers'));
  });

  it('assembles the complete Low SDNQ reference and reuses it after hash verification', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'velatura-qwen-low-'));
    try {
      const { components, tokenizerPath } = await fixture(dataDir, 'sdnq-uint4');
      const first = await prepareQwenTurboReference({
        dataDir,
        variant: 'sdnq-uint4',
        components,
        tokenizerPath,
      });
      expect(first.baseName).toBe('Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4');
      expect(first.sha256.dit).toBe(components.dit.expected.sha256);
      expect(first.files.tokenizer).toBe(join(first.referenceDir, 'processor', 'tokenizer.json'));
      expect(await hasManagedQwenTurboReference(dataDir, 'sdnq-uint4')).toBe(true);

      const modelIndex = JSON.parse(await readFile(join(first.referenceDir, 'model_index.json'), 'utf8')) as Record<string, unknown>;
      expect(modelIndex._class_name).toBe('QwenImage21Pipeline');
      expect(modelIndex.sample_sigmas).toEqual([...QWEN_TURBO_SAMPLE_SIGMAS]);
      const transformer = JSON.parse(await readFile(join(first.referenceDir, 'transformer', 'config.json'), 'utf8')) as Record<string, unknown>;
      expect(transformer).toHaveProperty('quantization_config');

      const second = await prepareQwenTurboReference({
        dataDir,
        variant: 'sdnq-uint4',
        components,
        tokenizerPath,
      });
      expect(second.placement).toEqual({ dit: 'reused', textEncoder: 'reused', vae: 'reused', tokenizer: 'reused' });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('assembles the Full BF16 reference from its own three pinned components', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'velatura-qwen-full-'));
    try {
      const { components, tokenizerPath } = await fixture(dataDir, 'bf16');
      const result = await prepareQwenTurboReference({ dataDir, variant: 'bf16', components, tokenizerPath });
      expect(result.baseName).toBe('Velatura-Qwen-Image-2.1-Turbo-BF16');
      const transformer = JSON.parse(await readFile(join(result.referenceDir, 'transformer', 'config.json'), 'utf8')) as Record<string, unknown>;
      expect(transformer).not.toHaveProperty('quantization_config');
      expect(await hasManagedQwenTurboReference(dataDir, 'bf16')).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses unpinned source files and does not overwrite an unowned model folder', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'velatura-qwen-safety-'));
    try {
      const { components, tokenizerPath } = await fixture(dataDir, 'sdnq-uint4');
      await expect(prepareQwenTurboReference({
        dataDir,
        variant: 'sdnq-uint4',
        components: { ...components, dit: { ...components.dit, expected: { ...components.dit.expected, sha256: '0'.repeat(64) } } },
        tokenizerPath,
      })).rejects.toThrow(/integrity check/i);

      const referenceDir = qwenTurboModelPath(dataDir, 'sdnq-uint4');
      await mkdir(referenceDir, { recursive: true });
      await writeFile(join(referenceDir, 'keep.txt'), 'user data', 'utf8');
      await expect(prepareQwenTurboReference({ dataDir, variant: 'sdnq-uint4', components, tokenizerPath }))
        .rejects.toThrow(/will not overwrite/i);
      expect(await readFile(join(referenceDir, 'keep.txt'), 'utf8')).toBe('user data');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('removes only references carrying Velatura ownership markers', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'velatura-qwen-forget-'));
    try {
      const { components, tokenizerPath } = await fixture(dataDir, 'sdnq-uint4');
      await prepareQwenTurboReference({ dataDir, variant: 'sdnq-uint4', components, tokenizerPath });
      const unowned = qwenTurboModelPath(dataDir, 'bf16');
      await mkdir(unowned, { recursive: true });
      await writeFile(join(unowned, 'keep.txt'), 'user data', 'utf8');
      const deleted = await removeManagedQwenTurboReferences(dataDir);
      expect(deleted).toEqual([qwenTurboModelPath(dataDir, 'sdnq-uint4')]);
      expect(await readFile(join(unowned, 'keep.txt'), 'utf8')).toBe('user data');
      expect(await hasManagedQwenTurboReference(dataDir, 'sdnq-uint4')).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('makes a stable fingerprint independent of object insertion order', () => {
    expect(qwenTurboReferenceFingerprint({ dit: 'a', vae: 'b' })).toBe(
      qwenTurboReferenceFingerprint({ vae: 'b', dit: 'a' }),
    );
  });
});
