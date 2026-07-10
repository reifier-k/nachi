import {
  attribute,
  burst,
  colorOverLife,
  compileEmitter,
  curve,
  defineEmitter,
  defineParameter,
  gradient,
  gravity,
  lifetime,
  parameter,
  positionSphere,
  range,
  sampleCurve,
  sizeOverLife,
  tslModule,
  velocityCone,
} from '@nachi/core';
import type { KernelTslAdapter, ModuleDefinition } from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { createThreeKernelAdapter, readLogicalAttribute } from './three-kernel-adapter';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './spike-compute.css';

const DEFAULT_PARTICLE_COUNT = 64;
const DEFAULT_FRAMES = 24;
const FIXED_DELTA_SECONDS = 1 / 60;
const CURVE = curve([0, 0], [0.1, 1], [1, 0]);
const GRADIENT_COLORS = ['#ffd27d', '#ff5a00', '#000000'] as const;
const GRADIENT = gradient(...GRADIENT_COLORS);
const GRADIENT_LUT_WIDTH = 256;
const GRAVITY = -9.8;
const USER_GRAVITY_DEFAULT = -10;
const USER_GRAVITY_FALLBACK = 123;

type BackendName = 'WebGL2' | 'WebGPU';
type RendererBackendLike = {
  device?: {
    features?: { has(feature: string): boolean };
    limits?: { maxStorageBuffersPerShaderStage?: number };
    lost: Promise<{ message?: string; reason?: string }>;
  };
  isWebGPUBackend?: boolean;
};

const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const particleCount = readInteger('count', DEFAULT_PARTICLE_COUNT, 1, 4096);
const frames = readInteger('frames', DEFAULT_FRAMES, 1, 600);
const backendValue = requireElement<HTMLElement>('#backend-value');
const statusValue = requireElement<HTMLElement>('#status-value');
const sceneHost = requireElement<HTMLElement>('#scene');

