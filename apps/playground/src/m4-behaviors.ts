import {
  VFXSystem,
  billboard,
  burst,
  curve,
  defineEffect,
  defineEmitter,
  defineParameter,
  killVolume,
  lifetime,
  linearForce,
  parameter,
  pointAttractor,
  positionSphere,
  rotationOverLife,
  turbulence,
  velocityCone,
  velocityOverLife,
  vortex,
} from '@nachi/core';
import type { UpdateModule, Vec3, VfxEmitterRuntimeView } from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  readLogicalAttribute,
} from './three-kernel-adapter';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m3-sprites.css';

const STEP = 1 / 60;
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
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
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

  const kernelAdapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
  });
  const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter, backend.device?.lost);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute'],
    mode: headless ? 'headless' : 'visual',
    page: 'm4-behaviors',
  });

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
    return { system, view };
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
  let angularMomentum = 0;
  for (let index = 0; index < 12; index += 1) {
    const offset = index * 3;
    angularMomentum += Math.abs(
      (vortexPosition[offset] ?? 0) * (vortexVelocity[offset + 2] ?? 0) -
        (vortexPosition[offset + 2] ?? 0) * (vortexVelocity[offset] ?? 0),
    );
  }
  angularMomentum /= 12;

  const attractorRun = await spawn(
    {
      capacity: 8,
      integration: 'euler',
      positionRadius: 2,
      surfaceOnly: true,
      update: [pointAttractor({ falloff: 0, position: [0, 0, 0], strength: 30 })],
    },
    12,
  );
  const attractorBefore = (await readLogicalAttribute(
    renderer,
    attractorRun.view.program,
    attractorRun.view.kernels,
    'position',
  )) as Float32Array;
  await attractorRun.system.update(STEP);
  const attractorAfter = (await readLogicalAttribute(
    renderer,
    attractorRun.view.program,
    attractorRun.view.kernels,
    'position',
  )) as Float32Array;
  const meanDistance = (values: Float32Array) => {
    let total = 0;
    for (let index = 0; index < 8; index += 1) total += vectorLength(values, index * 3);
    return total / 8;
  };
  const distanceBefore = meanDistance(attractorBefore);
  const distanceAfter = meanDistance(attractorAfter);

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
        update: [turbulence({ frequency: 1.7, octaves: 3, strength: 2 })],
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

  const validation = {
    consoleClean: consoleMessages.length === 0,
    killVolume: aliveBefore === 6 && aliveAfter === 0,
    linearForce: linearError < 0.00001,
    overLifeCurves: curveError < 0.002,
    pointAttractor: distanceAfter < distanceBefore - 0.001,
    turbulence: bytesEqual(turbulenceA, turbulenceB) && turbulenceVariance > 1e-8,
    vortex: angularMomentum > 0.001,
  };
  const result = {
    consoleMessages,
    killVolume: { aliveAfter, aliveBefore },
    linearForce: { error: linearError, expectedVelocity, measuredVelocity: [...linearVelocity] },
    mode: headless ? 'headless' : 'visual',
    ok: Object.values(validation).every(Boolean),
    overLife: {
      error: curveError,
      rotation: rotations[0],
      rotationExpected,
      speed: vectorLength(curveVelocity, 0),
      speedExpected,
    },
    pointAttractor: { distanceAfter, distanceBefore },
    turbulence: {
      bitIdentical: bytesEqual(turbulenceA, turbulenceB),
      variance: turbulenceVariance,
    },
    validation,
    vortex: { meanAbsoluteAngularMomentum: angularMomentum },
  };
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
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
