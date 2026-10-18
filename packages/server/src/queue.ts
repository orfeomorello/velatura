/**
 * The job queue.
 *
 * One GPU job at a time (SD.Next's own lock allows no more), with honest
 * ETA, cancellation and progress events. The runner is injected, so the
 * queue can be tested without a GPU.
 */
import { randomUUID } from 'node:crypto';
import type { Job, JobRequest, Provenance } from '@velatura/core';

export type QueueEvent =
  | { type: 'job'; job: Job }
  | { type: 'log'; message: string };

export type ProgressFn = (progress?: number, etaSeconds?: number, preview?: string, stage?: string) => void;

export interface Runner {
  (
    request: JobRequest,
    onProgress: ProgressFn,
    /** the id of the job: the runner names the files it writes */
    jobId: string,
  ): Promise<{ images: string[]; provenance?: Provenance; files?: Array<string | null> }>;
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly pending: string[] = [];
  private readonly listeners = new Set<(event: QueueEvent) => void>();
  private readonly cancelled = new Set<string>();
  private running = false;

  constructor(
    private runner: Runner,
    /** called once per job, when it reaches a final state */
    private onFinished?: (job: Job) => void,
  ) {}

  submit(request: JobRequest): Job {
    const job: Job = {
      id: randomUUID(),
      state: 'queued',
      request,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emit({ type: 'job', job: { ...job } });
    void this.pump();
    return { ...job };
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') return false;
    this.cancelled.add(id);
    if (job.state === 'queued') {
      const index = this.pending.indexOf(id);
      if (index >= 0) this.pending.splice(index, 1);
      job.state = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.emit({ type: 'job', job: { ...job } });
      // the job will never run: the mark is not needed any more
      this.cancelled.delete(id);
    }
    return true;
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  list(): Job[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  /**
   * Release the copy in memory of a picture that was deleted from the disk.
   *
   * The gallery keeps the pictures in RAM, as base64. When the file is
   * gone, the copy has to go with it: otherwise the image would still be
   * readable from the interface, and the memory of the session would grow
   * without bound.
   *
   * The list of `files` is aligned with the list of `images`, so the same
   * position is removed from both.
   *
   * @returns the ids of the jobs that changed.
   */
  releaseImage(path: string): string[] {
    const touched: string[] = [];
    for (const job of this.jobs.values()) {
      const files = job.files;
      const images = job.images;
      if (!files || !images) continue;
      const index = files.indexOf(path);
      if (index < 0) continue;
      files.splice(index, 1);
      images.splice(index, 1);
      // the picture is gone: the job is done, but it has nothing to show
      if (!images.length) job.preview = undefined;
      touched.push(job.id);
      this.emit({ type: 'job', job: { ...job } });
    }
    return touched;
  }

  /**
   * Remove finished, failed or cancelled jobs from the in-memory session queue.
   */
  clearCompleted(): number {
    let removed = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  onEvent(listener: (event: QueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const id = this.pending.shift()!;
        const job = this.jobs.get(id);
        if (!job || this.cancelled.has(id)) continue;
        job.state = 'running';
        job.startedAt = new Date().toISOString();
        this.emit({ type: 'job', job: { ...job } });

        try {
          const result = await this.runner(
            job.request,
            (progress, etaSeconds, preview, stage) => {
              job.progress = progress;
              job.etaSeconds = etaSeconds;
              job.stage = stage;
              if (preview) job.preview = preview;
              this.emit({ type: 'job', job: { ...job } });
            },
            job.id,
          );
          if (this.cancelled.has(id)) {
            job.state = 'cancelled';
          } else {
            job.state = 'done';
            job.images = result.images;
            job.progress = 1;
            // what produced this image: the gallery shows it
            if (result.provenance) job.provenance = result.provenance;
            // where the picture was written: the list is aligned with the
            // images, so a failed write is a null and not a shift
            if (result.files?.length === job.images.length) job.files = result.files;
          }
        } catch (err) {
          job.state = 'error';
          job.error = (err as Error).message;
        } finally {
          job.finishedAt = new Date().toISOString();
          // the preview of the last step is only shown while the job runs:
          // after that it is memory nobody looks at any more
          job.preview = undefined;
          this.emit({ type: 'job', job: { ...job } });
          this.onFinished?.({ ...job });
          // the job is over: the mark is not needed any more
          this.cancelled.delete(id);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
