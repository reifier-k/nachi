import {
  VFXSystem,
  billboard,
  burst,
  colorOverLife,
  curve,
  defineEffect,
  defineEmitter,
  drag,
  gradient,
  lifetime,
  positionMeshSurface,
  positionSphere,
  rate,
  sizeOverLife,
  velocityCone,
  velocityMeshNormal,
  vortex,
} from '@nachi/core';
import type { VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { createPerformanceMonitor } from './perf';
import {
  createThreeKernelAdapter,
  createThreeMeshSurfaceResolver,
  createThreeMeshSurfaceResource,
  createThreeRuntimeRenderer,
  createThreeTransformSource,
  materializeThreeSpriteDraw,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './golden-character.css';

const STEP = 1 / 30;
const WIDTH = 640;
const HEIGHT = 640;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const backendValue = requireElement<HTMLElement>('#backend-value');
const modeValue = requireElement<HTMLElement>('#mode-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const consoleMessages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  consoleMessages.push(`warning: ${values.map(String).join(' ')}`);
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  consoleMessages.push(`error: ${values.map(String).join(' ')}`);
  originalError(...values);
};

type BackendLike = {
  device?: {
    features?: { has(name: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

type RuntimeInstance = {
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  attachTo(source: ReturnType<typeof createThreeTransformSource>): void;
};

root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing golden character element: ${selector}`);
  return element;
}

function emitter(instance: RuntimeInstance, key: string): VfxEmitterRuntimeView {
  const value = instance.getEmitter(key);
  if (!value) throw new Error(`Golden character emitter "${key}" is missing.`);
  return value;
}

function bytesEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return a.every((value, index) => value === b[index]);
}

function paintReadback(canvas: HTMLCanvasElement, pixels: ArrayLike<number>): number {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Golden character preview canvas has no 2D context.');
  const image = context.createImageData(WIDTH, HEIGHT);
  const background = [pixels[0] ?? 0, pixels[1] ?? 0, pixels[2] ?? 0] as const;
  let foregroundPixels = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    const sourceY = HEIGHT - 1 - y;
    for (let x = 0; x < WIDTH; x += 1) {
      const source = (sourceY * WIDTH + x) * 4;
      const target = (y * WIDTH + x) * 4;
      image.data[target] = pixels[source] ?? 0;
      image.data[target + 1] = pixels[source + 1] ?? 0;
      image.data[target + 2] = pixels[source + 2] ?? 0;
      image.data[target + 3] = pixels[source + 3] ?? 255;
      const difference =
        Math.abs((pixels[source] ?? 0) - background[0]) +
        Math.abs((pixels[source + 1] ?? 0) - background[1]) +
        Math.abs((pixels[source + 2] ?? 0) - background[2]);
      if (difference > 12) foregroundPixels += 1;
    }
  }
  context.putImageData(image, 0, 0);
  return foregroundPixels / (WIDTH * HEIGHT);
}

function buildCharacter() {
  const body = new THREE.CapsuleGeometry(0.52, 1.2, 6, 14);
  body.translate(0, 0.1, 0);
  const head = new THREE.SphereGeometry(0.43, 14, 10);
  head.translate(0, 1.25, 0);
  const geometry = mergeGeometries([body, head], false);
  if (!geometry) throw new Error('Failed to merge procedural character geometry.');
  const positions = geometry.getAttribute('position');
  const skinIndices = new Uint16Array(positions.count * 4);
  const skinWeights = new Float32Array(positions.count * 4);
  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    const upper = positions.getY(vertex) > 0.45;
    skinIndices[vertex * 4] = upper ? 1 : 0;
    skinWeights[vertex * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  const lowerBone = new THREE.Bone();
  lowerBone.name = 'lower';
  lowerBone.position.y = -0.55;
  const upperBone = new THREE.Bone();
  upperBone.name = 'upper';
  upperBone.position.y = 1.05;
  lowerBone.add(upperBone);
  const footSocket = new THREE.Object3D();
  footSocket.name = 'foot-socket';
  footSocket.position.set(0, -0.55, 0);
  lowerBone.add(footSocket);
  const material = new THREE.MeshStandardMaterial({
    color: 0x173a52,
    metalness: 0.2,
    roughness: 0.48,
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(lowerBone);
  mesh.bind(new THREE.Skeleton([lowerBone, upperBone]));
  mesh.updateMatrixWorld(true);
  return { footSocket, lowerBone, mesh, upperBone };
}

function maximumNearestVertexDistance(
  points: Float32Array,
  surfacePositions: Float32Array,
): number {
  let maximum = 0;
  for (let point = 0; point < points.length / 3; point += 1) {
    let nearest = Infinity;
    for (let vertex = 0; vertex < surfacePositions.length / 4; vertex += 1) {
      nearest = Math.min(
        nearest,
        Math.hypot(
          (points[point * 3] ?? 0) - (surfacePositions[vertex * 4] ?? 0),
          (points[point * 3 + 1] ?? 0) - (surfacePositions[vertex * 4 + 1] ?? 0),
          (points[point * 3 + 2] ?? 0) - (surfacePositions[vertex * 4 + 2] ?? 0),
        ),
      );
    }
    maximum = Math.max(maximum, nearest);
  }
  return maximum;
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: true, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Golden character requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Deterministic capture' : 'Character preview';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const character = buildCharacter();
  const meshRef = {
    assetType: 'mesh',
    kind: 'asset-ref',
    uri: 'procedural://golden-character/skinned-body',
  } as const;
  const surfaceResource = createThreeMeshSurfaceResource(character.mesh);
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
    resolveMeshSurface: createThreeMeshSurfaceResolver(new Map([[meshRef.uri, surfaceResource]])),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);

  const probeDefinition = defineEffect({
    elements: {
      samples: defineEmitter({
        capacity: 24,
        init: [
          positionMeshSurface({ mesh: meshRef, mode: 'surface' }),
          velocityMeshNormal({ speed: 0.2 }),
          lifetime(2),
        ],
        integration: 'none',
        lifecycle: { duration: 1 },
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 24 }),
      }),
    },
  });
  const samplePose = async (seed: number) => {
    const system = new VFXSystem(runtimeRenderer);
    const instance = system.spawn(probeDefinition, { seed }) as RuntimeInstance;
    const view = emitter(instance, 'samples');
    await system.update(0);
    return {
      normals: (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'surfaceNormal',
      )) as Float32Array,
      positions: (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'position',
      )) as Float32Array,
      velocities: (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'velocity',
      )) as Float32Array,
    };
  };

  character.lowerBone.rotation.z = 0;
  character.upperBone.rotation.z = 0;
  surfaceResource.updateFromMesh(character.mesh);
  const restPose = await samplePose(606);
  character.lowerBone.rotation.z = 0.1;
  character.upperBone.rotation.z = -0.38;
  surfaceResource.updateFromMesh(character.mesh);
  const animatedPose = await samplePose(606);
  const deterministicPose = await samplePose(606);
  const surfacePositions = surfaceResource.positionTexture.image.data as Float32Array;
  const surfaceDistance = maximumNearestVertexDistance(animatedPose.positions, surfacePositions);
  let maximumPoseDelta = 0;
  let maximumNormalVelocityError = 0;
  for (let index = 0; index < animatedPose.positions.length; index += 1) {
    maximumPoseDelta = Math.max(
      maximumPoseDelta,
      Math.abs((animatedPose.positions[index] ?? 0) - (restPose.positions[index] ?? 0)),
    );
    maximumNormalVelocityError = Math.max(
      maximumNormalVelocityError,
      Math.abs((animatedPose.velocities[index] ?? 0) - (animatedPose.normals[index] ?? 0) * 0.2),
    );
  }

  const auraDefinition = defineEffect({
    elements: {
      aura: defineEmitter({
        capacity: 96,
        init: [
          positionMeshSurface({ mesh: meshRef, mode: 'surface' }),
          velocityMeshNormal({ speed: 0.18 }),
          lifetime(2.4),
        ],
        lifecycle: { duration: 3, loopCount: 'infinite' },
        render: billboard({ blending: 'additive' }),
        spawn: rate({ rate: 18 }),
        update: [
          drag(0.08),
          sizeOverLife(curve([0, 0.02], [0.35, 0.075], [1, 0.01])),
          colorOverLife(gradient([0.2, 0.8, 1, 0], [0.45, 1, 0.9, 0.9], [0.1, 0.5, 1, 0])),
        ],
      }),
    },
  });
  const ringDefinition = defineEffect({
    elements: {
      ring: defineEmitter({
        capacity: 48,
        init: [positionSphere({ radius: 0.72, surfaceOnly: true }), lifetime(3)],
        integration: 'none',
        lifecycle: { duration: 2, loopCount: 'infinite' },
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 48, cycles: 2, interval: 1 }),
        update: [sizeOverLife(curve([0, 0.035], [1, 0.02]))],
      }),
    },
  });
  const orbitDefinition = defineEffect({
    elements: {
      orbit: defineEmitter({
        capacity: 32,
        init: [
          positionSphere({ radius: 1.15, surfaceOnly: true }),
          velocityCone({ angle: 0, direction: [0, 1, 0], speed: 0 }),
          lifetime(4),
        ],
        lifecycle: { duration: 3, loopCount: 'infinite' },
        render: billboard({ blending: 'additive' }),
        spawn: burst({ count: 32, cycles: 2, interval: 1.5 }),
        update: [
          vortex({ axis: [0, 1, 0], space: 'emitter', strength: 1.4 }),
          sizeOverLife(curve([0, 0.025], [0.35, 0.065], [1, 0.015])),
          colorOverLife(gradient([0.15, 0.65, 1, 0], [0.4, 0.95, 1, 0.85], [0.5, 0.35, 1, 0])),
        ],
      }),
    },
  });

  const auraSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
  });
  const ringSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
  });
  const orbitSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
  });
  const auraInstance = auraSystem.spawn(auraDefinition, { seed: 71 }) as RuntimeInstance;
  const ringInstance = ringSystem.spawn(ringDefinition, { seed: 72 }) as RuntimeInstance;
  const orbitInstance = orbitSystem.spawn(orbitDefinition, { seed: 73 }) as RuntimeInstance;
  auraInstance.attachTo(createThreeTransformSource(character.mesh));
  ringInstance.attachTo(createThreeTransformSource(character.footSocket));
  orbitInstance.attachTo(createThreeTransformSource(character.mesh));
  await auraSystem.update(0);
  await ringSystem.update(0);
  await orbitSystem.update(0);
  for (let frame = 0; frame < 30; frame += 1) {
    const phase = (frame / 30) * Math.PI * 2;
    character.lowerBone.rotation.z = Math.sin(phase) * 0.1;
    character.upperBone.rotation.z = Math.sin(phase + 0.6) * 0.36;
    surfaceResource.updateFromMesh(character.mesh);
    await auraSystem.update(STEP);
    await ringSystem.update(STEP);
    await orbitSystem.update(STEP);
  }

  const ringView = emitter(ringInstance, 'ring');
  const ringTransform = ringView.kernels.uniforms['Emitter.transform']?.value as
    | THREE.Matrix4
    | undefined;
  const socketPosition = new THREE.Vector3();
  character.footSocket.getWorldPosition(socketPosition);
  const transformElements = ringTransform?.elements ?? [];
  const socketError = Math.hypot(
    (transformElements[12] ?? Number.NaN) - socketPosition.x,
    (transformElements[13] ?? Number.NaN) - socketPosition.y,
    (transformElements[14] ?? Number.NaN) - socketPosition.z,
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x061018);
  scene.add(character.mesh);
  scene.add(new THREE.HemisphereLight(0xb8f4ff, 0x102030, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const auraView = emitter(auraInstance, 'aura');
  const orbitView = emitter(orbitInstance, 'orbit');
  scene.add(
    materializeThreeSpriteDraw(auraView.program, auraView.kernels),
    materializeThreeSpriteDraw(ringView.program, ringView.kernels),
    materializeThreeSpriteDraw(orbitView.program, orbitView.kernels),
  );
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 30);
  camera.position.set(0, 0.7, 5.2);
  camera.lookAt(0, 0.25, 0);
  const visualTarget = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  renderer.setRenderTarget(visualTarget);
  renderer.render(scene, camera);
  const visualPixels = await renderer.readRenderTargetPixelsAsync(
    visualTarget,
    0,
    0,
    WIDTH,
    HEIGHT,
  );
  renderer.setRenderTarget(null);
  const foregroundPixelRatio = paintReadback(
    requireElement<HTMLCanvasElement>('#golden-character'),
    visualPixels,
  );

  const performanceRenderer = await createPlaygroundRenderer({
    antialias: false,
    trackTimestamp: true,
  });
  performanceRenderer.setSize(1, 1);
  await performanceRenderer.init();
  const performanceBackend = performanceRenderer.backend as BackendLike;
  if (!performanceBackend.isWebGPUBackend) {
    throw new Error('Golden character performance capture requires WebGPU.');
  }
  const performanceAdapter = createThreeKernelAdapter({ backend: 'webgpu' });
  const performanceRuntime = createThreeRuntimeRenderer(
    performanceRenderer,
    performanceAdapter,
    performanceBackend.device?.lost,
  );
  const performanceMonitor = createPerformanceMonitor(performanceRenderer, {
    gpuScopes: ['compute'],
    mode: headless ? 'headless' : 'visual',
    page: 'golden-character',
  });
  const performanceSystem = new VFXSystem(performanceRuntime);
  performanceSystem.spawn(orbitDefinition, { seed: 74 });
  await performanceSystem.update(0);
  await performanceRenderer.resolveTimestampsAsync('compute');
  await performanceMonitor.captureGpuSamples(async () => {
    await performanceSystem.update(STEP);
  });

  const validation = {
    bonePoseFollow: maximumPoseDelta > 0.03,
    consoleClean: consoleMessages.length === 0,
    deterministic:
      bytesEqual(animatedPose.positions, deterministicPose.positions) &&
      bytesEqual(animatedPose.normals, deterministicPose.normals),
    meshNormalVelocity: maximumNormalVelocityError < 0.0001,
    socketFollow: socketError < 0.0001,
    surfaceSpawn: surfaceDistance < 0.7,
    visualReadback: foregroundPixelRatio > 0.01,
    visualReadbackNotSaturated: foregroundPixelRatio < 0.3,
  };
  const result = {
    artifact: 'artifacts/golden-character.png',
    consoleMessages,
    foregroundPixelRatio,
    maximumNormalVelocityError,
    maximumPoseDelta,
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    skinningPath: 'cpu-deformed-triangle-cdf-upload',
    socketError,
    surfaceDistance,
    validation,
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'golden-character.png', selector: '#golden-character' },
  ]);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'Golden character verified' : 'Golden character failed';
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = 'error';
  statusValue.textContent = `Error: ${message}`;
});
