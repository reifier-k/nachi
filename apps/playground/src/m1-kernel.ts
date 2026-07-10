import {
  attribute,
  burst,
  colorOverLife,
  compileEmitter,
  curlNoise,
  curve,
  defineEmitter,
  drag,
  gradient,
  gravity,
  lifetime,
  positionSphere,
  range,
  sampleCurve,
  sizeOverLife,
  velocityCone,
} from '@nachi/core';
import type {
  BakedLut,
  KernelNode,
  KernelStorageNode,
  KernelTslAdapter,
  ModuleDefinition,
  TslStorageType,
} from '@nachi/core';
import * as THREE from 'three/webgpu';
import {
  Fn,
  cos,
  float,
  instanceIndex,
  instancedArray,
  int,
  mat3,
  mat4,
  sin,
  texture,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './spike-compute.css';

const DEFAULT_PARTICLE_COUNT = 64;
const DEFAULT_FRAMES = 24;
const FIXED_DELTA_SECONDS = 1 / 60;
const CURVE = curve([0, 0], [0.1, 1], [1, 0]);

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

function asNode(value: unknown): KernelNode {
  return value as KernelNode;
}

function vectorValues(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`Expected a ${length}-component value.`);
  }
  return value.map(Number);
}

function constantNode(
  value: unknown,
  type: Parameters<KernelTslAdapter['constant']>[1],
): KernelNode {
  switch (type) {
    case 'bool':
      return asNode(uint(value ? 1 : 0));
    case 'i32':
      return asNode(int(Number(value)));
    case 'u32':
      return asNode(uint(Number(value)));
    case 'f32':
      return asNode(float(Number(value)));
    case 'vec2': {
      const values = vectorValues(value, 2);
      return asNode(vec2(values[0], values[1]));
    }
    case 'vec3': {
      const values = vectorValues(value, 3);
      return asNode(vec3(values[0], values[1], values[2]));
    }
    case 'color':
    case 'quat':
    case 'vec4': {
      const values = vectorValues(value, 4);
      return asNode(vec4(values[0], values[1], values[2], values[3]));
    }
    case 'mat3': {
      const values = vectorValues(value, 9);
      const create = mat3 as unknown as (...components: number[]) => unknown;
      return asNode(create(...values));
    }
    case 'mat4': {
      const values = vectorValues(value, 16);
      const create = mat4 as unknown as (...components: number[]) => unknown;
      return asNode(create(...values));
    }
  }
}

