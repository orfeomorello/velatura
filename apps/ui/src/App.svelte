<script lang="ts">
  import Models from './routes/Models.svelte';
  import Setup from './routes/Setup.svelte';
  import Generate from './routes/Generate.svelte';
  import Queue from './routes/Queue.svelte';
  import Privacy from './routes/Privacy.svelte';
  import { onMount } from 'svelte';
  import { api, sessionToken, type Health } from './lib/api';
  import { onHandoff, onQueueView } from './lib/studio';
  import { displayModelName } from './lib/paths';

  type Route = 'generate' | 'queue' | 'privacy' | 'models' | 'setup';

  let route = $state<Route>('generate');
  let health = $state<Health | undefined>(undefined);
  let hasToken = $state(true);
  let tokenInput = $state('');
  let profiles = $state<Array<{ id: string; label: string; description?: string }>>([]);
  let profileId = $state('');
  let profileNote = $state('');
  let engineBusy = $state(false);
  let engineActionInFlight = $state<'start' | 'stop' | undefined>(undefined);
  let engineMessage = $state('');
  let engineError = $state('');
  let engineLogs = $state<string[]>([]);
  let showEngineLogs = $state(false);

  async function loadProfiles() {
    try {
      profiles = await api.get<Array<{ id: string; label: string; description?: string }>>('/api/v1/profiles');
      const config = await api.get<{ profileId: string }>('/api/v1/config');
      profileId = config.profileId;
    } catch {
      profiles = [];
    }
  }

  /** Change the profile while Velatura is running. */
  async function changeProfile(id: string) {
    profileId = id;
    profileNote = '';
    try {
      const result = await api.post<{ checkpoint?: string; reason?: string; applied?: boolean }>(
        '/api/v1/setup/profile',
        { profileId: id },
      );
      profileNote = result.reason ??
        (result.checkpoint ? `Active model: ${displayModelName(result.checkpoint)}` : '');
    } catch (err) {
      profileNote = (err as Error).message;
    }
    window.dispatchEvent(new CustomEvent('velatura:profile'));
  }

  async function engineAction(action: 'start' | 'stop') {
    engineBusy = true;
    engineActionInFlight = action;
    engineMessage = '';
    engineError = '';
    if (action === 'start') {
      engineLogs = [];
    }
    try {
      const result = await api.post<{
        error?: string;
        url?: string;
        started?: boolean;
        alreadyRunning?: boolean;
        stopped?: boolean;
        reason?: string;
        profileApplied?: boolean;
        profileReason?: string;
      }>(`/api/v1/sdnext/${action}`, { bootstrapConsent: true });
      if (result.error) {
        engineError = result.error;
      } else if (action === 'stop' && !result.stopped) {
        engineMessage = result.reason
          ? `Not stopped: ${result.reason}`
          : 'SD.Next was not stopped.';
      } else if (action === 'stop') {
        engineMessage = 'SD.Next has stopped.';
      } else if (result.started && result.profileApplied === false) {
        engineMessage = `SD.Next is running: ${result.profileReason ?? 'check profile models'}`;
      } else if (result.started || result.alreadyRunning) {
        engineMessage = 'SD.Next is ready.';
      }
      await refresh();
    } catch (err) {
      engineError = (err as Error).message;
    } finally {
      engineBusy = false;
      engineActionInFlight = undefined;
    }
  }

  async function refresh() {
    if (!sessionToken()) {
      hasToken = false;
      return;
    }
    try {
      health = await api.get<Health>('/api/v1/health');
      hasToken = true;
    } catch {
      health = undefined;
      hasToken = false;
    }
  }

  function useToken() {
    const token = tokenInput.trim();
    if (!token) return;
    try {
      localStorage.setItem('velatura.token', token);
    } catch {
      /* private mode */
    }
    window.location.reload();
  }

  $effect(() => {
    refresh();
    loadProfiles();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  });

  // Go straight to Generate when setup is ready; only show Setup on first unconfigured run
  onMount(async () => {
    try {
      const config = await api.get<{ sdnextRoot?: string; setupCompleted?: boolean }>('/api/v1/config');
      if (!config.sdnextRoot || !config.setupCompleted) {
        route = 'setup';
      } else {
        route = 'generate';
      }
    } catch {
      /* keep the default view */
    }

    // Listen to live engine startup logs from SSE
    const events = new EventSource(`/api/v1/queue/events?token=${encodeURIComponent(sessionToken())}`);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type: string; line?: string };
        if (event.type === 'engine-log' && event.line) {
          const clean = event.line.trim();
          if (clean) {
            engineLogs = [...engineLogs.slice(-14), clean];
          }
        }
      } catch {
        /* ignore */
      }
    };
    events.onerror = () => events.close();
    return () => events.close();
  });

  // Route changes requested by child screens
  $effect(() => {
    const unsubscribeHandoff = onHandoff(() => (route = 'generate'));
    const unsubscribeQueue = onQueueView(() => (route = 'queue'));
    const onSetupFinished = () => (route = 'generate');
    window.addEventListener('velatura:setup-finished', onSetupFinished);
    return () => {
      unsubscribeHandoff();
      unsubscribeQueue();
      window.removeEventListener('velatura:setup-finished', onSetupFinished);
    };
  });
