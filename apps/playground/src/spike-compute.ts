import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  atomicAdd,
  atomicLoad,
  atomicStore,
  color,
  cos,
  float,
  hash,
  instanceIndex,
  instancedArray,
  mix,
  sin,
  smoothstep,
  storage,
  uint,
  uniform,
  vec3,
} from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './spike-compute.css';

const DEFAULT_PARTICLE_COUNT = 100_000;
const DEFAULT_HEADLESS_FRAMES = 120;
const MAX_PARTICLE_COUNT = 1_000_000;
const FIXED_DELTA_SECONDS = 1 / 60;
const WORKGROUP_SIZE = 64;
const METRIC_WINDOW = 60;
const TIMING_NOTE =
  'encodeMs measures computeAsync CPU encode/submission wall time, not GPU execution. Timestamp-query GPU time is reported separately in data-perf-result.gpu when the selected adapter supports it.';

type BackendName = 'WebGL2' | 'WebGPU';
type CapabilityStatus = 'error' | 'supported' | 'unsupported';

type CapabilityResult = {
  status: CapabilityStatus;
  detail: string;
  error?: string;
};

type SupportMatrix = {
  instancedArrayCompute: CapabilityResult;
  atomics: CapabilityResult;
  indirectDraw: CapabilityResult;
  dispatchIndirect: CapabilityResult;
  readback: CapabilityResult;
};

type DeviceLostInfoLike = {
  message?: string;
  reason?: string;
};

type AdapterInfoLike = {
  architecture?: string;
  description?: string;
  device?: string;
  vendor?: string;
};

type RendererBackendLike = {
  adapter?: { info?: AdapterInfoLike };
  device?: { lost: Promise<DeviceLostInfoLike> };
  isWebGPUBackend?: boolean;
};

type ReadbackValidation = {
  activeAge: number;
  activePosition: number[];
  ageAdvanced: boolean;
  aliveCount: number | null;
  atomicOk: boolean;
  branchesOk: boolean;
  dispatchArgs: number[] | null;
  dispatchBoundaryValue: number | null;
  dispatchIndirectOk: boolean;
  dispatchInvocationCount: number | null;
  dispatchLastInvocationValue: number | null;
  expectedAliveCount: number;
  inactiveAge: number;
  inactiveY: number;
  indirectArgs: number[] | null;
  indirectOk: boolean;
  positionOk: boolean;
  sentinelOk: boolean;
};

type TimingStats = {
  encodeMs: number;
  p95EncodeMs: number;
  fps?: number;
  frameMs?: number;
};

type SpikeResult = {
  ok: boolean;
  activeBackend: BackendName;
  atomicOk: boolean;
  computeOk: boolean;
  dispatchIndirectOk: boolean;
  drawExecuted: boolean;
  drawPath: 'directInstancedCpuCount' | 'drawIndexedIndirect';
  indirectOk: boolean;
  measurementFrames: number;
  mode: 'headless' | 'visual';
  particleCount: number;
  renderedFrames: number;
  requestedBackend: 'webgl' | 'webgpu';
  stats: TimingStats;
  supportMatrix: SupportMatrix;
  timingNote: string;
  validation: ReadbackValidation;
};

const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const headless = query.get('headless') === '1';
const requestedBackend = readBackendParameter();
const particleCount = readIntegerParameter('count', DEFAULT_PARTICLE_COUNT, 2, MAX_PARTICLE_COUNT);
const headlessFrames = readIntegerParameter('frames', DEFAULT_HEADLESS_FRAMES, 1, 10_000);

root.dataset.backendRequested = requestedBackend;
root.dataset.headless = String(headless);
root.dataset.particleCount = String(particleCount);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

const sceneHost = requireElement<HTMLDivElement>('#scene');
const particleValue = requireElement<HTMLElement>('#particle-value');
const aliveValue = requireElement<HTMLElement>('#alive-value');
const fpsValue = requireElement<HTMLElement>('#fps-value');
const frameValue = requireElement<HTMLElement>('#frame-value');
const encodeValue = requireElement<HTMLElement>('#compute-value');
const drawValue = requireElement<HTMLElement>('#draw-value');
const statusValue = requireElement<HTMLElement>('#status-value');

