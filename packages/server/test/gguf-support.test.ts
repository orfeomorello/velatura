import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GGUF_PACKAGE,
  inspectGgufSupport,
  installGgufSupport,
  sdnextPythonPath,
  type GgufPackageInfo,
} from '../src/gguf-support.js';

const dependencies = Object.fromEntries(GGUF_PACKAGE.dependencies.map((item) => [item.distribution, '99.0.0']));

function probe(ggufAvailable: boolean, overrides: Record<string, string | null> = {}) {
  return JSON.stringify({
    pythonVersion: '3.12.2',
    ggufAvailable,
    ggufVersion: ggufAvailable ? '0.19.0' : null,
    dependencies: { ...dependencies, ...overrides },
    dependencyModules: Object.fromEntries(GGUF_PACKAGE.dependencies.map((item) => [item.distribution, true])),
  });
}

describe('SD.Next GGUF support preflight', () => {
  it('resolves the platform-specific SD.Next virtual-environment Python', () => {
    expect(sdnextPythonPath('/opt/sdnext', 'linux')).toBe(join('/opt/sdnext', 'venv', 'bin', 'python'));
    expect(sdnextPythonPath('C:\\sdnext', 'win32')).toBe(join('C:\\sdnext', 'venv', 'Scripts', 'python.exe'));
  });

  it('reports a missing gguf module without attempting any download', async () => {
    const runPython = vi.fn(async () => ({ stdout: probe(false), stderr: '' }));
    const fetcher = vi.fn();
    const state = await inspectGgufSupport('/sdnext', {
      platform: 'linux',
      exists: () => true,
      runPython,
      fetcher,
    });

    expect(state.status).toBe('missing');
    expect(state.package).toMatchObject({
      name: 'gguf',
      version: '0.19.0',
      sizeBytes: 118475,
      license: 'MIT',
      sha256: '70bcd10edfe697fb2dad6e40af2234b9d8ece9a41a99761405121ebda1c3c1cd',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(runPython).toHaveBeenCalledTimes(1);
  });

  it('does not offer installation when a declared dependency is missing or too old', async () => {
    const state = await inspectGgufSupport('/sdnext', {
      platform: 'linux',
      exists: () => true,
      runPython: async () => ({ stdout: probe(false, { numpy: '1.16.0', requests: null }), stderr: '' }),
    });

    expect(state.status).toBe('dependencies-missing');
    if (state.status === 'dependencies-missing') {
      expect(state.missingDependencies).toEqual([
        'numpy >= 1.17 (found 1.16.0)',
        'requests >= 2.25 (not installed)',
      ]);
    }
  });

  it('requires explicit consent before invoking Python or making a network request', async () => {
    const runPython = vi.fn();
    const fetcher = vi.fn();
    await expect(
      installGgufSupport('/sdnext', '/velatura/packages', {
        consent: false,
        platform: 'linux',
        exists: () => true,
        runPython,
        fetcher,
      }),
    ).rejects.toThrow('Explicit consent is required');
    expect(runPython).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads one checksum-verified wheel and installs it offline into the SD.Next venv only', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'velatura-gguf-test-'));
    const body = Buffer.from('test wheel fixture');
    const packageInfo: GgufPackageInfo = {
      ...GGUF_PACKAGE,
      filename: 'gguf-test.whl',
      url: 'https://example.test/gguf-test.whl',
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    const pythonCalls: Array<{ args: string[]; cwd: string }> = [];
    let inspections = 0;
    const runPython = vi.fn(async (_python: string, args: string[], cwd: string) => {
      pythonCalls.push({ args, cwd });
      if (args[0] === '-m') return { stdout: 'installed', stderr: '' };
      inspections += 1;
      return { stdout: probe(inspections > 1), stderr: '' };
    });
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));

    try {
      const result = await installGgufSupport(temp, join(temp, 'support'), {
        consent: true,
        platform: 'linux',
        exists: () => true,
        runPython,
        fetcher,
        packageInfo,
      });

      expect(result.installed).toBe(true);
      expect(result.support.status).toBe('ready');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(packageInfo.url, expect.objectContaining({ redirect: 'error' }));
      expect(pythonCalls).toHaveLength(3);
      expect(pythonCalls[1]?.args).toEqual([
        '-m',
        'pip',
        'install',
        '--no-index',
        '--no-deps',
        '--force-reinstall',
        join(temp, 'support', packageInfo.filename),
      ]);
      expect(pythonCalls[1]?.cwd).toBe(temp);
      expect(await readFile(join(temp, 'support', packageInfo.filename))).toEqual(body);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('refuses a tampered wheel before pip is called', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'velatura-gguf-tamper-'));
    const body = Buffer.from('tampered wheel');
    const packageInfo: GgufPackageInfo = {
      ...GGUF_PACKAGE,
      filename: 'gguf-test.whl',
      url: 'https://example.test/gguf-test.whl',
      sizeBytes: body.length,
      sha256: '0'.repeat(64),
    };
    const runPython = vi.fn(async (_python: string, args: string[]) => {
      if (args[0] === '-m') return { stdout: '', stderr: '' };
      return { stdout: probe(false), stderr: '' };
    });

    try {
      await expect(
        installGgufSupport(temp, join(temp, 'support'), {
          consent: true,
          platform: 'linux',
          exists: () => true,
          runPython,
          fetcher: async () => new Response(body, { status: 200 }),
          packageInfo,
        }),
      ).rejects.toThrow('SHA-256 mismatch');
      expect(runPython).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
