import type * as THREE from 'three/webgpu';

const WEBGPU_BYTES_PER_ROW_ALIGNMENT = 256;

export type PanelReadbackStats = {
  foregroundRatio: number;
};

type TimelineElementActivityState = {
  aliveCount?: unknown;
  localTime?: unknown;
  playing?: unknown;
  visible?: unknown;
};

export type TimelineElementDefinitionLike = {
  readonly elements: Readonly<Record<string, unknown>>;
};

const DEFAULT_PANEL_FOREGROUND_RATIO = 0.0005;

type RenderTargetReadbackRenderer = Pick<THREE.WebGPURenderer, 'readRenderTargetPixelsAsync'>;

/**
 * Creates the per-frame 1x1 readback used by headless/offscreen capture loops.
 *
 * Three r185's WebGPU readback path can return an empty first full-size capture after many frames
 * without a readback. Call the returned function once after every render to keep that path drained.
 */
export function createDrainedReadback(
  renderer: RenderTargetReadbackRenderer,
  target: THREE.RenderTarget,
): () => Promise<void> {
  return async () => {
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  };
}

/** Contract-sheet guard: every captured panel must contain a meaningful non-single-pixel floor. */
export function allPanelsHaveForeground(
  panelStats: readonly PanelReadbackStats[],
  minimumForegroundRatio = DEFAULT_PANEL_FOREGROUND_RATIO,
): boolean {
  return (
    panelStats.length > 0 &&
    panelStats.every(
      ({ foregroundRatio }) =>
        Number.isFinite(foregroundRatio) && foregroundRatio > minimumForegroundRatio,
    )
  );
}

/**
 * Requires every requested timeline element to publish a state at every capture and to show at
 * least one type-appropriate sign of activity. This catches missing elements and definitions whose
 * timers/visibility/alive population remain at their inert zero values for the entire showcase.
 */
export function allTimelineElementsHaveActivity(
  captures: readonly Readonly<Record<string, unknown>>[],
  elementKeys: readonly string[],
): boolean {
  if (captures.length === 0 || elementKeys.length === 0) return false;
  return elementKeys.every((key) => {
    const states = captures.map((capture) => capture[key]);
    if (
      states.some(
        (state) =>
          typeof state !== 'object' ||
          state === null ||
          Array.isArray(state) ||
          !(
            'localTime' in state ||
            'playing' in state ||
            'visible' in state ||
            'aliveCount' in state
          ),
      )
    ) {
      return false;
    }
    const activityStates = states as TimelineElementActivityState[];
    const publishesEmitterPopulation = activityStates.some(
      ({ aliveCount }) => typeof aliveCount === 'number' && Number.isFinite(aliveCount),
    );
    if (publishesEmitterPopulation) {
      return activityStates.some(
        ({ aliveCount }) =>
          typeof aliveCount === 'number' && Number.isFinite(aliveCount) && aliveCount > 0,
      );
    }
    return activityStates.some(
      ({ localTime, playing, visible }) =>
        playing === true ||
        visible === true ||
        (typeof localTime === 'number' && Number.isFinite(localTime) && localTime > 0),
    );
  });
}

/** Returns the complete element key set owned by a timeline definition. */
export function timelineDefinitionElementKeys(
  definition: TimelineElementDefinitionLike,
): readonly string[] {
  return Object.freeze(Object.keys(definition.elements));
}

/** Guards page wiring against silently tracking only a hand-picked subset of a definition. */
export function timelineTrackedKeysMatchDefinition(
  definition: TimelineElementDefinitionLike,
  trackedKeys: readonly string[],
): boolean {
  const expected = timelineDefinitionElementKeys(definition);
  return (
    trackedKeys.length === expected.length &&
    new Set(trackedKeys).size === trackedKeys.length &&
    expected.every((key) => trackedKeys.includes(key))
  );
}

/**
 * Removes the row padding returned by Three r185's WebGPU render-target readback.
 * WebGL2 already returns a dense array. The final WebGPU row is not padded because Three sizes
 * its staging buffer as `(height - 1) * alignedBytesPerRow + denseBytesPerRow`.
 */
export function compactRgba8Readback(
  source: Uint8Array,
  width: number,
  height: number,
  webgpu: boolean,
  bytesPerPixel = 4,
): Uint8Array {
  const denseBytesPerRow = width * bytesPerPixel;
  const denseByteLength = denseBytesPerRow * height;
  if (source.byteLength === denseByteLength) return source;

  if (!webgpu) {
    throw new Error(
      `Unexpected WebGL2 readback length: got ${source.byteLength}, expected ${denseByteLength}.`,
    );
  }

  const paddedBytesPerRow =
    Math.ceil(denseBytesPerRow / WEBGPU_BYTES_PER_ROW_ALIGNMENT) * WEBGPU_BYTES_PER_ROW_ALIGNMENT;
  const paddedByteLength = (height - 1) * paddedBytesPerRow + denseBytesPerRow;
  if (source.byteLength !== paddedByteLength) {
    throw new Error(
      `Unexpected WebGPU readback length: got ${source.byteLength}, expected ${paddedByteLength}.`,
    );
  }

  const dense = new Uint8Array(denseByteLength);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * paddedBytesPerRow;
    dense.set(
      source.subarray(sourceOffset, sourceOffset + denseBytesPerRow),
      row * denseBytesPerRow,
    );
  }
  return dense;
}

/** Compacts WebGPU padding and normalizes both backends to top-down rows for DOM presentation. */
export function normalizeRgba8Readback(
  source: Uint8Array,
  width: number,
  height: number,
  webgpu: boolean,
): Uint8Array {
  const dense = compactRgba8Readback(source, width, height, webgpu);
  if (webgpu) return dense;
  const bytesPerRow = width * 4;
  const topDown = new Uint8Array(dense.byteLength);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (height - 1 - row) * bytesPerRow;
    topDown.set(dense.subarray(sourceOffset, sourceOffset + bytesPerRow), row * bytesPerRow);
  }
  return topDown;
}
