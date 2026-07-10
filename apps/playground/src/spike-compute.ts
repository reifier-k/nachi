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

import './spike-compute.css';

const DEFAULT_PARTICLE_COUNT = 100_000;
const DEFAULT_HEADLESS_FRAMES = 120;
const MAX_PARTICLE_COUNT = 1_000_000;
const FIXED_DELTA_SECONDS = 1 / 60;
const WORKGROUP_SIZE = 64;
const METRIC_WINDOW = 60;

type DeviceLostInfoLike = {
  message?: string;
  reason?: string;
};

type RendererBackendLike = {
  device?: {
    lost: Promise<DeviceLostInfoLike>;
  };
  isWebGPUBackend?: boolean;
};

type ReadbackValidation = {
  aliveCount: number;
  atomicOk: boolean;
  expectedAliveCount: number;
  indirectArgs: number[];
  indirectOk: boolean;
  positionOk: boolean;
  positionSample: number[];
};

type SpikeResult = {
  ok: boolean;
  computeOk: boolean;
  atomicOk: boolean;
  indirectOk: boolean;
  mode: 'headless' | 'visual';
  particleCount: number;
  frames: number;
  drawPath: 'drawIndexedIndirect';
  computeTiming: 'computeAsync-wall-duration';
  stats: {
    computeMs: number;
    fps: number;
    frameMs: number;
    p95ComputeMs: number;
  };
  validation: ReadbackValidation;
};

const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const headless = query.get('headless') === '1';
const particleCount = readIntegerParameter('count', DEFAULT_PARTICLE_COUNT, 1, MAX_PARTICLE_COUNT);
const headlessFrames = readIntegerParameter('frames', DEFAULT_HEADLESS_FRAMES, 1, 10_000);

root.dataset.headless = String(headless);
root.dataset.particleCount = String(particleCount);
root.dataset.spikeStatus = 'initializing';

const sceneHost = requireElement<HTMLDivElement>('#scene');
const particleValue = requireElement<HTMLElement>('#particle-value');
const aliveValue = requireElement<HTMLElement>('#alive-value');
const fpsValue = requireElement<HTMLElement>('#fps-value');
const frameValue = requireElement<HTMLElement>('#frame-value');
const computeValue = requireElement<HTMLElement>('#compute-value');
const drawValue = requireElement<HTMLElement>('#draw-value');
const statusValue = requireElement<HTMLElement>('#status-value');

particleValue.textContent = particleCount.toLocaleString();
drawValue.textContent = 'drawIndexedIndirect';

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
  const fraction = 0.72 + Math.sin(timeSeconds * 0.65) * 0.2;
  return Math.floor(particleCount * fraction);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function setMetricDataset(frameMs: number, computeMs: number, aliveCount: number): void {
  const fps = frameMs > 0 ? 1000 / frameMs : 0;
  root.dataset.frameMs = frameMs.toFixed(3);
  root.dataset.computeMs = computeMs.toFixed(3);
  root.dataset.fps = fps.toFixed(3);
  root.dataset.aliveCount = String(aliveCount);

  frameValue.textContent = `${frameMs.toFixed(2)} ms`;
  computeValue.textContent = `${computeMs.toFixed(2)} ms`;
  fpsValue.textContent = fps.toFixed(1);
  aliveValue.textContent = aliveCount.toLocaleString();
}

function publishResult(result: SpikeResult): void {
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.computeOk = String(result.computeOk);
  root.dataset.atomicOk = String(result.atomicOk);
  root.dataset.indirectOk = String(result.indirectOk);
}

function recordFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({
    ok: false,
    computeOk: false,
    atomicOk: false,
    indirectOk: false,
    mode: headless ? 'headless' : 'visual',
    particleCount,
    error: message,
  });
  statusValue.textContent = `Error: ${message}`;
}

