/**
 * Velatura — shared contract between core, server, CLI and UI.
 * This file is the single source of truth for the API shape.
 */

export type ComponentRole = 'dit' | 'text-encoder' | 'vae' | 'lora' | 'mmproj' | 'unknown';

/** Where a component must live inside the SD.Next installation. */
export type SdnextSlot = 'UNET' | 'Text-encoder' | 'VAE' | 'Lora';

export interface ScanResult {
  path: string;
  name: string;
  sizeBytes: number;
  format: 'gguf' | 'safetensors' | 'unknown';
  role: ComponentRole;
  /** e.g. "qwen-image-2.1" */
  family?: string;
  /** e.g. "turbo" | "base" | "lightning" | "viggle-turbo" */
  variant?: string;
  /** e.g. "Q4_K_M" | "int8" | "w4a8" | "bf16" */
  quant?: string;
  /** parameter count in billions, when it can be derived from the header */
  paramsB?: number;
  /** true when the text encoder carries the vision tower (needed for image editing) */
  hasVision?: boolean;
  /** true when the file can be used with the 2.1 pipeline */
  compatible: boolean;
  /** human readable explanations, shown in the UI */
  reasons: string[];
  meta: Record<string, unknown>;
}

export interface ManifestAlternative {
  file: string;
  sizeBytes?: number;
  sha256?: string;
  note?: string;
}

export interface ManifestEntry {
  id: string;
  role: ComponentRole;
  label: string;
  /** Hugging Face repo id, e.g. "unsloth/Qwen-Image-2.1-Turbo-GGUF" */
  repo: string;
  /** pinned revision (commit sha) */
  revision: string;
  /** file name inside the repo */
  file: string;
  /** destination slot inside the SD.Next models folder */
  dest: SdnextSlot;
  sizeBytes?: number;
  /** sha256 of the file, when known */
  sha256?: string;
  license: string;
  licenseUrl?: string;
  /** other known-good files that satisfy the same role */
  alternatives?: ManifestAlternative[];
  required?: boolean;
  note?: string;
}

export interface Manifest {
  version: number;
  generatedAt?: string;
  models: ManifestEntry[];
}

export type PlacementMode = 'copy' | 'hardlink' | 'symlink' | 'in-place';

export interface PlacementPlan {
  source: string;
  target: string;
  mode: PlacementMode;
  sizeBytes: number;
  /** set when mode === 'in-place' */
  systemPath?: { slot: SdnextSlot; path: string };
}

export interface VerifyResult {
  path: string;
  sizeBytes: number;
  expectedSizeBytes?: number;
  sizeOk: boolean;
  expectedSha256?: string;
  actualSha256?: string;
  shaOk: boolean;
  /** ok only when every available check passed */
  ok: boolean;
  notes: string[];
}

export interface ProfileModel {
  role: ComponentRole;
  manifestId: string;
  /** override the file inside the repo (alternative) */
  file?: string;
}

/** Sampling parameters: the ones SD.Next understands per request. */
export interface ProfileSampling {
  /** "Default" keeps the solver the loaded model ships with */
  samplerName: string;
  /** default | karras | betas | exponential | lambdas | flowmatch */
  schedulersSigma?: string;
  cfgScale: number;
}

export interface ProfileHires {
  enabled: boolean;
  /** 1.5 = 150% */
  scale: number;
  steps: number;
  /** 0..1, how much of the original is kept */
  denoising?: number;
}

export interface ProfileDetailer {
  enabled: boolean;
  strength: number;
  steps: number;
  prompt?: string;
}

export interface ProfilePost {
  hires?: ProfileHires;
  detailer?: ProfileDetailer;
}

export interface ProfileEngine {
  /** extra command line flags for the SD.Next process */
  args?: string[];
  /** SD.Next Diffusers pipeline option, usually `Autodetect`; applied per generation. */
  pipeline?: string;
  /**
   * SD.Next base checkpoint/reference-model name, separate from the profile's
   * UNET/DiT component (which is sent as `sd_unet`).
   */
  checkpoint?: string;
}

export interface Profile {
  id: string;
  label: string;
  description?: string;
  /** Unbenchmarked selector heuristic in GB; not a measured minimum or guarantee. */
  vramGb: number;
  /** steps used by the sampler */
  steps: number;
  /** default output resolution */
  resolution: number;
  /** "speed" or "quality" */
  emphasis: 'speed' | 'quality';
  models: ProfileModel[];
  /** sampling defaults handed to the engine */
  sampling?: ProfileSampling;
  /** the extra pass and the detailer */
  post?: ProfilePost;
  /** how the engine must be started */
  engine?: ProfileEngine;
}

export interface JobRequest {
  prompt: string;
  images?: string[];
  negativePrompt?: string;
  steps?: number;
  seed?: number;
  size?: number;
  width?: number;
  height?: number;
  /** txt2img when no images are given */
  mode?: 'txt2img' | 'img2img';
  /** overrides the profile's guidance scale */
  cfgScale?: number;
  /** overrides the profile's solver */
  samplerName?: string;
  /** run the second (high resolution) pass */
  hires?: boolean;
  /** run the automatic detail pass */
  detailer?: boolean;
  /** how much of the reference image is kept, 0..1 */
  denoising?: number;
  /** the checkpoint the engine must load for this job */
  checkpoint?: string;
}

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/**
 * Where an image comes from.
 * The spec asks for it in the gallery: an image without its origin is
 * a picture, not a result you can reproduce.
 */
export interface Provenance {
  /** the UNET/DiT file selected for the profile */
  model?: string;
  /** the SD.Next base checkpoint, for example `Qwen-Image-2.1` */
  baseModel?: string;
  /** the text encoder selected for the profile */
  textEncoder?: string;
  /** the VAE selected for the profile */
  vae?: string;
  /** the SHA-256 of the DiT file, when it comes from the manifest */
  modelSha256?: string;
  /** the quantisation of the DiT, when it can be read from the file */
  quant?: string;
  /** the profile in use */
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
  /** seconds the job took, on this machine */
  durationSeconds?: number;
  /** the engine that produced it */
  engine?: string;
}

export interface Job {
  id: string;
  state: JobState;
  request: JobRequest;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 0..1 */
  progress?: number;
  /** Current SD.Next phase, such as loading the text encoder. */
  stage?: string;
  etaSeconds?: number;
  error?: string;
  images?: string[];
  /** base64 preview of the current step, while the job runs */
  preview?: string;
  /** raw SD.Next progress payload, for the advanced view */
  raw?: unknown;
  /** what produced this image */
  provenance?: Provenance;
  /** how many reference images the job had (the history does not keep the pictures) */
  imageCount?: number;
  /**
   * The real path of every picture written in the local store.
   *
   * The list is aligned with `images`: the entry at position *n* is the
   * path of the picture at position *n*, and it is null when the write
   * failed (the picture is still there, in memory).
   */
  files?: Array<string | null>;
}

export interface HardwareInfo {
  platform: string;
  arch: string;
  cpuModel: string;
  totalMemGb: number;
  gpus: Array<{
    vendor: string;
    name: string;
    vramGb?: number;
    driver?: string;
  }>;
  /** true when at least one GPU was detected */
  hasGpu: boolean;
}
