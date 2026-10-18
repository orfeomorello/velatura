/**
 * SD.Next client + process lifecycle.
 *
 * Velatura is the only client of the engine: the browser never talks to it.
 */
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import {
  buildGeneratePayload,
  type JobRequest,
  type PayloadOptions,
  defaultSdnextRoot,
  normalizeSdnextRootPath,
  sdnextLauncherName,
  type Profile,
  normalizeModelName,
} from '@velatura/core';

const execFileAsync = promisify(execFileCallback);

export interface SdnextProgress {
  /** 0..1 */
  progress?: number;
  /** seconds left, relative to the current step */
  eta_relative?: number;
  /** base64 preview of the current step */
  images?: string[];
  state?: {
    job?: string;
    job_count?: number;
    sampling_step?: number;
    sampling_steps?: number;
    processing_index?: number;
    skipped?: boolean;
    interrupted?: boolean;
  };
}

export interface SdnextStatus {
  ready: boolean;
  url?: string;
  progress?: SdnextProgress;
  models?: string[];
  error?: string;
}

export interface SdnextModelRecord {
  /** display title, including any hash */
  title: string;
  /** registered SD.Next alias accepted by `sd_model_checkpoint` */
  modelName?: string;
  /** registered local path alias, when SD.Next reports it */
  filename?: string;
  type?: string;
}

/**
 * SD.Next returns model records (with `title`/`model_name`) in current builds;
 * older API-compatible engines may return plain strings. Keep the title first:
 * that is the value SD.Next accepts as a checkpoint override.
 */
export function normalizeSdnextModelRecords(value: unknown): SdnextModelRecord[] {
  if (!Array.isArray(value)) return [];
  const records: SdnextModelRecord[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const title = item.trim();
      if (title) records.push({ title, modelName: title });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = [record.title, record.model_name, record.name, record.filename].find(
      (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
    );
    if (!title) continue;
    const modelName = [record.model_name, record.name].find(
      (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
    );
    records.push({
      title,
      modelName,
      filename: typeof record.filename === 'string' && record.filename.trim() ? record.filename : undefined,
      type: typeof record.type === 'string' ? record.type : undefined,
    });
  }
  return records;
}

export function normalizeSdnextModels(value: unknown): string[] {
  return normalizeSdnextModelRecords(value).map((record) => record.title);
}

export interface SdnextComponent {
  /** value accepted by SD.Next's `sd_unet` or `sd_vae` parameter */
  name: string;
  /** local file path returned by the enumerator, when available */
  filename?: string;
}

export interface SdnextRequestEvent {
  stage: 'start' | 'complete' | 'error';
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
  /** error class only: response bodies and request data are never recorded */
  errorType?: string;
  /** low-level transport cause, when Node exposes it */
  errorCauseType?: string;
  errorCauseCode?: string;
}

export type SdnextRequestObserver = (event: SdnextRequestEvent) => void;

export interface SdnextTaskStatus {
  status?: string;
  task?: string;
  current?: string;
  progress?: number;
  eta?: number;
  elapsed?: number;
}

const SDNEXT_GENERATION_TIMEOUT_MS = 30 * 60_000;

interface LocalHttpResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * Node's built-in fetch uses Undici's 300-second headers timeout. SD.Next's
 * first Qwen text-encoder load can legitimately take longer, so the blocking
 * generation POST uses node:http(s) with an explicit 30-minute overall limit.
 */
function requestLongSdnextJson(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<LocalHttpResponse> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const suppliedHeaders = init?.headers;
  if (suppliedHeaders instanceof Headers) {
    suppliedHeaders.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(suppliedHeaders)) {
    for (const [key, value] of suppliedHeaders as Array<[string, string]>) {
      headers[key.toLowerCase()] = value;
    }
  } else if (suppliedHeaders) {
    for (const [key, value] of Object.entries(suppliedHeaders)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }
  }
  const requestOptions: RequestOptions = {
    method: init?.method ?? 'POST',
    headers,
  };
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    return Promise.reject(new Error('SD.Next generation requests must use a JSON string body.'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const signal = init?.signal ?? undefined;
    let abortHandler: (() => void) | undefined;
    let request: ClientRequest;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    request = send(target, requestOptions, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: async () => text,
          json: async () => (text ? JSON.parse(text) : undefined),
        });
      });
    });
    request.once('error', fail);

    timer = setTimeout(() => {
      const error = new Error(`SD.Next generation request exceeded ${Math.round(timeoutMs / 60_000)} minutes.`);
      error.name = 'TimeoutError';
      request.destroy(error);
    }, timeoutMs);
    timer.unref?.();

    if (signal) {
      abortHandler = () => {
        const error = new Error('SD.Next generation request was aborted.');
        error.name = 'AbortError';
        request.destroy(error);
      };
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

function requestErrorDetails(error: unknown): Pick<SdnextRequestEvent, 'errorType' | 'errorCauseType' | 'errorCauseCode'> {
  const root = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const cause = root?.cause && typeof root.cause === 'object' ? (root.cause as Record<string, unknown>) : undefined;
  return {
    errorType: error instanceof Error ? error.name : 'UnknownError',
    errorCauseType: typeof cause?.name === 'string' ? cause.name : undefined,
    errorCauseCode: typeof cause?.code === 'string' ? cause.code : undefined,
  };
}

/** Normalize SD.Next's `{ name, filename }` component records and older string lists. */
export function normalizeSdnextComponents(value: unknown): SdnextComponent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const name = item.trim();
      return name ? [{ name, filename: name }] : [];
    }
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const filename = [record.filename, record.path, record.model_path].find(
      (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
    );
    const name = [record.name, record.model_name, record.title, filename].find(
      (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
    );
    return name ? [{ name, filename }] : [];
  });
}

