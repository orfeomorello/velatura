/**
 * Velatura server — the only process that talks to SD.Next.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROFILES,
  applyPlacement,
  expectationFor,
  detectHardware,
  downloadFile,
  findSdnextRoot,
  defaultSdnextRoot,
  normalizeSdnextRootPath,
  foreignInstallCandidates,
  modelState,
  modelStates,
  parseManifest,
  planPlacement,
  checkDiskSpace,
  clearImages,
  deleteImage,
  findPartials,
  imageStore,
  imagesDir,
  saveImage,
  secureShredFile,
  secureWipeInPlace,
  knownFilesFor,
  scanFile,
  scanForeignInstalls,
  detectSdnextRootCandidates,
  isIntelGpu,
  JsonlStore,
  loadProfiles,
  matchExactModel,
  slotDir,
  validateSdnextRoot,
  verifyFile,
  type Job,
  type Manifest,
  type ManifestEntry,
  type PlacementMode,
  type Profile,
  type SdnextSlot,
  type ScanResult,
  type Provenance,
} from '@velatura/core';
import {
  configDir,
  configPath,
  DEFAULT_CONFIG,
  generateToken,
  loadConfig,
  saveConfig,
  type VelaturaConfig,
} from './config.js';
import { JobQueue, type QueueEvent } from './queue.js';
import { DiagnosticLog, safeJobError, velaturaLogDirectory, velaturaLogFile } from './diagnostics.js';
import {
  GGUF_PACKAGE,
  inspectGgufSupport,
  installGgufSupport,
  type GgufSupportStatus,
} from './gguf-support.js';
import {
  QWEN_TURBO_TOKENIZER,
  getQwenTurboSupportState,
  qwenTurboDiffusersDir,
  qwenTurboHfCacheDir,
  qwenTurboSearchRoots,
  qwenTurboTokenizerPath,
  resolveSdnextComponentPath,
} from './qwen-turbo-reference.js';
import {
  QWEN_TURBO_VARIANTS,
  hasManagedQwenTurboReference,
  prepareQwenTurboReference,
  qwenTurboModelPath,
  qwenTurboVariantFromBaseName,
  removeManagedQwenTurboReferences,
  type QwenTurboVariant,
} from './qwen-profile-reference.js';
import {
  chooseCheckpointReloadAlias,
  profileRuntimeMatches,
  requireProfileModels,
  sdnextTextEncoderName,
} from './profile-model.js';
import {
  discardIsolatedSdnextConfig,
  isVelaturaSessionConfigPath,
  isolatedSdnextConfigExists,
  prepareIsolatedSdnextConfig,
  resolveSdnextConfigArgument,
  restoreIsolatedSdnextConfig,
  type IsolatedSdnextConfig,
} from './session-config.js';
import {
  SdnextClient,
  matchSdnextComponent,
  checkEngineRequirements,
  detectSdnextUrl,
  engineInstallState,
  installSdnext,
  SDNEXT_INSTALL_TARGETS,
  SDNEXT_PINNED_DEV_TARGET,
  inspectPinnedSdnextRuntime,
  readSdnextCommit,
  validateEngineInstallTarget,
  startSdnext,
  type SdnextInstallTargetId,
  type PinnedSdnextRuntimeStatus,
  type RunningEngine,
  type SdnextRequestEvent,
} from './sdnext.js';
import {
  hasQwen21GgufCompat,
  installQwen21GgufCompat,
  removeQwen21GgufCompat,
  type Qwen21GgufCompatInstall,
} from './sdnext-gguf-compat.js';

export interface ServerOptions {
  port?: number;
  sdnextRoot?: string;
  token?: string;
  logger?: boolean;
  uiDist?: string;
  /** Test hook; defaults to the local `~/.velatura/logs/velatura.log` path. */
  logFile?: string;
}

export interface BuiltServer {
  app: FastifyInstance;
  config: VelaturaConfig;
  token: string;
  diagnostics: DiagnosticLog;
  logFile: string;
  queue: JobQueue;
  manifest: Manifest;
  profiles: Profile[];
  /** the profile adapted to the files already installed, when there is one */
  derivedProfile: () => { profile: Profile; notes: string[]; dit?: string } | undefined;
  sdnextUrl: () => string;
}

type AppliedProfile = {
  applied: boolean;
  /** false means a required local model/component failed preflight */
  modelsResolved?: boolean;
  checkpoint?: string;
  /** API alias to send only when SD.Next must reload the profile pipeline */
  checkpointOverride?: string;
  /** restore only transient options when no base reload is required */
  restoreOverrideSettings?: boolean;
  pipeline?: string;
  unet?: string;
  textEncoder?: string;
  vae?: string;
  reason?: string;
};

