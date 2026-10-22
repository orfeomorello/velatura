<script lang="ts">
  import { onMount } from 'svelte';
  import { api, formatEngineStage, sessionToken, type Job } from '../lib/api';
  import {
    applyQuickActionPrompt,
    isCustomPrompt,
    mergePresetPrompt,
    type QuickAction,
  } from '../lib/chips';
  import CommandMenu from '../lib/CommandMenu.svelte';
  import Compare from '../lib/Compare.svelte';
  import {
    extensionAction,
    measureImage,
    planExtend,
    renderExtended,
    type ExtendDirection,
    type ExtendSize,
  } from '../lib/canvas-extend';
  import { EDIT_TOOLS } from '../lib/edit-tools';
  import { prepareImage } from '../lib/images';
  import { displayModelName } from '../lib/paths';
  import StageNudge from '../lib/StageNudge.svelte';
  import {
    onStudioReset,
    preserveGenerateDraft,
    takeGenerateDraft,
    takeHandoff,
    type StageSnapshot,
    type UndoSnapshot,
  } from '../lib/studio';

  type StripPlacement = 'right' | 'bottom' | 'hidden';

  interface AspectOption {
    id: string;
    label: string;
    short: string;
    width: number;
    height: number;
    ratio: number;
  }

  const ASPECT_OPTIONS: AspectOption[] = [
    { id: '1024x1024', label: '1:1 Square · 1024 × 1024 (Standard)', short: '1:1 · 1024×1024', width: 1024, height: 1024, ratio: 1 },
    { id: '1280x720', label: '16:9 Landscape · 1280 × 720 (Widescreen)', short: '16:9 · 1280×720', width: 1280, height: 720, ratio: 16 / 9 },
    { id: '720x1280', label: '9:16 Portrait · 720 × 1280 (Vertical)', short: '9:16 · 720×1280', width: 720, height: 1280, ratio: 9 / 16 },
    { id: '1152x864', label: '4:3 Classic Landscape · 1152 × 864', short: '4:3 · 1152×864', width: 1152, height: 864, ratio: 4 / 3 },
    { id: '864x1152', label: '3:4 Classic Portrait · 864 × 1152', short: '3:4 · 864×1152', width: 864, height: 1152, ratio: 3 / 4 },
    { id: '1216x832', label: '3:2 Photo Landscape · 1216 × 832', short: '3:2 · 1216×832', width: 1216, height: 832, ratio: 3 / 2 },
    { id: '832x1216', label: '2:3 Photo Portrait · 832 × 1216', short: '2:3 · 832×1216', width: 832, height: 1216, ratio: 2 / 3 },
    { id: '768x768', label: '1:1 Medium · 768 × 768', short: '1:1 · 768×768', width: 768, height: 768, ratio: 1 },
    { id: '512x512', label: '1:1 Fast · 512 × 512', short: '1:1 · 512×512', width: 512, height: 512, ratio: 1 },
    { id: '1280x1280', label: '1:1 Large · 1280 × 1280', short: '1:1 · 1280×1280', width: 1280, height: 1280, ratio: 1 },
  ];

  /** Screen magnification steps: the view, never the file. */
  const ZOOM_STEPS = [1, 1.5, 2, 3, 4];

  let prompt = $state('');
  let negative = $state('');
  let steps = $state(8);
  let aspectPreset = $state('1024x1024');
  let seed = $state(-1);
  let cfgScale = $state(1);
  let hires = $state(false);
  let detailer = $state(false);
  let denoising = $state(0.75);
  let showOptions = $state(false);
  let images = $state<string[]>([]);
  let hover = $state(false);
  let preparing = $state(false);
  let note = $state('');
  let submitting = $state(false);
  let errorMessage = $state('');
  let enhancing = $state(false);
  let promptEnhanceModel = $state('Qwen/Qwen3-0.6B');
  /**
   * The Magic Prompt pass is hidden: it is slow and its rewriting drifts from
   * what the user asked. The implementation stays here untouched, so turning
   * this flag back to true brings the button, the shortcut, the model picker
   * and its progress panel back with it.
   */
  const PROMPT_ENHANCE_ENABLED = false;

  interface EnhancerModelOption {
    name: string;
    label: string;
    vision: boolean;
  }

  let enhancerModels = $state<EnhancerModelOption[]>([
    { name: 'Qwen/Qwen3-0.6B', label: 'Qwen3 0.6B · Fast & Lightweight (~1.2 GB)', vision: false },
    { name: 'Qwen/Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B · Ultra-Light (~990 MB)', vision: false },
    { name: 'HuggingFaceTB/SmolLM2-360M-Instruct', label: 'SmolLM2 360M · Tiny Laptop LLM (~720 MB)', vision: false },
    { name: 'Qwen/Qwen3.5-0.8B', label: 'Qwen3.5 0.8B · Rich Creative Detail (~1.6 GB)', vision: false },
    { name: 'Qwen/Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B · High Quality (~3.0 GB)', vision: false },
    { name: 'Qwen/Qwen3-VL-2B-Instruct', label: 'Qwen3-VL 2B · Vision + Text (~4.2 GB)', vision: true },
  ]);

  let jobs = $state<Job[]>([]);
  let selectedJobId = $state<string | undefined>(undefined);
  let selectedImageIndex = $state(0);
  let compareMode = $state(false);
  let stripPlacement = $state<StripPlacement>('right');

  /** The one command menu, opened from the composer or from the picture. */
  let commandMenuOpen = $state(false);
  /** The command family the menu shows: an Edit tool id, or 'style'. */
  let openCommandGroup = $state(EDIT_TOOLS[0]?.id ?? 'style');
  /** The preset waiting for the user to confirm the replacement of a custom prompt. */
  let pendingPreset = $state<QuickAction | null>(null);
  /**
   * A preset was chosen while a finished result was on the stage: when the
   * instruction is confirmed, that result rides along as the reference. A
   * cancel drops the wish, no attachment without a confirmed instruction.
   */
  let stageRefPending = $state(false);
  /** The composer dock, used to close the menu on an outside click. */
  let dockEl = $state<HTMLDivElement | undefined>(undefined);
  /** Prompt, parameters and picture as they were before the last command. */
  let undoSnapshot = $state<UndoSnapshot | undefined>(undefined);
  /** The real pixel size of the picture on the stage: the arrows and their caption need it. */
  let stageSize = $state<ExtendSize | undefined>(undefined);
  /** The canvas of an extension is being prepared, before the job exists. */
  let extending = $state(false);
  /** Screen magnification of the picture, and the pan that goes with it. */
  let zoomStep = $state(0);
  let zoom = $derived(ZOOM_STEPS[zoomStep]!);
  let panX = $state(0);
  let panY = $state(0);
  let panning = $state<
    { x: number; y: number; fromX: number; fromY: number } | undefined
  >(undefined);
  /** The user pressed Reset: the stage shows the empty state again. */
  let stageCleared = $state(false);
  /**
   * A photo was attached to work on: it takes the stage, big, with the arrows
   * on it, until a job replaces it. This is not a reference for a job that is
   * already on the stage: it is the picture the next edit starts from.
   */
  let attachedOnStage = $state(false);
  /** Which of the attached photos took the stage: the last one you added. */
  let attachedIndex = $state(0);
  /** The last job whose result was attached automatically, so it is attached once. */
  let adoptedJobId: string | undefined = undefined;

  let currentAspect = $derived(
    ASPECT_OPTIONS.find((a) => a.id === aspectPreset) ?? ASPECT_OPTIONS[0]!,
  );
  let width = $derived(currentAspect.width);
  let height = $derived(currentAspect.height);
  let size = $derived(Math.max(width, height));

  interface ProfileInfo {
    id: string;
    label: string;
    steps: number;
    resolution: number;
    sampling?: { samplerName: string; cfgScale: number };
    post?: { hires?: { enabled: boolean }; detailer?: { enabled: boolean } };
    engine?: { checkpoint?: string; pipeline?: string };
  }
  let profile = $state<ProfileInfo | undefined>(undefined);

  // Active job on the central stage: either the user-selected job or the newest job,
  // unless Reset cleared the stage
  let activeJob = $derived(
    stageCleared ? undefined : (jobs.find((j) => j.id === selectedJobId) ?? jobs[0]),
  );

  /** Something to throw away: a reference, a prompt or a result on the stage. */
  let hasDraftState = $derived(
    images.length > 0 || prompt.trim().length > 0 || negative.trim().length > 0 || activeJob !== undefined,
  );

  // Flatten all completed or running jobs for the session filmstrip
  let sessionItems = $derived(
    jobs.filter((j) => j.state === 'running' || j.state === 'queued' || (j.images && j.images.length > 0)),
  );

  /** The finished result on the stage, as a data URL: the picture commands work on. */
  let stageResult = $derived(
    activeJob?.state === 'done' && activeJob.images?.length
      ? asDataUrl(activeJob.images[selectedImageIndex] ?? activeJob.images[0]!)
      : undefined,
  );
  /** The attached photo, shown big until a job takes the stage. */
  let attachedPreview = $derived(
    attachedOnStage && images.length > 0
      ? images[Math.min(attachedIndex, images.length - 1)]
      : undefined,
  );
  /** What is on the stage: the attached photo, or the finished result. */
  let stageImage = $derived(attachedPreview ?? stageResult);
  /** The before/after view is the picture on the stage: it is not a drag surface. */
  let compareVisible = $derived(
    compareMode && activeJob?.state === 'done' && Boolean(activeJob?.request.images?.length),
  );
  /** What the composer says when no menu is open. */
  let composerHint = $derived(
    commandMenuOpen
      ? 'Esc to close'
      : stageResult
        ? 'Pick a command, or describe the change'
        : images.length > 1
          ? `${images.length} refs — describe the edit; point at them as <image1>, <image2>`
          : images.length === 1
            ? '1 ref — pick a command or describe the change'
            : 'Attach an image to edit or restyle it',
  );

  function saveSessionState() {
    preserveGenerateDraft({
      profileId: profile?.id ?? '',
      prompt,
      negative,
      steps,
      size,
      aspectPreset,
      width,
      height,
      seed,
      cfgScale,
      hires,
      detailer,
      denoising,
      images,
      selectedJobId,
      selectedImageIndex,
      compareMode,
      cachedJobs: jobs,
      promptEnhanceModel,
      stageCleared,
      undo: undoSnapshot,
      attachedOnStage,
    });
  }

  function matchClosestAspect(w: number, h: number): string {
    if (!w || !h) return '1024x1024';
    const targetRatio = w / h;
    // Prefer standard ~1MP presets (first 7 entries) when matching reference image aspect ratio
    const candidates = ASPECT_OPTIONS.slice(0, 7);
    let best = candidates[0]!;
    let minDiff = Math.abs(best.ratio - targetRatio);
    for (const candidate of candidates) {
      const diff = Math.abs(candidate.ratio - targetRatio);
      if (diff < minDiff) {
        minDiff = diff;
        best = candidate;
      }
    }
    return best.id;
  }

  async function detectDataUrlAspect(dataUrl: string) {
    return new Promise<{ width: number; height: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = dataUrl;
    });
  }

  async function loadProfile(keepDraftForProfile?: string) {
    try {
      const list = await api.get<ProfileInfo[]>('/api/v1/profiles');
      const config = await api.get<{ profileId: string }>('/api/v1/config');
      profile = list.find((p) => p.id === config.profileId) ?? list[0];
      if (profile && profile.id !== keepDraftForProfile) {
        steps = profile.steps;
        const res = profile.resolution;
        const matchingSquare = ASPECT_OPTIONS.find((a) => a.width === res && a.height === res);
        if (matchingSquare) aspectPreset = matchingSquare.id;
        cfgScale = profile.sampling?.cfgScale ?? 1;
        hires = profile.post?.hires?.enabled ?? false;
        detailer = profile.post?.detailer?.enabled ?? false;
      }
    } catch {
      /* server not reachable yet */
    }
  }

  async function loadJobs() {
    try {
      const data = await api.get<{ jobs: Job[] }>('/api/v1/queue');
      const sorted = [...data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      jobs = sorted;
      if (sorted.length > 0 && (!selectedJobId || !sorted.some((j) => j.id === selectedJobId))) {
        selectedJobId = sorted[0]!.id;
      }
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    try {
      const savedStrip = localStorage.getItem('velatura.strip') as StripPlacement | null;
      if (savedStrip === 'right' || savedStrip === 'bottom' || savedStrip === 'hidden') {
        stripPlacement = savedStrip;
      }
    } catch {
      /* ignore */
    }

    const draft = takeGenerateDraft();
    if (draft) {
      prompt = draft.prompt;
      negative = draft.negative;
      steps = draft.steps;
      if (draft.aspectPreset && ASPECT_OPTIONS.some((a) => a.id === draft.aspectPreset)) {
        aspectPreset = draft.aspectPreset;
      }
      seed = draft.seed;
      cfgScale = draft.cfgScale;
      hires = draft.hires;
      detailer = draft.detailer;
      denoising = draft.denoising;
      if (draft.images) images = [...draft.images];
      if (draft.selectedJobId) selectedJobId = draft.selectedJobId;
      if (draft.selectedImageIndex !== undefined) selectedImageIndex = draft.selectedImageIndex;
      if (draft.compareMode !== undefined) compareMode = draft.compareMode;
      if (draft.cachedJobs?.length) jobs = [...draft.cachedJobs];
      if (draft.promptEnhanceModel) promptEnhanceModel = draft.promptEnhanceModel;
      if (draft.stageCleared) stageCleared = true;
      if (draft.attachedOnStage) attachedOnStage = true;
      if (draft.undo) undoSnapshot = { ...draft.undo };
    }

    const handoff = takeHandoff();
    if (handoff) {
      images = handoff.images;
      attachedOnStage = handoff.images.length > 0;
      attachedIndex = 0;
      compareMode = false;
      if (handoff.prompt !== undefined) prompt = handoff.prompt;
      if (handoff.images[0]) {
        void detectDataUrlAspect(handoff.images[0]).then((dim) => {
          if (dim.width && dim.height) {
            aspectPreset = matchClosestAspect(dim.width, dim.height);
          }
        });
      }
    }

    void loadProfile(draft?.profileId);
    void loadJobs();

    const onProfile = () => void loadProfile();
    window.addEventListener('velatura:profile', onProfile);

    const unsubscribeReset = onStudioReset(() => {
      jobs = [];
      selectedJobId = undefined;
      selectedImageIndex = 0;
      compareMode = false;
      images = [];
      prompt = '';
      undoSnapshot = undefined;
      attachedOnStage = false;
      attachedIndex = 0;
      pendingPreset = null;
      commandMenuOpen = false;
      stageCleared = true;
      errorMessage = '';
      note = '';
    });

    // La rotella zooma la vista. Il listener nasce passive false (solo una
    // attach via addEventListener lo permette), con un accumulo che regge sia
    // una rotella a scatti sia un trackpad che manda decine di eventi sottili.
    const onWheel = (event: WheelEvent) => {
      if (!stageImage || compareVisible) return;
      event.preventDefault();
      const dir = event.deltaY < 0 ? 1 : -1;
      if (dir !== wheelDir) {
        wheelDir = dir;
        wheelAccum = 0;
      }
      wheelAccum += Math.abs(event.deltaY);
      if (wheelAccum >= 80) {
        zoomBy(dir > 0 ? 'in' : 'out');
        wheelAccum = 0;
      }
    };
    let wheelTarget: HTMLElement | undefined = undefined;
    let wheelAccum = 0;
    let wheelDir = 0;
    $effect(() => {
      if (!stageImage || compareVisible) {
        wheelTarget?.removeEventListener('wheel', onWheel);
        wheelTarget = undefined;
        return;
      }
      const viewport = document.querySelector<HTMLElement>('.stage-viewport');
      if (viewport === wheelTarget) return;
      wheelTarget?.removeEventListener('wheel', onWheel);
      wheelTarget = viewport ?? undefined;
      wheelTarget?.addEventListener('wheel', onWheel, { passive: false });
    });
    $effect(() => {
      window.addEventListener('keydown', handleGlobalKeys);
      return () => {
        window.removeEventListener('keydown', handleGlobalKeys);
      };
    });

    const closePanels = () => {
      commandMenuOpen = false;
      showOptions = false;
      pendingPreset = null;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!dockEl?.contains(event.target as Node)) closePanels();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pendingPreset) {
        pendingPreset = null;
        return;
      }
      if (commandMenuOpen || showOptions) closePanels();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onEscape);

    const events = new EventSource(`/api/v1/queue/events?token=${encodeURIComponent(sessionToken())}`);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type: string; job?: Job };
        if (event.type === 'job' && event.job) {
          const incoming = event.job;
          const index = jobs.findIndex((j) => j.id === incoming.id);
          if (index >= 0) {
            jobs[index] = incoming;
            jobs = [...jobs];
          } else {
            jobs = [incoming, ...jobs];
            selectedJobId = incoming.id;
            selectedImageIndex = 0;
            compareMode = false;
          }
          adoptResultForEditing(incoming);
        }
      } catch {
        /* ignore */
      }
    };
    events.onerror = () => events.close();
    const timer = setInterval(loadJobs, 6000);

    return () => {
      saveSessionState();
      window.removeEventListener('velatura:profile', onProfile);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
      unsubscribeReset();
      events.close();
      clearInterval(timer);
    };
  });

  // Continuously keep session draft synced whenever key state changes
  $effect(() => {
    void [prompt, negative, steps, aspectPreset, seed, cfgScale, hires, detailer, denoising, images, selectedJobId, selectedImageIndex, compareMode, jobs, promptEnhanceModel, stageCleared, attachedOnStage, undoSnapshot];
    saveSessionState();
  });

  function setStrip(pos: StripPlacement) {
    stripPlacement = pos;
    try {
      localStorage.setItem('velatura.strip', pos);
    } catch {
      /* ignore */
    }
  }

  function selectJob(job: Job, imgIdx = 0) {
    selectedJobId = job.id;
    selectedImageIndex = imgIdx;
    compareMode = false;
    stageCleared = false;
    attachedOnStage = false;
  }

  let canUndo = $derived(
    undoSnapshot !== undefined &&
      (prompt !== undoSnapshot.prompt ||
        negative !== undoSnapshot.negative ||
        denoising !== undoSnapshot.denoising ||
        (undoSnapshot.stage !== undefined && undoSnapshot.stage.jobId !== activeJob?.id)),
  );
  let promptPreview = $derived(
    prompt.trim().length > 90 ? `${prompt.trim().slice(0, 90)}…` : prompt.trim(),
  );

  function focusPromptEnd() {
    const el = document.getElementById('prompt') as HTMLTextAreaElement | null;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }

  function toggleCommandMenu() {
    commandMenuOpen = !commandMenuOpen;
    if (commandMenuOpen) {
      showOptions = false;
      pendingPreset = null;
    }
  }

  function toggleOptions() {
    showOptions = !showOptions;
    if (showOptions) {
      commandMenuOpen = false;
      pendingPreset = null;
    }
  }

  /**    * A command never runs a job by itself: it writes the instruction and the
   * parameters and waits for *Apply edit*. On a result on the stage it adds
   * one thing, but only when the user confirms the instruction: that picture
   * becomes the reference of the job.
   */
  function handlePresetChoice(preset: QuickAction) {
    stageRefPending =
      stageResult !== undefined && !attachedPreview && !stageCleared && images.length === 0;
    applyPreset(preset);
  }

  /** The picture on the stage, so an undo can put the previous one back. */
  function stageSnapshot(): StageSnapshot {
    return { jobId: activeJob?.id, imageIndex: selectedImageIndex, cleared: stageCleared };
  }

  /**
   * One click, one edit: `reference` becomes the input of the job. The default
   * is the result on the stage; an extension passes the padded canvas and the
   * size the job has to be generated at.
   */
  async function applyEditNow(
    preset: QuickAction,
    reference = stageImage,
    jobSize?: ExtendSize,
  ): Promise<Job | undefined> {
    if (submitting || !reference) return undefined;
    undoSnapshot = {
      prompt,
      negative,
      denoising,
      stage: stageSnapshot(),
      images: [...images],
      attached: attachedOnStage,
    };
    attachedOnStage = false;
    images = [reference];
    prompt = preset.prompt;
    if (preset.params.denoising !== undefined) denoising = preset.params.denoising;
    if (preset.params.negativePrompt !== undefined) negative = preset.params.negativePrompt;
    if (preset.params.detailer !== undefined) detailer = preset.params.detailer;
    if (preset.params.hires !== undefined) hires = preset.params.hires;
    commandMenuOpen = false;
    pendingPreset = null;
    showOptions = false;
    compareMode = false;
    stageCleared = false;
    return generate(jobSize);
  }

  /** How far the picture may be dragged at the current zoom, per side. */
  function panLimit(viewport: HTMLElement, axis: 'x' | 'y') {
    // the rect already includes the zoom: with it we know how much of the
    // picture is actually off screen, instead of assuming it fills the viewport
    const img = viewport.querySelector<HTMLInputElement>('.stage-main-image');
    const full = img ? (axis === 'x' ? img.getBoundingClientRect().width : img.getBoundingClientRect().height) : 0;
    const box = axis === 'x' ? viewport.clientWidth : viewport.clientHeight;
    if (!full) return (box * (zoom - 1)) / 2;
    return Math.max(0, (full - box) / 2);
  }

  function clampPan(viewport?: HTMLElement) {
    if (!viewport) return;
    const x = panLimit(viewport, 'x');
    const y = panLimit(viewport, 'y');
    panX = Math.min(x, Math.max(-x, panX));
    panY = Math.min(y, Math.max(-y, panY));
  }

  /** Zoom the view. The picture on disk is not touched: it is a magnifier. */
  function zoomBy(direction: 'in' | 'out') {
    compareMode = false;
    const next = direction === 'in' ? zoomStep + 1 : zoomStep - 1;
    zoomStep = Math.max(0, Math.min(ZOOM_STEPS.length - 1, next));
    const viewport = document.querySelector<HTMLElement>('.stage-viewport');
    if (zoomStep === 0) {
      panX = 0;
      panY = 0;
    } else {
      // panning to a corner and then zooming out must not lose the picture
      clampPan(viewport);
    }
  }

  function startPan(event: PointerEvent) {
    if (zoom <= 1 || compareVisible) return;
    // the dock sits on the picture: its buttons are not a drag surface
    if ((event.target as HTMLElement | null)?.closest('.stage-nudge')) return;
    panning = { x: event.clientX, y: event.clientY, fromX: panX, fromY: panY };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    if (!panning) return;
    const el = event.currentTarget as HTMLElement;
    panX = panning.fromX + (event.clientX - panning.x);
    panY = panning.fromY + (event.clientY - panning.y);
    // keep the picture on screen, and only where there is something to move:
    // a letterboxed side has no hidden part, so it does not drift
    const maxX = panLimit(el, 'x');
    const maxY = panLimit(el, 'y');
    panX = Math.min(maxX, Math.max(-maxX, panX));
    panY = Math.min(maxY, Math.max(-maxY, panY));
  }

  function endPan(event: PointerEvent) {
    if (!panning) return;
    panning = undefined;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  // Pan with the keyboard: one short step per press, like the drag but without
  // holding a mouse button.
  function panByStep(dx: number, dy: number) {
    const viewport = document.querySelector<HTMLElement>('.stage-viewport');
    if (viewport) clampPanPoint(viewport, panX + dx, panY + dy);
  }

  /** Clamp an arbitrary pan position to the part of the picture that is off screen. */
  function clampPanPoint(viewport: HTMLElement, x: number, y: number) {
    const maxX = panLimit(viewport, 'x');
    const maxY = panLimit(viewport, 'y');
    panX = Math.min(maxX, Math.max(-maxX, x));
    panY = Math.min(maxY, Math.max(-maxY, y));
  }

  // Shortcuts, only when the user is not typing:
  // + / − zoom, arrows pan, Ctrl+Z / Ctrl+Shift+Z the last command.
  function handleGlobalKeys(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.ctrlKey || event.metaKey) {
      if (!event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        undoApply();
      }
      return;
    }
    if (event.key === '+' || event.key === '=') {
      if (stageImage) zoomBy('in');
      return;
    }
    if (event.key === '-' || event.key === '_') {
      if (stageImage) zoomBy('out');
      return;
    }
    if (zoom > 1 && stageImage) {
      const steps = { ArrowLeft: [-72, 0], ArrowRight: [72, 0], ArrowUp: [0, -72], ArrowDown: [0, 72] } as Record<string, [number, number]>;
      const move = steps[event.key];
      if (move) {
        event.preventDefault();
        panByStep(move[0]!, move[1]!);
      }
    }
  }

  /**
   * An arrow of the cross: the picture stays where it is and the model
   * continues the scene on that side.
   *
   * The canvas is prepared here, in the browser, and the job runs at the new
   * size. The aspect preset in the composer is not touched: this changes one
   * picture, it is not a new generation setting.
   */
  async function extendStage(direction: ExtendDirection) {
    if (submitting || extending || !stageImage) return;
    const source = stageImage;
    extending = true;
    try {
      const size = await measureImage(source);
      if (!size) {
        errorMessage = 'This result cannot be read as an image.';
        return;
      }
      const plan = planExtend(size.width, size.height, direction);
      if (!plan) return;
      const padded = await renderExtended(source, plan);
      if (!padded) {
        errorMessage = 'The extended canvas could not be prepared.';
        return;
      }
      await applyEditNow(extensionAction(direction), padded, {
        width: plan.width,
        height: plan.height,
      });
    } finally {
      extending = false;
    }
  }

  /**
   * An edit that just finished becomes the reference of the next one: the
   * result is already selected, so continuing costs no re-upload. Guarded so
   * that a from-scratch generation, a queued job or an explicit Reset never
   * attaches something the user did not ask for.
   */
  function adoptResultForEditing(job: Job) {
    if (job.state !== 'done') return;
    if (!job.images?.length) return;
    if (!job.request.images?.length) return;
    if (adoptedJobId === job.id) return;
    if (images.length > 0) return;
    if (stageCleared) return;
    if (jobs.some((other) => other.state === 'running' || other.state === 'queued')) return;
    adoptedJobId = job.id;
    images = [asDataUrl(job.images[0]!)];
  }

  /** Back to an empty Studio: no reference, no prompt, no result on the stage. */
  function resetStudio() {
    images = [];
    prompt = '';
    negative = '';
    undoSnapshot = undefined;
    attachedOnStage = false;
    attachedIndex = 0;
    pendingPreset = null;
    commandMenuOpen = false;
    showOptions = false;
    compareMode = false;
    selectedImageIndex = 0;
    selectedJobId = undefined;
    stageCleared = true;
    adoptedJobId = undefined;
    note = '';
    errorMessage = '';
  }

  function applyPreset(action: QuickAction) {
    // a preset rewrites the prompt: the user's own words are never dropped without asking
    if (isCustomPrompt(prompt)) {
      pendingPreset = action;
      return;
    }
    commitPreset(action, 'replace');
  }

  function commitPreset(action: QuickAction, how: 'replace' | 'merge') {
    undoSnapshot = { prompt, negative, denoising };
    prompt = how === 'merge' ? mergePresetPrompt(prompt, action) : applyQuickActionPrompt(prompt, action);
    if (action.params.denoising !== undefined) {
      denoising = action.params.denoising;
    }
    if (action.params.negativePrompt !== undefined) {
      negative = action.params.negativePrompt;
    }
    if (action.params.detailer !== undefined) {
      detailer = action.params.detailer;
    }
    if (action.params.hires !== undefined) {
      hires = action.params.hires;
    }
    // the confirmed instruction gets its base picture now, not at the click
    if (stageRefPending && stageImage) {
      images = [stageImage];
    }
    stageRefPending = false;
    pendingPreset = null;
    commandMenuOpen = false;
    showOptions = false;
    focusPromptEnd();
  }

  // A preset that is never confirmed must not leave a reference behind: any
  // path that closes the dialog without one also drops the wish.
  $effect(() => {
    if (!pendingPreset) {
      stageRefPending = false;
    }
  });

  function confirmPendingPreset(how: 'replace' | 'merge') {
    if (!pendingPreset) return;
    commitPreset(pendingPreset, how);
  }

  function undoApply() {
    if (!undoSnapshot) return;
    prompt = undoSnapshot.prompt;
    negative = undoSnapshot.negative;
    denoising = undoSnapshot.denoising;
    if (undoSnapshot.images) images = [...undoSnapshot.images];
    if (undoSnapshot.attached !== undefined) attachedOnStage = undoSnapshot.attached;
    // the picture goes back too: a command that ran on the previous result is
    // not undone if the new result stays on the stage
    if (undoSnapshot.stage) {
      selectedJobId = undoSnapshot.stage.jobId;
      selectedImageIndex = undoSnapshot.stage.imageIndex;
      stageCleared = undoSnapshot.stage.cleared || !undoSnapshot.stage.jobId;
    }
    undoSnapshot = undefined;
    focusPromptEnd();
  }

  let enhanceElapsed = $state(0);
  let enhanceRun = 0;

  function cancelMagicPromptEnhance() {
    enhanceRun += 1;
    enhancing = false;
    note = '';
  }

  async function runMagicPromptEnhance() {
    if (enhancing || submitting) return;
    const originalPrompt = prompt;
    // nothing to enhance: the button does nothing on an empty prompt
    if (!originalPrompt.trim()) return;
    const run = ++enhanceRun;
    enhancing = true;
    enhanceElapsed = 0;
    errorMessage = '';
    note = '';
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      enhanceElapsed = Math.floor((Date.now() - startedAt) / 1000);
    }, 500);
    try {
      const selectedModelInfo = enhancerModels.find((m) => m.name === promptEnhanceModel);
      const res = await api.post<{ prompt?: string; seed?: number; error?: string }>('/api/v1/prompt-enhance', {
        prompt: originalPrompt,
        model: promptEnhanceModel,
        image: selectedModelInfo?.vision && images[0] ? images[0] : undefined,
        useVision: Boolean(selectedModelInfo?.vision && images[0]),
      });
      if (run !== enhanceRun) return; // cancelled by the user
      if (res.error) {
        errorMessage = res.error;
        return;
      }
      if (res.prompt && res.prompt.trim()) {
        undoSnapshot = { prompt: originalPrompt, negative, denoising };
        prompt = res.prompt.trim();
        focusPromptEnd();
      }
    } catch (err) {
      if (run === enhanceRun) errorMessage = (err as Error).message;
    } finally {
      clearInterval(ticker);
      if (run === enhanceRun) enhancing = false;
    }
  }

  function enhanceStageLabel(sec: number): string {
    const model = promptEnhanceModel.split('/').pop();
    if (sec < 4) return `Sending your idea to ${model}…`;
    if (sec < 15) return `Loading ${model} into memory…`;
    return `First use: downloading & caching ${model} (one time only, may take a few minutes)…`;
  }

  async function readFiles(files: FileList | null) {
    if (!files) return;
    preparing = true;
    note = '';
    try {
      for (const file of Array.from(files).slice(0, 4 - images.length)) {
        try {
          const prepared = await prepareImage(file);
          if (images.length === 0 && prepared.width && prepared.height) {
            aspectPreset = matchClosestAspect(prepared.width, prepared.height);
          }
          images = [...images, prepared.dataUrl];
        } catch (err) {
          note = `${file.name}: ${(err as Error).message}`;
        }
      }
      if (images.length > 0) {
        attachedOnStage = true;
        attachedIndex = images.length - 1;
        // the stage now shows the photo, not the result the slider was comparing
        compareMode = false;
      }
    } finally {
      preparing = false;
    }
  }

  async function generate(jobSize?: ExtendSize): Promise<Job | undefined> {
    if (!prompt.trim() || submitting) return undefined;
    submitting = true;
    errorMessage = '';
    compareMode = false;
    try {
      const submittedPrompt = prompt;
      const submittedImages = [...images];
      const jobWidth = jobSize?.width ?? width;
      const jobHeight = jobSize?.height ?? height;
      const job = await api.post<Job>('/api/v1/queue', {
        prompt: submittedPrompt,
        negativePrompt: negative,
        images: submittedImages,
        steps,
        size: jobSize ? Math.max(jobWidth, jobHeight) : size,
        width: jobWidth,
        height: jobHeight,
        seed,
        cfgScale,
        hires,
        detailer,
        denoising,
        mode: submittedImages.length > 0 ? 'img2img' : 'txt2img',
      });
      let created: Job | undefined;
      if (job && job.id) {
        const existingIdx = jobs.findIndex((j) => j.id === job.id);
        if (existingIdx >= 0) jobs[existingIdx] = job;
        else jobs = [job, ...jobs];
        selectedJobId = job.id;
        selectedImageIndex = 0;
        stageCleared = false;
        created = job;
      }
      // Clear attached reference images after submitting so next prompt starts clean
      images = [];
      attachedOnStage = false;
      showOptions = false;
      commandMenuOpen = false;
      pendingPreset = null;
      saveSessionState();
      return created;
    } catch (err) {
      errorMessage = (err as Error).message;
    } finally {
      submitting = false;
    }
  }

  async function cancelJob(id: string) {
    await api.post(`/api/v1/queue/${id}/cancel`, {});
    await loadJobs();
  }

  function asDataUrl(image: string): string {
    if (image.startsWith('http') || image.startsWith('data:')) return image;
    return `data:image/png;base64,${image}`;
  }

  function useAsReference(job: Job, image: string) {
    const dataUrl = asDataUrl(image);
    images = [dataUrl];
    // the prompt is kept: iterating on the same instruction is the point of the handoff
    void detectDataUrlAspect(dataUrl).then((dim) => {
      if (dim.width && dim.height) {
        aspectPreset = matchClosestAspect(dim.width, dim.height);
      }
    });
    focusPromptEnd();
  }

  function reusePrompt(job: Job) {
    prompt = job.request.prompt;
    const el = document.getElementById('prompt') as HTMLTextAreaElement | null;
    el?.focus();
  }

  /**
   * The same question, one seed over: the request of the finished job is sent
   * again with the neighbouring seed, so the next picture is a sibling of this
   * one instead of a new throw of the dice. One click is one job.
   */
  async function runVariation(job: Job) {
    if (submitting || extending) return;
    const sourceSeed = job.provenance?.seed ?? job.request.seed;
    if (sourceSeed === undefined || !Number.isFinite(Number(sourceSeed))) {
      note = 'This picture has no seed to build on: generate it again and try once it is done.';
      return;
    }
    submitting = true;
    errorMessage = '';
    compareMode = false;
    try {
      const request = job.request;
      const submitted = await api.post<Job>('/api/v1/queue', {
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        images: request.images,
        steps: request.steps,
        size: request.size,
        width: request.width,
        height: request.height,
        seed: Number(sourceSeed) + 1,
        cfgScale: request.cfgScale,
        samplerName: request.samplerName,
        hires: request.hires,
        detailer: request.detailer,
        denoising: request.denoising,
        mode: (request.images?.length ?? 0) > 0 ? 'img2img' : 'txt2img',
      });
      if (submitted && submitted.id) {
        const existingIdx = jobs.findIndex((j) => j.id === submitted.id);
        if (existingIdx >= 0) jobs[existingIdx] = submitted;
        else jobs = [submitted, ...jobs];
        selectedJobId = submitted.id;
        selectedImageIndex = 0;
        stageCleared = false;
      }
      // the job now owns the stage: the attachment it came from is spent
      images = [];
      attachedOnStage = false;
      saveSessionState();
    } catch (err) {
      errorMessage = (err as Error).message;
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (PROMPT_ENHANCE_ENABLED && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void runMagicPromptEnhance();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void generate();
    }
  }

  // A new picture on the stage starts unzoomed.
  $effect(() => {
    void stageImage;
    zoomStep = 0;
    panX = 0;
    panY = 0;
  });

  // The arrows and their caption work on the real pixel size of the picture.
  $effect(() => {
    const source = stageImage;
    if (!source) {
      stageSize = undefined;
      return;
    }
    let current = true;
    void measureImage(source).then((measured) => {
      if (current) stageSize = measured;
    });
    return () => {
      current = false;
    };
  });

  let elapsedSeconds = $state(0);

  $effect(() => {
    const running = activeJob && (activeJob.state === 'running' || activeJob.state === 'queued');
    if (!running) {
      elapsedSeconds = 0;
      return;
    }
    const startMs = activeJob.startedAt
      ? new Date(activeJob.startedAt).getTime()
      : new Date(activeJob.createdAt).getTime();
    const tick = () => {
      elapsedSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  });

  function formatDuration(sec: number): string {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }

  function eta(job: Job): string {
    if (!job.etaSeconds || job.etaSeconds <= 0) return '';
    if (job.etaSeconds < 60) return `~${Math.round(job.etaSeconds)}s remaining`;
    return `~${Math.round(job.etaSeconds / 60)}m ${Math.round(job.etaSeconds % 60)}s remaining`;
  }

  function statusLabel(job: Job): string {
    if (job.state === 'queued') return 'Waiting in queue…';
    if (job.state === 'running') {
      if (job.stage) {
        const label = formatEngineStage(job.stage);
        return typeof job.progress === 'number' && job.progress > 0
          ? `${label} · ${Math.round(job.progress * 100)}%`
          : `${label}…`;
      }
      return job.progress === undefined
        ? 'Starting engine & loading model…'
        : `Generating · ${Math.round(job.progress * 100)}%`;
    }
    if (job.state === 'done') return 'Completed';
    if (job.state === 'error') return 'Failed';
    return 'Cancelled';
  }
</script>

<div
  class="studio-shell"
  class:drag-hover={hover}
  role="region"
  aria-label="Studio workspace"
  ondragover={(e) => {
    e.preventDefault();
    hover = true;
  }}
  ondragleave={() => (hover = false)}
  ondrop={(e) => {
    e.preventDefault();
    hover = false;
    readFiles(e.dataTransfer?.files ?? null);
  }}
>
  <!-- Upper Workspace: Central Stage + Dockable Filmstrip -->
  <div class="studio-workspace layout-{stripPlacement}">
    <!-- Central Active Stage -->
    <div class="studio-stage">
      {#if attachedPreview && activeJob?.state !== 'running' && activeJob?.state !== 'queued'}
        <!-- The photo you attached, at its own size, before any job exists -->
        <div class="stage-card">
          <div class="stage-header">
            <div class="stage-prompt">Attached photo</div>
            <div class="stage-header-right">
              <span class="muted small">Arrows extend it · or describe the edit below</span>
            </div>
          </div>          <div
            class="stage-viewport"
            class:zoomed={zoom > 1}
            onpointerdown={startPan}
            onpointermove={movePan}
            onpointerup={endPan}
            onpointercancel={endPan}
          >
            <img
              src={attachedPreview}
              alt="Attached photo"
              class="stage-main-image"
              draggable="false"
              style="transform: translate({panX}px, {panY}px) scale({zoom});"
            />
            <StageNudge
              busy={submitting || extending}
              size={stageSize}
              zoom={zoom}
              canZoomIn={zoomStep < ZOOM_STEPS.length - 1}
              canZoomOut={zoomStep > 0}
              onextend={extendStage}
              onzoom={zoomBy}
            />
          </div>
          </div>
      {:else if !activeJob}
        <div class="gpt-empty">
          <h2>What would you like to create?</h2>
          <p class="muted">
            Write a prompt below or attach an image with <strong>+</strong> to edit it.
          </p>
          <div class="gpt-suggestions">
            <button
              type="button"
              class="chip"
              onclick={() => (prompt = 'a cinematic photo of a medieval tower at sunset, warm golden light, 35mm')}
            >
              Medieval tower at sunset
            </button>
            <button
              type="button"
              class="chip"
              onclick={() => (prompt = 'a cozy minimalist studio apartment with plants and soft morning sunlight, architectural photography')}
            >
              Minimalist studio in morning light
            </button>
            <button
              type="button"
              class="chip"
              onclick={() => (prompt = 'portrait of an astronaut in a vintage brass helmet, oil painting texture, dramatic chiaroscuro')}
            >
              Vintage astronaut portrait
            </button>
          </div>
          {#if jobs.length > 0}
            <div class="flex" style="justify-content:center;margin-top:18px">
              <button
                type="button"
                class="ghost small"
                onclick={() => (stageCleared = false)}
              >
                Show the last result
              </button>
            </div>
          {/if}
        </div>
      {:else}
        {@const activeImage = activeJob.images?.[selectedImageIndex] ?? activeJob.images?.[0]}
        {@const activeFile = activeJob.files?.[selectedImageIndex] ?? activeJob.files?.[0]}
        {@const hasReference = Boolean(activeJob.request.images?.length)}

        <div class="stage-card">
          <!-- Stage Header: Prompt + Status + Strip Position Switcher -->
          <div class="stage-header">
            <div class="stage-prompt" title={activeJob.request.prompt}>
              {activeJob.request.prompt}
            </div>
            <div class="stage-header-right">
              {#if sessionItems.length > 1}
                <div class="strip-QuickSwitch" title="History strip position">
                  <button
                    type="button"
                    class:active={stripPlacement === 'right'}
                    onclick={() => setStrip('right')}
                    title="Dock history strip on the right"
                  >
                    Right
                  </button>
                  <button
                    type="button"
                    class:active={stripPlacement === 'bottom'}
                    onclick={() => setStrip('bottom')}
                    title="Dock history strip at the bottom"
                  >
                    Bottom
                  </button>
                  <button
                    type="button"
                    class:active={stripPlacement === 'hidden'}
                    onclick={() => setStrip('hidden')}
                    title="Hide history strip"
                  >
                    Hide
                  </button>
                </div>
              {/if}
            </div>
          </div>

          <!-- Stage Viewport (Single Image or Running Progress) -->
          <div
            class="stage-viewport"
            class:zoomed={zoom > 1 && !compareVisible}
            onpointerdown={startPan}
            onpointermove={movePan}
            onpointerup={endPan}
            onpointercancel={endPan}
          >
            {#if activeJob.state === 'running' || activeJob.state === 'queued'}
              <div class="stage-running">
                {#if activeJob.preview}
                  <img src={asDataUrl(activeJob.preview)} alt="Live preview" class="stage-main-image preview-blur" />
                {:else if activeJob.request.images?.[0]}
                  <img src={activeJob.request.images[0]} alt="Input reference" class="stage-main-image preview-dim" />
                {/if}
                <div class="stage-progress-overlay">
                  <div class="engine-spinner" style="width:34px;height:34px;margin-bottom:10px"></div>
                  <div class="stage-status-text">{statusLabel(activeJob)}</div>
                  <div class="muted small" style="margin-top:4px">
                    Elapsed: <strong>{formatDuration(elapsedSeconds)}</strong>
                    {#if activeJob.etaSeconds}
                      <span> · {eta(activeJob)}</span>
                    {/if}
                  </div>
                  <div
                    class="bar"
                    class:indeterminate={typeof activeJob.progress !== 'number' || activeJob.progress <= 0}
                    style="width:240px;margin:12px auto"
                  >
                    <div style="width:{activeJob.progress === undefined ? 35 : Math.round(activeJob.progress * 100)}%"></div>
                  </div>
                  <button class="ghost small" onclick={() => cancelJob(activeJob.id)}>
                    Cancel generation
                  </button>
                </div>
              </div>
            {:else if activeJob.error}
              <div class="notice err" style="max-width:480px;margin:24px auto">
                <strong>Generation failed</strong>
                <div class="small" style="margin-top:6px">{activeJob.error}</div>
              </div>
            {:else if activeImage}
              {#if compareMode && hasReference}
                <div class="stage-compare-box">
                  <Compare before={activeJob.request.images![0]!} after={asDataUrl(activeImage)} alt={activeJob.request.prompt} />
                </div>
              {:else}
                <img
                  src={asDataUrl(activeImage)}
                  alt={activeJob.request.prompt}
                  class="stage-main-image"
                  draggable="false"
                  style="transform: translate({panX}px, {panY}px) scale({zoom});"
                />
              {/if}
            {/if}

            <!-- The controls that live on the picture, not in the composer -->
            {#if activeImage && activeJob.state === 'done'}
              <StageNudge
                busy={submitting || extending}
                size={stageSize}
                zoom={zoom}
                canZoomIn={zoomStep < ZOOM_STEPS.length - 1}
                canZoomOut={zoomStep > 0}
                onextend={extendStage}
                onzoom={zoomBy}
              />
            {/if}
          </div>

          <!-- Stage Action Toolbar (Always visible when image is ready!) -->
          {#if activeImage && activeJob.state === 'done'}
            <div class="stage-toolbar">
              <div class="stage-actions-primary">
                <a
                  class="primary stage-btn"
                  download={`velatura-${activeJob.id.slice(0, 8)}.png`}
                  href={asDataUrl(activeImage)}
                >
                  <span aria-hidden="true">↓</span>
                  Save PNG
                </a>
                <button
                  type="button"
                  class="ghost stage-btn"
                  onclick={() => useAsReference(activeJob, activeImage)}
                >
                  Continue in Studio
                </button>
                <button
                  type="button"
                  class="ghost stage-btn"
                  onclick={() => reusePrompt(activeJob)}
                >
                  Reuse prompt
                </button>
                <button
                  type="button"
                  class="ghost stage-btn"
                  onclick={() => void runVariation(activeJob)}
                  title="Same request, one seed over: the next picture is a sibling of this one"
                >
                  Variations
                </button>
                {#if hasReference}
                  <button
                    type="button"
                    class="ghost stage-btn {compareMode ? 'active-toggle' : ''}"
                    onclick={() => (compareMode = !compareMode)}
                  >
                    {compareMode ? 'Show final image' : 'Compare Before / After'}
                  </button>
                {/if}
              </div>

              <div class="stage-meta muted small">
                {#if activeJob.provenance?.durationSeconds}
                  <span>{activeJob.provenance.durationSeconds}s</span>
                {/if}
                {#if activeJob.provenance?.width && activeJob.provenance?.height}
                  <span>· {activeJob.provenance.width}×{activeJob.provenance.height}</span>
                {:else if activeJob.provenance?.size}
                  <span>· {activeJob.provenance.size}×{activeJob.provenance.size}</span>
                {/if}
                {#if activeJob.provenance?.steps}
                  <span>· {activeJob.provenance.steps} steps</span>
                {/if}
                {#if activeJob.provenance?.seed !== undefined}
                  <span>· seed {activeJob.provenance.seed}</span>
                {/if}
                {#if activeFile}
                  <span class="mono" title={activeFile}>· {displayModelName(activeFile)}</span>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Session Filmstrip (Mini-History of thumbnails) -->
    {#if sessionItems.length > 1 && stripPlacement !== 'hidden'}
      <aside class="studio-filmstrip" aria-label="Session generations">
        <div class="filmstrip-header">
          <span class="small muted">Session ({sessionItems.length})</span>
        </div>
        <div class="filmstrip-list">
          {#each sessionItems as item (item.id)}
            {@const thumb = item.images?.[0] ?? item.preview ?? item.request.images?.[0]}
            <button
              type="button"
              class="filmstrip-thumb"
              class:selected={activeJob?.id === item.id}
              onclick={() => selectJob(item, 0)}
              title={item.request.prompt}
            >
              {#if thumb}
                <img src={asDataUrl(thumb)} alt={item.request.prompt} />
              {:else}
                <div class="filmstrip-placeholder">…</div>
              {/if}
              {#if item.state === 'running' || item.state === 'queued'}
                <span class="filmstrip-badge running">
                  {typeof item.progress === 'number' && item.progress > 0
                    ? `${Math.round(item.progress * 100)}%`
                    : '…'}
                </span>
              {:else if item.request.images?.length}
                <span class="filmstrip-badge edit" title="Edited from reference">edit</span>
              {/if}
            </button>
          {/each}
        </div>
      </aside>
    {/if}
  </div>

  <!-- Bottom GPT-style Composer Dock -->
  <div class="gpt-composer-dock" bind:this={dockEl}>
    {#if errorMessage}
      <div class="notice err small" style="margin-bottom:10px">{errorMessage}</div>
    {/if}
    {#if note}
      <div class="muted small" style="margin-bottom:6px">{note}</div>
    {/if}
    {#if PROMPT_ENHANCE_ENABLED && enhancing}
      <div class="enhance-progress panel">
        <div class="enhance-progress-row">
          <span class="magic-spin">✨</span>
          <span class="small">{enhanceStageLabel(enhanceElapsed)}</span>
          <span class="muted small" style="margin-left:auto">{formatDuration(enhanceElapsed)}</span>
          <button type="button" class="ghost small" onclick={cancelMagicPromptEnhance}>Cancel</button>
        </div>
        <div class="bar indeterminate" style="margin:8px 0 0"><div style="width:35%"></div></div>
      </div>
    {/if}

    {#if showOptions}
      <div
        class="gpt-options-popover panel"
        role="dialog"
        aria-label="Generation settings"
      >
        <div class="row">
          <div style="flex:2 1 220px">
            <label for="aspect">Format & Resolution</label>
            <select id="aspect" bind:value={aspectPreset}>
              {#each ASPECT_OPTIONS as opt (opt.id)}
                <option value={opt.id}>{opt.label}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for="steps">Steps</label>
            <input id="steps" type="number" min="1" max="50" step="1" bind:value={steps} />
          </div>
          <div>
            <label for="seed">Seed (-1 = random)</label>
            <input id="seed" type="number" bind:value={seed} />
          </div>
          {#if images.length > 0}
            <div>
              <label for="denoising">Edit strength (0.1–1.0)</label>
              <input id="denoising" type="number" min="0.1" max="1" step="0.05" bind:value={denoising} />
            </div>
          {/if}
        </div>
        <div class="row" style="margin-top:10px;align-items:center">
          <div style="flex:2 1 220px">
            <label for="negative">Negative prompt (optional)</label>
            <input id="negative" type="text" bind:value={negative} placeholder="blurry, watermark, low quality" />
          </div>
          {#if PROMPT_ENHANCE_ENABLED}
            <div style="flex:2 1 220px">
              <label for="enhancer-model">✨ Magic Prompt LLM</label>
              <select id="enhancer-model" bind:value={promptEnhanceModel}>
                {#each enhancerModels as em (em.name)}
                  <option value={em.name}>{em.label}</option>
                {/each}
              </select>
            </div>
          {/if}
          <div style="flex:1 1 160px;display:flex;gap:14px;padding-top:16px">
            <label class="small" style="display:flex;gap:6px;align-items:center;margin:0;cursor:pointer">
              <input type="checkbox" bind:checked={hires} />
              <span>Hi-res pass</span>
            </label>
            <label class="small" style="display:flex;gap:6px;align-items:center;margin:0;cursor:pointer">
              <input type="checkbox" bind:checked={detailer} />
              <span>Detailer</span>
            </label>
          </div>
        </div>
      </div>
    {/if}

    <div class="gpt-composer">
      {#if images.length > 0 || preparing}
        <div class="gpt-attachments">
          <div class="gpt-attachments-header">
            <span class="small muted">
              {images.length === 1
                ? '1 reference attached — pick a command in Edits, or describe the change'
                : `${images.length} references attached — describe the edit; point at them as <image1>, <image2>`}
            </span>
          </div>

          <div class="gpt-attachments-thumbs">
            {#each images as image, index (image)}
              <div class="thumb">
                <img src={image} alt="Image {index + 1}" />
                <span class="thumb-role-badge">Image {index + 1}</span>
                <button
                  type="button"
                  aria-label="Remove image"
                  onclick={() => {
                    images = images.filter((_, i) => i !== index);
                    if (attachedIndex >= images.length) {
                      attachedIndex = Math.max(0, images.length - 1);
                    }
                    pendingPreset = null;
                  }}
                >
                  ×
                </button>
              </div>
            {/each}
            {#if preparing}
              <span class="muted small">Preparing image…</span>
            {/if}
          </div>

        </div>
      {/if}

      <!-- One entry point for every command: Style is a family, not a mode -->
      <div class="gpt-mode-row">
        <div class="gpt-modes" role="group" aria-label="Commands">
          <button
            type="button"
            class="gpt-mode-btn"
            class:active={commandMenuOpen}
            aria-expanded={commandMenuOpen}
            title="Rotate, change the pose, remove or add something, write text, extend the canvas, restyle"
            onclick={toggleCommandMenu}
          >
            <span aria-hidden="true">✏</span> Edits
            <span class="gpt-edit-caret" aria-hidden="true">{commandMenuOpen ? '▴' : '▾'}</span>
          </button>
        </div>
        <div class="gpt-mode-side">
          <span class="muted small">{composerHint}</span>
          <button
            type="button"
            class="gpt-reset-btn"
            disabled={!hasDraftState}
            title="Clear the reference, the prompt and the result and start over"
            onclick={resetStudio}
          >
            Reset
          </button>
        </div>
      </div>

      {#if commandMenuOpen}
        <CommandMenu
          openGroup={openCommandGroup}
          pending={pendingPreset ? { label: pendingPreset.label, preview: promptPreview } : null}
          ongroup={(id) => (openCommandGroup = id)}
          onselect={handlePresetChoice}
          onconfirm={confirmPendingPreset}
          oncancel={() => (pendingPreset = null)}
        />
      {/if}

      <div class="gpt-composer-row">
        <!-- Attach Image Button -->
        <button
          type="button"
          class="gpt-icon-btn"
          title="Attach reference images (up to 4)"
          disabled={images.length >= 4 || preparing}
          onclick={() => document.getElementById('file-upload')?.click()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <input
          id="file-upload"
          type="file"
          accept="image/*"
          multiple
          hidden
          onchange={(e) => readFiles(e.currentTarget.files)}
        />

        <!-- Main Prompt Textarea -->
        <textarea
          id="prompt"
          class="gpt-textarea"
          rows="2"
          bind:value={prompt}
          onkeydown={handleKeydown}
          placeholder={images.length >= 2
            ? 'Describe your edit, pointing at each reference as <image1>, <image2>…'
            : images.length === 1
              ? 'Pick a command in Edits ▾, use the arrows on the picture, or describe the change…'
              : 'Describe the image you want to create… (Press Enter to generate)'}
        ></textarea>

        <!-- Prompt Helpers / Settings Toggles -->
        <div class="gpt-composer-actions">
          {#if canUndo}
            <button
              type="button"
              class="gpt-pill-btn"
              title="Restore the prompt, the parameters and the picture from before the last command"
              onclick={undoApply}
            >
              ↩ Undo
            </button>
          {/if}
          {#if PROMPT_ENHANCE_ENABLED}
            <button
              type="button"
              class="gpt-magic-btn {enhancing ? 'busy' : ''}"
              disabled={enhancing || submitting || !prompt.trim()}
              title={prompt.trim()
                ? `Expand & enrich your prompt with ${promptEnhanceModel.split('/').pop()}`
                : 'Write a short idea first, then click Enhance'}
              onclick={runMagicPromptEnhance}
            >
              {#if enhancing}
                <span class="magic-spin">✨</span>
                <span>Enhancing…</span>
              {:else}
                <span>✨</span>
                <span>Enhance</span>
              {/if}
            </button>
          {/if}
          <button
            type="button"
            class="gpt-icon-btn {showOptions ? 'active' : ''}"
            aria-expanded={showOptions}
            title="Generation settings ({steps} steps · {width}×{height})"
            onclick={toggleOptions}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="4" y1="21" x2="4" y2="14"></line>
              <line x1="4" y1="10" x2="4" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12" y2="3"></line>
              <line x1="20" y1="21" x2="20" y2="16"></line>
              <line x1="20" y1="12" x2="20" y2="3"></line>
              <line x1="1" y1="14" x2="7" y2="14"></line>
              <line x1="9" y1="8" x2="15" y2="8"></line>
              <line x1="17" y1="16" x2="23" y2="16"></line>
            </svg>
          </button>

          <!-- Generate / Send Button -->
          <button
            type="button"
            class="gpt-send-btn"
            disabled={submitting || !prompt.trim()}
            onclick={() => void generate()}
            title="Generate (Enter)"
          >
            {#if submitting}
              …
            {:else}
              {images.length > 0 ? 'Apply edit' : 'Generate'}
            {/if}
          </button>
        </div>
      </div>

      <div class="gpt-composer-footer muted small">
        <span>
          {profile?.label ?? 'Turbo'} · {steps} steps · {currentAspect.short}
          {#if PROMPT_ENHANCE_ENABLED}· ✨ {promptEnhanceModel.split('/').pop()}{/if}
        </span>
        {#if images.length > 0}
          <span>· {images.length} ref{images.length > 1 ? 's' : ''}</span>
        {/if}
      </div>
    </div>
  </div>
</div>
