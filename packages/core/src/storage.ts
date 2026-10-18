/**
 * Append-only storage, one JSON object per line.
 *
 * We chose JSONL on purpose: a crash in the middle of a write costs at
 * most one line, the file can be read with `tail`, and it needs no
 * database. Broken lines are skipped instead of stopping the reader.
 */
import { appendFile, mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class JsonlStore<T> {
  constructor(private readonly path: string) {}

  async append(record: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async readAll(): Promise<T[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        // a truncated line: skip it, keep the rest
      }
    }
    return out;
  }

  /**
   * Replace the whole file.
   *
   * The write goes to a temporary name and is renamed over the old one:
   * a crash in the middle leaves the old file, never a half-written one.
   */
  async rewrite(records: T[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body = records.map((record) => `${JSON.stringify(record)}\n`).join('');
    const temporary = join(dirname(this.path), `.${Date.now()}.jsonl`);
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, this.path);
  }

  /** The last `limit` records, newest last. */
  async read(limit = 100): Promise<T[]> {
    const all = await this.readAll();
    return all.slice(Math.max(0, all.length - limit));
  }
}


/**
 * Is there room on the disk for this download?
 * The manifest's sizes are exact, but the temporary space and the margin
 * make it necessary to ask for a little more.
 */
export async function checkDiskSpace(
  path: string,
  bytes: number,
  margin = 0.1,
): Promise<{ ok: boolean; freeBytes: number; neededBytes: number; problem?: string }> {
  const needed = Math.ceil(bytes * (1 + margin));
  try {
    const stats = await statfs(dirname(path));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (freeBytes < needed) {
      return {
        ok: false,
        freeBytes,
        neededBytes: needed,
        problem: `not enough space on the disk: ${formatBytes(freeBytes)} free, ${formatBytes(needed)} needed`,
      };
    }
    return { ok: true, freeBytes, neededBytes: needed };
  } catch {
    // we cannot know: we do not block the download
    return { ok: true, freeBytes: 0, neededBytes: needed };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}
