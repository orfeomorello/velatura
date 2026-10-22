<script lang="ts">
  /**
   * One menu for every command, anchored to the composer.
   *
   * The old panel had two layers - a mode (Edit or Style) and then a tool,
   * then the presets - and it pushed the picture up while it was open. Here
   * the families are tabs in a single popover: Style is a family like the
   * others, not a mode.
   *
   * What a click does depends on what is on the stage, which is why the note
   * at the bottom says it: with a result to work on the command runs at once,
   * with only a reference attached it fills the prompt and waits.
   */
  import { STYLE_ACTIONS, STYLE_GROUPS, type QuickAction } from './chips';
  import { EDIT_TOOLS } from './edit-tools';

  interface Props {
    /** which family tab is open */
    openGroup: string;
    /** the preset waiting for the user to confirm the replacement of a custom prompt */
    pending?: { label: string; preview: string } | null;
    ongroup: (id: string) => void;
    onselect: (preset: QuickAction) => void;
    onconfirm: (how: 'replace' | 'merge') => void;
    oncancel: () => void;
  }

  let {
    openGroup,
    pending = null,
    ongroup,
    onselect,
    onconfirm,
    oncancel,
  }: Props = $props();

  const FAMILIES = [
    ...EDIT_TOOLS.map((tool) => ({
      id: tool.id,
      icon: tool.icon,
      label: tool.label,
      summary: tool.summary,
    })),
    {
      id: 'style',
      icon: '🎨',
      label: 'Style',
      summary: 'Change the look, not the content: photography, illustration, quality.',
    },
  ];

  let family = $derived(FAMILIES.find((item) => item.id === openGroup) ?? FAMILIES[0]!);
  let sections = $derived<{ label?: string; actions: QuickAction[] }[]>(
    family.id === 'style'
      ? STYLE_GROUPS.map((group) => ({
          label: group,
          actions: STYLE_ACTIONS.filter((action) => action.group === group),
        })).filter((section) => section.actions.length > 0)
      : [
          {
            actions: EDIT_TOOLS.find((tool) => tool.id === family.id)?.presets ?? [],
          },
        ],
  );
</script>

<div class="gpt-command-menu" role="dialog" aria-label="Edit and style commands">
  {#if pending}
    <div class="gpt-confirm" role="group" aria-live="polite">
      <span class="small">«{pending.label}» will replace your text.</span>
      <span class="gpt-confirm-quote small muted">“{pending.preview}”</span>
      <div class="gpt-confirm-actions">
        <button type="button" class="primary small" onclick={() => onconfirm('replace')}>
          Replace
        </button>
        <button type="button" class="ghost small" onclick={() => onconfirm('merge')}>
          Add to the preset
        </button>
        <button type="button" class="ghost small" onclick={oncancel}>Cancel</button>
      </div>
    </div>
  {:else}
    <div class="gpt-menu-tabs" role="tablist" aria-label="Command families">
      {#each FAMILIES as item (item.id)}
        <button
          type="button"
          role="tab"
          aria-selected={item.id === family.id}
          class="gpt-menu-tab"
          class:active={item.id === family.id}
          title={item.summary}
          onclick={() => ongroup(item.id)}
        >
          <span aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      {/each}
    </div>

    <div class="gpt-menu-body">
      <p class="gpt-menu-summary small muted">{family.summary}</p>
      {#each sections as section (section.label ?? 'presets')}
        <div class="gpt-menu-section">
          {#if section.label}
            <span class="gpt-tool-group-label">{section.label}</span>
          {/if}
          <div class="gpt-menu-grid">
            {#each section.actions as action (action.id)}
              <button
                type="button"
                class="gpt-menu-item"
                title={action.summary}
                onclick={() => onselect(action)}
              >
                <span class="gpt-quick-icon" aria-hidden="true">{action.icon}</span>
                <span class="gpt-menu-item-label">{action.label}</span>
              </button>
            {/each}
          </div>
        </div>
      {/each}
      <p class="gpt-menu-note muted small">
        {'The command fills the prompt: check it, then press Apply edit.'}
      </p>
    </div>
  {/if}
</div>
