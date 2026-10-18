/**
 * The bridge between our simplified request and SD.Next's API.
 *
 * The payload is built here, as a pure function, so it can be checked
 * without a GPU: the field names are the ones documented by SD.Next
 * (`/sdapi/v1/txt2img`, `/sdapi/v1/img2img`).
 */
import type { JobRequest, Profile } from './types.js';

export interface PayloadOptions {
  /** the base checkpoint/reference model, not the profile's UNET/DiT file */
  checkpoint?: string;
  /** omit the checkpoint value when SD.Next already has the profile base loaded */
  skipCheckpointOverride?: boolean;
  /** restore transient options only when no model reload is needed */
  restoreOverrideSettings?: boolean;
  /** SD.Next Diffusers pipeline, e.g. `Autodetect`, applied before the checkpoint */
  pipeline?: string;
  /** the UNET/DiT component selected from SD.Next's `/unets` list */
  unet?: string;
  /** the custom text encoder selected by the profile */
  textEncoder?: string;
  /** the VAE selected from SD.Next's `/sd-vae` list */
  vae?: string;
}

/** Remove the `data:image/png;base64,` prefix: SD.Next wants raw base64. */
export function stripDataUrl(value: string): string {
  const comma = value.indexOf(',');
  if (value.startsWith('data:') && comma > 0) return value.slice(comma + 1);
  return value;
}

export function buildGeneratePayload(
  profile: Profile | undefined,
  request: JobRequest,
  options: PayloadOptions = {},
): Record<string, unknown> {
  const sampling = profile?.sampling;
  const selectedPipeline = options.pipeline ?? profile?.engine?.pipeline;
  const managedQwenTurbo = /^Velatura-Qwen-Image-2\.1-Turbo-(?:SDNQ-UINT4|BF16)$/i.test(profile?.engine?.checkpoint ?? '');
  const steps = request.steps ?? profile?.steps ?? 8;
  const size = request.size ?? profile?.resolution ?? 1024;
  const width = request.width ?? size;
  const height = request.height ?? size;
  const qwen21 = selectedPipeline === 'Qwen21' || (selectedPipeline === 'Autodetect' && managedQwenTurbo);
  const requestedCfg = request.cfgScale ?? sampling?.cfgScale ?? (qwen21 ? 1 : 4);

  const payload: Record<string, unknown> = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt ?? '',
    steps,
    // QwenImage21Pipeline uses true_cfg_scale, not guidance_scale. SD.Next
    // exposes true_cfg_scale per request as cfg_true and maps it in processing.
    cfg_scale: qwen21 ? 1 : requestedCfg,
    seed: request.seed ?? -1,
    width,
    height,
    batch_size: 1,
    n: 1,
  };
  if (qwen21) payload.cfg_true = requestedCfg;

  // "Default" is the solver the loaded model ships with — we do not guess.
  payload.sampler_name = request.samplerName ?? sampling?.samplerName ?? 'Default';
  if (sampling?.schedulersSigma) payload.schedulers_sigma = sampling.schedulersSigma;

  const isEdit = (request.images?.length ?? 0) > 0;
  if (isEdit) {
    payload.init_images = (request.images ?? []).map(stripDataUrl);
    payload.denoising_strength = request.denoising ?? profile?.post?.hires?.denoising ?? 0.8;
  }

  // The second pass and the detailer: the names are the ones SD.Next uses
  // (see its Parameters page: enable_hr / hr_* and detailer_*).
  const hires = request.hires ?? profile?.post?.hires?.enabled ?? false;
  if (hires) {
    const h = profile?.post?.hires;
    payload.enable_hr = true;
    if (h?.scale) payload.hr_scale = h.scale;
    if (h?.steps) payload.hr_second_pass_steps = h.steps;
    if (h?.denoising !== undefined) payload.hr_denoising_strength = h.denoising;
  }
  const detailer = request.detailer ?? profile?.post?.detailer?.enabled ?? false;
  if (detailer) {
    const d = profile?.post?.detailer;
    payload.detailer_enabled = true;
    if (d?.steps) payload.detailer_steps = d.steps;
    if (d?.strength !== undefined) payload.detailer_strength = d.strength;
    if (d?.prompt) payload.detailer_prompt = d.prompt;
  }

  const overrides: Record<string, unknown> = { offline_mode: true };
  if (qwen21) overrides.te_shared_te = false;
  if (options.unet) overrides.sd_unet = options.unet;
  if (options.textEncoder) overrides.sd_text_encoder = options.textEncoder;
  if (options.vae) overrides.sd_vae = options.vae;
  if (options.pipeline ?? profile?.engine?.pipeline) {
    overrides.diffusers_pipeline = options.pipeline ?? profile?.engine?.pipeline;
  }
  const checkpoint = options.skipCheckpointOverride
    ? undefined
    : options.checkpoint ?? request.checkpoint ?? profile?.engine?.checkpoint;
  if (checkpoint) overrides.sd_model_checkpoint = checkpoint;
  if (Object.keys(overrides).length > 1) {
    payload.override_settings = overrides;
    payload.override_settings_restore_afterwards = options.restoreOverrideSettings ?? false;
  }

  return payload;
}
