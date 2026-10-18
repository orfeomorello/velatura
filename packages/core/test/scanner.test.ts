import { describe, expect, it } from 'vitest';
import { scanFile } from '../src/scanner.js';
import { buildGguf, buildSafetensors, tempDir, writeFixture } from './fixtures.js';

describe('semantic scanner', () => {
  it('recognises a Qwen-Image 2.1 Turbo GGUF by its header, not by its name', async () => {
    const dir = await tempDir();
    // deliberately unhelpful file name: the decision must come from the content
    const path = await writeFixture(
      dir,
      'model.gguf',
      buildGguf({
        architecture: 'qwen_image',
        name: 'Qwen-Image-2.1-Turbo',
        tensors: [{ name: 'blk.0.attn_q.weight', dims: [1024, 1024] }],
      }),
    );

    const result = await scanFile(path);
    expect(result.format).toBe('gguf');
    expect(result.role).toBe('dit');
    expect(result.family).toBe('qwen-image-2.1');
    expect(result.variant).toBe('turbo');
    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('flags a non Qwen-Image architecture', async () => {
    const dir = await tempDir();
    const path = await writeFixture(
      dir,
      'flux.gguf',
      buildGguf({ architecture: 'flux', name: 'flux-dev' }),
    );
    const result = await scanFile(path);
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/not a Qwen-Image/i);
  });

  it('detects a LoRA', async () => {
    const dir = await tempDir();
    const path = await writeFixture(
      dir,
      'lightning.safetensors',
      buildSafetensors({
        tensors: {
          'lora_A.weight': { dtype: 'BF16', shape: [16, 1024] },
          'lora_B.weight': { dtype: 'BF16', shape: [1024, 16] },
        },
      }),
    );
    const result = await scanFile(path);
    expect(result.role).toBe('lora');
    expect(result.compatible).toBe(true);
  });

  it('detects the 2.1 VAE and rejects the 1.x VAE', async () => {
    const dir = await tempDir();
    const good = await writeFixture(
      dir,
      'qwen_image_2.1_vae_bf16.safetensors',
      buildSafetensors({
        tensors: {
          'vae.post_quant_conv.weight': { dtype: 'BF16', shape: [1, 1, 1, 1] },
          'vae.encoder.conv_in.weight': { dtype: 'BF16', shape: [1, 1, 1, 1] },
        },
      }),
    );
    const old = await writeFixture(
      dir,
      'qwen_image_vae.safetensors',
      buildSafetensors({
        tensors: {
          'vae.post_quant_conv.weight': { dtype: 'BF16', shape: [1, 1, 1, 1] },
          'vae.encoder.conv_in.weight': { dtype: 'BF16', shape: [1, 1, 1, 1] },
        },
      }),
    );

    const ok = await scanFile(good);
    expect(ok.role).toBe('vae');
    expect(ok.compatible).toBe(true);

    const bad = await scanFile(old);
    expect(bad.role).toBe('vae');
    expect(bad.compatible).toBe(false);
    expect(bad.reasons.join(' ')).toMatch(/not interchangeable/i);
  });

  it('detects the vision tower of the Qwen3-VL encoder', async () => {
    const dir = await tempDir();
    const path = await writeFixture(
      dir,
      'qwen3vl_8b_w4a8.safetensors',
      buildSafetensors({
        tensors: {
          'model.visual.blocks.0.attn.qkv.weight': { dtype: 'INT8', shape: [1024, 1024] },
          'model.language_model.layers.0.self_attn.q_proj.weight': { dtype: 'INT8', shape: [1024, 1024] },
        },
      }),
    );
    const result = await scanFile(path);
    expect(result.role).toBe('text-encoder');
    expect(result.hasVision).toBe(true);
    expect(result.compatible).toBe(true);
  });

  it('warns when the text encoder has no vision tower (editing would break)', async () => {
    const dir = await tempDir();
    const path = await writeFixture(
      dir,
      'text_encoder.safetensors',
      buildSafetensors({
        tensors: {
          'model.language_model.layers.0.self_attn.q_proj.weight': { dtype: 'INT8', shape: [1024, 1024] },
        },
      }),
    );
    const result = await scanFile(path);
    expect(result.role).toBe('text-encoder');
    expect(result.hasVision).toBe(false);
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/vision tower/i);
  });

  it('never throws on a file that is not a model', async () => {
    const dir = await tempDir();
    const path = await writeFixture(dir, 'notes.txt', Buffer.from('hello'));
    const result = await scanFile(path);
    expect(result.format).toBe('unknown');
    expect(result.compatible).toBe(false);
  });
});

describe('a LoRA is not a "base" model', () => {
  it('does not read the metadata key "base_model_name_or_path" as the variant', async () => {
    const dir = await tempDir('velatura-lora-');
    const path = await writeFixture(
      dir,
      'pytorch_lora_weights.safetensors',
      buildSafetensors({
        tensors: {
          'transformer.transformer_blocks.0.attn.to_k.lora.down.weight': { dtype: 'BF16', shape: [16, 16] },
        },
        metadata: {
          lora_adapter_metadata: JSON.stringify({
            'transformer.base_model_name_or_path': null,
            'transformer.alpha_pattern': {},
          }),
        },
      }),
    );
    const scan = await scanFile(path);
    expect(scan.role).toBe('lora');
    expect(scan.variant).toBeUndefined();
    expect(scan.compatible).toBe(true);
  });
});
