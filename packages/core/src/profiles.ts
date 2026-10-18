/**
 * Velatura exposes exactly two pinned Turbo profiles: Low (SDNQ UINT4) and
 * Full (BF16). The VRAM values are selection heuristics only, not benchmarks.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Profile } from './types.js';

export const DEFAULT_PROFILES: Profile[] = [
  {
    id: 'lowvram',
    label: 'Low (default)',
    description: 'Turbo SDNQ dynamic UINT4 with the official 8-step schedule. Lower-resource development target; VRAM use has not yet been benchmarked on the selected SD.Next build.',
    vramGb: 13,
    steps: 8,
    resolution: 1024,
    emphasis: 'speed',
    sampling: { samplerName: 'Default', cfgScale: 1 },
    post: {
      hires: { enabled: false, scale: 1.5, steps: 4, denoising: 0.35 },
      detailer: { enabled: false, strength: 0.3, steps: 10 },
    },
    engine: { args: ['--api'], pipeline: 'Autodetect', checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4' },
    models: [
      { role: 'dit', manifestId: 'dit-turbo-sdnq-uint4' },
      { role: 'text-encoder', manifestId: 'te-qwen3vl-sdnq-dynamic-int4' },
      { role: 'vae', manifestId: 'vae-2.1-sdnq' },
      { role: 'lora', manifestId: 'lora-lightning-4step' },
    ],
  },
  {
    id: 'full',
    label: 'Full',
    description: 'Turbo BF16 transformer, encoder and VAE using the official 8-step schedule. About 32.44 GB of model weights; peak VRAM and offload requirements are not yet benchmarked.',
    vramGb: 32,
    steps: 8,
    resolution: 1024,
    emphasis: 'quality',
    sampling: { samplerName: 'Default', cfgScale: 1 },
    post: {
      hires: { enabled: false, scale: 1.5, steps: 8, denoising: 0.35 },
      detailer: { enabled: false, strength: 0.3, steps: 12 },
    },
    engine: { args: ['--api'], pipeline: 'Autodetect', checkpoint: 'Velatura-Qwen-Image-2.1-Turbo-BF16' },
    models: [
      { role: 'dit', manifestId: 'dit-turbo-bf16' },
      { role: 'text-encoder', manifestId: 'te-qwen3vl-bf16' },
      { role: 'vae', manifestId: 'vae-2.1-bf16' },
    ],
  },
];

export function parseProfiles(text: string): Profile[] {
  const raw = parseYaml(text) as unknown;
  if (!Array.isArray(raw)) throw new Error('profiles: expected a list');
  return raw.map((item, i) => {
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.label !== 'string') {
      throw new Error(`profiles[${i}]: id and label are required`);
    }
    const engine = parseEngine(p.engine);
    // Older on-disk copies of the built-in YAML profiles predate the explicit
    // base-checkpoint field. Preserve that required setting when parsing them.
    const defaultEngine = DEFAULT_PROFILES.find((profile) => profile.id === p.id)?.engine;
    const resolvedEngine = engine || defaultEngine
      ? {
          args: engine?.args ?? defaultEngine?.args,
          pipeline: engine?.pipeline ?? defaultEngine?.pipeline,
          checkpoint: engine?.checkpoint ?? defaultEngine?.checkpoint,
        }
      : undefined;
    return {
      id: p.id,
      label: p.label,
      description: p.description ? String(p.description) : undefined,
      vramGb: Number(p.vramGb ?? 0),
      steps: Number(p.steps ?? 8),
      resolution: Number(p.resolution ?? 1024),
      emphasis: (p.emphasis === 'quality' ? 'quality' : 'speed') as 'speed' | 'quality',
      sampling: parseSampling(p.sampling),
      post: parsePost(p.post),
      engine: resolvedEngine,
      models: Array.isArray(p.models)
        ? p.models.map((m) => {
            const mm = m as Record<string, unknown>;
            return {
              role: mm.role as Profile['models'][number]['role'],
              manifestId: String(mm.manifestId),
              file: mm.file ? String(mm.file) : undefined,
            };
          })
        : [],
    };
  });
}

function parseSampling(raw: unknown): Profile['sampling'] {
  if (!raw || typeof raw !== 'object') return { samplerName: 'Default', cfgScale: 1 };
  const s = raw as Record<string, unknown>;
  return {
    samplerName: s.samplerName ? String(s.samplerName) : 'Default',
    schedulersSigma: s.schedulersSigma ? String(s.schedulersSigma) : undefined,
    cfgScale: Number(s.cfgScale ?? 1),
  };
}

function parsePost(raw: unknown): Profile['post'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const out: NonNullable<Profile['post']> = {};
  if (p.hires && typeof p.hires === 'object') {
    const h = p.hires as Record<string, unknown>;
    out.hires = {
      enabled: Boolean(h.enabled),
      scale: Number(h.scale ?? 1.5),
      steps: Number(h.steps ?? 4),
      denoising: h.denoising === undefined ? undefined : Number(h.denoising),
    };
  }
  if (p.detailer && typeof p.detailer === 'object') {
    const d = p.detailer as Record<string, unknown>;
    out.detailer = {
      enabled: Boolean(d.enabled),
      strength: Number(d.strength ?? 0.3),
      steps: Number(d.steps ?? 10),
      prompt: d.prompt ? String(d.prompt) : undefined,
    };
  }
  return out;
}

function parseEngine(raw: unknown): Profile['engine'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  return {
    args: Array.isArray(e.args) ? e.args.map((a) => String(a)) : undefined,
    pipeline: e.pipeline ? String(e.pipeline) : undefined,
    checkpoint: e.checkpoint ? String(e.checkpoint) : undefined,
  };
}

/**
 * Load the profiles from a folder of YAML files.
 * A file that cannot be read does not stop the others: we would rather
 * run with the built-in profiles than not run at all.
 */
