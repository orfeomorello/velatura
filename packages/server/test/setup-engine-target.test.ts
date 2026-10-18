import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

const originalConfigDir = process.env.VELATURA_CONFIG_DIR;

async function withServer<T>(run: (server: Awaited<ReturnType<typeof buildServer>>, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'velatura-engine-target-api-'));
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ sdnextUrl: 'http://127.0.0.1:1' }));
  process.env.VELATURA_CONFIG_DIR = configDir;
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    server = await buildServer({
      sdnextRoot: join(root, 'sdnext'),
      token: 'setup-engine-target-test-token',
      logFile: join(root, 'velatura.log'),
    });
    return await run(server, root);
  } finally {
    if (server) await server.app.close();
    if (originalConfigDir === undefined) delete process.env.VELATURA_CONFIG_DIR;
    else process.env.VELATURA_CONFIG_DIR = originalConfigDir;
    await rm(root, { recursive: true, force: true });
  }
}

describe('Setup SD.Next install targets', () => {
  it('publishes the official SD.Next master branch target', async () => {
    await withServer(async (server) => {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/v1/setup/engine/requirements',
        headers: { 'x-velatura-token': server.token },
      });
      const body = response.json() as {
        installTargets: Array<{ id: string; label?: string; branch?: string; commit?: string }>;
      };

      expect(response.statusCode).toBe(200);
      expect(body.installTargets).toContainEqual({
        id: 'repository-default',
        label: 'SD.Next official master branch (recommended)',
        branch: 'master',
      });
      expect(body.installTargets).toHaveLength(1);
    });
  });

  it('does not treat a missing SD.Next folder as consent for dependency setup', async () => {
    await withServer(async (server, root) => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/sdnext/start',
        headers: { 'x-velatura-token': server.token },
        payload: {},
      });
      const body = response.json() as { error?: string; bootstrapConsentRequired?: boolean };

      expect(response.statusCode).toBe(200);
      expect(body.error).toContain('could not find a runnable SD.Next installation');
      expect(body.bootstrapConsentRequired).toBeUndefined();
      expect(existsSync(join(root, 'config', 'sdnext-session'))).toBe(false);
    });
  });

  it('rejects arbitrary commit targets before touching the install folder', async () => {
    await withServer(async (server, root) => {
      const destination = join(root, 'sdnext');
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/setup/engine/install',
        headers: { 'x-velatura-token': server.token },
        payload: { dir: destination, target: 'some-other-commit' },
      });
      const body = response.json() as { error?: string };

      expect(response.statusCode).toBe(200);
      expect(body.error).toMatch(/unsupported sd\.next version selection/i);
      expect(existsSync(destination)).toBe(false);
    });
  });
});
