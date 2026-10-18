import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

const originalConfigDir = process.env.VELATURA_CONFIG_DIR;

describe('Setup test render route', () => {
  it('returns a queued job ID immediately without waiting for SD.Next', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'velatura-setup-render-'));
    const configDir = join(temp, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ sdnextUrl: 'http://127.0.0.1:1' }));
    process.env.VELATURA_CONFIG_DIR = configDir;

    let built: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      built = await buildServer({
        sdnextRoot: join(temp, 'sdnext-not-installed'),
        token: 'setup-render-test-token',
        logFile: join(temp, 'velatura.log'),
      });
      const startedAt = Date.now();
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/v1/setup/test-render',
        headers: { 'x-velatura-token': built.token },
        payload: {},
      });
      const elapsedMs = Date.now() - startedAt;
      const body = response.json() as { jobId: string; steps: number; size: number; profile: string };

      expect(response.statusCode).toBe(200);
      expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(body).toMatchObject({ steps: 8, size: 512, profile: 'lowvram' });
      expect(elapsedMs).toBeLessThan(1000);
      expect(built.queue.get(body.jobId)?.request).toMatchObject({
        prompt: 'a small studio, soft light, 35mm',
        steps: 8,
        size: 512,
        mode: 'txt2img',
      });

      // Let the deliberately unavailable local engine fail cleanly before the
      // temporary test directory is removed; no engine or model is installed.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const state = built.queue.get(body.jobId)?.state;
        if (state === 'error' || state === 'done' || state === 'cancelled') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(built.queue.get(body.jobId)?.state).toBe('error');
    } finally {
      if (built) await built.app.close();
      if (originalConfigDir === undefined) delete process.env.VELATURA_CONFIG_DIR;
      else process.env.VELATURA_CONFIG_DIR = originalConfigDir;
      await rm(temp, { recursive: true, force: true });
    }
  });
});