async function runSpike(): Promise<void> {
  const renderer = new THREE.WebGPURenderer({ antialias: !headless });
  if (!headless) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    sceneHost.append(renderer.domElement);
  }

  await renderer.init();
  const backend = renderer.backend as RendererBackendLike;
  if (!backend.isWebGPUBackend) {
    throw new Error(
      'This compute spike requires the WebGPU backend; WebGL2 fallback is unsupported.',
    );
  }

  let deviceLost = false;
  if (backend.device) {
    void backend.device.lost.then((info) => {
      deviceLost = true;
      const reason = info.reason ?? 'unknown';
      const message = info.message ?? '';
      root.dataset.spikeStatus = 'device-lost';
      root.dataset.deviceLostReason = reason;
      root.dataset.deviceLostMessage = message;
      root.dataset.spikeResult = JSON.stringify({
        ok: false,
        computeOk: false,
        atomicOk: false,
        indirectOk: false,
        mode: headless ? 'headless' : 'visual',
        particleCount,
        error: `WebGPU device lost (${reason})${message ? `: ${message}` : ''}`,
      });
      statusValue.textContent = `Device lost (${reason})`;
      void renderer.setAnimationLoop(null);
    });
  }

  const positions = instancedArray(particleCount, 'vec3').setName('ParticlePositions');
  const velocities = instancedArray(particleCount, 'vec3').setName('ParticleVelocities');
  const ages = instancedArray(particleCount, 'float').setName('ParticleAges');
  const lifetimes = instancedArray(particleCount, 'float').setName('ParticleLifetimes');
  const aliveCounter = instancedArray(new Uint32Array(1), 'uint')
    .toAtomic()
    .setName('AliveCounter');

  const geometry = new THREE.PlaneGeometry(0.075, 0.075);
  const indexCount = geometry.index?.count ?? 6;
  const indirectAttribute = new THREE.IndirectStorageBufferAttribute(
    new Uint32Array([indexCount, 0, 0, 0, 0]),
    1,
  );
  const indirectArguments = storage(indirectAttribute, 'uint', 5).setName('DrawIndirectArgs');
  geometry.setIndirect(indirectAttribute);

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
    ages.element(instanceIndex).assign(hash(index.add(241)).mul(lifetime));
    lifetimes.element(instanceIndex).assign(lifetime);
  })()
    .compute(particleCount, [WORKGROUP_SIZE])
    .setName('InitializeParticles');

  const resetAliveKernel = Fn(() => {
    atomicStore(aliveCounter.element(uint(0)), uint(0));
  })()
    .compute(1, [1])
    .setName('ResetAliveCounter');

  const simulateKernel = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);
    const age = ages.element(instanceIndex);
    const lifetime = lifetimes.element(instanceIndex);
    const index = float(instanceIndex);

    If(instanceIndex.lessThan(aliveLimit), () => {
      atomicAdd(aliveCounter.element(uint(0)), uint(1));

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

      // Each component omits its own axis, yielding a cheap divergence-free curl-like field.
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
      const acceleration = curlField.add(vec3(0, -1.65, 0));
      velocity.addAssign(acceleration.mul(deltaSeconds));
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
    .setName('SimulateAndCountAlive');

  const finalizeIndirectKernel = Fn(() => {
    indirectArguments.element(uint(0)).assign(uint(indexCount));
    indirectArguments.element(uint(1)).assign(atomicLoad(aliveCounter.element(uint(0))));
    indirectArguments.element(uint(2)).assign(uint(0));
    indirectArguments.element(uint(3)).assign(uint(0));
    indirectArguments.element(uint(4)).assign(uint(0));
  })()
    .compute(1, [1])
    .setName('FinalizeDrawIndirect');

  await renderer.computeAsync(initializeKernel);

  const runComputeFrame = async (timeSeconds: number): Promise<number> => {
    simulationTime.value = timeSeconds;
    aliveLimit.value = computeAliveLimit(timeSeconds);
    const start = performance.now();
    await renderer.computeAsync([resetAliveKernel, simulateKernel, finalizeIndirectKernel]);
    return performance.now() - start;
  };

  const validateReadback = async (): Promise<ReadbackValidation> => {
    const [counterData, indirectData, positionData] = await Promise.all([
      renderer.getArrayBufferAsync(aliveCounter.value),
      renderer.getArrayBufferAsync(indirectAttribute),
      renderer.getArrayBufferAsync(positions.value),
    ]);
    const aliveCount = new Uint32Array(counterData)[0] ?? 0;
    const expectedAliveCount = aliveLimit.value;
    const indirectArgs = [...new Uint32Array(indirectData).slice(0, 5)];
    const sampledPositions = [...new Float32Array(positionData).slice(0, 24)];
    const positionOk =
      sampledPositions.length === 24 &&
      sampledPositions.every(Number.isFinite) &&
      sampledPositions.some((value) => Math.abs(value) > 0.0001);
    const atomicOk = aliveCount === expectedAliveCount;
    const indirectOk =
      indirectArgs[0] === indexCount &&
      indirectArgs[1] === aliveCount &&
      indirectArgs.slice(2).every((value) => value === 0);

    return {
      aliveCount,
      atomicOk,
      expectedAliveCount,
      indirectArgs,
      indirectOk,
      positionOk,
      positionSample: sampledPositions.slice(0, 6).map((value) => roundMetric(value)),
    };
  };

  root.dataset.backend = 'WebGPU';
  root.dataset.indirectDraw = 'drawIndexedIndirect';
  root.dataset.spikeStatus = 'warming-up';
  statusValue.textContent = 'Warming up compute…';

  const validationComputeMs = await runComputeFrame(FIXED_DELTA_SECONDS);
  setMetricDataset(validationComputeMs, validationComputeMs, aliveLimit.value);

  if (headless) {
    const computeSamples = new RollingAverage(headlessFrames);
    for (let frame = 0; frame < headlessFrames; frame += 1) {
      if (deviceLost) throw new Error('WebGPU device was lost during headless measurement.');
      computeSamples.push(await runComputeFrame((frame + 2) * FIXED_DELTA_SECONDS));
    }

    const computeMs = computeSamples.mean();
    const frameMs = computeMs;
    const finalValidation = await validateReadback();
    const result: SpikeResult = {
      ok: finalValidation.atomicOk && finalValidation.indirectOk && finalValidation.positionOk,
      computeOk: finalValidation.positionOk,
      atomicOk: finalValidation.atomicOk,
      indirectOk: finalValidation.indirectOk,
      mode: 'headless',
      particleCount,
      frames: headlessFrames,
      drawPath: 'drawIndexedIndirect',
      computeTiming: 'computeAsync-wall-duration',
      stats: {
        computeMs: roundMetric(computeMs),
        fps: roundMetric(computeMs > 0 ? 1000 / computeMs : 0),
        frameMs: roundMetric(frameMs),
        p95ComputeMs: roundMetric(percentile95(computeSamples.values())),
      },
      validation: finalValidation,
    };
    setMetricDataset(frameMs, computeMs, finalValidation.aliveCount);
    publishResult(result);
    root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
    statusValue.textContent = result.ok ? 'Headless measurement complete' : 'Validation failed';
    return;
  }

  const validation = await validateReadback();
  if (!validation.atomicOk || !validation.indirectOk || !validation.positionOk) {
    throw new Error(`GPU readback validation failed: ${JSON.stringify(validation)}`);
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
  scene.add(particles);

  const frameSamples = new RollingAverage(METRIC_WINDOW);
  const computeSamples = new RollingAverage(METRIC_WINDOW);
  let previousTimestamp: number | undefined;
  let simulationSeconds = FIXED_DELTA_SECONDS;
  let inFlight = false;
  let lastHudUpdate = 0;
  let latestAliveCount = validation.aliveCount;

  root.dataset.spikeStatus = 'running';
  statusValue.textContent = 'Running — atomic count drives drawIndexedIndirect';

  renderer.setAnimationLoop((timestamp: number) => {
    if (inFlight || deviceLost) return;
    inFlight = true;
    void (async () => {
      const frameMs =
        previousTimestamp === undefined ? 1000 / 60 : Math.max(timestamp - previousTimestamp, 0.01);
      previousTimestamp = timestamp;
      frameSamples.push(frameMs);
      simulationSeconds += Math.min(frameMs / 1000, 0.05);
      latestAliveCount = computeAliveLimit(simulationSeconds);
      computeSamples.push(await runComputeFrame(simulationSeconds));
      renderer.render(scene, camera);

      if (timestamp - lastHudUpdate >= 200) {
        setMetricDataset(frameSamples.mean(), computeSamples.mean(), latestAliveCount);
        const result: SpikeResult = {
          ok: true,
          computeOk: true,
          atomicOk: validation.atomicOk,
          indirectOk: validation.indirectOk,
          mode: 'visual',
          particleCount,
          frames: frameSamples.values().length,
          drawPath: 'drawIndexedIndirect',
          computeTiming: 'computeAsync-wall-duration',
          stats: {
            computeMs: roundMetric(computeSamples.mean()),
            fps: roundMetric(1000 / frameSamples.mean()),
            frameMs: roundMetric(frameSamples.mean()),
            p95ComputeMs: roundMetric(percentile95(computeSamples.values())),
          },
          validation,
        };
        publishResult(result);
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
