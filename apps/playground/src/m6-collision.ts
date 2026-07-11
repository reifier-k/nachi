import {
  VFXSystem,
  billboard,
  burst,
  collideBox,
  collidePlane,
  collideSceneDepth,
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
import { pass, screenUV, vec4 } from 'three/tsl';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
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
    typeof collidePlane | typeof collideSphere | typeof collideBox | typeof collideSceneDepth
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
  const scenePass = pass(depthScene, camera);
  const sceneDepth = scenePass.getTextureNode('depth').sample(screenUV).r;
  const depthPipeline = new THREE.RenderPipeline(renderer);
  depthPipeline.outputNode = vec4(sceneDepth, sceneDepth, sceneDepth, 1);
  const depthCopyTarget = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: false });
  depthCopyTarget.texture.minFilter = THREE.NearestFilter;
  depthCopyTarget.texture.magFilter = THREE.NearestFilter;
  renderer.setRenderTarget(depthCopyTarget);
  depthPipeline.render();
  const depthPixels = await renderer.readRenderTargetPixelsAsync(
    depthCopyTarget,
    0,
    0,
    WIDTH,
    HEIGHT,
  );
  renderer.setRenderTarget(null);

  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
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

  const depthSystem = new VFXSystem(runtimeRenderer, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
  });
  depthSystem.setCamera(cameraState);
  const depthInstance = depthSystem.spawn(
    defineEffect({
      elements: {
        particles: particleEmitter({
          update: [collideSceneDepth({ mode: 'stick', surfaceOffset: 0.002 })],
          velocity: [0, 0, -1],
        }),
      },
    }),
    { position: [0, 0, 1], seed: 40 },
  ) as RuntimeInstance;
  const depthView = emitter(depthInstance);
  await depthSystem.update(0);
  for (let frame = 0; frame < 90; frame += 1) await depthSystem.update(STEP);
  const depthPosition = (await readLogicalAttribute(
    renderer,
    depthView.program,
    depthView.kernels,
    'position',
  )) as Float32Array;
  const depthVelocity = (await readLogicalAttribute(
    renderer,
    depthView.program,
    depthView.kernels,
    'velocity',
  )) as Float32Array;
  const centerDepth =
    Number(depthPixels[((Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4) | 0] ?? 0) /
    255;
  await measureGpuPerformance();

  const validation = {
    analyticPushout:
      close(spherePosition[0] ?? Number.NaN, 1, 0.002) &&
      close(boxPosition[0] ?? Number.NaN, 1, 0.002),
    consoleClean: consoleMessages.length === 0,
    depthCollision:
      centerDepth > 0 &&
      centerDepth < 1 &&
      (depthPosition[2] ?? Number.NaN) > -0.4 &&
      (depthPosition[2] ?? Number.NaN) < 0.5 &&
      Math.abs(depthVelocity[2] ?? Number.NaN) < 0.002,
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
      position: [...depthPosition.slice(0, 3)],
      source: 'previous-frame-pass-depth-color-copy',
      velocity: [...depthVelocity.slice(0, 3)],
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