/** Walk up from a starting point looking for a relative path. */
async function engineResponds(url: string, timeoutMs = 800): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = url.replace(/\/$/, '');
    const response = await fetch(`${base}/sdapi/v1/sd-models`, { signal: controller.signal });
    const ok = response.ok;
    await response.body?.cancel().catch(() => undefined);
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function findUp(start: string, relative: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function resolveManifestPath(): string | undefined {
  if (process.env.VELATURA_MANIFEST) return process.env.VELATURA_MANIFEST;
  const here = dirname(fileURLToPath(import.meta.url));
  return (
    findUp(here, join('manifests', 'models.yaml')) ??
    findUp(process.cwd(), join('manifests', 'models.yaml')) ??
    findUp(resolve(process.cwd(), '..'), join('manifests', 'models.yaml'))
  );
}

export function resolveProfilesPath(): string | undefined {
  if (process.env.VELATURA_PROFILES) return process.env.VELATURA_PROFILES;
  const here = dirname(fileURLToPath(import.meta.url));
  return (
    findUp(here, join('profiles')) ??
    findUp(process.cwd(), join('profiles')) ??
    findUp(resolve(process.cwd(), '..'), join('profiles'))
  );
}

export function resolveUiDist(): string | undefined {
  if (process.env.VELATURA_UI_DIST) return process.env.VELATURA_UI_DIST;
  const here = dirname(fileURLToPath(import.meta.url));
  return findUp(here, join('apps', 'ui', 'dist'));
}

export async function buildServer(opts: ServerOptions = {}): Promise<BuiltServer> {
  const config = await loadConfig();
  const diagnostics = new DiagnosticLog(opts.logFile ?? velaturaLogFile());
  if (opts.port) config.port = opts.port;
  if (opts.sdnextRoot) config.sdnextRoot = normalizeSdnextRootPath(opts.sdnextRoot);
  else if (config.sdnextRoot) config.sdnextRoot = normalizeSdnextRootPath(config.sdnextRoot);
  if (!config.sdnextRoot) {
    config.sdnextRoot = await findSdnextRoot();
  }

  const token = opts.token ?? generateToken();
  // the body carries the reference images as base64: the interface scales
  // them down, but the limit stays generous enough for four big photos
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 * 1024 });
  app.addHook('onClose', async () => {
    diagnostics.info('server.closed');
    await diagnostics.flush();
  });
  app.addHook('onError', async (request, reply, error) => {
    diagnostics.error('http.request.failed', {
      method: request.method,
      path: request.url.split('?')[0],
      status: reply.statusCode,
      errorType: error.name,
    });
  });

  // ---- manifest & profiles -------------------------------------------------
  const manifestPath = resolveManifestPath();
  let manifest: Manifest = { version: 1, models: [] };
  if (manifestPath) {
    try {
      manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    } catch (err) {
      diagnostics.warn('manifest.load.failed', { message: (err as Error).message });
    }
  }
  // profiles: the YAML files in the repository, falling back to the built-in ones
  const profilesDir = resolveProfilesPath();
  const profiles = profilesDir ? await loadProfiles(profilesDir) : DEFAULT_PROFILES;
  if (!profiles.some((profile) => profile.id === config.profileId)) {
    const previousProfileId = config.profileId;
    config.profileId = profiles.find((profile) => profile.id === 'lowvram')?.id ?? profiles[0]!.id;
    await saveConfig(config);
    diagnostics.info('profile.config.migrated', {
      previousProfileId,
      profileId: config.profileId,
      reason: 'Removed profile id; defaulted to Low because only Low and Full are supported.',
    });
  }

  // ---- engine --------------------------------------------------------------
  // the configured URL wins: the automatic detection is only a fallback
  let sdnextUrl = config.sdnextUrl ?? 'http://127.0.0.1:7860';
  if (!config.sdnextUrl) {
    const detected = await detectSdnextUrl();
    if (detected) sdnextUrl = detected;
  }
  const createSdnextClient = (url: string): SdnextClient =>
    new SdnextClient(url, (event: SdnextRequestEvent) => {
      // The UI polls these successful endpoints every few seconds. Their
      // useful state is recorded by profile/job events, so omit the noise.
      const routineHealthRead =
        event.method === 'GET' &&
        ['/sdapi/v1/progress', '/sdapi/v1/status', '/sdapi/v1/sd-models', '/sdapi/v1/checkpoint'].includes(event.path);
      if (routineHealthRead && event.stage !== 'error') return;
      if (event.stage === 'error') diagnostics.warn('sdnext.http', { ...event });
      else diagnostics.info('sdnext.http', { ...event });
    });
  let client = createSdnextClient(sdnextUrl);
  diagnostics.info('server.initializing', {
    version: '0.1.4',
    profileId: config.profileId,
    port: config.port,
    sdnextConfigured: Boolean(config.sdnextRoot),
    platform: process.platform,
  });
  /** the engine we started ourselves: only this one may be stopped by us */
  let managed:
    | { stop: () => Promise<void>; log: string[]; sessionConfig?: IsolatedSdnextConfig }
    | undefined;
  let ggufInstallInProgress = false;
  let qwenGgufCompatActive = false;
  let qwenGgufCompatSession: Qwen21GgufCompatInstall | undefined;
  let qwenReferenceStatus:
    | {
        profileId: string;
        variant: QwenTurboVariant;
        label: string;
        state: 'verifying' | 'assembling' | 'ready' | 'error';
        role?: string;
        percent?: number;
        message?: string;
        updatedAt: string;
      }
    | undefined;

  const restoreSessionConfig = async (isolation: IsolatedSdnextConfig): Promise<void> => {
    const result = await restoreIsolatedSdnextConfig(isolation);
    if (result.status === 'restored') {
      diagnostics.info('sdnext.session-config.restored', { path: result.path, savedModelDefaultsPreserved: true });
    } else if (result.status === 'concurrent-change') {
      diagnostics.warn('sdnext.session-config.restore-skipped', {
        path: result.path,
        reason: 'The original SD.Next config changed while the isolated session was running; it was left untouched.',
      });
    } else {
      diagnostics.warn('sdnext.session-config.restore-skipped', { path: result.path, reason: result.reason });
    }
  };

  const trackManagedEngine = (
    engine: RunningEngine,
    log: string[],
    isolation: IsolatedSdnextConfig,
    qwenCompat?: Qwen21GgufCompatInstall,
  ): NonNullable<typeof managed> => {
    qwenGgufCompatActive = Boolean(qwenCompat);
    qwenGgufCompatSession = qwenCompat;
    return {
      log,
      sessionConfig: isolation,
      stop: async () => {
        try {
          await engine.stop();
        } finally {
          try {
            await restoreSessionConfig(isolation);
          } finally {
            if (qwenCompat) {
              const removed = await removeQwen21GgufCompat(qwenCompat.root).catch(() => false);
              diagnostics.info('sdnext.gguf-compat.removed', {
                removed,
                path: qwenCompat.scriptPath,
              });
            }
            if (qwenGgufCompatSession?.scriptPath === qwenCompat?.scriptPath) {
              qwenGgufCompatActive = false;
              qwenGgufCompatSession = undefined;
            }
          }
        }
      },
    };
  };

  const hasIsolatedSessionConfig = async (): Promise<boolean> => {
    const flags = await client.commandFlags().catch(() => undefined);
    const configArgument = resolveSdnextConfigArgument(flags?.config, config.sdnextRoot ?? process.cwd());
    if (!configArgument || !existsSync(configArgument)) return false;
    if (managed?.sessionConfig && isolatedSdnextConfigExists(managed.sessionConfig)) {
      const expectedPath = resolveSdnextConfigArgument(managed.sessionConfig.sessionPath, process.cwd());
      const actual = process.platform === 'win32' ? configArgument.toLowerCase() : configArgument;
      const expected = process.platform === 'win32' ? expectedPath?.toLowerCase() : expectedPath;
      return actual === expected;
    }
    return isVelaturaSessionConfigPath(configArgument, configDir());
  };

  const eventListeners = new Set<(event: unknown) => void>();
  const emitEvent = (event: unknown) => {
    for (const listener of eventListeners) listener(event);
  };

  const history = new JsonlStore<Job>(join(configDir(), 'history.jsonl'));

  /**
   * The history must not point at a picture that was deleted.
   *
   * The file is small and it is rewritten atomically: a crash in the
   * middle leaves the old history, never a broken one.
   */
  const forgetPathInHistory = async (path: string): Promise<void> => {
    const records = await history.readAll();
    let changed = false;
    for (const record of records) {
      const files = record.files;
      if (!files?.includes(path)) continue;
      record.files = files.filter((file) => file !== path);
      changed = true;
    }
    if (changed) await history.rewrite(records);
  };
  /** the local image store: the pictures Velatura makes live here */
  const imageStoreDir = imagesDir(configDir());

  /**
   * The folder where the program itself is installed.
   *
   * The manifest is the anchor: it sits in the app folder in every layout
   * (the repository, the bundle, the installed copy).
   */
  const appFolder = (): string => {
    const manifest = resolveManifestPath();
    if (manifest) return dirname(dirname(manifest));
    const here = dirname(dirname(fileURLToPath(import.meta.url)));
    return resolve(here, '..', '..');
  };
  const configuredProfile = () => profiles.find((p) => p.id === config.profileId) ?? profiles[0];

  // The public product surface is intentionally limited to the two pinned
  // profiles. Installed files are checked against the selected profile; they
  // do not silently create or select a third derived profile.
  let derived: { profile: Profile; notes: string[]; dit?: string } | undefined;

  /** the base reference selected by the active profile (not proof it is loaded) */
  let profileCheckpoint: string | undefined;

  /** was the engine awake at the last check? */
  let engineWasReady = false;

  const refreshDerivedProfile = async (): Promise<void> => {
    derived = undefined;
  };

  /** Exactly one of the two user-selected built-in profiles is active. */
  const activeProfile = () => configuredProfile();

  /** The component file pinned by the selected profile, never a nearby substitute. */
  const profileModelFile = (
    profile: Profile | undefined,
    role: Profile['models'][number]['role'] = 'dit',
  ): string | undefined => {
    const selected = profile?.models.find((model) => model.role === role);
    const entry = selected ? manifest.models.find((model) => model.id === selected.manifestId) : undefined;
    const file = selected?.file ?? entry?.file;
    return file?.split(/[\\/]/).pop();
  };

  const profileQwenVariant = (profile: Profile | undefined): QwenTurboVariant | undefined =>
    qwenTurboVariantFromBaseName(profile?.engine?.checkpoint);

  const profileRequiresGguf = (profile: Profile | undefined): boolean =>
    profile?.engine?.pipeline === 'Qwen21' && /\.gguf$/i.test(profileModelFile(profile, 'dit') ?? '');

  const prepareQwen21GgufCompat = async (
    root: string,
    profile: Profile | undefined,
  ): Promise<Qwen21GgufCompatInstall | undefined> => {
    if (!profileRequiresGguf(profile)) return undefined;
    const compat = await installQwen21GgufCompat(root);
    diagnostics.info('sdnext.gguf-compat.prepared', {
      version: '1.0.0',
      changed: compat.changed,
      path: compat.scriptPath,
      loadedOnNextStart: true,
    });
    return compat;
  };

  /**
   * The flags the engine is started with.
   * On an Intel Arc, SD.Next needs --use-ipex, otherwise it uses the CPU.
   */
  type EngineLaunchMode = 'auto' | 'bootstrap' | 'runtime';
  type EngineLaunchPlan = {
    args: string[];
    isolation: IsolatedSdnextConfig;
    qwenGgufCompat?: Qwen21GgufCompatInstall;
    bootstrap: boolean;
  };

  const engineLaunch = async (
    root: string,
    mode: EngineLaunchMode = 'auto',
  ): Promise<EngineLaunchPlan> => {
    const profile = activeProfile();
    const args = [...(profile?.engine?.args ?? ['--api'])];
    if (!args.includes('--use-ipex')) {
      const hw = await detectHardware();
      if (isIntelGpu(hw)) args.push('--use-ipex');
    }
    const qwenVariant = profileQwenVariant(profile);
    const qwenSession = Boolean(qwenVariant);
    const hasSdnextLauncher = existsSync(join(root, 'webui.sh')) || existsSync(join(root, 'webui.bat'));

    const runtime: PinnedSdnextRuntimeStatus = qwenSession && mode !== 'bootstrap'
      ? await inspectPinnedSdnextRuntime(root)
      : { ready: false, reason: 'A first-run dependency bootstrap was requested.' };
    if (qwenSession && runtime.pythonUnsupported) {
      throw new Error(
        `SD.Next supports Python 3.10–3.13 (Python 3.12 is recommended), but this installation's virtual environment uses Python ${runtime.pythonVersion}. Velatura stopped before dependency bootstrap or model loading.`,
      );
    }
    if (qwenSession && mode === 'runtime' && !runtime.ready) {
      throw new Error(
        `SD.Next is not ready (${runtime.reason ?? 'dependency check failed'}). Start SD.Next from Velatura while connected to the internet so its dependencies can be prepared; no model weights will be downloaded.`,
      );
    }
    const bootstrap = qwenSession && !runtime.ready;
    let qwenGgufCompat: Qwen21GgufCompatInstall | undefined;
    if (qwenSession && profileRequiresGguf(profile) && hasSdnextLauncher) {
      qwenGgufCompat = await prepareQwen21GgufCompat(root, profile);
    }
    const diffusersDir = qwenTurboDiffusersDir(configDir());
    const hfCacheDir = qwenTurboHfCacheDir(configDir());
    if (qwenSession) {
      await mkdir(diffusersDir, { recursive: true });
      await mkdir(hfCacheDir, { recursive: true });
    }
    const isolatedOverrides = qwenSession
      ? {
          diffusers_dir: diffusersDir,
          hfcache_dir: hfCacheDir,
          offline_mode: !bootstrap,
          // Select the profile only in this private config. Autoload stays off;
          // Velatura explicitly loads the verified local reference on the first
          // generation request, then keeps it active for the rest of the session.
          sd_model_checkpoint: profile?.engine?.checkpoint,
          diffusers_pipeline: profile?.engine?.pipeline ?? 'Autodetect',
          sd_unet: 'Default',
          sd_text_encoder: 'Default',
          te_shared_te: false,
          sd_vae: 'Default',
          // The installer needs network access on first run. Keep it from
          // loading or auto-downloading any checkpoint during that bootstrap.
          sd_checkpoint_autoload: false,
          sd_checkpoint_autodownload: false,
          sdnq_quantize_weights: [],
        }
      : {};
    const isolated = await prepareIsolatedSdnextConfig(root, args, configDir(), isolatedOverrides);
    diagnostics.info('sdnext.session-config.prepared', {
      sourcePath: isolated.isolation.sourcePath,
      sessionPath: isolated.isolation.sessionPath,
      qwenVariant,
      qwenReferenceDir: qwenSession && qwenVariant ? qwenTurboModelPath(configDir(), qwenVariant) : undefined,
      isolatedDiffusersDir: qwenSession ? diffusersDir : undefined,
      isolatedHfCacheDir: qwenSession ? hfCacheDir : undefined,
      offlineMode: qwenSession && !bootstrap,
      automaticDownloadsDisabled: qwenSession,
      modelAutoloadDisabled: qwenSession,
      bootstrap,
      savedModelDefaultsIsolated: true,
    });
    return { ...isolated, qwenGgufCompat, bootstrap };
  };

  const verifyQwenBootstrap = async (root: string, url: string): Promise<void> => {
    const bootstrapClient = createSdnextClient(url);
    const [options, loadedModel] = await Promise.all([
      bootstrapClient.options(),
      bootstrapClient.currentModel(),
    ]);
    if (
      options.offline_mode !== false ||
      options.sd_checkpoint_autoload !== false ||
      options.sd_checkpoint_autodownload !== false ||
      loadedModel.class ||
      loadedModel.type ||
      loadedModel.checkpoint
    ) {
      throw new Error(
        'SD.Next did not confirm the safe first-run state (online dependency setup, model autoload disabled, and model auto-download disabled). Velatura stopped before the Qwen session; inspect the SD.Next log and retry.',
      );
    }
    const runtime = await inspectPinnedSdnextRuntime(root);
    if (!runtime.ready) {
      throw new Error(
        `SD.Next started, but its runtime could not be verified (${runtime.reason ?? 'unknown dependency state'}). Velatura stopped before loading Qwen or sending a generation request.`,
      );
    }
    diagnostics.info('sdnext.bootstrap.completed', {
      commit: runtime.commit,
      dependencyPinsVerified: true,
      modelLoaded: false,
      modelAutoloadDisabled: true,
      modelAutodownloadDisabled: true,
    });
  };

  const promoteQwenBootstrap = async (
    root: string,
    bootstrapEngine: RunningEngine,
    bootstrapLaunch: EngineLaunchPlan,
    onLog: (line: string) => void,
  ): Promise<{ engine: RunningEngine; launch: EngineLaunchPlan }> => {
    let runtimeLaunch: EngineLaunchPlan | undefined;
    try {
      await verifyQwenBootstrap(root, bootstrapEngine.url);
      await bootstrapEngine.stop();
      await discardIsolatedSdnextConfig(bootstrapLaunch.isolation);
      if (bootstrapLaunch.qwenGgufCompat) {
        await removeQwen21GgufCompat(bootstrapLaunch.qwenGgufCompat.root).catch(() => false);
      }
      runtimeLaunch = await engineLaunch(root, 'runtime');
      const engine = await startSdnext({
        root,
        args: runtimeLaunch.args,
        startupTimeoutMs: existsSync(join(root, 'venv')) ? 15 * 60_000 : 45 * 60_000,
        onLog,
      });
      return { engine, launch: runtimeLaunch };
    } catch (error) {
      await bootstrapEngine.stop().catch(() => undefined);
      await discardIsolatedSdnextConfig(bootstrapLaunch.isolation).catch(() => undefined);
      if (runtimeLaunch) {
        await discardIsolatedSdnextConfig(runtimeLaunch.isolation).catch(() => undefined);
        if (runtimeLaunch.qwenGgufCompat) {
          await removeQwen21GgufCompat(runtimeLaunch.qwenGgufCompat.root).catch(() => false);
        }
      }
      if (bootstrapLaunch.qwenGgufCompat) {
        await removeQwen21GgufCompat(bootstrapLaunch.qwenGgufCompat.root).catch(() => false);
      }
      throw error;
    }
  };

  const ggufSupportForProfile = async (profile: Profile | undefined): Promise<GgufSupportStatus | undefined> => {
    if (!profileRequiresGguf(profile)) return undefined;
    if (!config.sdnextRoot) {
      return {
        status: 'check-failed',
        package: GGUF_PACKAGE,
        reason: 'SD.Next is not configured. Choose its installation folder in Setup before checking GGUF support.',
      };
    }
    return inspectGgufSupport(config.sdnextRoot);
  };

  const ggufSupportMessage = (support: GgufSupportStatus): string => {
    switch (support.status) {
      case 'missing':
        return 'The selected Qwen profile needs the gguf Python package in SD.Next. Velatura keeps SD.Next offline, so its automatic installer cannot fetch this package. Review the package details and approve the verified install before starting.';
      case 'dependencies-missing':
        return `GGUF support was not installed. SD.Next is missing required Python packages: ${support.missingDependencies.join(', ')}. No download was made.`;
      case 'python-unsupported':
      case 'python-missing':
      case 'check-failed':
        return support.reason;
      case 'ready':
        return 'GGUF support is ready in SD.Next.';
    }
  };

  /**
   * Apply a profile only after resolving its base checkpoint and each local
   * component from the SD.Next enumerators. A DiT file is never treated as a
   * checkpoint; it is sent as `sd_unet`.
   */
  const applyProfileToEngine = async (
    profile: Profile | undefined,
    onProgress?: (progress?: number, etaSeconds?: number, preview?: string, stage?: string) => void,
  ): Promise<AppliedProfile> => {
    if (!profile) {
      const reason = 'No active profile is selected.';
      diagnostics.warn('profile.apply.failed', { profileId: null, reason });
      return { applied: false, reason };
    }

    const baseName = profile.engine?.checkpoint;
    const pipeline = profile.engine?.pipeline ?? 'Autodetect';
    const qwenVariant = profileQwenVariant(profile);
    const managedSession = managed;
    const localQwenReference = Boolean(qwenVariant);
    const ditFile = profileModelFile(profile, 'dit');
    const textEncoderFile = profileModelFile(profile, 'text-encoder');
    const vaeFile = profileModelFile(profile, 'vae');
    const fail = (
      reason: string,
      details: Omit<AppliedProfile, 'applied' | 'reason'> = {},
      context: Record<string, unknown> = {},
    ): AppliedProfile => {
      diagnostics.warn('profile.apply.failed', { profileId: profile.id, reason, ...context, ...details });
      return { applied: false, ...details, reason };
    };
    diagnostics.info('profile.apply.started', {
      profileId: profile.id,
      baseCheckpoint: baseName ?? null,
      pipeline,
      ditFile: ditFile ?? null,
      textEncoderFile: textEncoderFile ?? null,
      vaeFile: vaeFile ?? null,
    });

    const engineStatus = await client.status();
    if (!engineStatus.ready) {
      return fail('SD.Next is not running. Velatura will validate the profile base model and components after SD.Next starts.');
    }

    const [loadedModel, currentOptions, optionInfo] = await Promise.all([
      client.currentModel().catch((): Awaited<ReturnType<SdnextClient['currentModel']>> => ({})),
      client.options().catch(() => undefined),
      client.optionsInfo().catch(() => undefined),
    ]);

    const pipelineChoices = optionInfo?.options?.diffusers_pipeline?.component_args?.choices;
    const supportedPipelines = Array.isArray(pipelineChoices)
      ? pipelineChoices.filter((choice): choice is string => typeof choice === 'string')
      : [];
    const pipelineSupported = supportedPipelines.includes(pipeline);
    diagnostics.info('profile.pipeline.checked', {
      profileId: profile.id,
      expected: pipeline,
      current: currentOptions?.diffusers_pipeline ?? null,
      loadedClass: loadedModel.class ?? null,
      supported: pipelineSupported,
      availableQwenPipelines: supportedPipelines.filter((choice) => /qwen/i.test(choice)),
    });
    if (!pipelineSupported) {
      return fail(
        `This SD.Next version does not expose the required "${pipeline}" pipeline through its API. Update SD.Next before using this profile. Velatura stopped before sending a generation request.`,
        {},
        { supportedPipelines: supportedPipelines.slice(0, 80) },
      );
    }

    if (!currentOptions) {
      profileCheckpoint = undefined;
      return fail('Velatura could not verify SD.Next model settings. Retry after confirming the SD.Next API is ready.');
    }

    if (localQwenReference && qwenVariant) {
      if (!config.sdnextRoot) {
        profileCheckpoint = undefined;
        return fail('Velatura needs the SD.Next installation folder to prepare the local Qwen Turbo reference. Re-select the SD.Next folder in Setup.');
      }
      if (managedSession) {
        const expectedDiffusersDir = qwenTurboDiffusersDir(configDir());
        const actualDiffusersDir = resolveSdnextConfigArgument(currentOptions.diffusers_dir, config.sdnextRoot);
        const pathKey = (value: string) => {
          const normalized = resolve(value);
          return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        };
        if (!actualDiffusersDir || pathKey(actualDiffusersDir) !== pathKey(expectedDiffusersDir)) {
          profileCheckpoint = undefined;
          return fail(
            'SD.Next did not apply Velatura’s private Diffusers folder. No model was loaded. Stop this SD.Next session and start the engine from Velatura again.',
            {},
            { expectedDiffusersDir, actualDiffusersDir: actualDiffusersDir ?? null },
          );
        }
        const expectedHfCacheDir = qwenTurboHfCacheDir(configDir());
        const actualHfCacheDir = resolveSdnextConfigArgument(currentOptions.hfcache_dir, config.sdnextRoot);
        if (!actualHfCacheDir || pathKey(actualHfCacheDir) !== pathKey(expectedHfCacheDir)) {
          profileCheckpoint = undefined;
          return fail(
            'SD.Next did not apply Velatura’s private offline config cache. No model was loaded. Stop this SD.Next session and start the engine from Velatura again.',
            {},
            { expectedHfCacheDir, actualHfCacheDir: actualHfCacheDir ?? null },
          );
        }
        if (currentOptions.offline_mode !== true) {
          profileCheckpoint = undefined;
          return fail(
            'SD.Next did not confirm offline mode for the Qwen session. Velatura stopped before loading the model or sending a generation request.',
          );
        }
        diagnostics.info('qwen.turbo.offline-mode.runtime.checked', {
          expectedHfCacheDir,
          actualHfCacheDir,
          offlineMode: currentOptions.offline_mode,
          baseWeightsAutoDownload: false,
        });
      } else {
        // Ensure safe runtime options on an already-running SD.Next instance so it never downloads 17 GB
        await client.setOptions({
          te_shared_te: false,
          offline_mode: true,
          sd_unet: 'Default',
          sd_text_encoder: 'Default',
          sd_vae: 'Default',
        });
      }

      const originalDiffusersDir = managedSession?.sessionConfig?.originalConfig.diffusers_dir;
      const originalHfCacheDir = managedSession?.sessionConfig?.originalConfig.hfcache_dir;
      const support = await getQwenTurboSupportState(
        configDir(),
        qwenTurboSearchRoots(config.sdnextRoot, originalDiffusersDir, originalHfCacheDir),
      );
      diagnostics.info('qwen.turbo.support.checked', {
        status: support.status,
        ready: support.ready,
        source: support.source ?? null,
        path: support.path ?? null,
        expectedBytes: support.sizeBytes,
        expectedSha256: support.sha256,
        actualSha256: support.actualSha256 ?? null,
        license: support.license,
      });
      if (!support.ready || !support.path) {
        profileCheckpoint = undefined;
        return fail(
          `The Qwen Turbo pipeline needs one small processor support file (${support.sizeBytes.toLocaleString('en-US')} bytes; Qwen Research License, non-commercial). It contains tokenizer data, not model weights. Open Models and use “Download Qwen Turbo support file” after reviewing the licence and SHA-256. Velatura will not download the full Qwen base weights.`,
          {},
          { supportStatus: support.status, supportSha256: support.sha256 },
        );
      }

      qwenReferenceStatus = {
        profileId: profile.id,
        variant: qwenVariant,
        label: QWEN_TURBO_VARIANTS[qwenVariant].label,
        state: 'verifying',
        percent: 0,
        updatedAt: new Date().toISOString(),
      };
      onProgress?.(undefined, undefined, undefined, `Verifying ${QWEN_TURBO_VARIANTS[qwenVariant].label} profile files`);

      const qwenComponents: {
        dit?: { path: string; expected: { sizeBytes?: number; sha256?: string } };
        textEncoder?: { path: string; expected: { sizeBytes?: number; sha256?: string } };
        vae?: { path: string; expected: { sizeBytes?: number; sha256?: string } };
      } = {};
      const componentRoles = ['dit', 'text-encoder', 'vae'] as const;
      for (const role of componentRoles) {
        const selected = profile.models.find((model) => model.role === role);
        const entry = selected ? manifest.models.find((model) => model.id === selected.manifestId) : undefined;
        const remoteFile = selected?.file ?? entry?.file;
        if (!entry || !remoteFile) {
          profileCheckpoint = undefined;
          return fail(`The ${profile.label} profile does not have a pinned manifest entry for its ${role} component.`);
        }
        const expected = expectationFor(entry, remoteFile);
        if (!expected.sha256 || !expected.sizeBytes) {
          profileCheckpoint = undefined;
          return fail(`The ${role} component has no pinned size and SHA-256. Velatura will not assemble an unverified Qwen Turbo reference.`);
        }
        const fileName = basename(remoteFile);
        const componentPath = join(slotDir(config.sdnextRoot, entry.dest), fileName);
        if (!existsSync(componentPath)) {
          profileCheckpoint = undefined;
          return fail(
            `The ${profile.label} profile needs “${fileName}” in SD.Next's models/${entry.dest} folder. Open Models and download or import that file; Velatura will check its SHA-256 and assemble the profile automatically. Expected path: ${componentPath}`,
            {},
            { role, expectedPath: componentPath, manifestId: entry.id },
          );
        }
        const component = { path: componentPath, expected };
        if (role === 'dit') qwenComponents.dit = component;
        else if (role === 'text-encoder') qwenComponents.textEncoder = component;
        else qwenComponents.vae = component;
      }
      if (!qwenComponents.dit || !qwenComponents.textEncoder || !qwenComponents.vae) {
        profileCheckpoint = undefined;
        return fail(`Velatura could not find all three pinned components for the ${profile.label} profile.`);
      }

      try {
        const progressBuckets = new Map<string, number>();
        const reference = await prepareQwenTurboReference({
          dataDir: configDir(),
          sdnextRoot: config.sdnextRoot,
          variant: qwenVariant,
          components: qwenComponents as {
            dit: { path: string; expected: { sizeBytes?: number; sha256?: string } };
            textEncoder: { path: string; expected: { sizeBytes?: number; sha256?: string } };
            vae: { path: string; expected: { sizeBytes?: number; sha256?: string } };
          },
          tokenizerPath: support.path,
          onEvent: (event) => {
            if (event.action === 'verify-progress' && typeof event.role === 'string' && typeof event.bytes === 'number' && typeof event.total === 'number' && event.total > 0) {
              const role = event.role;
              progressBuckets.set(role, Math.max(progressBuckets.get(role) ?? 0, Math.min(event.bytes, event.total)));
              const totalBytes =
                (qwenComponents.dit?.expected.sizeBytes ?? 0) +
                (qwenComponents.textEncoder?.expected.sizeBytes ?? 0) +
                (qwenComponents.vae?.expected.sizeBytes ?? 0) +
                support.sizeBytes;
              const verifiedBytes = [...progressBuckets.values()].reduce((sum, value) => sum + value, 0);
              const percent = totalBytes > 0 ? Math.min(99, Math.floor((verifiedBytes / totalBytes) * 100)) : 0;
              const label = role === 'textEncoder' ? 'text encoder' : role;
              if (percent >= 5 && percent > (qwenReferenceStatus?.percent ?? 0)) {
                qwenReferenceStatus = {
                  profileId: profile.id,
                  variant: qwenVariant,
                  label: QWEN_TURBO_VARIANTS[qwenVariant].label,
                  state: 'verifying',
                  role,
                  percent,
                  message: `Checking the ${label} file`,
                  updatedAt: new Date().toISOString(),
                };
                onProgress?.(undefined, undefined, undefined, `Checking ${QWEN_TURBO_VARIANTS[qwenVariant].label} files (${percent}%)`);
                diagnostics.info('qwen.profile-reference.verify.progress', {
                  profileId: profile.id,
                  variant: qwenVariant,
                  role,
                  percent,
                });
              }
              return;
            }
            if (event.action === 'assembly-started') {
              qwenReferenceStatus = {
                profileId: profile.id,
                variant: qwenVariant,
                label: QWEN_TURBO_VARIANTS[qwenVariant].label,
                state: 'assembling',
                percent: 100,
                message: 'Building the local Diffusers reference',
                updatedAt: new Date().toISOString(),
              };
              onProgress?.(undefined, undefined, undefined, `Building the local ${QWEN_TURBO_VARIANTS[qwenVariant].label} reference`);
            }
            if (event.action === 'created' || event.action === 'reused') {
              qwenReferenceStatus = {
                profileId: profile.id,
                variant: qwenVariant,
                label: QWEN_TURBO_VARIANTS[qwenVariant].label,
                state: 'assembling',
                percent: 100,
                message: 'Registering the local reference with SD.Next',
                updatedAt: new Date().toISOString(),
              };
              onProgress?.(undefined, undefined, undefined, `Registering the ${QWEN_TURBO_VARIANTS[qwenVariant].label} reference with SD.Next`);
            }
            diagnostics.info(`qwen.profile-reference.${String(event.action ?? 'event')}`, {
              profileId: profile.id,
              variant: qwenVariant,
              ...event,
            });
          },
        });
        diagnostics.info('qwen.profile-reference.ready', {
          profileId: profile.id,
          variant: qwenVariant,
          referenceDir: reference.referenceDir,
          baseName: reference.baseName,
          files: reference.files,
          sha256: reference.sha256,
          placement: reference.placement,
          offline: true,
          fullBaseWeightsDownloaded: false,
        });
        await client.refreshCheckpoints();
        qwenReferenceStatus = {
          profileId: profile.id,
          variant: qwenVariant,
          label: QWEN_TURBO_VARIANTS[qwenVariant].label,
          state: 'ready',
          percent: 100,
          message: 'SD.Next indexed the local profile reference',
          updatedAt: new Date().toISOString(),
        };
        onProgress?.(undefined, undefined, undefined, `${QWEN_TURBO_VARIANTS[qwenVariant].label} reference ready`);
        diagnostics.info('qwen.profile-reference.indexed', {
          profileId: profile.id,
          variant: qwenVariant,
          referenceDir: reference.referenceDir,
        });
      } catch (error) {
        profileCheckpoint = undefined;
        const message = error instanceof Error ? error.message : 'unknown preparation error';
        qwenReferenceStatus = {
          profileId: profile.id,
          variant: qwenVariant,
          label: QWEN_TURBO_VARIANTS[qwenVariant].label,
          state: 'error',
          message,
          updatedAt: new Date().toISOString(),
        };
        onProgress?.(undefined, undefined, undefined, `Could not prepare the ${QWEN_TURBO_VARIANTS[qwenVariant].label} reference`);
        return fail(
          `Velatura could not prepare the local ${QWEN_TURBO_VARIANTS[qwenVariant].label} reference. No network download was made. ${message}`,
          {},
          { variant: qwenVariant, errorType: error instanceof Error ? error.name : 'UnknownError' },
        );
      }
    }

    const modelRecords = await client.modelRecords(true).catch(() => []);
    const engineModels = modelRecords.map((record) => record.title);
    const checkpointRecord = baseName
      ? modelRecords.find((record) => {
          const aliases = [record.title, record.modelName, record.filename].filter(
            (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate),
          );
          return Boolean(matchExactModel(baseName, aliases));
        })
      : undefined;
    const checkpoint = checkpointRecord?.title ??
      (baseName && loadedModel.checkpoint ? matchExactModel(baseName, [loadedModel.checkpoint]) : undefined);
    diagnostics.info('profile.base.checked', {
      profileId: profile.id,
      expectedBase: baseName ?? null,
      resolvedBase: checkpoint ?? null,
      loadedCheckpoint: loadedModel.checkpoint ?? null,
      checkpointCount: engineModels.length,
      qwenCheckpointNames: engineModels.filter((name) => /qwen/i.test(name)).slice(0, 40),
    });
    if (baseName && !checkpoint) {
      profileCheckpoint = undefined;
      const reason = qwenVariant
        ? `Velatura assembled the pinned ${QWEN_TURBO_VARIANTS[qwenVariant].label} Diffusers reference, but SD.Next did not list “${baseName}” after refreshing its model list. No base weights were downloaded. Check the Velatura and SD.Next logs for the indexing error; no generation request was sent.`
        : `This SD.Next instance does not list the required "${baseName}" reference. Stop the external instance and start SD.Next from Velatura; Velatura will prepare the local profile reference automatically from installed components. It will not download full base weights or use another model as a fallback.`;
      return fail(reason, {}, { expectedBase: baseName, managed: Boolean(managed) });
    }

    if (ditFile && !baseName) {
      profileCheckpoint = undefined;
      return fail(
        `The profile requires UNET/DiT file "${ditFile}" but does not specify its Qwen Turbo base reference. Select a built-in Qwen profile in Setup.`,
        {},
        { ditFile },
      );
    }

    let unet: string | undefined = localQwenReference ? 'Default' : undefined;
    if (ditFile && !localQwenReference) {
      let available: Awaited<ReturnType<SdnextClient['unets']>> = [];
      try {
        available = await client.unets();
        let selected = matchSdnextComponent(ditFile, available);
        if (!selected) {
          await client.refreshUnets().catch(() => undefined);
          available = await client.unets();
          selected = matchSdnextComponent(ditFile, available);
        }
        unet = selected?.name;
      } catch {
        // The validation below reports the expected component and endpoint.
      }
      diagnostics.info('profile.unet.checked', {
        profileId: profile.id,
        expected: ditFile,
        resolved: unet ?? null,
        availableCount: available.length,
        availableNames: available.slice(0, 40).map((component) => component.name),
      });
      if (!unet) {
        profileCheckpoint = undefined;
        return fail(
          `SD.Next did not list the profile's UNET/DiT component "${ditFile}" in /sdapi/v1/unets (or /sdapi/v1/unet). Confirm that the file is in SD.Next's models/UNET folder and refresh or restart SD.Next.`,
          { checkpoint, pipeline },
          { availableCount: available.length, availableNames: available.slice(0, 40).map((component) => component.name) },
        );
      }
    }

    let textEncoder: string | undefined = localQwenReference ? 'Default' : undefined;
    if (textEncoderFile && !localQwenReference) {
      const path = config.sdnextRoot
        ? join(slotDir(config.sdnextRoot, 'Text-encoder'), textEncoderFile)
        : '';
      if (!path || !existsSync(path)) {
        profileCheckpoint = undefined;
        return fail(
          `The profile's text encoder "${textEncoderFile}" is missing from SD.Next's models/Text-encoder folder.`,
          { checkpoint, pipeline, unet },
        );
      }
      textEncoder = sdnextTextEncoderName(textEncoderFile);
      const choices = optionInfo?.options?.sd_text_encoder?.component_args?.choices;
      const indexed =
        Array.isArray(choices) &&
        choices.some((choice) => typeof choice === 'string' && choice === textEncoder);
      diagnostics.info('profile.text_encoder.checked', {
        profileId: profile.id,
        expected: textEncoder,
        indexed,
        qwenChoices: Array.isArray(choices)
          ? choices.filter((choice): choice is string => typeof choice === 'string' && /qwen/i.test(choice)).slice(0, 40)
          : [],
      });
      if (!indexed) {
        profileCheckpoint = undefined;
        return fail(
          `SD.Next has not indexed the profile's text encoder "${textEncoderFile}". Confirm it is in models/Text-encoder, then restart SD.Next and retry.`,
          { checkpoint, pipeline, unet },
        );
      }
    }

    let vae: string | undefined = localQwenReference
      ? (currentOptions.sd_vae === 'Default' ? 'Default' : 'Automatic')
      : undefined;
    if (vaeFile && !localQwenReference) {
      let available: Awaited<ReturnType<SdnextClient['vaes']>> = [];
      try {
        available = await client.vaes();
        let selected = matchSdnextComponent(vaeFile, available);
        if (!selected) {
          await client.refreshVaes().catch(() => undefined);
          available = await client.vaes();
          selected = matchSdnextComponent(vaeFile, available);
        }
        vae = selected?.name;
      } catch {
        // The validation below reports the expected component and endpoint.
      }
      diagnostics.info('profile.vae.checked', {
        profileId: profile.id,
        expected: vaeFile,
        resolved: vae ?? null,
        availableCount: available.length,
        availableNames: available.slice(0, 40).map((component) => component.name),
      });
      if (!vae) {
        profileCheckpoint = undefined;
        return fail(
          `SD.Next did not list the profile's VAE component "${vaeFile}" in /sdapi/v1/sd-vae. Confirm that the file is in SD.Next's models/VAE folder and refresh or restart SD.Next.`,
          { checkpoint, pipeline, unet, textEncoder },
          { availableCount: available.length, availableNames: available.slice(0, 40).map((component) => component.name) },
        );
      }
    }

    if (!currentOptions) {
      profileCheckpoint = undefined;
      return fail('Velatura could not verify SD.Next model settings. Retry after confirming the SD.Next API is ready.', {
        checkpoint,
        pipeline,
        unet,
        textEncoder,
        vae,
      });
    }

    const profileAlreadyLoaded = profileRuntimeMatches({
      expectedBase: baseName,
      loadedBase: loadedModel.checkpoint,
      selectedBase: currentOptions.sd_model_checkpoint,
      expectedPipeline: pipeline,
      loadedPipelineClass: loadedModel.class,
      selectedPipeline: currentOptions.diffusers_pipeline,
      expectedDit: unet,
      selectedDit: currentOptions.sd_unet,
      expectedTextEncoder: textEncoder,
      selectedTextEncoder: currentOptions.sd_text_encoder,
      expectedVae: vae,
      selectedVae: currentOptions.sd_vae,
    });

    const sessionConfigIsolated = await hasIsolatedSessionConfig();
    diagnostics.info('profile.persistence.safety.checked', {
      profileId: profile.id,
      isolatedConfig: sessionConfigIsolated,
      modelReloadRequired: !profileAlreadyLoaded,
      requestedBase: baseName ?? null,
    });

    let checkpointOverride: string | undefined;
    if (!profileAlreadyLoaded) {
      if (!checkpointRecord) {
        checkpointOverride = checkpoint ?? baseName;
      } else {
        checkpointOverride = chooseCheckpointReloadAlias(
          [checkpointRecord.title, checkpointRecord.filename],
          currentOptions.sd_model_checkpoint,
        ) ?? checkpointRecord.title;
      }
    }

    profileCheckpoint = checkpoint;
    const restoreOverrideSettings = profileAlreadyLoaded && !sessionConfigIsolated;
    const resolved = { checkpoint, pipeline, unet, textEncoder, vae, checkpointOverride, restoreOverrideSettings };
    diagnostics.info('profile.components.resolved', {
      profileId: profile.id,
      ...resolved,
      profileAlreadyLoaded,
      willReloadBase: Boolean(checkpointOverride),
    });
    diagnostics.info('profile.apply.completed', {
      profileId: profile.id,
      ...resolved,
      originalSdnextConfigChanged: false,
      sessionConfigIsolated,
    });
    return { applied: true, modelsResolved: true, ...resolved };
  };

  /**
   * Make sure the engine is awake.
   * The boot takes minutes, so it happens in the background and the job
   * simply waits for it.
   */
  let engineBoot: Promise<void> | undefined;
  const ensureEngine = async (): Promise<void> => {
    if (ggufInstallInProgress) throw new Error('GGUF support is still being installed. Retry after it finishes.');
    const ggufSupport = await ggufSupportForProfile(activeProfile());
    const awake = await client.status();
    if (awake.ready && ggufSupport && ggufSupport.status !== 'ready') {
      throw new Error(ggufSupportMessage(ggufSupport));
    }
    if (!awake.ready && ggufSupport && ggufSupport.status !== 'ready' && ggufSupport.status !== 'python-missing') {
      throw new Error(ggufSupportMessage(ggufSupport));
    }
    diagnostics.info('sdnext.ensure.status', {
      ready: awake.ready,
      configuredRoot: Boolean(config.sdnextRoot),
      engineWasReady,
    });
    if (awake.ready) {
      engineWasReady = true;
      return;
    }
    engineWasReady = false;
    if (!config.sdnextRoot) {
      diagnostics.error('sdnext.start.not_configured');
      throw new Error('SD.Next is not configured: run the setup first');
    }
    if (!engineBoot) {
      engineBoot = (async () => {
        diagnostics.info('sdnext.process.start.requested', { profileId: activeProfile()?.id ?? null });
        let launch = await engineLaunch(config.sdnextRoot!);
        let started: RunningEngine;
        try {
          started = await startSdnext({
            root: config.sdnextRoot!,
            args: launch.args,
            startupTimeoutMs: existsSync(join(config.sdnextRoot!, 'venv')) ? 15 * 60_000 : 45 * 60_000,
            onLog: (line) => emitEvent({ type: 'engine-log', line }),
          });
          if (launch.bootstrap) {
            const promoted = await promoteQwenBootstrap(
              config.sdnextRoot!,
              started,
              launch,
              (line) => emitEvent({ type: 'engine-log', line }),
            );
            started = promoted.engine;
            launch = promoted.launch;
          }
        } catch (err) {
          const sessionConfigDiscarded = await discardIsolatedSdnextConfig(launch.isolation);
          if (launch.qwenGgufCompat) await removeQwen21GgufCompat(launch.qwenGgufCompat.root).catch(() => false);
          diagnostics.error('sdnext.process.start.failed', {
            errorType: err instanceof Error ? err.name : 'UnknownError',
            sessionConfigDiscarded,
            bootstrap: launch.bootstrap,
          });
          throw err;
        }
        managed = trackManagedEngine(started, [], launch.isolation, launch.qwenGgufCompat);
        sdnextUrl = started.url;
        diagnostics.info('sdnext.process.ready', { ready: true });
        client = createSdnextClient(started.url);
        engineWasReady = true;
        await applyProfileToEngine(activeProfile());
      })().finally(() => {
        engineBoot = undefined;
      });
    }
    await engineBoot;
  };

  const queue = new JobQueue(
    async (request, onProgress, jobId) => {
      const mode = request.images?.length ? 'img2img' : 'txt2img';
      diagnostics.info('queue.job.started', {
        jobId,
        profileId: activeProfile()?.id ?? null,
        mode,
        referenceCount: request.images?.length ?? 0,
      });
      try {
        await ensureEngine();
      } catch (err) {
        diagnostics.warn('queue.engine.ensure.failed', {
          jobId,
          errorType: err instanceof Error ? err.name : 'UnknownError',
        });
        throw err;
      }
      const profile = activeProfile();
      diagnostics.info('generation.preflight.started', { jobId, profileId: profile?.id ?? null, mode });
      // the profile is authoritative: preflight verifies the active base,
      // pipeline and components; generation uses request overrides without a
      // persistent /options write.
      let applied = await applyProfileToEngine(profile, onProgress);
      if (!applied.modelsResolved) {
        const reason = applied.reason ?? 'Velatura could not resolve the active profile models.';
        diagnostics.warn('generation.preflight.failed', { jobId, profileId: profile?.id ?? null, reason });
        throw new Error(reason);
      }
      if (!applied.applied) {
        diagnostics.warn('generation.profile.options.warning', {
          jobId,
          profileId: profile?.id ?? null,
          reason: applied.reason,
        });
      }
      const localQwenProfile = Boolean(profileQwenVariant(profile));
      if (localQwenProfile && applied.checkpointOverride) {
        const checkpointToLoad = applied.checkpoint ?? applied.checkpointOverride;
        onProgress?.(undefined, undefined, undefined, `Loading ${profile?.label ?? 'Qwen Turbo'} in SD.Next`);
        diagnostics.info('generation.profile-load.started', {
          jobId,
          profileId: profile?.id ?? null,
          checkpoint: checkpointToLoad,
          endpoint: '/sdapi/v1/checkpoint',
          forcedReload: true,
          offlineMode: true,
          automaticDownloadsDisabled: true,
        });
        const loadConfirmed = await client.loadCheckpoint(checkpointToLoad, true);
        if (!loadConfirmed) {
          diagnostics.warn('generation.profile-load.failed', {
            jobId,
            profileId: profile?.id ?? null,
            checkpoint: checkpointToLoad,
            reason: 'SD.Next did not confirm that the checkpoint was loaded.',
          });
          throw new Error(
            `SD.Next did not confirm loading the local ${profile?.label ?? 'Qwen Turbo'} reference. Check the SD.Next log; Velatura stopped before sending the generation request.`,
          );
        }
        diagnostics.info('generation.profile-load.completed', {
          jobId,
          profileId: profile?.id ?? null,
          checkpoint: checkpointToLoad,
        });
        const verifiedLoad = await applyProfileToEngine(profile, onProgress);
        if (!verifiedLoad.modelsResolved || !verifiedLoad.applied || verifiedLoad.checkpointOverride) {
          const reason = verifiedLoad.reason ??
            'SD.Next acknowledged the model-load request, but Velatura could not verify that the selected Qwen pipeline is active.';
          diagnostics.warn('generation.profile-load.verification-failed', {
            jobId,
            profileId: profile?.id ?? null,
            reason,
            loadedCheckpoint: verifiedLoad.checkpoint ?? null,
            reloadStillRequired: Boolean(verifiedLoad.checkpointOverride),
          });
          throw new Error(`${reason} Velatura stopped before sending the generation request.`);
        }
        applied = verifiedLoad;
        onProgress?.(undefined, undefined, undefined, `${profile?.label ?? 'Qwen Turbo'} loaded in SD.Next`);
      }
      const expectedDit = profileModelFile(profile, 'dit');
      const expectedTextEncoder = profileModelFile(profile, 'text-encoder');
      const expectedVae = profileModelFile(profile, 'vae');
      requireProfileModels({
        expectedBase: profile?.engine?.checkpoint,
        resolvedBase: applied.checkpoint ?? profileCheckpoint,
        expectedDit: localQwenProfile ? undefined : expectedDit,
        resolvedDit: applied.unet,
        expectedTextEncoder: localQwenProfile ? undefined : expectedTextEncoder,
        resolvedTextEncoder: applied.textEncoder,
        expectedVae: localQwenProfile ? undefined : expectedVae,
        resolvedVae: applied.vae,
        explicitBase: request.checkpoint,
      });
      diagnostics.info('generation.preflight.passed', {
        jobId,
        profileId: profile?.id ?? null,
        baseCheckpoint: applied.checkpoint ?? null,
        pipeline: applied.pipeline ?? null,
        unet: applied.unet ?? null,
        textEncoder: applied.textEncoder ?? null,
        vae: applied.vae ?? null,
        willReloadBase: Boolean(applied.checkpointOverride),
      });
      const started = Date.now();
      const endpoint = request.images?.length ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img';
      diagnostics.info('generation.request.will_send', {
        jobId,
        method: 'POST',
        endpoint,
        mode,
        profileId: profile?.id ?? null,
        baseCheckpoint: applied.checkpoint ?? null,
        pipeline: applied.pipeline ?? null,
        unet: applied.unet ?? null,
      });
      let lastProgressMilestone = 0;
      const result = await client.generate(
        request,
        profile,
        (progress, eta, preview, stage) => {
          onProgress(progress, eta, preview, stage);
          if (typeof progress !== 'number') return;
          const milestone = Math.floor(progress * 4) * 25;
          if (milestone >= 25 && milestone > lastProgressMilestone) {
            lastProgressMilestone = milestone;
            diagnostics.info('generation.progress', { jobId, percent: Math.min(100, milestone), etaSeconds: eta ?? null });
          }
        },
        {
          checkpoint: applied.checkpointOverride,
          skipCheckpointOverride: !applied.checkpointOverride,
          restoreOverrideSettings: applied.restoreOverrideSettings,
          pipeline: applied.pipeline,
          unet: applied.unet,
          textEncoder: applied.textEncoder,
          vae: applied.vae,
        },
      );
      diagnostics.info('generation.request.completed', {
        jobId,
        durationMs: Date.now() - started,
        imageCount: result.images.length,
      });
      const loadedModel = await client.currentModel().catch((): Awaited<ReturnType<SdnextClient['currentModel']>> => ({}));
      const optionsAfter = await client.options().catch(() => undefined);
      requireProfileModels({
        expectedBase: profile?.engine?.checkpoint,
        resolvedBase: loadedModel.checkpoint,
        expectedDit: localQwenProfile ? undefined : expectedDit,
        resolvedDit: typeof optionsAfter?.sd_unet === 'string' ? optionsAfter.sd_unet : undefined,
        expectedTextEncoder: localQwenProfile ? undefined : expectedTextEncoder,
        resolvedTextEncoder:
          typeof optionsAfter?.sd_text_encoder === 'string' ? optionsAfter.sd_text_encoder : undefined,
        expectedVae: localQwenProfile ? undefined : expectedVae,
        resolvedVae: typeof optionsAfter?.sd_vae === 'string' ? optionsAfter.sd_vae : undefined,
      });
      if (loadedModel.class !== 'QwenImage21Pipeline') {
        throw new Error(
          `SD.Next reports the loaded pipeline as "${loadedModel.class ?? 'unknown'}", not Qwen Image 2.1. Velatura will not accept the image as a Qwen 2.1 result.`,
        );
      }
      const pipelineStayedSelected = optionsAfter?.diffusers_pipeline === applied.pipeline;
      if (!pipelineStayedSelected) {
        throw new Error(
          `SD.Next did not keep the requested "${applied.pipeline}" pipeline selection active for this session. Velatura will not accept the image as a Qwen 2.1 result.`,
        );
      }
      diagnostics.info('generation.postflight.passed', {
        jobId,
        checkpoint: loadedModel.checkpoint ?? null,
        pipeline: applied.pipeline ?? null,
        pipelineClass: loadedModel.class,
        originalSdnextConfigChanged: false,
        sessionConfigIsolated: true,
      });
      const params = result.parameters ?? {};
      const model = expectedDit ?? applied.unet;
      const baseModel = loadedModel.checkpoint ?? applied.checkpoint;
      const textEncoder = expectedTextEncoder ?? applied.textEncoder;
      const vae = expectedVae ?? applied.vae;
      // the hash of the DiT file, not the base checkpoint, makes the result reproducible
      const modelFile = model ? basename(model).toLowerCase() : undefined;
      const manifestEntry = modelFile
        ? manifest.models.find((m) => m.file.split('/').pop()?.toLowerCase() === modelFile)
        : undefined;
      // the quantisation, read from the installed file
      let quant: string | undefined;
      if (config.sdnextRoot && modelFile) {
        const path = join(slotDir(config.sdnextRoot, 'UNET'), modelFile);
        if (existsSync(path)) {
          const scan = await scanFile(path).catch(() => undefined);
          quant = scan?.quant;
        }
      }
      if (manifestEntry?.id === 'dit-turbo-sdnq-uint4') quant = 'SDNQ dynamic UINT4';
      else if (manifestEntry?.id === 'dit-turbo-bf16') quant = 'BF16';
      const provenance: Provenance = {
        model,
        baseModel,
        textEncoder,
        vae,
        modelSha256: manifestEntry?.sha256,
        quant,
        profile: profile?.id,
        steps: Number(params.steps ?? request.steps ?? profile?.steps ?? 0) || undefined,
        seed: Number.isFinite(Number(params.seed)) ? Number(params.seed) : request.seed,
        cfgScale: Number(
          (localQwenProfile || applied.pipeline === 'Qwen21')
            ? params.cfg_true ?? request.cfgScale ?? params.cfg_scale ?? profile?.sampling?.cfgScale
            : params.cfg_scale ?? profile?.sampling?.cfgScale,
        ) || undefined,
        sampler: (params.sampler_name as string) ?? profile?.sampling?.samplerName,
        size: Number(params.width ?? request.width ?? request.size ?? profile?.resolution) || undefined,
        width: Number(params.width ?? request.width ?? request.size ?? profile?.resolution) || undefined,
        height: Number(params.height ?? request.height ?? request.size ?? profile?.resolution) || undefined,
        hires: Boolean(params.enable_hr),
        detailer: Boolean(params.detailer_enabled),
        durationSeconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
        engine: 'SD.Next',
      };
      // the images are written here, on this machine: the interface shows
      // the real path, and the user can delete them when they want
      const files: Array<string | null> = [];
      for (const [index, image] of result.images.entries()) {
        const path = await saveImage(imageStoreDir, jobId, index, image).catch(() => undefined);
        files.push(path ?? null);
      }
      return { images: result.images, provenance, files };
    },
    (job) => {
      const mode = job.request.images?.length ? 'img2img' : 'txt2img';
      const summary = {
        jobId: job.id,
        state: job.state,
        profileId: job.provenance?.profile ?? activeProfile()?.id ?? null,
        mode,
        referenceCount: job.request.images?.length ?? 0,
        imageCount: job.images?.length ?? 0,
      };
      if (job.state === 'error') {
        diagnostics.error('queue.job.failed', {
          ...summary,
          error: safeJobError(job.error ?? 'Unknown job error', job.request),
        });
      } else {
        diagnostics.info('queue.job.finished', summary);
      }
      // one line per finished job: the history survives a restart.
      // The pictures are not written: a base64 image is megabytes, and the
      // history is a list of what was made, not a gallery.
      const { images: _out, request, ...rest } = job;
      const { images: _in, ...safeRequest } = request ?? { images: undefined };
      void history
        .append({ ...rest, request: safeRequest, imageCount: (job.images ?? []).length })
        .catch((err) => diagnostics.warn('history.write.failed', { message: err instanceof Error ? err.message : 'unknown error' }));
    },
  );

  // ---- auth ---------------------------------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1')) return;
    if (request.url.startsWith('/api/v1/health')) return;
    const provided =
      (request.headers['x-velatura-token'] as string | undefined) ??
      (request.query as { token?: string } | undefined)?.token;
    if (provided !== token) {
      await reply.code(401).send({ error: 'invalid or missing session token' });
    }
  });

  // ---- API ----------------------------------------------------------------
  app.get('/api/v1/health', async () => {
    const status = await client.status();
    const hardware = await detectHardware().catch(() => undefined);
    return {
      ok: true,
      name: 'Velatura',
      tagline: 'Velatura',
      version: '0.1.4',
      queue: {
        depth: queue.list().filter((j) => j.state === 'queued' || j.state === 'running').length,
        running: queue.list().some((j) => j.state === 'running'),
      },
      hardware: hardware
        ? {
            gpu: hardware.gpus[0]?.name,
            vramGb: hardware.gpus[0]?.vramGb,
            totalMemGb: hardware.totalMemGb,
          }
        : undefined,
      sdnext: {
        url: sdnextUrl,
        ready: status.ready,
        error: status.error,
        starting: Boolean(engineBoot),
        managed: Boolean(managed),
        /** the checkpoint SD.Next itself reports as currently loaded */
        model: status.ready ? await client.currentCheckpoint().catch(() => undefined) : undefined,
        /** the base checkpoint selected by the active profile; not a load confirmation */
        selectedBaseModel: profileCheckpoint,
        /** the profile in use, adapted or not */
        profile: activeProfile()?.id,
        /** local Qwen reference setup state; not evidence of successful generation */
        profilePreparation: qwenReferenceStatus,
      },
      sdnextRoot: config.sdnextRoot ?? null,
      profiles: profiles.length,
      manifestEntries: manifest.models.length,
    };
  });

  /**
   * The privacy promise, kept in one place: "delete all the data".
   * The model files are deleted only when the user asks for it.
   */
  app.post('/api/v1/forget', async (request) => {
    const body = (request.body ?? {}) as { models?: boolean };
    if (ggufInstallInProgress) {
      return { deleted: [], failed: ['GGUF support installation is still running; retry after it finishes.'], models: Boolean(body.models) };
    }
    diagnostics.info('privacy.forget.started', { deleteModels: Boolean(body.models) });
    const deleted: string[] = [];
    // what could not be deleted: on Windows a file that another program has
    // open stays where it is, and the user has to know it
    const failed: string[] = [];

    // the pictures too: they are the biggest thing Velatura writes
    const cleared = await clearImages(imageStoreDir);
    if (cleared.deleted > 0) {
      deleted.push(`${imageStoreDir} (${cleared.deleted} images)`);
      // and the copies the session still holds in memory
      for (const path of cleared.paths) queue.releaseImage(path);
    }

    for (const file of [
      configPath(),
      join(configDir(), 'history.jsonl'),
      join(configDir(), 'session.json'),
      join(configDir(), 'packages', GGUF_PACKAGE.filename),
      join(configDir(), 'packages', `${GGUF_PACKAGE.filename}.part`),
    ]) {
      if (existsSync(file)) {
        try {
          await rm(file, { force: true });
          deleted.push(file);
        } catch {
          failed.push(file);
        }
      }
    }

    if (body.models && config.sdnextRoot) {
      for (const entry of manifest.models) {
        for (const file of knownFilesFor(entry)) {
          const path = join(slotDir(config.sdnextRoot, entry.dest), file.split('/').pop()!);
          if (existsSync(path)) {
            try {
              await rm(path, { force: true });
              deleted.push(path);
            } catch {
              failed.push(path);
            }
          }
        }
      }
    }
    if (body.models) {
      try {
        deleted.push(...await removeManagedQwenTurboReferences(configDir()));
      } catch {
        failed.push('Velatura-managed Qwen Turbo reference folders');
      }
      for (const path of [qwenTurboTokenizerPath(configDir()), `${qwenTurboTokenizerPath(configDir())}.part`]) {
        if (!existsSync(path)) continue;
        try {
          await rm(path, { force: true });
          deleted.push(path);
        } catch {
          failed.push(path);
        }
      }
      const hfCache = qwenTurboHfCacheDir(configDir());
      if (existsSync(hfCache)) {
        try {
          await rm(hfCache, { recursive: true, force: true });
          deleted.push(hfCache);
        } catch {
          failed.push(hfCache);
        }
      }
    }

    // back to a first start
    Object.assign(config, DEFAULT_CONFIG);
    await saveConfig(config);
    const clearedLogs = await diagnostics.clear();
    deleted.push(...clearedLogs.deleted);
    failed.push(...clearedLogs.failed);
    return { deleted, failed, models: Boolean(body.models) };
  });

  app.get('/api/v1/config', async () => {
    if (!config.setupCompleted && config.sdnextRoot && validateSdnextRoot(config.sdnextRoot).ok) {
      const selectedProfile = activeProfile();
      if (selectedProfile) {
        const states = await modelStates(config.sdnextRoot, manifest.models);
        const requiredIds = new Set(selectedProfile.models.map((m) => m.manifestId));
        const requiredStates = states.filter((m) => requiredIds.has(m.entry.id) && m.entry.required !== false);
        if (requiredStates.length > 0 && requiredStates.every((m) => m.status === 'installed')) {
          config.setupCompleted = true;
          await saveConfig(config).catch(() => undefined);
        }
      }
    }
    const { hfToken: _omit, ...safe } = config;
    return safe;
  });

  app.post('/api/v1/config', async (request) => {
    const body = (request.body ?? {}) as Partial<VelaturaConfig>;
    Object.assign(config, body);
    await saveConfig(config);
    const { hfToken: _omit, ...safe } = config;
    return safe;
  });

  app.get('/api/v1/manifest', async () => manifest);

  /**
   * Where everything is, on this machine.
   *
   * The interface shows these paths: the user must always be able to see
   * what Velatura wrote, where, and how much it takes.
   */
  app.get('/api/v1/paths', async () => {
    const store = await imageStore(imageStoreDir);
    const root = config.sdnextRoot;
    const modelFiles: Array<{
      slot: string;
      path: string;
      folder: string;
      sizeBytes: number;
      manifestId: string | null;
    }> = [];
    if (root) {
      // what the manifest says, and what is really on the disk: a file the
      // user placed by hand has to show up too
      const expected = new Map<string, string>();
      for (const entry of manifest.models) {
        for (const file of knownFilesFor(entry)) {
          // the name on the disk can differ in case: the match is forgiving
          expected.set(`${entry.dest}/${file.split('/').pop()!}`.toLowerCase(), entry.id);
        }
      }
      for (const slot of ['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]) {
        const dir = slotDir(root, slot);
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names.sort()) {
          if (name.endsWith('.part')) continue;
          const path = join(dir, name);
          const info = await stat(path).catch(() => undefined);
          if (!info?.isFile()) continue;
          modelFiles.push({
            slot,
            path,
            folder: dirname(path),
            sizeBytes: info.size,
            manifestId: expected.get(`${slot}/${name}`.toLowerCase()) ?? null,
          });
        }
      }
    }
    const partials = root
      ? await findPartials(
          (['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]).map((slot) => slotDir(root, slot)),
        )
      : [];

    return {
      install: {
        app: appFolder(),
        config: configPath(),
        history: join(configDir(), 'history.jsonl'),
        images: imageStoreDir,
        logs: velaturaLogDirectory(),
        logFile: diagnostics.filePath,
        sdnext: root ?? null,
      },
      images: {
        dir: store.dir,
        count: store.count,
        totalBytes: store.totalBytes,
        files: store.images.map((image) => ({
          path: image.path,
          // the folder that holds it: the browser must not guess it, the
          // separator is not the same on every system
          folder: dirname(image.path),
          name: image.name,
          sizeBytes: image.sizeBytes,
          modifiedAt: image.modifiedAt,
        })),
      },
      modelFiles,
      partials,
    };
  });

  /**
   * Open a folder in the file manager of the system.
   *
   * Only the folders Velatura owns are allowed: the request is checked
   * twice, and an unknown path is refused.
   */
  app.post('/api/v1/open', async (request) => {
    const body = (request.body ?? {}) as { path?: string };
    if (!body.path) return { error: 'path is required' };
    const allowed = [resolve(configDir()), resolve(imageStoreDir)];
    if (config.sdnextRoot) allowed.push(resolve(config.sdnextRoot));
    const target = resolve(body.path);
    if (!allowed.some((root) => target === root || target.startsWith(root + sep))) {
      return { error: 'that folder does not belong to Velatura' };
    }
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try {
      const child = spawn(opener, [target], { detached: true, stdio: 'ignore' });
      child.unref();
      return { opened: target };
    } catch (err) {
      return { error: `the folder could not be opened: ${(err as Error).message}` };
    }
  });

  /** Delete one image of the local store. */
  app.delete('/api/v1/images', async (request) => {
    const body = (request.body ?? {}) as { path?: string };
    if (!body.path) return { error: 'path is required' };
    const result = await deleteImage(imageStoreDir, body.path);
    if (!result.ok) return result;
    // the file is gone: the copy in memory goes with it, and the history
    // stops pointing at a picture that does not exist any more
    const released = queue.releaseImage(body.path);
    await forgetPathInHistory(body.path);
    return { ...result, released };
  });

  /** Delete every image of the local store. */
  app.post('/api/v1/images/clear', async () => {
    const cleared = await clearImages(imageStoreDir);
    const released: string[] = [];
    for (const path of cleared.paths) {
      released.push(...queue.releaseImage(path));
      await forgetPathInHistory(path);
    }
    return { deleted: cleared.deleted, dir: imageStoreDir, released };
  });

  /**
   * The partial files of the interrupted downloads.
   *
   * They are not pictures: they are the beginning of a model file. They
   * are safe to delete — the download simply starts again.
   */
  app.post('/api/v1/partials/clear', async () => {
    const root = config.sdnextRoot;
    if (!root) return { deleted: 0, files: [] };
    const dirs = (['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]).map((slot) =>
      slotDir(root, slot),
    );
    const partials = await findPartials(dirs);
    const deleted: string[] = [];
    for (const partial of partials) {
      await secureShredFile(partial.path);
      deleted.push(partial.path);
    }
    return { deleted: deleted.length, files: deleted };
  });

  app.get('/api/v1/profiles', async () => profiles);

  /**
   * The profile adapted to the files already installed.
   * The UI shows it as a note: "this profile fits what you already own".
   */
  app.get('/api/v1/profiles/derived', async () => {
    await refreshDerivedProfile();
    if (!derived) return { derived: null };
    return {
      derived: {
        id: derived.profile.id,
        label: derived.profile.label,
        steps: derived.profile.steps,
        vramGb: derived.profile.vramGb,
        notes: derived.notes,
        dit: derived.dit,
      },
    };
  });

  // ---- setup wizard --------------------------------------------------------
  app.get('/api/v1/setup/state', async () => {
    const { hfToken: _omit, ...safeConfig } = config;
    const validation = config.sdnextRoot ? validateSdnextRoot(config.sdnextRoot) : undefined;
    const candidates = await detectSdnextRootCandidates();
    const selectedProfile = activeProfile();
    const baseName = selectedProfile?.engine?.checkpoint;
    const qwenVariant = profileQwenVariant(selectedProfile);
    const engineStatus = await client.status();
    const engineModels = engineStatus.ready ? await client.models(true).catch(() => [] as string[]) : [];
    const loadedModel: { checkpoint?: string; class?: string; type?: string } = engineStatus.ready
      ? await client.currentModel().catch((): Awaited<ReturnType<SdnextClient['currentModel']>> => ({}))
      : {};
    const managedReference = Boolean(qwenVariant);
    const originalDiffusersDir = managed?.sessionConfig?.originalConfig.diffusers_dir;
    const originalHfCacheDir = managed?.sessionConfig?.originalConfig.hfcache_dir;
    const qwenTurboSupport = await getQwenTurboSupportState(
      configDir(),
      qwenTurboSearchRoots(config.sdnextRoot, originalDiffusersDir, originalHfCacheDir),
    );
    const qwenGgufCompatRequired = profileRequiresGguf(activeProfile());
    const qwenGgufCompatInstalled = qwenGgufCompatRequired && config.sdnextRoot
      ? await hasQwen21GgufCompat(config.sdnextRoot)
      : false;
    const qwenGgufCompat = {
      required: qwenGgufCompatRequired,
      installed: qwenGgufCompatInstalled,
      active: qwenGgufCompatActive,
      restartRequired: Boolean(engineStatus.ready && qwenGgufCompatRequired && !qwenGgufCompatActive),
    };
    const baseModel = baseName
      ? {
          name: qwenVariant ? QWEN_TURBO_VARIANTS[qwenVariant].label : baseName,
          variant: qwenVariant,
          engineReady: engineStatus.ready,
          listed: Boolean(matchExactModel(baseName, engineModels)),
          loaded: Boolean(loadedModel.checkpoint && matchExactModel(baseName, [loadedModel.checkpoint])),
          loadedClass: loadedModel.class,
          managedReference,
          referencePrepared: qwenVariant ? await hasManagedQwenTurboReference(configDir(), qwenVariant) : false,
        }
      : null;
    const models = await modelStates(config.sdnextRoot, manifest.models);
    if (!config.setupCompleted && validation?.ok && selectedProfile) {
      const requiredIds = new Set(
        selectedProfile.models.map((m) => m.manifestId),
      );
      const requiredStates = models.filter((m) => requiredIds.has(m.entry.id) && m.entry.required !== false);
      if (requiredStates.length > 0 && requiredStates.every((m) => m.status === 'installed')) {
        config.setupCompleted = true;
        safeConfig.setupCompleted = true;
        await saveConfig(config).catch(() => undefined);
      }
    }
    return {
      config: safeConfig,
      sdnextRoot: config.sdnextRoot ?? null,
      defaultSdnextRoot: defaultSdnextRoot(),
      validation: validation ?? null,
      candidates: candidates.map((candidate) => ({ ...candidate, validation: validateSdnextRoot(candidate.root) })),
      hardware: await detectHardware(),
      profiles,
      derived: derived
        ? { id: derived.profile.id, steps: derived.profile.steps, vramGb: derived.profile.vramGb, notes: derived.notes, dit: derived.dit }
        : null,
      baseModel,
      qwenTurboSupport,
      qwenGgufCompat,
      models,
    };
  });

  /**
   * Install SD.Next only after Setup explicitly confirms it: fetch the
   * selected repository target (the temporary option is pinned to an exact
   * commit), then let SD.Next's own startup script build its environment.
   */
  app.get('/api/v1/setup/engine/requirements', async () => {
    const installTargets = [
      {
        id: 'repository-default',
        label: 'SD.Next official master branch (recommended)',
        branch: 'master',
        commit: undefined,
        referenceDate: undefined,
      },
    ];
    return { ...(await checkEngineRequirements()), defaultDir: defaultSdnextRoot(), installTargets };
  });

  app.get('/api/v1/setup/engine/install', async () => {
    return engineInstallState() ?? { running: false, dir: '', phase: 'done', log: [] };
  });

  app.post('/api/v1/setup/engine/install', async (request) => {
    const body = (request.body ?? {}) as { dir?: unknown; target?: unknown };
    const requestedTarget = body.target ?? 'repository-default';
    if (
      typeof requestedTarget !== 'string' ||
      !Object.prototype.hasOwnProperty.call(SDNEXT_INSTALL_TARGETS, requestedTarget)
    ) {
      return { error: 'Unsupported SD.Next version selection. Reload Setup and choose one of the listed install targets.' };
    }
    const installTargetId = requestedTarget as SdnextInstallTargetId;
    if (engineInstallState()?.running) return { alreadyRunning: true, state: engineInstallState() };
    if (managed) return { error: 'SD.Next is already running. Select its folder and continue setup instead.' };
    const configuredUrlIsActive = config.sdnextUrl ? await engineResponds(config.sdnextUrl) : false;
    const activeUrl = configuredUrlIsActive ? config.sdnextUrl : await detectSdnextUrl();
    if (activeUrl) {
      return { error: `SD.Next is already responding at ${activeUrl}. Enter its folder and check it instead of installing another copy.` };
    }

    const requestedDir = typeof body.dir === 'string' ? body.dir : '';
    const dir = normalizeSdnextRootPath(requestedDir || defaultSdnextRoot());
    const target = await validateEngineInstallTarget(dir);
    if (!target.ok) return { error: target.error, dir: target.dir };

    // The user has explicitly confirmed this destination by starting the install.
    // Persist it so a restart can recover the folder if the first run is interrupted.
    config.sdnextRoot = target.dir;
    await saveConfig(config);

    const launch = await engineLaunch(target.dir, 'bootstrap');
    let runtimeIsolation: IsolatedSdnextConfig | undefined;
    let installQwenCompat: Qwen21GgufCompatInstall | undefined;
    const state = installSdnext(
      target.dir,
      (line) => emitEvent({ type: 'engine-log', line }),
      launch.args,
      async (bootstrapEngine, readyState) => {
        let activeEngine = bootstrapEngine;
        let activeLaunch = launch;
        if (launch.bootstrap) {
          const promoted = await promoteQwenBootstrap(target.dir, bootstrapEngine, launch, (line) => {
            readyState.log.push(line);
            if (readyState.log.length > 500) readyState.log.shift();
            emitEvent({ type: 'engine-log', line });
          });
          activeEngine = promoted.engine;
          activeLaunch = promoted.launch;
          runtimeIsolation = promoted.launch.isolation;
        }
        managed = trackManagedEngine(
          activeEngine,
          readyState.log,
          activeLaunch.isolation,
          activeLaunch.qwenGgufCompat ?? installQwenCompat,
        );
        sdnextUrl = activeEngine.url;
        client = createSdnextClient(activeEngine.url);
        engineWasReady = true;
        return activeEngine;
      },
      async (error) => {
        const cleanupResults = await Promise.all(
          [launch.isolation, runtimeIsolation].filter((isolation): isolation is IsolatedSdnextConfig => Boolean(isolation))
            .map((isolation) => discardIsolatedSdnextConfig(isolation)),
        );
        if (installQwenCompat) await removeQwen21GgufCompat(installQwenCompat.root).catch(() => false);
        diagnostics[cleanupResults.every(Boolean) ? 'info' : 'warn'](
          cleanupResults.every(Boolean) ? 'sdnext.install.session-config.discarded' : 'sdnext.install.session-config.cleanup-failed',
          { errorType: error.name, discardedConfigs: cleanupResults.length },
        );
      },
      async () => {
        installQwenCompat = await prepareQwen21GgufCompat(target.dir, activeProfile());
      },
      installTargetId,
    );
    return { started: true, state };
  });

  app.post('/api/v1/setup/sdnext', async (request) => {
    const body = (request.body ?? {}) as { root?: string };
    if (!body.root?.trim()) return { error: 'root is required' };
    const root = normalizeSdnextRootPath(body.root);
    const validation = validateSdnextRoot(root);
    if (!validation.ok) return { validation, saved: false };
    config.sdnextRoot = root;
    await saveConfig(config);
    if (!config.sdnextUrl) {
      const detected = await detectSdnextUrl();
      if (detected) {
        sdnextUrl = detected;
        client = createSdnextClient(detected);
      }
    }
    return { validation, saved: true };
  });

  app.post('/api/v1/setup/profile', async (request) => {
    const body = (request.body ?? {}) as { profileId?: string };
    const profile = profiles.find((p) => p.id === body.profileId);
    if (!profile) return { error: `unknown profile "${body.profileId}"` };
    config.profileId = profile.id;
    await saveConfig(config);
    const engineStatus = await client.status();
    if (engineStatus.ready && profileRequiresGguf(profile) && !qwenGgufCompatActive) {
      if (config.sdnextRoot) await prepareQwen21GgufCompat(config.sdnextRoot, profile);
      return { profileId: config.profileId, applied: false, restartRequired: true };
    }
    // Validate against SD.Next; when a different base is active, the
    // generation request applies components before switching the base.
    const applied = await applyProfileToEngine(profile);
    return { profileId: config.profileId, ...applied };
  });

  /**
   * The test drive: one real image, with the active profile.
   * It is the last level of verification (V4) and the first real measurement
   * of the seconds/edit of this machine.
   */
  app.post('/api/v1/setup/test-render', async (request) => {
    const body = (request.body ?? {}) as { prompt?: string; size?: number; steps?: number };
    const profile = activeProfile();
    const prompt = body.prompt?.trim() || 'a small studio, soft light, 35mm';
    const size = body.size ?? 512;
    const steps = body.steps ?? Math.min(8, profile?.steps ?? 8);
    const job = queue.submit({ prompt, steps, size, mode: 'txt2img' });
    diagnostics.info('setup.test-render.submitted', { jobId: job.id, profileId: profile?.id ?? null, steps, size });
    // Return immediately. The UI follows the normal queue events, including
    // SD.Next startup and first-time component-loading phases; no HTTP request
    // is held open while the text encoder is loaded.
    return { jobId: job.id, createdAt: job.createdAt, steps, size, profile: profile?.id };
  });

  app.post('/api/v1/setup/finalize', async () => {
    config.setupCompleted = true;
    await saveConfig(config);
    return { ok: true, profileId: config.profileId };
  });

  app.post('/api/v1/setup/verify', async () => {
    const profile = activeProfile();
    const selectedEntries = profile
      ? profile.models
          .map((item) => manifest.models.find((entry) => entry.id === item.manifestId))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      : manifest.models;
    const states = await modelStates(config.sdnextRoot, selectedEntries);
    const report: Array<{
      id: string;
      label: string;
      status: string;
      required: boolean;
      path?: string;
      sizeOk?: boolean;
      shaOk?: boolean;
      expectedSha256?: string;
      actualSha256?: string;
      problems: string[];
    }> = [];

    for (const state of states) {
      if (state.status === 'missing') {
        report.push({
          id: state.entry.id,
          label: state.entry.label,
          status: 'missing',
          required: state.entry.required !== false,
          problems: [],
        });
        continue;
      }
      const expectation = expectationFor(state.entry, state.expectedFile);
      // hashing a 14 GB file takes a while: the interface is told what
      // is being read, so the wait is not a mystery
      emitEvent({
        type: 'verify',
        id: state.entry.id,
        label: state.entry.label,
        bytes: 0,
        total: state.sizeBytes ?? 0,
      });
      const verification = await verifyFile(state.installedPath!, expectation, (bytes, total) => {
        emitEvent({
          type: 'verify',
          id: state.entry.id,
          label: state.entry.label,
          bytes,
          total,
        });
      });
      const problems = [
        ...(state.scan?.reasons ?? []),
        ...verification.notes.filter((n) => !n.startsWith('no known sha256')),
      ];
      report.push({
        id: state.entry.id,
        label: state.entry.label,
        status: state.status,
        required: state.entry.required !== false,
        path: state.installedPath,
        sizeOk: verification.sizeOk,
        shaOk: verification.expectedSha256 ? verification.shaOk : undefined,
        expectedSha256: verification.expectedSha256,
        actualSha256: verification.actualSha256,
        problems,
      });
    }
    return { report };
  });

  app.get('/api/v1/models/scan', async () => {
    const results: ScanResult[] = [];
    if (config.sdnextRoot) {
      for (const slot of ['UNET', 'Text-encoder', 'VAE', 'Lora'] as SdnextSlot[]) {
        const dir = slotDir(config.sdnextRoot, slot);
        if (!existsSync(dir)) continue;
        const hits = await scanForeignInstalls([{ label: 'sdnext', root: config.sdnextRoot }], ['.gguf', '.safetensors']);
        void hits;
        const entries = await readdir(dir).catch(() => [] as string[]);
        for (const entry of entries) {
          if (!/\.(gguf|safetensors)$/i.test(entry)) continue;
          const path = join(dir, entry);
          results.push(await scanFile(path));
        }
      }
    }
    const foreign = await scanForeignInstalls(foreignInstallCandidates());
    const foreignScans: Array<ScanResult & { install: string }> = [];
    for (const hit of foreign) {
      const scan = await scanFile(hit.path);
      foreignScans.push({ ...scan, install: hit.install });
    }
    return { installed: results, foreign: foreignScans };
  });

  app.post('/api/v1/models/check-placement', async (request) => {
    const body = (request.body ?? {}) as { manifestId?: string; profileId?: string };
    if (!body.manifestId) return { error: 'manifestId is required' };
    if (!config.sdnextRoot) return { error: 'SD.Next is not configured yet' };
    const entry = manifest.models.find((model) => model.id === body.manifestId);
    if (!entry) return { error: `unknown manifest id \"${body.manifestId}\"` };
    const profile = profiles.find((item) => item.id === (body.profileId ?? config.profileId));
    const selected = profile?.models.find((item) => item.manifestId === entry.id);
    const profileEntry = selected?.file ? { ...entry, file: selected.file } : entry;
    const state = await modelState(config.sdnextRoot, profileEntry);
    return {
      status: state.status,
      expectedFile: state.expectedFile,
      targetPath: state.targetPath,
      installedPath: state.installedPath,
      scan: state.scan
        ? { role: state.scan.role, variant: state.scan.variant, quant: state.scan.quant, compatible: state.scan.compatible, reasons: state.scan.reasons }
        : undefined,
      conflicts: state.conflicts,
    };
  });

  app.post('/api/v1/models/verify', async (request) => {
    const body = (request.body ?? {}) as { path?: string; manifestId?: string; file?: string };
    if (!body.path) return { error: 'path is required' };
    const entry: ManifestEntry | undefined = body.manifestId
      ? manifest.models.find((m) => m.id === body.manifestId)
      : undefined;
    const expectation = entry
      ? expectationFor(entry, body.file ?? entry.file)
      : { sizeBytes: undefined, sha256: undefined };
    const verification = await verifyFile(body.path, expectation);
    const scan = await scanFile(body.path);
    return { verification, scan };
  });

  app.post('/api/v1/models/import', async (request) => {
    const body = (request.body ?? {}) as {
      path?: string;
      slot?: SdnextSlot;
      mode?: PlacementMode;
      fileName?: string;
    };
    if (!body.path) return { error: 'path is required' };
    if (!config.sdnextRoot) return { error: 'SD.Next is not configured yet' };
    const slot = body.slot ?? 'UNET';
    const mode = body.mode ?? config.placementMode;
    const plan = await planPlacement({
      source: body.path,
      sdnextRoot: config.sdnextRoot,
      slot,
      mode,
      fileName: body.fileName,
    });
    const result = await applyPlacement(plan);
    return { plan, result };
  });

  // ---- downloads ----------------------------------------------------------
  interface DownloadState {
    id: string;
    manifestId: string;
    label: string;
    file: string;
    dest: string;
    bytes: number;
    total?: number;
    /** bytes per second, measured over the last interval */
    speed?: number;
    /** seconds left, from the measured speed */
    etaSeconds?: number;
    state: 'running' | 'done' | 'error';
    error?: string;
    sha256?: string;
    /** when the download started, to measure the speed */
    startedAt?: number;
  }
  const downloads = new Map<string, DownloadState>();

  app.get('/api/v1/models/downloads', async () => ({ downloads: [...downloads.values()] }));

  let qwenSupportDownloadRunning = false;
  app.post('/api/v1/qwen/turbo-support/fetch', async (request) => {
    const body = (request.body ?? {}) as { confirm?: boolean; acceptLicense?: boolean };
    if (body.confirm !== true || body.acceptLicense !== true) {
      return { error: 'Review the displayed Qwen Research License and explicitly confirm before downloading this support file.' };
    }
    if (qwenSupportDownloadRunning) return { error: 'The Qwen Turbo support file is already downloading.' };

    const support = await getQwenTurboSupportState(
      configDir(),
      qwenTurboSearchRoots(
        config.sdnextRoot,
        managed?.sessionConfig?.originalConfig.diffusers_dir,
        managed?.sessionConfig?.originalConfig.hfcache_dir,
      ),
    );
    if (support.ready) return { ready: true, path: support.path, sha256: support.sha256, alreadyPresent: true };

    qwenSupportDownloadRunning = true;
    const id = randomUUID();
    const target = qwenTurboTokenizerPath(configDir());
    const publish = (state: 'running' | 'done' | 'error', bytes: number, error?: string, sha256?: string) =>
      emitEvent({
        type: 'download',
        download: {
          id,
          manifestId: QWEN_TURBO_TOKENIZER.id,
          label: 'Qwen Turbo processor tokenizer',
          file: QWEN_TURBO_TOKENIZER.file,
          dest: target,
          bytes,
          total: QWEN_TURBO_TOKENIZER.sizeBytes,
          state,
          error,
          sha256,
        },
      });

    diagnostics.info('qwen.turbo.support.download.started', {
      repo: QWEN_TURBO_TOKENIZER.repo,
      revision: QWEN_TURBO_TOKENIZER.revision,
      file: QWEN_TURBO_TOKENIZER.file,
      sizeBytes: QWEN_TURBO_TOKENIZER.sizeBytes,
      sha256: QWEN_TURBO_TOKENIZER.sha256,
      license: QWEN_TURBO_TOKENIZER.license,
    });
    try {
      await mkdir(dirname(target), { recursive: true });
      const result = await downloadFile(
        QWEN_TURBO_TOKENIZER.repo,
        QWEN_TURBO_TOKENIZER.revision,
        QWEN_TURBO_TOKENIZER.file,
        target,
        {
          mirror: config.mirror,
          token: config.hfToken,
          expectedBytes: QWEN_TURBO_TOKENIZER.sizeBytes,
          expectedSha256: QWEN_TURBO_TOKENIZER.sha256,
          onProgress: (bytes) => publish('running', bytes),
        },
      );
      publish('done', result.bytes, undefined, result.sha256);
      diagnostics.info('qwen.turbo.support.download.completed', {
        bytes: result.bytes,
        sha256: result.sha256,
        path: result.path,
      });
      return { ready: true, path: result.path, sha256: result.sha256, bytes: result.bytes };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown download error';
      let partialBytes = 0;
      try {
        partialBytes = (await stat(`${target}.part`)).size;
      } catch {
        /* no resumable partial */
      }
      publish('error', partialBytes, message);
      diagnostics.warn('qwen.turbo.support.download.failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        partialBytes,
      });
      return { error: message, partialBytes };
    } finally {
      qwenSupportDownloadRunning = false;
    }
  });

  app.post('/api/v1/models/fetch', async (request) => {
    const body = (request.body ?? {}) as { manifestId?: string; file?: string };
    if (!body.manifestId) return { error: 'manifestId is required' };
    const entry = manifest.models.find((m) => m.id === body.manifestId);
    if (!entry) return { error: `unknown manifest id "${body.manifestId}"` };
    if (!config.sdnextRoot) return { error: 'SD.Next is not configured yet' };

    const fileName = body.file ?? entry.file;
    const target = join(slotDir(config.sdnextRoot, entry.dest), fileName.split('/').pop()!);
    const id = randomUUID();

    const state: DownloadState = {
      id,
      manifestId: entry.id,
      label: entry.label,
      file: fileName,
      dest: target,
      bytes: 0,
      total: entry.sizeBytes,
      state: 'running',
    };
    state.startedAt = Date.now();
    let firstSample = true;
    let lastSampleAt = Date.now();
    let lastSampleBytes = 0;
    downloads.set(id, state);
    const publish = () => emitEvent({ type: 'download', download: { ...state } });

    void (async () => {
      try {
        const result = await downloadFile(entry.repo, entry.revision, fileName, target, {
          expectedSha256: entry.sha256,
          mirror: config.mirror,
          token: config.hfToken,
          expectedBytes: entry.sizeBytes,
          onProgress: (bytes, total) => {
            const now = Date.now();
            state.bytes = bytes;
            if (total) state.total = total;
            // the speed is measured between two samples: with a resumed
            // download the first sample already carries the old bytes
            const seconds = (now - lastSampleAt) / 1000;
            if (firstSample) {
              firstSample = false;
              lastSampleAt = now;
              lastSampleBytes = bytes;
            } else if (seconds > 0.4) {
              state.speed = Math.round((bytes - lastSampleBytes) / seconds);
              lastSampleAt = now;
              lastSampleBytes = bytes;
              if (state.total && state.total > bytes) {
                state.etaSeconds = Math.round((state.total - bytes) / Math.max(1, state.speed));
              }
            }
            publish();
          },
        });
        state.bytes = result.bytes;
        state.sha256 = result.sha256;
        if (entry.sha256 && result.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
          state.state = 'error';
          state.error = `sha256 mismatch: got ${result.sha256}, expected ${entry.sha256}`;
        } else {
          state.state = 'done';
        }
      } catch (err) {
        state.state = 'error';
        state.error = (err as Error).message;
      }
      publish();
      void refreshDerivedProfile();
    })();

    return { id, state };
  });

  /**
   * Install the whole profile: every component, one after the other.
   * The licence of every file is returned *before* anything is downloaded,
   * so the interface can show it and ask for a confirmation.
   */
  app.post('/api/v1/models/bundle/plan', async (request) => {
    const body = (request.body ?? {}) as { profileId?: string };
    const profile = profiles.find((p) => p.id === (body.profileId ?? config.profileId));
    if (!profile) return { error: 'unknown profile' };
    const items = profile.models.map((m) => {
      const entry = manifest.models.find((x) => x.id === m.manifestId);
      if (!entry) return { role: m.role, manifestId: m.manifestId, error: 'not in the manifest' };
      return {
        role: m.role,
        manifestId: entry.id,
        label: entry.label,
        repo: entry.repo,
        revision: entry.revision,
        file: m.file ?? entry.file,
        dest: entry.dest,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        license: entry.license,
        licenseUrl: entry.licenseUrl,
      };
    });
    return {
      profile: { id: profile.id, label: profile.label, description: profile.description },
      items,
      totalBytes: items.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0),
    };
  });

  app.post('/api/v1/models/bundle', async (request) => {
    const body = (request.body ?? {}) as { profileId?: string };
    const profile = profiles.find((p) => p.id === (body.profileId ?? config.profileId));
    if (!profile) return { error: 'unknown profile' };
    const root = config.sdnextRoot;
    if (!root) return { error: 'SD.Next is not configured yet' };

    const id = randomUUID();
    const state = {
      id,
      profileId: profile.id,
      label: profile.label,
      state: 'running' as 'running' | 'done' | 'error',
      current: '',
      done: 0,
      total: profile.models.length,
      error: undefined as string | undefined,
    };
    downloads.set(id, {
      id,
      manifestId: `bundle:${profile.id}`,
      label: `Bundle ${profile.label}`,
      file: '',
      dest: root,
      bytes: 0,
      state: 'running',
    });
    const publish = () => emitEvent({ type: 'bundle', bundle: { ...state } });

    void (async () => {
      try {
        // the whole bundle is checked at once: failing on the last file
        // after ten gigabytes of download is a bad way to say "no room"
        const wanted = profile.models
          .map((item) => manifest.models.find((x) => x.id === item.manifestId))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
        const totalBytes = wanted.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
        if (totalBytes > 0) {
          const space = await checkDiskSpace(join(root, 'models', 'UNET', 'bundle'), totalBytes);
          if (!space.ok) throw new Error(space.problem);
        }

        for (const [index, item] of profile.models.entries()) {
          const entry = manifest.models.find((x) => x.id === item.manifestId);
          if (!entry) continue;
          const fileName = item.file ?? entry.file;
          state.current = fileName;
          publish();
          const target = join(slotDir(root, entry.dest), fileName.split('/').pop()!);
          const result = await downloadFile(entry.repo, entry.revision, fileName, target, {
            expectedSha256: entry.sha256,
            mirror: config.mirror,
            token: config.hfToken,
            expectedBytes: entry.sizeBytes,
            onProgress: (bytes, total) => {
              const item = downloads.get(id);
              if (item) {
                item.bytes = bytes;
                item.total = total;
              }
              publish();
            },
          });
          if (entry.sha256 && result.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
            throw new Error(`${fileName}: sha256 mismatch (got ${result.sha256})`);
          }
          state.done = index + 1;
          publish();
        }
        state.state = 'done';
      } catch (err) {
        state.state = 'error';
        state.error = (err as Error).message;
      }
      const item = downloads.get(id);
      if (item) item.state = state.state === 'done' ? 'done' : 'error';
      publish();
    })();

    return { id, state };
  });

  app.get('/api/v1/sdnext/status', async () => {
    const status = await client.status();
    return { ...status, url: sdnextUrl, managed: Boolean(managed) };
  });

  app.get('/api/v1/sdnext/gguf-support', async () => {
    const profile = activeProfile();
    if (!profileRequiresGguf(profile)) return { required: false, status: 'not-required' };
    const support = await ggufSupportForProfile(profile);
    return support ? { required: true, ...support } : { required: false, status: 'not-required' };
  });

  app.post('/api/v1/sdnext/gguf/install', async (request) => {
    const body = (request.body ?? {}) as { consent?: boolean };
    if (body.consent !== true) return { error: 'Explicit consent is required before downloading or installing GGUF support.' };
    if (ggufInstallInProgress) return { error: 'A GGUF support installation is already in progress.' };
    if (engineBoot) return { error: 'SD.Next is still starting. Wait for it to finish before installing GGUF support.' };
    const profile = activeProfile();
    if (!profileRequiresGguf(profile)) return { error: 'The selected profile does not require GGUF support.' };
    const root = config.sdnextRoot;
    if (!root) return { error: 'Choose the SD.Next installation folder in Setup before installing GGUF support.' };

    ggufInstallInProgress = true;
    try {
      const before = await inspectGgufSupport(root);
      if (before.status === 'ready') return { installed: false, support: before };
      if (before.status !== 'missing') return { error: ggufSupportMessage(before), support: before };

      const engineStatus = await client.status();
      if (managed) {
        await managed.stop();
        managed = undefined;
        engineWasReady = false;
      } else if (engineStatus.ready) {
        return {
          error: 'SD.Next is running outside Velatura. Close that SD.Next process before Velatura installs a package in its Python environment.',
        };
      }

      diagnostics.info('gguf.install.started', {
        version: GGUF_PACKAGE.version,
        sizeBytes: GGUF_PACKAGE.sizeBytes,
        license: GGUF_PACKAGE.license,
        sha256: GGUF_PACKAGE.sha256,
      });
      const result = await installGgufSupport(root, join(configDir(), 'packages'), { consent: true });
      diagnostics.info('gguf.install.completed', {
        installed: result.installed,
        status: result.support.status,
        version: GGUF_PACKAGE.version,
      });
      return result;
    } catch (err) {
      diagnostics.error('gguf.install.failed', {
        errorType: err instanceof Error ? err.name : 'UnknownError',
        message: err instanceof Error ? err.message : 'unknown error',
      });
      return { error: (err as Error).message };
    } finally {
      ggufInstallInProgress = false;
    }
  });

  /**
   * Start SD.Next ourselves.
   *
   * We read the port from its log ("Local URL: http://127.0.0.1:7860/") and
   * we only ever stop an engine we started.
   */
  app.post('/api/v1/sdnext/start', async (request) => {
    if (ggufInstallInProgress) return { error: 'GGUF support is still being installed. Wait for it to finish, then start SD.Next again.' };
    if (managed) {
      const engineStatus = await client.status();
      if (engineStatus.ready) return { alreadyRunning: true, url: sdnextUrl };
      return { error: 'The SD.Next process started by Velatura is not responding. Use Stop, then retry Start.' };
    }
    const currentlyReady = await client.status();
    if (currentlyReady.ready) return { alreadyRunning: true, url: sdnextUrl };
    const root = config.sdnextRoot;
    if (!root) return { error: 'SD.Next is not configured yet. Open Setup to select its folder or install the temporary pinned target.' };
    const launcher = process.platform === 'win32' ? 'webui.bat' : 'webui.sh';
    if (!existsSync(join(root, launcher)) || !existsSync(join(root, 'launch.py'))) {
      return { error: 'Velatura could not find a runnable SD.Next installation in this folder. Open Setup to choose the correct folder or install the temporary pinned target; no files were changed.' };
    }
    const profile = activeProfile();
    const ggufSupport = await ggufSupportForProfile(profile);
    if (ggufSupport && ggufSupport.status !== 'ready' && ggufSupport.status !== 'python-missing') {
      return { error: ggufSupportMessage(ggufSupport), ggufSupport };
    }
    const launch = await engineLaunch(root);
    const body = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {};
    const bootstrapConsent = body.bootstrapConsent === true;
    if (launch.bootstrap && !bootstrapConsent) {
      await discardIsolatedSdnextConfig(launch.isolation);
      if (launch.qwenGgufCompat) await removeQwen21GgufCompat(launch.qwenGgufCompat.root).catch(() => false);
      return {
        bootstrapConsentRequired: true,
        bootstrapMessage: 'SD.Next must prepare its pinned Python runtime before Qwen can start. Its own installer may download and install Python packages; the exact package set and total size depend on your system and may be several GB. Velatura will disable checkpoint autoload and auto-download, will not download Qwen weights, then restart SD.Next in offline mode. Continue only if you approve this one-time software setup.',
      };
    }
    const args = launch.args;
    const log: string[] = [];
    let engine: RunningEngine | undefined;
    let activeLaunch = launch;
    const onLog = (line: string) => {
      log.push(line);
      if (log.length > 400) log.shift();
      emitEvent({ type: 'engine-log', line });
    };
    try {
      engine = await startSdnext({
        root,
        args,
        startupTimeoutMs: existsSync(join(root, 'venv')) ? 15 * 60_000 : 45 * 60_000,
        onLog,
      });
      if (launch.bootstrap) {
        const promoted = await promoteQwenBootstrap(root, engine, launch, onLog);
        engine = promoted.engine;
        activeLaunch = promoted.launch;
      }
      managed = trackManagedEngine(engine, log, activeLaunch.isolation, activeLaunch.qwenGgufCompat);
      sdnextUrl = engine.url;
      client = createSdnextClient(engine.url);
      const profileResult = await applyProfileToEngine(profile);
      return {
        started: true,
        bootstrapCompleted: launch.bootstrap,
        url: engine.url,
        args,
        profileApplied: profileResult.applied,
        profileReason: profileResult.reason,
      };
    } catch (err) {
      if (engine) await engine.stop().catch(() => undefined);
      await discardIsolatedSdnextConfig(launch.isolation).catch(() => undefined);
      if (activeLaunch.isolation.sessionPath !== launch.isolation.sessionPath) {
        await discardIsolatedSdnextConfig(activeLaunch.isolation).catch(() => undefined);
      }
      if (launch.qwenGgufCompat) await removeQwen21GgufCompat(launch.qwenGgufCompat.root).catch(() => false);
      if (activeLaunch.qwenGgufCompat) await removeQwen21GgufCompat(activeLaunch.qwenGgufCompat.root).catch(() => false);
      if (managed && engine && sdnextUrl === engine.url) managed = undefined;
      return { error: (err as Error).message, log: log.slice(-20) };
    }
  });

  app.post('/api/v1/sdnext/stop', async () => {
    if (!managed) return { stopped: false, reason: 'the engine was not started by Velatura' };
    await managed.stop();
    managed = undefined;
    return { stopped: true };
  });

  app.post('/api/v1/sdnext/restart', async () => {
    const root = config.sdnextRoot;
    const profile = activeProfile();
    if (!root) return { restarted: false, error: 'SD.Next is not configured yet.' };
    if (!profileRequiresGguf(profile)) {
      return { restarted: false, error: 'The selected profile does not need the Qwen GGUF compatibility helper.' };
    }
    if (queue.list().some((job) => job.state === 'queued' || job.state === 'running')) {
      return { restarted: false, error: 'Wait for the current queue to finish before restarting SD.Next.' };
    }

    try {
      await prepareQwen21GgufCompat(root, profile);
      const engineStatus = await client.status();
      if (managed) {
        const current = managed;
        managed = undefined;
        await current.stop();
      } else if (engineStatus.ready) {
        // This endpoint is only called by an explicit user action in the UI.
        // Ask the responding local SD.Next instance to stop, then let Velatura
        // relaunch it with the isolated session config and compatibility helper.
        await client.shutdown();
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && (await client.status()).ready) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if ((await client.status()).ready) {
          return { restarted: false, error: 'SD.Next did not stop in time. No further action was taken.' };
        }
      }
      engineWasReady = false;
      await ensureEngine();
      return { restarted: true, url: sdnextUrl };
    } catch (err) {
      return { restarted: false, error: (err as Error).message };
    }
  });

  app.post('/api/v1/sdnext/apply-profile', async () => {
    const profile = activeProfile();
    const result = await applyProfileToEngine(profile);
    return { ...result, profile: profile?.id };
  });

  app.get('/api/v1/sdnext/samplers', async () => {
    const samplers = await client.samplers().catch((err) => ({ error: (err as Error).message }));
    return samplers;
  });

  // the history: one line per finished job, on disk
  /**
   * The instructions for the people who do not want the app to do it:
   * the exact file names, the exact folders, the sizes, the licences.
   */
  app.post('/api/v1/setup/export', async (request) => {
    const body = (request.body ?? {}) as { profileId?: string };
    const profile = profiles.find((p) => p.id === (body.profileId ?? config.profileId));
    if (!profile) return { error: 'unknown profile' };
    const root = config.sdnextRoot ?? '<your SD.Next folder>';
    const lines: string[] = [];
    lines.push(`# Velatura — ${profile.label}`);
    lines.push('');
    lines.push(profile.description ?? '');
    lines.push('');
    lines.push(`SD.Next folder: \`${root}\``);
    lines.push('');
    lines.push('## Files to place');
    lines.push('');
    for (const item of profile.models) {
      const entry = manifest.models.find((x) => x.id === item.manifestId);
      if (!entry) continue;
      const fileName = (item.file ?? entry.file).split('/').pop();
      const size = entry.sizeBytes ? `${(entry.sizeBytes / 1e9).toFixed(2)} GB` : 'unknown size';
      lines.push(`### ${entry.label} (${item.role})`);
      lines.push(`- file: \`${fileName}\``);
      lines.push(`- folder: \`${root}/models/${entry.dest}/\``);
      lines.push(`- from: ${entry.repo} @ ${entry.revision.slice(0, 12)}`);
      lines.push(`- size: ${size}`);
      if (entry.sha256) lines.push(`- sha256: \`${entry.sha256}\``);
      lines.push(`- licence: ${entry.license}${entry.licenseUrl ? ` — ${entry.licenseUrl}` : ''}`);
      lines.push('');
    }
    lines.push('## Generation settings of this profile');
    lines.push('');
    lines.push(`- steps: ${profile.steps}`);
    lines.push(`- resolution: ${profile.resolution}`);
    if (profile.sampling) {
      lines.push(`- sampler: ${profile.sampling.samplerName}`);
      lines.push(`- guidance (cfg): ${profile.sampling.cfgScale}`);
    }
    lines.push('');
    lines.push('When every file is in place, run `velatura doctor` to check.');
    const text = lines.join('\n');
    return { text, fileName: `velatura-${profile.id}.md` };
  });

  app.get('/api/v1/history', async (request) => {
    const query = request.query as { limit?: string } | undefined;
    const limit = Math.min(500, Math.max(1, Number(query?.limit ?? 50)));
    const jobs = await history.read(limit);
    return { jobs: jobs.reverse() };
  });

  async function wipeSdnextLogs(): Promise<string[]> {
    const wiped: string[] = [];
    if (!config.sdnextRoot) return wiped;
    for (const name of ['sdnext.log', 'sdnext.log.1', 'sdnext.log.old']) {
      const logPath = join(config.sdnextRoot, name);
      if (!existsSync(logPath)) continue;
      if (await secureWipeInPlace(logPath)) {
        wiped.push(logPath);
      }
    }
    if (managed?.log) {
      managed.log.length = 0;
    }
    return wiped;
  }

  app.post('/api/v1/history/clear', async () => {
    const historyFile = join(configDir(), 'history.jsonl');
    let deletedFile = false;
    if (existsSync(historyFile)) {
      await secureShredFile(historyFile);
      deletedFile = !existsSync(historyFile);
    }
    const wipedEngineLogs = await wipeSdnextLogs();
    const clearedSessionJobs = queue.clearCompleted();
    return { ok: true, deletedFile, wipedEngineLogs, clearedSessionJobs };
  });

  app.post('/api/v1/logs/clear', async () => {
    const cleared = await diagnostics.clear();
    const wipedEngineLogs = await wipeSdnextLogs();
    return {
      ok: true,
      deleted: cleared.deleted.length + wipedEngineLogs.length,
      wipedEngineLogs,
      failed: cleared.failed,
    };
  });

  app.get('/api/v1/queue', async () => ({ jobs: queue.list() }));

  app.post('/api/v1/queue', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const images = Array.isArray(body.images) ? (body.images as string[]) : [];
    const job = queue.submit({
      prompt: String(body.prompt ?? ''),
      images,
      negativePrompt: body.negativePrompt ? String(body.negativePrompt) : undefined,
      steps: body.steps ? Number(body.steps) : undefined,
      seed: body.seed !== undefined ? Number(body.seed) : undefined,
      size: body.size ? Number(body.size) : undefined,
      width: body.width ? Number(body.width) : undefined,
      height: body.height ? Number(body.height) : undefined,
      // the images decide: a job with references is an edit, whatever the client says
      mode: images.length > 0 ? 'img2img' : 'txt2img',
      cfgScale: body.cfgScale !== undefined ? Number(body.cfgScale) : undefined,
      samplerName: body.samplerName ? String(body.samplerName) : undefined,
      hires: body.hires !== undefined ? Boolean(body.hires) : undefined,
      detailer: body.detailer !== undefined ? Boolean(body.detailer) : undefined,
      denoising: body.denoising !== undefined ? Number(body.denoising) : undefined,
      checkpoint: body.checkpoint ? String(body.checkpoint) : undefined,
    });
    diagnostics.info('queue.job.accepted', {
      jobId: job.id,
      profileId: activeProfile()?.id ?? null,
      mode: job.request.mode ?? (job.request.images?.length ? 'img2img' : 'txt2img'),
      referenceCount: job.request.images?.length ?? 0,
    });
    return job;
  });

  app.post('/api/v1/queue/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const job = queue.get(id);
    const cancelled = queue.cancel(id);
    // a running job must stop burning the GPU, not just stop being tracked
    if (cancelled && job?.state === 'running') {
      await client.interrupt();
    }
    return { cancelled };
  });

  app.get('/api/v1/queue/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '127.0.0.1',
    });
    const send = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribeQueue = queue.onEvent(send);
    eventListeners.add(send);
    request.raw.on('close', () => {
      unsubscribeQueue();
      eventListeners.delete(send);
    });
    return reply;
  });

  // ---- static UI ----------------------------------------------------------
  const uiDist = opts.uiDist ?? resolveUiDist();
  if (uiDist && existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/' });
  } else {
    app.get('/', async () => ({
      name: 'Velatura',
      hint: 'The UI is not built yet. Run `npm run build -w @velatura/ui` (or use `npm run dev`).',
      api: '/api/v1/health',
    }));
  }

  // the profile may already be adapted to the files the user owns
  await refreshDerivedProfile();

  diagnostics.info('server.initialized', { profileId: activeProfile()?.id ?? null, profileCount: profiles.length });
  await diagnostics.flush();
  return {
    app,
    config,
    token,
    diagnostics,
    logFile: diagnostics.filePath,
    queue,
    manifest,
    profiles,
    derivedProfile: () => derived,
    sdnextUrl: () => sdnextUrl,
  };
}


export * from './config.js';
export * from './diagnostics.js';
export * from './queue.js';
export * from './sdnext.js';