</script>

{#if !hasToken}
  <div class="gate">
    <div class="panel" style="max-width:520px">
      <h2>Velatura needs the session token</h2>
      <p class="subtitle">
        The server is running, but this address was opened without the token. The token is printed
        in the terminal where you started Velatura, at the end of the line that begins with
        <span class="mono">UI:</span>
      </p>
      <label for="token">Paste it here</label>
      <input id="token" type="text" bind:value={tokenInput} placeholder="the token from the terminal" />
      <div class="flex" style="margin-top:12px">
        <button class="primary" disabled={!tokenInput.trim()} onclick={useToken}>Open Velatura</button>
      </div>
      <p class="muted small" style="margin-top:14px">
        It is a local token: it only protects this computer, and it changes every time you start
        Velatura.
      </p>
    </div>
  </div>
{:else}
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <h1>Velatura</h1>
    </div>

    <nav>
      <button class:active={route === 'generate'} onclick={() => (route = 'generate')}>Studio</button>
      <button class:active={route === 'queue'} onclick={() => (route = 'queue')}>History & Queue</button>
      <button class:active={route === 'privacy'} onclick={() => (route = 'privacy')}>Privacy</button>
      <div class="nav-divider"></div>
      <button class:active={route === 'models'} onclick={() => (route = 'models')}>Models</button>
      <button class:active={route === 'setup'} onclick={() => (route = 'setup')}>Setup</button>
    </nav>

    <div class="status">
      <div class="flex" style="justify-content:space-between">
        <div>
          <span
            class="dot {engineActionInFlight || health?.sdnext.starting
              ? 'warn'
              : health?.sdnext.ready
                ? 'ok'
                : 'idle'}"
          ></span>
          {#if engineActionInFlight === 'start' || health?.sdnext.starting}
            Starting engine…
          {:else if engineActionInFlight === 'stop'}
            Stopping…
          {:else if health?.sdnext.ready}
            Engine ready
          {:else}
            Engine on standby
          {/if}
        </div>
        <div class="flex" style="gap:4px">
          {#if !health?.sdnext.ready && !health?.sdnext.starting && engineActionInFlight !== 'start'}
            <button
              class="ghost small"
              style="padding:3px 8px;font-size:11.5px"
              disabled={engineBusy}
              onclick={() => engineAction('start')}
            >
              Start
            </button>
          {:else if health?.sdnext.managed}
            <button
              class="ghost small"
              style="padding:3px 8px;font-size:11.5px"
              disabled={engineBusy}
              onclick={() => engineAction('stop')}
            >
              Stop
            </button>
          {/if}
        </div>
      </div>

      {#if health?.hardware?.gpu}
        <div class="small muted" style="margin-top:6px">
          {health.hardware.gpu}{health.hardware.vramGb ? ` · ${health.hardware.vramGb} GB` : ''}
        </div>
      {/if}

      {#if engineMessage}
        <div class="engine-feedback small" role="status" aria-live="polite">{engineMessage}</div>
      {/if}
      {#if engineError}
        <div class="engine-feedback error small" role="alert">{engineError}</div>
      {/if}

      {#if profiles.length > 0}
        <div style="margin-top:10px">
          <label class="small" for="profile">Profile</label>
          <select id="profile" bind:value={profileId} onchange={(e) => changeProfile(e.currentTarget.value)}>
            {#each profiles as profile (profile.id)}
              <option value={profile.id}>{profile.label}</option>
            {/each}
          </select>
          {#if profileNote}
            <div class="small muted" style="margin-top:4px">{profileNote}</div>
          {/if}
        </div>
      {/if}
    </div>
  </aside>

  <main class:studio-mode={route === 'generate'}>
    {#if route === 'setup'}
      <Setup />
    {:else if route === 'models'}
      <Models />
    {:else if route === 'privacy'}
      <Privacy />
    {:else if route === 'queue'}
      <Queue />
    {:else if route === 'generate'}
      {#if health && !health.sdnext.ready}
        <!-- Full-screen Engine Launch / Startup Hero before showing Studio -->
        <div class="engine-gate">
          <div class="engine-gate-card panel">
            {#if engineActionInFlight === 'start' || health.sdnext.starting}
              <div class="engine-spinner" aria-hidden="true"></div>
              <h2>Starting SD.Next Engine…</h2>
              <p class="muted">
                Initializing the local AI engine on <strong>{health.hardware?.gpu ?? 'your GPU'}</strong> and preparing the Qwen-Image 2.1 pipeline.
                This usually takes 20–45 seconds.
              </p>

              <div class="bar indeterminate" style="margin:18px 0 12px">
                <div style="width:45%"></div>
              </div>

              {#if health.sdnext.profilePreparation?.message}
                <div class="engine-stage-pill">
                  {health.sdnext.profilePreparation.message}
                  {#if typeof health.sdnext.profilePreparation.percent === 'number'}
                    ({health.sdnext.profilePreparation.percent}%)
                  {/if}
                </div>
              {:else if engineLogs.length > 0}
                <div class="engine-stage-pill mono">
                  {engineLogs[engineLogs.length - 1]}
                </div>
              {:else}
                <div class="engine-stage-pill">
                  Launching Python & IPEX/GPU backend…
                </div>
              {/if}

              {#if engineLogs.length > 0}
                <div style="margin-top:14px;width:100%;text-align:left">
                  <button
                    type="button"
                    class="ghost small"
                    onclick={() => (showEngineLogs = !showEngineLogs)}
                  >
                    {showEngineLogs ? 'Hide startup log' : 'Show live startup log'}
                  </button>
                  {#if showEngineLogs}
                    <pre class="log" style="margin-top:8px;max-height:150px">{engineLogs.join('\n')}</pre>
                  {/if}
                </div>
              {/if}
            {:else}
              <div class="engine-hero-icon" aria-hidden="true">⚡</div>
              <h2>Ready to Launch Studio</h2>
              <p class="muted">
                Your system and Qwen-Image 2.1 models are configured. Start the local SD.Next engine to open the Studio prompt workspace.
              </p>

              {#if health.hardware?.gpu}
                <div class="engine-hw-badge">
                  <span>GPU: <strong>{health.hardware.gpu}</strong>{health.hardware.vramGb ? ` (${health.hardware.vramGb} GB VRAM)` : ''}</span>
                  {#if profiles.length > 0}
                    <span>· Profile: <strong>{profiles.find((p) => p.id === profileId)?.label ?? profileId}</strong></span>
                  {/if}
                </div>
              {/if}

              {#if engineError}
                <div class="notice err small" style="margin:14px 0;text-align:left">{engineError}</div>
              {/if}

              <div class="flex" style="justify-content:center;margin-top:20px;gap:12px">
                <button
                  class="primary engine-start-hero-btn"
                  disabled={engineBusy}
                  onclick={() => engineAction('start')}
                >
                  Start Engine & Open Studio
                </button>
              </div>
              <p class="muted small" style="margin-top:14px">
                100% local · offline mode enabled · no extra model downloads
              </p>
            {/if}
          </div>
        </div>
      {:else}
        <Generate />
      {/if}
    {/if}
  </main>
</div>
{/if}
