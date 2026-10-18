/**
 * Semantic file scanner.
 *
 * Reads only the *header* of a model file and decides what it is:
 *  - GGUF        (magic "GGUF", KV metadata + tensor infos)
 *  - Safetensors (8-byte LE header length + JSON header)
 *
 * This is what makes the "manual placement" mode safe: we can accept a
 * community quantisation we have never seen, because we do not rely on a
 * file name or on a known SHA-256 — we read the file itself.
 */
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { ComponentRole, ScanResult } from './types.js';

const GGUF_MAGIC = 0x46554747; // 'GGUF' little endian
const MAX_TENSORS = 200_000;

class ByteReader {
  private pos = 0;

  private constructor(private readonly fh: FileHandle) {}

  static async open(path: string): Promise<ByteReader> {
    return new ByteReader(await open(path, 'r'));
  }

  private async exact(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(n);
    let read = 0;
    while (read < n) {
      const { bytesRead } = await this.fh.read(buf, read, n - read, this.pos + read);
      if (bytesRead === 0) throw new Error('unexpected end of file');
      read += bytesRead;
    }
    this.pos += n;
    return buf;
  }

  async u8(): Promise<number> {
    return (await this.exact(1)).readUInt8(0);
  }

  async i8(): Promise<number> {
    return (await this.exact(1)).readInt8(0);
  }

  async u16(): Promise<number> {
    return (await this.exact(2)).readUInt16LE(0);
  }

  async i16(): Promise<number> {
    return (await this.exact(2)).readInt16LE(0);
  }

  async u32(): Promise<number> {
    return (await this.exact(4)).readUInt32LE(0);
  }

  async i32(): Promise<number> {
    return (await this.exact(4)).readInt32LE(0);
  }

  async f32(): Promise<number> {
    return (await this.exact(4)).readFloatLE(0);
  }

  async f64(): Promise<number> {
    return (await this.exact(8)).readDoubleLE(0);
  }

  async u64(): Promise<bigint> {
    return (await this.exact(8)).readBigUInt64LE(0);
  }

  async i64(): Promise<bigint> {
    return (await this.exact(8)).readBigInt64LE(0);
  }

  async bool(): Promise<boolean> {
    return (await this.u8()) !== 0;
  }

  async str(): Promise<string> {
    const len = Number(await this.u64());
    return (await this.exact(len)).toString('utf8');
  }

  async value(type: number): Promise<unknown> {
    switch (type) {
      case 0:
        return this.u8();
      case 1:
        return this.i8();
      case 2:
        return this.u16();
      case 3:
        return this.i16();
      case 4:
        return this.u32();
      case 5:
        return this.i32();
      case 6:
        return this.f32();
      case 7:
        return this.bool();
      case 8:
        return this.str();
      case 9: {
        const elemType = await this.u32();
        const count = Number(await this.u64());
        const out: unknown[] = [];
        for (let i = 0; i < count; i++) out.push(await this.value(elemType));
        return out;
      }
      case 10:
        return this.u64();
      case 11:
        return this.i64();
      case 12:
        return this.f64();
      default:
        throw new Error(`unknown GGUF value type ${type}`);
    }
  }

  async close(): Promise<void> {
    await this.fh.close();
  }
}

export interface GgufInfo {
  format: 'gguf';
  version: number;
  metadata: Record<string, unknown>;
  tensors: Array<{ name: string; dims: number[] }>;
  paramsB: number;
}

export interface SafetensorsInfo {
  format: 'safetensors';
  metadata: Record<string, string>;
  tensors: Array<{ name: string; dtype: string; shape: number[] }>;
  paramsB: number;
}

export type HeaderInfo = GgufInfo | SafetensorsInfo;

function countParams(dims: number[]): number {
  let n = 1;
  for (const d of dims) n *= d;
  return n;
}

export async function readGguf(path: string): Promise<GgufInfo> {
  const r = await ByteReader.open(path);
  try {
    const magic = await r.u32();
    if (magic !== GGUF_MAGIC) throw new Error('not a GGUF file');
    const version = await r.u32();
    const tensorCount = Number(await r.u64());
    const kvCount = Number(await r.u64());

    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str();
      const type = await r.u32();
      metadata[key] = await r.value(type);
    }

    const tensors: Array<{ name: string; dims: number[] }> = [];
    let params = 0;
    const n = Math.min(tensorCount, MAX_TENSORS);
    for (let i = 0; i < n; i++) {
      const name = await r.str();
      const nDims = await r.u32();
      const dims: number[] = [];
      for (let d = 0; d < nDims; d++) dims.push(Number(await r.u64()));
      await r.u32(); // ggml type
      await r.u64(); // offset
      tensors.push({ name, dims });
      params += countParams(dims);
    }

    return { format: 'gguf', version, metadata, tensors, paramsB: params / 1e9 };
  } finally {
    await r.close();
  }
}

