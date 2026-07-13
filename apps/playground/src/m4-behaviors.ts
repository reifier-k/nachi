import {
  VFXSystem,
  billboard,
  burst,
  curve,
  curlNoise,
  defineEffect,
  defineEmitter,
  defineParameter,
  killVolume,
  lifetime,
  linearForce,
  orientToVelocity,
  parameter,
  parseFga,
  pointAttractor,
  positionSphere,
  rotationOverLife,
  turbulence,
  velocityCone,
  velocityOverLife,
  vectorField,
  vortex,
} from '@nachi/core';
import type { UpdateModule, Vec3, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeVectorFieldResolver,
  createThreeVectorFieldResource,
} from '@nachi/three';
import { readLogicalAttribute } from './three-runtime-readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m3-sprites.css';

const STEP = 1 / 60;
const SIMPLEX_EFFECTIVE_AMPLITUDE = 0.286;
const TURBULENCE_STRENGTH = 2;
const CURL_STRENGTH = 2;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
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

const backendValue = requireElement<HTMLElement>('#backend-value');
const modeValue = requireElement<HTMLElement>('#mode-value');
const statusValue = requireElement<HTMLElement>('#status-value');
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

type RuntimeInstance = {
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  setTransform(position: Vec3): void;
};

type BackendLike = {
  device?: {
    features?: { has(name: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M4 behavior UI element: ${selector}`);
  return element;
}

function emitter(instance: RuntimeInstance): VfxEmitterRuntimeView {
  const runtimeEmitter = instance.getEmitter('particles');
  if (!runtimeEmitter) throw new Error('M4 behavior runtime emitter is missing.');
  return runtimeEmitter;
}

function particleEffect(options: {
  readonly capacity?: number;
  readonly direction?: Vec3;
  readonly integration?: 'euler' | 'none';
  readonly lifetimeSeconds?: number;
  readonly positionRadius?: number;
  readonly speed?: number;
  readonly surfaceOnly?: boolean;
  readonly update: readonly UpdateModule[];
}) {
  const capacity = options.capacity ?? 8;
  return defineEffect({
    elements: {
      particles: defineEmitter({
        capacity,
        init: [
          positionSphere({
            radius: options.positionRadius ?? 0,
            surfaceOnly: options.surfaceOnly ?? false,
          }),
          velocityCone({
            angle: 0,
            direction: options.direction ?? [1, 0, 0],
            speed: options.speed ?? 0,
          }),
          lifetime(options.lifetimeSeconds ?? 10),
        ],
        integration: options.integration ?? 'none',
        render: billboard({}),
        spawn: burst({ count: capacity }),
        update: options.update,
      }),
    },
  });
}

function vectorLength(values: ArrayLike<number>, offset: number): number {
  return Math.hypot(values[offset] ?? 0, values[offset + 1] ?? 0, values[offset + 2] ?? 0);
}

async function indirectCount(renderer: THREE.WebGPURenderer, view: VfxEmitterRuntimeView) {
  const indirect = view.kernels.drawIndirect;
  const offset = view.kernels.drawIndirectOffsetBytes;
  if (!indirect || offset === undefined) throw new Error('M4 indirect arguments are missing.');
  const buffer = await renderer.getArrayBufferAsync(indirect.indirectResource as never);
  return new Uint32Array(buffer)[offset / Uint32Array.BYTES_PER_ELEMENT + 1] ?? 0;
}

function bytesEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(64, 64);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('M4 behavior smoke requires WebGPU.');
  backendValue.textContent = 'WebGPU';
  modeValue.textContent = headless ? 'Storage readback' : 'Visual diagnostics';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';
  const linearFloat32Filtering = backend.device?.features?.has('float32-filterable') === true;

  const fieldRef = {
    assetType: 'vector-field',
    kind: 'asset-ref',
    uri: 'procedural://m4-behaviors/vortex.fga',
  } as const;
  const parsedField = parseFga(
    '2 2 2 -1 -1 -1 1 1 1 ' + '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24',
  );
  const resolveVectorField = createThreeVectorFieldResolver(
    new Map([[fieldRef.uri, createThreeVectorFieldResource(parsedField, linearFloat32Filtering)]]),
  );

  const kernelAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
    resolveVectorField,
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter, backend.device?.lost);
  const measureGpuPerformance = async () => {
    const performanceRenderer = await createPlaygroundRenderer({
      antialias: false,
      trackTimestamp: true,
    });
    performanceRenderer.setSize(1, 1);
    await performanceRenderer.init();
    const performanceBackend = performanceRenderer.backend as BackendLike;
    if (!performanceBackend.isWebGPUBackend) {
      throw new Error('M4 performance measurement requires WebGPU.');
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
      page: 'm4-behaviors',
    });
    const performanceSystem = new VFXSystem(performanceRuntimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      fixedTimeStep: { stepSeconds: STEP },
    });
    performanceSystem.spawn(
      particleEffect({
        capacity: 1,
        update: [linearForce({ force: [1, 0, 0] })],
      }),
      { seed: 400 },
    );
    await performanceSystem.update(0);
    await performanceMonitor.resolveGpuTimestamps();
    for (let frame = 0; frame < 2; frame += 1) {
      await performanceSystem.update(STEP);
      await performanceMonitor.resolveGpuTimestamps();
    }
    performanceMonitor.publish();
  };

  const spawn = async (
    options: Parameters<typeof particleEffect>[0],
    seed: number,
    position?: Vec3,
  ) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      fixedTimeStep: { stepSeconds: STEP },
    });
    const instance = system.spawn(particleEffect(options), {
      ...(position === undefined ? {} : { position }),
      seed,
    }) as RuntimeInstance;
    const view = emitter(instance);
    await system.update(0);
    return { instance, system, view };
  };

  const vortexRun = await spawn(
    {
      capacity: 12,
      positionRadius: 1,
      surfaceOnly: true,
      update: [vortex({ axis: [0, 1, 0], inwardStrength: 0.25, strength: 6 })],
    },
    11,
  );
  await vortexRun.system.update(STEP);
  const vortexPosition = (await readLogicalAttribute(
    renderer,
    vortexRun.view.program,
    vortexRun.view.kernels,
    'position',
  )) as Float32Array;
  const vortexVelocity = (await readLogicalAttribute(
    renderer,
    vortexRun.view.program,
    vortexRun.view.kernels,
    'velocity',
  )) as Float32Array;
  let signedAngularMomentum = 0;
  for (let index = 0; index < 12; index += 1) {
    const offset = index * 3;
    signedAngularMomentum +=
      (vortexPosition[offset + 2] ?? 0) * (vortexVelocity[offset] ?? 0) -
      (vortexPosition[offset] ?? 0) * (vortexVelocity[offset + 2] ?? 0);
  }
  signedAngularMomentum /= 12;

  const attractorRun = await spawn(
    {
      capacity: 8,
      integration: 'euler',
      positionRadius: 2,
      surfaceOnly: true,
      update: [
        pointAttractor({
          falloff: 0,
          position: [0, 0, 0],
          space: 'emitter',
          strength: 30,
        }),
      ],
    },
    12,
    [4, 0, 0],
  );
  const attractorBefore = (await readLogicalAttribute(
    renderer,
    attractorRun.view.program,
    attractorRun.view.kernels,
    'position',
  )) as Float32Array;
  attractorRun.instance.setTransform([5, 0, 0]);
  await attractorRun.system.update(STEP);
  const attractorAfter = (await readLogicalAttribute(
    renderer,
    attractorRun.view.program,
    attractorRun.view.kernels,
    'position',
  )) as Float32Array;
  const meanDistance = (values: Float32Array, center: Vec3) => {
    let total = 0;
    for (let index = 0; index < 8; index += 1) {
      const offset = index * 3;
      total += Math.hypot(
        (values[offset] ?? 0) - center[0],
        (values[offset + 1] ?? 0) - center[1],
        (values[offset + 2] ?? 0) - center[2],
      );
    }
    return total / 8;
  };
  const distanceBefore = meanDistance(attractorBefore, [5, 0, 0]);
  const distanceAfter = meanDistance(attractorAfter, [5, 0, 0]);

  const placementSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: STEP },
  });
  const placementInstance = placementSystem.spawn(
    defineEffect({
      elements: {
        centerOnly: defineEmitter({
          capacity: 32,
          init: [
            positionSphere({ center: [1, 0, 0], radius: 0.1, surfaceOnly: true }),
            lifetime(1),
          ],
          integration: 'none',
          offset: [2, 0, 0],
          render: billboard({}),
          spawn: burst({ count: 32 }),
        }),
        particles: defineEmitter({
          capacity: 512,
          init: [
            positionSphere({
              arc: { axis: [0, 1, 0], thetaMax: 90 },
              center: [1, 0, 0],
              radius: 0.1,
            }),
            lifetime(1),
          ],
          integration: 'none',
          offset: [2, 0, 0],
          render: billboard({}),
          spawn: burst({ count: 512 }),
        }),
      },
    }),
    { position: [4, 0, 0], seed: 401 },
  ) as RuntimeInstance;
  const centerOnlyView = placementInstance.getEmitter('centerOnly');
  if (!centerOnlyView) throw new Error('M4 center-only placement emitter is missing.');
  const placementView = emitter(placementInstance);
  await placementSystem.update(0);
  const centerOnlyPositions = (await readLogicalAttribute(
    renderer,
    centerOnlyView.program,
    centerOnlyView.kernels,
    'position',
  )) as Float32Array;
  const placementPositions = (await readLogicalAttribute(
    renderer,
    placementView.program,
    placementView.kernels,
    'position',
  )) as Float32Array;
  const placementCenter: Vec3 = [7, 0, 0];
  let placementMaximumRadiusError = 0;
  let placementMinimumCosTheta = 1;
  let placementMeanRadius = 0;
  let placementMeanCosTheta = 0;
  let centerOnlyMaximumRadiusError = 0;
  for (let particle = 0; particle < 32; particle += 1) {
    const offset = particle * 3;
    const radius = Math.hypot(
      (centerOnlyPositions[offset] ?? 0) - placementCenter[0],
      (centerOnlyPositions[offset + 1] ?? 0) - placementCenter[1],
      (centerOnlyPositions[offset + 2] ?? 0) - placementCenter[2],
    );
    centerOnlyMaximumRadiusError = Math.max(centerOnlyMaximumRadiusError, Math.abs(radius - 0.1));
  }
  for (let particle = 0; particle < 512; particle += 1) {
    const offset = particle * 3;
    const relative: Vec3 = [
      (placementPositions[offset] ?? 0) - placementCenter[0],
      (placementPositions[offset + 1] ?? 0) - placementCenter[1],
      (placementPositions[offset + 2] ?? 0) - placementCenter[2],
    ];
    const radius = Math.hypot(...relative);
    const cosTheta = radius === 0 ? 1 : relative[1] / radius;
    placementMaximumRadiusError = Math.max(placementMaximumRadiusError, Math.max(0, radius - 0.1));
    placementMinimumCosTheta = Math.min(placementMinimumCosTheta, cosTheta);
    placementMeanRadius += radius / 512;
    placementMeanCosTheta += cosTheta / 512;
  }

  const acceleration: Vec3 = [1.5, -3, 0.75];
  const linearSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: STEP },
  });
  const linearInstance = linearSystem.spawn(
    defineEffect({
      elements: {
        particles: defineEmitter({
          capacity: 4,
          init: [velocityCone({ angle: 0, direction: [1, 0, 0], speed: 0 }), lifetime(10)],
          integration: 'none',
          parameters: {
            'User.force': defineParameter('User.force', { default: acceleration, type: 'vec3' }),
          },
          render: billboard({}),
          spawn: burst({ count: 4 }),
          update: [
            linearForce({
              force: parameter('User.force', [...acceleration] as [number, number, number]),
            }),
          ],
        }),
      },
    }),
    { seed: 13 },
  ) as RuntimeInstance;
  const linearRun = { system: linearSystem, view: emitter(linearInstance) };
  await linearRun.system.update(0);
  for (let frame = 0; frame < 3; frame += 1) await linearRun.system.update(STEP);
  const linearVelocity = (await readLogicalAttribute(
    renderer,
    linearRun.view.program,
    linearRun.view.kernels,
    'velocity',
  )) as Float32Array;
  const expectedVelocity = acceleration.map((value) => value * STEP * 3) as unknown as Vec3;
  const linearError = Math.max(
    ...expectedVelocity.map((value, axis) => Math.abs((linearVelocity[axis] ?? 0) - value)),
  );

  const runTurbulence = async () => {
    const run = await spawn(
      {
        capacity: 16,
        positionRadius: 1.5,
        update: [turbulence({ frequency: 1.7, octaves: 3, strength: TURBULENCE_STRENGTH })],
      },
      14,
    );
    await run.system.update(STEP);
    return (await readLogicalAttribute(
      renderer,
      run.view.program,
      run.view.kernels,
      'velocity',
    )) as Float32Array;
  };
  const turbulenceA = await runTurbulence();
  const turbulenceB = await runTurbulence();
  const turbulenceMean = turbulenceA.reduce((sum, value) => sum + value, 0) / turbulenceA.length;
  const turbulenceVariance =
    turbulenceA.reduce((sum, value) => sum + (value - turbulenceMean) ** 2, 0) / turbulenceA.length;
  let turbulenceMaximumAcceleration = 0;
  for (let particle = 0; particle < turbulenceA.length / 3; particle += 1) {
    turbulenceMaximumAcceleration = Math.max(
      turbulenceMaximumAcceleration,
      vectorLength(turbulenceA, particle * 3) / STEP,
    );
  }

  const curlCenters: readonly Vec3[] = [
    [0.2, -0.3, 0.4],
    [-0.7, 0.5, 0.1],
    [0.9, 0.2, -0.6],
  ];
  const curlDifference = 0.04;
  const curlSamplePositions = curlCenters.flatMap((center) =>
    ([0, 1, 2] as const).flatMap((axis) =>
      ([-1, 1] as const).map(
        (direction) =>
          center.map((value, index) =>
            index === axis ? value + direction * curlDifference : value,
          ) as unknown as Vec3,
      ),
    ),
  );
  const runCurlSamples = async () => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      fixedTimeStep: { maxSubSteps: 64, stepSeconds: STEP },
    });
    const views = curlSamplePositions.map((position, index) => {
      const instance = system.spawn(
        particleEffect({
          capacity: 1,
          update: [curlNoise({ frequency: 1.3, strength: CURL_STRENGTH })],
        }),
        { position, seed: 100 + index },
      ) as RuntimeInstance;
      return emitter(instance);
    });
    await system.update(0);
    await system.update(STEP);
    const values = new Float32Array(views.length * 3);
    for (const [index, view] of views.entries()) {
      const velocity = (await readLogicalAttribute(
        renderer,
        view.program,
        view.kernels,
        'velocity',
      )) as Float32Array;
      values.set(velocity.subarray(0, 3), index * 3);
    }
    return values;
  };
  const curlA = await runCurlSamples();
  const curlB = await runCurlSamples();
  let curlMaximumAcceleration = 0;
  for (let sample = 0; sample < curlA.length / 3; sample += 1) {
    curlMaximumAcceleration = Math.max(
      curlMaximumAcceleration,
      vectorLength(curlA, sample * 3) / STEP,
    );
  }
  const curlDivergences = curlCenters.map((_center, centerIndex) => {
    const offset = centerIndex * 18;
    return (
      ((curlA[offset + 3] ?? 0) - (curlA[offset] ?? 0)) / (2 * curlDifference * STEP) +
      ((curlA[offset + 10] ?? 0) - (curlA[offset + 7] ?? 0)) / (2 * curlDifference * STEP) +
      ((curlA[offset + 17] ?? 0) - (curlA[offset + 14] ?? 0)) / (2 * curlDifference * STEP)
    );
  });
  const curlMaximumDivergence = Math.max(...curlDivergences.map(Math.abs));

  const fieldSamples: readonly {
    readonly expected: Vec3;
    readonly position: Vec3;
    readonly tiling?: boolean;
  }[] = [
    { expected: [1, 2, 3], position: [-1, -1, -1] },
    { expected: [4, 5, 6], position: [1, -1, -1] },
    { expected: [7, 8, 9], position: [-1, 1, -1] },
    { expected: [10, 11, 12], position: [1, 1, -1] },
    { expected: [13, 14, 15], position: [-1, -1, 1] },
    { expected: [16, 17, 18], position: [1, -1, 1] },
    { expected: [19, 20, 21], position: [-1, 1, 1] },
    { expected: [22, 23, 24], position: [1, 1, 1] },
    {
      expected: linearFloat32Filtering ? [3.25, 4.25, 5.25] : [4, 5, 6],
      position: [1.5, -1, -1],
      tiling: true,
    },
  ];
  const fieldSystem = new VFXSystem(runtimeRenderer, undefined, {
    aliveCountReadbackInterval: 1,
    fixedTimeStep: { stepSeconds: STEP },
  });
  const fieldViews = fieldSamples.map(({ position, tiling }, index) => {
    const instance = fieldSystem.spawn(
      particleEffect({
        capacity: 1,
        update: [
          vectorField({
            field: fieldRef,
            strength: 1,
            ...(tiling === undefined ? {} : { tiling }),
          }),
        ],
      }),
      { position, seed: 200 + index },
    ) as RuntimeInstance;
    return emitter(instance);
  });
  await fieldSystem.update(0);
  await fieldSystem.update(STEP);
  const fieldMeasured: Vec3[] = [];
  let fieldError = 0;
  for (const [index, view] of fieldViews.entries()) {
    const velocity = (await readLogicalAttribute(
      renderer,
      view.program,
      view.kernels,
      'velocity',
    )) as Float32Array;
    const measured = [velocity[0] ?? 0, velocity[1] ?? 0, velocity[2] ?? 0] as Vec3;
    fieldMeasured.push(measured);
    for (let axis = 0; axis < 3; axis += 1) {
      fieldError = Math.max(
        fieldError,
        Math.abs((measured[axis] ?? 0) - (fieldSamples[index]?.expected[axis] ?? 0) * STEP),
      );
    }
  }

  const orientRun = await spawn(
    {
      capacity: 1,
      direction: [1, 0, 0],
      speed: 2,
      update: [orientToVelocity()],
    },
    18,
  );
  await orientRun.system.update(STEP);
  const orientation = (await readLogicalAttribute(
    renderer,
    orientRun.view.program,
    orientRun.view.kernels,
    'rotation',
  )) as Float32Array;
  const spriteOrientation = (await readLogicalAttribute(
    renderer,
    orientRun.view.program,
    orientRun.view.kernels,
    'spriteRotation',
  )) as Float32Array;
  const halfSqrt = Math.SQRT1_2;
  const orientationError = Math.max(
    Math.abs(orientation[0] ?? 0),
    Math.abs(orientation[1] ?? 0),
    Math.abs((orientation[2] ?? 0) + halfSqrt),
    Math.abs((orientation[3] ?? 0) - halfSqrt),
    Math.abs((spriteOrientation[0] ?? 0) + Math.PI / 2),
  );

  const curveRun = await spawn(
    {
      capacity: 2,
      lifetimeSeconds: STEP * 4,
      speed: 2,
      update: [rotationOverLife(curve([0, 0], [1, 2])), velocityOverLife(curve([0, 1], [1, 0]))],
    },
    15,
  );
  await curveRun.system.update(STEP);
  const rotations = (await readLogicalAttribute(
    renderer,
    curveRun.view.program,
    curveRun.view.kernels,
    'spriteRotation',
  )) as Float32Array;
  const curveVelocity = (await readLogicalAttribute(
    renderer,
    curveRun.view.program,
    curveRun.view.kernels,
    'velocity',
  )) as Float32Array;
  const normalizedAge = STEP / (STEP * 4);
  const rotationExpected = normalizedAge * 2;
  const speedExpected = 2 * (1 - normalizedAge);
  const curveError = Math.max(
    Math.abs((rotations[0] ?? 0) - rotationExpected),
    Math.abs(vectorLength(curveVelocity, 0) - speedExpected),
  );

  const runVelocityPartition = async (stepSeconds: number) => {
    const system = new VFXSystem(runtimeRenderer, undefined, {
      aliveCountReadbackInterval: 1,
      fixedTimeStep: { maxSubSteps: 64, stepSeconds },
    });
    const instance = system.spawn(
      particleEffect({
        capacity: 1,
        lifetimeSeconds: 2,
        speed: 2,
        update: [velocityOverLife(curve([0, 1], [1, 0.25]))],
      }),
      { seed: 300 },
    ) as RuntimeInstance;
    const view = emitter(instance);
    await system.update(0);
    await system.update(0.5);
    const velocity = (await readLogicalAttribute(
      renderer,
      view.program,
      view.kernels,
      'velocity',
    )) as Float32Array;
    return vectorLength(velocity, 0);
  };
  const velocityAt60Hz = await runVelocityPartition(1 / 60);
  const velocityAt30Hz = await runVelocityPartition(1 / 30);
  const partitionExpectedSpeed = 2 * (1 - 0.75 * (0.5 / 2));
  const partitionError = Math.max(
    Math.abs(velocityAt60Hz - velocityAt30Hz),
    Math.abs(velocityAt60Hz - partitionExpectedSpeed),
    Math.abs(velocityAt30Hz - partitionExpectedSpeed),
  );

  const killRun = await spawn(
    {
      capacity: 6,
      positionRadius: 0.5,
      surfaceOnly: true,
      update: [killVolume({ mode: 'inside', radius: 1, shape: 'sphere' })],
    },
    16,
    [3, -2, 1],
  );
  const aliveBefore = await indirectCount(renderer, killRun.view);
  await killRun.system.update(STEP);
  const aliveAfter = await indirectCount(renderer, killRun.view);
  await measureGpuPerformance();

  const validation = {
    consoleClean: consoleMessages.length === 0,
    curlNoise:
      bytesEqual(curlA, curlB) &&
      curlMaximumAcceleration > 0.01 &&
      curlMaximumAcceleration <= CURL_STRENGTH * 1.001 &&
      curlMaximumDivergence < CURL_STRENGTH * 0.5,
    vectorField: fieldError < 0.00002,
    orientToVelocity: orientationError < 0.002,
    killVolume: aliveBefore === 6 && aliveAfter === 0,
    linearForce: linearError < 0.00001,
    overLifeCurves: curveError < 0.002 && partitionError < 0.002,
    pointAttractor: distanceAfter < distanceBefore - 0.001,
    positionSphereCenter: centerOnlyMaximumRadiusError < 0.001,
    positionSpherePlacement:
      placementMaximumRadiusError < 0.001 &&
      placementMinimumCosTheta > -0.001 &&
      placementMeanRadius > 0.07 &&
      placementMeanRadius < 0.08 &&
      placementMeanCosTheta > 0.45 &&
      placementMeanCosTheta < 0.55,
    turbulence:
      bytesEqual(turbulenceA, turbulenceB) &&
      turbulenceVariance > 1e-8 &&
      turbulenceMaximumAcceleration <= TURBULENCE_STRENGTH * 1.001,
    vortex: signedAngularMomentum > 0.001,
  };
  const result = {
    consoleMessages,
    curlNoise: {
      bitIdentical: bytesEqual(curlA, curlB),
      divergences: curlDivergences,
      maximumAcceleration: curlMaximumAcceleration,
      maximumDivergence: curlMaximumDivergence,
      strengthUpperBound: CURL_STRENGTH,
    },
    killVolume: { aliveAfter, aliveBefore },
    linearForce: { error: linearError, expectedVelocity, measuredVelocity: [...linearVelocity] },
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    overLife: {
      error: curveError,
      partitionError,
      partitionExpectedSpeed,
      rotation: rotations[0],
      rotationExpected,
      speed: vectorLength(curveVelocity, 0),
      speedExpected,
      velocityAt30Hz,
      velocityAt60Hz,
    },
    orientToVelocity: {
      error: orientationError,
      expectedQuaternion: [0, 0, -halfSqrt, halfSqrt],
      expectedSpriteRotation: -Math.PI / 2,
      measuredQuaternion: [...orientation],
      measuredSpriteRotation: spriteOrientation[0],
    },
    pointAttractor: {
      distanceAfter,
      distanceBefore,
      emitterCenterAfterMove: [5, 0, 0],
      emitterCenterAtSpawn: [4, 0, 0],
      space: 'emitter',
    },
    positionSphereCenter: {
      center: [1, 0, 0],
      emitterOffset: [2, 0, 0],
      expectedWorldCenter: placementCenter,
      instancePosition: [4, 0, 0],
      maximumRadiusError: centerOnlyMaximumRadiusError,
      radius: 0.1,
    },
    positionSpherePlacement: {
      arc: { axis: [0, 1, 0], thetaMax: 90 },
      center: placementCenter,
      emitterOffset: [2, 0, 0],
      instancePosition: [4, 0, 0],
      maximumRadiusError: placementMaximumRadiusError,
      meanCosTheta: placementMeanCosTheta,
      meanRadius: placementMeanRadius,
      minimumCosTheta: placementMinimumCosTheta,
      radius: 0.1,
      surfaceOnly: false,
    },
    turbulence: {
      bitIdentical: bytesEqual(turbulenceA, turbulenceB),
      correction: 1 / SIMPLEX_EFFECTIVE_AMPLITUDE,
      effectiveSimplexAmplitude: SIMPLEX_EFFECTIVE_AMPLITUDE,
      maximumAcceleration: turbulenceMaximumAcceleration,
      strengthUpperBound: TURBULENCE_STRENGTH,
      variance: turbulenceVariance,
    },
    vectorField: {
      boundsMax: parsedField.boundsMax,
      boundsMin: parsedField.boundsMin,
      error: fieldError,
      samples: fieldSamples.map((sample, index) => ({
        ...sample,
        expectedVelocity: sample.expected.map((value) => value * STEP),
        measuredVelocity: fieldMeasured[index],
      })),
      resolution: parsedField.resolution,
      sampleCount: parsedField.vectors.length / 3,
    },
    validation,
    vortex: {
      axis: [0, 1, 0],
      expectedRightHandSign: 1,
      meanSignedAngularMomentum: signedAngularMomentum,
    },
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M4 behavior checks passed' : 'M4 checks failed';
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  statusValue.textContent = `Error: ${message}`;
});