function pathBase(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** Match a component by exact filename/name; never confuse it with a base checkpoint. */
export function matchSdnextComponent(
  fileName: string,
  components: SdnextComponent[],
): SdnextComponent | undefined {
  const wanted = normalizeModelName(pathBase(fileName));
  if (!wanted) return undefined;
  return components.find((component) =>
    [component.filename, component.name]
      .filter((candidate): candidate is string => Boolean(candidate))
      .some((candidate) => normalizeModelName(pathBase(candidate)) === wanted),
  );
}

export class SdnextClient {
  constructor(
    private baseUrl: string,
    private observeRequest?: SdnextRequestObserver,
  ) {}

  get url(): string {
    return this.baseUrl;
  }

  private observe(event: SdnextRequestEvent): void {
    try {
      this.observeRequest?.(event);
    } catch {
      // diagnostics must never prevent an engine request
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const startedAt = Date.now();
    let status: number | undefined;
    let reported = false;
    this.observe({ stage: 'start', method, path });
    try {
      const longSdnextPost =
        method === 'POST' && (
          path === '/sdapi/v1/txt2img' ||
          path === '/sdapi/v1/img2img' ||
          path.startsWith('/sdapi/v1/checkpoint')
        );
      const res = longSdnextPost
        ? await requestLongSdnextJson(`${this.baseUrl}${path}`, init, SDNEXT_GENERATION_TIMEOUT_MS)
        : await fetch(`${this.baseUrl}${path}`, {
            ...init,
            headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
          });
      status = res.status;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.observe({ stage: 'error', method, path, status, durationMs: Date.now() - startedAt, errorType: 'HttpError' });
        reported = true;
        throw new Error(`SD.Next ${path} → HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      if (res.status === 204) {
        this.observe({ stage: 'complete', method, path, status, durationMs: Date.now() - startedAt });
        reported = true;
        return undefined as T;
      }
      const data = (await res.json()) as T;
      this.observe({ stage: 'complete', method, path, status, durationMs: Date.now() - startedAt });
      reported = true;
      return data;
    } catch (err) {
      if (!reported) {
        this.observe({
          stage: 'error',
          method,
          path,
          status,
          durationMs: Date.now() - startedAt,
          ...requestErrorDetails(err),
        });
      }
      throw err;
    }
  }

  async status(): Promise<SdnextStatus> {
    try {
      // this call must succeed for the engine to count as ready
      const models = normalizeSdnextModels(await this.request<unknown>('/sdapi/v1/sd-models'));
      const progress = await this.request<SdnextProgress>('/sdapi/v1/progress').catch(() => undefined);
      return { ready: true, url: this.baseUrl, progress, models };
    } catch (err) {
      return { ready: false, error: (err as Error).message };
    }
  }

  /**
   * The models the engine knows, with the names it gives them.
   *
   * The list changes only when a model is installed, but the profile asks
   * for it on every job: a few seconds of cache save a round trip to the
   * engine for each image.
   */
  private modelsCache?: { at: number; records: SdnextModelRecord[] };

  async modelRecords(force = false): Promise<SdnextModelRecord[]> {
    if (!force && this.modelsCache && Date.now() - this.modelsCache.at < 5000) {
      return this.modelsCache.records;
    }
    const data = await this.request<unknown>('/sdapi/v1/sd-models');
    const records = normalizeSdnextModelRecords(data);
    this.modelsCache = { at: Date.now(), records };
    return records;
  }

  async models(force = false): Promise<string[]> {
    return (await this.modelRecords(force)).map((record) => record.title);
  }

  /** Refresh Diffusers/checkpoint indexing after Velatura creates its local reference folder. */
  async refreshCheckpoints(): Promise<void> {
    await this.request('/sdapi/v1/refresh-checkpoints', { method: 'POST', body: '{}' });
    this.modelsCache = undefined;
  }

  /** Return the checkpoint SD.Next reports as currently loaded, not merely selected. */
  async currentModel(): Promise<{ checkpoint?: string; class?: string; type?: string }> {
    const value = await this.request<unknown>('/sdapi/v1/checkpoint');
    if (!value || typeof value !== 'object') return {};
    const record = value as Record<string, unknown>;
    return {
      checkpoint: [record.title, record.checkpoint, record.name, record.filename].find(
        (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
      ),
      class: typeof record.class === 'string' ? record.class : undefined,
      type: typeof record.type === 'string' ? record.type : undefined,
    };
  }

  /** Load a local checkpoint via SD.Next's dedicated API without POSTing `/options`. */
  async loadCheckpoint(checkpoint: string, force = true): Promise<boolean> {
    const query = new URLSearchParams({ sd_model_checkpoint: checkpoint, force: String(force) });
    const result = await this.request<{ ok?: boolean }>(`/sdapi/v1/checkpoint?${query.toString()}`, {
      method: 'POST',
    });
    return result.ok === true;
  }

  async currentCheckpoint(): Promise<string | undefined> {
    return (await this.currentModel()).checkpoint;
  }

  private unetsCache?: { at: number; components: SdnextComponent[] };

  /** SD.Next reports UNET/DiT components separately from base checkpoints. */
  async unets(): Promise<SdnextComponent[]> {
    if (this.unetsCache && Date.now() - this.unetsCache.at < 5000) {
      return this.unetsCache.components;
    }
    // Current SD.Next exposes `/unets`; some releases/documentation use the
    // singular `/unet`. Support both without treating a checkpoint list as a fallback.
    let data: unknown;
    try {
      data = await this.request<unknown>('/sdapi/v1/unets');
    } catch {
      data = await this.request<unknown>('/sdapi/v1/unet');
    }
    const components = normalizeSdnextComponents(data);
    this.unetsCache = { at: Date.now(), components };
    return components;
  }

  async vaes(): Promise<SdnextComponent[]> {
    const data = await this.request<unknown>('/sdapi/v1/sd-vae');
    return normalizeSdnextComponents(data);
  }

  async refreshUnets(): Promise<void> {
    await this.request('/sdapi/v1/refresh-unets', { method: 'POST', body: '{}' });
    this.unetsCache = undefined;
  }

  async refreshVaes(): Promise<void> {
    await this.request('/sdapi/v1/refresh-vae', { method: 'POST', body: '{}' });
  }

  /** The list of solvers the engine knows — the UI offers them. */
  async samplers(): Promise<string[]> {
    const data = await this.request<string[] | { samplers?: string[] }>('/sdapi/v1/samplers');
    if (Array.isArray(data)) return data;
    return data.samplers ?? [];
  }

  /** Read the engine's selected settings (selection does not itself prove a component loaded). */
  async options(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/sdapi/v1/options');
  }

  /** Read startup flags only to verify whether a running engine uses Velatura's isolated config copy. */
  async commandFlags(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/sdapi/v1/cmd-flags');
  }

  /** Read dynamic option choices, including the indexed text-encoder files. */
  async optionsInfo(): Promise<{
    options?: Record<string, { component_args?: { choices?: unknown } }>;
  }> {
    return this.request<{ options?: Record<string, { component_args?: { choices?: unknown } }> }>(
      '/sdapi/v1/options-info',
    );
  }

  /**
   * Set the engine's global options (the detailer's settings live there).
   * Best effort: the engine may be off, and that is not an error.
   */
  async setOptions(options: Record<string, unknown>): Promise<boolean> {
    try {
      await this.request('/sdapi/v1/options', {
        method: 'POST',
        body: JSON.stringify(options),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Set options and require SD.Next to report that each changed option was accepted. */
  async setOptionsChecked(options: Record<string, unknown>): Promise<boolean> {
    if (Object.keys(options).length === 0) return true;
    try {
      const result = await this.request<{ updated?: Array<Record<string, boolean>> }>(
        '/sdapi/v1/options',
        { method: 'POST', body: JSON.stringify(options) },
      );
      return Boolean(
        result.updated &&
          result.updated.length === Object.keys(options).length &&
          result.updated.every((entry) => Object.keys(entry).length === 1 && Object.values(entry)[0] === true),
      );
    } catch {
      return false;
    }
  }

  /** Stop a generation that is running right now. */
  async interrupt(): Promise<void> {
    await this.request('/sdapi/v1/interrupt', { method: 'POST', body: '{}' }).catch(() => undefined);
  }

  /** Shut down SD.Next after an explicit user request to restart the managed session. */
  async shutdown(): Promise<void> {
    await this.request('/sdapi/v1/shutdown', { method: 'POST', body: '{}' });
  }

  /**
   * Generate, and report the progress while it runs.
   *
   * SD.Next's generate endpoints block until the image is ready, so the
   * progress is read from /sdapi/v1/progress in parallel. The preview
   * image (if the engine sends one) is passed through as it is.
   */
  async generate(
    request: JobRequest,
    profile?: Profile,
    onProgress?: (progress: number | undefined, etaSeconds?: number, preview?: string, stage?: string) => void,
    options: PayloadOptions = {},
  ): Promise<{ images: string[]; parameters: Record<string, unknown> }> {
    const payload = buildGeneratePayload(profile, request, options);
    const endpoint = request.images?.length ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img';

    let stopped = false;
    let lastStatusAt = 0;
    let taskStatus: SdnextTaskStatus | undefined;
    let firstSamplingAt: number | undefined;
    let firstSamplingStep = 0;

    const watch = async (): Promise<void> => {
      while (!stopped) {
        await sleep(500);
        if (stopped) return;
        const state = await this.request<SdnextProgress>('/sdapi/v1/progress').catch(() => undefined);
        if (Date.now() - lastStatusAt >= 1200) {
          taskStatus = await this.request<SdnextTaskStatus>('/sdapi/v1/status').catch(() => undefined);
          lastStatusAt = Date.now();
        }
        if (!state && !taskStatus) continue;
        const preview = state?.images?.[0];
        const step = state?.state?.sampling_step;
        const totalSteps = state?.state?.sampling_steps;
        const rawStage = [taskStatus?.task, taskStatus?.current, state?.state?.job].find(
          (value): value is string => typeof value === 'string' && Boolean(value.trim()),
        );
        const stage =
          typeof step === 'number' && typeof totalSteps === 'number' && totalSteps > 0 && step > 0
            ? `Step ${step}/${totalSteps}`
            : rawStage;

        // Calculate accurate remaining seconds from real measured step speed
        let etaSeconds: number | undefined;
        if (typeof step === 'number' && typeof totalSteps === 'number' && totalSteps > 0 && step > 0) {
          if (firstSamplingAt === undefined) {
            firstSamplingAt = Date.now();
            firstSamplingStep = step;
          } else if (step > firstSamplingStep) {
            const elapsedSec = (Date.now() - firstSamplingAt) / 1000;
            const secPerStep = elapsedSec / (step - firstSamplingStep);
            const remainingSteps = Math.max(0, totalSteps - step);
            etaSeconds = Math.max(1, Math.round(secPerStep * remainingSteps));
          }
        }
        if (etaSeconds === undefined) {
          etaSeconds = state ? totalEta(state) : taskStatus?.eta;
        }

        const progressValue =
          typeof step === 'number' && typeof totalSteps === 'number' && totalSteps > 0 && step > 0
            ? step / totalSteps
            : (state?.progress ?? taskStatus?.progress);

        onProgress?.(progressValue, etaSeconds, preview, stage);
      }
    };
    const watcher = watch();

    try {
      const data = await this.request<{ images?: string[] | null; parameters?: Record<string, unknown> }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!Array.isArray(data.images) || data.images.length === 0) {
        throw new Error('SD.Next returned no image. The generation failed inside the engine; check the SD.Next log for the specific error.');
      }
      return { images: data.images, parameters: data.parameters ?? {} };
    } finally {
      stopped = true;
      await watcher.catch(() => undefined);
    }
  }
}

/**
 * SD.Next's `eta_relative` is already the estimated remaining seconds for the
 * current job. Round it cleanly without multiplying by remaining steps.
 */
export function totalEta(state: SdnextProgress): number | undefined {
  const relative = state.eta_relative;
  if (typeof relative !== 'number' || !Number.isFinite(relative) || relative <= 0) return undefined;
  return Math.max(1, Math.round(relative));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Try the usual SD.Next ports. */
export async function detectSdnextUrl(ports = [7860, 7861, 7862]): Promise<string | undefined> {
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const res = await fetch(`${url}/sdapi/v1/sd-models`, { signal: controller.signal });
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return url;
      }
    } catch {
      /* try next port */
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

export interface StartOptions {
  root: string;
  /** extra command line flags (the profile decides: --api, device flags…) */
  args?: string[];
  onLog?: (line: string) => void;
  env?: Record<string, string>;
  /** lets an owner track the child while the startup URL is still being read */
  onProcess?: (child: ChildProcess) => void;
  /** SD.Next may need several minutes on its first run or while loading */
  startupTimeoutMs?: number;
}

export interface RunningEngine {
  process: ChildProcess;
  url: string;
  stop: () => Promise<void>;
}

/**
 * Start SD.Next and read the port from its log
 * (SD.Next prints "Local URL: http://127.0.0.1:7860/").
 */
async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000 });
    } catch {
      // taskkill may be unavailable or the process may have exited between checks.
      child.kill();
    }
    if (await waitForChildExit(child, 5000)) return;
    child.kill('SIGKILL');
    await waitForChildExit(child, 3000);
    return;
  }
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 1200)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 3000);
}

/**
 * Start SD.Next and read the port from its log
 * (SD.Next prints "Local URL: http://127.0.0.1:7860/").
 */
async function waitForSdnextApi(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'the API has not responded yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`SD.Next exited before its API became ready (code ${child.exitCode ?? child.signalCode})`);
    }
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${url}/sdapi/v1/sd-models`, { signal: controller.signal });
      clearTimeout(requestTimer);
      const ready = response.ok;
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (ready) return;
      lastError = `the API returned HTTP ${status}`;
    } catch (err) {
      clearTimeout(requestTimer);
      lastError = (err as Error).message;
    }
    await sleep(1000);
  }
  throw new Error(`SD.Next printed its URL but the API did not become ready in time (${lastError})`);
}

export function quoteWindowsShellArg(value: string): string {
  return `"${value}"`;
}

export async function startSdnext(opts: StartOptions): Promise<RunningEngine> {
  const isWindows = process.platform === 'win32';
  const script = join(opts.root, isWindows ? 'webui.bat' : 'webui.sh');
  const args = opts.args ?? [];
  if (!existsSync(script)) throw new Error(`SD.Next startup script not found: ${script}`);

  const childEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    TQDM_DISABLE: '1',
    ...opts.env,
  };
  const child = isWindows
    ? spawn([script, ...args].map(quoteWindowsShellArg).join(' '), {
        cwd: opts.root,
        shell: true,
        windowsHide: true,
        env: childEnv,
      })
    : spawn(script, args, {
        cwd: opts.root,
        env: childEnv,
      });
  opts.onProcess?.(child);

  let url: string | undefined;
  let buffer = '';
  const timeoutMs = opts.startupTimeoutMs ?? 15 * 60_000;
  const startedAt = Date.now();
  const urlPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('SD.Next did not print its URL before the startup timeout')),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        opts.onLog?.(line);
        const match = line.match(/Local URL:\s*(http:\/\/[^\s/]+)/i);
        if (match?.[1] && !url) {
          url = match[1];
          clearTimeout(timer);
          resolve(url);
        }
      }
      // Some launchers write the final URL without a trailing newline.
      if (!url) {
        const match = buffer.match(/Local URL:\s*(http:\/\/[^\s/]+)/i);
        if (match?.[1]) {
          url = match[1];
          clearTimeout(timer);
          resolve(url);
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!url) reject(new Error(`SD.Next exited before becoming ready (code ${code})`));
    });
  });

  try {
    const resolved = await urlPromise;
    const remainingMs = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    await waitForSdnextApi(resolved, child, remainingMs);
    return {
      process: child,
      url: resolved,
      stop: () => terminateProcess(child),
    };
  } catch (err) {
    await terminateProcess(child);
    throw err;
  }
}

