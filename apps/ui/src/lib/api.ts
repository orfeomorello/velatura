/**
 * Thin API client. The session token lives in the URL fragment
 * (never sent to the server as part of the path) and is attached as a header.
 */
export function sessionToken(): string {
  const hash = window.location.hash.replace(/^#/, '');
  const match = /(?:^|&)token=([^&]+)/.exec(hash);
  if (match) {
    const token = decodeURIComponent(match[1]!);
    // remember it: the address without the fragment is the one people bookmark
    try {
      localStorage.setItem('velatura.token', token);
    } catch {
      /* private mode */
    }
    return token;
  }
  try {
    return localStorage.getItem('velatura.token') ?? '';
  } catch {
    return '';
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const token = sessionToken();
  // a GET must not hang for ever: the interface asks for the health every
  // few seconds, and a stuck request would pile up
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(path, {
      ...init,
      signal: controller?.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-velatura-token': token } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`${path} → no answer in ${Math.round((timeoutMs ?? 0) / 1000)}s`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const api = {
  get: <T>(path: string, timeoutMs = 20_000) => request<T>(path, {}, timeoutMs),
  post: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }, timeoutMs),
  delete: <T>(path: string, body: unknown, timeoutMs = 20_000) =>
    request<T>(path, { method: 'DELETE', body: JSON.stringify(body) }, timeoutMs),
};

export interface Health {
  ok: boolean;
  name: string;
  tagline: string;
  version: string;
  sdnext: {
    url: string;
    ready: boolean;
    error?: string;
    starting?: boolean;
    managed?: boolean;
    /** the checkpoint SD.Next itself reports as currently loaded */
    model?: string;
    /** the profile base model selected for the next generation */
    selectedBaseModel?: string;
    /** the profile in use */
    profile?: string;
    /** local Qwen profile reference preparation, not an engine or generation confirmation */
    profilePreparation?: {
      profileId: string;
      variant: string;
      label: string;
      state: 'verifying' | 'assembling' | 'ready' | 'error';
      role?: string;
      percent?: number;
      message?: string;
      updatedAt: string;
    };
  };
  queue?: { depth: number; running: boolean };
  hardware?: { gpu?: string; vramGb?: number; totalMemGb?: number };
  sdnextRoot: string | null;
  manifestEntries: number;
}

export interface ScanRow {
  path: string;
  name: string;
  sizeBytes: number;
  format: string;
  role: string;
  family?: string;
  variant?: string;
  quant?: string;
  paramsB?: number;
  hasVision?: boolean;
  compatible: boolean;
  reasons: string[];
  install?: string;
}

export interface ManifestEntry {
  id: string;
  role: string;
  label: string;
  repo: string;
  revision: string;
  file: string;
  dest: string;
  sizeBytes?: number;
  sha256?: string;
  license: string;
  licenseUrl?: string;
  required?: boolean;
  note?: string;
  alternatives?: Array<{ file: string; sizeBytes?: number; sha256?: string; note?: string }>;
}

export interface Job {
  id: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  request: { prompt: string; images?: string[]; width?: number; height?: number; size?: number };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: number;
  stage?: string;
  etaSeconds?: number;
  error?: string;
  images?: string[];
  /** preview of the current step, while the job runs */
  preview?: string;
  /** how many pictures the job made */
  imageCount?: number;
  /** the real path of every picture written on disk (null where the write failed) */
  files?: Array<string | null>;
  /** what produced this image: model, steps, seed, profile */
  provenance?: {
    model?: string;
    baseModel?: string;
    textEncoder?: string;
    vae?: string;
    modelSha256?: string;
    quant?: string;
    profile?: string;
    steps?: number;
    seed?: number;
    cfgScale?: number;
    sampler?: string;
    size?: number;
    width?: number;
    height?: number;
    hires?: boolean;
    detailer?: boolean;
    durationSeconds?: number;
    engine?: string;
  };
}

export function formatEngineStage(stage?: string): string {
  const value = stage?.trim();
  if (!value) return 'Preparing SD.Next';
  if (/^step\s+\d+\/\d+/i.test(value)) return value;
  const normalized = value.toLowerCase();
  const verification = normalized.match(/checking .*files?\s*\((\d+)%\)/);
  if (verification) return `Checking local model files · ${verification[1]}%`;
  if (/verifying .*profile files|checking .*files/.test(normalized)) return 'Checking local model files';
  if (/building the local .*reference/.test(normalized)) return 'Building the local model reference';
  if (/registering .*reference/.test(normalized)) return 'Registering the model reference with SD.Next';
  if (/reference ready/.test(normalized)) return 'Local model reference ready';
  if (/could not prepare .*reference/.test(normalized)) return 'Could not prepare the local model reference';
  if (/load.*(te|text.?encoder)|text.?encoder/.test(normalized)) return 'Loading the text encoder';
  if (/load.*(vae)|\bvae\b/.test(normalized)) return 'Loading the VAE';
  if (/load.*(dit|transformer|unet|model)/.test(normalized)) return 'Loading the image model';
  if (/inference|txt2img|img2img|sampling|generation/.test(normalized)) return 'Generating the image';
  return `SD.Next: ${value}`;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '—';
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${bytes} B`;
}