root.dataset.backendRequested = requestedBackend;
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M1 kernel smoke element: ${selector}`);
  return element;
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const computeRender: ModuleDefinition<'render', Record<string, never>> = {
  access: { reads: [], writes: [] },
  config: {},
  kind: 'module',
  stage: 'render',
  type: 'test/m1-compute-only',
  version: 1,
};

const emitter = defineEmitter({
  capacity: particleCount,
  init: [
    positionSphere({ radius: 0.2 }),
    velocityCone({ angle: 20, direction: [0, 1, 0], speed: range(2, 3) }),
    lifetime(2),
  ],
  render: computeRender,
  spawn: burst({ count: particleCount }),
  update: [gravity(GRAVITY), colorOverLife(GRADIENT)],
});
const program = compileEmitter(emitter, {
  deltaTime: FIXED_DELTA_SECONDS,
  emitterSeed: 42,
  spawnGeneration: 0,
});

// Keep the mat3/bool storage proof in a separate emitter so the primary nine-check M1 smoke
// remains within common per-stage storage-buffer limits after lifecycle state is included.
const storageTypeProbeProgram = compileEmitter(
  defineEmitter({
    attributes: {
      enabled: attribute('enabled', { default: true, type: 'bool' }),
      frame: attribute('frame', {
        default: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        type: 'mat3',
      }),
    },
    capacity: 1,
    integration: 'none',
    render: computeRender,
    spawn: burst({ count: 1 }),
    update: [
      tslModule(
        ({ normalizedAge }) => ({
          normalizedAge: normalizedAge.add(1 / frames),
        }),
        { stage: 'update' },
      ),
      sizeOverLife(CURVE),
    ],
  }),
);

const userParameterEmitter = defineEmitter({
  capacity: 1,
  integration: 'none',
  parameters: {
    'User.gravity': defineParameter('User.gravity', {
      default: USER_GRAVITY_DEFAULT,
      type: 'f32',
    }),
  },
  render: computeRender,
  spawn: burst({ count: 1 }),
  update: [gravity(parameter('User.gravity', USER_GRAVITY_FALLBACK))],
});
const userParameterProgram = compileEmitter(userParameterEmitter, { deltaTime: 1 });

async function runProgram(renderer: THREE.WebGPURenderer, kernelAdapter: KernelTslAdapter) {
  const built = program.buildKernels(kernelAdapter);
  await renderer.computeAsync(built.init as never);
  const initial = {
    age: await readLogicalAttribute(renderer, program, built, 'age'),
    color: await readLogicalAttribute(renderer, program, built, 'color'),
    lifetime: await readLogicalAttribute(renderer, program, built, 'lifetime'),
    position: await readLogicalAttribute(renderer, program, built, 'position'),
    velocity: await readLogicalAttribute(renderer, program, built, 'velocity'),
  };
  const colorSamples: Array<{ frame: number; value: number[] }> = [];
  for (let frame = 0; frame < frames; frame += 1) {
    built.uniforms['System.time']!.value = (frame + 1) * FIXED_DELTA_SECONDS;
    await renderer.computeAsync(built.update as never);
    const completedFrame = frame + 1;
    if (
      completedFrame === 1 ||
      completedFrame === Math.max(1, Math.round(frames / 2)) ||
      completedFrame === frames
    ) {
      const color = await readLogicalAttribute(renderer, program, built, 'color');
      colorSamples.push({ frame: completedFrame, value: [...color.slice(0, 4)] });
    }
  }
  const final = {
    age: await readLogicalAttribute(renderer, program, built, 'age'),
    color: await readLogicalAttribute(renderer, program, built, 'color'),
    position: await readLogicalAttribute(renderer, program, built, 'position'),
    velocity: await readLogicalAttribute(renderer, program, built, 'velocity'),
  };
  return { colorSamples, final, initial };
}

async function runStorageTypeProbe(
  renderer: THREE.WebGPURenderer,
  kernelAdapter: KernelTslAdapter,
) {
  const built = storageTypeProbeProgram.buildKernels(kernelAdapter);
  await renderer.computeAsync(built.init as never);
  const initialSize = await readLogicalAttribute(renderer, storageTypeProbeProgram, built, 'size');
  const sizeSampleFrames = new Set([1, Math.max(1, Math.round(frames / 2)), frames]);
  const sizeSamples: Array<{ frame: number; value: number }> = [];
  for (let frame = 0; frame < frames; frame += 1) {
    await renderer.computeAsync(built.update as never);
    const completedFrame = frame + 1;
    if (sizeSampleFrames.has(completedFrame)) {
      const size = await readLogicalAttribute(renderer, storageTypeProbeProgram, built, 'size');
      sizeSamples.push({ frame: completedFrame, value: size[0] ?? Number.NaN });
    }
  }
  return {
    enabled: await readLogicalAttribute(renderer, storageTypeProbeProgram, built, 'enabled'),
    frame: await readLogicalAttribute(renderer, storageTypeProbeProgram, built, 'frame'),
    initialSize: initialSize[0] ?? Number.NaN,
    sizeSamples,
  };
}

async function runUserParameterProgram(
  renderer: THREE.WebGPURenderer,
  kernelAdapter: KernelTslAdapter,
) {
  const built = userParameterProgram.buildKernels(kernelAdapter);
  await renderer.computeAsync(built.init as never);
  const initial = await readLogicalAttribute(renderer, userParameterProgram, built, 'velocity');
  await renderer.computeAsync(built.update as never);
  const afterDefault = await readLogicalAttribute(
    renderer,
    userParameterProgram,
    built,
    'velocity',
  );
  return {
    afterDefault: afterDefault[1] ?? Number.NaN,
    initial: initial[1] ?? Number.NaN,
    uniformDefault: Number(built.uniforms['User.gravity']?.value),
  };
}

function equalArrays(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return (
    left.length === right.length && Array.from(left).every((value, index) => value === right[index])
  );
}

function nearlyEqual(left: number, right: number, tolerance = 0.0002): boolean {
  return Math.abs(left - right) <= tolerance;
}

function linearRgba(hexColor: string): number[] {
  const hex = hexColor.slice(1);
  const toLinear = (value: number) => {
    const channel = value / 255;
    return channel < 0.04045
      ? channel * 0.0773993808
      : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
  };
  return [
    toLinear(Number.parseInt(hex.slice(0, 2), 16)),
    toLinear(Number.parseInt(hex.slice(2, 4), 16)),
    toLinear(Number.parseInt(hex.slice(4, 6), 16)),
    1,
  ];
}

function buildGradientReferenceLut(colors: readonly string[], width: number): Float32Array {
  const rgba = colors.map(linearRgba);
  const data = new Float32Array(width * 4);
  for (let index = 0; index < width; index += 1) {
    const scaled = (index / (width - 1)) * (rgba.length - 1);
    const leftIndex = Math.min(Math.floor(scaled), rgba.length - 1);
    const rightIndex = Math.min(leftIndex + 1, rgba.length - 1);
    const alpha = scaled - leftIndex;
    for (let channel = 0; channel < 4; channel += 1) {
      const left = rgba[leftIndex]?.[channel] ?? Number.NaN;
      const right = rgba[rightIndex]?.[channel] ?? Number.NaN;
      data[index * 4 + channel] = left + (right - left) * alpha;
    }
  }
  return data;
}

function sampleRgbaLut(
  data: Float32Array,
  width: number,
  coordinate: number,
  linear: boolean,
): number[] {
  const texel = Math.min(Math.max(coordinate, 0), 1) * (width - 1);
  const read = (index: number, channel: number) => data[index * 4 + channel] ?? Number.NaN;
  if (!linear) {
    const index = Math.min(Math.round(texel), width - 1);
    return [0, 1, 2, 3].map((channel) => read(index, channel));
  }
  const left = Math.floor(texel);
  const right = Math.min(left + 1, width - 1);
  const alpha = texel - left;
  return [0, 1, 2, 3].map(
    (channel) => read(left, channel) + (read(right, channel) - read(left, channel)) * alpha,
  );
}

async function runSmoke(): Promise<void> {
  if (requestedBackend === 'webgl') {
    const error =
      'NACHI_M1_KERNEL_WEBGPU_ONLY: The M1 kernel smoke is WebGPU-only; WebGL2 transform-feedback limits are intentionally gated.';
    backendValue.textContent = 'WebGL2 (unsupported)';
    root.dataset.backend = 'WebGL2';
    root.dataset.rendererStatus = 'unsupported';
    root.dataset.spikeError = error;
    root.dataset.spikeResult = JSON.stringify({
      computeOk: false,
      error,
      ok: false,
      requestedBackend,
    });
    root.dataset.spikeStatus = 'error';
    root.dataset.sceneReady = 'true';
    statusValue.textContent = error;
    return;
  }
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: false,
    trackTimestamp: true,
  });
  if (!headless) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    sceneHost.append(renderer.domElement);
  }
  await renderer.init();
  const backend = renderer.backend as RendererBackendLike;
  const activeBackend: BackendName = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  const expectedBackend: BackendName = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (activeBackend !== expectedBackend) {
    throw new Error(`Backend mismatch: requested ${expectedBackend}, active ${activeBackend}.`);
  }
  backendValue.textContent = activeBackend;
  root.dataset.backend = activeBackend;
  root.dataset.rendererStatus = 'ready';
  const storageBufferLimit = backend.device?.limits?.maxStorageBuffersPerShaderStage;
  const linearFloat32Filtering =
    !backend.isWebGPUBackend || backend.device?.features?.has('float32-filterable') === true;
  // Windows real-GPU smoke must confirm the optional linear path; unsupported adapters use
  // nearest filtering so float32 LUT creation remains valid without float32-filterable.
  root.dataset.lutFilter = linearFloat32Filtering ? 'linear' : 'nearest';
  const kernelAdapter = createThreeKernelAdapter({
    linearFloat32Filtering,
    ...(storageBufferLimit === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: storageBufferLimit }),
  });
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute'],
    mode: headless ? 'headless' : 'visual',
    page: 'm1-kernel',
  });

  if (backend.device) {
    void backend.device.lost.then((info) => {
      const reason = info.reason ?? 'unknown';
      root.dataset.deviceLostReason = reason;
      root.dataset.deviceLostMessage = info.message ?? '';
      root.dataset.rendererStatus = 'device-lost';
      root.dataset.spikeStatus = 'device-lost';
    });
  }

  root.dataset.spikeStatus = 'running';
  statusValue.textContent = 'Compiling and executing kernels…';
  const first = await runProgram(renderer, kernelAdapter);
  const second = await runProgram(renderer, kernelAdapter);
  const storageTypeProbe = await runStorageTypeProbe(renderer, kernelAdapter);
  const userParameter = await runUserParameterProgram(renderer, kernelAdapter);
  const expectedAge = frames * FIXED_DELTA_SECONDS;
  const lifetimeValue = first.initial.lifetime[0] ?? 1;
  const sizeLutSamples = storageTypeProbe.sizeSamples.map(({ frame, value }) => {
    const normalizedAge = frame / frames;
    const expected = sampleCurve(CURVE, normalizedAge);
    return { expected, frame, ok: Math.abs(value - expected) < 0.02, value };
  });
  const gradientLut = buildGradientReferenceLut(GRADIENT_COLORS, GRADIENT_LUT_WIDTH);
  const colorLutSamples = first.colorSamples.map(({ frame, value }) => {
    const normalizedAge = Math.min((frame * FIXED_DELTA_SECONDS) / lifetimeValue, 1);
    const expected = sampleRgbaLut(
      gradientLut,
      GRADIENT_LUT_WIDTH,
      normalizedAge,
      linearFloat32Filtering,
    );
    return {
      expected,
      frame,
      ok: value.every((channel, index) => nearlyEqual(channel, expected[index]!, 0.002)),
      value,
    };
  });
  const initialVelocity = [
    first.initial.velocity[0] ?? Number.NaN,
    first.initial.velocity[1] ?? Number.NaN,
    first.initial.velocity[2] ?? Number.NaN,
  ];
  const initialPosition = [
    first.initial.position[0] ?? Number.NaN,
    first.initial.position[1] ?? Number.NaN,
    first.initial.position[2] ?? Number.NaN,
  ];
  const elapsed = frames * FIXED_DELTA_SECONDS;
  const expectedVelocity = [
    initialVelocity[0]!,
    initialVelocity[1]! + GRAVITY * elapsed,
    initialVelocity[2]!,
  ];
  const expectedPosition = [
    initialPosition[0]! + initialVelocity[0]! * elapsed,
    initialPosition[1]! +
      initialVelocity[1]! * elapsed +
      GRAVITY * FIXED_DELTA_SECONDS ** 2 * ((frames * (frames + 1)) / 2),
    initialPosition[2]! + initialVelocity[2]! * elapsed,
  ];
  const finalVelocity = [...first.final.velocity.slice(0, 3)];
  const finalPosition = [...first.final.position.slice(0, 3)];
  const gravityVelocityMatchesCpu = finalVelocity.every((value, index) =>
    nearlyEqual(value, expectedVelocity[index]!, 0.002),
  );
  const integratePositionMatchesCpu = finalPosition.every((value, index) =>
    nearlyEqual(value, expectedPosition[index]!, 0.002),
  );
  const validation = {
    defaultsOk: (first.initial.age[0] ?? Number.NaN) === 0 && storageTypeProbe.initialSize === 1,
    deterministic:
      equalArrays(first.final.position, second.final.position) &&
      equalArrays(first.final.velocity, second.final.velocity) &&
      equalArrays(first.final.age, second.final.age) &&
      equalArrays(first.final.color, second.final.color),
    gradientLutOk: colorLutSamples.every(({ ok: sampleOk }) => sampleOk),
    gravityVelocityMatchesCpu,
    integratePositionMatchesCpu,
    lifetimeAdvanced: Math.abs((first.final.age[0] ?? Number.NaN) - expectedAge) < 0.0001,
    mat3BoolOk:
      (storageTypeProbe.enabled[0] ?? 0) === 1 &&
      (storageTypeProbe.frame[0] ?? 0) === 1 &&
      // Logical readback removes the vec4 padding from the physical mat3 columns.
      (storageTypeProbe.frame[4] ?? 0) === 1 &&
      (storageTypeProbe.frame[8] ?? 0) === 1,
    sizeLutOk: sizeLutSamples.every(({ ok: sampleOk }) => sampleOk),
    userParameterDefaultOk:
      userParameter.initial === 0 &&
      userParameter.uniformDefault === USER_GRAVITY_DEFAULT &&
      nearlyEqual(userParameter.afterDefault, USER_GRAVITY_DEFAULT),
  };
  const ok = Object.values(validation).every(Boolean);
  const result = {
    activeBackend,
    colorLutSamples,
    computeOk: ok,
    compileDiagnostics: [
      ...program.diagnostics,
      ...storageTypeProbeProgram.diagnostics,
      ...userParameterProgram.diagnostics,
    ],
    cpuIntegrationReference: {
      expectedPosition,
      expectedVelocity,
      finalPosition,
      finalVelocity,
    },
    frames,
    mode: headless ? 'headless' : 'visual',
    ok,
    particleCount,
    requestedBackend,
    sizeLutSamples,
    userParameter,
    validation,
  };
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  statusValue.textContent = ok ? 'M1 kernel smoke complete' : 'M1 kernel validation failed';
}

void runSmoke().catch((error) => {
  const errorText = message(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = errorText;
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeResult = JSON.stringify({
    computeOk: false,
    error: errorText,
    ok: false,
    requestedBackend,
  });
  statusValue.textContent = `Error: ${errorText}`;
});
