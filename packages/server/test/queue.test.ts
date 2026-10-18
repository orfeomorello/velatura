import { describe, expect, it } from 'vitest';
import { JobQueue } from '../src/queue.js';

describe('job queue', () => {
  it('runs one job at a time and reports progress', async () => {
    const seen: number[] = [];
    const queue = new JobQueue(async (_request, onProgress) => {
      onProgress(0.5);
      seen.push(50);
      onProgress(1);
      return { images: ['data:image/png;base64,AAA'] };
    });

    const job = queue.submit({ prompt: 'a small studio' });
    // the worker may already have picked it up
    expect(['queued', 'running']).toContain(job.state);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const finished = queue.get(job.id);
    expect(finished?.state).toBe('done');
    expect(finished?.images?.length).toBe(1);
    expect(seen).toEqual([50]);
  });

  it('preserves an SD.Next loading phase when generation progress is still zero', async () => {
    const queue = new JobQueue(async (_request, onProgress) => {
      onProgress(undefined, undefined, undefined, 'Load TE');
      return { images: ['image'] };
    });
    const job = queue.submit({ prompt: 'first-load' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(queue.get(job.id)?.stage).toBe('Load TE');
  });

  it('keeps the order of the submissions', async () => {
    const order: string[] = [];
    const queue = new JobQueue(async (request) => {
      order.push(request.prompt);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { images: [] };
    });

    queue.submit({ prompt: 'first' });
    queue.submit({ prompt: 'second' });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(order).toEqual(['first', 'second']);
  });

  it('cancels a queued job', async () => {
    const queue = new JobQueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { images: [] };
    });

    const first = queue.submit({ prompt: 'long job' });
    const second = queue.submit({ prompt: 'never runs' });

    expect(queue.cancel(second.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(queue.get(second.id)?.state).toBe('cancelled');
    expect(queue.get(first.id)?.state).toBe('done');
  });

  it('reports the error of a failed job without stopping the queue', async () => {
    let calls = 0;
    const queue = new JobQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error('SD.Next is not running');
      return { images: ['ok'] };
    });

    const failing = queue.submit({ prompt: 'boom' });
    const following = queue.submit({ prompt: 'after' });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(queue.get(failing.id)?.state).toBe('error');
    expect(queue.get(failing.id)?.error).toMatch(/not running/);
    expect(queue.get(following.id)?.state).toBe('done');
  });

  it('frees the memory of a picture that was deleted from the disk', async () => {
    const queue = new JobQueue(async () => ({
      images: ['base64-one', 'base64-two'],
      files: ['/store/day/aaa-1.png', '/store/day/aaa-2.png'],
    }));

    const job = queue.submit({ prompt: 'two pictures' });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(queue.get(job.id)?.images).toEqual(['base64-one', 'base64-two']);

    const released = queue.releaseImage('/store/day/aaa-1.png');

    expect(released).toEqual([job.id]);
    const after = queue.get(job.id);
    // the copy in memory is gone, and the list of the files stays aligned
    expect(after?.images).toEqual(['base64-two']);
    expect(after?.files).toEqual(['/store/day/aaa-2.png']);
  });

  it('tells the interface when a picture is released', async () => {
    const queue = new JobQueue(async () => ({
      images: ['base64-one'],
      files: ['/store/day/bbb-1.png'],
    }));
    const events: Array<{ type: string; job?: { images?: string[] } }> = [];
    queue.onEvent((event) => events.push(event));

    queue.submit({ prompt: 'one picture' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    events.length = 0;

    queue.releaseImage('/store/day/bbb-1.png');

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('job');
    expect(events[0]?.job?.images).toEqual([]);
  });

  it('ignores a path that is not one of ours', async () => {
    const queue = new JobQueue(async () => ({
      images: ['base64-one'],
      files: ['/store/day/ccc-1.png'],
    }));
    const job = queue.submit({ prompt: 'one picture' });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(queue.releaseImage('/etc/passwd')).toEqual([]);
    expect(queue.get(job.id)?.images).toEqual(['base64-one']);
  });

  it('drops the preview when the job is over', async () => {
    const queue = new JobQueue(async (_request, onProgress) => {
      onProgress(0.5, 10, 'preview-base64');
      return { images: ['done'] };
    });
    const job = queue.submit({ prompt: 'a job with a preview' });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(queue.get(job.id)?.state).toBe('done');
    expect(queue.get(job.id)?.preview).toBeUndefined();
  });
});
