#!/usr/bin/env node
/**
 * Regenerate the pinned Velatura profile manifest from upstream repository metadata.
 *
 * The source revisions and paths are fixed below. This script lists files at
 * those exact commits; it never resolves `main` or follows a moving branch.
 * It downloads no model weights.
 *
 *   npm run build --workspace @velatura/core
 *   node scripts/generate-manifest.mjs
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRepoFiles } from '../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '..', 'manifests', 'models.yaml');

/** @type {Array<{id:string,role:string,label:string,repo:string,revision:string,file:string,dest:string,license:string,licenseUrl:string,required?:boolean,note?:string}>} */
const SPECS = [
  {
    id: 'dit-turbo-sdnq-uint4',
    role: 'dit',
    label: 'Qwen-Image 2.1 Turbo — SDNQ dynamic UINT4 transformer',
    repo: 'OzzyGT/Qwen_Image_2_1_Turbo_sdnq_dynamic_4bit',
    revision: '05c2f7737886dff796a8c0f592383f641b73c8dd',
    file: 'transformer/diffusion_pytorch_model.safetensors',
    dest: 'UNET',
    license: 'qwen-research',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/LICENSE',
    note: 'Community SDNQ dynamic UINT4/Hadamard quantization. The complete Low profile also needs its matching SDNQ text encoder, VAE and tokenizer. Qwen Research terms are non-commercial.',
  },
  {
    id: 'te-qwen3vl-sdnq-dynamic-int4',
    role: 'text-encoder',
    label: 'Qwen3-VL 8B — SDNQ dynamic UINT4 text and vision encoder',
    repo: 'OzzyGT/Qwen_Image_2_1_Turbo_sdnq_dynamic_4bit',
    revision: '05c2f7737886dff796a8c0f592383f641b73c8dd',
    file: 'text_encoder/model.safetensors',
    dest: 'Text-encoder',
    license: 'qwen-research',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/LICENSE',
    note: 'Matching SDNQ encoder from the pinned Turbo repository; includes the visual tower needed for image editing.',
  },
  {
    id: 'vae-2.1-sdnq',
    role: 'vae',
    label: 'Qwen-Image 2.1 Turbo VAE — SDNQ repository',
    repo: 'OzzyGT/Qwen_Image_2_1_Turbo_sdnq_dynamic_4bit',
    revision: '05c2f7737886dff796a8c0f592383f641b73c8dd',
    file: 'vae/diffusion_pytorch_model.safetensors',
    dest: 'VAE',
    license: 'qwen-research',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/LICENSE',
    note: 'Use this VAE with the matching SDNQ profile; it is not byte-identical to the BF16 VAE used by Full.',
  },
  {
    id: 'dit-turbo-bf16',
    role: 'dit',
    label: 'Qwen-Image 2.1 Turbo — BF16 transformer',
    repo: 'Comfy-Org/Qwen-Image-2.1',
    revision: 'a8342359c61979b06a8dafb1a47991fe1f30e994',
    file: 'diffusion_models/qwen_image_2.1_turbo_bf16.safetensors',
    dest: 'UNET',
    license: 'qwen-research',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
    note: 'Full-profile Turbo transformer weights in BF16. This is not the undistilled 40-step base model.',
  },
  {
    id: 'te-qwen3vl-bf16',
    role: 'text-encoder',
    label: 'Qwen3-VL 8B — BF16 text and vision encoder',
    repo: 'Comfy-Org/Qwen-Image-2.1',
    revision: 'a8342359c61979b06a8dafb1a47991fe1f30e994',
    file: 'text_encoders/qwen3vl_8b_bf16.safetensors',
    dest: 'Text-encoder',
    license: 'qwen-research',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
    note: 'BF16 encoder shared with the Qwen-Image 2.1 model family; includes the visual tower needed for image editing.',
  },
  {
    id: 'vae-2.1-bf16',
    role: 'vae',
    label: 'Qwen-Image 2.1 Turbo VAE — BF16',
    repo: 'Comfy-Org/Qwen-Image-2.1',
    revision: 'a8342359c61979b06a8dafb1a47991fe1f30e994',
    file: 'vae/qwen_image_2.1_vae_bf16.safetensors',
    dest: 'VAE',
    license: 'qwen-research',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
    note: 'BF16 VAE used by Full; it is not interchangeable with the Qwen-Image 1.x/2.0 VAE.',
  },
  {
    id: 'lora-lightning-4step',
    role: 'lora',
    label: 'Lightning 4-step LoRA',
    repo: 'lightx2v/Qwen-Image-2.1-Lightning',
    revision: '6b0a1176327c01522a44276c5da67331a025b6fc',
    file: 'pytorch_lora_weights.safetensors',
    dest: 'Lora',
    license: 'unknown',
    licenseUrl: 'https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning',
    required: false,
    note: 'Optional LoRA retained in Low by user decision. Compatibility with the Turbo 8-step schedule is not verified; the licence is undeclared.',
  },
];

function yamlString(value) {
  return JSON.stringify(value);
}

async function main() {
  const entries = [];
  const problems = [];

  for (const spec of SPECS) {
    process.stdout.write(`· ${spec.id} — ${spec.repo}@${spec.revision}\n`);
    try {
      const files = await listRepoFiles(spec.repo, spec.revision);
      const file = files.find((candidate) => candidate.path === spec.file);
      if (!file) throw new Error(`file not found at pinned path: ${spec.file}`);
      if (!file.sha256 || !file.sizeBytes) throw new Error('upstream metadata does not include a pinned size and LFS SHA-256');
      entries.push({ ...spec, sizeBytes: file.sizeBytes, sha256: file.sha256 });
    } catch (error) {
      problems.push(`${spec.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const lines = [
    '# Velatura model manifest',
    '#',
    '# GENERATED FILE — exact repository revisions are pinned in the script.',
    '# Regenerate with: node scripts/generate-manifest.mjs',
    '#',
    '# Metadata only. Velatura does not distribute weights; the UI displays the',
    '# exact file, size, SHA-256 and licence before an explicit download.',
    'version: 1',
    `generatedAt: ${yamlString(new Date().toISOString().slice(0, 10))}`,
    'models:',
  ];
  for (const entry of entries) {
    lines.push(`  - id: ${entry.id}`);
    lines.push(`    role: ${entry.role}`);
    lines.push(`    label: ${yamlString(entry.label)}`);
    lines.push(`    repo: ${entry.repo}`);
    lines.push(`    revision: ${yamlString(entry.revision)}`);
    lines.push(`    file: ${yamlString(entry.file)}`);
    lines.push(`    dest: ${entry.dest}`);
    lines.push(`    sizeBytes: ${entry.sizeBytes}`);
    lines.push(`    sha256: ${entry.sha256}`);
    lines.push(`    license: ${entry.license}`);
    lines.push(`    licenseUrl: ${entry.licenseUrl}`);
    lines.push(`    required: ${entry.required !== false}`);
    if (entry.note) lines.push(`    note: ${yamlString(entry.note)}`);
  }

  await writeFile(outPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nWrote ${outPath} (${entries.length} entries)`);
  if (problems.length > 0) {
    console.error('\nProblems:');
    for (const problem of problems) console.error(`  ! ${problem}`);
    process.exitCode = 1;
  }
}

main();
