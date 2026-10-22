/**
 * The handoff and persistent session state between screens.
 *
 * The result of a job can become the input of the next one: that loop is
 * the reason an edit model is worth having, so it is a first-class action
 * and not a copy-paste.
 *
 * In addition, the active Studio state (prompt, attached reference images,
 * selected job ID, aspect ratio / dimensions, and parameters) is preserved
 * in memory while navigating across tabs, and cleared whenever a Privacy
 * wipe occurs.
 */
import type { Job } from './api';

export interface Handoff {
  /** the reference images for the next job (data URLs) */
  images: string[];
  /** the prompt to start from */
  prompt?: string;
}

let pending: Handoff | undefined;
const listeners = new Set<(handoff: Handoff) => void>();

/** The picture on the stage, so an undo can put the previous one back. */
export interface StageSnapshot {
  jobId?: string;
  imageIndex: number;
  cleared: boolean;
}

/** Prompt, parameters and picture as they were before the last command. */
export interface UndoSnapshot {
  prompt: string;
  negative: string;
  denoising: number;
  stage?: StageSnapshot;
  /** the attached photos, so undo can put an attached preview back on the stage */
  images?: string[];
  /** whether the attached photo was the picture on the stage */
  attached?: boolean;
}

/** Persistent in-memory state of the Studio across tab navigation. */
export interface GenerateDraft {
  profileId: string;
  prompt: string;
  negative: string;
  steps: number;
  size: number;
  aspectPreset?: string;
  width?: number;
  height?: number;
  seed: number;
  cfgScale: number;
  hires: boolean;
  detailer: boolean;
  denoising: number;
  images?: string[];
  selectedJobId?: string;
  selectedImageIndex?: number;
  compareMode?: boolean;
  cachedJobs?: Job[];
  promptEnhanceModel?: string;
  /** Reset emptied the stage: do not fall back to the newest job on return. */
  stageCleared?: boolean;
  /** The attached photo was the picture on the stage when the user left. */
  attachedOnStage?: boolean;
  /** The prompt, parameters and picture to restore when the user undoes a command. */
  undo?: UndoSnapshot;
}

let savedDraft: GenerateDraft | undefined;
const queueViewEvent = 'velatura:show-queue';
const studioResetEvent = 'velatura:studio-reset';

export function preserveGenerateDraft(draft: GenerateDraft): void {
  savedDraft = {
    ...draft,
    images: draft.images ? [...draft.images] : undefined,
    cachedJobs: draft.cachedJobs ? [...draft.cachedJobs] : undefined,
  };
}

export function peekGenerateDraft(): GenerateDraft | undefined {
  return savedDraft ? { ...savedDraft } : undefined;
}

export function takeGenerateDraft(): GenerateDraft | undefined {
  return savedDraft ? { ...savedDraft } : undefined;
}

export function clearStudioSession(): void {
  savedDraft = undefined;
  pending = undefined;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(studioResetEvent));
  }
}

export function onStudioReset(listener: () => void): () => void {
  window.addEventListener(studioResetEvent, listener);
  return () => window.removeEventListener(studioResetEvent, listener);
}

export function requestQueueView(): void {
  window.dispatchEvent(new CustomEvent(queueViewEvent));
}

export function onQueueView(listener: () => void): () => void {
  window.addEventListener(queueViewEvent, listener);
  return () => window.removeEventListener(queueViewEvent, listener);
}

/** Send a result to the Generate screen. */
export function handOff(handoff: Handoff): void {
  pending = handoff;
  for (const listener of listeners) listener(handoff);
}

/** Take the handoff, once. */
export function takeHandoff(): Handoff | undefined {
  const current = pending;
  pending = undefined;
  return current;
}

/** Be told when a handoff arrives. */
export function onHandoff(listener: (handoff: Handoff) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
