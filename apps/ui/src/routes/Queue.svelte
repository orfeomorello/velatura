<script lang="ts">
  import { onMount } from 'svelte';
  import { api, formatEngineStage, sessionToken, type Job } from '../lib/api';
  import Compare from '../lib/Compare.svelte';
  import { handOff, onStudioReset } from '../lib/studio';
  import { displayModelName, folderOf } from '../lib/paths';

  let jobs = $state<Job[]>([]);
  let history = $state<Job[]>([]);
  let compareOpen = $state<Record<string, boolean>>({});
  let note = $state('');

  // Avoid showing duplicate items in Previous Sessions if they are already in the active Session Queue
  let pastSessions = $derived(
    history.filter((h) => !jobs.some((j) => j.id === h.id)),
  );

  async function load() {
    try {
      const data = await api.get<{ jobs: Job[] }>('/api/v1/queue');
      jobs = [...data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      /* engine not reachable */
    }
  }

  async function loadHistory() {
    try {
      const data = await api.get<{ jobs: Job[] }>('/api/v1/history?limit=50');
      history = data.jobs;
    } catch {
      /* no history yet */
    }
  }

  onMount(() => {
    void load();
    void loadHistory();

    const unsubscribeReset = onStudioReset(() => {
      jobs = [];
      history = [];
      compareOpen = {};
    });

    const events = new EventSource(`/api/v1/queue/events?token=${encodeURIComponent(sessionToken())}`);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type: string; job?: Job };
        if (event.type === 'job' && event.job) {
          const index = jobs.findIndex((j) => j.id === event.job!.id);
          if (index >= 0) jobs[index] = event.job!;
          else jobs = [event.job!, ...jobs];
          jobs = [...jobs];
        }
      } catch {
        /* ignore */
      }
    };
    events.onerror = () => events.close();
    const timer = setInterval(load, 10000);
    return () => {
      unsubscribeReset();
      events.close();
      clearInterval(timer);
    };
  });

  async function cancel(id: string) {
    await api.post(`/api/v1/queue/${id}/cancel`, {});
    await load();
  }

  function asDataUrl(image: string): string {
    if (image.startsWith('http') || image.startsWith('data:')) return image;
    return `data:image/png;base64,${image}`;
  }

  /** Send image as reference to Studio (with empty prompt ready for editing instructions). */
  function useAsReference(image: string) {
    handOff({ images: [asDataUrl(image)], prompt: '' });
  }

  /** Send prompt to Studio composer. */
  function reusePromptInStudio(promptText: string) {
    handOff({ images: [], prompt: promptText });
  }

  function toggleCompare(jobId: string) {
    compareOpen = { ...compareOpen, [jobId]: !compareOpen[jobId] };
  }

  async function openFolder(filePath: string) {
    note = '';
    const folder = folderOf(filePath) || filePath;
    const result = await api.post<{ error?: string }>('/api/v1/open', { path: folder });
    if (result.error) note = result.error;
  }

  function eta(job: Job): string {
    if (!job.etaSeconds || job.etaSeconds <= 0) return '';
    if (job.etaSeconds < 60) return `~${Math.round(job.etaSeconds)}s remaining`;
    return `~${Math.round(job.etaSeconds / 60)}m ${Math.round(job.etaSeconds % 60)}s remaining`;
  }

  function statusLabel(job: Job): string {
    if (job.state === 'queued') return 'Waiting in queue';
    if (job.state === 'running') {
      if (job.stage) {
        const label = formatEngineStage(job.stage);
        return typeof job.progress === 'number' && job.progress > 0
          ? `${label} · ${Math.round(job.progress * 100)}%`
          : `${label}…`;
      }
      return job.progress === undefined
        ? 'Preparing SD.Next…'
        : `Generating · ${Math.round(job.progress * 100)}%`;
    }
    if (job.state === 'done') return 'Completed';
    if (job.state === 'error') return 'Failed';
    return 'Cancelled';
  }
</script>

<h2>History & Queue</h2>
<p class="subtitle">
  Active and completed generations from your current session, plus saved prompt records from previous sessions.
</p>

