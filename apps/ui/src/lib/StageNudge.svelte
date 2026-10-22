<script lang="ts">
  /**
   * The controls that live on the picture.
   *
   * The arrows extend the canvas: the subject stays where it is and the model
   * continues the scene on the side the arrow points at. Each click is one job
   * and the picture really gets bigger, so the caption shows the current size
   * and an arrow is disabled once its side has reached the limit.
   *
   * Everything is anchored to the top-right corner of the viewport so it never
   * covers the middle of the image.
   */
  import { planExtend, type ExtendDirection, type ExtendSize } from './canvas-extend';

  interface Props {
    /** an edit is being sent, or a job is running */
    busy: boolean;
    /** the real size of the picture on the stage */
    size?: ExtendSize;
    /** how much the picture is magnified on screen (1 = 100%) */
    zoom: number;
    canZoomIn: boolean;
    canZoomOut: boolean;
    onextend: (direction: ExtendDirection) => void;
    onzoom: (direction: 'in' | 'out') => void;
  }

  let { busy, size, zoom, canZoomIn, canZoomOut, onextend, onzoom }: Props = $props();

  const canExtend = (direction: ExtendDirection) =>
    size !== undefined && planExtend(size.width, size.height, direction) !== undefined;
</script>

<div class="stage-nudge-layer">
  <div class="stage-nudge-wrap">
    <div class="stage-nudge" role="group" aria-label="Extend the picture">
      <div
        class="stage-nudge-grid"
        title="Extend the picture: one click is one job, a quarter of that side, up to 2048 px"
      >
        <button
          type="button"
          class="stage-nudge-key up"
          aria-label="Extend the picture upward"
          title="Extend upward by a quarter"
          disabled={busy || !canExtend('up')}
          onclick={() => onextend('up')}
        >
          ↑
        </button>
        <button
          type="button"
          class="stage-nudge-key left"
          aria-label="Extend the picture to the left"
          title="Extend to the left by a quarter"
          disabled={busy || !canExtend('left')}
          onclick={() => onextend('left')}
        >
          ←
        </button>
        <button
          type="button"
          class="stage-nudge-key right"
          aria-label="Extend the picture to the right"
          title="Extend to the right by a quarter"
          disabled={busy || !canExtend('right')}
          onclick={() => onextend('right')}
        >
          →
        </button>
        <button
          type="button"
          class="stage-nudge-key down"
          aria-label="Extend the picture downward"
          title="Extend downward by a quarter"
          disabled={busy || !canExtend('down')}
          onclick={() => onextend('down')}
        >
          ↓
        </button>
      </div>

      <div class="stage-nudge-zoom" role="group" aria-label="Zoom the view">
        <button
          type="button"
          class="stage-nudge-key"
          aria-label="Zoom in"
          title="Zoom in (the picture is not changed)"
          disabled={!canZoomIn}
          onclick={() => onzoom('in')}
        >
          +
        </button>
        <button
          type="button"
          class="stage-nudge-key"
          aria-label="Zoom out"
          title="Zoom out (the picture is not changed)"
          disabled={!canZoomOut}
          onclick={() => onzoom('out')}
        >
          −
        </button>
      </div>
    </div>

    {#if size}
      <div
        class="stage-nudge-caption"
        title="The current canvas. An arrow adds a quarter of that side and the model continues the scene there; the zoom only changes what you see."
      >
        {size.width} × {size.height}{zoom > 1 ? ` · ${Math.round(zoom * 100)}%` : ''}
      </div>
    {/if}
  </div>
</div>
