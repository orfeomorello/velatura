import { describe, expect, it } from 'vitest';
import { buildGeneratePayload, stripDataUrl } from '../src/payload.js';
import type { Profile } from '../src/types.js';

const lowProfile: Profile = {
  id: 'lowvram',
  label: 'Low (default)',
  description: 'Turbo SDNQ dynamic UINT4',
  vramGb: 13,
  steps: 8,
  resolution: 1024,
  emphasis: 'speed',
  sampling: { samplerName: 'Default', cfgScale: 1 },
  post: {
    hires: { enabled: false, scale: 1.5, steps: 4, denoising: 0.35 },
    detailer: { enabled: false, strength: 0.3, steps: 10 },
  },
  models: [],
  engine: { pipeline: 'Autodetect', checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4' },
};

const fullProfile: Profile = {
  ...lowProfile,
  id: 'full',
  label: 'Full',
  emphasis: 'quality',
  vramGb: 32,
  engine: { pipeline: 'Autodetect', checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-BF16' },
};

describe('generate payload', () => {
  it('takes the pinned Turbo defaults from the Low profile', () => {
    const payload = buildGeneratePayload(lowProfile, { prompt: 'a cat' });
    expect(payload.prompt).toBe('a cat');
    expect(payload.negative_prompt).toBe('');
    expect(payload.steps).toBe(8);
    expect(payload.cfg_scale).toBe(1);
    expect(payload.cfg_true).toBe(1);
    expect(payload.width).toBe(1024);
    expect(payload.height).toBe(1024);
    expect(payload.seed).toBe(-1);
    expect(payload.batch_size).toBe(1);
    expect(payload.sampler_name).toBe('Default');
    expect(payload.enable_hr).toBeUndefined();
    expect(payload.detailer_enabled).toBeUndefined();
  });

  it('respects user-requested steps and true-guidance settings for Full BF16', () => {
    const payload = buildGeneratePayload(fullProfile, { prompt: 'a cat', steps: 30, cfgScale: 5 });
    expect(payload.steps).toBe(30);
    expect(payload.cfg_scale).toBe(1);
    expect(payload.cfg_true).toBe(5);
  });

  it('keeps the requested size, steps, cfgScale, and seed', () => {
    const payload = buildGeneratePayload(lowProfile, {
      prompt: 'a cat',
      steps: 20,
      size: 1536,
      cfgScale: 6.5,
      seed: 42,
    });
    expect(payload.steps).toBe(20);
    expect(payload.width).toBe(1536);
    expect(payload.height).toBe(1536);
    expect(payload.cfg_scale).toBe(1);
    expect(payload.cfg_true).toBe(6.5);
    expect(payload.seed).toBe(42);
  });

  it('sends the reference images as raw base64', () => {
    const payload = buildGeneratePayload(lowProfile, {
      prompt: 'edit this',
      images: ['data:image/png;base64,AAAA', 'BBBB'],
    });
    expect(payload.init_images).toEqual(['AAAA', 'BBBB']);
    expect(payload.denoising_strength).toBeCloseTo(0.35);
  });

  it('turns the extra passes on when asked, with the SD.Next field names', () => {
    const payload = buildGeneratePayload(lowProfile, { prompt: 'x', hires: true, detailer: true });
    expect(payload.enable_hr).toBe(true);
    expect(payload.hr_scale).toBe(1.5);
    expect(payload.hr_second_pass_steps).toBe(4);
    expect(payload.hr_denoising_strength).toBeCloseTo(0.35);
    expect(payload.detailer_enabled).toBe(true);
    expect(payload.detailer_steps).toBe(10);
    expect(payload.detailer_strength).toBeCloseTo(0.3);
  });

  it('selects the managed Diffusers reference with Autodetect and offline mode', () => {
    const payload = buildGeneratePayload(lowProfile, { prompt: 'x' }, {
      checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
    });
    expect(payload.override_settings).toEqual({
      offline_mode: true,
      te_shared_te: false,
      diffusers_pipeline: 'Autodetect',
      sd_model_checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
    });
    expect(payload.override_settings_restore_afterwards).toBe(false);
  });

  it('selects the profile reference when no explicit checkpoint override is passed', () => {
    const payload = buildGeneratePayload(lowProfile, { prompt: 'x' });
    expect(payload.override_settings).toEqual({
      offline_mode: true,
      te_shared_te: false,
      diffusers_pipeline: 'Autodetect',
      sd_model_checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
    });
  });

  it('resets replaceable components to pipeline defaults for the assembled Turbo reference', () => {
    const payload = buildGeneratePayload(lowProfile, { prompt: 'x' }, {
      checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
      unet: 'Default',
      textEncoder: 'Default',
      vae: 'Automatic',
    });
    expect(payload.override_settings).toEqual({
      offline_mode: true,
      te_shared_te: false,
      sd_unet: 'Default',
      sd_text_encoder: 'Default',
      sd_vae: 'Automatic',
      diffusers_pipeline: 'Autodetect',
      sd_model_checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
    });
    expect(payload.sd_unet).toBeUndefined();
    expect(payload.sd_text_encoder).toBeUndefined();
    expect(payload.sd_vae).toBeUndefined();
  });

  it('keeps generic Qwen21 payload overrides available outside the two pinned profiles', () => {
    const genericProfile: Profile = {
      ...lowProfile,
      engine: { pipeline: 'Qwen21', checkpoint: 'Qwen-Image-2.1' },
    };
    const payload = buildGeneratePayload(genericProfile, { prompt: 'x', steps: 20, cfgScale: 6.5 }, {
      checkpoint: 'Qwen-Image-2.1 [local-alias]',
      unet: 'custom.safetensors',
    });
    const overrides = payload.override_settings as Record<string, unknown>;
    expect(payload.steps).toBe(20);
    expect(payload.cfg_true).toBe(6.5);
    expect(overrides.diffusers_pipeline).toBe('Qwen21');
    expect(overrides.sd_model_checkpoint).toBe('Qwen-Image-2.1 [local-alias]');
    expect(overrides.sd_unet).toBe('custom.safetensors');
    expect(Object.keys(overrides).indexOf('diffusers_pipeline')).toBeLessThan(
      Object.keys(overrides).indexOf('sd_model_checkpoint'),
    );
  });

  it('can omit a profile checkpoint override when the selected model is already active', () => {
    const payload = buildGeneratePayload(lowProfile, { prompt: 'x' }, {
      skipCheckpointOverride: true,
      unet: 'Default',
      textEncoder: 'Default',
      vae: 'Automatic',
    });
    expect(payload.override_settings).toEqual({
      offline_mode: true,
      te_shared_te: false,
      sd_unet: 'Default',
      sd_text_encoder: 'Default',
      sd_vae: 'Automatic',
      diffusers_pipeline: 'Autodetect',
    });
    expect(payload.override_settings_restore_afterwards).toBe(false);

    const attachedEnginePayload = buildGeneratePayload(lowProfile, { prompt: 'x' }, {
      skipCheckpointOverride: true,
      restoreOverrideSettings: true,
    });
    expect(attachedEnginePayload.override_settings_restore_afterwards).toBe(true);
  });

  it('supports non-square width and height aspect ratio presets', () => {
    const payload = buildGeneratePayload(lowProfile, {
      prompt: 'widescreen landscape',
      width: 1280,
      height: 720,
    });
    expect(payload.width).toBe(1280);
    expect(payload.height).toBe(720);
  });

  it('strips the data url prefix only when there is one', () => {
    expect(stripDataUrl('data:image/png;base64,AAAA')).toBe('AAAA');
    expect(stripDataUrl('AAAA')).toBe('AAAA');
  });
});
