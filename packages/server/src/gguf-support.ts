/**
 * Consent-gated support for loading GGUF transformers in SD.Next.
 *
 * SD.Next's global offline mode also blocks its own pip installer. Velatura
 * therefore stages this small, pinned wheel before starting an offline Qwen
 * session. It never disables offline mode and never downloads model weights.
 */
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

export interface GgufDependency {
  distribution: string;
  minimumVersion: string;
}

export interface GgufPackageInfo {
  name: string;
  version: string;
  filename: string;
  url: string;
  sizeBytes: number;
  license: string;
  licenseUrl: string;
  sha256: string;
  requiresPython: string;
  dependencies: GgufDependency[];
}

/**
 * PyPI release metadata for the platform-independent wheel. This version is
 * pinned so that consent, size and checksum describe exactly what is fetched.
 */
export const GGUF_PACKAGE: GgufPackageInfo = Object.freeze({
  name: 'gguf',
  version: '0.19.0',
  filename: 'gguf-0.19.0-py3-none-any.whl',
  url: 'https://files.pythonhosted.org/packages/b3/bb/d71d6da82763528c2c2ed6b59a9d6142c6595545a4c448e2085d155e88c2/gguf-0.19.0-py3-none-any.whl',
  sizeBytes: 118475,
  license: 'MIT',
  licenseUrl: 'https://pypi.org/project/gguf/0.19.0/',
  sha256: '70bcd10edfe697fb2dad6e40af2234b9d8ece9a41a99761405121ebda1c3c1cd',
  requiresPython: '>=3.10',
  dependencies: [
    { distribution: 'numpy', minimumVersion: '1.17' },
    { distribution: 'PyYAML', minimumVersion: '5.1' },
    { distribution: 'requests', minimumVersion: '2.25' },
    { distribution: 'tqdm', minimumVersion: '4.27' },
  ],
});

export type GgufSupportStatus =
  | {
      status: 'ready';
      package: GgufPackageInfo;
      pythonVersion: string;
      installedVersion?: string;
    }
  | {
      status: 'missing';
      package: GgufPackageInfo;
      pythonVersion: string;
      missingDependencies: string[];
    }
  | {
      status: 'dependencies-missing';
      package: GgufPackageInfo;
      pythonVersion: string;
      missingDependencies: string[];
    }
  | {
      status: 'python-unsupported';
      package: GgufPackageInfo;
      pythonVersion: string;
      reason: string;
    }
  | {
      status: 'python-missing';
      package: GgufPackageInfo;
      reason: string;
    }
  | {
      status: 'check-failed';
      package: GgufPackageInfo;
      reason: string;
    };

export interface GgufSupportDependencies {
  /** Test seams; production defaults are the current platform, fetch, and execFile. */
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  fetcher?: typeof fetch;
  runPython?: (
    pythonPath: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Test seam only; production always uses the pinned PyPI metadata above. */
  packageInfo?: GgufPackageInfo;
}

interface ProbeResult {
  pythonVersion?: string;
  ggufAvailable?: boolean;
  ggufVersion?: string | null;
  dependencies?: Record<string, string | null>;
  dependencyModules?: Record<string, boolean>;
}

const MINIMUM_PYTHON_PROBE = String.raw`
import importlib.metadata as metadata
import importlib.util
import json
import sys

names = json.loads(sys.argv[1])
module_names = {"numpy": "numpy", "PyYAML": "yaml", "requests": "requests", "tqdm": "tqdm"}
dependencies = {}
dependency_modules = {}
for name in names:
    try:
        dependencies[name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        dependencies[name] = None
    try:
        dependency_modules[name] = importlib.util.find_spec(module_names.get(name, name)) is not None
    except (ImportError, ValueError):
        dependency_modules[name] = False
try:
    gguf_version = metadata.version("gguf")
except metadata.PackageNotFoundError:
    gguf_version = None
try:
    import gguf
    gguf_available = True
except Exception:
    gguf_available = False
print(json.dumps({
    "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
    "ggufAvailable": gguf_available,
    "ggufVersion": gguf_version,
    "dependencies": dependencies,
    "dependencyModules": dependency_modules,
}))
`;

export function sdnextPythonPath(root: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? win32.join(root, 'venv', 'Scripts', 'python.exe')
    : join(root, 'venv', 'bin', 'python');
}

function defaultRunPython(
  pythonPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(pythonPath, args, { cwd, timeout: timeoutMs, windowsHide: true });
}

function parseVersion(value: string | null | undefined): number[] | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:\.\d+){0,3})/.exec(value);
  return match?.[1]?.split('.').map((part) => Number(part));
}

