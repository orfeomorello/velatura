import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelState, modelStates, validateSdnextRoot } from '../src/status.js';
import { sdnextLauncherName } from '../src/paths.js';
import { detectHardware } from '../src/hardware.js';
import { parseManifest } from '../src/manifest.js';
import { buildGguf, buildSafetensors, tempDir } from './fixtures.js';

const MANIFEST = `
version: 1
models:
  - id: dit-turbo-gguf-q4
    role: dit
    label: Turbo GGUF
    repo: a/b
    revision: "abcdef1234567"
    file: qwen-image-2.1-turbo-Q4_K_M.gguf
    dest: UNET
    license: qwen-research
  - id: vae-2.1-bf16
    role: vae
    label: VAE 2.1
    repo: a/b
    revision: "abcdef1234567"
    file: qwen_image_2.1_vae_bf16.safetensors
    dest: VAE
    license: qwen-research
`;

async function fakeSdnext(): Promise<string> {
  const root = await tempDir('velatura-sdnext-');
  const launcher = sdnextLauncherName();
  await writeFile(join(root, launcher), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  await writeFile(join(root, 'launch.py'), '# SD.Next entrypoint\n');
  await mkdir(join(root, 'venv'), { recursive: true });
  for (const dir of ['UNET', 'VAE', 'Text-encoder', 'Lora']) {
    await mkdir(join(root, 'models', dir), { recursive: true });
  }
  return root;
}

describe('sdnext validation', () => {
  it('accepts a folder that looks like a SD.Next installation', async () => {
    const root = await fakeSdnext();
    const result = validateSdnextRoot(root);
    expect(result.ok).toBe(true);
    expect(result.markers).toContain(sdnextLauncherName());
    expect(result.rootExists).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('treats a fresh checkout without a models folder as usable, with a warning', async () => {
    const root = await tempDir('velatura-fresh-sdnext-');
    await writeFile(join(root, sdnextLauncherName()), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    await writeFile(join(root, 'launch.py'), '# SD.Next entrypoint\n');
    const result = validateSdnextRoot(root);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/models folder.*first run/i);
    expect(result.warnings.join(' ')).toMatch(/virtual environment.*first start/i);
  });

  it('rejects a file path instead of treating it as an installation folder', async () => {
    const parent = await tempDir('velatura-file-path-');
    const path = join(parent, 'not-a-folder');
    await writeFile(path, 'not a directory');
    const result = validateSdnextRoot(path);
    expect(result.ok).toBe(false);
    expect(result.rootExists).toBe(false);
    expect(result.problems.join(' ')).toMatch(/not a folder/i);
  });

  it('rejects a launcher-only folder without the SD.Next entrypoint', async () => {
    const root = await tempDir('velatura-launcher-only-');
    await writeFile(join(root, sdnextLauncherName()), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    const result = validateSdnextRoot(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/launch.py/i);
  });

  it('rejects an empty folder and explains why', async () => {
    const root = await tempDir('velatura-empty-');
    const result = validateSdnextRoot(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/webui/i);
  });
});

describe('model state', () => {
  it('reports a missing component', async () => {
    const root = await fakeSdnext();
    const manifest = parseManifest(MANIFEST);
    const state = await modelState(root, manifest.models[0]!);
    expect(state.status).toBe('missing');
    expect(state.targetPath).toBe(join(root, 'models', 'UNET', 'qwen-image-2.1-turbo-Q4_K_M.gguf'));
  });

  it('recognises an installed component by reading it', async () => {
    const root = await fakeSdnext();
    await writeFile(
      join(root, 'models', 'UNET', 'qwen-image-2.1-turbo-Q4_K_M.gguf'),
      buildGguf({ architecture: 'qwen_image', name: 'Qwen-Image-2.1-Turbo' }),
    );
    const manifest = parseManifest(MANIFEST);
    const state = await modelState(root, manifest.models[0]!);
    expect(state.status).toBe('installed');
    expect(state.scan?.family).toBe('qwen-image-2.1');
  });

  it('flags a file of the same role that is not the one we need', async () => {
    const root = await fakeSdnext();
    // the 1.x VAE, sitting where the 2.1 one should be
    await writeFile(
      join(root, 'models', 'VAE', 'qwen_image_vae.safetensors'),
      buildSafetensors({
        tensors: { 'vae.post_quant_conv.weight': { dtype: 'BF16', shape: [1, 1, 1, 1] } },
      }),
    );
    const manifest = parseManifest(MANIFEST);
    const state = await modelState(root, manifest.models[1]!);
    expect(state.status).toBe('missing');
    expect(state.conflicts.length).toBe(1);
    expect(state.conflicts[0]!.reasons.join(' ')).toMatch(/not interchangeable/i);
  });

  it('computes the state of every entry', async () => {
    const root = await fakeSdnext();
    const manifest = parseManifest(MANIFEST);
    const states = await modelStates(root, manifest.models);
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.status === 'missing')).toBe(true);
  });
});

describe('hardware detection', () => {
  it('always reports the basics, and never invents a GPU', async () => {
    const hw = await detectHardware();
    expect(hw.platform).toBe(process.platform);
    expect(hw.cpuModel.length).toBeGreaterThan(0);
    expect(hw.totalMemGb).toBeGreaterThan(0);
    if (hw.gpus.length === 0) {
      expect(hw.notes.join(' ')).toMatch(/GPU/i);
      expect(hw.vramGb).toBeUndefined();
    }
  });
});
