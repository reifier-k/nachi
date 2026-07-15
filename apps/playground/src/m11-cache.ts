import {
  VFXSystem,
  VfxDiagnosticError,
  attributeStorageComponentIndex,
  bakeSimulation,
  billboard,
  burst,
  curve,
  defineEffect,
  defineEmitter,
  estimateSimulationCacheMemory,
  lifetime,
  positionSphere,
  replaySimulation,
  sizeOverLife,
  type SimulationCache,
  type VfxEmitterRuntimeView,
  type VfxRuntimeRenderer,
} from '@nachi-vfx/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m11-cache.css';

const WIDTH = 128;
const HEIGHT = 64;
const FRAME_RATE = 60;
const LOOP_FRAMES = FRAME_RATE;
const LOOP_TOLERANCE = 0.002;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const consoleMessages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  consoleMessages.push(values.map(String).join(' '));
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  consoleMessages.push(values.map(String).join(' '));
  originalError(...values);
};

type BackendLike = {
  readonly device?: {
    readonly features?: { has(name: string): boolean };
    readonly limits?: { readonly maxStorageBuffersPerShaderStage?: number };
    readonly lost?: Promise<{ message?: string; reason?: string }>;
  };
  readonly gl?: WebGL2RenderingContext;
  readonly isWebGPUBackend?: boolean;
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing M11 cache UI element ${selector}.`);
  return value;
}

function countedRuntime(base: VfxRuntimeRenderer) {
  const counts = { indirect: 0, simulation: 0 };
  const runtime: VfxRuntimeRenderer = {
    ...base,
    submitCompute(kernel) {
      counts.simulation += 1;
      return base.submitCompute(kernel);
    },
    ...(base.submitComputeIndirect === undefined
      ? {}
      : {
          submitComputeIndirect(
            kernel: Parameters<NonNullable<VfxRuntimeRenderer['submitComputeIndirect']>>[0],
            resource: unknown,
          ) {
            counts.indirect += 1;
            return base.submitComputeIndirect!(kernel, resource);
          },
        }),
  };
  return { counts, runtime };
}

function view(instance: {
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
}): VfxEmitterRuntimeView {
  const value = instance.getEmitter('particles');
  if (!value) throw new Error('M11 cache runtime emitter is missing.');
  return value;
}

async function readRenderAttributes(runtime: VfxRuntimeRenderer, emitter: VfxEmitterRuntimeView) {
  const names = [
    ...new Set(emitter.program.draws.flatMap(({ vertex }) => vertex.attributes)),
  ].sort();
  const buffers = new Map<number, Float32Array | Int32Array | Uint32Array>();
  for (const name of names) {
    const attribute = emitter.program.attributeSchema.byName[name]!;
    const storage = emitter.program.attributeSchema.storageArrays[attribute.physical.bufferIndex]!;
    if (!buffers.has(storage.index)) {
      const raw = await runtime.readStorage!(emitter.kernels.storages[storage.name]!);
      buffers.set(
        storage.index,
        storage.componentType === 'uint'
          ? new Uint32Array(raw)
          : storage.componentType === 'int'
            ? new Int32Array(raw)
            : new Float32Array(raw),
      );
    }
  }
  return Object.fromEntries(
    names.map((name) => {
      const attribute = emitter.program.attributeSchema.byName[name]!;
      const storage =
        emitter.program.attributeSchema.storageArrays[attribute.physical.bufferIndex]!;
      const physical = buffers.get(storage.index)!;
      const logical: number[] = [];
      for (let particle = 0; particle < emitter.program.attributeSchema.capacity; particle += 1) {
        for (let component = 0; component < attribute.components; component += 1) {
          logical.push(
            physical[
              attributeStorageComponentIndex(
                attribute,
                storage,
                runtime.kernelAdapter.capabilities.backend,
                particle,
                component,
              )
            ] ?? 0,
          );
        }
      }
      return [name, logical] as const;
    }),
  );
}

function attributeDifference(
  left: Readonly<Record<string, readonly number[]>>,
  right: Readonly<Record<string, readonly number[]>>,
) {
  let maximum = 0;
  let mismatchCount = 0;
  for (const [name, values] of Object.entries(left)) {
    const other = right[name] ?? [];
    for (let index = 0; index < values.length; index += 1) {
      const difference = Math.abs(values[index]! - (other[index] ?? Number.NaN));
      if (!(difference <= 1e-6)) mismatchCount += 1;
      maximum = Math.max(maximum, difference);
    }
  }
  return { maximum, mismatchCount };
}

function webglReplayDiagnosticCache(): SimulationCache {
  return {
    data: new ArrayBuffer(8),
    diagnostics: [],
    kind: 'simulation-cache',
    metadata: {
      compression: 'float32',
      durationSeconds: 0,
      emitters: [
        {
          aliveCounts: [0],
          aliveIndicesFrameStrideBytes: 4,
          aliveIndicesOffsetBytes: 0,
          attributes: [],
          capacity: 1,
          key: 'particles',
          lineageFrameStrideBytes: 4,
          lineageOffsetBytes: 4,
        },
      ],
      frameCount: 1,
      frameRate: FRAME_RATE,
      interpolation: 'nearest',
      kind: 'nachi-simulation-cache-metadata',
      loop: {
        continuous: true,
        enabled: false,
        integerAttributesMatch: true,
        lineageMatch: true,
        maximumAttributeError: 0,
        tolerance: 0,
      },
      qualityTier: 'low',
      sampleStartFrame: 0,
      sourceBackend: 'webgl2',
      uploadBytesPerFrame: 0,
      version: 2,
    },
  };
}

function aliasSlotReuseLineage(cache: SimulationCache): SimulationCache {
  const emitter = cache.metadata.emitters[0];
  if (emitter?.capacity !== 1) {
    throw new Error('M11 slot-reuse cache has an unexpected schema.');
  }
  const data = cache.data.slice(0);
  const firstLineage = new Uint32Array(data, emitter.lineageOffsetBytes, emitter.capacity);
  const secondLineage = new Uint32Array(
    data,
    emitter.lineageOffsetBytes + emitter.lineageFrameStrideBytes,
    emitter.capacity,
  );
  secondLineage[0] = firstLineage[0]!;
  return { ...cache, data };
}

function particleHorizontalCentroid(pixels: Uint8Array): number {
  let weightedX = 0;
  let weight = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      const brightness =
        Math.max(0, pixels[offset]! - 2) +
        Math.max(0, pixels[offset + 1]! - 6) +
        Math.max(0, pixels[offset + 2]! - 11);
      weightedX += x * brightness;
      weight += brightness;
    }
  }
  return weight === 0 ? Number.NaN : weightedX / weight;
}

async function capture(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.RenderTarget,
  webgpu: boolean,
): Promise<Uint8Array> {
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const raw = new Uint8Array(
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT),
  );
  return compactRgba8Readback(raw, WIDTH, HEIGHT, webgpu);
}

function pixelDifference(left: Uint8Array, right: Uint8Array) {
  let maximumLinear = 0;
  let changed = 0;
  for (let index = 0; index < left.length; index += 4) {
    const difference =
      Math.max(
        Math.abs(left[index]! - right[index]!),
        Math.abs(left[index + 1]! - right[index + 1]!),
        Math.abs(left[index + 2]! - right[index + 2]!),
      ) / 255;
    if (difference > 2 / 255) changed += 1;
    maximumLinear = Math.max(maximumLinear, difference);
  }
  return { changed, maximumLinear };
}

function paint(panels: readonly Uint8Array[]): void {
  const canvas = required<HTMLCanvasElement>('#cache-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('M11 cache visual canvas has no 2D context.');
  const output = context.createImageData(WIDTH * panels.length, HEIGHT);
  for (const [panel, pixels] of panels.entries()) {
    for (let y = 0; y < HEIGHT; y += 1) {
      const sourceY = HEIGHT - 1 - y;
      for (let x = 0; x < WIDTH; x += 1) {
        const source = (sourceY * WIDTH + x) * 4;
        const target = (y * WIDTH * panels.length + panel * WIDTH + x) * 4;
        output.data.set(pixels.subarray(source, source + 4), target);
      }
    }
  }
  context.putImageData(output, 0, 0);
}

async function run(): Promise<void> {
  root.dataset.rendererStatus = 'initializing';
  root.dataset.spikeStatus = 'running';
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x02060b, 1);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  const webgpu = backend.isWebGPUBackend === true;
  const activeBackend = webgpu ? 'WebGPU' : 'WebGL2';
  const expectedBackend = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (activeBackend !== expectedBackend) {
    throw new Error(`Backend mismatch: requested ${expectedBackend}, active ${activeBackend}.`);
  }
  root.dataset.backend = activeBackend;
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = activeBackend;
  if (webgpu && query.get('headless') !== '1') {
    root.dataset.artifactScreenshots = JSON.stringify([
      { filename: 'm11-cache.png', selector: '#cache-visual' },
    ]);
  }
  const transformFeedbackLimit = backend.gl?.getParameter(
    backend.gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS,
  ) as number | undefined;
  const adapter = createThreeKernelAdapter({
    backend: webgpu ? 'webgpu' : 'webgl2',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
    ...(transformFeedbackLimit === undefined
      ? {}
      : { maxTransformFeedbackSeparateAttribs: transformFeedbackLimit }),
  });
  const baseRuntime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const loopingEffect = defineEffect({
    elements: {
      particles: defineEmitter({
        bounds: { center: [0.21, -0.13, 0], radius: 0.7 },
        capacity: 12,
        init: [positionSphere({ radius: 0 }), lifetime(10)],
        lifecycle: { duration: 1, loopCount: 1 },
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 9 }),
        update: [
          sizeOverLife(
            curve(
              [0, 0.11],
              [0.11, 0.11],
              [0.12, 0.19],
              [0.14, 0.19],
              [0.18, 0.11],
              [0.22, 0.11],
              [1, 0.11],
            ),
          ),
        ],
      }),
    },
  });
  const singleShotEffect = defineEffect({
    elements: {
      particles: defineEmitter({
        bounds: { center: [0.21, -0.13, 0], radius: 0.7 },
        capacity: 12,
        init: [positionSphere({ radius: 0 }), lifetime(0.5)],
        lifecycle: { duration: 1, loopCount: 1 },
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 9 }),
        update: [sizeOverLife(curve([0, 0.11], [0.25, 0.19], [0.5, 0.11], [1, 0.11]))],
      }),
    },
  });
  const slotReuseEffect = defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 1,
        init: [positionSphere({ radius: 0.45 }), lifetime(0.015)],
        lifecycle: { duration: 0.02, loopCount: 'infinite' },
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 1 }),
      }),
    },
  });
  const seed = 0x5a17;
  const spawn = { position: [0.21, -0.13, 0] as const, seed };
  const capturePerformance = async (): Promise<void> => {
    // Keep the timestamp-enabled renderer wholly outside the correctness renderer's lifetime-sensitive
    // draw/readback sequence. In particular, #cache-visual must be read from the renderer that owns
    // and rendered the live/replay scenes before this short measurement renderer is initialized.
    const performanceRenderer = await createPlaygroundRenderer({
      antialias: false,
      forceWebGL: requestedBackend === 'webgl',
      trackTimestamp: true,
    });
    performanceRenderer.setSize(1, 1);
    await performanceRenderer.init();
    const performanceBackend = performanceRenderer.backend as BackendLike;
    const performanceAdapter = createThreeKernelAdapter({
      backend: performanceBackend.isWebGPUBackend === true ? 'webgpu' : 'webgl2',
      ...(performanceBackend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
        ? {}
        : {
            maxStorageBuffersPerShaderStage:
              performanceBackend.device.limits.maxStorageBuffersPerShaderStage,
          }),
    });
    const performanceRuntime = createThreeRuntimeRenderer(
      performanceRenderer,
      performanceAdapter,
      performanceBackend.device?.lost,
    );
    const monitor = createPerformanceMonitor(performanceRenderer, {
      gpuScopes: webgpu ? ['compute'] : ['render'],
      mode: query.get('headless') === '1' ? 'headless' : 'visual',
      page: 'm11-cache',
    });
    const performanceSystem = new VFXSystem(performanceRuntime, undefined, {
      onBuildDiagnostic: null,
    });
    performanceSystem.spawn(singleShotEffect, spawn);
    await performanceSystem.update(0);
    const performanceTarget = new THREE.RenderTarget(1, 1);
    const performanceScene = new THREE.Scene();
    const performanceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    performanceScene.add(performanceMesh);
    const performanceCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    performanceCamera.position.z = 1;
    performanceRenderer.setRenderTarget(performanceTarget);
    performanceRenderer.render(performanceScene, performanceCamera);
    await performanceRenderer.readRenderTargetPixelsAsync(performanceTarget, 0, 0, 1, 1);
    await performanceRenderer.resolveTimestampsAsync(webgpu ? 'compute' : 'render');
    await monitor.captureGpuSamples(async () => {
      await performanceSystem.update(1 / FRAME_RATE);
      performanceRenderer.render(performanceScene, performanceCamera);
      await performanceRenderer.readRenderTargetPixelsAsync(performanceTarget, 0, 0, 1, 1);
    });
    performanceRenderer.setRenderTarget(null);
    performanceMesh.geometry.dispose();
    performanceMesh.material.dispose();
    performanceTarget.dispose();
  };
  const loopBakeOptions = {
    compression: 'float32',
    frameRate: FRAME_RATE,
    frames: LOOP_FRAMES + 1,
    interpolation: 'linear',
    loop: true,
    // The same long-lived particle lineages span the duplicated endpoint window [1, 2]. Their
    // size pulses inside that window but returns to the same value at both endpoints.
    loopTolerance: LOOP_TOLERANCE,
    sampleStartFrame: LOOP_FRAMES,
    spawn,
  } as const;
  const singleShotBakeOptions = {
    compression: 'float32',
    frameRate: FRAME_RATE,
    frames: LOOP_FRAMES + 1,
    interpolation: 'linear',
    loop: false,
    spawn,
  } as const;
  const bakeLoopCache = async (system: VFXSystem) => {
    try {
      return { cache: await bakeSimulation(system, loopingEffect, loopBakeOptions) };
    } catch (error) {
      const loopDiagnostic =
        error instanceof VfxDiagnosticError &&
        error.diagnostics.some(({ code }) => code === 'NACHI_SIM_CACHE_LOOP_DISCONTINUITY');
      if (!loopDiagnostic) throw error;

      // Strict loop baking rejects before returning the cache. Re-bake the same deterministic
      // window as non-looping so the spike can publish the measured seam instead of a null result.
      const cache = await bakeSimulation(system, loopingEffect, {
        ...loopBakeOptions,
        loop: false,
      });
      return { cache, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const publishLoopFailure = async (
    message: string,
    loop: Awaited<ReturnType<typeof bakeLoopCache>>['cache']['metadata']['loop'],
    computeSubmissions: Readonly<Record<string, unknown>>,
  ) => {
    const result = {
      activeBackend,
      computeSubmissions,
      error: message,
      loop: { ...loop, enabled: true },
      ok: false,
      validation: { loopContinuity: false },
    };
    root.dataset.spikeError = message;
    await capturePerformance();
    root.dataset.spikeResult = JSON.stringify(result);
    root.dataset.spikeStatus = 'complete';
    root.dataset.sceneReady = 'true';
    required<HTMLElement>('#status-value').textContent = `Validation failed: ${message}`;
  };

  if (!webgpu) {
    const diagnosticCounter = countedRuntime(baseRuntime);
    const diagnosticSystem = new VFXSystem(diagnosticCounter.runtime, undefined, {
      aliveCountReadbackInterval: 1,
      onBuildDiagnostic: null,
    });
    const errorInstance = diagnosticSystem.spawn(singleShotEffect, spawn);
    const spawnState = errorInstance.state;
    const spawnDiagnostic = errorInstance.diagnostics.find(
      ({ code }) => code === 'NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED',
    );
    let bakeDiagnosticCode = '';
    let bakeDiagnosticMessage = '';
    let bakeRejectedWithStructuredDiagnostic = false;
    let bakeRejectedWithTypeError = false;
    try {
      await bakeSimulation(diagnosticSystem, singleShotEffect, {
        ...singleShotBakeOptions,
        frames: 1,
      });
    } catch (error) {
      bakeRejectedWithTypeError = error instanceof TypeError;
      if (error instanceof VfxDiagnosticError) {
        const diagnostic = error.diagnostics.find(
          ({ code }) => code === 'NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED',
        );
        bakeDiagnosticCode = diagnostic?.code ?? error.diagnostics[0]?.code ?? '';
        bakeDiagnosticMessage = diagnostic?.message ?? error.message;
        bakeRejectedWithStructuredDiagnostic = diagnostic !== undefined;
      }
    }
    errorInstance.release();

    let replayDiagnosticCode = '';
    let replayDiagnosticMessage = '';
    try {
      await replaySimulation(
        new VFXSystem(baseRuntime, undefined, { onBuildDiagnostic: null }),
        singleShotEffect,
        webglReplayDiagnosticCache(),
      );
    } catch (error) {
      if (error instanceof VfxDiagnosticError) {
        replayDiagnosticCode = error.diagnostics[0]?.code ?? '';
        replayDiagnosticMessage = error.diagnostics[0]?.message ?? error.message;
      }
    }
    root.dataset.cacheMemory = JSON.stringify({ supported: false });
    required<HTMLElement>('#memory-value').textContent = 'Not available on WebGL2';
    await capturePerformance();
    const validation = {
      bakeRejectedWithStructuredDiagnostic:
        bakeRejectedWithStructuredDiagnostic &&
        !bakeRejectedWithTypeError &&
        bakeDiagnosticCode === 'NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED',
      consoleClean: consoleMessages.length === 0,
      explicitReplayDiagnostic:
        replayDiagnosticCode === 'NACHI_SIM_CACHE_REPLAY_WEBGL2_UNSUPPORTED',
      richSchemaSpawnDiagnostic:
        spawnState === 'error' &&
        spawnDiagnostic?.code === 'NACHI_BACKEND_PACKED_STORAGE_UNSUPPORTED' &&
        spawnDiagnostic.message.includes('higher element groups would alias group 0'),
      simulationNotSubmitted:
        diagnosticCounter.counts.simulation === 0 && diagnosticCounter.counts.indirect === 0,
    };
    const result = {
      activeBackend,
      capability: {
        bake: 'diagnosed-unsupported',
        replay: 'diagnosed-unsupported',
      },
      computeSubmissions: diagnosticCounter.counts,
      constraints: {
        packedSimulationStorage: {
          reason:
            'Renderable lifecycle emitters require packed float group 1, which WebGL2 transform feedback cannot address without aliasing group 0.',
          supported: false,
        },
      },
      diagnostics: {
        bake: {
          code: bakeDiagnosticCode,
          message: bakeDiagnosticMessage,
          structured: bakeRejectedWithStructuredDiagnostic,
          typeError: bakeRejectedWithTypeError,
        },
        replay: { code: replayDiagnosticCode, message: replayDiagnosticMessage },
        spawn: {
          code: spawnDiagnostic?.code ?? '',
          message: spawnDiagnostic?.message ?? '',
          state: spawnState,
        },
      },
      fixture: {
        emission: 'single-shot-burst',
        loopContinuityChecked: false,
        schema: 'rich-billboard',
        validationMode: 'structured-diagnostics',
      },
      ok: Object.values(validation).every(Boolean),
      validation,
    };
    root.dataset.spikeResult = JSON.stringify(result);
    root.dataset.spikeStatus = 'complete';
    root.dataset.sceneReady = 'true';
    required<HTMLElement>('#status-value').textContent = result.ok
      ? 'All checks passed'
      : 'Validation failed';
    return;
  }

  const bakeCounter = countedRuntime(baseRuntime);
  const bakeSystem = new VFXSystem(bakeCounter.runtime, undefined, {
    aliveCountReadbackInterval: 1,
  });
  const baked = await bakeLoopCache(bakeSystem);
  if (baked.error !== undefined) {
    await publishLoopFailure(baked.error, baked.cache.metadata.loop, {
      bake: bakeCounter.counts,
    });
    return;
  }
  const cache = baked.cache;
  const memory = estimateSimulationCacheMemory(cache);
  root.dataset.cacheMemory = JSON.stringify(memory);
  required<HTMLElement>('#memory-value').textContent = `${memory.totalBytes} bytes`;

  const slotReuseBakeCounter = countedRuntime(baseRuntime);
  const slotReuseBakedCache = await bakeSimulation(
    new VFXSystem(slotReuseBakeCounter.runtime, undefined, { aliveCountReadbackInterval: 1 }),
    slotReuseEffect,
    {
      compression: 'float32',
      frameRate: 10,
      frames: 2,
      interpolation: 'linear',
      spawn: { seed: 0x51_07 },
    },
  );
  const slotReuseEmitter = slotReuseBakedCache.metadata.emitters[0]!;
  const slotReusePosition = slotReuseEmitter.attributes.find(({ name }) => name === 'position')!;
  const slotReuseAlive = [0, 1].map((frame) => [
    ...new Uint32Array(
      slotReuseBakedCache.data,
      slotReuseEmitter.aliveIndicesOffsetBytes +
        frame * slotReuseEmitter.aliveIndicesFrameStrideBytes,
      slotReuseEmitter.aliveCounts[frame],
    ),
  ]);
  const slotReuseLineage = [0, 1].map(
    (frame) =>
      new Uint32Array(
        slotReuseBakedCache.data,
        slotReuseEmitter.lineageOffsetBytes + frame * slotReuseEmitter.lineageFrameStrideBytes,
        slotReuseEmitter.capacity,
      )[0]!,
  );
  const slotReuseEndpoints = [0, 1].map((frame) => [
    ...new Float32Array(
      slotReuseBakedCache.data,
      slotReusePosition.offsetBytes + frame * slotReusePosition.frameStrideBytes,
      slotReusePosition.components,
    ),
  ]);
  const slotReuseEndpointDistance = Math.hypot(
    ...slotReuseEndpoints[0]!.map(
      (component, index) => component - (slotReuseEndpoints[1]![index] ?? 0),
    ),
  );
  const slotReuseCache =
    query.get('forceFailure') === 'lineage-alias'
      ? aliasSlotReuseLineage(slotReuseBakedCache)
      : slotReuseBakedCache;
  const slotReuseReplayCounter = countedRuntime(baseRuntime);
  const slotReusePlayer = await replaySimulation(
    new VFXSystem(slotReuseReplayCounter.runtime),
    slotReuseEffect,
    slotReuseCache,
    { interpolation: 'linear', spawn: { seed: 0x51_07 } },
  );
  const slotReuseView = view(slotReusePlayer.instance);
  const slotReuseScene = new THREE.Scene();
  const slotReuseMesh = materializeThreeSpriteDraw(slotReuseView.program, slotReuseView.kernels);
  slotReuseScene.add(slotReuseMesh);
  const slotReuseCamera = new THREE.OrthographicCamera(-1.2, 1.2, 0.75, -0.75, 0.1, 10);
  slotReuseCamera.position.z = 3;
  slotReuseCamera.updateProjectionMatrix();
  const slotReuseTarget = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  slotReuseTarget.texture.colorSpace = THREE.NoColorSpace;
  await slotReusePlayer.seek(0.25 / 10);
  const slotReuseMidpointSnapshot =
    await slotReusePlayer.instance.debug.captureAttributes('particles');
  const slotReuseMidpointPixels = await capture(
    renderer,
    slotReuseScene,
    slotReuseCamera,
    slotReuseTarget,
    true,
  );
  await slotReusePlayer.seek(0);
  const slotReuseNearestPixels = await capture(
    renderer,
    slotReuseScene,
    slotReuseCamera,
    slotReuseTarget,
    true,
  );
  const slotReusePixels = pixelDifference(slotReuseMidpointPixels, slotReuseNearestPixels);
  const slotReuseMidpointPosition = slotReuseMidpointSnapshot.rows[0]?.attributes.position;
  const slotReusePositionError = Array.isArray(slotReuseMidpointPosition)
    ? Math.max(
        ...slotReuseEndpoints[0]!.map((value, index) =>
          Math.abs(value - (slotReuseMidpointPosition[index] ?? Number.NaN)),
        ),
      )
    : Number.POSITIVE_INFINITY;
  const slotReuseCentroid = particleHorizontalCentroid(slotReuseMidpointPixels);
  slotReuseScene.remove(slotReuseMesh);
  slotReuseTarget.dispose();
  slotReusePlayer.release();

  const liveCounter = countedRuntime(baseRuntime);
  const liveSystem = new VFXSystem(liveCounter.runtime, undefined, {
    aliveCountReadbackInterval: 1,
  });
  const liveInstance = liveSystem.spawn(loopingEffect, spawn);
  await liveSystem.update(0);
  const comparisonFrame = 15;
  for (let frame = 0; frame < loopBakeOptions.sampleStartFrame + comparisonFrame; frame += 1) {
    await liveSystem.update(1 / FRAME_RATE);
  }
  const liveView = view(liveInstance);

  const replayCounter = countedRuntime(baseRuntime);
  const replaySystem = new VFXSystem(replayCounter.runtime);
  const player = await replaySimulation(replaySystem, loopingEffect, cache, {
    interpolation: 'linear',
    loop: true,
    spawn,
  });
  player.setTimeScale(2);
  player.play();
  await player.update(0.1);
  const scaledTime = player.localTime;
  player.stop();
  await player.update(0.2);
  const stoppedTime = player.localTime;
  await player.seek(player.duration - 0.05);
  player.play();
  await player.update(0.05);
  const loopedTime = player.localTime;
  player.stop();
  await player.seek(0.25);
  const immediateReplaySnapshot = await player.instance.debug.captureAttributes('particles');
  const replayView = view(player.instance);

  const camera = new THREE.OrthographicCamera(-1.2, 1.2, 0.75, -0.75, 0.1, 10);
  camera.position.z = 3;
  camera.updateProjectionMatrix();
  const liveScene = new THREE.Scene();
  const replayScene = new THREE.Scene();
  const liveMesh = materializeThreeSpriteDraw(liveView.program, liveView.kernels);
  const replayMesh = materializeThreeSpriteDraw(replayView.program, replayView.kernels);
  liveScene.add(liveMesh);
  replayScene.add(replayMesh);
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  const livePixels = await capture(renderer, liveScene, camera, target, true);
  const replayPixels = await capture(renderer, replayScene, camera, target, true);
  paint([livePixels, replayPixels]);
  const pixels = pixelDifference(livePixels, replayPixels);
  const liveAttributes = await readRenderAttributes(liveCounter.runtime, liveView);
  const replayAttributes = await readRenderAttributes(replayCounter.runtime, replayView);
  const attributes = attributeDifference(liveAttributes, replayAttributes);
  const visualAsymmetry = (() => {
    let left = 0;
    let right = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const brightness = livePixels[(y * WIDTH + x) * 4] ?? 0;
        if (x < WIDTH / 2) left += brightness;
        else right += brightness;
      }
    }
    return Math.abs(left - right) > 200;
  })();
  // The correctness renderer has completed both scene renders and readbacks before the separate
  // timestamp-enabled renderer is allowed to initialize.
  await capturePerformance();
  const validation = {
    attributeEquivalent: attributes.maximum <= 1e-6 && attributes.mismatchCount === 0,
    consoleClean: consoleMessages.length === 0,
    liveVsReplayPixelsLinearTolerance: pixels.maximumLinear <= 2 / 255 && pixels.changed === 0,
    loopContinuity:
      cache.metadata.loop.integerAttributesMatch &&
      cache.metadata.loop.lineageMatch &&
      cache.metadata.loop.continuous &&
      cache.metadata.loop.maximumAttributeError <= LOOP_TOLERANCE,
    memoryPublished: memory.totalBytes > memory.binaryBytes && memory.uploadBytesPerFrame > 0,
    nonMirrorAsset: visualAsymmetry,
    playbackControl:
      Math.abs(scaledTime - 0.2) < 1e-9 &&
      stoppedTime === scaledTime &&
      Math.abs(loopedTime - 0.05) < 1e-8,
    renderReadsOnly:
      cache.metadata.emitters[0]?.attributes.map(({ name }) => name).join(',') ===
      'color,position,size,spriteRotation',
    replayReadbackImmediatelyCoherent:
      immediateReplaySnapshot.aliveCount ===
      cache.metadata.emitters[0]?.aliveCounts[comparisonFrame],
    replaySimulationCostZero:
      replayCounter.counts.simulation === 0 && replayCounter.counts.indirect === 0,
    slotReuseBakedIdentity:
      slotReuseAlive[0]?.length === 1 &&
      slotReuseAlive[0]?.[0] === 0 &&
      slotReuseAlive[1]?.length === 1 &&
      slotReuseAlive[1]?.[0] === 0 &&
      slotReuseLineage[0] !== slotReuseLineage[1] &&
      slotReuseEndpointDistance > 0.01,
    slotReuseLineageNearest:
      slotReusePositionError <= 1e-6 &&
      slotReusePixels.changed === 0 &&
      slotReuseLineage[0] !== slotReuseLineage[1],
    sourceBackendRecorded: cache.metadata.sourceBackend === 'webgpu',
  };
  const result = {
    activeBackend,
    attributes,
    computeSubmissions: {
      bake: bakeCounter.counts,
      live: liveCounter.counts,
      replay: replayCounter.counts,
      slotReuseBake: slotReuseBakeCounter.counts,
      slotReuseReplay: slotReuseReplayCounter.counts,
    },
    loop: cache.metadata.loop,
    memory,
    ok: Object.values(validation).every(Boolean),
    pixels,
    playback: {
      absoluteComparisonFrame: loopBakeOptions.sampleStartFrame + comparisonFrame,
      loopedTime,
      scaledTime,
      stoppedTime,
    },
    replayReadback: {
      aliveCount: immediateReplaySnapshot.aliveCount,
      expectedAliveCount: cache.metadata.emitters[0]?.aliveCounts[comparisonFrame],
    },
    slotReuse: {
      alivePhysicalSlots: slotReuseAlive,
      endpointDistance: slotReuseEndpointDistance,
      endpoints: slotReuseEndpoints,
      lineage: slotReuseLineage,
      midpointCentroid: slotReuseCentroid,
      midpointPosition: slotReuseMidpointPosition,
      nearestPositionError: slotReusePositionError,
      pixels: slotReusePixels,
    },
    validation,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = 'complete';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'All checks passed'
    : 'Validation failed';
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false, requestedBackend });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = `Failed: ${message}`;
});
