/**
 * Synthetic model-file fixtures.
 *
 * We build real (tiny) GGUF and Safetensors headers so the scanner can be
 * tested without downloading a single gigabyte — and so CI stays fast.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GGUF_MAGIC = 0x46554747;

function str(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(body.length));
  return Buffer.concat([len, body]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

function u64(value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

export interface GgufFixture {
  architecture?: string;
  name?: string;
  fileType?: number;
  tensors?: Array<{ name: string; dims: number[] }>;
}

/** Build a minimal but structurally valid GGUF file. */
export function buildGguf(fixture: GgufFixture = {}): Buffer {
  const tensors = fixture.tensors ?? [{ name: 'blk.0.attn_q.weight', dims: [1024, 1024] }];
  const kvs: Buffer[] = [];
  kvs.push(str('general.architecture'), u32(8), str(fixture.architecture ?? 'qwen_image'));
  kvs.push(str('general.name'), u32(8), str(fixture.name ?? 'Qwen-Image-2.1-Turbo'));
  kvs.push(str('general.file_type'), u32(4), u32(fixture.fileType ?? 15));

  const parts: Buffer[] = [u32(GGUF_MAGIC), u32(3), u64(tensors.length), u64(3), ...kvs];
  for (const t of tensors) {
    parts.push(str(t.name), u32(t.dims.length));
    for (const d of t.dims) parts.push(u64(d));
    parts.push(u32(0), u64(0));
  }
  return Buffer.concat(parts);
}

export interface SafetensorsFixture {
  tensors?: Record<string, { dtype?: string; shape: number[] }>;
  metadata?: Record<string, string>;
}

/** Build a minimal but structurally valid Safetensors file. */
export function buildSafetensors(fixture: SafetensorsFixture = {}): Buffer {
  const tensors = fixture.tensors ?? {
    'model.diffusion_model.blocks.0.attn.to_q.weight': { dtype: 'BF16', shape: [1024, 1024] },
  };
  const header: Record<string, unknown> = { ...tensors };
  if (fixture.metadata) header.__metadata__ = fixture.metadata;
  const body = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(body.length));
  // a little payload after the header, so the file is a plausible size
  return Buffer.concat([len, body, Buffer.alloc(64)]);
}

export async function tempDir(prefix = 'velatura-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeFixture(dir: string, name: string, data: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}
