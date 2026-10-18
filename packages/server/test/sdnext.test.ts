import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sdnextLauncherName } from '@velatura/core';
import { discardIsolatedSdnextConfig, prepareIsolatedSdnextConfig } from '../src/session-config.js';
import {
  matchSdnextComponent,
  normalizeSdnextComponents,
  normalizeSdnextModels,
  normalizeSdnextModelRecords,
  installSdnext,
  inspectPinnedSdnextRuntime,
  isSupportedSdnextPythonVersion,
  SDNEXT_PINNED_DEV_TARGET,
  sdnextPythonCandidates,
  quoteWindowsShellArg,
  SdnextClient,
  startSdnext,
  totalEta,
  validateEngineInstallTarget,
} from '../src/sdnext.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('pinned SD.Next Python version policy', () => {
  it('accepts only Python 3.10 through 3.13', () => {
    for (const minor of [10, 11, 12, 13]) {
      expect(isSupportedSdnextPythonVersion(3, minor)).toBe(true);
    }
    for (const [major, minor] of [[3, 9], [3, 14], [3, 15], [2, 7], [4, 0]]) {
      expect(isSupportedSdnextPythonVersion(major!, minor!)).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32' || !gitAvailable)('recognizes an unsupported Python version in the pinned venv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-sdnext-python-guard-'));
    try {
      execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' });
      const refs = join(root, '.git', 'refs', 'heads');
      await mkdir(refs, { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(join(refs, 'main'), `${SDNEXT_PINNED_DEV_TARGET.commit}\n`);
      const fakePython = join(root, 'venv', 'bin', 'python3');
      await mkdir(join(root, 'venv', 'bin'), { recursive: true });
      await writeFile(fakePython, `#!/bin/sh\nprintf '%s\\n' '{"python_version":"3.14.3","missing":[],"mismatch":{}}'\n`);
      await chmod(fakePython, 0o755);

      await expect(inspectPinnedSdnextRuntime(root)).resolves.toMatchObject({
        ready: false,
        commit: SDNEXT_PINNED_DEV_TARGET.commit,
        pythonVersion: '3.14.3',
        pythonUnsupported: true,
        reason: expect.stringContaining('No dependency bootstrap was started.'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('SD.Next model-list responses', () => {
  it('uses model titles from current SD.Next records', () => {
    expect(
      normalizeSdnextModels([
        {
          title: 'qwen-image-2.1-turbo-Q4_K_M.gguf [abc123]',
          model_name: 'qwen-image-2.1-turbo-Q4_K_M',
          filename: '/models/UNET/qwen-image-2.1-turbo-Q4_K_M.gguf',
        },
      ]),
    ).toEqual(['qwen-image-2.1-turbo-Q4_K_M.gguf [abc123]']);
  });

  it('preserves the registered aliases needed to reload a base model', () => {
    expect(
      normalizeSdnextModelRecords([
        {
          title: 'Qwen-Image-2.1 [abc123]',
          model_name: 'Qwen-Image-2.1',
          filename: 'C:\\sdnext\\models\\Diffusers\\Qwen-Image-2.1',
          type: 'diffusers',
        },
      ]),
    ).toEqual([
      {
        title: 'Qwen-Image-2.1 [abc123]',
        modelName: 'Qwen-Image-2.1',
        filename: 'C:\\sdnext\\models\\Diffusers\\Qwen-Image-2.1',
        type: 'diffusers',
      },
    ]);
  });

  it('still supports plain string lists and skips malformed records', () => {
    expect(normalizeSdnextModels(['sd15', { model_name: 'sdxl' }, null, 4, {}])).toEqual([
      'sd15',
      'sdxl',
    ]);
  });

  it('exposes the SD.Next model records as well as their display titles', async () => {
    const server = createServer((request, response) => {
      if (request.url !== '/sdapi/v1/sd-models') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([
        {
          title: 'Qwen-Image-2.1 [abc123]',
          model_name: 'Qwen-Image-2.1',
          filename: '/sdnext/models/Diffusers/Qwen-Image-2.1',
        },
      ]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      expect(await client.modelRecords(true)).toEqual([
        {
          title: 'Qwen-Image-2.1 [abc123]',
          modelName: 'Qwen-Image-2.1',
          filename: '/sdnext/models/Diffusers/Qwen-Image-2.1',
          type: undefined,
        },
      ]);
      expect(await client.models()).toEqual(['Qwen-Image-2.1 [abc123]']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('SD.Next checkpoint loading API', () => {
  it('loads a checkpoint through the dedicated endpoint, not the global options endpoint', async () => {
    let observed: { method?: string; path?: string; checkpoint?: string | null; force?: string | null } = {};
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      observed = {
        method: request.method,
        path: url.pathname,
        checkpoint: url.searchParams.get('sd_model_checkpoint'),
        force: url.searchParams.get('force'),
      };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/sdapi/v1/checkpoint')) {
        return Promise.reject(new Error('checkpoint POST must not use global fetch'));
      }
      return originalFetch(input, init);
    });
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      await expect(client.loadCheckpoint('Velatura Qwen [local reference]', true)).resolves.toBe(true);
      expect(observed).toEqual({
        method: 'POST',
        path: '/sdapi/v1/checkpoint',
        checkpoint: 'Velatura Qwen [local reference]',
        force: 'true',
      });
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not treat an unconfirmed SD.Next model load as successful', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      await expect(client.loadCheckpoint('Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4')).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('SD.Next component enumerators', () => {
  it('normalizes UNET and VAE records without conflating the filename and accepted name', () => {
    expect(
      normalizeSdnextComponents([
        {
          name: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
          filename: 'C:\\sdnext\\models\\UNET\\qwen-image-2.1-turbo-Q4_K_M.gguf',
        },
        {
          model_name: 'qwen_image_2.1_vae_bf16.safetensors',
          filename: 'C:\\sdnext\\models\\VAE\\qwen_image_2.1_vae_bf16.safetensors',
        },
        null,
        4,
      ]),
    ).toEqual([
      {
        name: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
        filename: 'C:\\sdnext\\models\\UNET\\qwen-image-2.1-turbo-Q4_K_M.gguf',
      },
      {
        name: 'qwen_image_2.1_vae_bf16.safetensors',
        filename: 'C:\\sdnext\\models\\VAE\\qwen_image_2.1_vae_bf16.safetensors',
      },
    ]);
  });

  it('matches the requested component against its filename, not a checkpoint list', () => {
    const components = normalizeSdnextComponents([
      {
        name: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
        filename: 'C:\\sdnext\\models\\UNET\\qwen-image-2.1-turbo-Q4_K_M.gguf',
      },
      { name: 'Qwen-Image-2.1-Turbo', filename: 'C:\\sdnext\\models\\UNET\\other.gguf' },
    ]);
    expect(matchSdnextComponent('qwen-image-2.1-turbo-Q4_K_M.gguf', components)?.name).toBe(
      'qwen-image-2.1-turbo-Q4_K_M.gguf',
    );
    expect(matchSdnextComponent('qwen-image-2.1-turbo-Q8_0.gguf', components)).toBeUndefined();
  });

  it('uses the current plural endpoint and falls back to the singular documented route', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/sdapi/v1/unets') {
        response.writeHead(404).end();
      } else if (request.url === '/sdapi/v1/unet') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify([{ name: 'dit.gguf', filename: '/models/UNET/dit.gguf' }]),
        );
      } else if (request.url === '/sdapi/v1/refresh-unets' && request.method === 'POST') {
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      expect(await client.unets()).toEqual([{ name: 'dit.gguf', filename: '/models/UNET/dit.gguf' }]);
      await expect(client.refreshUnets()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('SD.Next runtime model checks', () => {
  it('reports whether the generation endpoint was called without recording request text', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/sdapi/v1/txt2img' && request.method === 'POST') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ images: ['fake-image'], parameters: {} }));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const observed: Array<{ stage: string; method: string; path: string }> = [];
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`, (event) => observed.push(event));
      await client.generate({ prompt: 'do not write this prompt to a log' });
      expect(observed).toEqual([
        expect.objectContaining({ stage: 'start', method: 'POST', path: '/sdapi/v1/txt2img' }),
        expect.objectContaining({ stage: 'complete', method: 'POST', path: '/sdapi/v1/txt2img', status: 200 }),
      ]);
      expect(JSON.stringify(observed)).not.toContain('do not write this prompt to a log');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses a long-lived core HTTP request for SD.Next generation and reports its loading phase', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/sdapi/v1/txt2img' && request.method === 'POST') {
        setTimeout(() => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ images: ['generated-image'], parameters: {} }));
        }, 900);
      } else if (request.url === '/sdapi/v1/progress') {
        response.setHeader('content-type', 'application/json').end(JSON.stringify({ progress: 0, state: {} }));
      } else if (request.url === '/sdapi/v1/status') {
        response.setHeader('content-type', 'application/json').end(
          JSON.stringify({ status: 'running', task: 'Load TE', current: '', progress: 0 }),
        );
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const stages: string[] = [];
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/sdapi/v1/txt2img')) {
        return Promise.reject(new Error('generation POST must not use global fetch'));
      }
      return originalFetch(input, init);
    });
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      const result = await client.generate({ prompt: 'slow first load' }, undefined, (_progress, _eta, _preview, stage) => {
        if (stage) stages.push(stage);
      });
      expect(result.images).toEqual(['generated-image']);
      expect(stages).toContain('Load TE');
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('treats an empty HTTP 200 generation response as a failure, not a completed job', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/sdapi/v1/txt2img' && request.method === 'POST') {
        response.setHeader('content-type', 'application/json').end(JSON.stringify({ images: [], parameters: {} }));
      } else if (request.url === '/sdapi/v1/progress') {
        response.setHeader('content-type', 'application/json').end(JSON.stringify({ progress: 0, state: {} }));
      } else if (request.url === '/sdapi/v1/status') {
        response.setHeader('content-type', 'application/json').end(JSON.stringify({ status: 'running', task: '' }));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      await expect(client.generate({ prompt: 'empty result' })).rejects.toThrow(/returned no image/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('records the low-level fetch cause code without logging request data', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const cause = Object.assign(new Error('headers timed out'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
      throw new TypeError('fetch failed', { cause });
    });
    try {
      const client = new SdnextClient('http://127.0.0.1:7860', (event) => observed.push(event));
      const result = await client.status();
      expect(result.ready).toBe(false);
      expect(observed).toContainEqual(expect.objectContaining({ errorCauseCode: 'UND_ERR_HEADERS_TIMEOUT' }));
    } finally {
      fetchSpy.mockRestore();
      void originalFetch;
    }
  });

  it('reads active options and the actually loaded checkpoint, including its pipeline class', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/sdapi/v1/options' && request.method === 'GET') {
        response.end(JSON.stringify({ offline_mode: false, sd_unet: 'Default' }));
      } else if (request.url === '/sdapi/v1/options-info') {
        response.end(
          JSON.stringify({
            options: {
              sd_text_encoder: { component_args: { choices: ['Default', 'qwen3vl_8b_w4a8'] } },
            },
          }),
        );
      } else if (request.url === '/sdapi/v1/checkpoint') {
        response.end(
          JSON.stringify({
            title: 'Qwen-Image-2.1 [abc123]',
            class: 'QwenImage21Pipeline',
            type: 'qwen21',
          }),
        );
      } else if (request.url === '/sdapi/v1/cmd-flags') {
        response.end(JSON.stringify({ config: '/home/user/.velatura/sdnext-session/config.json' }));
      } else if (request.url === '/sdapi/v1/options' && request.method === 'POST') {
        response.end(JSON.stringify({ updated: [{ sd_unet: true }] }));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      expect(await client.options()).toEqual({ offline_mode: false, sd_unet: 'Default' });
      expect((await client.optionsInfo()).options?.sd_text_encoder?.component_args?.choices).toEqual([
        'Default',
        'qwen3vl_8b_w4a8',
      ]);
      expect(await client.currentModel()).toEqual({
        checkpoint: 'Qwen-Image-2.1 [abc123]',
        class: 'QwenImage21Pipeline',
        type: 'qwen21',
      });
      expect(await client.commandFlags()).toEqual({ config: '/home/user/.velatura/sdnext-session/config.json' });
      expect(await client.setOptionsChecked({ sd_unet: 'qwen-dit.gguf' })).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('SD.Next checkpoint refresh', () => {
  it('refreshes the checkpoint index and invalidates the cached model list', async () => {
    let modelReads = 0;
    let refreshes = 0;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/sdapi/v1/sd-models' && request.method === 'GET') {
        modelReads += 1;
        response.end(JSON.stringify([{ title: 'Qwen-Image-2.1-Turbo' }]));
      } else if (request.url === '/sdapi/v1/refresh-checkpoints' && request.method === 'POST') {
        refreshes += 1;
        response.end('{}');
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SdnextClient(`http://127.0.0.1:${port}`);
      await client.modelRecords();
      await client.modelRecords();
      expect(modelReads).toBe(1);
      await client.refreshCheckpoints();
      await client.modelRecords();
      expect(refreshes).toBe(1);
      expect(modelReads).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Windows SD.Next launcher arguments', () => {
  it('quotes paths with spaces so cmd.exe treats them as one argument', () => {
    const configPath = 'C:\\Users\\Ada Lovelace\\AppData\\Local\\velatura\\sdnext-session\\config.json';
    expect(quoteWindowsShellArg(configPath)).toBe(`"${configPath}"`);
  });
});

describe('the time left', () => {
  it('uses eta_relative directly as remaining seconds without multiplying by remaining steps', () => {
    expect(
      totalEta({ eta_relative: 4, state: { sampling_step: 2, sampling_steps: 8 } }),
    ).toBe(4);
  });

  it('rounds fractional eta_relative to the nearest second', () => {
    expect(
      totalEta({ eta_relative: 4.4, state: { sampling_step: 8, sampling_steps: 8 } }),
    ).toBe(4);
  });

  it('keeps the value of the engine when it does not say the step', () => {
    expect(totalEta({ eta_relative: 7 })).toBe(7);
    expect(totalEta({ eta_relative: 7, state: { sampling_step: 3 } })).toBe(7);
  });

  it('says nothing when the engine says nothing or reports zero', () => {
    expect(totalEta({})).toBeUndefined();
    expect(totalEta({ eta_relative: 0 })).toBeUndefined();
  });
});


describe('SD.Next install target safety', () => {
  it.skipIf(process.platform === 'win32')('follows a literal venv_dir configured in webui-user.sh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-sdnext-venv-path-'));
    try {
      await writeFile(join(root, 'webui-user.sh'), `venv_dir='custom-env'\n`);
      const candidates = await sdnextPythonCandidates(root);
      expect(candidates[0]).toBe(join(root, 'custom-env', 'bin', 'python3'));
      expect(candidates[1]).toBe(join(root, 'custom-env', 'bin', 'python'));
      expect(candidates).toContain(join(root, 'venv', 'bin', 'python3'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat a folder without a virtual environment as a prepared runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-sdnext-runtime-'));
    try {
      await expect(inspectPinnedSdnextRuntime(root)).resolves.toMatchObject({
        ready: false,
        reason: 'The SD.Next virtual environment is not installed yet.',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a new destination without creating it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'velatura-engine-target-'));
    const target = join(base, 'sdnext');
    try {
      const result = await validateEngineInstallTarget(target);
      expect(result.ok).toBe(true);
      expect(result.dir).toBe(target);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a non-empty folder', async () => {
    const target = await mkdtemp(join(tmpdir(), 'velatura-engine-nonempty-'));
    try {
      await writeFile(join(target, 'keep-me.txt'), 'user data');
      const result = await validateEngineInstallTarget(target);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/will not overwrite/i);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('refuses to install over a folder that already has the SD.Next launcher', async () => {
    const target = await mkdtemp(join(tmpdir(), 'velatura-engine-existing-'));
    try {
      await writeFile(join(target, sdnextLauncherName()), '');
      const result = await validateEngineInstallTarget(target);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/already has its startup script/i);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});


describe('SD.Next install failure cleanup', () => {
  it('calls the cleanup hook and removes the isolated config when installation is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-engine-install-fail-'));
    const sdnext = join(root, 'sdnext');
    const velatura = join(root, 'velatura');
    await mkdir(sdnext, { recursive: true });
    const prepared = await prepareIsolatedSdnextConfig(sdnext, ['--api'], velatura);
    await writeFile(join(sdnext, 'user-data.txt'), 'do not overwrite');
    const onError = vi.fn(async () => {
      await discardIsolatedSdnextConfig(prepared.isolation);
    });

    try {
      const state = installSdnext(sdnext, () => undefined, prepared.args, undefined, onError);
      await vi.waitFor(() => expect(state.phase).toBe('error'));
      expect(onError).toHaveBeenCalledOnce();
      expect(existsSync(prepared.isolation.sessionPath)).toBe(false);
      expect(existsSync(join(sdnext, 'user-data.txt'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe('SD.Next startup readiness', () => {
  it.skipIf(process.platform === 'win32')('waits for the SD.Next API after reading its URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velatura-engine-start-'));
    const server = createServer((request, response) => {
      if (request.url !== '/sdapi/v1/sd-models') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await writeFile(
        join(root, 'webui.sh'),
        `#!/bin/sh\nprintf 'Local URL: http://127.0.0.1:${port}/\\n'\nexec sleep 10\n`,
      );
      await chmod(join(root, 'webui.sh'), 0o755);
      const engine = await startSdnext({ root, startupTimeoutMs: 4000 });
      expect(engine.url).toBe(`http://127.0.0.1:${port}`);
      await engine.stop();
      expect(engine.process.exitCode !== null || engine.process.signalCode !== null).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
