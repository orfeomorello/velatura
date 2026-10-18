<script lang="ts">
  import { onMount } from 'svelte';
  import { api, formatEngineStage, sessionToken, type Job } from '../lib/api';
  import { CHIPS, chipSentence } from '../lib/chips';
  import Compare from '../lib/Compare.svelte';
  import { prepareImage } from '../lib/images';
  import { displayModelName } from '../lib/paths';
  import {
    onStudioReset,
    preserveGenerateDraft,
    takeGenerateDraft,
    takeHandoff,
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
  let showChips = $state(false);
  let images = $state<string[]>([]);
  let hover = $state(false);
  let preparing = $state(false);
  let note = $state('');
  let submitting = $state(false);
  let errorMessage = $state('');

  let jobs = $state<Job[]>([]);
  let selectedJobId = $state<string | undefined>(undefined);
  let selectedImageIndex = $state(0);
  let compareMode = $state(false);
  let stripPlacement = $state<StripPlacement>('right');

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

  // Active job on the central stage: either the user-selected job or the newest job
  let activeJob = $derived(
    jobs.find((j) => j.id === selectedJobId) ?? jobs[0],
  );

  // Flatten all completed or running jobs for the session filmstrip
  let sessionItems = $derived(
    jobs.filter((j) => j.state === 'running' || j.state === 'queued' || (j.images && j.images.length > 0)),
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
    }

    const handoff = takeHandoff();
    if (handoff) {
      images = handoff.images;
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
      errorMessage = '';
      note = '';
    });

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
      unsubscribeReset();
      events.close();
      clearInterval(timer);
    };
  });

  // Continuously keep session draft synced whenever key state changes
  $effect(() => {
    void [prompt, negative, steps, aspectPreset, seed, cfgScale, hires, detailer, denoising, images, selectedJobId, selectedImageIndex, compareMode, jobs];
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
  }

  function applyChip(id: string) {
    const chip = CHIPS.find((c) => c.id === id);
    if (!chip) return;
    const sentence = chipSentence(chip, images.length);
    prompt = prompt.trim() ? `${prompt.trim()}, ${sentence}` : sentence;
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
    } finally {
      preparing = false;
    }
  }

  async function generate() {
    if (!prompt.trim() || submitting) return;
    submitting = true;
    errorMessage = '';
    compareMode = false;
    try {
      const submittedPrompt = prompt;
      const submittedImages = [...images];
      const job = await api.post<Job>('/api/v1/queue', {
        prompt: submittedPrompt,
        negativePrompt: negative,
        images: submittedImages,
        steps,
        size,
        width,
        height,
        seed,
        cfgScale,
        hires,
        detailer,
        denoising,
        mode: submittedImages.length > 0 ? 'img2img' : 'txt2img',
      });
      if (job && job.id) {
        const existingIdx = jobs.findIndex((j) => j.id === job.id);
        if (existingIdx >= 0) jobs[existingIdx] = job;
        else jobs = [job, ...jobs];
        selectedJobId = job.id;
        selectedImageIndex = 0;
      }
      // Clear attached reference images after submitting so next prompt starts clean
      images = [];
      showOptions = false;
      saveSessionState();
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
    prompt = '';
    void detectDataUrlAspect(dataUrl).then((dim) => {
      if (dim.width && dim.height) {
        aspectPreset = matchClosestAspect(dim.width, dim.height);
      }
    });
    const el = document.getElementById('prompt') as HTMLTextAreaElement | null;
    el?.focus();
  }

  function reusePrompt(job: Job) {
    prompt = job.request.prompt;
    const el = document.getElementById('prompt') as HTMLTextAreaElement | null;
    el?.focus();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void generate();
    }
  }

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
      {#if !activeJob}
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
          <div class="stage-viewport">
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
                />
              {/if}
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
                  Save PNG
                </a>
                <button
                  type="button"
                  class="ghost stage-btn"
                  onclick={() => useAsReference(activeJob, activeImage)}
                >
                  Edit / Use as reference
                </button>
                <button
                  type="button"
                  class="ghost stage-btn"
                  onclick={() => reusePrompt(activeJob)}
                >
                  Reuse prompt
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
  <div class="gpt-composer-dock">
    {#if errorMessage}
      <div class="notice err small" style="margin-bottom:10px">{errorMessage}</div>
    {/if}
    {#if note}
      <div class="muted small" style="margin-bottom:6px">{note}</div>
    {/if}

    {#if showChips}
      <div class="chips" style="margin-bottom:8px">
        {#each CHIPS as chip (chip.id)}
          <button
            type="button"
            class="chip"
            disabled={images.length < chip.minImages}
            title={images.length < chip.minImages
              ? `Attach ${chip.minImages} image${chip.minImages > 1 ? 's' : ''} first`
              : chip.writes}
            onclick={() => applyChip(chip.id)}
          >
            {chip.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if showOptions}
      <div class="gpt-options-popover panel">
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
          <div style="flex:2 1 240px">
            <label for="negative">Negative prompt (optional)</label>
            <input id="negative" type="text" bind:value={negative} placeholder="blurry, watermark, low quality" />
          </div>
          <div style="flex:1 1 180px;display:flex;gap:14px;padding-top:16px">
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
          <div class="small muted" style="width:100%;margin-bottom:2px">
            Reference image{images.length > 1 ? 's' : ''} attached for editing:
          </div>
          {#each images as image, index (image)}
            <div class="thumb">
              <img src={image} alt="attachment {index + 1}" />
              <button type="button" aria-label="Remove image" onclick={() => (images = images.filter((_, i) => i !== index))}>×</button>
            </div>
          {/each}
          {#if preparing}
            <span class="muted small">Preparing image…</span>
          {/if}
        </div>
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
          placeholder={images.length > 0
            ? 'Describe what to change in the attached image… (Press Enter to generate)'
            : 'Describe the image you want to create… (Press Enter to generate)'}
        ></textarea>

        <!-- Prompt Helpers / Settings Toggles -->
        <div class="gpt-composer-actions">
          {#if images.length > 0}
            <button
              type="button"
              class="gpt-pill-btn {showChips ? 'active' : ''}"
              title="Quick edit suggestions"
              onclick={() => (showChips = !showChips)}
            >
              Ideas
            </button>
          {/if}
          <button
            type="button"
            class="gpt-icon-btn {showOptions ? 'active' : ''}"
            title="Generation settings ({steps} steps · {width}×{height})"
            onclick={() => (showOptions = !showOptions)}
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
            onclick={generate}
            title="Generate (Enter)"
          >
            {#if submitting}
              …
            {:else}
              {images.length > 0 ? 'Edit Image' : 'Generate'}
            {/if}
          </button>
        </div>
      </div>

      <div class="gpt-composer-footer muted small">
        <span>{profile?.label ?? 'Turbo'} · {steps} steps · {currentAspect.short}</span>
        {#if images.length > 0}
          <span>· Editing mode ({images.length} reference image{images.length > 1 ? 's' : ''})</span>
        {/if}
      </div>
    </div>
  </div>
</div>
