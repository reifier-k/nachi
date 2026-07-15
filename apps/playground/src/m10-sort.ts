import {
  VFXSystem,
  VfxDiagnosticError,
  billboard,
  burst,
  colorOverLife,
  compileEmitter,
  defineEffect,
  defineEmitter,
  gradient,
  lifetime,
  packedComponentIndex,
  positionSphere,
  range,
  resolvePackedAttributeAddress,
  tslModule,
  type VfxEmitterRuntimeView,
} from '@nachi-vfx/core';
import { compositeWboitLayers, createWboitOutput, createWboitPipeline } from '@nachi-vfx/post';
import * as THREE from 'three/webgpu';
import { float, vec3, vec4 } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  publishM10SortError,
  publishM10SortValidation,
  validateSpawnOrderInitReadback,
} from './m10-sort-status';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  disposeThreeDraw,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m10-sort.css';

const SIZE = 64;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const backendValue = required<HTMLElement>('#backend-value');
const statusValue = required<HTMLElement>('#status-value');
const visual = required<HTMLCanvasElement>('#sort-visual');
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

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing M10 sort UI element ${selector}.`);
  return value;
}

function emitter(
  instance: { getEmitter(key: string): VfxEmitterRuntimeView | undefined },
  key: string,
) {
  const value = instance.getEmitter(key);
  if (!value) throw new Error(`Missing runtime emitter ${key}.`);
  return value;
}

function cameraState(camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  return {
    projectionMatrix: camera.projectionMatrix.toArray(),
    viewMatrix: camera.matrixWorldInverse.toArray(),
    viewportSize: [SIZE, SIZE] as const,
  };
}

async function readTarget(
  renderer: THREE.WebGPURenderer,
  target: THREE.RenderTarget,
  webgpu: boolean,
) {
  const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
  const dense = compactRgba8Readback(new Uint8Array(raw), SIZE, SIZE, webgpu);
  if (webgpu) return dense;
  const flipped = new Uint8Array(dense.length);
  for (let y = 0; y < SIZE; y += 1) {
    const stride = SIZE * 4;
    flipped.set(dense.subarray((SIZE - 1 - y) * stride, (SIZE - y) * stride), y * stride);
  }
  return flipped;
}

async function run(): Promise<void> {
  root.dataset.rendererStatus = 'initializing';
  root.dataset.spikeStatus = 'running';
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  await renderer.init();
  const webgpu = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backend = webgpu ? 'WebGPU' : 'WebGL2';
  backendValue.textContent = backend;
  root.dataset.backend = backend;
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: query.get('headless') === '1' ? 'headless' : 'visual',
    page: 'm10-sort',
  });

  if (!webgpu) {
    const sortDiagnosticCode = 'NACHI_PARTICLE_SORT_WEBGL2_UNSUPPORTED';
    const oitDiagnosticCode = 'NACHI_WBOIT_WEBGL2_UNSUPPORTED';
    const unsupported = defineEmitter({
      capacity: 4,
      init: [positionSphere({ radius: 0 }), lifetime(1)],
      integration: 'none',
      render: billboard({ blending: 'alpha', sorted: true }),
      spawn: burst({ count: 1 }),
    });
    let sortDiagnostic = false;
    try {
      compileEmitter(unsupported).buildKernels(createThreeKernelAdapter({ backend: 'webgl2' }));
    } catch (error) {
      sortDiagnostic =
        error instanceof VfxDiagnosticError &&
        error.diagnostics.some(({ code }) => code === sortDiagnosticCode);
    }
    let oitDiagnostic = false;
    try {
      createWboitPipeline(renderer, new THREE.Scene(), new THREE.Camera(), { backend: 'webgl2' });
    } catch (error) {
      oitDiagnostic = String(error).includes(oitDiagnosticCode);
    }
    const validation = {
      consoleClean: consoleMessages.length === 0,
      sortDiagnostic,
      wboitDiagnostic: oitDiagnostic,
    };
    const target = new THREE.RenderTarget(1, 1);
    renderer.setRenderTarget(target);
    await performanceMonitor.captureGpuSamples(async () => {
      renderer.render(new THREE.Scene(), new THREE.Camera());
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    });
    renderer.setRenderTarget(null);
    target.dispose();
    publishM10SortValidation(root, statusValue, validation, {
      backend,
      diagnostics: {
        particleSort: sortDiagnostic ? sortDiagnosticCode : null,
        wboit: oitDiagnostic ? oitDiagnosticCode : null,
      },
    });
    return;
  }

  const adapter = createThreeKernelAdapter({ backend: 'webgpu' });
  const runtime = createThreeRuntimeRenderer(renderer, adapter);
  const sortedDefinition = defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 7,
        init: [positionSphere({ radius: 3, surfaceOnly: false }), lifetime(range(0.2, 1))],
        integration: 'none',
        lifecycle: { duration: 1 },
        render: billboard({ blending: 'alpha', sorted: true }),
        spawn: burst({ count: 7 }),
      }),
    },
  });
  const readSort = async (view: VfxEmitterRuntimeView, viewMatrix: readonly number[]) => {
    const kernels = view.kernels;
    const state = new Uint32Array(
      await renderer.getArrayBufferAsync(kernels.aliveCount.value as never),
    );
    const aliveCount = state[kernels.counterOffsets.aliveCount] ?? 0;
    const padded = kernels.sortPaddedCapacity!;
    const depths = new Float32Array(
      await renderer.getArrayBufferAsync(kernels.sortedDepths!.value as never),
    );
    const indices = new Uint32Array(
      await renderer.getArrayBufferAsync(kernels.sortedIndices!.value as never),
    );
    const positionAttribute = view.program.attributeSchema.byName.position!;
    const positionStorage =
      view.program.attributeSchema.storageArrays[positionAttribute.physical.bufferIndex]!;
    const positions = new Float32Array(
      await renderer.getArrayBufferAsync(kernels.storages[positionStorage.name]!.value as never),
    );
    const address = resolvePackedAttributeAddress(positionAttribute, positionStorage);
    const validIndices = [...indices.slice(padded - aliveCount, padded)];
    const cpuDepths = validIndices.map((physical) => {
      const x = positions[packedComponentIndex(physical, address, 0)]!;
      const y = positions[packedComponentIndex(physical, address, 1)]!;
      const z = positions[packedComponentIndex(physical, address, 2)]!;
      return viewMatrix[2]! * x + viewMatrix[6]! * y + viewMatrix[10]! * z + viewMatrix[14]!;
    });
    return {
      aliveCount,
      cpuDepths,
      indices: [...indices],
      padded,
      sortedDepths: [...depths.slice(padded - aliveCount, padded)],
      validIndices,
    };
  };
  const isDepthMonotonic = (sort: Awaited<ReturnType<typeof readSort>>) =>
    sort.sortedDepths.every((value, index, values) => index === 0 || values[index - 1]! <= value);
  const matchesCpuDepth = (sort: Awaited<ReturnType<typeof readSort>>) =>
    sort.sortedDepths.every((value, index) => Math.abs(value - sort.cpuDepths[index]!) < 1e-5);
  const executeSort = async () => {
    const system = new VFXSystem(runtime, undefined, { aliveCountReadbackInterval: 1 });
    const viewMatrix = new THREE.Matrix4().toArray();
    system.setCamera({
      projectionMatrix: new THREE.Matrix4().toArray(),
      viewMatrix,
      viewportSize: [SIZE, SIZE],
    });
    const instance = system.spawn(sortedDefinition, { seed: 0x5a17 });
    await system.update(0);
    await system.update(0.55);
    const view = emitter(instance, 'particles');
    return readSort(view, viewMatrix);
  };
  const firstSort = await executeSort();
  const secondSort = await executeSort();
  const center = ((SIZE / 2) * SIZE + SIZE / 2) * 4;

  const sortedDrawEffect = defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 3,
        init: [
          tslModule(
            ({ spawnOrder }) => {
              // spawnOrder is u32-backed. Convert before fractional arithmetic; otherwise Three
              // rounds 0.6 to 1u and spawnOrder 0/1 underflow to 0xffffffff at the subtraction.
              const phase = spawnOrder.toFloat().div(2);
              return {
                color: vec4(float(1).sub(phase as never), 0.05, phase as never, 0.62) as never,
                position: vec3(0, 0, phase.mul(1.2).sub(0.6) as never) as never,
              };
            },
            { stage: 'init' },
          ),
          lifetime(2),
        ],
        integration: 'none',
        render: billboard({ blending: 'alpha', sorted: true }),
        spawn: burst({ count: 3 }),
      }),
    },
  });
  const sortedDrawSystem = new VFXSystem(runtime);
  const sortedDrawInstance = sortedDrawSystem.spawn(sortedDrawEffect, { seed: 0x5017 });
  const sortedDrawView = emitter(sortedDrawInstance, 'particles');
  const sortedDraw = materializeThreeSpriteDraw(sortedDrawView.program, sortedDrawView.kernels);
  const sortedDrawScene = new THREE.Scene();
  sortedDrawScene.add(sortedDraw);
  const sortedDrawCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  const sortedDrawTarget = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  sortedDrawTarget.texture.colorSpace = THREE.NoColorSpace;
  const renderSortedDraw = async () => {
    renderer.setRenderTarget(sortedDrawTarget);
    renderer.clear();
    renderer.render(sortedDrawScene, sortedDrawCamera);
    return readTarget(renderer, sortedDrawTarget, true);
  };
  sortedDrawCamera.position.z = 4;
  sortedDrawCamera.lookAt(0, 0, 0);
  sortedDrawSystem.setCamera(cameraState(sortedDrawCamera));
  await sortedDrawSystem.update(0);
  const spawnOrderAttribute = sortedDrawView.program.attributeSchema.byName.spawnOrder!;
  const spawnOrderStorage =
    sortedDrawView.program.attributeSchema.storageArrays[spawnOrderAttribute.physical.bufferIndex]!;
  const spawnOrderAddress = resolvePackedAttributeAddress(spawnOrderAttribute, spawnOrderStorage);
  const spawnOrderWords = new Uint32Array(
    await renderer.getArrayBufferAsync(
      sortedDrawView.kernels.storages[spawnOrderStorage.name]!.value as never,
    ),
  );
  const positionAttribute = sortedDrawView.program.attributeSchema.byName.position!;
  const positionStorage =
    sortedDrawView.program.attributeSchema.storageArrays[positionAttribute.physical.bufferIndex]!;
  const positionAddress = resolvePackedAttributeAddress(positionAttribute, positionStorage);
  const positionWords = new Float32Array(
    await renderer.getArrayBufferAsync(
      sortedDrawView.kernels.storages[positionStorage.name]!.value as never,
    ),
  );
  const spawnOrders = Array.from(
    { length: 3 },
    (_, physicalIndex) =>
      spawnOrderWords[packedComponentIndex(physicalIndex, spawnOrderAddress, 0)]!,
  );
  const spawnOrderPositionZ = Array.from(
    { length: 3 },
    (_, physicalIndex) => positionWords[packedComponentIndex(physicalIndex, positionAddress, 2)]!,
  );
  const spawnOrderInitReadback = validateSpawnOrderInitReadback(spawnOrders, spawnOrderPositionZ);
  const sortedCameraASort = await readSort(
    sortedDrawView,
    sortedDrawCamera.matrixWorldInverse.toArray(),
  );
  const sortedCameraA = await renderSortedDraw();
  sortedDrawCamera.position.z = -4;
  sortedDrawCamera.lookAt(0, 0, 0);
  sortedDrawSystem.setCamera(cameraState(sortedDrawCamera));
  // A zero-delta active update submits no compaction/sort work, so advance one static frame to
  // rebuild the sorted indirection buffer with cameraB's view matrix.
  await sortedDrawSystem.update(1 / 60);
  const sortedCameraBSort = await readSort(
    sortedDrawView,
    sortedDrawCamera.matrixWorldInverse.toArray(),
  );
  const sortedCameraB = await renderSortedDraw();
  const depthMonotonic = [firstSort, sortedCameraASort, sortedCameraBSort].every(isDepthMonotonic);
  const cpuDepthMatch = [firstSort, sortedCameraASort, sortedCameraBSort].every(matchesCpuDepth);
  const sortedDrawReversal =
    sortedCameraA[center + 2]! > sortedCameraA[center]! &&
    sortedCameraB[center]! > sortedCameraB[center + 2]! &&
    query.get('forceFailure') !== 'sortedDrawReversal';

  const alphaEffect = defineEffect({
    elements: {
      far: defineEmitter({
        capacity: 1,
        init: [positionSphere({ radius: 0 }), lifetime(2)],
        integration: 'none',
        render: billboard({ blending: 'alpha', sortCenter: [0, 0, -1] }),
        spawn: burst({ count: 1 }),
        update: [colorOverLife(gradient([1, 0.03, 0.02, 0.68], [1, 0.03, 0.02, 0.68]))],
      }),
      near: defineEmitter({
        capacity: 1,
        init: [positionSphere({ radius: 0 }), lifetime(2)],
        integration: 'none',
        render: billboard({ blending: 'alpha', sortCenter: [0, 0, 1] }),
        spawn: burst({ count: 1 }),
        update: [colorOverLife(gradient([0.02, 0.12, 1, 0.68], [0.02, 0.12, 1, 0.68]))],
      }),
    },
  });
  const alphaSystem = new VFXSystem(runtime);
  const alphaInstance = alphaSystem.spawn(alphaEffect, { seed: 3 });
  const alphaScene = new THREE.Scene();
  const alphaCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  alphaCamera.position.z = 4;
  alphaCamera.lookAt(0, 0, 0);
  const farView = emitter(alphaInstance, 'far');
  const nearView = emitter(alphaInstance, 'near');
  const farDraw = materializeThreeSpriteDraw(farView.program, farView.kernels);
  const nearDraw = materializeThreeSpriteDraw(nearView.program, nearView.kernels);
  alphaScene.add(farDraw, nearDraw);
  const target = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  const renderAlpha = async () => {
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(alphaScene, alphaCamera);
    return readTarget(renderer, target, true);
  };
  alphaSystem.setCamera(cameraState(alphaCamera));
  // Activation at dt=0 only runs init/spawn. Advance once so colorOverLife writes the authored
  // red/blue colors before using the readback to distinguish emitter render order.
  await alphaSystem.update(1 / 60);
  const cameraA = await renderAlpha();
  const cameraAOrders = { far: farDraw.renderOrder, near: nearDraw.renderOrder };
  alphaCamera.position.z = -4;
  alphaCamera.lookAt(0, 0, 0);
  alphaSystem.setCamera(cameraState(alphaCamera));
  const cameraB = await renderAlpha();
  const cameraBOrders = { far: farDraw.renderOrder, near: nearDraw.renderOrder };
  const coarseReversal =
    cameraA[center + 2]! > cameraA[center]! &&
    cameraB[center]! > cameraB[center + 2]! &&
    query.get('forceFailure') !== 'coarseReversal';
  const warningSystem = new VFXSystem(runtime);
  const warningInstance = warningSystem.spawn(alphaEffect);
  await warningSystem.update(0);
  const cameraWarning = warningInstance.diagnostics.some(
    ({ code }) => code === 'NACHI_ALPHA_SORT_CAMERA_UNSET',
  );

  const tieEmitter = defineEmitter({
    bounds: { radius: 0.1 },
    capacity: 1,
    integration: 'none',
    render: billboard({ blending: 'alpha' }),
    spawn: burst({ count: 0 }),
  });
  const tieEffect = defineEffect({ elements: { particles: tieEmitter } });
  const tieSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
  tieSystem.setCamera(cameraState(alphaCamera));
  const tieDraws = new Map<number, ReturnType<typeof materializeThreeSpriteDraw>>();
  const tieResources: Array<{
    readonly draw: ReturnType<typeof materializeThreeSpriteDraw>;
    readonly instance: { release(): void };
    readonly view: VfxEmitterRuntimeView;
  }> = [];
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    const tied = tieSystem.spawn(tieEffect);
    if ([9, 10, 99, 100].includes(sequence)) {
      const view = emitter(tied, 'particles');
      const draw = materializeThreeSpriteDraw(view.program, view.kernels);
      tieDraws.set(sequence, draw);
      tieResources.push({ draw, instance: tied, view });
    } else tied.release();
  }
  tieSystem.setCamera(cameraState(alphaCamera));
  const tieRenderOrders = Object.fromEntries(
    [...tieDraws].map(([sequence, draw]) => [sequence, draw.renderOrder]),
  );

  const budgetProbe = async (boundary: 10 | 100, budget: 'instance' | 'particle') => {
    const system = new VFXSystem(runtime, undefined, {
      maxPoolSize: 0,
      significanceBudget:
        budget === 'instance'
          ? { maxActiveInstances: 1, maxParticles: 2 }
          : { maxActiveInstances: 2, maxParticles: 1 },
    });
    system.setCamera(cameraState(alphaCamera));
    const definition = defineEffect({
      elements: { particles: tieEmitter },
      scalability: {
        culling: { distance: { fadeEnd: 6, fadeStart: 5 }, frustum: false },
      },
    });
    for (let sequence = 1; sequence < boundary - 1; sequence += 1) {
      system.spawn(definition, { position: [10, 0, 0] }).release();
    }
    const earlier = system.spawn(definition, { position: [10, 0, 0] });
    const later = system.spawn(definition, { position: [10, 0, 0] });
    earlier.setTransform([0, 0, 0]);
    later.setTransform([0, 0, 0]);
    await system.update(0);
    const result = {
      earlier: { action: earlier.scalability.action, id: earlier.id },
      later: { action: later.scalability.action, id: later.id },
    };
    earlier.release();
    later.release();
    return result;
  };
  const tieBudgets = {
    digit10: await budgetProbe(10, 'instance'),
    digit100: await budgetProbe(100, 'particle'),
  };
  const numericInstanceTieBreak =
    tieRenderOrders[9]! < tieRenderOrders[10]! &&
    tieRenderOrders[99]! < tieRenderOrders[100]! &&
    tieBudgets.digit10.earlier.action === 'full' &&
    tieBudgets.digit10.later.action === 'culled' &&
    tieBudgets.digit100.earlier.action === 'full' &&
    tieBudgets.digit100.later.action === 'spawn-suppressed';

  const oitScene = new THREE.Scene();
  const oitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  oitCamera.position.z = 3;
  const layers = [
    { alpha: 0.35, color: [0.9, 0.15, 0.05] as const, depth: 0.23 },
    { alpha: 0.6, color: [0.05, 0.2, 0.85] as const, depth: 0.71 },
  ];
  const planes = layers.map((layer, index) => {
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.mrtNode = createWboitOutput(
      vec3(...layer.color),
      float(layer.alpha),
      float(layer.depth),
    );
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), material);
    mesh.position.z = index === 0 ? 0.2 : -0.2;
    mesh.renderOrder = index;
    oitScene.add(mesh);
    return mesh;
  });
  const oit = createWboitPipeline(renderer, oitScene, oitCamera, {
    backend: 'webgpu',
    width: SIZE,
    height: SIZE,
  });
  const renderOit = async () => {
    renderer.setRenderTarget(target);
    renderer.clear();
    oit.render(target);
    return readTarget(renderer, target, true);
  };
  const oitForward = await renderOit();
  planes[0]!.renderOrder = 1;
  planes[1]!.renderOrder = 0;
  const oitReverse = await renderOit();
  const expected = compositeWboitLayers(layers);
  const expectedRgb = expected.color
    .slice(0, 3)
    .map((value) => Math.round(value * expected.color[3] * 255));
  const oitNumeric = expectedRgb.every(
    (value, channel) => Math.abs(oitForward[center + channel]! - value) <= 8,
  );
  const oitInvariant = [0, 1, 2, 3].every(
    (channel) => Math.abs(oitForward[center + channel]! - oitReverse[center + channel]!) <= 2,
  );

  const context = visual.getContext('2d')!;
  [sortedCameraA, sortedCameraB, oitForward].forEach((pixels, index) => {
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), SIZE, SIZE), index * SIZE, 0);
  });
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm10-sort.png', selector: '#sort-visual' },
  ]);
  renderer.setRenderTarget(target);
  await performanceMonitor.captureGpuSamples(async () => {
    await alphaSystem.update(1 / 60);
    renderer.render(alphaScene, alphaCamera);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  });
  const validation = {
    cameraWarning,
    coarseReversal,
    consoleClean: consoleMessages.length === 0,
    cpuDepthMatch,
    deterministic: JSON.stringify(firstSort.indices) === JSON.stringify(secondSort.indices),
    depthMonotonic,
    killMixed: firstSort.aliveCount > 0 && firstSort.aliveCount < 7,
    numericInstanceTieBreak,
    paddingBoundary: firstSort.padded === 8,
    spawnOrderInitReadback,
    sortedDrawReversal,
    wboitInvariant: oitInvariant,
    wboitNumeric: oitNumeric,
  };
  publishM10SortValidation(root, statusValue, validation, {
    alphaReadback: {
      cameraA: [...cameraA.slice(center, center + 4)],
      cameraB: [...cameraB.slice(center, center + 4)],
      renderOrders: { cameraA: cameraAOrders, cameraB: cameraBOrders },
      thresholdSpace: 'linear working space',
    },
    backend,
    expectedRgb,
    firstSort,
    numericInstanceTieBreak: { budgets: tieBudgets, renderOrders: tieRenderOrders },
    sortedDrawReadback: {
      cameraA: [...sortedCameraA.slice(center, center + 4)],
      cameraB: [...sortedCameraB.slice(center, center + 4)],
      sorts: { cameraA: sortedCameraASort, cameraB: sortedCameraBSort },
      thresholdSpace: 'linear working space',
    },
    spawnOrderInitReadback: { positionZ: spawnOrderPositionZ, spawnOrders },
  });
  target.dispose();
  sortedDrawTarget.dispose();
  oit.dispose();
  for (const { draw, instance, view } of tieResources) {
    disposeThreeDraw(view.kernels, draw, renderer);
    instance.release();
  }
}

void run().catch((error) => {
  publishM10SortError(root, statusValue, error);
  console.error(error);
});