{#if note}
  <div class="notice err small" style="margin-bottom:14px">{note}</div>
{/if}

<h3 class="panel-title" style="margin:18px 0 10px">Current Session ({jobs.length})</h3>

{#if jobs.length === 0}
  <div class="panel muted">No generations in the current session yet.</div>
{/if}

{#each jobs as job (job.id)}
  {@const hasReference = Boolean(job.request.images?.length)}
  {@const isComparing = Boolean(compareOpen[job.id])}
  <div class="job">
    <div class="flex" style="justify-content:space-between;align-items:flex-start">
      <div style="min-width:0;flex:1">
        <div class="pre-wrap" style="font-weight:500">{job.request.prompt}</div>
        <div class="muted small" style="margin-top:4px">
          {statusLabel(job)}
          {#if job.etaSeconds && job.state === 'running'} · {eta(job)}{/if}
          · {new Date(job.createdAt).toLocaleTimeString()}
        </div>
      </div>
      <div class="flex">
        {#if job.request.prompt}
          <button class="ghost small" onclick={() => reusePromptInStudio(job.request.prompt)}>
            Reuse prompt
          </button>
        {/if}
        {#if job.state === 'queued' || job.state === 'running'}
          <button class="ghost small" onclick={() => cancel(job.id)}>Cancel</button>
        {/if}
        <span
          class="badge {job.state === 'done'
            ? 'ok'
            : job.state === 'error'
              ? 'err'
              : job.state === 'running'
                ? 'warn'
                : ''}"
        >
          {job.state === 'queued'
            ? 'Waiting'
            : job.state === 'running'
              ? 'Working'
              : job.state === 'done'
                ? 'Ready'
                : job.state === 'error'
                  ? 'Failed'
                  : 'Cancelled'}
        </span>
      </div>
    </div>

    {#if job.state === 'running'}
      <div
        class="bar"
        class:indeterminate={typeof job.progress !== 'number' || job.progress <= 0}
        role="progressbar"
        aria-label="Image generation progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round((job.progress ?? 0) * 100)}
      >
        <div style="width:{job.progress === undefined ? 35 : Math.round(job.progress * 100)}%"></div>
      </div>
      {#if job.preview}
        <div class="gallery">
          <img src={`data:image/png;base64,${job.preview}`} alt="preview" />
        </div>
      {/if}
    {/if}

    {#if job.error}<div class="small" style="color:var(--err);margin-top:8px">{job.error}</div>{/if}

    {#if job.state === 'done' && !job.images?.length}
      <div class="muted small" style="margin-top:8px">
        Image deleted from disk and session memory.
      </div>
    {/if}

    {#if job.images?.length}
      {#if isComparing && hasReference}
        <div style="margin-top:12px">
          <div class="muted small" style="margin-bottom:6px">Before & After comparison — drag the slider</div>
          <Compare before={job.request.images![0]!} after={asDataUrl(job.images[0]!)} alt="result" />
        </div>
      {/if}

      <div class="gallery">
        {#each job.images as image, imageIndex}
          {@const file = job.files?.[imageIndex]}
          <figure>
            <img src={asDataUrl(image)} alt={job.request.prompt} />
            <figcaption>
              <div class="flex" style="gap:6px;flex-wrap:wrap">
                <a
                  class="primary small"
                  style="padding:5px 10px;border-radius:var(--radius);text-decoration:none;font-size:12px;font-weight:600"
                  download={`velatura-${job.id.slice(0, 8)}.png`}
                  href={asDataUrl(image)}
                >
                  Save PNG
                </a>
                <button class="ghost small" onclick={() => useAsReference(image)}>
                  Edit / Use as reference
                </button>
                {#if hasReference && imageIndex === 0}
                  <button class="ghost small" onclick={() => toggleCompare(job.id)}>
                    {isComparing ? 'Hide Before / After' : 'Compare Before / After'}
                  </button>
                {/if}
                {#if file}
                  <button class="ghost small" onclick={() => openFolder(file)}>
                    Open folder
                  </button>
                {/if}
              </div>

              {#if file}
                <div class="muted small mono" style="margin-top:8px;word-break:break-all">
                  {file}
                </div>
              {/if}

              {#if job.provenance}
                <div class="muted small" style="margin-top:6px;line-height:1.5">
                  <div>
                    {#if job.provenance.width && job.provenance.height}
                      {job.provenance.width}×{job.provenance.height}px ·
                    {:else if job.provenance.size}
                      {job.provenance.size}×{job.provenance.size}px ·
                    {/if}
                    {job.provenance.steps ?? '?'} steps · seed {job.provenance.seed ?? '?'} · CFG {job.provenance.cfgScale ?? '?'}
                    {#if job.provenance.durationSeconds}· {job.provenance.durationSeconds}s{/if}
                  </div>
                  {#if job.provenance.model}
                    <div class="mono" style="word-break:break-all">
                      {displayModelName(job.provenance.model)}
                      {#if job.provenance.quant}· {job.provenance.quant}{/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </figcaption>
          </figure>
        {/each}
      </div>
    {/if}
  </div>
{/each}

<!-- Previous Sessions History -->
<div style="margin-top:28px">
  <h3 class="panel-title" style="margin-bottom:10px">
    Previous Sessions ({pastSessions.length})
  </h3>
  {#if pastSessions.length === 0}
    <div class="panel muted small">
      No earlier session records found on disk.
    </div>
  {:else}
    <div class="panel" style="padding:8px 16px">
      {#each pastSessions as item (item.id)}
        <div
          class="flex"
          style="justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:10px 0;gap:12px"
        >
          <div style="min-width:0;flex:1">
            <div class="pre-wrap" style="font-weight:500">{item.request?.prompt || '(No prompt)'}</div>
            <div class="muted small" style="margin-top:2px">
              {new Date(item.createdAt).toLocaleString()}
              {#if item.provenance?.width && item.provenance?.height}
                · {item.provenance.width}×{item.provenance.height}
              {:else if item.provenance?.size}
                · {item.provenance.size}×{item.provenance.size}
              {/if}
              {#if item.provenance?.steps}· {item.provenance.steps} steps{/if}
              {#if item.provenance?.durationSeconds}· {item.provenance.durationSeconds}s{/if}
            </div>
            {#if item.files?.length && item.files[0]}
              <div class="muted small mono" style="margin-top:3px;word-break:break-all">
                {item.files[0]}
              </div>
            {/if}
          </div>
          <div class="flex" style="flex-shrink:0">
            {#if item.files?.length && item.files[0]}
              <button class="ghost small" onclick={() => openFolder(item.files![0]!)}>
                Open folder
              </button>
            {/if}
            {#if item.request?.prompt}
              <button class="ghost small" onclick={() => reusePromptInStudio(item.request.prompt)}>
                Reuse prompt
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
