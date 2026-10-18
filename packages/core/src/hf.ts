/**
 * Minimal Hugging Face client.
 *
 * We deliberately do not depend on an SDK: we need three things only —
 * list the files of a repo (with their sha256, which HF exposes as the LFS
 * oid), download a file with resume, and support a mirror (HF_ENDPOINT).
 */
import { createHash } from 'node:crypto';
import { checkDiskSpace } from './storage.js';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface HfFile {
  path: string;
  sizeBytes?: number;
  /** sha256, only available for LFS files */
  sha256?: string;
}

export interface HfOptions {
  /** base URL, e.g. https://huggingface.co or a mirror */
  mirror?: string;
  /** local HF token (never uploaded anywhere else) */
  token?: string;
}

export function hfBase(mirror?: string): string {
  const base = mirror ?? process.env.HF_ENDPOINT ?? 'https://huggingface.co';
  return base.replace(/\/+$/, '');
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function encodeRepoPath(repo: string): string {
  return repo.split('/').map(encodeURIComponent).join('/');
}

/** Resolve the commit sha of a repo revision, so the manifest can pin it. */
export async function resolveRevision(repo: string, revision = 'main', opts: HfOptions = {}): Promise<string> {
  const url = `${hfBase(opts.mirror)}/api/models/${encodeRepoPath(repo)}/revision/${encodeURIComponent(revision)}`;
  const res = await fetch(url, { headers: authHeaders(opts.token) });
  if (!res.ok) throw new Error(`HF: cannot resolve ${repo}@${revision} (HTTP ${res.status})`);
  const data = (await res.json()) as { sha?: string };
  return data.sha ?? revision;
}

/** List every file of a repo, with sizes and (for LFS files) sha256. */
export async function listRepoFiles(
  repo: string,
  revision = 'main',
  opts: HfOptions = {},
): Promise<HfFile[]> {
  const out: HfFile[] = [];
  let url: string | undefined = `${hfBase(opts.mirror)}/api/models/${encodeRepoPath(repo)}/tree/${encodeURIComponent(revision)}?recursive=true&limit=1000`;

  while (url) {
    const res: Response = await fetch(url, { headers: authHeaders(opts.token) });
    if (!res.ok) throw new Error(`HF: cannot list ${repo} (HTTP ${res.status})`);
    const items = (await res.json()) as Array<{
      type?: string;
      path?: string;
      size?: number;
      lfs?: { oid?: string; size?: number };
    }>;
    for (const item of items) {
      if (item.type === 'directory' || !item.path) continue;
      const file: HfFile = { path: item.path };
      if (item.lfs?.size !== undefined) file.sizeBytes = item.lfs.size;
      else if (item.size !== undefined) file.sizeBytes = item.size;
      if (item.lfs?.oid) file.sha256 = item.lfs.oid;
      out.push(file);
    }
    const link = res.headers.get('link');
    const next = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = next?.[1] ?? undefined;
  }
  return out;
}

export function fileUrl(repo: string, revision: string, file: string, opts: HfOptions = {}): string {
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return `${hfBase(opts.mirror)}/${encodeRepoPath(repo)}/resolve/${encodeURIComponent(revision)}/${encoded}`;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  resumed: boolean;
}

/** Download with resume support, computing the sha256 while streaming. */
export async function downloadFile(
  repo: string,
  revision: string,
  file: string,
  dest: string,
  opts: HfOptions & {
    onProgress?: (bytes: number, total?: number) => void;
    /** how many bytes the file will take, when we know it (the manifest) */
    expectedBytes?: number;
    /**
     * the checksum the manifest declares.
     *
     * When it is given, the file is checked *before* it gets its final
     * name: a corrupted download must never become the file the engine
     * looks for.
     */
    expectedSha256?: string;
  } = {},
): Promise<DownloadResult> {
  await mkdir(dirname(dest), { recursive: true });

  // the disk must have room: the manifest knows the size, and we keep a margin
  if (opts.expectedBytes) {
    const space = await checkDiskSpace(dest, opts.expectedBytes);
    if (!space.ok) throw new Error(space.problem);
  }

  const part = `${dest}.part`;

  let start = 0;
  try {
    const st = await stat(part);
    start = st.size;
  } catch {
    start = 0;
  }

  const headers: Record<string, string> = { ...authHeaders(opts.token) };
  if (start > 0) headers.range = `bytes=${start}-`;

  const res = await fetch(fileUrl(repo, revision, file, opts), { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HF: download failed for ${repo}/${file} (HTTP ${res.status})`);
  }
  const resumed = res.status === 206 && start > 0;
  const total = Number(res.headers.get('content-length') ?? 0) + (resumed ? start : 0);
  if (!res.body) throw new Error('HF: empty response body');

  const hash = createHash('sha256');
  let bytes = start;

  // On resume the hash must cover the whole file, not only the new bytes:
  // we hash what is already on disk first, then the stream continues it.
  if (resumed && start > 0) {
    await new Promise<void>((resolve, reject) => {
      const existing = createReadStream(part, { highWaterMark: 4 * 1024 * 1024 });
      existing.on('data', (chunk) => hash.update(chunk as Buffer));
      existing.on('end', () => resolve());
      existing.on('error', reject);
    });
  }

  const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });

  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        hash.update(buf);
        bytes += buf.length;
        opts.onProgress?.(bytes, total || undefined);
        yield buf;
      }
    },
    out,
  );

  // a truncated download must not become the final file: the partial file
  // stays on disk, so the next attempt continues it
  if (opts.expectedBytes && bytes !== opts.expectedBytes) {
    throw new Error(
      `the download stopped at ${bytes} bytes, expected ${opts.expectedBytes} — the partial file was kept, run it again to continue`,
    );
  }

  const digest = hash.digest('hex');

  // the checksum is checked before the file gets its final name: the engine
  // must never find a file that was not verified
  if (opts.expectedSha256 && digest.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
    throw new Error(
      `sha256 mismatch: got ${digest}, expected ${opts.expectedSha256} — ` +
        `the partial file was kept at ${part}, the final file was not written`,
    );
  }

  await promote(part, dest);
  return { path: dest, bytes, sha256: digest, resumed };
}

/**
 * Give the partial file its final name.
 *
 * On Windows the rename fails if the destination exists and is open by
 * somebody else (the engine, for a model it has loaded): the file is
 * removed first, and if that is not possible the error says it plainly.
 */
async function promote(part: string, dest: string): Promise<void> {
  try {
    await rename(part, dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
  }
  // the destination is in the way: remove it and try again
  await rm(dest, { force: true }).catch(() => undefined);
  await rename(part, dest);
}

/** Select one file from a repo listing, using simple patterns. */
export function selectFile(files: HfFile[], spec: { match: string[]; prefer?: string[] }): HfFile | undefined {
  const match = (f: HfFile, patterns: string[]) => patterns.every((p) => f.path.toLowerCase().includes(p.toLowerCase()));
  const candidates = files.filter((f) => match(f, spec.match));
  if (candidates.length === 0) return undefined;
  if (spec.prefer) {
    for (const p of spec.prefer) {
      const hit = candidates.find((f) => f.path.toLowerCase().includes(p.toLowerCase()));
      if (hit) return hit;
    }
  }
  // biggest file first: the main checkpoint is usually the largest
  return [...candidates].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
}

export { join };