function uniformValue(value: unknown, type: Parameters<KernelTslAdapter['uniform']>[1]): unknown {
  if (type === 'mat3') return new THREE.Matrix3().fromArray(vectorValues(value, 9));
  if (type === 'mat4') return new THREE.Matrix4().fromArray(vectorValues(value, 16));
  if (type === 'vec2') return new THREE.Vector2().fromArray(vectorValues(value, 2));
  if (type === 'vec3') return new THREE.Vector3().fromArray(vectorValues(value, 3));
  if (type === 'vec4') {
    return new THREE.Vector4().fromArray(vectorValues(value, 4));
  }
  if (type === 'uint' && typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function createDataTexture(lut: BakedLut, linearFloat32Filtering: boolean): THREE.DataTexture {
  const format = lut.channels === 1 ? THREE.RedFormat : THREE.RGBAFormat;
  const dataTexture = new THREE.DataTexture(lut.data, lut.width, 1, format, THREE.FloatType);
  const filter = linearFloat32Filtering ? THREE.LinearFilter : THREE.NearestFilter;
  dataTexture.minFilter = filter;
  dataTexture.magFilter = filter;
  dataTexture.wrapS = THREE.ClampToEdgeWrapping;
  dataTexture.wrapT = THREE.ClampToEdgeWrapping;
  dataTexture.needsUpdate = true;
  return dataTexture;
}

const createInstancedArray = instancedArray as unknown as (
  length: number,
  type: TslStorageType,
) => unknown;
const createUniform = uniform as unknown as (value: unknown, type: string) => unknown;

const adapter: KernelTslAdapter = {
  instanceIndex: asNode(instanceIndex),
  constant: constantNode,
  cos: (value) => asNode(cos(value as never)),
  dataTexture: (lut) => createDataTexture(lut, false),
  fn: (callback) => Fn(callback)() as unknown as ReturnType<KernelTslAdapter['fn']>,
  instancedArray: (length: number, type: TslStorageType) =>
    createInstancedArray(length, type) as KernelStorageNode,
  sampleTexture: (value, uv) => asNode(texture(value as THREE.Texture, uv as never)),
  sin: (value) => asNode(sin(value as never)),
  uniform: (value, type) =>
    createUniform(uniformValue(value, type), type) as ReturnType<KernelTslAdapter['uniform']>,
  uint: (value) => asNode(uint(value as never)),
  vec2: (x, y) => asNode(vec2(x as never, y as never)),
  vec3: (x, y, z) => asNode(vec3(x as never, y as never, z as never)),
  vec4: (x, y, z, w) => asNode(vec4(x as never, y as never, z as never, w as never)),
};

const computeRender: ModuleDefinition<'render', Record<string, never>> = {
  access: { reads: [], writes: [] },
  config: {},
  kind: 'module',
  stage: 'render',
  type: 'test/m1-compute-only',
  version: 1,
};

const emitter = defineEmitter({
  attributes: {
    enabled: attribute('enabled', { default: true, type: 'bool' }),
    frame: attribute('frame', {
      default: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      type: 'mat3',
    }),
  },
  capacity: particleCount,
  init: [
    positionSphere({ radius: 0.2 }),
    velocityCone({ angle: 20, direction: [0, 1, 0], speed: range(2, 3) }),
    lifetime(2),
  ],
  render: computeRender,
  spawn: burst({ count: particleCount }),
  update: [
    gravity(-9.8),
    drag(0.05),
    curlNoise({ frequency: 0.5, strength: 0.1 }),
    sizeOverLife(CURVE),
    colorOverLife(gradient('#ffd27d', '#ff5a00', '#000000')),
  ],
});
const program = compileEmitter(emitter, {
  deltaTime: FIXED_DELTA_SECONDS,
  emitterSeed: 42,
  spawnGeneration: 0,
});

async function readStorage(
  renderer: THREE.WebGPURenderer,
  storage: KernelStorageNode,
  type: 'float' | 'uint',
): Promise<Float32Array | Uint32Array> {
  const buffer = await renderer.getArrayBufferAsync(storage.value as never);
  return type === 'uint' ? new Uint32Array(buffer) : new Float32Array(buffer);
}

async function runProgram(renderer: THREE.WebGPURenderer, kernelAdapter: KernelTslAdapter) {
  const built = program.buildKernels(kernelAdapter);
  await renderer.computeAsync(built.init as never);
  const initial = {
    age: await readStorage(renderer, built.storages.age!, 'float'),
    enabled: await readStorage(renderer, built.storages.enabled!, 'uint'),
    frame: await readStorage(renderer, built.storages.frame!, 'float'),
    lifetime: await readStorage(renderer, built.storages.lifetime!, 'float'),
    position: await readStorage(renderer, built.storages.position!, 'float'),
    size: await readStorage(renderer, built.storages.size!, 'float'),
    velocity: await readStorage(renderer, built.storages.velocity!, 'float'),
  };
  const sizeSampleFrames = new Set([1, Math.max(1, Math.round(frames / 2)), frames]);
  const sizeSamples: Array<{ frame: number; value: number }> = [];
  for (let frame = 0; frame < frames; frame += 1) {
    built.uniforms['System.time']!.value = (frame + 1) * FIXED_DELTA_SECONDS;
    await renderer.computeAsync(built.update as never);
    const completedFrame = frame + 1;
    if (sizeSampleFrames.has(completedFrame)) {
      const size = await readStorage(renderer, built.storages.size!, 'float');
      sizeSamples.push({ frame: completedFrame, value: size[0] ?? Number.NaN });
    }
  }
  const final = {
    age: await readStorage(renderer, built.storages.age!, 'float'),
    position: await readStorage(renderer, built.storages.position!, 'float'),
    size: await readStorage(renderer, built.storages.size!, 'float'),
    velocity: await readStorage(renderer, built.storages.velocity!, 'float'),
  };
  return { final, initial, sizeSamples };
}

function equalArrays(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return (
    left.length === right.length && Array.from(left).every((value, index) => value === right[index])
  );
}

async function runSmoke(): Promise<void> {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
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
  const kernelAdapter: KernelTslAdapter =
    storageBufferLimit === undefined
      ? {
          ...adapter,
          dataTexture: (lut) => createDataTexture(lut, linearFloat32Filtering),
        }
      : {
          ...adapter,
          dataTexture: (lut) => createDataTexture(lut, linearFloat32Filtering),
          deviceLimits: { maxStorageBuffersPerShaderStage: storageBufferLimit },
        };
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
  const expectedAge = frames * FIXED_DELTA_SECONDS;
  const lifetimeValue = first.initial.lifetime[0] ?? 1;
  const sizeLutSamples = first.sizeSamples.map(({ frame, value }) => {
    const normalizedAge = Math.min((frame * FIXED_DELTA_SECONDS) / lifetimeValue, 1);
    const expected = sampleCurve(CURVE, normalizedAge);
    return { expected, frame, ok: Math.abs(value - expected) < 0.02, value };
  });
  const validation = {
    defaultsOk:
      (first.initial.age[0] ?? Number.NaN) === 0 && (first.initial.size[0] ?? Number.NaN) === 1,
    deterministic:
      equalArrays(first.final.position, second.final.position) &&
      equalArrays(first.final.velocity, second.final.velocity) &&
      equalArrays(first.final.age, second.final.age) &&
      equalArrays(first.final.size, second.final.size),
    gravityVelocityChanged:
      (first.final.velocity[1] ?? Number.NaN) < (first.initial.velocity[1] ?? Number.NaN),
    integratePositionAdvanced:
      (first.final.position[1] ?? Number.NaN) !== (first.initial.position[1] ?? Number.NaN),
    lifetimeAdvanced: Math.abs((first.final.age[0] ?? Number.NaN) - expectedAge) < 0.0001,
    mat3BoolOk:
      (first.initial.enabled[0] ?? 0) === 1 &&
      (first.initial.frame[0] ?? 0) === 1 &&
      // Storage-buffer mat3 columns are vec4-aligned: 9 logical values occupy stride 12.
      (first.initial.frame[5] ?? 0) === 1 &&
      (first.initial.frame[10] ?? 0) === 1,
    sizeLutOk: sizeLutSamples.every(({ ok: sampleOk }) => sampleOk),
  };
  const ok = Object.values(validation).every(Boolean);
  const result = {
    activeBackend,
    computeOk: ok,
    compileDiagnostics: program.diagnostics,
    frames,
    mode: headless ? 'headless' : 'visual',
    ok,
    particleCount,
    requestedBackend,
    sizeLutSamples,
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
