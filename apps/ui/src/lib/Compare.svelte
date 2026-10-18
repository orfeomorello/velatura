<script lang="ts">
  /**
   * Before and after, with a slider.
   *
   * The two images are stacked; the "before" one is clipped by the
   * position of the handle, so dragging it wipes one into the other.
   */
  let {
    before,
    after,
    alt = 'result',
  }: { before: string; after: string; alt?: string } = $props();

  let position = $state(50);
</script>

<div class="compare">
  <img class="compare-after" src={after} alt="{alt} — after" />
  <div class="compare-before" style="clip-path:inset(0 {100 - position}% 0 0)">
    <img src={before} alt="{alt} — before" />
  </div>
  <div class="compare-handle" style="left:{position}%"></div>
  <input
    class="compare-range"
    type="range"
    min="0"
    max="100"
    step="1"
    bind:value={position}
    aria-label="before and after"
  />
  <span class="compare-tag left">before</span>
  <span class="compare-tag right">after</span>
</div>