particleValue.textContent = particleCount.toLocaleString();

class RollingAverage {
  readonly #values: number[] = [];

  constructor(readonly capacity: number) {}

  push(value: number): void {
    this.#values.push(value);
    if (this.#values.length > this.capacity) this.#values.shift();
  }

  mean(): number {
    if (this.#values.length === 0) return 0;
    return this.#values.reduce((sum, value) => sum + value, 0) / this.#values.length;
  }

  values(): readonly number[] {
    return this.#values;
  }
}

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing spike UI element: ${selector}`);
  return element;
}

function readBackendParameter(): 'webgl' | 'webgpu' {
  const value = query.get('backend')?.toLowerCase() ?? 'webgpu';
  if (value !== 'webgl' && value !== 'webgpu') {
    throw new Error('backend must be either "webgpu" or "webgl".');
  }
  return value;
}

function readIntegerParameter(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = query.get(name);
  if (rawValue === null) return fallback;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(Math.ceil(ordered.length * 0.95) - 1, ordered.length - 1)] ?? 0;
}

function computeAliveLimit(timeSeconds: number): number {
  return Math.floor(particleCount * (0.72 + Math.sin(timeSeconds * 0.65) * 0.2));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
}

function capability(status: CapabilityStatus, detail: string, error?: unknown): CapabilityResult {
  return error === undefined ? { detail, status } : { detail, error: errorMessage(error), status };
}

function createEmptySupportMatrix(): SupportMatrix {
  const pending = (): CapabilityResult => capability('error', 'Probe has not run yet.');
  return {
    instancedArrayCompute: pending(),
    atomics: pending(),
    indirectDraw: pending(),
    dispatchIndirect: pending(),
    readback: pending(),
  };
}

function setMetrics(frameMs: number | null, encodeMs: number, aliveCount: number): void {
  root.dataset.encodeMs = encodeMs.toFixed(3);
  root.dataset.aliveCount = String(aliveCount);
  delete root.dataset.computeMs;
  encodeValue.textContent = `${encodeMs.toFixed(2)} ms`;
  aliveValue.textContent = aliveCount.toLocaleString();

  if (frameMs === null) {
    delete root.dataset.fps;
    delete root.dataset.frameMs;
    fpsValue.textContent = 'N/A (headless)';
    frameValue.textContent = 'N/A (headless)';
    return;
  }

  const fps = frameMs > 0 ? 1000 / frameMs : 0;
  root.dataset.frameMs = frameMs.toFixed(3);
  root.dataset.fps = fps.toFixed(3);
  frameValue.textContent = `${frameMs.toFixed(2)} ms`;
  fpsValue.textContent = fps.toFixed(1);
}

function publishResult(result: SpikeResult): void {
  root.dataset.atomicOk = String(result.atomicOk);
  root.dataset.computeOk = String(result.computeOk);
  root.dataset.dispatchIndirectOk = String(result.dispatchIndirectOk);
  root.dataset.drawExecuted = String(result.drawExecuted);
  root.dataset.indirectOk = String(result.indirectOk);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.supportMatrix = JSON.stringify(result.supportMatrix);
}

function recordFailure(error: unknown): void {
  const message = errorMessage(error);
  root.dataset.spikeError = message;
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeResult = JSON.stringify({
    atomicOk: false,
    computeOk: false,
    dispatchIndirectOk: false,
    drawExecuted: false,
    error: message,
    indirectOk: false,
    mode: headless ? 'headless' : 'visual',
    ok: false,
    particleCount,
    requestedBackend,
  });
  statusValue.textContent = `Error: ${message}`;
}

function installWebGlShaderErrorTrap(renderer: THREE.WebGPURenderer): void {
  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    const programLog = gl.getProgramInfoLog(program)?.trim() || 'Program link failed.';
    const vertexLog = gl.getShaderInfoLog(vertexShader)?.trim();
    const fragmentLog = gl.getShaderInfoLog(fragmentShader)?.trim();
    throw new Error([programLog, vertexLog, fragmentLog].filter(Boolean).join('\n'));
  };
}

async function runSpike(): Promise<void> {
  const renderer = await createPlaygroundRenderer({
    antialias: !headless,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  if (!headless) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  if (activeBackend === 'WebGL2') installWebGlShaderErrorTrap(renderer);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'spike-compute',
  });

  root.dataset.backend = activeBackend;
  root.dataset.rendererStatus = 'ready';
  if (backend.adapter?.info) root.dataset.adapterInfo = JSON.stringify(backend.adapter.info);

  let deviceLost = false;
  if (backend.device) {
    void backend.device.lost.then((info) => {
      deviceLost = true;
      const reason = info.reason ?? 'unknown';
      const message = info.message ?? '';
      root.dataset.deviceLostMessage = message;
      root.dataset.deviceLostReason = reason;
      root.dataset.rendererStatus = 'device-lost';
      root.dataset.spikeStatus = 'device-lost';
      root.dataset.spikeResult = JSON.stringify({
        atomicOk: false,
        computeOk: false,
        dispatchIndirectOk: false,
        drawExecuted: false,
        error: `WebGPU device lost (${reason})${message ? `: ${message}` : ''}`,
        indirectOk: false,
        mode: headless ? 'headless' : 'visual',
        ok: false,
        particleCount,
        requestedBackend,
      });
      statusValue.textContent = `Device lost (${reason})`;
      void renderer.setAnimationLoop(null);
    });
  }

  const supportMatrix = createEmptySupportMatrix();
  const positions = instancedArray(particleCount, 'vec3').setName('ParticlePositions');
  const velocities = instancedArray(particleCount, 'vec3').setName('ParticleVelocities');
  const ages = instancedArray(particleCount, 'float').setName('ParticleAges');
  const lifetimes = instancedArray(particleCount, 'float').setName('ParticleLifetimes');
  const aliveCounter = instancedArray(new Uint32Array(1), 'uint')
    .toAtomic()
    .setName('AliveCounter');

  const geometry = new THREE.PlaneGeometry(0.075, 0.075);
  const indexCount = geometry.index?.count ?? 6;
  const drawIndirectAttribute = new THREE.IndirectStorageBufferAttribute(
    new Uint32Array([indexCount, 0, 0, 0, 0]),
    1,
  );
  const drawIndirectArguments = storage(drawIndirectAttribute, 'uint', 5).setName(
    'DrawIndirectArgs',
  );
  const dispatchIndirectAttribute = new THREE.IndirectStorageBufferAttribute(
    new Uint32Array([1, 1, 1]),
    1,
  );
  const dispatchIndirectArguments = storage(dispatchIndirectAttribute, 'uint', 3).setName(
    'DispatchIndirectArgs',
  );
  const dispatchOutputCount = Math.ceil(particleCount / WORKGROUP_SIZE) * WORKGROUP_SIZE + 1;
  const dispatchOutput = instancedArray(new Uint32Array(dispatchOutputCount), 'uint').setName(
    'DispatchIndirectOutput',
  );
  if (activeBackend === 'WebGPU') geometry.setIndirect(drawIndirectAttribute);

  const deltaSeconds = uniform(FIXED_DELTA_SECONDS);
  const simulationTime = uniform(0);
  const aliveLimit = uniform(computeAliveLimit(0), 'uint');

  const initializeKernel = Fn(() => {
    const index = float(instanceIndex);
    const angle = hash(index.add(11)).mul(Math.PI * 2);
    const radius = hash(index.add(37)).sqrt().mul(3.2);
    const height = hash(index.add(71)).mul(4).sub(2);
    const lifetime = hash(index.add(109)).mul(3.5).add(2.5);

    positions
      .element(instanceIndex)
      .assign(vec3(cos(angle).mul(radius), height, sin(angle).mul(radius)));
    velocities
      .element(instanceIndex)
      .assign(
        vec3(
          hash(index.add(149)).sub(0.5),
          hash(index.add(181)).mul(1.4).add(0.4),
          hash(index.add(211)).sub(0.5),
        ),
      );
    ages
      .element(instanceIndex)
      .assign(instanceIndex.equal(uint(0)).select(float(0), hash(index.add(241)).mul(lifetime)));
    lifetimes.element(instanceIndex).assign(lifetime);
  })()
    .compute(particleCount, [WORKGROUP_SIZE])
    .setName('InitializeParticles');

  const createSimulationKernel = (withAtomics: boolean) =>
    Fn(() => {
      const position = positions.element(instanceIndex);
      const velocity = velocities.element(instanceIndex);
      const age = ages.element(instanceIndex);
      const lifetime = lifetimes.element(instanceIndex);
      const index = float(instanceIndex);

      If(instanceIndex.lessThan(aliveLimit), () => {
        if (withAtomics) atomicAdd(aliveCounter.element(uint(0)), uint(1));

        If(age.lessThan(0).or(age.greaterThanEqual(lifetime)), () => {
          const respawnSeed = index.add(simulationTime.mul(97));
          const angle = hash(respawnSeed.add(13)).mul(Math.PI * 2);
          const radius = hash(respawnSeed.add(29)).sqrt().mul(0.65);
          position.assign(
            vec3(
              cos(angle).mul(radius),
              hash(respawnSeed.add(47)).mul(0.45).sub(1.5),
              sin(angle).mul(radius),
            ),
          );
          velocity.assign(
            vec3(
              hash(respawnSeed.add(61)).sub(0.5).mul(1.2),
              hash(respawnSeed.add(79)).mul(2.2).add(2.4),
              hash(respawnSeed.add(101)).sub(0.5).mul(1.2),
            ),
          );
          lifetime.assign(hash(respawnSeed.add(127)).mul(3.5).add(2.5));
          age.assign(0);
        });

        // Each component omits its own axis, forming a cheap divergence-free curl-like field.
        const curlField = vec3(
          sin(position.y.mul(1.7).add(simulationTime)).sub(
            cos(position.z.mul(1.3).sub(simulationTime.mul(0.7))),
          ),
          sin(position.z.mul(1.5).add(simulationTime.mul(0.8))).sub(
            cos(position.x.mul(1.9).add(simulationTime.mul(0.4))),
          ),
          sin(position.x.mul(1.4).sub(simulationTime.mul(0.6))).sub(
            cos(position.y.mul(1.6).add(simulationTime)),
          ),
        ).mul(1.25);
        velocity.addAssign(curlField.add(vec3(0, -1.65, 0)).mul(deltaSeconds));
        velocity.mulAssign(float(1).sub(deltaSeconds.mul(0.08)));
        position.addAssign(velocity.mul(deltaSeconds));
        age.addAssign(deltaSeconds);
      }).Else(() => {
        position.assign(vec3(0, -10_000, 0));
        velocity.assign(vec3(0));
        age.assign(-1);
      });
    })()
      .compute(particleCount, [WORKGROUP_SIZE])
      .setName(withAtomics ? 'SimulateAndCountAlive' : 'SimulateWebGLFallback');

  const webGpuSimulationKernel = createSimulationKernel(true);
  const webGlSimulationKernel = createSimulationKernel(false);
  const resetAliveKernel = Fn(() => {
    atomicStore(aliveCounter.element(uint(0)), uint(0));
  })()
    .compute(1, [1])
    .setName('ResetAliveCounter');

  const finalizeIndirectKernel = Fn(() => {
    const count = atomicLoad(aliveCounter.element(uint(0)));
    drawIndirectArguments.element(uint(0)).assign(uint(indexCount));
    drawIndirectArguments.element(uint(1)).assign(count);
    drawIndirectArguments.element(uint(2)).assign(uint(0));
    drawIndirectArguments.element(uint(3)).assign(uint(0));
    drawIndirectArguments.element(uint(4)).assign(uint(0));
    dispatchIndirectArguments
      .element(uint(0))
      .assign(count.add(uint(WORKGROUP_SIZE - 1)).div(uint(WORKGROUP_SIZE)));
    dispatchIndirectArguments.element(uint(1)).assign(uint(1));
    dispatchIndirectArguments.element(uint(2)).assign(uint(1));
  })()
    .compute(1, [1])
    .setName('FinalizeIndirectArguments');

  const dispatchProbeKernel = Fn(() => {
    dispatchOutput.element(instanceIndex).assign(instanceIndex.mul(uint(3)).add(uint(7)));
  })()
    .computeKernel([WORKGROUP_SIZE])
    .setName('DispatchIndirectProbe');

  try {
    await renderer.computeAsync(initializeKernel);
    supportMatrix.instancedArrayCompute = capability(
      'supported',
      activeBackend === 'WebGPU'
        ? 'TSL storage compute encoded through native WebGPU compute.'
        : 'TSL storage compute encoded as WebGL2 transform feedback.',
    );
  } catch (error) {
    supportMatrix.instancedArrayCompute = capability(
      'error',
      'Particle initialization failed.',
      error,
    );
    throw error;
  }

  const runComputeFrame = async (timeSeconds: number): Promise<number> => {
    simulationTime.value = timeSeconds;
    aliveLimit.value = computeAliveLimit(timeSeconds);
    const start = performance.now();
    if (activeBackend === 'WebGPU') {
      await renderer.computeAsync([
        resetAliveKernel,
        webGpuSimulationKernel,
        finalizeIndirectKernel,
      ]);
    } else {
      await renderer.computeAsync(webGlSimulationKernel);
    }
    return performance.now() - start;
  };

  const runDispatchIndirectProbe = (): void => {
    renderer.compute(dispatchProbeKernel, dispatchIndirectAttribute);
  };

  const runWebGlAtomicProbe = async (): Promise<CapabilityResult> => {
    const probeCounter = instancedArray(new Uint32Array(1), 'uint')
      .toAtomic()
      .setName('WebGLAtomicProbe');
    const kernel = Fn(() => {
      atomicStore(probeCounter.element(uint(0)), uint(0));
      atomicAdd(probeCounter.element(uint(0)), uint(1));
    })()
      .compute(1, [1])
      .setName('WebGLAtomicUnsupportedProbe');

    try {
      await renderer.computeAsync(kernel);
      const data = new Uint32Array(await renderer.getArrayBufferAsync(probeCounter.value));
      if (data[0] === 1) return capability('supported', 'Atomic store/add and readback succeeded.');
      return capability(
        'unsupported',
        `Atomic probe did not execute correctly (returned ${String(data[0])}, expected 1).`,
      );
    } catch (error) {
      const message = errorMessage(error);
      const isAtomicShaderCompilationFailure =
        /atomic(?:Add|Store|Load)|no matching overloaded function[^\n]*atomic|undeclared identifier[^\n]*atomic|syntax error[^\n]*&|&[^\n]*syntax error/i.test(
          message,
        );
      return isAtomicShaderCompilationFailure
        ? capability(
            'unsupported',
            'WebGL2 transform-feedback shaders have no atomic lowering; the shader compiler rejected the atomic operation.',
            error,
          )
        : capability('error', 'WebGL2 atomic probe failed for an unexpected reason.', error);
    }
  };

  const runWebGlDispatchIndirectProbe = async (): Promise<CapabilityResult> => {
    const output = instancedArray(new Uint32Array(8), 'uint').setName(
      'WebGLDispatchIndirectFallbackOutput',
    );
    const arguments_ = new THREE.IndirectStorageBufferAttribute(new Uint32Array([1, 1, 1]), 1);
    const kernel = Fn(() => {
      output.element(instanceIndex).assign(instanceIndex.add(uint(1)));
    })()
      .compute(8, [1])
      .setName('WebGLDispatchIndirectFallbackProbe');

    try {
      renderer.compute(kernel, arguments_);
      const values = new Uint32Array(await renderer.getArrayBufferAsync(output.value));
      const fallbackRanDirectCount = values[0] === 1 && values[7] === 8;
      return capability(
        'unsupported',
        fallbackRanDirectCount
          ? 'Indirect dispatch argument was ignored and computeNode.count=8 executed, confirming Three WebGLBackend direct-count fallback.'
          : 'WebGL2 exposes no indirect dispatch API and the fallback output was inconclusive.',
      );
    } catch (error) {
      return capability('unsupported', 'WebGL2 exposes no indirect dispatch API.', error);
    }
  };

  const runWebGlIndirectDrawProbe = (): CapabilityResult => {
    try {
      const context = renderer.getContext() as WebGL2RenderingContext;
      const hasIndirectDrawApi =
        'drawArraysIndirect' in context || 'drawElementsIndirect' in context;
      return hasIndirectDrawApi
        ? capability('error', 'Unexpected indirect draw entry point was exposed by WebGL2.')
        : capability(
            'unsupported',
            'WebGL2 has no indirect draw entry point; Three WebGLBackend renders the CPU-side instanceCount directly.',
          );
    } catch (error) {
      return capability('error', 'WebGL2 indirect-draw capability detection failed.', error);
    }
  };

  const validateReadback = async (includeWebGpuFeatures: boolean): Promise<ReadbackValidation> => {
    const [positionData, ageData] = await Promise.all([
      renderer.getArrayBufferAsync(positions.value),
      renderer.getArrayBufferAsync(ages.value),
    ]);
    const positionValues = new Float32Array(positionData);
    const ageValues = new Float32Array(ageData);
    const stride = positions.value.itemSize;
    const expectedAliveCount = aliveLimit.value;
    const inactiveIndex = expectedAliveCount;
    const activePosition = [...positionValues.slice(0, 3)];
    const activeAge = ageValues[0] ?? Number.NaN;
    const inactiveY = positionValues[inactiveIndex * stride + 1] ?? Number.NaN;
    const inactiveAge = ageValues[inactiveIndex] ?? Number.NaN;
    const ageAdvanced = Number.isFinite(activeAge) && activeAge > 0;
    const positionOk =
      activePosition.every(Number.isFinite) &&
      activePosition.some((value) => Math.abs(value) > 0.0001);
    const sentinelOk = Math.abs(inactiveY + 10_000) < 0.01 && inactiveAge === -1;

    let aliveCount: number | null = null;
    let indirectArgs: number[] | null = null;
    let dispatchArgs: number[] | null = null;
    let dispatchInvocationCount: number | null = null;
    let dispatchLastInvocationValue: number | null = null;
    let dispatchBoundaryValue: number | null = null;
    let atomicOk = false;
    let indirectOk = false;
    let dispatchIndirectOk = false;

    if (includeWebGpuFeatures) {
      const [counterData, drawData, dispatchData, dispatchOutputData] = await Promise.all([
        renderer.getArrayBufferAsync(aliveCounter.value),
        renderer.getArrayBufferAsync(drawIndirectAttribute),
        renderer.getArrayBufferAsync(dispatchIndirectAttribute),
        renderer.getArrayBufferAsync(dispatchOutput.value),
      ]);
      aliveCount = new Uint32Array(counterData)[0] ?? 0;
      indirectArgs = [...new Uint32Array(drawData).slice(0, 5)];
      dispatchArgs = [...new Uint32Array(dispatchData).slice(0, 3)];
      const dispatchValues = new Uint32Array(dispatchOutputData);
      dispatchInvocationCount = (dispatchArgs[0] ?? 0) * WORKGROUP_SIZE;
      dispatchLastInvocationValue = dispatchValues[dispatchInvocationCount - 1] ?? null;
      dispatchBoundaryValue = dispatchValues[dispatchInvocationCount] ?? null;
      atomicOk = aliveCount === expectedAliveCount;
      indirectOk =
        indirectArgs[0] === indexCount &&
        indirectArgs[1] === aliveCount &&
        indirectArgs.slice(2).every((value) => value === 0);
      dispatchIndirectOk =
        dispatchArgs[0] === Math.ceil(expectedAliveCount / WORKGROUP_SIZE) &&
        dispatchArgs[1] === 1 &&
        dispatchArgs[2] === 1 &&
        dispatchInvocationCount > 0 &&
        dispatchLastInvocationValue === (dispatchInvocationCount - 1) * 3 + 7 &&
        dispatchBoundaryValue === 0;
    }

    return {
      activeAge: roundMetric(activeAge),
      activePosition: activePosition.map(roundMetric),
      ageAdvanced,
      aliveCount,
      atomicOk,
      branchesOk: ageAdvanced && sentinelOk,
      dispatchArgs,
      dispatchBoundaryValue,
      dispatchIndirectOk,
      dispatchInvocationCount,
      dispatchLastInvocationValue,
      expectedAliveCount,
      inactiveAge: roundMetric(inactiveAge),
      inactiveY: roundMetric(inactiveY),
      indirectArgs,
      indirectOk,
      positionOk,
      sentinelOk,
    };
  };

  root.dataset.indirectDraw =
    activeBackend === 'WebGPU' ? 'drawIndexedIndirect' : 'directInstancedCpuCount';
  root.dataset.spikeStatus = 'warming-up';
  drawValue.textContent = root.dataset.indirectDraw;
  statusValue.textContent = `Warming up ${activeBackend} compute…`;

  const warmupEncodeMs = await runComputeFrame(FIXED_DELTA_SECONDS);
  setMetrics(headless ? null : 1000 / 60, warmupEncodeMs, aliveLimit.value);

  const encodeSamples = new RollingAverage(headless ? headlessFrames : METRIC_WINDOW);
  let measurementFrames = 0;
  if (headless) {
    for (let frame = 0; frame < headlessFrames; frame += 1) {
      if (deviceLost) throw new Error('WebGPU device was lost during headless measurement.');
      encodeSamples.push(await runComputeFrame((frame + 2) * FIXED_DELTA_SECONDS));
      measurementFrames += 1;
    }
  } else {
    encodeSamples.push(warmupEncodeMs);
    measurementFrames = 1;
  }

  if (activeBackend === 'WebGPU') {
    runDispatchIndirectProbe();
  }

  let validation: ReadbackValidation;
  try {
    validation = await validateReadback(activeBackend === 'WebGPU');
    supportMatrix.readback = capability(
      'supported',
      activeBackend === 'WebGPU'
        ? 'Storage, atomic, draw-argument, dispatch-argument, and dispatch-output buffers were read back.'
        : 'Transform-feedback storage buffers were read back with gl.getBufferSubData().',
    );
  } catch (error) {
    supportMatrix.readback = capability('error', 'Storage-buffer readback failed.', error);
    throw error;
  }

  if (activeBackend === 'WebGPU') {
    supportMatrix.atomics = validation.atomicOk
      ? capability('supported', 'atomicAdd alive count matched the expected active prefix.')
      : capability('error', 'Atomic count readback did not match.');
    supportMatrix.indirectDraw = validation.indirectOk
      ? capability(
          'supported',
          headless
            ? 'Indexed indirect arguments were GPU-generated and read back; draw intentionally not executed in headless mode.'
            : 'Indexed indirect arguments were GPU-generated and are bound to BufferGeometry.',
        )
      : capability('error', 'Indexed indirect arguments failed validation.');
    supportMatrix.dispatchIndirect = validation.dispatchIndirectOk
      ? capability(
          'supported',
          'renderer.compute(node, IndirectStorageBufferAttribute) dispatched the alive-derived workgroup count.',
        )
      : capability('error', 'Indirect dispatch output failed boundary validation.');
  } else {
    supportMatrix.atomics = await runWebGlAtomicProbe();
    supportMatrix.dispatchIndirect = await runWebGlDispatchIndirectProbe();
    supportMatrix.indirectDraw = runWebGlIndirectDrawProbe();
  }

  const baselineOk =
    supportMatrix.instancedArrayCompute.status === 'supported' &&
    supportMatrix.readback.status === 'supported' &&
    validation.positionOk &&
    validation.branchesOk;
  const advancedOk =
    activeBackend === 'WebGPU'
      ? validation.atomicOk && validation.indirectOk && validation.dispatchIndirectOk
      : supportMatrix.atomics.status === 'unsupported' &&
        supportMatrix.indirectDraw.status === 'unsupported' &&
        supportMatrix.dispatchIndirect.status === 'unsupported';

  const createResult = (
    stats: TimingStats,
    renderedFrames: number,
    drawExecuted: boolean,
  ): SpikeResult => ({
    activeBackend,
    atomicOk: activeBackend === 'WebGPU' ? validation.atomicOk : false,
    computeOk: baselineOk,
    dispatchIndirectOk: activeBackend === 'WebGPU' ? validation.dispatchIndirectOk : false,
    drawExecuted,
    drawPath: activeBackend === 'WebGPU' ? 'drawIndexedIndirect' : 'directInstancedCpuCount',
    indirectOk: activeBackend === 'WebGPU' ? validation.indirectOk : false,
    measurementFrames,
    mode: headless ? 'headless' : 'visual',
    ok: baselineOk && advancedOk,
    particleCount,
    renderedFrames,
    requestedBackend,
    stats,
    supportMatrix,
    timingNote: TIMING_NOTE,
    validation,
  });

  if (headless) {
    const encodeMs = encodeSamples.mean();
    const result = createResult(
      {
        encodeMs: roundMetric(encodeMs),
        p95EncodeMs: roundMetric(percentile95(encodeSamples.values())),
      },
      0,
      false,
    );
    setMetrics(null, encodeMs, validation.expectedAliveCount);
    await performanceMonitor.resolveGpuTimestamps();
    performanceMonitor.publish();
    publishResult(result);
    root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
    statusValue.textContent = result.ok
      ? `${activeBackend} capability measurement complete`
      : `${activeBackend} capability validation failed`;
    return;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02050d);
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.2, 8.5);
  camera.lookAt(0, 0.5, 0);

  const normalizedAge = ages.toAttribute().div(lifetimes.toAttribute()).clamp(0, 1);
  const material = new THREE.SpriteNodeMaterial({
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  material.positionNode = positions.toAttribute();
  material.scaleNode = smoothstep(0, 0.12, normalizedAge)
    .mul(smoothstep(0.72, 1, normalizedAge).oneMinus())
    .mul(1.8)
    .add(0.2);
  material.colorNode = mix(color('#53e7ff'), color('#ff53b7'), normalizedAge);
  material.opacityNode = normalizedAge.oneMinus().mul(0.8).add(0.08);

  const particles = new THREE.InstancedMesh(geometry, material, particleCount);
  particles.frustumCulled = false;
  if (activeBackend === 'WebGL2') particles.count = validation.expectedAliveCount;
  scene.add(particles);

  const frameSamples = new RollingAverage(METRIC_WINDOW);
  let previousTimestamp: number | undefined;
  let simulationSeconds = FIXED_DELTA_SECONDS;
  let inFlight = false;
  let lastHudUpdate = 0;
  let renderedFrames = 0;

  root.dataset.spikeStatus = 'running';
  statusValue.textContent =
    activeBackend === 'WebGPU'
      ? 'Running — atomic count drives drawIndexedIndirect'
      : 'Running — WebGL2 transform feedback + CPU instance count fallback';

  renderer.setAnimationLoop((timestamp: number) => {
    if (inFlight || deviceLost) return;
    inFlight = true;
    void (async () => {
      const frameMs =
        previousTimestamp === undefined ? 1000 / 60 : Math.max(timestamp - previousTimestamp, 0.01);
      previousTimestamp = timestamp;
      frameSamples.push(frameMs);
      simulationSeconds += Math.min(frameMs / 1000, 0.05);
      const encodeMs = await runComputeFrame(simulationSeconds);
      encodeSamples.push(encodeMs);
      measurementFrames += 1;
      if (activeBackend === 'WebGL2') particles.count = aliveLimit.value;
      renderer.render(scene, camera);
      renderedFrames += 1;
      performanceMonitor.recordFrame(timestamp);

      if (timestamp - lastHudUpdate >= 200) {
        const frameAverage = frameSamples.mean();
        const encodeAverage = encodeSamples.mean();
        setMetrics(frameAverage, encodeAverage, aliveLimit.value);
        publishResult(
          createResult(
            {
              encodeMs: roundMetric(encodeAverage),
              fps: roundMetric(1000 / frameAverage),
              frameMs: roundMetric(frameAverage),
              p95EncodeMs: roundMetric(percentile95(encodeSamples.values())),
            },
            renderedFrames,
            true,
          ),
        );
        root.dataset.sceneReady = 'true';
        lastHudUpdate = timestamp;
      }
    })()
      .catch(recordFailure)
      .finally(() => {
        inFlight = false;
      });
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

void runSpike().catch(recordFailure);
