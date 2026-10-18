import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiagnosticLog, safeJobError } from '../src/diagnostics.js';

describe('Velatura diagnostic log', () => {
  it('redacts prompt and data-URI text from job errors', () => {
    const safe = safeJobError('engine echoed: private prompt text data:image/png;base64,AAAA', {
      prompt: 'private prompt text',
    });
    expect(safe).not.toContain('private prompt text');
    expect(safe).not.toContain('data:image/png;base64,AAAA');
    expect(safe).toContain('[prompt redacted]');
    expect(safe).toContain('[image data redacted]');
  });

  it('writes readable JSONL and redacts prompts and image data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-log-'));
    const file = join(dir, 'logs', 'velatura.log');
    try {
      const log = new DiagnosticLog(file);
      log.info('generation.request.will_send', {
        jobId: 'job-1',
        prompt: 'private prompt text',
        image: 'private image bytes',
        imageCount: 1,
      });
      await log.flush();
      const [line] = (await readFile(file, 'utf8')).trim().split('\n');
      const record = JSON.parse(line!) as Record<string, unknown>;
      expect(record).toMatchObject({
        level: 'info',
        event: 'generation.request.will_send',
        jobId: 'job-1',
        prompt: '[redacted]',
        image: '[redacted]',
        imageCount: 1,
      });
      expect(line).not.toContain('private prompt text');
      expect(line).not.toContain('private image bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rotates a full log and retains the previous file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-log-'));
    const file = join(dir, 'velatura.log');
    try {
      const log = new DiagnosticLog(file, 150, 1);
      log.info('first', { value: 'a'.repeat(80) });
      await log.flush();
      log.info('second', { value: 'b'.repeat(80) });
      await log.flush();
      expect(await stat(`${file}.1`).then(() => true, () => false)).toBe(true);
      expect(await readFile(file, 'utf8')).toContain('second');
      expect(await readFile(`${file}.1`, 'utf8')).toContain('first');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clears current and rotated logs and disables logging for the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-log-'));
    const file = join(dir, 'velatura.log');
    try {
      const log = new DiagnosticLog(file, 150, 1);
      log.info('first', { value: 'a'.repeat(80) });
      await log.flush();
      log.info('second', { value: 'b'.repeat(80) });
      await log.flush();
      const result = await log.clear();
      expect(result.deleted).toContain(file);
      expect(result.deleted).toContain(`${file}.1`);
      log.info('must-not-return', {});
      await log.flush();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