// ------------------------------------------------------------ installation ----

export const SDNEXT_REPOSITORY_URL = 'https://github.com/vladmandic/sdnext.git';
export const SDNEXT_PINNED_DEV_TARGET = {
  id: 'velatura-dev-2026-10-17',
  label: 'SD.Next official master (recommended)',
  branch: 'master',
  commit: undefined as string | undefined,
  referenceDate: '2026-10-18',
} as const;

export const SDNEXT_INSTALL_TARGETS = {
  'repository-default': {
    id: 'repository-default',
    label: 'SD.Next official master branch (recommended)',
    branch: 'master',
    commit: undefined,
    referenceDate: undefined,
  },
  [SDNEXT_PINNED_DEV_TARGET.id]: SDNEXT_PINNED_DEV_TARGET,
} as const;

export type SdnextInstallTargetId = keyof typeof SDNEXT_INSTALL_TARGETS;

/** Runtime dependency commits required by the pinned SD.Next snapshot. */
export const SDNEXT_PINNED_RUNTIME_COMMITS = {
  diffusers: 'b800f828f3951c4d206e154411bcbfa693cd322e',
  transformers: 'b70d02fc724d04c916832ca4ead03ff05e8fb1ee',
  sdnq: '35337772cdd3ca160d8ab216d06b22461fa476dc',
} as const;

