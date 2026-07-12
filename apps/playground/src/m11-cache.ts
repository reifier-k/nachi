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
} from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from './three-kernel-adapter';
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

function readCachedRenderAttributes(cache: SimulationCache, frame: number) {
  const emitter = cache.metadata.emitters[0];
  if (!emitter) throw new Error('M11 cache metadata has no emitter.');
  return Object.fromEntries(
    emitter.attributes.map((attribute) => {
      const length = emitter.capacity * attribute.components;
      const offset = attribute.offsetBytes + frame * attribute.frameStrideBytes;
      if (attribute.encoding === 'float32') {
        return [attribute.name, [...new Float32Array(cache.data, offset, length)]] as const;
      }
      if (attribute.encoding === 'int32') {
        return [attribute.name, [...new Int32Array(cache.data, offset, length)]] as const;
      }
      if (attribute.encoding === 'uint32') {
        return [attribute.name, [...new Uint32Array(cache.data, offset, length)]] as const;
      }
      const encoded = new Uint16Array(cache.data, offset, length);
      const range = attribute.quantization!;
      return [
        attribute.name,
        [...encoded].map((value, index) => {
          const component = index % attribute.components;
          const minimum = range.minimum[component]!;
          return minimum + (value / 65535) * (range.maximum[component]! - minimum);
        }),
      ] as const;
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
  if (webgpu) {
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
        init: [positionSphere({ radius: 0 }), lifetime(0.5)],
        lifecycle: { duration: 1, loopCount: 'infinite' },
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 9 }),
        update: [sizeOverLife(curve([0, 0.11], [0.25, 0.19], [0.5, 0.11], [1, 0.11]))],
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
    const performanceSystem = new VFXSystem(performanceRuntime);
    performanceSystem.spawn(singleShotEffect, spawn);
    await performanceSystem.update(0);
    await performanceSystem.update(1 / FRAME_RATE);
    const performanceTarget = new THREE.RenderTarget(1, 1);
    performanceRenderer.setRenderTarget(performanceTarget);
    performanceRenderer.render(
      new THREE.Scene(),
      new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10),
    );
    await performanceRenderer.readRenderTargetPixelsAsync(performanceTarget, 0, 0, 1, 1);
    performanceRenderer.setRenderTarget(null);
    performanceTarget.dispose();
    await monitor.resolveGpuTimestamps();
    monitor.publish();
  };
  const loopBakeOptions = {
    compression: 'float32',
    frameRate: FRAME_RATE,
    frames: LOOP_FRAMES + 1,
    interpolation: 'linear',
    loop: true,
    // This only covers ordinary f32 backend variation; the former 0.8896 phase error is far too
    // large to pass. The fixture itself is structurally periodic: 0.5 s lifetime, 1 s emission
    // period, and a complete 1 s warmup before recording the duplicated endpoint window [1, 2].
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
    const bakeCounter = countedRuntime(baseRuntime);
    const bakeSystem = new VFXSystem(bakeCounter.runtime, undefined, {
      aliveCountReadbackInterval: 1,
    });
    const cache = await bakeSimulation(bakeSystem, singleShotEffect, singleShotBakeOptions);
    const comparisonFrame = 15;
    const liveCounter = countedRuntime(baseRuntime);
    const liveSystem = new VFXSystem(liveCounter.runtime, undefined, {
      aliveCountReadbackInterval: 1,
    });
    const liveInstance = liveSystem.spawn(singleShotEffect, spawn);
    await liveSystem.update(0);
    for (let frame = 0; frame < comparisonFrame; frame += 1) {
      await liveSystem.update(1 / FRAME_RATE);
    }
    const liveAttributes = await readRenderAttributes(liveCounter.runtime, view(liveInstance));
    const bakedAttributes = readCachedRenderAttributes(cache, comparisonFrame);
    const attributes = attributeDifference(bakedAttributes, liveAttributes);
    liveInstance.release();
    let diagnosticCode = '';
    try {
      await replaySimulation(new VFXSystem(baseRuntime), singleShotEffect, cache);
    } catch (error) {
      if (error instanceof VfxDiagnosticError) diagnosticCode = error.diagnostics[0]?.code ?? '';
      else throw error;
    }
    const memory = estimateSimulationCacheMemory(cache);
    root.dataset.cacheMemory = JSON.stringify(memory);
    required<HTMLElement>('#memory-value').textContent = `${memory.totalBytes} bytes`;
    await capturePerformance();
    const validation = {
      bakeReadback:
        cache.metadata.frameCount === LOOP_FRAMES + 1 &&
        cache.metadata.sampleStartFrame === 0 &&
        cache.metadata.sourceBackend === 'webgl2' &&
        !cache.metadata.loop.enabled &&
        cache.data.byteLength > 0,
      bakedVsLiveAttributes: attributes.maximum <= 1e-6 && attributes.mismatchCount === 0,
      consoleClean: consoleMessages.length === 0,
      explicitReplayDiagnostic: diagnosticCode === 'NACHI_SIM_CACHE_REPLAY_WEBGL2_UNSUPPORTED',
      renderReadsOnly:
        cache.metadata.emitters[0]?.attributes.map(({ name }) => name).join(',') ===
        'color,position,size,spriteRotation',
    };
    const result = {
      activeBackend,
      attributes,
      capability: { bake: 'supported', replay: 'diagnosed-unsupported', diagnosticCode },
      computeSubmissions: { bake: bakeCounter.counts, live: liveCounter.counts },
      constraints: {
        loopingBurstEmission: {
          reason:
            'Looping burst emission is unsupported on WebGL2 because prefix spawning would overwrite the same particle prefix on each loop.',
          supported: false,
        },
      },
      fixture: {
        comparisonFrame,
        emission: 'single-shot-burst',
        loopContinuityChecked: false,
      },
      loop: cache.metadata.loop,
      memory,
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
      cache.metadata.loop.aliveIndicesMatch &&
      cache.metadata.loop.integerAttributesMatch &&
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
    sourceBackendRecorded: cache.metadata.sourceBackend === 'webgpu',
  };
  const result = {
    activeBackend,
    attributes,
    computeSubmissions: {
      bake: bakeCounter.counts,
      live: liveCounter.counts,
      replay: replayCounter.counts,
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
