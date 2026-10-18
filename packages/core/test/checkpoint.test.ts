import { describe, expect, it } from 'vitest';
import { matchCheckpoint, matchExactModel, normalizeModelName } from '../src/checkpoint.js';

describe('the name of a model', () => {
  it('ignores the case, the extension and the hash', () => {
    expect(normalizeModelName('Qwen-Image-2.1-Turbo-Q4_K_M.gguf')).toBe('qwenimage21turboq4km');
    expect(normalizeModelName('qwen-image-2.1-turbo-Q4_K_M.gguf [a1b2c3d4]')).toBe(
      'qwenimage21turboq4km',
    );
  });
});

describe('matching a base checkpoint by exact identity', () => {
  it('does not resolve the Qwen base to a Turbo variant with a shared prefix', () => {
    expect(
      matchExactModel('Qwen-Image-2.1', [
        'Qwen-Image-2.1-Turbo [abc123]',
        'Qwen-Image-2.1 [def456]',
      ]),
    ).toBe('Qwen-Image-2.1 [def456]');
  });

  it('does not guess a base model when only a different variant is available', () => {
    expect(matchExactModel('Qwen-Image-2.1', ['Qwen-Image-2.1-Turbo [abc123]'])).toBeUndefined();
  });
});

describe('matching a file with the models of the engine', () => {
  const models = [
    'qwen-image-2.1-turbo-Q4_K_M.gguf',
    'qwen_image_2.1_turbo_int8.safetensors [7f3d9c11]',
    'some_other_model.safetensors',
  ];

  it('finds the exact name', () => {
    expect(matchCheckpoint('qwen-image-2.1-turbo-Q4_K_M.gguf', models)).toBe(
      'qwen-image-2.1-turbo-Q4_K_M.gguf',
    );
  });

  it('finds a name the engine wrote with a hash', () => {
    expect(matchCheckpoint('qwen_image_2.1_turbo_int8.safetensors', models)).toBe(
      'qwen_image_2.1_turbo_int8.safetensors [7f3d9c11]',
    );
  });

  it('accepts a name the engine spells with less detail', () => {
    expect(matchCheckpoint('qwen_image_2.1_turbo_int8_convrot.safetensors', models)).toBe(
      'qwen_image_2.1_turbo_int8.safetensors [7f3d9c11]',
    );
  });

  it('does not confuse the turbo with the base', () => {
    expect(matchCheckpoint('qwen-image-2.1-Q4_K_M.gguf', models)).toBeUndefined();
    expect(matchCheckpoint('qwen-image-2.1-turbo-Q8_0.gguf', models)).toBeUndefined();
  });

  it('returns nothing when the engine does not know the file', () => {
    expect(matchCheckpoint('vae_2.1.safetensors', models)).toBeUndefined();
    expect(matchCheckpoint('anything.gguf', [])).toBeUndefined();
  });

  it('matches a name the engine wrote with the separator of Windows', () => {
    // on Windows the engine writes the folder with a backslash
    const models = [
      'models\\UNET\\other-qwen-image-2.1-turbo-Q4_K_M.gguf',
      'models\\UNET\\qwen-image-2.1-turbo-Q4_K_M.gguf [a1b2c3d4]',
    ];
    // the right one, and not the other one that has the same name in it
    expect(matchCheckpoint('qwen-image-2.1-turbo-Q4_K_M.gguf', models)).toBe(models[1]);
  });
});