export interface PinnedSdnextRuntimeStatus {
  ready: boolean;
  commit?: string;
  pythonVersion?: string;
  pythonUnsupported?: boolean;
  reason?: string;
}

/** SD.Next accepts Python 3.10–3.13; 3.12 is recommended. */
export function isSupportedSdnextPythonVersion(major: number, minor: number): boolean {
  return major === 3 && minor >= 10 && minor <= 13;
}

/** Read a checkout's exact source revision without changing it. */
export async function readSdnextCommit(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 8000 });
    return stdout.trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export async function sdnextPythonCandidates(root: string): Promise<string[]> {
  const directories: string[] = [];
  if (process.platform === 'win32') {
    // webui.bat uses VENV_DIR (unlike webui.sh, which uses venv_dir).
    const configured = (process.env.VENV_DIR ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (configured && configured !== '-') {
      directories.push(isAbsolute(configured) ? resolve(configured) : resolve(root, configured));
    }
  } else {
    // webui.sh sources this file before activating the environment. Do not
    // execute user shell code here; accept only a plain literal assignment.
    try {
      const userScript = await readFile(join(root, 'webui-user.sh'), 'utf8');
      const assignments = [...userScript.matchAll(/^\s*(?:export\s+)?venv_dir\s*=\s*(['"]?)([^'"\r\n;]+)\1\s*(?:#.*)?$/gm)];
      const value = assignments.at(-1)?.[2]?.trim();
      const homeExpanded = value?.replace(/\$\{HOME\}|\$HOME\b/g, homedir());
      if (homeExpanded && !/[$`]/.test(homeExpanded) && homeExpanded !== '-') {
        const expanded = homeExpanded.startsWith('~')
          ? join(homedir(), homeExpanded.slice(1).replace(/^[/\\]/, ''))
          : homeExpanded;
        directories.push(isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded));
      }
    } catch {
      /* use SD.Next's default virtual-environment path */
    }
  }
  directories.push(join(root, 'venv'));

  const candidates: string[] = [];
  for (const directory of new Set(directories)) {
    if (process.platform === 'win32') {
      candidates.push(join(directory, 'Scripts', 'python.exe'));
    } else {
      candidates.push(join(directory, 'bin', 'python3'), join(directory, 'bin', 'python'));
    }
  }
  return [...new Set(candidates)];
}

/**
 * Verify that SD.Next's virtual environment has its core runtime packages installed.
 */
export async function inspectPinnedSdnextRuntime(root: string): Promise<PinnedSdnextRuntimeStatus> {
  const commit = await readSdnextCommit(root);
  const python = (await sdnextPythonCandidates(root)).find((candidate) => existsSync(candidate));
  if (!python) {
    return { ready: false, commit, reason: 'The SD.Next virtual environment is not installed yet.' };
  }

  const probe = `import importlib.util as u, json, sys\n` +
    `python_version = '.'.join(str(part) for part in sys.version_info[:3])\n` +
    `required = ['torch', 'diffusers', 'transformers', 'fastapi', 'gradio']\n` +
    `missing = [name for name in required if u.find_spec(name) is None]\n` +
    `print(json.dumps({'python_version': python_version, 'missing': missing}))\n`;
  let packageState: { python_version?: unknown; missing?: unknown };
  try {
    const { stdout } = await execFileAsync(python, ['-c', probe], {
      cwd: root,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    packageState = JSON.parse(stdout.trim()) as { python_version?: unknown; missing?: unknown };
  } catch (error) {
    return {
      ready: false,
      commit,
      reason: `The SD.Next Python environment could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const pythonVersion = typeof packageState.python_version === 'string' ? packageState.python_version : undefined;
  const pythonMatch = pythonVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!pythonVersion || !pythonMatch) {
    return { ready: false, commit, reason: 'The SD.Next virtual environment did not report a valid Python version.' };
  }
  if (!isSupportedSdnextPythonVersion(Number(pythonMatch[1]), Number(pythonMatch[2]))) {
    return {
      ready: false,
      commit,
      pythonVersion,
      pythonUnsupported: true,
      reason: `SD.Next supports Python 3.10–3.13 (Python 3.12 is recommended); this environment uses Python ${pythonVersion}.`,
    };
  }

  const missing = Array.isArray(packageState.missing)
    ? packageState.missing.filter((item): item is string => typeof item === 'string')
    : [];
  if (missing.length) {
    return {
      ready: false,
      commit,
      reason: `missing Python packages: ${missing.join(', ')}`,
    };
  }

  return { ready: true, commit, pythonVersion };
}

export interface EngineInstallState {
  running: boolean;
  dir: string;
  phase: 'checking' | 'cloning' | 'installing' | 'ready' | 'error';
  log: string[];
  target?: SdnextInstallTargetId;
  /** Actual checked-out commit, reported only after `git rev-parse` succeeds. */
  commit?: string;
  error?: string;
  missing?: string[];
}

let installState: EngineInstallState | undefined;
let installProcess: ChildProcess | undefined;

/** What the machine needs before we can install SD.Next. */
export async function checkEngineRequirements(): Promise<{
  ok: boolean;
  missing: string[];
  versions: Record<string, string>;
  warnings: string[];
}> {
  const missing: string[] = [];
  const warnings: string[] = [];
  const versions: Record<string, string> = {};
  const probeGit = async () => {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['--version'], { timeout: 8000 });
      versions.git = (stdout || stderr).trim().split('\n')[0] ?? '';
    } catch {
      missing.push('Git');
    }
  };
  const probePython = async () => {
    const command = process.platform === 'win32' ? 'python' : 'python3';
    try {
      const { stdout, stderr } = await execFileAsync(command, ['--version'], { timeout: 8000 });
      const output = `${stdout}\n${stderr}`;
      const match = output.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
      if (!match) {
        missing.push(`Python 3.10+ (${command} on PATH)`);
        return;
      }
      const major = Number(match[1]);
      const minor = Number(match[2]);
      const patch = Number(match[3] ?? 0);
      versions.python = `${major}.${minor}.${patch}`;
      if (!isSupportedSdnextPythonVersion(major, minor)) {
        missing.push(`Python 3.10-3.13 required by the pinned SD.Next target (${command} on PATH; found ${versions.python}; Python 3.12 is recommended)`);
      } else if (minor === 10) {
        warnings.push('Python 3.10 is no longer recommended by SD.Next; Python 3.12 is recommended.');
      } else if (minor === 13) {
        warnings.push('Python 3.13 is supported, but some packages may need to be built from source.');
      }
    } catch {
      missing.push(`Python 3.10+ (${command} on PATH)`);
    }
  };
  await Promise.all([probeGit(), probePython()]);
  return { ok: missing.length === 0, missing, versions, warnings };
}

export interface EngineInstallTarget {
  ok: boolean;
  dir: string;
  error?: string;
}

/** Do not overwrite a non-empty folder or install into a filesystem root. */
export async function validateEngineInstallTarget(input: string): Promise<EngineInstallTarget> {
  const dir = normalizeSdnextRootPath(input || defaultSdnextRoot());
  const filesystemRoot = parse(dir).root;
  if (dir === filesystemRoot) {
    return { ok: false, dir, error: 'Choose a folder inside the drive, not the drive itself.' };
  }
  if (dir === resolve(defaultSdnextRoot(), '..')) {
    return { ok: false, dir, error: 'Choose a dedicated folder for SD.Next, not the parent of the default install folder.' };
  }

  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return { ok: false, dir, error: 'That path is a file, not a folder. Choose a folder for SD.Next.' };
    }
    if (existsSync(join(dir, sdnextLauncherName()))) {
      return {
        ok: false,
        dir,
        error: 'SD.Next already has its startup script in this folder. Select it above and choose “Check and continue” instead.',
      };
    }
    const contents = await readdir(dir);
    if (contents.length > 0) {
      return {
        ok: false,
        dir,
        error: 'This folder is not empty and does not look like SD.Next. Velatura will not overwrite it; choose an empty folder.',
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, dir, error: `This folder cannot be checked: ${(err as Error).message}` };
    }
  }
  return { ok: true, dir };
}

function relayLines(chunk: Buffer, push: (line: string) => void): void {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim()) push(line);
  }
}

function runLoggedCommand(
  command: string,
  args: string[],
  cwd: string,
  push: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    installProcess = child;
    child.stdout?.on('data', (chunk: Buffer) => relayLines(chunk, push));
    child.stderr?.on('data', (chunk: Buffer) => relayLines(chunk, push));
    child.once('error', (err) => {
      installProcess = undefined;
      reject(err);
    });
    child.once('exit', (code) => {
      installProcess = undefined;
      if (code === 0) resolve();
      else reject(new Error(`git command stopped with code ${code}`));
    });
  });
}

