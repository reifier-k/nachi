import {
  VFXSystem,
  VfxDiagnosticError,
  billboard,
  burst,
  colorOverLife,
  compileEmitter,
  decalRenderer,
  defineEffect,
  defineEmitter,
  gradient,
  lifetime,
  meshRenderer,
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
  createThreeEffectPreparer,
  createThreeRuntimeRenderer,
  disposeThreeDraw,
  materializeThreeDecalDraw,
  materializeThreeMeshDraw,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m10-sort.css';

const SIZE = 64;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const qualityQuery = query.get('quality');
const performanceQualityTier =
  qualityQuery === 'low' ||
  qualityQuery === 'medium' ||
  qualityQuery === 'high' ||
  qualityQuery === 'epic'
    ? qualityQuery
    : 'epic';
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
    const system = new VFXSystem(runtime, undefined, {
      aliveCountReadbackInterval: 1,
      maxPoolSize: 0,
    });
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
    const result = await readSort(view, viewMatrix);
    instance.release();
    return result;
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
  const sortedDrawSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
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
        render: billboard({
          blending: 'alpha',
          renderOrderOffset: 2,
          sortCenter: [0, 0, -1],
        }),
        quality: {
          low: { capacityScale: 1, spawnRateScale: 1 },
          medium: { capacityScale: 1, spawnRateScale: 1 },
        },
        spawn: burst({ count: 1 }),
        update: [colorOverLife(gradient([1, 0.03, 0.02, 0.68], [1, 0.03, 0.02, 0.68]))],
      }),
      near: defineEmitter({
        capacity: 1,
        init: [positionSphere({ radius: 0 }), lifetime(2)],
        integration: 'none',
        render: billboard({
          blending: 'alpha',
          renderOrderOffset: -1,
          sortCenter: [0, 0, 1],
        }),
        quality: {
          low: { capacityScale: 1, spawnRateScale: 1 },
          medium: { capacityScale: 1, spawnRateScale: 1 },
        },
        spawn: burst({ count: 1 }),
        update: [colorOverLife(gradient([0.02, 0.12, 1, 0.68], [0.02, 0.12, 1, 0.68]))],
      }),
    },
  });
  const alphaSystem = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    qualityTier: performanceQualityTier,
  });
  const alphaInstance = alphaSystem.spawn(alphaEffect, { seed: 3 });
  const alphaScene = new THREE.Scene();
  const alphaCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  alphaCamera.position.z = 4;
  alphaCamera.lookAt(0, 0, 0);
  const farView = emitter(alphaInstance, 'far');
  const nearView = emitter(alphaInstance, 'near');
  const farDraw = materializeThreeSpriteDraw(farView.program, farView.kernels, 0, {
    renderOrder: 998,
  });
  const nearDraw = materializeThreeSpriteDraw(nearView.program, nearView.kernels, 0, {
    renderOrder: 1_001,
  });
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
  const warningSystem = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    onRuntimeDiagnostic: null,
  });
  const warningInstance = warningSystem.spawn(alphaEffect);
  await warningSystem.update(0);
  const cameraWarning = warningInstance.diagnostics.some(
    ({ code }) => code === 'NACHI_ALPHA_SORT_CAMERA_UNSET',
  );

  const renderManifest = (
    name: string,
    render:
      | ReturnType<typeof billboard>
      | ReturnType<typeof meshRenderer>
      | ReturnType<typeof decalRenderer>,
  ) => {
    const program = compileEmitter(
      defineEmitter({
        capacity: 4,
        integration: 'none',
        render,
        spawn: burst({ count: 1 }),
      }),
    );
    const draw = program.draws[0];
    if (!draw || !('indirect' in draw)) throw new Error(`Missing renderer manifest ${name}.`);
    return {
      automatic: 'automaticRenderOrder' in draw && draw.automaticRenderOrder,
      moduleVersion: 'moduleVersion' in draw ? draw.moduleVersion : null,
      name,
      physicalIndex: draw.indirect.physicalIndex,
    };
  };
  const geometryRef = { assetType: 'geometry', kind: 'asset-ref', uri: 'm10-box' } as const;
  const defaultSortedManifests = [
    renderManifest('billboard-alpha', billboard({ blending: 'alpha' })),
    renderManifest('billboard-premultiplied', billboard({ blending: 'premultiplied' })),
    renderManifest('mesh-alpha', meshRenderer({ blending: 'alpha', geometry: geometryRef })),
    renderManifest(
      'mesh-premultiplied',
      meshRenderer({ blending: 'premultiplied', geometry: geometryRef }),
    ),
    renderManifest('decal-alpha', decalRenderer({ blending: 'alpha' })),
    renderManifest('decal-premultiplied', decalRenderer({ blending: 'premultiplied' })),
  ];
  const v1Billboard = billboard({ blending: 'alpha' });
  const v1Mesh = meshRenderer({ blending: 'alpha', geometry: geometryRef });
  const v1Decal = decalRenderer({ blending: 'alpha' });
  const legacyManifests = [
    renderManifest('billboard-v1-omitted', {
      ...v1Billboard,
      config: { blending: 'alpha' },
      version: 1,
    }),
    renderManifest('mesh-v1-omitted', {
      ...v1Mesh,
      config: { blending: 'alpha', geometry: geometryRef },
      version: 1,
    }),
    renderManifest('decal-v1-omitted', {
      ...v1Decal,
      config: { blending: 'alpha' },
      version: 1,
    }),
    renderManifest('billboard-v2-explicit-false', billboard({ blending: 'alpha', sorted: false })),
    renderManifest(
      'mesh-v2-explicit-false',
      meshRenderer({ blending: 'alpha', geometry: geometryRef, sorted: false }),
    ),
    renderManifest('decal-v2-explicit-false', decalRenderer({ blending: 'alpha', sorted: false })),
  ];
  const defaultSorted =
    defaultSortedManifests.every(({ physicalIndex }) => physicalIndex === 'sorted-indices') &&
    legacyManifests.every(({ physicalIndex }) => physicalIndex === 'alive-indices') &&
    query.get('forceFailure') !== 'default-unsorted';

  const depthGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const resolveGeometry = () => depthGeometry;
  const meshDepthManifest: Array<{
    readonly blending: string;
    readonly depthWrite: boolean;
    readonly version: number;
  }> = [];
  for (const blending of ['additive', 'alpha', 'multiply', 'premultiplied'] as const) {
    const current = meshRenderer({ blending, geometry: geometryRef, sorted: false });
    for (const version of [1, 2] as const) {
      const program = compileEmitter(
        defineEmitter({
          capacity: 1,
          render: version === 1 ? { ...current, version } : current,
          spawn: burst({ count: 1 }),
        }),
      );
      const kernels = program.buildKernels(adapter);
      const draw = materializeThreeMeshDraw(program, kernels, 0, { resolveGeometry });
      meshDepthManifest.push({ blending, depthWrite: draw.material.depthWrite, version });
      runtime.releaseKernels?.(kernels);
    }
  }
  const meshDepthWrite =
    meshDepthManifest.every(({ depthWrite, version }) => depthWrite === (version === 1)) &&
    query.get('forceFailure') !== 'mesh-depth-write';

  const meshDepthTarget = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  meshDepthTarget.texture.colorSpace = THREE.NoColorSpace;
  const meshDepthCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  meshDepthCamera.position.z = 3;
  meshDepthCamera.lookAt(0, 0, 0);
  const renderMeshDepthVersion = async (version: 1 | 2) => {
    const current = meshRenderer({
      blending: 'alpha',
      geometry: geometryRef,
      sorted: false,
    });
    const system = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
    system.setCamera(cameraState(meshDepthCamera));
    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 1,
            init: [
              tslModule(() => ({ color: vec4(1, 0, 0, 0.65) as never }), { stage: 'init' }),
              lifetime(1),
            ],
            integration: 'none',
            render: version === 1 ? { ...current, version } : current,
            spawn: burst({ count: 1 }),
          }),
        },
      }),
    );
    await system.update(0);
    const view = emitter(instance, 'particles');
    const particleGeometry = new THREE.PlaneGeometry(1.4, 1.4);
    const particle = materializeThreeMeshDraw(view.program, view.kernels, 0, {
      resolveGeometry: () => particleGeometry,
    });
    particleGeometry.dispose();
    particle.renderOrder = 1_000;
    const behind = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.4),
      new THREE.MeshBasicMaterial({
        color: 0x0011ff,
        depthTest: true,
        depthWrite: false,
        opacity: 0.7,
        transparent: true,
      }),
    );
    behind.position.z = -0.25;
    behind.renderOrder = 1_001;
    const scene = new THREE.Scene();
    scene.add(particle, behind);
    renderer.setRenderTarget(meshDepthTarget);
    renderer.clear();
    renderer.render(scene, meshDepthCamera);
    const pixels = await readTarget(renderer, meshDepthTarget, true);
    disposeThreeDraw(view.kernels, particle, renderer);
    behind.geometry.dispose();
    behind.material.dispose();
    instance.release();
    return [...pixels.slice(center, center + 4)];
  };
  const meshDepthPixels = {
    v1: await renderMeshDepthVersion(1),
    v2: await renderMeshDepthVersion(2),
  };
  const meshDepthPixelReadback =
    meshDepthPixels.v2[2]! > meshDepthPixels.v1[2]! + 20 &&
    meshDepthPixels.v1[0]! > meshDepthPixels.v1[2]!;

  const rankStep = 1 / 2 ** 20;
  const cameraARankComposition =
    cameraAOrders.far === 1_000 + rankStep && cameraAOrders.near === 1_000 + rankStep * 2;
  const cameraBRankComposition =
    cameraBOrders.far === 1_000 + rankStep * 2 && cameraBOrders.near === 1_000 + rankStep;
  farDraw.renderOrder = -100;
  alphaSystem.setCamera(cameraState(alphaCamera));
  const directMutationReapplied = farDraw.renderOrder === cameraBOrders.far;
  farDraw.setRenderOrderBase(997);
  const setterPersistent = farDraw.renderOrder === 999 + rankStep * 2;
  farDraw.setRenderOrderBase(998);
  const externalMaterial = new THREE.MeshBasicMaterial({
    color: 0x22ff33,
    depthTest: false,
    depthWrite: false,
    opacity: 0.8,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const externalPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), externalMaterial);
  alphaScene.add(externalPlane);
  externalPlane.renderOrder = 1_000;
  const externalAtBucket = await renderAlpha();
  externalPlane.renderOrder = 1_001;
  const externalAtNextBucket = await renderAlpha();
  alphaScene.remove(externalPlane);
  externalPlane.geometry.dispose();
  externalMaterial.dispose();
  const externalBucketPixelOrder = [0, 1, 2].some(
    (channel) =>
      Math.abs(externalAtBucket[center + channel]! - externalAtNextBucket[center + channel]!) > 2,
  );
  const rankComposition =
    cameraARankComposition &&
    cameraBRankComposition &&
    directMutationReapplied &&
    setterPersistent &&
    externalBucketPixelOrder &&
    1_000 < cameraAOrders.far &&
    cameraAOrders.near < 1_001 &&
    query.get('forceFailure') !== 'rank-overwrite';

  const depthTexture = new THREE.DataTexture(
    new Float32Array([0.5]),
    1,
    1,
    THREE.RedFormat,
    THREE.FloatType,
  );
  depthTexture.needsUpdate = true;
  const decalAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    sceneDepthTexture: depthTexture,
  });
  const decalRuntime = createThreeRuntimeRenderer(renderer, decalAdapter);
  const decalSystem = new VFXSystem(decalRuntime, undefined, { maxPoolSize: 0 });
  decalSystem.setCamera(cameraState(alphaCamera));
  const decalInstance = decalSystem.spawn(
    defineEffect({
      elements: {
        decal: defineEmitter({
          capacity: 1,
          init: [positionSphere({ center: [2, 0, 0], radius: 0 }), lifetime(1)],
          integration: 'none',
          render: decalRenderer({ sorted: false }),
          spawn: burst({ count: 1 }),
        }),
      },
    }),
    { position: [2, 2, 0], rotation: [0, 0, Math.PI / 2] },
  );
  await decalSystem.update(0);
  const decalView = emitter(decalInstance, 'decal');
  const readParticleAttribute = async (name: string, components: number) => {
    const attribute = decalView.program.attributeSchema.byName[name]!;
    const storageDescription =
      decalView.program.attributeSchema.storageArrays[attribute.physical.bufferIndex]!;
    const values = new Float32Array(
      await renderer.getArrayBufferAsync(
        decalView.kernels.storages[storageDescription.name]!.value as never,
      ),
    );
    if (!storageDescription.packed) {
      return Array.from({ length: components }, (_, component) => values[component]!);
    }
    const address = resolvePackedAttributeAddress(attribute, storageDescription);
    return Array.from(
      { length: components },
      (_, component) => values[packedComponentIndex(0, address, component)]!,
    );
  };
  const decalSpawnPosition = await readParticleAttribute('position', 3);
  const decalSpawnQuaternion = await readParticleAttribute('rotation', 4);
  const approximately = (left: readonly number[], right: readonly number[]) =>
    left.every((value, index) => Math.abs(value - right[index]!) < 1e-5);
  const decalSpawnRotation =
    approximately(decalSpawnPosition, [2, 4, 0]) &&
    approximately(decalSpawnQuaternion, [0, 0, Math.SQRT1_2, Math.SQRT1_2]) &&
    decalView.program.kernels.init.modules[1]?.type === 'core/decal-spawn-rotation' &&
    query.get('forceFailure') !== 'decal-no-spawn-rotation';

  const gpuSortProbe = async (
    name: string,
    render:
      | ReturnType<typeof billboard>
      | ReturnType<typeof meshRenderer>
      | ReturnType<typeof decalRenderer>,
    expectSorted: boolean,
  ) => {
    const system = new VFXSystem(name.startsWith('decal') ? decalRuntime : runtime, undefined, {
      maxPoolSize: 0,
    });
    const viewMatrix = new THREE.Matrix4().toArray();
    system.setCamera({
      projectionMatrix: new THREE.Matrix4().toArray(),
      viewMatrix,
      viewportSize: [SIZE, SIZE],
    });
    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: defineEmitter({
            capacity: 3,
            init: [
              tslModule(
                ({ spawnOrder }) => ({
                  position: vec3(0, 0, spawnOrder.toFloat().mul(0.6).sub(0.6) as never) as never,
                }),
                { stage: 'init' },
              ),
              lifetime(2),
            ],
            integration: 'none',
            render,
            spawn: burst({ count: 3 }),
          }),
        },
      }),
    );
    await system.update(0);
    const view = emitter(instance, 'particles');
    const kernels = view.kernels;
    if (expectSorted) {
      const sort = await readSort(view, viewMatrix);
      const result = {
        name,
        physicalIndex:
          view.program.draws[0] && 'indirect' in view.program.draws[0]
            ? view.program.draws[0].indirect.physicalIndex
            : 'missing',
        readback: sort.validIndices,
        valid: sort.validIndices.join(',') === '2,1,0' && isDepthMonotonic(sort),
      };
      instance.release();
      return result;
    }
    const state = new Uint32Array(
      await renderer.getArrayBufferAsync(kernels.aliveIndices.value as never),
    );
    const aliveCount = state[kernels.counterOffsets.aliveCount] ?? 0;
    const alive = Array.from(
      state.slice(kernels.aliveIndicesOffset, kernels.aliveIndicesOffset + aliveCount),
    );
    const result = {
      name,
      physicalIndex:
        view.program.draws[0] && 'indirect' in view.program.draws[0]
          ? view.program.draws[0].indirect.physicalIndex
          : 'missing',
      readback: alive,
      valid: alive.length === 3 && new Set(alive).size === 3,
    };
    instance.release();
    return result;
  };
  const omittedAndTrueGpuProbes = [];
  for (const blending of ['alpha', 'premultiplied'] as const) {
    for (const explicit of [false, true]) {
      const suffix = explicit ? 'explicit-true' : 'omitted';
      omittedAndTrueGpuProbes.push(
        await gpuSortProbe(
          `billboard-${blending}-${suffix}`,
          billboard({ blending, ...(explicit ? { sorted: true } : {}) }),
          true,
        ),
        await gpuSortProbe(
          `mesh-${blending}-${suffix}`,
          meshRenderer({
            blending,
            geometry: geometryRef,
            ...(explicit ? { sorted: true } : {}),
          }),
          true,
        ),
        await gpuSortProbe(
          `decal-${blending}-${suffix}`,
          decalRenderer({ blending, ...(explicit ? { sorted: true } : {}) }),
          true,
        ),
      );
    }
  }
  const aliveIndexGpuProbes = [
    await gpuSortProbe(
      'billboard-v1-alive',
      {
        ...v1Billboard,
        config: { blending: 'alpha' },
        version: 1,
      },
      false,
    ),
    await gpuSortProbe(
      'mesh-v1-alive',
      {
        ...v1Mesh,
        config: { blending: 'alpha', geometry: geometryRef },
        version: 1,
      },
      false,
    ),
    await gpuSortProbe(
      'decal-v1-alive',
      {
        ...v1Decal,
        config: { blending: 'alpha' },
        version: 1,
      },
      false,
    ),
    await gpuSortProbe('billboard-v2-false-alive', billboard({ sorted: false }), false),
    await gpuSortProbe(
      'mesh-v2-false-alive',
      meshRenderer({ geometry: geometryRef, sorted: false }),
      false,
    ),
    await gpuSortProbe('decal-v2-false-alive', decalRenderer({ sorted: false }), false),
  ];
  const rendererSortGpuReadback = [...omittedAndTrueGpuProbes, ...aliveIndexGpuProbes].every(
    ({ valid }) => valid,
  );

  const recycleSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
  const recycleViewMatrix = new THREE.Matrix4().toArray();
  recycleSystem.setCamera({
    projectionMatrix: new THREE.Matrix4().toArray(),
    viewMatrix: recycleViewMatrix,
    viewportSize: [SIZE, SIZE],
  });
  const recycleInstance = recycleSystem.spawn(
    defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 3,
          init: [
            tslModule(
              ({ spawnOrder }) => ({
                position: vec3(0, 0, spawnOrder.toFloat() as never) as never,
              }),
              { stage: 'init' },
            ),
            lifetime(10),
          ],
          integration: 'none',
          lifecycle: { duration: 0.3, loopCount: 2 },
          render: billboard({ sorted: false }),
          spawn: burst({ count: 3 }),
        }),
      },
    }),
  );
  const recycleView = emitter(recycleInstance, 'particles');
  const readAliveSpawnOrders = async () => {
    const kernels = recycleView.kernels;
    const state = new Uint32Array(
      await renderer.getArrayBufferAsync(kernels.aliveIndices.value as never),
    );
    const count = state[kernels.counterOffsets.aliveCount] ?? 0;
    const physical = Array.from(
      state.slice(kernels.aliveIndicesOffset, kernels.aliveIndicesOffset + count),
    );
    const spawnAttribute = recycleView.program.attributeSchema.byName.spawnOrder!;
    const spawnStorage =
      recycleView.program.attributeSchema.storageArrays[spawnAttribute.physical.bufferIndex]!;
    const spawnAddress = resolvePackedAttributeAddress(spawnAttribute, spawnStorage);
    const words = new Uint32Array(
      await renderer.getArrayBufferAsync(
        recycleView.kernels.storages[spawnStorage.name]!.value as never,
      ),
    );
    return physical.map((index) => words[packedComponentIndex(index, spawnAddress, 0)]!);
  };
  await recycleSystem.update(0);
  const lifetimeAttribute = recycleView.program.attributeSchema.byName.lifetime!;
  const lifetimeStorage =
    recycleView.program.attributeSchema.storageArrays[lifetimeAttribute.physical.bufferIndex]!;
  const lifetimeAddress = resolvePackedAttributeAddress(lifetimeAttribute, lifetimeStorage);
  const lifetimeBytes = new Uint8Array(
    await renderer.getArrayBufferAsync(
      recycleView.kernels.storages[lifetimeStorage.name]!.value as never,
    ),
  );
  new Float32Array(lifetimeBytes.buffer)[packedComponentIndex(1, lifetimeAddress, 0)] = 0.1;
  runtime.writeStorage?.(recycleView.kernels.storages[lifetimeStorage.name]!, lifetimeBytes);
  await runtime.flushStorageWrites?.();
  await recycleSystem.update(0.15);
  const afterDeathSpawnOrders = await readAliveSpawnOrders();
  await recycleSystem.update(0.16);
  await recycleSystem.update(0);
  const afterRecycleSpawnOrders = await readAliveSpawnOrders();
  const recycleSemanticOrder =
    afterDeathSpawnOrders.join(',') === '2,0' && afterRecycleSpawnOrders.join(',') === '2,3,0';
  recycleInstance.release();

  const decalCamera = new THREE.OrthographicCamera(-0.8, 3.2, 1, -1, 0.1, 10);
  decalCamera.position.z = 4;
  decalCamera.lookAt(0, 0, 0);
  const decalTarget = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  decalTarget.texture.colorSpace = THREE.NoColorSpace;
  const decalOverlapSystem = new VFXSystem(decalRuntime, undefined, { maxPoolSize: 0 });
  decalOverlapSystem.setCamera(cameraState(decalCamera));
  const decalOverlapInstance = decalOverlapSystem.spawn(
    defineEffect({
      elements: {
        decal: defineEmitter({
          capacity: 2,
          init: [
            tslModule(
              ({ spawnOrder }) => {
                const phase = spawnOrder.toFloat();
                return {
                  color: vec4(float(1).sub(phase as never), 0.05, phase as never, 0.65) as never,
                  position: vec3(0, 0, phase.mul(0.4).sub(0.2) as never) as never,
                  size: float(10) as never,
                };
              },
              { stage: 'init' },
            ),
            lifetime(2),
          ],
          integration: 'none',
          render: decalRenderer({ fadeOverLife: false }),
          spawn: burst({ count: 2 }),
        }),
      },
    }),
  );
  await decalOverlapSystem.update(0);
  const decalOverlapView = emitter(decalOverlapInstance, 'decal');
  const decalOverlapDraw = materializeThreeDecalDraw(
    decalOverlapView.program,
    decalOverlapView.kernels,
    0,
    { sceneDepthTexture: depthTexture },
  );
  const decalScene = new THREE.Scene();
  decalScene.add(decalOverlapDraw);
  const renderDecalOverlap = async () => {
    renderer.setRenderTarget(decalTarget);
    renderer.clear();
    renderer.render(decalScene, decalCamera);
    return readTarget(renderer, decalTarget, true);
  };
  const decalOverlapA = await renderDecalOverlap();
  decalCamera.position.z = -4;
  decalCamera.lookAt(0, 0, 0);
  decalOverlapSystem.setCamera(cameraState(decalCamera));
  await decalOverlapSystem.update(1 / 60);
  const decalOverlapB = await renderDecalOverlap();
  const decalOverlapSort =
    decalOverlapA[center + 3]! > 0 &&
    decalOverlapB[center + 3]! > 0 &&
    decalOverlapA[center + 2]! > decalOverlapA[center]! &&
    decalOverlapB[center]! > decalOverlapB[center + 2]!;

  const asymmetricMapRef = {
    assetType: 'texture',
    kind: 'asset-ref',
    uri: 'm10-asymmetric-decal',
  } as const;
  const asymmetricMap = new THREE.DataTexture(
    new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]),
    2,
    2,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  asymmetricMap.colorSpace = THREE.NoColorSpace;
  asymmetricMap.magFilter = THREE.NearestFilter;
  asymmetricMap.minFilter = THREE.NearestFilter;
  asymmetricMap.needsUpdate = true;
  decalCamera.position.z = 4;
  decalCamera.lookAt(0, 0, 0);
  const renderDecalOrientation = async (version: 1 | 2) => {
    const current = decalRenderer({
      fadeOverLife: false,
      map: asymmetricMapRef,
      sorted: false,
    });
    const render =
      version === 1
        ? {
            ...current,
            config: { blending: 'alpha', fadeOverLife: false, map: asymmetricMapRef },
            version,
          }
        : current;
    const system = new VFXSystem(decalRuntime, undefined, { maxPoolSize: 0 });
    system.setCamera(cameraState(decalCamera));
    const instance = system.spawn(
      defineEffect({
        elements: {
          decal: defineEmitter({
            capacity: 1,
            init: [
              tslModule(
                () => ({
                  color: vec4(1, 1, 1, 1) as never,
                  position: vec3(0, 0, 0) as never,
                  size: float(4) as never,
                }),
                { stage: 'init' },
              ),
              lifetime(2),
            ],
            integration: 'none',
            render,
            spawn: burst({ count: 1 }),
          }),
        },
      }),
      { rotation: [0, 0, Math.PI / 2] },
    );
    await system.update(0);
    const view = emitter(instance, 'decal');
    const draw = materializeThreeDecalDraw(view.program, view.kernels, 0, {
      resolveTexture: () => asymmetricMap,
      sceneDepthTexture: depthTexture,
    });
    const scene = new THREE.Scene();
    scene.add(draw);
    renderer.setRenderTarget(decalTarget);
    renderer.clear();
    renderer.render(scene, decalCamera);
    const pixels = await readTarget(renderer, decalTarget, true);
    const result = [
      [SIZE / 2, SIZE / 2],
      [SIZE / 2 + 10, SIZE / 2 - 8],
      [SIZE / 2 - 7, SIZE / 2 + 11],
    ].map(([x, y]) => {
      const offset = (y! * SIZE + x!) * 4;
      return [...pixels.slice(offset, offset + 4)];
    });
    disposeThreeDraw(view.kernels, draw, renderer);
    instance.release();
    return result;
  };
  const decalOrientationPixels = {
    v1: await renderDecalOrientation(1),
    v2: await renderDecalOrientation(2),
  };
  const decalAsymmetricProjection =
    decalOrientationPixels.v1.every((sample) => sample[3]! > 0) &&
    decalOrientationPixels.v2.every((sample) => sample[3]! > 0) &&
    decalOrientationPixels.v1.some((sample, sampleIndex) =>
      [0, 1, 2].some(
        (channel) =>
          Math.abs(sample[channel]! - decalOrientationPixels.v2[sampleIndex]![channel]!) > 40,
      ),
    );
  disposeThreeDraw(decalOverlapView.kernels, decalOverlapDraw, renderer);
  decalOverlapInstance.release();

  const pooledDefinition = defineEffect({
    elements: {
      particles: defineEmitter({
        capacity: 1,
        integration: 'none',
        render: billboard({ blending: 'alpha', sorted: false }),
        spawn: burst({ count: 0 }),
      }),
    },
  });
  const pooledSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 1 });
  pooledSystem.setCamera(cameraState(alphaCamera));
  const firstPooled = pooledSystem.spawn(pooledDefinition);
  const firstPooledView = emitter(firstPooled, 'particles');
  const pooledKernels = firstPooledView.kernels;
  const firstPooledDraw = materializeThreeSpriteDraw(firstPooledView.program, pooledKernels, 0, {
    renderOrder: 37,
  });
  await pooledSystem.update(0);
  const firstPooledRank = firstPooledDraw.renderOrder;
  firstPooled.release();
  const secondPooled = pooledSystem.spawn(pooledDefinition);
  const secondPooledView = emitter(secondPooled, 'particles');
  const secondPooledDraw = materializeThreeSpriteDraw(
    secondPooledView.program,
    secondPooledView.kernels,
    0,
    { renderOrder: 50 },
  );
  const poolBeforeUpdate = secondPooledDraw.renderOrder;
  await pooledSystem.update(0);
  const poolAfterUpdate = secondPooledDraw.renderOrder;
  const poolStaleOrder =
    firstPooledRank === 37 + rankStep &&
    secondPooledView.kernels === pooledKernels &&
    poolBeforeUpdate === 50 &&
    poolAfterUpdate === 50 + rankStep &&
    query.get('forceFailure') !== 'pool-stale-order';

  const lateSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
  const lateInstance = lateSystem.spawn(pooledDefinition);
  lateSystem.setCamera(cameraState(alphaCamera));
  const lateView = emitter(lateInstance, 'particles');
  const lateDraw = materializeThreeSpriteDraw(lateView.program, lateView.kernels, 0, {
    renderOrder: 44,
  });
  const materializeAfterRank = lateDraw.renderOrder === 44 + rankStep;

  const preparedScene = new THREE.Scene();
  const preparedTarget = new THREE.RenderTarget(1, 1);
  const preparer = createThreeEffectPreparer(renderer, preparedScene, alphaCamera, {
    compileTarget: preparedTarget,
    sprite: { renderOrder: 61 },
  });
  const preparedSystem = new VFXSystem(runtime, undefined, { maxPoolSize: 1 });
  await preparedSystem.prepare(pooledDefinition, { preparer });
  const preparedInstance = preparedSystem.spawn(pooledDefinition);
  const preparedView = emitter(preparedInstance, 'particles');
  preparedSystem.setCamera(cameraState(alphaCamera));
  const preparedDraw =
    preparer.takePreparedDraw<ReturnType<typeof materializeThreeSpriteDraw>>(preparedView);
  const retainedPreparedRank = preparedDraw?.renderOrder === 61 + rankStep;
  const materializationLifecycle =
    firstPooledRank === 37 + rankStep && materializeAfterRank && retainedPreparedRank;

  const qualityDefinitions = {
    billboard: sortedDefinition,
    decal: defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          integration: 'none',
          render: decalRenderer({}),
          spawn: burst({ count: 1 }),
        }),
      },
    }),
    mesh: defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          integration: 'none',
          render: meshRenderer({ geometry: geometryRef }),
          spawn: burst({ count: 1 }),
        }),
      },
    }),
  };
  const qualityManifests = Object.fromEntries(
    await Promise.all(
      Object.entries(qualityDefinitions).map(async ([rendererName, definition]) => {
        const tiers = Object.fromEntries(
          (['low', 'medium', 'high', 'epic'] as const).map((tier) => {
            const system = new VFXSystem(
              rendererName === 'decal' ? decalRuntime : runtime,
              undefined,
              { maxPoolSize: 0, qualityTier: tier },
            );
            const instance = system.spawn(definition);
            const draw = emitter(instance, 'particles').program.draws[0];
            const result = [
              tier,
              draw && 'indirect' in draw ? draw.indirect.physicalIndex : 'missing',
            ] as const;
            instance.release();
            return result;
          }),
        );
        return [rendererName, tiers];
      }),
    ),
  );
  const qualityBoundary = Object.values(qualityManifests).every((candidate) => {
    const manifest = candidate as Record<string, string>;
    return (
      manifest.low === 'alive-indices' &&
      manifest.medium === 'alive-indices' &&
      manifest.high === 'sorted-indices' &&
      manifest.epic === 'sorted-indices'
    );
  });
  const liveQualitySystem = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    onRuntimeDiagnostic: null,
    qualityTier: 'low',
  });
  const lowQualityInstance = liveQualitySystem.spawn(sortedDefinition);
  const compilationBeforeQualityChange = liveQualitySystem.compilationCount;
  liveQualitySystem.setQualityTier('high');
  const restartWarning = lowQualityInstance.diagnostics.some(
    ({ code }) => code === 'NACHI_QUALITY_RESTART_REQUIRED',
  );
  const compilationAfterQualityChange = liveQualitySystem.compilationCount;
  const highQualityInstance = liveQualitySystem.spawn(sortedDefinition);
  const highQualityDraw = emitter(highQualityInstance, 'particles').program.draws[0];
  const liveQualityRestartBoundary =
    restartWarning &&
    compilationBeforeQualityChange === 1 &&
    compilationAfterQualityChange === 1 &&
    liveQualitySystem.compilationCount === 2 &&
    highQualityDraw !== undefined &&
    'indirect' in highQualityDraw &&
    highQualityDraw.indirect.physicalIndex === 'sorted-indices';

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
  const defaultSortedValidation = defaultSorted && rendererSortGpuReadback && recycleSemanticOrder;
  const meshDepthValidation = meshDepthWrite && meshDepthPixelReadback;
  const decalValidation = decalSpawnRotation && decalOverlapSort && decalAsymmetricProjection;
  const poolLifecycleValidation = poolStaleOrder && materializationLifecycle;
  const qualityValidation = qualityBoundary && liveQualityRestartBoundary;

  decalInstance.release();
  warningInstance.release();
  disposeThreeDraw(sortedDrawView.kernels, sortedDraw, renderer);
  sortedDrawInstance.release();
  secondPooled.release();
  disposeThreeDraw(lateView.kernels, lateDraw, renderer);
  lateInstance.release();
  preparedInstance.release();
  preparer.dispose();
  lowQualityInstance.release();
  highQualityInstance.release();
  depthGeometry.dispose();
  for (const { draw, instance, view } of tieResources) {
    disposeThreeDraw(view.kernels, draw, renderer);
    instance.release();
  }
  renderer.setRenderTarget(target);
  await performanceMonitor.captureGpuSamples(async () => {
    await alphaSystem.update(1 / 60);
    renderer.render(alphaScene, alphaCamera);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  });
  disposeThreeDraw(farView.kernels, farDraw, renderer);
  disposeThreeDraw(nearView.kernels, nearDraw, renderer);
  alphaInstance.release();
  const validation = {
    cameraWarning,
    coarseReversal,
    consoleClean: consoleMessages.length === 0,
    cpuDepthMatch,
    decalSpawnRotation: decalValidation,
    defaultSorted: defaultSortedValidation,
    deterministic: JSON.stringify(firstSort.indices) === JSON.stringify(secondSort.indices),
    depthMonotonic,
    killMixed: firstSort.aliveCount > 0 && firstSort.aliveCount < 7,
    meshDepthWrite: meshDepthValidation,
    numericInstanceTieBreak,
    paddingBoundary: firstSort.padded === 8,
    poolStaleOrder: poolLifecycleValidation,
    qualityBoundary: qualityValidation,
    rankComposition,
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
    decalSpawn: {
      asymmetricProjectionPixels: decalOrientationPixels,
      overlapPixels: {
        cameraA: [...decalOverlapA.slice(center, center + 4)],
        cameraB: [...decalOverlapB.slice(center, center + 4)],
      },
      position: decalSpawnPosition,
      quaternion: decalSpawnQuaternion,
    },
    drawManifests: {
      defaultSorted: defaultSortedManifests,
      legacyAndExplicitFalse: legacyManifests,
      meshDepth: meshDepthManifest,
      quality: qualityManifests,
      rendererGpuReadback: {
        aliveIndices: aliveIndexGpuProbes,
        sortedIndices: omittedAndTrueGpuProbes,
      },
    },
    expectedRgb,
    firstSort,
    meshDepthPixels,
    numericInstanceTieBreak: { budgets: tieBudgets, renderOrders: tieRenderOrders },
    performanceQualityTier,
    poolOrder: {
      afterUpdate: poolAfterUpdate,
      beforeUpdate: poolBeforeUpdate,
      firstGeneration: firstPooledRank,
      reusedKernels: secondPooledView.kernels === pooledKernels,
      retainedPreparedRank,
      materializeAfterRank,
    },
    rankComposition: {
      cameraA: cameraAOrders,
      cameraB: cameraBOrders,
      directMutationReapplied,
      externalPixels: {
        bucket: [...externalAtBucket.slice(center, center + 4)],
        nextBucket: [...externalAtNextBucket.slice(center, center + 4)],
      },
      setterPersistent,
    },
    recycleOrder: { afterDeathSpawnOrders, afterRecycleSpawnOrders },
    qualityRestart: {
      compilationAfterQualityChange,
      compilationBeforeQualityChange,
      finalCompilationCount: liveQualitySystem.compilationCount,
      restartWarning,
    },
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
  meshDepthTarget.dispose();
  decalTarget.dispose();
  preparedTarget.dispose();
  depthTexture.dispose();
  asymmetricMap.dispose();
  oit.dispose();
  for (const plane of planes) {
    plane.geometry.dispose();
    plane.material.dispose();
  }
}

void run().catch((error) => {
  publishM10SortError(root, statusValue, error);
  console.error(error);
});
