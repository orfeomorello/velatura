import { describe, expect, it } from 'vitest';
import {
  chooseCheckpointReloadAlias,
  profileRuntimeMatches,
  requireProfileModels,
  sdnextTextEncoderName,
} from '../src/profile-model.js';

const validSelection = {
  expectedBase: 'Qwen-Image-2.1',
  resolvedBase: 'Qwen-Image-2.1 [abc123]',
  expectedDit: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
  resolvedDit: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
  expectedTextEncoder: 'qwen3vl_8b_w4a8.safetensors',
  resolvedTextEncoder: 'qwen3vl_8b_w4a8.safetensors',
  expectedVae: 'qwen_image_2.1_vae_bf16.safetensors',
  resolvedVae: 'qwen_image_2.1_vae_bf16.safetensors',
};

describe('profile model selection', () => {
  it('uses the text-encoder option key SD.Next indexes from a safetensors file', () => {
    expect(sdnextTextEncoderName('C:\\sdnext\\models\\Text-encoder\\qwen3vl_8b_w4a8.safetensors')).toBe(
      'qwen3vl_8b_w4a8',
    );
    expect(sdnextTextEncoderName('qwen3vl_8b_w4a8.gguf')).toBe('qwen3vl_8b_w4a8.gguf');
  });

  it('allows an explicitly resolved Qwen base and its separate components', () => {
    expect(() => requireProfileModels(validSelection)).not.toThrow();
  });

  it('requires a base checkpoint for a UNET/DiT profile', () => {
    expect(() =>
      requireProfileModels({
        expectedDit: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
      }),
    ).toThrow(/does not specify its SD.Next base checkpoint/i);
  });

  it('refuses to continue when the Qwen base checkpoint is not listed', () => {
    expect(() =>
      requireProfileModels({
        expectedBase: 'Qwen-Image-2.1',
        expectedDit: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
        resolvedDit: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
      }),
    ).toThrow(/not listed in SD.Next's local model list/i);
  });

  it('does not accept an unrelated checkpoint override', () => {
    expect(() =>
      requireProfileModels({
        ...validSelection,
        explicitBase: 'sdxl-default-model',
      }),
    ).toThrow(/does not match the active profile's required base model/i);
  });

  it('does not resolve the base profile to another model with a similar name', () => {
    expect(() =>
      requireProfileModels({
        ...validSelection,
        resolvedBase: 'Qwen-Image-2.1-Turbo [abc123]',
      }),
    ).toThrow(/resolved.*instead of the active profile's required base model/i);
  });

  it('reports an unrecognized UNET/DiT component separately from the base checkpoint', () => {
    expect(() =>
      requireProfileModels({
        ...validSelection,
        resolvedDit: undefined,
      }),
    ).toThrow(/UNET\/DiT component.*\/sdapi\/v1\/unets/i);
  });

  it('requires the profile text encoder and VAE when specified', () => {
    expect(() =>
      requireProfileModels({
        ...validSelection,
        resolvedTextEncoder: undefined,
      }),
    ).toThrow(/text encoder.*models\/Text-encoder/i);

    expect(() =>
      requireProfileModels({
        ...validSelection,
        resolvedVae: undefined,
      }),
    ).toThrow(/VAE component.*\/sdapi\/v1\/sd-vae/i);
  });

  it('recognizes when the requested Qwen base, pipeline, and components are already active', () => {
    expect(
      profileRuntimeMatches({
        expectedBase: 'Qwen-Image-2.1',
        loadedBase: 'Qwen-Image-2.1 [abc123]',
        selectedBase: 'Qwen-Image-2.1 [abc123]',
        expectedPipeline: 'Qwen21',
        selectedPipeline: 'Qwen21',
        loadedPipelineClass: 'QwenImage21Pipeline',
        expectedDit: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
        selectedDit: 'C:\\sdnext\\models\\UNET\\qwen-image-2.1-turbo-Q4_K_M.gguf',
        expectedTextEncoder: 'qwen3vl_8b_w4a8.safetensors',
        selectedTextEncoder: 'qwen3vl_8b_w4a8',
        expectedVae: 'qwen_image_2.1_vae_bf16.safetensors',
        selectedVae: 'qwen_image_2.1_vae_bf16.safetensors',
      }),
    ).toBe(true);
  });

  it('accepts Autodetect only when SD.Next loaded the Qwen Image 2.1 pipeline class', () => {
    const state = {
      expectedBase: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
      loadedBase: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
      selectedBase: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
      expectedPipeline: 'Autodetect',
      selectedPipeline: 'Autodetect',
      loadedPipelineClass: 'QwenImage21Pipeline',
      expectedDit: 'Default',
      selectedDit: 'Default',
      expectedTextEncoder: 'Default',
      selectedTextEncoder: 'Default',
      expectedVae: 'Automatic',
      selectedVae: 'Automatic',
    };
    expect(profileRuntimeMatches(state)).toBe(true);
    expect(profileRuntimeMatches({ ...state, loadedPipelineClass: 'StableDiffusionXLPipeline' })).toBe(false);
  });

  it('requires a matching loaded base and pipeline before omitting the checkpoint reload', () => {
    const state = {
      expectedBase: 'Qwen-Image-2.1',
      loadedBase: 'Qwen-Image-2.1 [abc123]',
      selectedBase: 'Qwen-Image-2.1 [abc123]',
      expectedPipeline: 'Qwen21',
      selectedPipeline: 'Qwen21',
      loadedPipelineClass: 'QwenImage21Pipeline',
    };
    expect(profileRuntimeMatches(state)).toBe(true);
    expect(profileRuntimeMatches({ ...state, selectedBase: 'seductionCurves_V30 [94ea979604]' })).toBe(false);
    expect(profileRuntimeMatches({ ...state, selectedPipeline: 'Stable Diffusion XL' })).toBe(false);
    expect(profileRuntimeMatches({ ...state, loadedPipelineClass: 'StableDiffusionXLPipeline' })).toBe(false);
  });

  it('chooses a registered checkpoint alias different from the active option to force reload', () => {
    expect(
      chooseCheckpointReloadAlias(
        ['Qwen-Image-2.1', 'Qwen-Image-2.1 [abc123]', 'C:\\models\\Qwen-Image-2.1.safetensors'],
        'Qwen-Image-2.1',
      ),
    ).toBe('Qwen-Image-2.1 [abc123]');
    expect(chooseCheckpointReloadAlias(['Qwen-Image-2.1'], 'Qwen-Image-2.1')).toBe('Qwen-Image-2.1');
  });

  it('does not require components for a profile that does not declare them', () => {
    expect(() => requireProfileModels({})).not.toThrow();
  });
});
