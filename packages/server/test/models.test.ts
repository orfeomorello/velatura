import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSafetensors } from '../../core/test/fixtures.js';
import { GGUF_PACKAGE } from '../src/gguf-support.js';
import { buildServer } from '../src/index.js';

const originalConfigDir = process.env.VELATURA_CONFIG_DIR;
const configDirs: string[] = [];

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.VELATURA_CONFIG_DIR;
  else process.env.VELATURA_CONFIG_DIR = originalConfigDir;
  await Promise.all(configDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function testServer() {
  const dir = await mkdtemp(join(tmpdir(), 'velatura-model-routes-'));
  configDirs.push(dir);
  process.env.VELATURA_CONFIG_DIR = join(dir, 'config');
  const root = join(dir, 'sdnext');
  const built = await buildServer({ sdnextRoot: root, token: 'model-route-test-token' });
  return { built, root };
}

describe('profile-aware model routes', () => {
  it('exposes the rotating Velatura diagnostic log path', async () => {
    const { built } = await testServer();
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/v1/paths',
      headers: { 'x-velatura-token': built.token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().install).toMatchObject({
      logs: dirname(built.logFile),
      logFile: built.logFile,
    });
    await built.app.close();
    const logText = await readFile(built.logFile, 'utf8');
    expect(logText).toContain('server.initialized');
  });

  it('removes and disables diagnostic logging when the user forgets Velatura data', async () => {
    const { built } = await testServer();
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/v1/forget',
      headers: { 'x-velatura-token': built.token },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toContain(built.logFile);
    await built.app.close();
    expect(await stat(built.logFile).then(() => true, () => false)).toBe(false);
  });

  it('does not require GGUF support for either pinned Turbo profile', async () => {
    const { built } = await testServer();
    try {
      const status = await built.app.inject({
        method: 'GET',
        url: '/api/v1/sdnext/gguf-support',
        headers: { 'x-velatura-token': built.token },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ required: false, status: 'not-required' });

      const install = await built.app.inject({
        method: 'POST',
        url: '/api/v1/sdnext/gguf/install',
        headers: { 'x-velatura-token': built.token },
        payload: { consent: true },
      });
      expect(install.json().error).toContain('does not require GGUF support');
      expect(existsSync(join(process.env.VELATURA_CONFIG_DIR!, 'packages', GGUF_PACKAGE.filename))).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('removes the cached GGUF support wheel when Velatura data is forgotten', async () => {
    const { built } = await testServer();
    const wheelPath = join(process.env.VELATURA_CONFIG_DIR!, 'packages', GGUF_PACKAGE.filename);
    try {
      await mkdir(join(process.env.VELATURA_CONFIG_DIR!, 'packages'), { recursive: true });
      await writeFile(wheelPath, 'test fixture only');
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/v1/forget',
        headers: { 'x-velatura-token': built.token },
        payload: {},
      });
      expect(response.json().deleted).toContain(wheelPath);
      expect(existsSync(wheelPath)).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('checks the selected model at its expected SD.Next destination', async () => {
    const { built, root } = await testServer();
    try {
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/v1/models/check-placement',
        headers: { 'x-velatura-token': built.token },
        payload: { manifestId: 'dit-turbo-sdnq-uint4', profileId: 'lowvram' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'missing',
        expectedFile: 'diffusion_pytorch_model.safetensors',
        targetPath: join(root, 'models', 'UNET', 'diffusion_pytorch_model.safetensors'),
      });
    } finally {
      await built.app.close();
    }
  });

  it('finds and reports a compatible file already in the expected folder', async () => {
    const { built, root } = await testServer();
    try {
      const expected = join(root, 'models', 'UNET', 'diffusion_pytorch_model.safetensors');
      await mkdir(join(root, 'models', 'UNET'), { recursive: true });
      await writeFile(expected, buildSafetensors());
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/v1/models/check-placement',
        headers: { 'x-velatura-token': built.token },
        payload: { manifestId: 'dit-turbo-sdnq-uint4', profileId: 'lowvram' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'installed', installedPath: expected, targetPath: expected });
    } finally {
      await built.app.close();
    }
  });

  it('uses the pinned BF16 transformer for the Full profile', async () => {
    const { built, root } = await testServer();
    try {
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/v1/models/check-placement',
        headers: { 'x-velatura-token': built.token },
        payload: { manifestId: 'dit-turbo-bf16', profileId: 'full' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'missing',
        expectedFile: 'qwen_image_2.1_turbo_bf16.safetensors',
        targetPath: join(root, 'models', 'UNET', 'qwen_image_2.1_turbo_bf16.safetensors'),
      });
    } finally {
      await built.app.close();
    }
  });

  it('verifies only files selected by the active profile, not every manifest variant', async () => {
    const { built } = await testServer();
    try {
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/v1/setup/verify',
        headers: { 'x-velatura-token': built.token },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      const report = response.json().report as Array<{ id: string; status: string; required: boolean }>;
      expect(report.map((item) => item.id)).toEqual([
        'dit-turbo-sdnq-uint4',
        'te-qwen3vl-sdnq-dynamic-int4',
        'vae-2.1-sdnq',
        'lora-lightning-4step',
      ]);
      expect(report.every((item) => item.status === 'missing')).toBe(true);
      expect(report.at(-1)?.required).toBe(false);
    } finally {
      await built.app.close();
    }
  });
});
