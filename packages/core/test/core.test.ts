import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest, ManifestError, expectationFor, entriesForRole, findEntry, knownFilesFor } from '../src/manifest.js';
import { sha256File, verifyFile } from '../src/verify.js';
import { applyPlacement, planPlacement } from '../src/placement.js';
import { pickProfile, DEFAULT_PROFILES } from '../src/profiles.js';
import { tempDir } from './fixtures.js';

const sampleManifest = `
version: 1
models:
  - id: turbo-transformer
    role: dit
    label: Qwen Turbo transformer
    repo: example/Qwen-Turbo
    revision: "0123456789abcdef0123456789abcdef01234567"
    file: transformer/model.safetensors
    dest: UNET
    sizeBytes: 4
    sha256: aaaa
    license: qwen-research
    alternatives:
      - file: transformer/alternate.safetensors
        sizeBytes: 5
        sha256: bbbb
        note: known alternative
  - id: turbo-vae
    role: vae
    label: Qwen Turbo VAE
    repo: example/Qwen-Turbo
    revision: "0123456789abcdef0123456789abcdef01234567"
    file: vae/model.safetensors
    dest: VAE
    sizeBytes: 3
    sha256: cccc
    license: qwen-research
`;

describe('manifest', () => {
  it('parses pinned entries and preserves alternatives', () => {
    const manifest = parseManifest(sampleManifest);
    expect(manifest.version).toBe(1);
    expect(manifest.models).toHaveLength(2);
    expect(findEntry(manifest, 'turbo-transformer')?.revision).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(entriesForRole(manifest, 'vae').map((entry) => entry.id)).toEqual(['turbo-vae']);
    const transformer = manifest.models[0]!;
    expect(knownFilesFor(transformer)).toEqual([
      'transformer/model.safetensors',
      'transformer/alternate.safetensors',
    ]);
    expect(expectationFor(transformer, 'transformer/model.safetensors')).toEqual({ sizeBytes: 4, sha256: 'aaaa' });
    expect(expectationFor(transformer, 'transformer/alternate.safetensors')).toEqual({ sizeBytes: 5, sha256: 'bbbb' });
  });

  it('rejects unquoted numeric revisions instead of accepting a rounded SHA', () => {
    const unquoted = sampleManifest.replace('"0123456789abcdef0123456789abcdef01234567"', '1234567890123456789');
    expect(() => parseManifest(unquoted)).toThrow(ManifestError);
    expect(() => parseManifest(unquoted)).toThrow(/quoted string/i);
  });

  it('rejects duplicate manifest ids', () => {
    const duplicate = sampleManifest.replace('id: turbo-vae', 'id: turbo-transformer');
    expect(() => parseManifest(duplicate)).toThrow(/duplicate id/i);
  });

  it('rejects an unknown SD.Next destination slot', () => {
    const invalid = sampleManifest.replace('dest: UNET', 'dest: checkpoints');
    expect(() => parseManifest(invalid)).toThrow(/dest must be one of/i);
  });
});

describe('integrity verification', () => {
  it('computes and verifies a streaming SHA-256', async () => {
    const dir = await tempDir();
    const path = join(dir, 'model.bin');
    const data = Buffer.from('tiny pinned fixture');
    await writeFile(path, data);
    const expected = createHash('sha256').update(data).digest('hex');
    expect(await sha256File(path)).toBe(expected);
    await expect(verifyFile(path, { sizeBytes: data.length, sha256: expected })).resolves.toMatchObject({
      ok: true,
      sizeOk: true,
      shaOk: true,
      actualSha256: expected,
    });
    await expect(verifyFile(path, { sizeBytes: data.length, sha256: '0'.repeat(64) })).resolves.toMatchObject({
      ok: false,
      shaOk: false,
    });
  });
});

describe('placement', () => {
  it('hard-links a file into the requested SD.Next slot', async () => {
    const dir = await tempDir();
    const source = join(dir, 'source.safetensors');
    const root = join(dir, 'sdnext');
    await mkdir(root, { recursive: true });
    await writeFile(source, Buffer.alloc(2048, 7));
    const plan = await planPlacement({ source, sdnextRoot: root, slot: 'VAE', mode: 'hardlink' });
    const result = await applyPlacement(plan);
    expect(result.ok).toBe(true);
    expect((await stat(result.path)).size).toBe(2048);
    expect(await readFile(result.path)).toEqual(await readFile(source));
  });

  it('keeps a model in place for manual import without copying it', async () => {
    const dir = await tempDir();
    const sourceDir = join(dir, 'manual');
    await mkdir(sourceDir, { recursive: true });
    const source = join(sourceDir, 'model.gguf');
    await writeFile(source, 'manual fixture');
    const plan = await planPlacement({ source, sdnextRoot: join(dir, 'sdnext'), slot: 'UNET', mode: 'in-place' });
    expect(plan.target).toBe(source);
    expect(plan.systemPath?.slot).toBe('UNET');
  });
});

describe('pinned profiles', () => {
  it('exposes exactly Low SDNQ UINT4 and Full BF16 with the official Turbo defaults', () => {
    expect(DEFAULT_PROFILES.map((profile) => profile.id)).toEqual(['lowvram', 'full']);
    const low = DEFAULT_PROFILES[0]!;
    const full = DEFAULT_PROFILES[1]!;
    expect(low.engine).toMatchObject({
      pipeline: 'Autodetect',
      checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
    });
    expect(full.engine).toMatchObject({
      pipeline: 'Autodetect',
      checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-BF16',
    });
    expect(low.steps).toBe(8);
    expect(full.steps).toBe(8);
    expect(low.sampling.cfgScale).toBe(1);
    expect(full.sampling.cfgScale).toBe(1);
    expect(low.models.map((model) => model.manifestId)).toEqual([
      'dit-turbo-sdnq-uint4',
      'te-qwen3vl-sdnq-dynamic-int4',
      'vae-2.1-sdnq',
      'lora-lightning-4step',
    ]);
    expect(full.models.map((model) => model.manifestId)).toEqual([
      'dit-turbo-bf16',
      'te-qwen3vl-bf16',
      'vae-2.1-bf16',
    ]);
  });

  it('defaults to Low and only suggests Full when the selector hint fits', () => {
    expect(pickProfile(DEFAULT_PROFILES, 16).id).toBe('lowvram');
    expect(pickProfile(DEFAULT_PROFILES, 16, 'speed').id).toBe('lowvram');
    expect(pickProfile(DEFAULT_PROFILES, 16, 'quality').id).toBe('lowvram');
    expect(pickProfile(DEFAULT_PROFILES, 32, 'quality').id).toBe('full');
  });
});