/**
 * Install SD.Next only after the user has explicitly confirmed in the setup
 * wizard. The official startup script builds the virtual environment and then
 * starts the engine; readiness is the URL it prints, not the process exiting.
 */
export function installSdnext(
  inputDir: string,
  onLog: (line: string) => void,
  args: string[] = [],
  onReady?: (
    engine: RunningEngine,
    state: EngineInstallState,
  ) => void | RunningEngine | Promise<void | RunningEngine>,
  onError?: (error: Error, state: EngineInstallState) => void | Promise<void>,
  beforeStart?: () => void | Promise<void>,
  targetId: SdnextInstallTargetId = SDNEXT_PINNED_DEV_TARGET.id,
): EngineInstallState {
  if (installState?.running) return installState;
  if (installProcess && installProcess.exitCode === null && installState) return installState;

  const dir = normalizeSdnextRootPath(inputDir || defaultSdnextRoot());
  const selectedTarget = SDNEXT_INSTALL_TARGETS[targetId];
  const state: EngineInstallState = {
    running: true,
    dir,
    phase: 'checking',
    log: [],
    target: targetId,
  };
  installState = state;
  const push = (line: string) => {
    state.log.push(line);
    if (state.log.length > 500) state.log.shift();
    onLog(line);
  };

  let cloneAttempted = false;
  let activeEngine: RunningEngine | undefined;
  void (async () => {
    try {
      const target = await validateEngineInstallTarget(dir);
      if (!target.ok) throw new Error(target.error ?? 'the install folder is not safe to use');

      const requirements = await checkEngineRequirements();
      if (!requirements.ok) {
        state.missing = requirements.missing;
        throw new Error(`missing on this machine: ${requirements.missing.join(', ')}`);
      }

      const launcher = join(dir, sdnextLauncherName());
      if (!existsSync(launcher)) {
        cloneAttempted = true;
        state.phase = 'cloning';
        await mkdir(dirname(dir), { recursive: true });
        if (selectedTarget.commit) {
          push(`Fetching the pinned SD.Next ${selectedTarget.branch} commit ${selectedTarget.commit}…`);
          await runLoggedCommand('git', ['init', dir], dirname(dir), push);
          await runLoggedCommand('git', ['-C', dir, 'remote', 'add', 'origin', SDNEXT_REPOSITORY_URL], dirname(dir), push);
          await runLoggedCommand(
            'git',
            ['-C', dir, 'fetch', '--depth', '1', '--progress', 'origin', selectedTarget.commit],
            dirname(dir),
            push,
          );
          await runLoggedCommand('git', ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD'], dirname(dir), push);
        } else {
          push('Cloning the SD.Next repository default branch (not pinned)…');
          await runLoggedCommand(
            'git',
            ['clone', '--depth', '1', '--progress', SDNEXT_REPOSITORY_URL, dir],
            dirname(dir),
            push,
          );
        }
        const revisionResult = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 8000 });
        const checkedOutCommit = revisionResult.stdout.trim().toLowerCase();
        if (selectedTarget.commit && checkedOutCommit !== selectedTarget.commit) {
          throw new Error(`SD.Next checkout mismatch: expected ${selectedTarget.commit}, received ${checkedOutCommit || 'no commit id'}.`);
        }
        state.commit = checkedOutCommit;
        push(`Checked out SD.Next commit ${checkedOutCommit}.`);
      }

      if (!existsSync(launcher)) {
        throw new Error(`the SD.Next startup script was not created: ${launcher}`);
      }

      await beforeStart?.();
      state.phase = 'installing';
      push('Starting SD.Next for its first-run setup. This can download several GB; the model bundle is separate.');
      activeEngine = await startSdnext({
        root: dir,
        args,
        onLog: push,
        startupTimeoutMs: 45 * 60_000,
        onProcess: (child) => {
          // Keep the process visible while startup is in progress. A second
          // install request must not start another clone or engine.
          installProcess = child;
        },
      });
      const replacement = await onReady?.(activeEngine, state);
      if (replacement) activeEngine = replacement;
      installProcess = activeEngine.process;
      state.phase = 'ready';
      state.running = false;
      push('SD.Next is installed and running. Review the path, then choose “Use this installation”.');
      activeEngine.process.once('exit', (code) => {
        if (installProcess === activeEngine?.process) installProcess = undefined;
        if (state.phase === 'ready') {
          state.phase = 'error';
          state.error = code === 0 ? 'SD.Next stopped after setup.' : `SD.Next exited with code ${code ?? 'unknown'}.`;
          state.running = false;
          push(state.error);
        }
      });
    } catch (err) {
      if (activeEngine) await activeEngine.stop().catch(() => undefined);
      installProcess = undefined;
      // We only enter clone after the target has been verified as new or empty.
      // Remove an incomplete checkout so a network failure does not strand the
      // user with a non-empty directory that the next attempt must refuse.
      if (cloneAttempted && (!existsSync(join(dir, sdnextLauncherName())) || !existsSync(join(dir, 'launch.py')))) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      state.phase = 'error';
      const error = err instanceof Error ? err : new Error(String(err));
      state.error = error.message;
      try {
        await onError?.(error, state);
      } catch (cleanupError) {
        push(`Cleanup warning: ${(cleanupError as Error).message}`);
      }
      push(state.error);
    } finally {
      state.running = false;
      if (!installProcess || installProcess.exitCode !== null) installProcess = undefined;
    }
  })();

  return state;
}

export function engineInstallState(): EngineInstallState | undefined {
  return installState;
}