export async function readSafetensors(path: string): Promise<SafetensorsInfo> {
  const fh = await open(path, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    await fh.read(lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (headerLen <= 0 || headerLen > 100 * 1024 * 1024) throw new Error('invalid safetensors header');
    const header = Buffer.allocUnsafe(headerLen);
    await fh.read(header, 0, headerLen, 8);
    const parsed = JSON.parse(header.toString('utf8')) as Record<
      string,
      { dtype?: string; shape?: number[] } | Record<string, string>
    >;

    const metadata: Record<string, string> = {};
    const tensors: Array<{ name: string; dtype: string; shape: number[] }> = [];
    let params = 0;
    for (const [name, value] of Object.entries(parsed)) {
      if (name === '__metadata__') {
        metadata.__metadata__ = JSON.stringify(value);
        continue;
      }
      const t = value as { dtype?: string; shape?: number[] };
      const shape = t.shape ?? [];
      tensors.push({ name, dtype: t.dtype ?? 'unknown', shape });
      params += countParams(shape);
    }
    return { format: 'safetensors', metadata, tensors, paramsB: params / 1e9 };
  } finally {
    await fh.close();
  }
}

const RE_LORA = /(lora[._](a|b|down|up)|lora_te|lora_base_model)/i;
const RE_VAE = /(^|[./])(vae|autoencoder)|post_quant_conv|quant_conv|decoder\.conv|encoder\.conv|vae\./i;
const RE_DIT =
  /diffusion_model|transformer_blocks|double_blocks|single_blocks|img_(in|norm|mod|attn|mlp)|txt_(in|norm|mod|attn|mlp)|time_text_embed|pos_embed|patch_embed|context_embedder|\bblk\.\d+\./i;
const RE_TEXT_ENCODER = /text_model|language_model|qwen3_?vl|qwen2_5_vl|model\.layers|lm_head|visual\.|vision_model/i;

function roleFromTensorNames(names: string[]): ComponentRole {
  const joined = names.slice(0, 400).join('\n');
  if (RE_LORA.test(joined)) return 'lora';
  if (RE_DIT.test(joined)) return 'dit';
  if (RE_VAE.test(joined) && !RE_TEXT_ENCODER.test(joined)) return 'vae';
  if (RE_TEXT_ENCODER.test(joined)) return 'text-encoder';
  return 'unknown';
}

function familyFrom(name: string): string | undefined {
  if (/qwen[-_.\s]?image[-_.\s]?2\.1/i.test(name)) return 'qwen-image-2.1';
  if (/qwen[-_.\s]?image/i.test(name)) return 'qwen-image';
  if (/qwen3[-_.\s]?vl/i.test(name)) return 'qwen3-vl';
  return undefined;
}

function variantFrom(name: string, role?: ComponentRole): string | undefined {
  const n = name.toLowerCase();
  if (n.includes('lightning')) return 'lightning';
  if (n.includes('viggle')) return 'viggle-turbo';
  if (role === 'lora') return undefined; // a LoRA has no turbo/base variant
  if (n.includes('turbo')) return 'turbo';
  if (n.includes('4step') || n.includes('4-step')) return 'lightning';
  // "base" only as a word: the metadata of a LoRA contains keys like
  // "base_model_name_or_path", and that is not the variant
  if (/\bbase\b/.test(n)) return 'base';
  return undefined;
}

function quantFrom(name: string, info: HeaderInfo): string | undefined {
  const n = name.toLowerCase();
  // the label keeps the precision: "Q4" and "Q5" need a different profile
  const table: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
    [/ad[-_]?q(\d+)(?:_k(?:_[ms])?)?/, (m) => `AD-Q${m[1]}`],
    [/q(\d+)_k_[ms]/, (m) => `Q${m[1]}`],
    [/q(\d+)_0/, (m) => `Q${m[1]}`],
    [/w4a8/, 'w4a8'],
    [/w8a8/, 'w8a8'],
    [/int8[-_]?convrot/, 'int8'],
    [/int8/, 'int8'],
    [/uint4/, 'uint4'],
    [/bf16/, 'bf16'],
    [/fp16/, 'fp16'],
    [/f16/, 'fp16'],
  ];
  for (const [re, label] of table) {
    const match = n.match(re);
    if (match) return typeof label === 'function' ? label(match) : label;
  }
  if (info.format === 'gguf') {
    const t = info.metadata['general.file_type'];
    if (typeof t === 'number') return `gguf-type-${t}`;
  }
  return undefined;
}

function hasVisionTensor(info: HeaderInfo): boolean | undefined {
  if (info.format === 'gguf') {
    const arch = String(info.metadata['general.architecture'] ?? '');
    const names = info.tensors.map((t) => t.name).join('\n');
    if (arch.includes('clip') || /visual\.|vision/.test(names)) return true;
    if (arch.includes('mllama') || arch.includes('qwen')) return undefined;
    return false;
  }
  const names = info.tensors.map((t) => t.name).join('\n');
  if (/visual\.|vision_model|vision_tower/.test(names)) return true;
  if (RE_TEXT_ENCODER.test(names)) return false;
  return undefined;
}