function versionAtLeast(current: string | null | undefined, minimum: string): boolean {
  const actual = parseVersion(current);
  const required = parseVersion(minimum);
  if (!actual || !required) return false;
  const length = Math.max(actual.length, required.length);
  for (let i = 0; i < length; i++) {
    const a = actual[i] ?? 0;
    const b = required[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function dependenciesNotMet(
  packageInfo: GgufPackageInfo,
  versions: Record<string, string | null> | undefined,
  modules: Record<string, boolean> | undefined,
): string[] {
  return packageInfo.dependencies.flatMap(({ distribution, minimumVersion }) => {
    const current = versions?.[distribution];
    const moduleAvailable = modules?.[distribution] ?? false;
    if (versionAtLeast(current, minimumVersion) && moduleAvailable) return [];
    const versionNote = current ? `found ${current}` : 'not installed';
    const importNote = moduleAvailable ? '' : ', import unavailable';
    return [`${distribution} >= ${minimumVersion} (${versionNote}${importNote})`];
  });
}

function supportedPython(pythonVersion: string): boolean {
  return versionAtLeast(pythonVersion, '3.10');
}

export async function inspectGgufSupport(
  root: string,
  dependencies: GgufSupportDependencies = {},
): Promise<GgufSupportStatus> {
  const packageInfo = dependencies.packageInfo ?? GGUF_PACKAGE;
  const pythonPath = sdnextPythonPath(root, dependencies.platform ?? process.platform);
  if (!(dependencies.exists ?? existsSync)(pythonPath)) {
    return {
      status: 'python-missing',
      package: packageInfo,
      reason: `SD.Next's virtual-environment Python was not found at ${pythonPath}. Start its installer once to create the environment, then check GGUF support again.`,
    };
  }

  const runPython = dependencies.runPython ?? defaultRunPython;
  try {
    const result = await runPython(
      pythonPath,
      ['-c', MINIMUM_PYTHON_PROBE, JSON.stringify(packageInfo.dependencies.map((item) => item.distribution))],
      root,
      15_000,
    );
    const probe = JSON.parse(result.stdout.trim()) as ProbeResult;
    if (!probe.pythonVersion) throw new Error('SD.Next did not report its Python version');
    if (!supportedPython(probe.pythonVersion)) {
      return {
        status: 'python-unsupported',
        package: packageInfo,
        pythonVersion: probe.pythonVersion,
        reason: `The GGUF support wheel requires Python ${packageInfo.requiresPython}; SD.Next is using Python ${probe.pythonVersion}.`,
      };
    }

    const missingDependencies = dependenciesNotMet(packageInfo, probe.dependencies, probe.dependencyModules);
    if (probe.ggufAvailable) {
      return {
        status: 'ready',
        package: packageInfo,
        pythonVersion: probe.pythonVersion,
        installedVersion: probe.ggufVersion ?? undefined,
      };
    }
    if (missingDependencies.length) {
      return {
        status: 'dependencies-missing',
        package: packageInfo,
        pythonVersion: probe.pythonVersion,
        missingDependencies,
      };
    }
    return {
      status: 'missing',
      package: packageInfo,
      pythonVersion: probe.pythonVersion,
      missingDependencies: [],
    };
  } catch (err) {
    return {
      status: 'check-failed',
      package: packageInfo,
      reason: `Velatura could not check GGUF support in SD.Next's Python environment: ${(err as Error).message}`,
    };
  }
}

async function readVerifiedWheel(path: string, packageInfo: GgufPackageInfo): Promise<Buffer | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength !== packageInfo.sizeBytes) return undefined;
    const digest = createHash('sha256').update(bytes).digest('hex');
    return digest.toLowerCase() === packageInfo.sha256.toLowerCase() ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function downloadVerifiedWheel(
  path: string,
  packageInfo: GgufPackageInfo,
  fetcher: typeof fetch,
): Promise<void> {
  if (await readVerifiedWheel(path, packageInfo)) return;
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  const response = await fetcher(packageInfo.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`PyPI file download failed (HTTP ${response.status}).`);
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > 0 && declaredLength !== packageInfo.sizeBytes) {
    throw new Error(`GGUF wheel size mismatch: server declared ${declaredLength} bytes, expected ${packageInfo.sizeBytes}.`);
  }
  if (!response.body) throw new Error('PyPI file download returned an empty response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      receivedBytes += value.byteLength;
      if (receivedBytes > packageInfo.sizeBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`GGUF wheel exceeded its expected size of ${packageInfo.sizeBytes} bytes; no package was installed.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (receivedBytes !== packageInfo.sizeBytes) {
    throw new Error(`GGUF wheel size mismatch: received ${receivedBytes} bytes, expected ${packageInfo.sizeBytes}.`);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), receivedBytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest.toLowerCase() !== packageInfo.sha256.toLowerCase()) {
    throw new Error(`GGUF wheel SHA-256 mismatch: received ${digest}; no package was installed.`);
  }

  const part = `${path}.part`;
  await rm(part, { force: true });
  await writeFile(part, bytes, { flag: 'wx' });
  try {
    await rename(part, path);
  } catch (err) {
    await rm(part, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface GgufInstallResult {
  installed: boolean;
  support: GgufSupportStatus;
}

/**
 * Install only after an explicit user action. The verified wheel is installed
 * into SD.Next's venv with pip offline and with dependency resolution disabled.
 */
export async function installGgufSupport(
  root: string,
  supportDir: string,
  options: GgufSupportDependencies & { consent: boolean },
): Promise<GgufInstallResult> {
  if (options.consent !== true) throw new Error('Explicit consent is required before installing GGUF support.');

  const packageInfo = options.packageInfo ?? GGUF_PACKAGE;
  const before = await inspectGgufSupport(root, options);
  if (before.status === 'ready') return { installed: false, support: before };
  if (before.status !== 'missing') {
    throw new Error(
      before.status === 'dependencies-missing'
        ? `GGUF support was not downloaded because SD.Next is missing required packages: ${before.missingDependencies.join(', ')}.`
        : before.status === 'python-missing' || before.status === 'check-failed'
          ? before.reason
          : before.status === 'python-unsupported'
            ? before.reason
            : 'GGUF support could not be installed safely.',
    );
  }

  const pythonPath = sdnextPythonPath(root, options.platform ?? process.platform);
  const wheelPath = join(supportDir, packageInfo.filename);
  await downloadVerifiedWheel(wheelPath, packageInfo, options.fetcher ?? fetch);
  const runPython = options.runPython ?? defaultRunPython;
  await runPython(
    pythonPath,
    [
      '-m',
      'pip',
      'install',
      '--no-index',
      '--no-deps',
      '--force-reinstall',
      wheelPath,
    ],
    root,
    120_000,
  );

  const after = await inspectGgufSupport(root, options);
  if (after.status !== 'ready') {
    throw new Error(
      after.status === 'check-failed'
        ? after.reason
        : `The wheel was verified and pip completed, but SD.Next still cannot import gguf (status: ${after.status}).`,
    );
  }
  return { installed: true, support: after };
}
