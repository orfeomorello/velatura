import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { configDir } from './config.js';

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export type DiagnosticFields = Record<string, unknown>;

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_ARCHIVES = 2;
const SECRET_FIELD = /prompt|base64|token|authorization|password|secret|headers|body|payload|api.?key|image(data)?s?$/i;

export function velaturaLogDirectory(): string {
  return resolve(configDir(), 'logs');
}

export function velaturaLogFile(): string {
  return resolve(velaturaLogDirectory(), 'velatura.log');
}

function scrub(value: unknown, key = ''): unknown {
  if (SECRET_FIELD.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return value
      .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g, '[image data redacted]')
      .slice(0, 2000);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => scrub(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        scrub(childValue, childKey),
      ]),
    );
  }
  return value;
}

/**
 * Small, local-only JSONL diagnostic log. It never records request bodies;
 * sensitive-looking fields and embedded image data are redacted as a second
 * line of defence. Writes are serialized and failures never break the app.
 */
export class DiagnosticLog {
  readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();
  private disabled = false;
  private warned = false;

  constructor(
    filePath = velaturaLogFile(),
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly archives = DEFAULT_ARCHIVES,
  ) {
    this.filePath = resolve(filePath);
  }

  info(event: string, fields: DiagnosticFields = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: DiagnosticFields = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: DiagnosticFields = {}): void {
    this.write('error', event, fields);
  }

  private write(level: DiagnosticLevel, event: string, fields: DiagnosticFields): void {
    if (this.disabled) return;
    const record = scrub({ at: new Date().toISOString(), level, event, ...fields });
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending
      .then(async () => {
        if (this.disabled) return;
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const existing = await stat(this.filePath).catch(() => undefined);
        if (existing && existing.size + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
        await appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
      })
      .catch((err: unknown) => {
        if (this.warned) return;
        this.warned = true;
        const message = err instanceof Error ? err.message : 'unknown file error';
        process.stderr.write(`Velatura could not write its diagnostic log: ${message}\n`);
      });
  }

  private async rotate(): Promise<void> {
    await rm(`${this.filePath}.${this.archives}`, { force: true });
    for (let index = this.archives - 1; index >= 1; index -= 1) {
      await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
    await rename(this.filePath, `${this.filePath}.1`);
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  /** Overwrite and delete current and rotated logs; suppress further writes until next start. */
  async clear(): Promise<{ deleted: string[]; failed: string[] }> {
    this.disabled = true;
    await this.flush();
    const { secureShredFile } = await import('@velatura/core');
    const deleted: string[] = [];
    const failed: string[] = [];
    for (let index = 0; index <= this.archives; index += 1) {
      const file = index === 0 ? this.filePath : `${this.filePath}.${index}`;
      const exists = await stat(file).then(() => true, () => false);
      if (!exists) continue;
      const ok = await secureShredFile(file);
      if (ok) {
        deleted.push(file);
      } else {
        failed.push(file);
      }
    }
    return { deleted, failed };
  }
}

/** Remove prompt/image text before recording an error attached to a job. */
export function safeJobError(message: string, request: { prompt?: string; negativePrompt?: string }): string {
  let safe = message.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g, '[image data redacted]');
  for (const text of [request.prompt, request.negativePrompt]) {
    if (text) safe = safe.split(text).join('[prompt redacted]');
  }
  return safe.slice(0, 2000);
}
