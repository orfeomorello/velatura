import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discardIsolatedSdnextConfig,
  isVelaturaSessionConfigPath,
  prepareIsolatedSdnextConfig,
  restoreIsolatedSdnextConfig,
} from '../src/session-config.js';

async function temporaryTree(): Promise<{ root: string; velatura: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'velatura-session-config-'));
  const velatura = join(root, 'velatura');
  return { root, velatura, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('isolated SD.Next session config', () => {
  it('uses a private copy and restores model defaults while keeping unrelated settings', async () => {
    const tree = await temporaryTree();
    const sdnext = join(tree.root, 'sdnext');
    const configPath = join(sdnext, 'config.json');
    const original = {
      sd_model_checkpoint: 'seductionCurves_V30 [94ea979604]',
      diffusers_pipeline: 'Stable Diffusion XL',
      sd_unet: 'Default',
      sd_text_encoder: 'Default',
      sd_vae: 'sdxl-vae',
      offline_mode: false,
      samples_format: 'png',
    };
    try {
      await mkdir(sdnext, { recursive: true });
      await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`);
      const prepared = await prepareIsolatedSdnextConfig(sdnext, ['--api', '--use-ipex'], tree.velatura);
      expect(prepared.args).toEqual(['--api', '--use-ipex', '--config', prepared.isolation.sessionPath]);
      expect(isVelaturaSessionConfigPath(prepared.isolation.sessionPath, tree.velatura)).toBe(true);
      expect(isVelaturaSessionConfigPath(configPath, tree.velatura)).toBe(false);
      expect(await readFile(configPath, 'utf8')).toContain('seductionCurves_V30');

      await writeFile(
        prepared.isolation.sessionPath,
        `${JSON.stringify({
          ...original,
          sd_model_checkpoint: 'Qwen-Image-2.1 [abc123]',
          diffusers_pipeline: 'Qwen21',
          sd_unet: 'qwen-image-2.1-turbo-Q4_K_M.gguf',
          sd_text_encoder: 'qwen3vl_8b_w4a8',
          sd_vae: 'qwen_image_2.1_vae_bf16',
          offline_mode: true,
          samples_format: 'jpeg',
        }, null, 2)}\n`,
      );
      await expect(restoreIsolatedSdnextConfig(prepared.isolation)).resolves.toMatchObject({
        status: 'restored',
        path: configPath,
      });

      const saved = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      expect(saved).toMatchObject({
        sd_model_checkpoint: original.sd_model_checkpoint,
        diffusers_pipeline: original.diffusers_pipeline,
        sd_unet: original.sd_unet,
        sd_text_encoder: original.sd_text_encoder,
        sd_vae: original.sd_vae,
        offline_mode: false,
        samples_format: 'jpeg',
      });
    } finally {
      await tree.cleanup();
    }
  });

  it('rewrites a custom --config argument and refuses to overwrite a concurrent user change', async () => {
    const tree = await temporaryTree();
    const sdnext = join(tree.root, 'sdnext');
    const customConfig = join(sdnext, 'custom', 'settings.json');
    try {
      await mkdir(join(sdnext, 'custom'), { recursive: true });
      await writeFile(customConfig, JSON.stringify({ sd_model_checkpoint: 'sdxl', samples_format: 'png' }));
      const prepared = await prepareIsolatedSdnextConfig(
        sdnext,
        ['--api', '--config', 'custom/settings.json', '--use-ipex'],
        tree.velatura,
      );
      expect(prepared.isolation.sourcePath).toBe(resolve(customConfig));
      expect(prepared.args).toEqual(['--api', '--use-ipex', '--config', prepared.isolation.sessionPath]);

      await writeFile(prepared.isolation.sessionPath, JSON.stringify({
        sd_model_checkpoint: 'Qwen-Image-2.1',
        samples_format: 'jpeg',
      }));
      await writeFile(customConfig, JSON.stringify({ sd_model_checkpoint: 'manual-user-change', samples_format: 'webp' }));
      await expect(restoreIsolatedSdnextConfig(prepared.isolation)).resolves.toMatchObject({
        status: 'concurrent-change',
      });
      expect(JSON.parse(await readFile(customConfig, 'utf8'))).toMatchObject({
        sd_model_checkpoint: 'manual-user-change',
        samples_format: 'webp',
      });
    } finally {
      await tree.cleanup();
    }
  });

  it('overrides private Diffusers and Hub-cache directories for the session and restores saved values', async () => {
    const tree = await temporaryTree();
    const sdnext = join(tree.root, 'sdnext');
    const configPath = join(sdnext, 'config.json');
    const original = {
      diffusers_dir: 'models/Diffusers',
      hfcache_dir: 'models/huggingface',
      offline_mode: false,
      sd_checkpoint_autoload: true,
      sd_checkpoint_autodownload: true,
      sdnq_quantize_weights: ['Model', 'TE'],
      sd_model_checkpoint: 'original-model',
      diffusers_pipeline: 'Stable Diffusion XL',
      sd_unet: 'original-unet',
      sd_text_encoder: 'original-text-encoder',
      sd_vae: 'original-vae',
      samples_format: 'png',
    };
    const privateDiffusers = join(tree.velatura, 'qwen21-turbo', 'diffusers');
    const privateHfCache = join(tree.velatura, 'qwen21-turbo', 'hf-cache');
    try {
      await mkdir(sdnext, { recursive: true });
      await writeFile(configPath, JSON.stringify(original));
      const prepared = await prepareIsolatedSdnextConfig(sdnext, ['--api'], tree.velatura, {
        diffusers_dir: privateDiffusers,
        hfcache_dir: privateHfCache,
        offline_mode: true,
        sd_checkpoint_autoload: false,
        sd_checkpoint_autodownload: false,
        sdnq_quantize_weights: [],
        sd_model_checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
        diffusers_pipeline: 'Autodetect',
        sd_unet: 'Default',
        sd_text_encoder: 'Default',
        te_shared_te: false,
        sd_vae: 'Automatic',
      });
      expect(JSON.parse(await readFile(prepared.isolation.sessionPath, 'utf8'))).toMatchObject({
        diffusers_dir: privateDiffusers,
        hfcache_dir: privateHfCache,
        offline_mode: true,
        sd_checkpoint_autoload: false,
        sd_checkpoint_autodownload: false,
        sdnq_quantize_weights: [],
        sd_model_checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
        diffusers_pipeline: 'Autodetect',
        sd_unet: 'Default',
        sd_text_encoder: 'Default',
        te_shared_te: false,
        sd_vae: 'Automatic',
      });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(original);

      await writeFile(
        prepared.isolation.sessionPath,
        JSON.stringify({
          ...original,
          diffusers_dir: privateDiffusers,
          hfcache_dir: privateHfCache,
          offline_mode: true,
          sd_checkpoint_autoload: false,
          sd_checkpoint_autodownload: false,
          sdnq_quantize_weights: [],
          sd_model_checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
          diffusers_pipeline: 'Autodetect',
          sd_unet: 'Default',
          sd_text_encoder: 'Default',
          te_shared_te: false,
          sd_vae: 'Automatic',
          samples_format: 'webp',
        }),
      );
      await expect(restoreIsolatedSdnextConfig(prepared.isolation)).resolves.toMatchObject({ status: 'restored' });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        ...original,
        samples_format: 'webp',
      });
    } finally {
      await tree.cleanup();
    }
  });

  it('removes the temporary config when an engine launch is discarded', async () => {
    const tree = await temporaryTree();
    const sdnext = join(tree.root, 'sdnext');
    try {
      await mkdir(sdnext, { recursive: true });
      const prepared = await prepareIsolatedSdnextConfig(sdnext, ['--api'], tree.velatura);
      expect(existsSync(prepared.isolation.sessionPath)).toBe(true);
      await expect(discardIsolatedSdnextConfig(prepared.isolation)).resolves.toBe(true);
      expect(existsSync(prepared.isolation.sessionPath)).toBe(false);
    } finally {
      await tree.cleanup();
    }
  });
});