export async function loadProfiles(dir: string): Promise<Profile[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'));
  } catch {
    return DEFAULT_PROFILES;
  }
  const loaded: Profile[] = [];
  for (const name of names) {
    try {
      const text = await readFile(join(dir, name), 'utf8');
      for (const profile of parseProfiles(text)) loaded.push(profile);
    } catch {
      // skip the broken file
    }
  }
  // Upgrade-safe: stale standard/max YAML files from older installations do
  // not become extra selectable profiles. Keep the two built-ins in order and
  // fill a missing/broken file from the pinned in-code default.
  const byId = new Map(loaded.filter((profile) => DEFAULT_PROFILES.some((item) => item.id === profile.id)).map((profile) => [profile.id, profile]));
  return DEFAULT_PROFILES.map((profile) => byId.get(profile.id) ?? profile);
}

/**
 * Pick the profile to use.
 *
 * Default policy: **Low** is the default. It is the lower-resource SDNQ
 * target, but its actual VRAM use is not yet benchmarked. Full is opt-in.
 */
export function pickProfile(
  profiles: Profile[],
  vramGb: number,
  emphasis?: 'speed' | 'quality',
): Profile {
  const fitting = profiles
    .filter((p) => p.vramGb <= vramGb)
    .sort((a, b) => a.vramGb - b.vramGb);

  if (emphasis) {
    const preferred = fitting.filter((p) => p.emphasis === emphasis);
    if (preferred.length > 0) return preferred[preferred.length - 1]!;
    if (fitting.length > 0) return fitting[fitting.length - 1]!;
    return profiles[0]!;
  }

  const low = profiles.find((p) => p.id === 'lowvram');
  if (low && low.vramGb <= vramGb) return low;
  if (fitting.length > 0) return fitting[fitting.length - 1]!;
  // nothing fits: start from the cheapest profile
  return [...profiles].sort((a, b) => a.vramGb - b.vramGb)[0]!;
}

/**
 * Derive a profile from the files that are actually installed.
 * A Q5 quant uses more VRAM than the Q4 the profile was written for.
 */
export function deriveProfile(
  base: Profile,
  installed: Array<{ role: string; quant?: string; variant?: string; paramsB?: number }>,
): Profile {
  const dit = installed.find((i) => i.role === 'dit');
  let vramGb = base.vramGb;
  let steps = base.steps;

  if (dit?.quant) {
    const q = dit.quant.toLowerCase();
    if (q.includes('q8') || q.includes('int8')) vramGb = Math.max(vramGb, 16);
    else if (q.includes('q5') || q.includes('w8a8')) vramGb = Math.max(vramGb, 15);
    else if (q.includes('q4') || q.includes('w4a8')) vramGb = Math.max(vramGb, 13);
    else if (q.includes('bf16') || q.includes('fp16')) vramGb = Math.max(vramGb, 30);
  }
  if (dit?.variant === 'lightning') steps = 4;

  return { ...base, vramGb, steps, id: `${base.id}-derived` };
}