function archOf(info: HeaderInfo): string | undefined {
  if (info.format === 'gguf') {
    const arch = info.metadata['general.architecture'];
    return typeof arch === 'string' ? arch : undefined;
  }
  return undefined;
}

/** Everything we know about the file, as one searchable string. */
function nameHints(info: HeaderInfo, fileName: string): string {
  const parts: string[] = [fileName];
  if (info.format === 'gguf') {
    for (const key of ['general.name', 'general.basename', 'general.description']) {
      const v = info.metadata[key];
      if (typeof v === 'string') parts.push(v);
    }
  } else {
    const meta = info.metadata.__metadata__;
    if (meta) {
      try {
        const parsed = JSON.parse(meta) as Record<string, string>;
        parts.push(...Object.values(parsed));
      } catch {
        /* ignore */
      }
    }
  }
  return parts.join(' ');
}

/** Decide whether a scanned file can be used by the Qwen-Image 2.1 pipeline. */
export function assess(info: HeaderInfo, fileName: string, sizeBytes?: number): {
  role: ComponentRole;
  family?: string;
  variant?: string;
  quant?: string;
  paramsB?: number;
  hasVision?: boolean;
  compatible: boolean;
  reasons: string[];
} {
  const names = info.tensors.map((t) => t.name);
  const role = roleFromTensorNames(names);
  const hints = nameHints(info, fileName);
  const family = familyFrom(hints);
  // "turbo" and "base" describe a DiT; a LoRA is neither
  const variant =
    role === 'dit' || role === 'text-encoder' ? variantFrom(hints) : variantFrom(hints, role);
  const quant = quantFrom(hints, info);
  const hasVision = hasVisionTensor(info);
  const reasons: string[] = [];

  const arch = archOf(info);
  const isQwenImage = arch ? /qwen[_-]?image/i.test(arch) : role === 'dit';
  if (arch && !isQwenImage && (role === 'dit' || role === 'unknown')) {
    reasons.push(`architecture "${arch}" is not a Qwen-Image model`);
  }

  if (role === 'dit') {
    if (family === 'qwen-image-2.1') {
      // ok
    } else if (family === 'qwen-image') {
      reasons.push('this is a Qwen-Image 1.x/2.0 DiT — not compatible with the 2.1 pipeline');
    }
    if (info.paramsB !== undefined && info.paramsB < 0.5 && (sizeBytes ?? 0) > 50 * 1024 * 1024) {
      reasons.push('the header announces a very small model but the file is large — it may be truncated');
    }
  }

  if (role === 'vae') {
    const n = fileName.toLowerCase();
    if (/2[._-]?1/.test(n)) {
      // the 2.1 VAE
    } else if (/qwen[-_.]?image[-_.]?vae|vae.*(bf16|fp16)\.safetensors/i.test(n)) {
      reasons.push('this looks like the Qwen-Image 1.x/2.0 VAE — the 2.1 VAE is NOT interchangeable');
    }
  }

  if (role === 'text-encoder' && hasVision === false) {
    reasons.push('text encoder without the vision tower — image editing will not work');
  }

  return {
    role,
    family,
    variant,
    quant,
    paramsB: info.paramsB,
    hasVision,
    compatible: reasons.length === 0,
    reasons,
  };
}

export async function scanFile(path: string): Promise<ScanResult> {
  const st = await stat(path);
  const name = path.split(/[\\/]/).pop() ?? path;
  const base: ScanResult = {
    path,
    name,
    sizeBytes: st.size,
    format: 'unknown',
    role: 'unknown',
    compatible: false,
    reasons: ['unrecognised file format'],
    meta: {},
  };

  let info: HeaderInfo;
  try {
    const fh = await open(path, 'r');
    try {
      const magic = Buffer.alloc(4);
      await fh.read(magic, 0, 4, 0);
      if (magic.readUInt32LE(0) === GGUF_MAGIC) info = await readGguf(path);
      else info = await readSafetensors(path);
    } finally {
      await fh.close();
    }
  } catch (err) {
    base.reasons = [`cannot read the file header: ${(err as Error).message}`];
    return base;
  }

  const verdict = assess(info, name, st.size);
  return {
    ...base,
    format: info.format,
    role: verdict.role,
    family: verdict.family,
    variant: verdict.variant,
    quant: verdict.quant,
    paramsB: verdict.paramsB,
    hasVision: verdict.hasVision,
    compatible: verdict.compatible,
    reasons: verdict.reasons,
    meta: {
      arch: archOf(info),
      tensorCount: info.tensors.length,
      ggufVersion: info.format === 'gguf' ? info.version : undefined,
    },
  };
}
