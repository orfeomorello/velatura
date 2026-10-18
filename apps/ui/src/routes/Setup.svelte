<script lang="ts">
  import { onMount } from 'svelte';
  import { api, formatBytes, formatEngineStage, sessionToken, type Job, type ManifestEntry } from '../lib/api';

  interface Validation {
    ok: boolean;
    root: string;
    rootExists: boolean;
    markers: string[];
    modelsDir?: string;
    problems: string[];
    warnings: string[];
  }

  interface Hardware {
    platform: string;
    arch: string;
    cpuModel: string;
    totalMemGb: number;
    hasGpu: boolean;
    vramGb?: number;
    gpus: Array<{ vendor: string; name: string; vramGb?: number; driver?: string }>;
    notes: string[];
  }

  interface Profile {
    id: string;
    label: string;
    description?: string;
    vramGb: number;
    steps: number;
    emphasis: 'speed' | 'quality';
    models: Array<{ role: string; manifestId: string; file?: string }>;
  }

  interface ProfileComponent {
    role: string;
    manifestId: string;
    file?: string;
  }

  interface SelectedModel {
    profileModel: ProfileComponent;
    model: ModelState;
  }

  interface PlacementCheck {
    status?: 'installed' | 'incompatible' | 'missing';
    expectedFile?: string;
    targetPath?: string;
    installedPath?: string;
    scan?: { reasons: string[]; compatible: boolean };
    error?: string;
  }

  interface ModelState {
    entry: ManifestEntry;
    status: 'installed' | 'incompatible' | 'missing';
    installedPath?: string;
    targetPath: string;
    expectedFile: string;
    acceptableFiles: string[];
    sizeBytes?: number;
    scan?: { reasons: string[]; role: string; quant?: string; variant?: string };
    conflicts?: Array<{ path: string; name: string; role: string; variant?: string; reasons: string[] }>;
  }

  interface SetupState {
    config: { sdnextRoot?: string; profileId: string; setupCompleted?: boolean };
    sdnextRoot: string | null;
    defaultSdnextRoot: string;
    validation: Validation | null;
    candidates: Array<{ root: string; looksRight: boolean; validation: Validation }>;
    hardware: Hardware;
    profiles: Profile[];
    baseModel?: {
      name: string;
      engineReady: boolean;
      listed: boolean;
      loaded: boolean;
      loadedClass?: string;
      managedReference?: boolean;
      referencePrepared?: boolean;
    } | null;
    qwenTurboSupport?: {
      ready: boolean;
      status: 'ready' | 'missing' | 'checksum-mismatch';
      id: string;
      label: string;
      repo: string;
      revision: string;
      file: string;
      sizeBytes: number;
      sha256: string;
      license: string;
      licenseUrl: string;
      path?: string;
      source?: string;
      partialBytes?: number;
      actualSha256?: string;
    };
    qwenGgufCompat?: {
      required: boolean;
      installed: boolean;
      active: boolean;
      restartRequired: boolean;
    };
    models: ModelState[];
    derived: {
      id: string;
      steps: number;
      vramGb: number;
      notes: string[];
      dit?: string;
    } | null;
  }

  interface Download {
    id: string;
    manifestId: string;
    label: string;
    bytes: number;
    total?: number;
    state: 'running' | 'done' | 'error';
    error?: string;
  }

  interface BundleState {
    id: string;
    profileId: string;
    label: string;
    state: 'running' | 'done' | 'error';
    current: string;
    done: number;
    total: number;
    error?: string;
  }

  interface EngineInstallTargetOption {
    id: string;
    label: string;
    branch?: string;
    commit?: string;
    referenceDate?: string;
  }

  interface EngineRequirements {
    ok: boolean;
    missing: string[];
    versions: Record<string, string>;
    warnings: string[];
    defaultDir: string;
    installTargets: EngineInstallTargetOption[];
  }

  interface VerifyRow {
    id: string;
    label: string;
    status: string;
    required: boolean;
    path?: string;
    sizeOk?: boolean;
    shaOk?: boolean;
    expectedSha256?: string;
    actualSha256?: string;
    problems: string[];
  }

  let step = $state(1);
  let state = $state<SetupState | undefined>(undefined);
  let downloads = $state<Record<string, Download>>({});
  let sdnextPath = $state('');
  let validation = $state<Validation | undefined>(undefined);
  let saveError = $state('');
  let profileId = $state('lowvram');
  let emphasis = $state<'speed' | 'quality'>('speed');
  let manualPath = $state<Record<string, string>>({});
  let manualOpen = $state<string | undefined>(undefined);
  let placementChecks = $state<Record<string, PlacementCheck>>({});
  let checkingPlacement = $state<string | undefined>(undefined);
  let report = $state<VerifyRow[] | undefined>(undefined);
  let busy = $state(false);
  let finished = $state(false);
  let verifyProgress = $state<{ label: string; bytes: number; total: number } | undefined>(undefined);
  let bundle = $state<
    | {
        id: string;
        profileId: string;
        label: string;
        state: 'running' | 'done' | 'error';
        current: string;
        done: number;
        total: number;
        error?: string;
      }
    | undefined
  >(undefined);
  let bundlePlan = $state<
    | {
        profile: { id: string; label: string; description?: string };
        items: Array<{
          role: string;
          label: string;
          file: string;
          dest: string;
          sizeBytes?: number;
          sha256?: string;
          license: string;
          licenseUrl?: string;
        }>;
        totalBytes: number;
      }
    | undefined
  >(undefined);
  let bundleAccepted = $state(false);
  let exportText = $state('');
  let engineReq = $state<EngineRequirements | undefined>(undefined);
  let engineInstall = $state<
    | {
        running: boolean;
        dir: string;
        phase: string;
        log: string[];
        target?: string;
        commit?: string;
        error?: string;
        missing?: string[];
      }
    | undefined
  >(undefined);
  let engineDir = $state('');
  let engineTargetId = $state('repository-default');
  let selectedEngineTarget = $derived(engineReq?.installTargets.find((target) => target.id === engineTargetId));
  let engineInstallError = $state('');
  let checkingEngine = $state(false);
  let showEngineInstaller = $state(false);
  let engineStatusLoaded = false;
  let testResult = $state<
    | { ok: boolean; seconds?: number; steps?: number; size?: number; image?: string; vramGb?: number; error?: string }
    | undefined
  >(undefined);
  let testing = $state(false);
  let testJobId = $state<string | undefined>(undefined);
  let testProgress = $state<{ stage?: string; progress?: number } | undefined>(undefined);
  let testMeta = $state<{ steps: number; size: number; profile?: string; createdAt?: string } | undefined>(undefined);
  let restartingQwenCompat = $state(false);
  let qwenCompatRestartError = $state('');
  let qwenSupportBusy = $state(false);
  let qwenSupportLicenseAccepted = $state(false);
  let qwenSupportError = $state('');
  let systemPaths = $state<{
    install: {
      app: string;
      config: string;
      history: string;
      images: string;
      logs: string;
      logFile: string;
      sdnext: string | null;
    };
  } | undefined>(undefined);
  let pathNote = $state('');

  async function openSystemFolder(path: string) {
    pathNote = '';
    const result = await api.post<{ error?: string }>('/api/v1/open', { path });
    if (result.error) pathNote = result.error;
  }

  async function load() {
    state = await api.get<SetupState>('/api/v1/setup/state');
    api.get<NonNullable<typeof systemPaths>>('/api/v1/paths').then((p) => (systemPaths = p)).catch(() => {});
    if (!sdnextPath) {
      const found = state.sdnextRoot ?? state.candidates.find((candidate) => candidate.looksRight)?.root ?? '';
      sdnextPath = found;
    }
    validation = state.validation ?? state.candidates.find((candidate) => candidate.root === sdnextPath)?.validation;
    if (!engineDir) engineDir = state.sdnextRoot ?? state.defaultSdnextRoot;
    profileId = state.config.profileId ?? 'lowvram';
    emphasis = state.profiles.find((profile) => profile.id === profileId)?.emphasis ?? 'speed';

    const hasValidInstall = Boolean(state.validation?.ok || state.candidates.some((candidate) => candidate.looksRight));
    if (!hasValidInstall && !state.validation?.ok) {
      showEngineInstaller = true;
      if (!engineReq) void checkEngine();
    }
    if (!engineStatusLoaded) {
      engineStatusLoaded = true;
      try {
        const install = await api.get<NonNullable<typeof engineInstall>>('/api/v1/setup/engine/install');
        if (install.dir) {
          engineInstall = install;
          if (install.running || install.phase === 'ready' || install.phase === 'error') {
            showEngineInstaller = true;
          }
          if (install.running) void pollEngineInstall();
        }
      } catch {
        /* the current install process may not have been started yet */
      }
    }
  }

  onMount(() => {
    load().catch(() => {});
    const refreshProfile = () => load().catch(() => {});
    window.addEventListener('velatura:profile', refreshProfile);
    const events = new EventSource(`/api/v1/queue/events?token=${encodeURIComponent(sessionToken())}`);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as {
          type: string;
          job?: Job;
          download?: Download;
          bundle?: BundleState;
          label?: string;
          bytes?: number;
          total?: number;
        };
        if (event.type === 'job' && event.job) handleTestJob(event.job);
        // the final check reads the files: the wait is not a mystery
        if (event.type === 'verify' && event.label) {
          verifyProgress = { label: event.label, bytes: event.bytes ?? 0, total: event.total ?? 0 };
        }
        if (event.type === 'download' && event.download) {
          downloads = { ...downloads, [event.download.id]: event.download };
          if (event.download.state !== 'running') setTimeout(load, 500);
        }
        if (event.type === 'bundle' && event.bundle) {
          bundle = event.bundle;
          if (event.bundle.state !== 'running') setTimeout(load, 800);
        }
        if (event.type === 'engine-log' && engineInstall) {
          engineInstall = {
            ...engineInstall,
            log: [...engineInstall.log, (event as { line?: string }).line ?? ''].slice(-200),
          };
        }
      } catch {
        /* ignore */
      }
    };
    events.onerror = () => events.close();
    return () => {
      window.removeEventListener('velatura:profile', refreshProfile);
      events.close();
    };
  });

  async function checkEngine() {
    checkingEngine = true;
    try {
      engineReq = await api.get<EngineRequirements>('/api/v1/setup/engine/requirements');
      if (engineReq.installTargets.length > 0 && !engineReq.installTargets.some((target) => target.id === engineTargetId)) {
        engineTargetId = engineReq.installTargets[0]!.id;
      }
      if (!engineDir) engineDir = engineReq.defaultDir;
    } catch {
      engineReq = undefined;
    } finally {
      checkingEngine = false;
    }
  }

  async function pollEngineInstall() {
    while (engineInstall?.running) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        engineInstall = await api.get<NonNullable<typeof engineInstall>>('/api/v1/setup/engine/install');
      } catch {
        break;
      }
    }
  }

  function openEngineInstaller() {
    showEngineInstaller = true;
    if (!engineReq) void checkEngine();
  }

  async function installEngine() {
    engineInstallError = '';
    busy = true;
    try {
      const result = await api.post<{
        state?: NonNullable<typeof engineInstall>;
        error?: string;
        dir?: string;
      }>('/api/v1/setup/engine/install', {
        dir: engineDir || state?.defaultSdnextRoot,
        target: engineTargetId,
      });
      if (result.error) engineInstallError = result.error;
      if (result.state) {
        engineInstall = result.state;
        void pollEngineInstall();
      }
    } catch (err) {
      engineInstallError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function useInstalledEngine() {
    if (!engineInstall?.dir) return;
    sdnextPath = engineInstall.dir;
    showEngineInstaller = false;
    await saveSdnext();
  }

  async function checkFailedEngineFolder() {
    if (!engineInstall?.dir) return;
    sdnextPath = engineInstall.dir;
    validation = undefined;
    showEngineInstaller = false;
    await saveSdnext();
  }

  async function saveSdnext() {
    saveError = '';
    busy = true;
    try {
      const result = await api.post<{ validation: Validation; saved: boolean; error?: string }>(
        '/api/v1/setup/sdnext',
        { root: sdnextPath },
      );
      validation = result.validation;
      if (result.saved) {
        showEngineInstaller = false;
        await load();
        step = 2;
      } else {
        saveError = result.error ?? '';
        showEngineInstaller = true;
        if (!result.validation.rootExists && sdnextPath.trim()) engineDir = sdnextPath;
        if (!engineReq) void checkEngine();
      }
    } finally {
      busy = false;
    }
  }

  async function saveProfile() {
    busy = true;
    try {
      await api.post('/api/v1/setup/profile', { profileId });
      await load();
      step = 3;
    } finally {
      busy = false;
    }
  }

  async function download(entry: ManifestEntry) {
    busy = true;
    try {
      await api.post('/api/v1/models/fetch', { manifestId: entry.id });
    } finally {
      busy = false;
    }
  }

  async function checkPlacement(model: ModelState) {
    checkingPlacement = model.entry.id;
    placementChecks = { ...placementChecks, [model.entry.id]: {} };
    try {
      const result = await api.post<PlacementCheck>('/api/v1/models/check-placement', {
        manifestId: model.entry.id,
        profileId,
      });
      placementChecks = { ...placementChecks, [model.entry.id]: result };
      if (result.status === 'installed') {
        manualOpen = undefined;
        await load();
      } else if (result.status === 'missing' || result.status === 'incompatible') {
        manualOpen = model.entry.id;
      }
    } catch (err) {
      placementChecks = {
        ...placementChecks,
        [model.entry.id]: { error: (err as Error).message },
      };
    } finally {
      checkingPlacement = undefined;
    }
  }

  async function placeManually(model: ModelState) {
    const path = manualPath[model.entry.id];
    if (!path) return;
    busy = true;
    try {
      await api.post('/api/v1/models/import', {
        path,
        slot: model.entry.dest,
        mode: 'hardlink',
        fileName: model.expectedFile,
      });
      manualOpen = undefined;
      manualPath = { ...manualPath, [model.entry.id]: '' };
      await load();
    } finally {
      busy = false;
    }
  }

  async function planBundle() {
    busy = true;
    try {
      bundlePlan = await api.post<NonNullable<typeof bundlePlan>>('/api/v1/models/bundle/plan', {
        profileId,
      });
      bundleAccepted = false;
    } finally {
      busy = false;
    }
  }

  async function installBundle() {
    busy = true;
    try {
      const result = await api.post<{ id: string; error?: string }>('/api/v1/models/bundle', {
        profileId,
      });
      if (result.error) {
        bundle = {
          id: '',
          profileId,
          label: profileId,
          state: 'error',
          current: '',
          done: 0,
          total: 0,
          error: result.error,
        };
      }
    } finally {
      busy = false;
    }
  }

  async function exportInstructions() {
    busy = true;
    try {
      const result = await api.post<{ text: string }>('/api/v1/setup/export', { profileId });
      exportText = result.text;
    } finally {
      busy = false;
    }
  }

  async function verify() {
    busy = true;
    verifyProgress = undefined;
    try {
      const result = await api.post<{ report: VerifyRow[] }>('/api/v1/setup/verify', {});
      report = result.report;
    } finally {
      busy = false;
      verifyProgress = undefined;
    }
  }

  function handleTestJob(job: Job) {
    if (!testJobId || job.id !== testJobId) return;
    testProgress = { stage: job.stage ?? (job.state === 'queued' ? 'queued' : undefined), progress: job.progress };
    if (job.state === 'queued' || job.state === 'running') return;

    const startedAt = Date.parse(job.startedAt ?? job.createdAt);
    const finishedAt = Date.parse(job.finishedAt ?? new Date().toISOString());
    const seconds = Math.max(0, finishedAt - startedAt) / 1000;
    if (job.state === 'done' && job.images?.[0]) {
      testResult = {
        ok: true,
        seconds,
        steps: testMeta?.steps,
        size: testMeta?.size,
        image: job.images[0],
        vramGb: state?.hardware.gpus[0]?.vramGb,
      };
    } else {
      testResult = { ok: false, error: job.error ?? `The test job ${job.state} without returning an image.` };
    }
    testing = false;
    testJobId = undefined;
    testProgress = undefined;
    testMeta = undefined;
  }

  async function pollTestJob(jobId: string) {
    while (testing && testJobId === jobId) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!testing || testJobId !== jobId) return;
      try {
        const result = await api.get<{ jobs: Job[] }>('/api/v1/queue');
        const job = result.jobs.find((item) => item.id === jobId);
        if (job) handleTestJob(job);
      } catch {
        /* the event stream remains the primary progress source */
      }
    }
  }

  async function testRender() {
    testing = true;
    testResult = undefined;
    testProgress = { stage: 'queued' };
    testJobId = undefined;
    testMeta = undefined;
    try {
      const submitted = await api.post<{ jobId: string; createdAt: string; steps: number; size: number; profile?: string }>(
        '/api/v1/setup/test-render',
        {},
      );
      if (!submitted.jobId) throw new Error('Velatura did not return a test job ID.');
      testJobId = submitted.jobId;
      testMeta = {
        steps: submitted.steps,
        size: submitted.size,
        profile: submitted.profile,
        createdAt: submitted.createdAt,
      };
      void pollTestJob(submitted.jobId);
    } catch (err) {
      testResult = { ok: false, error: (err as Error).message };
      testing = false;
      testProgress = undefined;
      testJobId = undefined;
    }
  }

  async function restartQwenCompatEngine() {
    restartingQwenCompat = true;
    qwenCompatRestartError = '';
    try {
      const result = await api.post<{ restarted: boolean; error?: string }>('/api/v1/sdnext/restart', {});
      if (!result.restarted) qwenCompatRestartError = result.error ?? 'SD.Next could not be restarted.';
      await load();
    } catch (err) {
      qwenCompatRestartError = (err as Error).message;
    } finally {
      restartingQwenCompat = false;
    }
  }

  async function downloadQwenTurboSupport() {
    if (!qwenSupportLicenseAccepted) return;
    qwenSupportBusy = true;
    qwenSupportError = '';
    try {
      const result = await api.post<{ ready?: boolean; error?: string }>(
        '/api/v1/qwen/turbo-support/fetch',
        { confirm: true, acceptLicense: true },
      );
      if (result.error) qwenSupportError = result.error;
      await load();
    } catch (err) {
      qwenSupportError = (err as Error).message;
    } finally {
      qwenSupportBusy = false;
    }
  }

  async function finish() {
    busy = true;
    try {
      await api.post('/api/v1/setup/finalize', {});
      finished = true;
      window.dispatchEvent(new CustomEvent('velatura:setup-finished'));
    } finally {
      busy = false;
    }
  }

  function recommendedProfile(): string | undefined {
    return state?.profiles.find((profile) => profile.emphasis === emphasis)?.id;
  }

  function chooseEmphasis(value: 'speed' | 'quality') {
    emphasis = value;
    const matching = state?.profiles.find((profile) => profile.emphasis === value);
    if (matching) profileId = matching.id;
  }

  function selectedProfile(): Profile | undefined {
    return state?.profiles.find((profile) => profile.id === profileId);
  }

  function selectedProfileModels(): SelectedModel[] {
    const profile = selectedProfile();
    if (!profile || !state) return [];
    const selected: SelectedModel[] = [];
    for (const profileModel of profile.models) {
      const model = state.models.find((candidate) => candidate.entry.id === profileModel.manifestId);
      if (model) selected.push({ profileModel, model });
    }
    return selected;
  }

  function requiredReady(): boolean {
    const required = selectedProfileModels().filter((item) => item.model.entry.required !== false);
    return required.length > 0 && required.every((item) => item.model.status === 'installed');
  }
