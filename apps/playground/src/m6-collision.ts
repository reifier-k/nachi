import {
  VFXSystem,
  bakeSdf,
  billboard,
  burst,
  collideBox,
  collidePlane,
  collideSceneDepth,
  collideSdf,
  collideSphere,
  defineEffect,
  defineEmitter,
  emitTo,
  gravity,
  lifetime,
  positionSphere,
  velocityCone,
} from '@nachi/core';
import type { Vec3, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';
import { screenUV, texture, vec4 } from 'three/tsl';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeSdfResolver,
  createThreeSdfResource,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m6-collision.css';

const STEP = 1 / 60;
const WIDTH = 96;
const HEIGHT = 96;
const PLANE_FRAMES = 120;
const PLANE_BOUNCE = 0.55;
const PLANE_FRICTION = 0.15;
const GRAVITY = -9.8;

type BackendLike = {
  device?: {
    features?: { has(name: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

type RuntimeInstance = {
  readonly diagnostics: readonly { code: string }[];
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  on(event: string, callback: (summary: { count: number }) => void): () => void;
};

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const backendValue = requireElement<HTMLElement>('#backend-value');
const modeValue = requireElement<HTMLElement>('#mode-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const sceneHost = requireElement<HTMLDivElement>('#scene');
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

root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M6 collision UI element: ${selector}`);
  return element;
}

function emitter(instance: RuntimeInstance, key = 'particles'): VfxEmitterRuntimeView {
  const value = instance.getEmitter(key);
  if (!value) throw new Error(`M6 runtime emitter "${key}" is missing.`);
  return value;
}

function bytesEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

function close(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function particleEmitter(options: {
  readonly integration?: 'euler' | 'none';
  readonly lifetimeSeconds?: number;
  readonly update: ReturnType<
    | typeof collidePlane
    | typeof collideSphere
    | typeof collideBox
    | typeof collideSceneDepth
    | typeof collideSdf
  >[];
  readonly velocity?: Vec3;
}) {
  const velocity = options.velocity ?? [0, 0, 0];
  const speed = Math.hypot(...velocity);
  const direction: Vec3 =
    speed === 0 ? [0, 1, 0] : [velocity[0] / speed, velocity[1] / speed, velocity[2] / speed];
  return defineEmitter({
    capacity: 1,
    init: [
      positionSphere({ radius: 0 }),
      velocityCone({ angle: 0, direction, speed }),
      lifetime(options.lifetimeSeconds ?? 10),
    ],
    integration: options.integration ?? 'euler',
    lifecycle: { duration: 4 },
    render: billboard({}),
    spawn: burst({ count: 1 }),
    update: options.update,
  });
}

function cpuPlaneReference() {
  let position = 1;
  let velocity = -1;
  let incomingSpeed = 0;
  let outgoingSpeed = 0;
  for (let frame = 0; frame < PLANE_FRAMES; frame += 1) {
    velocity += GRAVITY * STEP;
    if (position < 0) {
      if (velocity < 0 && incomingSpeed === 0) incomingSpeed = -velocity;
      position = 0;
      if (velocity < 0) velocity = -velocity * PLANE_BOUNCE;
      if (incomingSpeed > 0 && outgoingSpeed === 0) outgoingSpeed = velocity;
    }
    position += velocity * STEP;
  }
  return {
    energyDecayed: outgoingSpeed < incomingSpeed,
    incomingSpeed,
    outgoingSpeed,
    position,
    velocity,
  };
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  if (!headless) sceneHost.append(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('M6 collision smoke requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Offscreen readback' : 'GPU diagnostics';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const depthScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 20);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const occluder = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  depthScene.add(occluder);
  const sceneDepthTexture = new THREE.DepthTexture(WIDTH, HEIGHT, THREE.UnsignedIntType);
  sceneDepthTexture.minFilter = THREE.NearestFilter;
  sceneDepthTexture.magFilter = THREE.NearestFilter;
  const depthSceneTarget = new THREE.RenderTarget(WIDTH, HEIGHT, {
    depthBuffer: true,
    depthTexture: sceneDepthTexture,
    samples: 0,
  });
  const sceneDepth = texture(sceneDepthTexture, screenUV).r;
  const depthPipeline = new THREE.RenderPipeline(renderer);
  depthPipeline.outputColorTransform = false;
  depthPipeline.outputNode = vec4(sceneDepth, sceneDepth, sceneDepth, 1);
  const depthCopyTarget = new THREE.RenderTarget(WIDTH, HEIGHT, {
    depthBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  });
  depthCopyTarget.texture.minFilter = THREE.NearestFilter;
  depthCopyTarget.texture.magFilter = THREE.NearestFilter;
  depthCopyTarget.texture.colorSpace = THREE.NoColorSpace;
  const centerPixelOffset = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
  const centerDepthOf = (pixels: ArrayLike<number>): number =>
    Number(pixels[centerPixelOffset] ?? Number.NaN);
  let previousDepthCopy: { readonly centerDepth: number; readonly configuration: string } | null =
    null;
  const copySceneDepth = async (configuration: string) => {
    try {
      // three r185 PassNode uses FRAME updateBefore semantics, so RenderPipeline.render() calls
      // outside the presentation loop can reuse its prior depth. Render the prepass explicitly.
      renderer.setRenderTarget(depthSceneTarget);
      renderer.render(depthScene, camera);
      renderer.setRenderTarget(depthCopyTarget);
      depthPipeline.render();
      const pixels = await renderer.readRenderTargetPixelsAsync(
        depthCopyTarget,
        0,
        0,
        WIDTH,
        HEIGHT,
      );
      const centerDepth = centerDepthOf(pixels);
      // This tripwire intentionally compares the exact center pixel only. Every preceding test
      // configuration moves the large center-covering occluder, so equality is a strong stale-copy
      // signal here; it is not a general-purpose depth-change detector for sub-pixel geometry.
      if (previousDepthCopy !== null && centerDepth === previousDepthCopy.centerDepth) {
        throw new Error(
          `Stale scene-depth copy: ${configuration} retained center depth from ${previousDepthCopy.configuration}.`,
        );
      }
      previousDepthCopy = { centerDepth, configuration };
      return pixels;
    } finally {
      renderer.setRenderTarget(null);
    }
  };
  const depthPixels = await copySceneDepth('frontal-z0');

  const sdfRef = {
    assetType: 'sdf',
    kind: 'asset-ref',
    uri: 'procedural://m6-collision/sphere',
  } as const;
  const sdfResource = createThreeSdfResource(
    bakeSdf({
      boundsMax: [2, 2, 2],
      boundsMin: [-2, -2, -2],
      resolution: [33, 33, 33],
      shapes: [{ center: [0, 0, 0], radius: 1, shape: 'sphere' }],
    }),
  );

  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
    resolveSdf: createThreeSdfResolver(new Map([[sdfRef.uri, sdfResource]])),
    sceneDepthSampleCount: 1,
    sceneDepthTexture: depthCopyTarget.texture,
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const cameraState = {
    projectionMatrix: camera.projectionMatrix.toArray(),
    viewMatrix: camera.matrixWorldInverse.toArray(),
    viewportSize: [WIDTH, HEIGHT] as const,
  };
  const measureGpuPerformance = async () => {
    const performanceRenderer = await createPlaygroundRenderer({
      antialias: false,
      trackTimestamp: true,
    });
    performanceRenderer.setSize(1, 1);
    await performanceRenderer.init();
    const performanceBackend = performanceRenderer.backend as BackendLike;
    if (!performanceBackend.isWebGPUBackend) {
      throw new Error('M6 performance measurement requires WebGPU.');
    }
    const performanceAdapter = createThreeKernelAdapter({
      backend: 'webgpu',
      linearFloat32Filtering:
        performanceBackend.device?.features?.has('float32-filterable') === true,
      ...(performanceBackend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
        ? {}
        : {
            maxStorageBuffersPerShaderStage:
              performanceBackend.device.limits.maxStorageBuffersPerShaderStage,
          }),
    });
    const performanceRuntimeRenderer = createThreeRuntimeRenderer(
      performanceRenderer,
      performanceAdapter,
      performanceBackend.device?.lost,
    );
    const performanceMonitor = createPerformanceMonitor(performanceRenderer, {
      gpuScopes: ['compute'],
      mode: headless ? 'headless' : 'visual',
      page: 'm6-collision',
    });
    const performanceSystem = new VFXSystem(performanceRuntimeRenderer, undefined, {
      fixedTimeStep: { stepSeconds: STEP },
    });
    performanceSystem.spawn(
      defineEffect({
        elements: {
          particles: particleEmitter({
            update: [collidePlane({ mode: 'stick', normal: [0, 1, 0], offset: 0 })],
            velocity: [0, -1, 0],
          }),
        },
      }),
      { position: [0, 0.1, 0], seed: 50 },
    );
    await performanceSystem.update(0);
    await performanceMonitor.resolveGpuTimestamps();
    for (let frame = 0; frame < 2; frame += 1) {
      await performanceSystem.update(STEP);
      await performanceMonitor.resolveGpuTimestamps();
    }
    performanceMonitor.publish();
  };

  const runPlane = async (seed: number) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      fixedTimeStep: { stepSeconds: STEP },
    });
    const definition = defineEffect({
      elements: {
        particles: defineEmitter({
          ...particleEmitter({
            update: [
              collidePlane({
                bounce: PLANE_BOUNCE,
                friction: PLANE_FRICTION,
                mode: 'bounce',
                normal: [0, 1, 0],
                offset: 0,
              }),
            ],
            velocity: [0, -1, 0],
          }),
          update: [
            gravity(GRAVITY),
            collidePlane({
              bounce: PLANE_BOUNCE,
              friction: PLANE_FRICTION,
              mode: 'bounce',
              normal: [0, 1, 0],
              offset: 0,
            }),
          ],
        }),
      },
    });
    const instance = system.spawn(definition, { position: [0, 1, 0], seed }) as RuntimeInstance;
    const view = emitter(instance);
    await system.update(0);
    for (let frame = 0; frame < PLANE_FRAMES; frame += 1) await system.update(STEP);
    return {
      position: (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'position',
      )) as Float32Array,
      velocity: (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'velocity',
      )) as Float32Array,
    };
  };

  const runSingle = async (
    position: Vec3,
    update: Parameters<typeof particleEmitter>[0]['update'],
    options: { readonly exact?: boolean; readonly velocity?: Vec3 } = {},
  ) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      ...(options.exact ? { aliveCountReadbackInterval: 1 } : {}),
    });
    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: particleEmitter({
            integration: 'none',
            update,
            ...(options.velocity === undefined ? {} : { velocity: options.velocity }),
          }),
        },
      }),
      { position, seed: 20 },
    ) as RuntimeInstance;
    const view = emitter(instance);
    await system.update(0);
    await system.update(STEP);
    return { instance, system, view };
  };

  const plane = await runPlane(10);
  const planeDuplicate = await runPlane(10);
  const planeCpu = cpuPlaneReference();
  const sphere = await runSingle(
    [0.25, 0, 0],
    [collideSphere({ center: [0, 0, 0], mode: 'stick', radius: 1 })],
  );
  const spherePosition = (await readLogicalAttribute(
    renderer,
    sphere.view.program,
    sphere.view.kernels,
    'position',
  )) as Float32Array;
  const box = await runSingle(
    [0.2, 0, 0],
    [collideBox({ center: [0, 0, 0], mode: 'stick', size: [2, 2, 2] })],
  );
  const boxPosition = (await readLogicalAttribute(
    renderer,
    box.view.program,
    box.view.kernels,
    'position',
  )) as Float32Array;
  const sdf = await runSingle(
    [0.5, 0, 0],
    [collideSdf({ bounce: 0.5, field: sdfRef, friction: 0, mode: 'bounce' })],
    { velocity: [-1, 0, 0] },
  );
  const sdfPosition = (await readLogicalAttribute(
    renderer,
    sdf.view.program,
    sdf.view.kernels,
    'position',
  )) as Float32Array;
  const sdfVelocity = (await readLogicalAttribute(
    renderer,
    sdf.view.program,
    sdf.view.kernels,
    'velocity',
  )) as Float32Array;
  const killed = await runSingle(
    [0, -0.1, 0],
    [collidePlane({ mode: 'kill', normal: [0, 1, 0], offset: 0 })],
    { exact: true },
  );

  const collisionCallbacks: number[] = [];
  const eventSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
  });
  const eventInstance = eventSystem.spawn(
    defineEffect({
      elements: {
        impacts: defineEmitter({
          capacity: 2,
          init: [positionSphere({ radius: 0 }), lifetime(1)],
          integration: 'none',
          lifecycle: { duration: 2 },
          render: billboard({}),
          spawn: burst({ count: 0 }),
        }),
        source: defineEmitter({
          ...particleEmitter({
            integration: 'none',
            update: [collidePlane({ mode: 'stick', normal: [0, 1, 0], offset: 0 })],
          }),
          events: { onCollision: emitTo('impacts', { inherit: ['position'] }) },
        }),
      },
    }),
    { position: [0, -0.2, 0], seed: 30 },
  ) as RuntimeInstance;
  eventInstance.on('collision', ({ count }) => collisionCallbacks.push(count));
  await eventSystem.update(0);
  await eventSystem.update(STEP);
  await eventSystem.update(STEP);
  const impactView = emitter(eventInstance, 'impacts');
  const impactPosition = (await readLogicalAttribute(
    renderer,
    impactView.program,
    impactView.kernels,
    'position',
  )) as Float32Array;

  const runDepthCollision = async (options: {
    readonly collision: ReturnType<typeof collideSceneDepth>;
    readonly frames?: number;
    readonly integration?: 'euler' | 'none';
    readonly position: Vec3;
    readonly seed: number;
    readonly velocity: Vec3;
  }) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      fixedTimeStep: { stepSeconds: STEP },
    });
    system.setCamera(cameraState);
    const instance = system.spawn(
      defineEffect({
        elements: {
          particles: particleEmitter({
            ...(options.integration === undefined ? {} : { integration: options.integration }),
            update: [options.collision],
            velocity: options.velocity,
          }),
        },
      }),
      { position: options.position, seed: options.seed },
    ) as RuntimeInstance;
    const view = emitter(instance);
    await system.update(0);
    for (let frame = 0; frame < (options.frames ?? 1); frame += 1) await system.update(STEP);
    return {
      diagnostics: instance.diagnostics,
      position: (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'position',
      )) as Float32Array,
      velocity: (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'velocity',
      )) as Float32Array,
      system,
      view,
    };
  };

  const depth = await runDepthCollision({
    collision: collideSceneDepth({ mode: 'stick', surfaceOffset: 0.002, thickness: 0.15 }),
    frames: 90,
    integration: 'euler',
    position: [0, 0, 1],
    seed: 40,
    velocity: [0, 0, -1],
  });
  const centerDepth = centerDepthOf(depthPixels);

  occluder.position.z = 0.2;
  occluder.rotation.y = 0;
  await copySceneDepth('moving-z0.2');
  const movingDepth = await runDepthCollision({
    collision: collideSceneDepth({ mode: 'stick', surfaceOffset: 0.002, thickness: 0.5 }),
    integration: 'none',
    position: [0, 0, 0.1],
    seed: 41,
    velocity: [0, 0, 0],
  });
  occluder.position.z = 0.35;
  const movedDepthPixels = await copySceneDepth('moving-z0.35');
  await movingDepth.system.update(STEP);
  const movingDepthNextPosition = (await readLogicalAttribute(
    renderer,
    movingDepth.view.program,
    movingDepth.view.kernels,
    'position',
  )) as Float32Array;
  const movedCenterDepth = centerDepthOf(movedDepthPixels);

  const slopeAngle = Math.PI / 6;
  occluder.position.z = 0;
  occluder.rotation.y = slopeAngle;
  const slopeDepthPixels = await copySceneDepth('slope-y-pi-over-6-z0');
  const slopeCenterDepth = centerDepthOf(slopeDepthPixels);
  const slopeDepth = await runDepthCollision({
    collision: collideSceneDepth({ bounce: 1, friction: 0, mode: 'bounce', thickness: 0.2 }),
    integration: 'none',
    position: [0, 0, -0.03],
    seed: 42,
    velocity: [0, 0, -1],
  });
  const slopeNormal: Vec3 = [Math.sin(slopeAngle), 0, Math.cos(slopeAngle)];
  const incoming: Vec3 = [0, 0, -1];
  const normalSpeed =
    incoming[0] * slopeNormal[0] + incoming[1] * slopeNormal[1] + incoming[2] * slopeNormal[2];
  const expectedSlopeVelocity: Vec3 = [
    incoming[0] - 2 * normalSpeed * slopeNormal[0],
    incoming[1] - 2 * normalSpeed * slopeNormal[1],
    incoming[2] - 2 * normalSpeed * slopeNormal[2],
  ];

  // Regression tripwire for screenUV(v down) <-> WebGPU NDC(y up). A rotation around X makes
  // depth differ between the upper and lower screen halves; the old mirrored lookup leaves this
  // upper particle untouched at z=0.15 instead of projecting it near z=0.267.
  const asymmetricAngle = Math.PI / 9;
  const asymmetricPlaneZ = 0.07;
  const asymmetricParticle: Vec3 = [0, 0.55, 0.15];
  occluder.position.z = asymmetricPlaneZ;
  occluder.rotation.y = 0;
  occluder.rotation.x = asymmetricAngle;
  await copySceneDepth('slope-x-pi-over-9-z0.07-asymmetric-y0.55');
  const asymmetricDepth = await runDepthCollision({
    collision: collideSceneDepth({ mode: 'stick', surfaceOffset: 0.002, thickness: 0.5 }),
    integration: 'none',
    position: asymmetricParticle,
    seed: 44,
    velocity: [0, 0, 0],
  });
  const asymmetricTangent = Math.tan(asymmetricAngle);
  const asymmetricRayT =
    (camera.position.z - asymmetricPlaneZ) /
    (camera.position.z - asymmetricParticle[2] + asymmetricParticle[1] * asymmetricTangent);
  const asymmetricNormal: Vec3 = [0, -Math.sin(asymmetricAngle), Math.cos(asymmetricAngle)];
  const expectedAsymmetricPosition: Vec3 = [
    0,
    asymmetricParticle[1] * asymmetricRayT + asymmetricNormal[1] * 0.002,
    asymmetricPlaneZ +
      asymmetricParticle[1] * asymmetricRayT * asymmetricTangent +
      asymmetricNormal[2] * 0.002,
  ];

  occluder.rotation.x = 0;
  occluder.rotation.y = 0;
  occluder.position.z = 0;
  await copySceneDepth('thickness-frontal-z0');
  const thicknessDepth = await runDepthCollision({
    collision: collideSceneDepth({ mode: 'stick', thickness: 0.1 }),
    integration: 'none',
    position: [0, 0, -1],
    seed: 43,
    velocity: [0, 0, -1],
  });
  await measureGpuPerformance();

  const validation = {
    analyticPushout:
      close(spherePosition[0] ?? Number.NaN, 1, 0.002) &&
      close(boxPosition[0] ?? Number.NaN, 1, 0.002),
    consoleClean: consoleMessages.length === 0,
    depthCollision:
      centerDepth > 0 &&
      centerDepth < 1 &&
      close(depth.position[2] ?? Number.NaN, 0.002, 0.02) &&
      Math.abs(depth.velocity[2] ?? Number.NaN) < 0.002,
    depthMovingOccluder:
      movedCenterDepth < centerDepth &&
      close(movingDepth.position[2] ?? Number.NaN, 0.202, 0.02) &&
      close(movingDepthNextPosition[2] ?? Number.NaN, 0.352, 0.02),
    depthNormalBounce:
      close(slopeDepth.velocity[0] ?? Number.NaN, expectedSlopeVelocity[0], 0.04) &&
      close(slopeDepth.velocity[1] ?? Number.NaN, expectedSlopeVelocity[1], 0.002) &&
      close(slopeDepth.velocity[2] ?? Number.NaN, expectedSlopeVelocity[2], 0.04),
    depthScreenUvYConvention:
      close(asymmetricDepth.position[1] ?? Number.NaN, expectedAsymmetricPosition[1], 0.02) &&
      close(asymmetricDepth.position[2] ?? Number.NaN, expectedAsymmetricPosition[2], 0.02) &&
      Math.abs((asymmetricDepth.position[2] ?? Number.NaN) - asymmetricParticle[2]) > 0.08,
    depthThicknessReject:
      close(thicknessDepth.position[2] ?? Number.NaN, -1, 0.002) &&
      close(thicknessDepth.velocity[2] ?? Number.NaN, -1, 0.002),
    deterministic:
      bytesEqual(plane.position, planeDuplicate.position) &&
      bytesEqual(plane.velocity, planeDuplicate.velocity),
    killMode: killed.view.aliveCount === 0,
    onCollision:
      impactView.aliveCount === 1 &&
      collisionCallbacks.reduce((sum, count) => sum + count, 0) === 1 &&
      close(impactPosition[1] ?? Number.NaN, 0, 0.002),
    planeBounce:
      planeCpu.energyDecayed &&
      (plane.position[1] ?? Number.NaN) >= -0.0001 &&
      close(plane.position[1] ?? Number.NaN, planeCpu.position, 0.003) &&
      close(plane.velocity[1] ?? Number.NaN, planeCpu.velocity, 0.003),
    sdfBounce:
      close(sdfVelocity[0] ?? Number.NaN, 0.5, 0.01) &&
      close(sdfVelocity[1] ?? Number.NaN, 0, 0.01) &&
      close(sdfVelocity[2] ?? Number.NaN, 0, 0.01),
    sdfPushout: close(sdfPosition[0] ?? Number.NaN, 1, 0.01),
  };
  const result = {
    analytic: {
      boxPosition: [...boxPosition.slice(0, 3)],
      spherePosition: [...spherePosition.slice(0, 3)],
    },
    consoleMessages,
    depth: {
      cameraUniforms: ['System.viewMatrix', 'System.projectionMatrix', 'System.viewportSize'],
      centerDepth,
      moving: {
        centerDepth: movedCenterDepth,
        firstFramePosition: [...movingDepth.position.slice(0, 3)],
        nextFramePosition: [...movingDepthNextPosition.slice(0, 3)],
      },
      normalBounce: {
        centerDepth: slopeCenterDepth,
        expectedVelocity: expectedSlopeVelocity,
        velocity: [...slopeDepth.velocity.slice(0, 3)],
      },
      screenUvYConvention: {
        expectedPosition: expectedAsymmetricPosition,
        mirroredConventionPosition: asymmetricParticle,
        position: [...asymmetricDepth.position.slice(0, 3)],
        result: 'screenUV-v-down-requires-one-minus-to-WebGPU-NDC-y-up',
      },
      position: [...depth.position.slice(0, 3)],
      source: 'explicit-render-target-depth-prepass-linear-float-depth-color-copy',
      thicknessReject: {
        position: [...thicknessDepth.position.slice(0, 3)],
        velocity: [...thicknessDepth.velocity.slice(0, 3)],
      },
      velocity: [...depth.velocity.slice(0, 3)],
    },
    event: {
      callbackCount: collisionCallbacks.reduce((sum, count) => sum + count, 0),
      impactAlive: impactView.aliveCount,
      impactPosition: [...impactPosition.slice(0, 3)],
    },
    killAlive: killed.view.aliveCount,
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    plane: {
      cpu: planeCpu,
      position: [...plane.position.slice(0, 3)],
      velocity: [...plane.velocity.slice(0, 3)],
    },
    sdf: {
      expected: { position: [1, 0, 0], velocity: [0.5, 0, 0] },
      position: [...sdfPosition.slice(0, 3)],
      velocity: [...sdfVelocity.slice(0, 3)],
    },
    validation,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M6 collision checks passed' : 'M6 checks failed';
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
