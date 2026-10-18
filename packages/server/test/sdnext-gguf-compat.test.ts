import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasQwen21GgufCompat,
  installQwen21GgufCompat,
  QWEN21_GGUF_COMPAT_SOURCE,
  qwen21GgufCompatScriptPath,
  removeQwen21GgufCompat,
} from '../src/sdnext-gguf-compat.js';

describe('Qwen-Image 2.1 GGUF compatibility helper', () => {
  it('installs idempotently into SD.Next user extensions without downloading or editing engine files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-qwen-compat-'));
    try {
      const first = await installQwen21GgufCompat(root);
      const second = await installQwen21GgufCompat(root);
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(first.scriptPath).toBe(qwen21GgufCompatScriptPath(root));
      expect(await hasQwen21GgufCompat(root)).toBe(true);
      expect(await readFile(first.scriptPath, 'utf8')).toBe(QWEN21_GGUF_COMPAT_SOURCE);
      expect(first.scriptPath).toContain(join('extensions', 'velatura-qwen21-gguf-compat', 'scripts'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an unrelated SD.Next extension script', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-qwen-compat-owned-'));
    const path = qwen21GgufCompatScriptPath(root);
    await mkdir(join(root, 'extensions', 'velatura-qwen21-gguf-compat', 'scripts'), { recursive: true });
    await writeFile(path, '# user-owned script\n');
    try {
      await expect(installQwen21GgufCompat(root)).rejects.toThrow(/will not replace an unrelated/i);
      expect(await readFile(path, 'utf8')).toBe('# user-owned script\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes only the Velatura script and leaves other extension files untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-qwen-compat-clean-'));
    try {
      const installed = await installQwen21GgufCompat(root);
      const neighbour = join(installed.directory, 'keep.txt');
      await writeFile(neighbour, 'keep');
      expect(await removeQwen21GgufCompat(root)).toBe(true);
      expect(existsSync(installed.scriptPath)).toBe(false);
      expect(await readFile(neighbour, 'utf8')).toBe('keep');
      expect(await hasQwen21GgufCompat(root)).toBe(false);
      expect(await removeQwen21GgufCompat(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('limits the patch to the Qwen 2.1 transformer and keeps GGUFLinear weights quantized', () => {
    expect(QWEN21_GGUF_COMPAT_SOURCE).toContain('QwenImage21Transformer2DModel');
    expect(QWEN21_GGUF_COMPAT_SOURCE).toContain('script_callbacks.on_model_loaded');
    expect(QWEN21_GGUF_COMPAT_SOURCE).toContain('isinstance(module, GGUFLinear)');
    expect(QWEN21_GGUF_COMPAT_SOURCE).toContain('isinstance(parameter, GGUFParameter)');
    expect(QWEN21_GGUF_COMPAT_SOURCE).toContain('dequantize_gguf_tensor(parameter)');
    expect(QWEN21_GGUF_COMPAT_SOURCE).toContain('requires_grad=False');
  });
});