</script>

<h2>Setup</h2>
<p class="subtitle">
  Four short steps: find the engine, pick a profile, get the model files, check everything.
</p>

<div class="steps">
  {#each ['Engine', 'Hardware & profile', 'Models', 'Verify'] as label, index}
    <button
      class="step {step === index + 1 ? 'active' : ''} {step > index + 1 ? 'done' : ''}"
      onclick={() => (step = index + 1)}
    >
      <span class="n">{index + 1}</span>
      {label}
    </button>
  {/each}
</div>

{#if step === 1}
  <div class="panel">
    <h3 class="panel-title">Where is SD.Next?</h3>
    <p class="muted small">
      Velatura is a local interface for SD.Next. It checks the folder you choose before saving it.
    </p>

    {#if state?.candidates?.length}
      <div class="candidates">
        {#each state.candidates as candidate (candidate.root)}
          <label class="candidate">
            <input
              type="radio"
              name="sdnext"
              value={candidate.root}
              checked={sdnextPath === candidate.root}
              onchange={() => {
                sdnextPath = candidate.root;
                validation = candidate.validation;
                saveError = '';
              }}
            />
            <span class="mono">{candidate.root}</span>
            {#if candidate.looksRight}
              <span class="badge ok">startup script found</span>
            {:else}
              <span class="badge warn">not a valid SD.Next folder</span>
            {/if}
          </label>
        {/each}
      </div>
    {/if}

    {#if state && !state.validation?.ok && !state.candidates.some((candidate) => candidate.looksRight)}
      <div class="notice small" style="margin-top:10px">
        <span class="badge warn">not found</span>
        No valid SD.Next folder was found in the usual locations. How would you like to continue?
        Enter the path of an existing folder below, or install a new copy with Velatura. Nothing
        will be downloaded until you confirm.
      </div>
    {/if}

    <label for="path" style="margin-top:14px">Path of the SD.Next folder</label>
    <input
      id="path"
      type="text"
      bind:value={sdnextPath}
      oninput={() => {
        validation = undefined;
        saveError = '';
      }}
      placeholder="C:\sdnext or /home/you/sdnext"
    />

    {#if validation && !validation.ok}
      <div class="notice err" style="margin-top:10px">
        <div class="small">This path is not a usable SD.Next folder:</div>
        <ul class="small">
          {#each validation.problems as problem}<li>{problem}</li>{/each}
        </ul>
      </div>
    {/if}
    {#if validation?.ok}
      <div class="notice ok" style="margin-top:10px">
        <div class="small">SD.Next startup script found: {validation.markers.join(', ')}</div>
        <div class="small mono">{validation.modelsDir}</div>
      </div>
    {/if}
    {#if validation?.warnings.length}
      <div class="notice small" style="margin-top:10px">
        <span class="badge warn">note</span>
        {validation.warnings.join(' ')}
      </div>
    {/if}
    {#if saveError}<div class="notice err small">{saveError}</div>{/if}

    <div class="flex" style="margin-top:14px">
      <button class="primary" disabled={busy || !sdnextPath.trim()} onclick={saveSdnext}>
        Check path and continue
      </button>
      {#if validation?.ok}
        <span class="muted small">The path will be saved only after this check succeeds.</span>
      {/if}
    </div>
  </div>

  {#if showEngineInstaller}
    <div class="panel" style="margin-top:14px">
      <h3 class="panel-title">Install SD.Next</h3>
      <p class="muted small">
        If you do not have a usable installation, Velatura can fetch the selected SD.Next source
        and run its first-start setup. This can take a while and download several GB; model weights
        are a separate step. Velatura will not overwrite a non-empty folder.
      </p>

      {#if !engineReq}
        <div class="notice small" style="margin-top:10px">
          {checkingEngine ? 'Checking for Git and Python…' : 'Check that Git and Python are available before installing SD.Next.'}
        </div>
        <button class="ghost" style="margin-top:10px" disabled={checkingEngine} onclick={checkEngine}>
          {checkingEngine ? 'Checking…' : 'Check prerequisites'}
        </button>
      {:else}
        <div class="notice small" style="margin-top:10px">
          {#if engineReq.ok}
            <span class="badge ok">ready</span>
            {Object.entries(engineReq.versions).map(([key, value]) => `${key}: ${value}`).join(' · ')}
          {:else}
            <span class="badge err">not ready</span>
            Missing: {engineReq.missing.join(', ')}. Install them, then check again.
          {/if}
          {#each engineReq.warnings as warning}
            <div class="muted small" style="margin-top:6px">{warning}</div>
          {/each}
        </div>

        <label for="engine-target" style="margin-top:12px">SD.Next version</label>
        <select id="engine-target" bind:value={engineTargetId} disabled={Boolean(engineInstall?.running)}>
          {#each engineReq.installTargets as target (target.id)}
            <option value={target.id}>{target.label}</option>
          {/each}
        </select>

        <label for="engine-dir" style="margin-top:12px">New installation folder</label>
        <input
          id="engine-dir"
          type="text"
          bind:value={engineDir}
          placeholder={state?.defaultSdnextRoot ?? '~/sdnext'}
        />
        <p class="muted small" style="margin-top:6px">
          Default: <span class="mono">{engineReq.defaultDir}</span> (inside your user folder, no administrator rights).
          Existing files in a non-empty folder are never overwritten.
        </p>
        <p class="muted small">
          To proceed, click <strong>Install SD.Next</strong>. That is the confirmation: only then will Velatura
          fetch this exact source and start SD.Next's dependency setup, which can download several GB. During
          setup, model auto-load and auto-download are disabled; Velatura then restarts SD.Next in an isolated
          offline session. No model weights are part of the engine install.
        </p>
        <div class="flex" style="margin-top:10px">
          <button
            class="primary"
            disabled={!engineReq.ok || !selectedEngineTarget || busy || Boolean(engineInstall?.running)}
            onclick={installEngine}
          >
            {engineInstall?.running ? 'Installing…' : 'Install SD.Next'}
          </button>
          {#if !engineReq.ok}
            <button class="ghost" disabled={checkingEngine} onclick={checkEngine}>Check again</button>
          {/if}
        </div>
      {/if}

      {#if engineInstallError}
        <div class="notice err small" style="margin-top:10px">{engineInstallError}</div>
      {/if}
      {#if engineInstall}
        <div class="notice small" style="margin-top:10px">
          {#if engineInstall.phase === 'checking'}Checking requirements…
          {:else if engineInstall.phase === 'cloning'}Fetching the selected SD.Next source…
          {:else if engineInstall.phase === 'installing'}Building and starting SD.Next. First start can take several minutes…
          {:else if engineInstall.phase === 'ready'}
            <span class="badge ok">ready</span>
            SD.Next is running at <span class="mono">{engineInstall.dir}</span>.
            {#if engineInstall.commit}
              <div class="small" style="margin-top:4px;overflow-wrap:anywhere">Checked-out commit: <span class="mono">{engineInstall.commit}</span></div>
            {/if}
          {:else if engineInstall.phase === 'error'}
            <span style="color:var(--err)">Installation stopped: {engineInstall.error}</span>
            <div>
              <button class="ghost" style="margin-top:8px" disabled={busy} onclick={checkFailedEngineFolder}>
                Check this folder and continue
              </button>
            </div>
          {/if}
          {#if engineInstall.log.length > 0}
            <pre class="small mono log">{engineInstall.log.slice(-12).join('\n')}</pre>
          {/if}
          {#if engineInstall.phase === 'ready'}
            <button class="primary" style="margin-top:10px" onclick={useInstalledEngine}>
              Use this installation
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {:else if state?.validation?.ok || state?.candidates.some((candidate) => candidate.looksRight)}
    <button class="ghost" style="margin-top:12px" onclick={openEngineInstaller}>
      Install a different SD.Next copy
    </button>
  {/if}

{/if}

{#if step === 2 && state}
  <div class="panel">
    <h3 class="panel-title">Your hardware</h3>
    <table>
      <tbody>
        <tr><td>System</td><td>{state.hardware.platform} {state.hardware.arch}</td></tr>
        <tr><td>CPU</td><td>{state.hardware.cpuModel}</td></tr>
        <tr><td>Memory</td><td>{state.hardware.totalMemGb} GB</td></tr>
        {#each state.hardware.gpus as gpu}
          <tr>
            <td>GPU</td>
            <td>
              {gpu.vendor} — {gpu.name}
              {#if gpu.vramGb}<span class="badge">{gpu.vramGb} GB VRAM</span>{:else}<span class="badge warn">VRAM unknown</span>{/if}
            </td>
          </tr>
        {/each}
        {#if !state.hardware.gpus.length}
          <tr><td>GPU</td><td class="muted">not detected</td></tr>
        {/if}
      </tbody>
    </table>
    {#each state.hardware.notes as note}<div class="muted small" style="margin-top:8px">! {note}</div>{/each}
    {#if state.hardware.gpus.some((g) => /intel|arc/i.test(`${g.vendor} ${g.name}`))}
      <div class="notice small" style="margin-top:10px">
        <span class="badge ok">Intel GPU</span>
        The engine will be started with <span class="mono">--use-ipex</span>, the flag SD.Next needs on Intel
        Arc. Make sure the Intel drivers are installed, otherwise it falls back to the CPU.
      </div>
    {/if}
  </div>

  <div class="panel">
    <h3 class="panel-title">Profile</h3>
    <p class="muted small">
      Low is the default and uses the pinned SDNQ UINT4 Turbo profile. Full uses the BF16 Turbo profile.
      The speed/detail toggle only suggests a profile from detected memory; actual VRAM use and image-quality
      differences have not been benchmarked on the target SD.Next build. You can always choose either profile manually.
    </p>

    <div class="toggle">
      <button class:active={emphasis === 'speed'} onclick={() => chooseEmphasis('speed')}>Speed · Low</button>
      <button class:active={emphasis === 'quality'} onclick={() => chooseEmphasis('quality')}>Detail · Full</button>
    </div>

    {#if state.derived}
      <div class="notice small" style="margin:12px 0">
        <span class="badge ok">adapted</span>
        You already own <span class="mono">{state.derived.dit}</span>: the profile has been adapted to
        it ({state.derived.notes.join(', ') || 'no change'}). Velatura will use the file you have, not
        ask you for another download.
      </div>
    {/if}

    <div class="profiles">
      {#each state.profiles as profile (profile.id)}
        <button
          class="profile {profileId === profile.id ? 'selected' : ''}"
          onclick={() => { profileId = profile.id; emphasis = profile.emphasis; }}
        >
          <div class="flex" style="justify-content:space-between">
            <strong>{profile.label}</strong>
            {#if recommendedProfile() === profile.id}<span class="badge ok">suggested by selector</span>{/if}
          </div>
          <div class="muted small">{profile.description}</div>
          <div class="muted small">Memory selector hint: {profile.vramGb} GB (unbenchmarked) · {profile.steps} steps</div>
        </button>
      {/each}
    </div>

    {#if selectedProfile()?.id === 'full'}
      <div class="notice warn small" style="margin-top:12px">
        Full uses about 32.44 GB of weights on disk. Peak VRAM, offload behavior and runtime compatibility have not been benchmarked; the selector hint is not a verified minimum. Choosing Full does not download any files.
      </div>
    {/if}

    <div class="flex" style="margin-top:14px">
      <button class="primary" disabled={busy} onclick={saveProfile}>Continue</button>
      <button class="ghost" onclick={() => (step = 1)}>Back</button>
    </div>
  </div>
{/if}

{#if step === 3 && state}
  <div class="panel">
    <h3 class="panel-title">Files for {selectedProfile()?.label ?? 'the selected profile'}</h3>
    <p class="muted small">
      {selectedProfile()?.description ?? 'These are the model files for the selected profile.'}
      This is the complete list for this profile; the other Turbo variants are not needed. Velatura
      never ships weights. Download these files, or check whether a compatible file is already in the
      expected SD.Next folder.
    </p>

    <div class="panel" style="margin-bottom:14px">
      <h3 class="panel-title">Download this profile</h3>
      <p class="muted small">
        Review the exact files for {selectedProfile()?.label ?? profileId}. Download them individually
        below, or download the selected profile's files together.
      </p>
      <div class="flex">
        <button class="primary" disabled={busy} onclick={planBundle}>
          Review files and licences
        </button>
        <button class="ghost" disabled={busy} onclick={exportInstructions}>
          Write the instructions to a file
        </button>
      </div>

      {#if bundlePlan}
        <div style="margin-top:12px">
          <div class="muted small">
            {bundlePlan.profile.label} · about {formatBytes(bundlePlan.totalBytes)} in total
          </div>
          <table style="margin-top:8px">
            <thead>
              <tr><th>File</th><th>Expected folder</th><th>SHA-256</th><th>Licence</th><th class="right">Size</th></tr>
            </thead>
            <tbody>
              {#each bundlePlan.items as item (item.file)}
                <tr>
                  <td><span class="model-file-line mono" title={item.file}>{item.file}</span></td>
                  <td class="mono">models/{item.dest}/</td>
                  <td><span class="model-hash-line mono" title={item.sha256 ?? 'No checksum listed'}>{item.sha256 ?? 'not listed'}</span></td>
                  <td>
                    {item.license}
                    {#if item.licenseUrl}<div class="small"><a href={item.licenseUrl} target="_blank" rel="noreferrer">read licence</a></div>{/if}
                  </td>
                  <td class="right mono">{formatBytes(item.sizeBytes)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="notice small" style="margin-top:10px">
            These are non-commercial research weights; read the applicable terms before using them.
            {#if bundlePlan.items.some((item) => item.license === 'unknown')}
              <div class="small" style="color:var(--warn);margin-top:6px">
                ⚠ At least one repository does not declare a licence. Review its model card before use.
              </div>
            {/if}
          </div>
          <label class="small" style="display:flex;gap:8px;align-items:flex-start;margin-top:10px">
            <input type="checkbox" bind:checked={bundleAccepted} />
            <span>I have read the licence and I want to download these files.</span>
          </label>
          <div class="flex" style="margin-top:8px">
            <button class="primary" disabled={busy || !bundleAccepted} onclick={installBundle}>
              Download these profile files
            </button>
          </div>
        </div>
      {/if}

      {#if bundle}
        <div class="notice small" style="margin-top:10px">
          {#if bundle.state === 'running'}
            Downloading {bundle.done + 1}/{bundle.total}: {bundle.current}
          {:else if bundle.state === 'done'}
            All the files are in place. Continue to the check.
          {:else}
            <span style="color:var(--err)">! {bundle.error}</span>
          {/if}
        </div>
      {/if}

      {#if exportText}
        <details style="margin-top:10px">
          <summary class="small">The instructions, ready to copy</summary>
          <textarea readonly rows="12" style="width:100%;margin-top:8px" value={exportText}></textarea>
        </details>
      {/if}
    </div>

    <div class="model-table-wrap">
      <table class="model-table">
        <colgroup>
          <col style="width:22%" />
          <col style="width:15%" />
          <col style="width:22%" />
          <col style="width:17%" />
          <col style="width:24%" />
        </colgroup>
        <thead>
          <tr>
            <th>Model</th>
            <th>Status</th>
            <th>File to use</th>
            <th>SD.Next folder</th>
            <th class="right">Choose how to add it</th>
          </tr>
        </thead>
        <tbody>
          {#each selectedProfileModels() as selected (selected.model.entry.id)}
            {@const model = selected.model}
            {@const entry = model.entry}
            {@const dl = Object.values(downloads).find((d) => d.manifestId === entry.id)}
            {@const check = placementChecks[entry.id]}
            <tr>
              <td>
                <div class="model-component-name">{entry.label}</div>
                <div class="model-meta">
                  {#if entry.required === false}<span class="badge">Optional</span>{:else}<span>Required</span>{/if}
                  <span>{formatBytes(entry.sizeBytes)}</span>
                </div>
                <div class="model-meta">
                  <span>Licence: {entry.license}</span>
                  {#if entry.licenseUrl}
                    <a href={entry.licenseUrl} target="_blank" rel="noreferrer">Read terms</a>
                  {/if}
                </div>
                <div class="model-hash-line mono" title={entry.sha256 ?? 'No checksum listed'}>
                  SHA-256: {entry.sha256 ?? 'not listed in the manifest'}
                </div>
                {#if entry.license === 'unknown'}
                  <div class="notice small model-license-warning">
                    ⚠ Licence not declared. Review the model card before use. This file is optional.
                  </div>
                {/if}
                {#if entry.note}
                  <details class="model-details">
                    <summary>About this file</summary>
                    <div style="margin-top:4px">{entry.note}</div>
                  </details>
                {/if}
              </td>
              <td>
                {#if dl && dl.state === 'running'}
                  <span class="badge warn">Downloading {Math.round((dl.bytes / (dl.total || dl.bytes || 1)) * 100)}%</span>
                {:else if model.status === 'installed'}
                  <span class="badge ok">Ready</span>
                  <div class="model-status-note">A compatible file is in place.</div>
                {:else if model.status === 'incompatible'}
                  <span class="badge warn">Needs attention</span>
                  <div class="model-status-note">The file found cannot be used by this profile.</div>
                  {#if model.scan?.reasons.length}
                    <details class="model-details">
                      <summary>Technical details</summary>
                      {#each model.scan.reasons as reason}<div style="margin-top:4px">{reason}</div>{/each}
                    </details>
                  {/if}
                {:else}
                  <span class="badge">Not installed</span>
                  <div class="model-status-note">Download it, or check the SD.Next folder.</div>
                {/if}
                {#if model.status !== 'installed' && model.conflicts?.length}
                  <details class="model-other-files">
                    <summary>Other files found ({model.conflicts.length})</summary>
                    <div>They do not replace the file required by this profile.</div>
                    <ul>
                      {#each model.conflicts as conflict}<li class="mono">{conflict.name}</li>{/each}
                    </ul>
                  </details>
                {/if}
              </td>
              <td>
                <span class="model-file-line mono" title={model.expectedFile}>{model.expectedFile}</span>
              </td>
              <td>
                <div class="model-destination">SD.Next · models/{entry.dest}/</div>
                <details class="model-details">
                  <summary>Show full path</summary>
                  <code class="model-full-path">{model.targetPath || 'SD.Next folder not configured'}</code>
                </details>
              </td>
              <td>
                <div class="model-actions">
                  <button class="primary model-action" disabled={busy} onclick={() => download(entry)}>
                    {dl && dl.state === 'running' ? 'Downloading…' : 'Download'}
                  </button>
                  <button
                    class="primary model-action"
                    disabled={busy || checkingPlacement === entry.id}
                    onclick={() => checkPlacement(model)}
                  >
                    {checkingPlacement === entry.id ? 'Checking…' : 'Check folder'}
                  </button>
                </div>
                {#if check?.error}
                  <div class="notice err small model-check-result">{check.error}</div>
                {:else if check?.status === 'installed'}
                  <div class="notice ok small model-check-result">
                    Found and compatible in this folder.
                    <code class="model-full-path">{check.installedPath ?? check.targetPath ?? model.targetPath}</code>
                  </div>
                {:else if check?.status === 'incompatible'}
                  <div class="notice err small model-check-result">
                    A file is present, but it cannot be used for this profile.
                    {#if check.scan?.reasons.length}
                      <details class="model-details">
                        <summary>Technical details</summary>
                        {#each check.scan.reasons as reason}<div style="margin-top:4px">{reason}</div>{/each}
                      </details>
                    {/if}
                  </div>
                {:else if check?.status === 'missing'}
                  <div class="notice small model-check-result">
                    Nothing compatible was found in the expected folder. If your copy is elsewhere,
                    choose its location below.
                    <details class="model-details">
                      <summary>Expected full path</summary>
                      <code class="model-full-path">{check.targetPath ?? model.targetPath}</code>
                    </details>
                  </div>
                {/if}
                {#if manualOpen === entry.id}
                  <div style="margin-top:10px;text-align:left">
                    <label class="small" for="manual-{entry.id}">Where is your existing file?</label>
                    <input
                      id="manual-{entry.id}"
                      type="text"
                      placeholder="Paste the file path from your computer"
                      bind:value={manualPath[entry.id]}
                    />
                    <div class="model-actions" style="justify-content:flex-start;margin-top:7px">
                      <button class="primary model-action" disabled={busy} onclick={() => placeManually(model)}>Use this file</button>
                      <span class="muted small">Velatura checks it and places it in the SD.Next folder.</span>
                    </div>
                  </div>
                {/if}
              </td>
            </tr>
          {/each}
          {#if selectedProfileModels().length === 0}
            <tr><td colspan="5" class="model-empty">No model files are configured for this profile.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>



    <div class="flex" style="margin-top:14px">
      <button class="primary" disabled={!requiredReady()} onclick={() => (step = 4)}>Continue</button>
      <button class="ghost" onclick={() => (step = 2)}>Back</button>
      {#if !requiredReady()}<span class="muted small">The required files are still missing.</span>{/if}
    </div>
  </div>
{/if}

{#if step === 4 && state}
  <div class="panel">
    <h3 class="panel-title">The test drive</h3>
    <p class="muted small">
      One real image, with the active profile. It starts the engine if it is not running, and it
      tells you how long it took — the first honest measurement of this machine.
    </p>
    {#if state.baseModel}
      <div class="notice" style="margin:10px 0">
        <strong>{state.baseModel.managedReference ? `Velatura-managed ${state.baseModel.name} reference` : `Required SD.Next base: ${state.baseModel.name}`}</strong>
        {#if state.baseModel.managedReference}
          {#if !state.qwenTurboSupport?.ready}
            <div class="small" style="margin-top:4px">
              The test needs one small processor tokenizer file ({formatBytes(state.qwenTurboSupport?.sizeBytes ?? 11_422_650)}). It is not a model-weight file; Velatura assembles the selected profile's Diffusers reference from the installed DiT, text encoder and VAE. It will not download a separate full base checkpoint.
            </div>
            {#if state.qwenTurboSupport}
              <div class="model-meta" style="margin-top:6px">
                <span>Licence: {state.qwenTurboSupport.license}</span>
                <a href={state.qwenTurboSupport.licenseUrl} target="_blank" rel="noreferrer">Read terms</a>
                <span>{state.qwenTurboSupport.repo} · {state.qwenTurboSupport.file}</span>
              </div>
              <div class="model-hash-line mono" style="margin-top:4px;overflow-wrap:anywhere">SHA-256: {state.qwenTurboSupport.sha256}</div>
              {#if state.qwenTurboSupport.status === 'checksum-mismatch'}
                <div class="small" style="margin-top:4px">A local copy did not match the pinned checksum. Downloading will replace it only after the new file passes verification.</div>
              {/if}
              {#if state.qwenTurboSupport.partialBytes}
                <div class="small" style="margin-top:4px">A partial download is available ({formatBytes(state.qwenTurboSupport.partialBytes)}); Velatura can resume it.</div>
              {/if}
              <label class="small" style="display:flex;gap:8px;align-items:flex-start;margin-top:8px">
                <input type="checkbox" bind:checked={qwenSupportLicenseAccepted} />
                <span>I have reviewed the Qwen Research License and accept its non-commercial terms for downloading this support file.</span>
              </label>
              <button class="primary" style="margin-top:8px" disabled={!qwenSupportLicenseAccepted || qwenSupportBusy} onclick={downloadQwenTurboSupport}>
                {qwenSupportBusy ? 'Downloading…' : 'Download Qwen Turbo support file'}
              </button>
              {@const supportDownload = Object.values(downloads).find((item) => item.manifestId === state.qwenTurboSupport?.id)}
              {#if supportDownload?.state === 'running'}
                <div class="small" style="margin-top:6px">Downloading {formatBytes(supportDownload.bytes)} of {formatBytes(supportDownload.total ?? state.qwenTurboSupport.sizeBytes)}…</div>
              {:else if supportDownload?.state === 'error'}
                <div class="notice err small" style="margin-top:6px">{supportDownload.error ?? 'The download failed.'}</div>
              {/if}
              {#if qwenSupportError}<div class="notice err small" style="margin-top:6px">{qwenSupportError}</div>{/if}
            {/if}
          {:else if !state.baseModel.engineReady}
            <div class="small" style="margin-top:4px">SD.Next is not running. The test will start it; Velatura will assemble the selected profile's local reference from verified installed files. No separate full base checkpoint is required.</div>
          {:else if !state.baseModel.referencePrepared || !state.baseModel.listed}
            <div class="small" style="margin-top:4px">The small tokenizer is verified. Velatura will verify the selected profile files, assemble the local Diffusers reference and ask SD.Next to index it automatically when you start the test.</div>
          {:else if state.baseModel.loaded}
            <div class="small" style="margin-top:4px">The local {state.baseModel.name} reference is loaded{#if state.baseModel.loadedClass} ({state.baseModel.loadedClass}){/if}. Its weights come from the verified profile components; no separate full base checkpoint was downloaded.</div>
          {:else}
            <div class="small" style="margin-top:4px">The local reference is ready. The test selects it with the profile components and keeps the saved SD.Next model default unchanged.</div>
          {/if}
        {:else if !state.baseModel.engineReady}
          <div class="small" style="margin-top:4px">SD.Next is not running. The test will start it and then check the selected base.</div>
        {:else if !state.baseModel.listed}
          <div class="small" style="margin-top:4px">This base is not listed in this SD.Next instance. Start the managed engine from Velatura; no other model will be used as a fallback.</div>
        {:else if state.baseModel.loaded}
          <div class="small" style="margin-top:4px">SD.Next reports this base as loaded{#if state.baseModel.loadedClass} ({state.baseModel.loadedClass}){/if}. Velatura checks the pipeline and components again during the test.</div>
        {:else}
          <div class="small" style="margin-top:4px">Base found locally. The test selects it with the profile components and keeps the saved model default unchanged.</div>
        {/if}
      </div>
    {/if}
    {#if state.qwenGgufCompat?.restartRequired}
      <div class="notice warn small" style="margin-top:12px">
        <strong>Restart SD.Next to activate the Qwen GGUF fix.</strong>
        <div style="margin-top:4px">
          Velatura has prepared a local compatibility helper. This SD.Next session was already running, so it has not loaded it yet. Restarting here preserves your saved model default.
        </div>
        <button class="primary" style="margin-top:8px" disabled={restartingQwenCompat || testing} onclick={restartQwenCompatEngine}>
          {restartingQwenCompat ? 'Restarting SD.Next…' : 'Restart SD.Next with the fix'}
        </button>
        {#if qwenCompatRestartError}<div class="notice err small" style="margin-top:6px">{qwenCompatRestartError}</div>{/if}
      </div>
    {/if}

    <div class="flex" style="margin-top:10px">
      <button class="primary" disabled={testing || state.qwenGgufCompat?.restartRequired || Boolean(state.baseModel?.managedReference && !state.qwenTurboSupport?.ready)} onclick={testRender}>
        {testing ? 'Rendering…' : 'Test the model'}
      </button>
      {#if testResult?.ok}
        <span class="badge ok">worked</span>
        <span class="muted small">
          {testResult.seconds?.toFixed(1)}s · {testResult.steps} steps · {testResult.size}px
          {#if testResult.vramGb} · {testResult.vramGb} GB VRAM{/if}
        </span>
      {:else if testResult?.error}
        <span class="badge err">failed</span>
        <span class="muted small">{testResult.error}</span>
      {/if}
    </div>
    {#if testing}
      {@const testPercent = Math.round((testProgress?.progress ?? 0) * 100)}
      <div class="notice small" style="margin-top:10px">
        <div><strong>{testProgress?.stage === 'queued' ? 'Waiting in the queue' : `${formatEngineStage(testProgress?.stage)}…`}</strong>{#if testProgress?.progress && testProgress.progress > 0} · {testPercent}%{/if}</div>
        <div class="muted small" style="margin-top:4px">The first model load can take several minutes. Velatura keeps waiting and shows the phase reported by SD.Next.</div>
        <div class="bar" class:indeterminate={!testProgress?.progress} role="progressbar" aria-label="Test render progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={testPercent}>
          <div style="width:{testProgress?.progress ? testPercent : 35}%"></div>
        </div>
      </div>
    {/if}
    {#if testResult?.image}
      <div class="gallery" style="margin-top:12px">
        <img
          src={`data:image/png;base64,${testResult.image}`}
          alt="test render"
          style="max-width:320px;border-radius:8px"
        />
      </div>
    {/if}
  </div>

  <div class="panel">
    <h3 class="panel-title">Final check</h3>
    <p class="muted small">
      Every installed file is read and compared with the expected size and SHA-256. Nothing is sent
      anywhere: the check happens on this machine.
    </p>

    <button class="primary" disabled={busy} onclick={verify}>Run the check</button>
    {#if verifyProgress}
      <div class="muted small" style="margin-top:8px">
        reading {verifyProgress.label} — {formatBytes(verifyProgress.bytes)}
        {#if verifyProgress.total}of {formatBytes(verifyProgress.total)}{/if}
      </div>
    {/if}

    {#if report}
      <table style="margin-top:14px">
        <thead>
          <tr><th>Component</th><th>Status</th><th>Size</th><th>SHA-256</th><th>Notes</th></tr>
        </thead>
        <tbody>
          {#each report as row (row.id)}
            <tr>
              <td>
                {row.label}
                {#if !row.required}<span class="badge">optional</span>{/if}
              </td>
              <td>
                {#if row.status === 'installed'}<span class="badge ok">ok</span>
                {:else if row.status === 'incompatible'}<span class="badge err">incompatible</span>
                {:else if !row.required}<span class="badge">not installed — optional</span>
                {:else}<span class="badge">missing</span>{/if}
              </td>
              <td>{row.sizeOk === undefined ? '—' : row.sizeOk ? '✓' : '✗'}</td>
              <td>{row.shaOk === undefined ? '—' : row.shaOk ? '✓' : '✗'}</td>
              <td class="small muted">{row.problems.join('; ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <div class="flex" style="margin-top:16px">
      <button class="primary" disabled={busy} onclick={finish}>Finish setup</button>
      <button class="ghost" onclick={() => (step = 3)}>Back</button>
      {#if finished}<span class="badge ok">ready — you can generate now</span>{/if}
    </div>
  </div>
{/if}

{#if systemPaths}
  <div class="panel" style="margin-top:18px">
    <details>
      <summary class="panel-title" style="cursor:pointer;margin:0">System & SD.Next Folders</summary>
      <p class="muted small" style="margin:8px 0 12px">
        Real local paths used by Velatura and SD.Next on this computer.
      </p>
      <table>
        <tbody>
          <tr>
            <td>SD.Next engine</td>
            <td class="mono">{systemPaths.install.sdnext ?? 'not configured'}</td>
            <td>
              {#if systemPaths.install.sdnext}
                <button class="ghost small" onclick={() => openSystemFolder(systemPaths!.install.sdnext!)}>Open folder</button>
              {/if}
            </td>
          </tr>
          <tr>
            <td>Generated images folder</td>
            <td class="mono">{systemPaths.install.images}</td>
            <td>
              <button class="ghost small" onclick={() => openSystemFolder(systemPaths!.install.images)}>Open folder</button>
            </td>
          </tr>
          <tr>
            <td>Diagnostic logs</td>
            <td class="mono">{systemPaths.install.logs}</td>
            <td>
              <button class="ghost small" onclick={() => openSystemFolder(systemPaths!.install.logs)}>Open folder</button>
            </td>
          </tr>
          <tr>
            <td>Velatura settings</td>
            <td class="mono" colspan="2">{systemPaths.install.config}</td>
          </tr>
        </tbody>
      </table>
      {#if pathNote}
        <div class="muted small" style="margin-top:8px">{pathNote}</div>
      {/if}
    </details>
  </div>
{/if}

