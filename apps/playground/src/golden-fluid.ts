import {
  VFXSystem,
  defineEffect,
  defineGrid3D,
  defineSimStage,
  grid3DAdvect,
  grid3DBuoyancy,
  grid3DCellIndex,
  grid3DInject,
  grid3DPressureJacobi,
  grid3DProjectVelocity,
  grid3DSnapshotChannel,
  type Grid3DRuntimeView,
  type Grid3DSnapshot,
} from '@nachi/core';

import { createPerformanceMonitor } from './perf';
import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './golden-fluid.css';

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const MAIN_CAPTURE_FRAME = 108;
const MAIN_CAPTURE_SECONDS = MAIN_CAPTURE_FRAME / 30;
// Exact CPU replay: 465 samples for this plume versus 13 with transport and buoyancy disabled.
const VOLUME_DRAW_THRESHOLD = 180;
root.dataset.headless = String(headless);
root.dataset.spikeStatus = 'running';

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
  if (!value) throw new Error(`Missing Golden Fluid UI element ${selector}.`);
  return value;
}

function fluidGrid(resolution: readonly [number, number, number] = [32, 32, 32]) {
  return defineGrid3D({
    channels: {
      density: { default: 0, type: 'f32' },
      velocity: { default: [0.34, 0.32, -0.2], type: 'vec3' },
      temperature: { default: 0, type: 'f32' },
      pressure: { default: 0, type: 'f32' },
    },
    resolution,
  });
}

function fluidEffect(
  resolution: readonly [number, number, number] = [32, 32, 32],
  pressureIterations = 4,
) {
  return defineEffect({
    elements: {
      fluid: fluidGrid(resolution),
      source: defineSimStage({
        phase: 'before-particles',
        target: 'fluid',
        update: grid3DInject({
          center: [0.43, 0.09, 0.54],
          radius: 0.09,
          values: {
            density: 3.4,
            temperature: 8.5,
            velocity: [0.7, 2.1, -0.55],
          },
        }),
      }),
      swirlA: defineSimStage({
        phase: 'before-particles',
        target: 'fluid',
        update: grid3DInject({
          center: [0.39, 0.13, 0.5],
          radius: 0.07,
          values: { velocity: [2.4, 0.65, -2.4] },
        }),
      }),
      swirlB: defineSimStage({
        phase: 'before-particles',
        target: 'fluid',
        update: grid3DInject({
          center: [0.47, 0.13, 0.58],
          radius: 0.07,
          values: { velocity: [-2.4, 0.65, 2.4] },
        }),
      }),
      advect: defineSimStage({
        target: 'fluid',
        update: grid3DAdvect({
          dissipation: { density: 0.2, pressure: 0.08, temperature: 0.38, velocity: 0.08 },
        }),
      }),
      buoyancy: defineSimStage({
        target: 'fluid',
        update: grid3DBuoyancy({ densityWeight: 0.08, temperatureBuoyancy: 1.65 }),
      }),
      pressure: defineSimStage({
        iterations: pressureIterations,
        target: 'fluid',
        update: grid3DPressureJacobi(),
      }),
      project: defineSimStage({ target: 'fluid', update: grid3DProjectVelocity() }),
    },
  });
}

function gridView(instance: { getGrid3D(key: string): Grid3DRuntimeView | undefined }) {
  const grid = instance.getGrid3D('fluid');
  if (!grid) throw new Error('Grid3D runtime view is unavailable.');
  return grid;
}

function densityCenterY(snapshot: Grid3DSnapshot): number {
  const density = grid3DSnapshotChannel(snapshot, 'density');
  const [width, height, depth] = snapshot.resolution;
  let mass = 0;
  let weighted = 0;
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = Math.max(0, density[grid3DCellIndex(x, y, z, snapshot.resolution)] ?? 0);
        mass += value;
        weighted += value * ((y + 0.5) / height);
      }
    }
  }
  return mass === 0 ? 0 : weighted / mass;
}

function maximumDifference(left: ArrayLike<number>, right: ArrayLike<number>) {
  let maximum = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return maximum;
}

function sampleCloud(resolution: readonly [number, number, number]) {
  const [width, height, depth] = resolution;
  const points: [number, number, number][] = [];
  for (let z = 1; z < depth; z += 2) {
    for (let y = 1; y < height; y += 2) {
      for (let x = 1; x < width; x += 2) {
        points.push([(x + 0.5) / width, (y + 0.5) / height, (z + 0.5) / depth]);
      }
    }
  }
  return points;
}

function paintParticles(points: readonly [number, number, number][], density: Float32Array) {
  const canvas = required<HTMLCanvasElement>('#fluid-visual');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Golden Fluid canvas has no 2D context.');
  const gradient = context.createRadialGradient(256, 440, 18, 256, 300, 360);
  gradient.addColorStop(0, '#2b1b17');
  gradient.addColorStop(0.34, '#101117');
  gradient.addColorStop(1, '#05070b');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const order = points.map((_, index) => index).sort((a, b) => points[b]![2] - points[a]![2]);
  let drawn = 0;
  let maximumDrawnY = 0;
  let minimumDrawnY = 1;
  for (const index of order) {
    const point = points[index]!;
    const amount = Math.max(0, density[index] ?? 0);
    if (amount < 0.002) continue;
    const heightShape = Math.sin(point[1] * 12.4 + point[2] * 5.1) * 0.036 * Math.min(amount, 1);
    const screenX = 256 + (point[0] - 0.5 + (point[2] - 0.5) * 0.38 + heightShape) * 405;
    const screenY = 477 - point[1] * 438 + (point[2] - 0.5) * 42;
    const alpha = Math.min(0.32, 0.035 + amount * 0.16);
    const radius = 3.4 + Math.min(1, amount) * 8.5 + point[2] * 2;
    const warmth = Math.max(0, 1 - point[1] * 2.7);
    context.beginPath();
    context.arc(screenX, screenY, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(${Math.round(157 + warmth * 56)},${Math.round(165 + warmth * 18)},${Math.round(177 - warmth * 24)},${alpha})`;
    context.fill();
    drawn += 1;
    maximumDrawnY = Math.max(maximumDrawnY, point[1]);
    minimumDrawnY = Math.min(minimumDrawnY, point[1]);
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let foreground = 0;
  let saturated = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const maximum = Math.max(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
    if (maximum > 34) foreground += 1;
    if (maximum > 248) saturated += 1;
  }
  const pixelCount = pixels.length / 4;
  return {
    drawn,
    foregroundRatio: foreground / pixelCount,
    maximumDrawnY,
    minimumDrawnY,
    saturatedRatio: saturated / pixelCount,
    verticalSpan: drawn === 0 ? 0 : maximumDrawnY - minimumDrawnY,
  };
}

async function measurePerformance(forceWebGL: boolean) {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL,
    trackTimestamp: true,
  });
  renderer.setSize(1, 1);
  await renderer.init();
  const backend = renderer.backend as {
    device?: {
      limits?: {
        maxBufferSize?: number;
        maxStorageBufferBindingSize?: number;
        maxStorageBuffersPerShaderStage?: number;
      };
      lost?: Promise<{ message?: string; reason?: string }>;
    };
    isWebGPUBackend?: boolean;
  };
  const adapter = createThreeKernelAdapter({
    backend: backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
    ...(backend.device?.limits?.maxBufferSize === undefined
      ? {}
      : { maxBufferSize: backend.device.limits.maxBufferSize }),
    ...(backend.device?.limits?.maxStorageBufferBindingSize === undefined
      ? {}
      : { maxStorageBufferBindingSize: backend.device.limits.maxStorageBufferBindingSize }),
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute'],
    mode: 'headless',
    page: 'golden-fluid',
  });
  if (backend.isWebGPUBackend) {
    const system = new VFXSystem(runtime);
    system.spawn(fluidEffect([16, 16, 16], 2));
    await system.update(1 / 30);
    await renderer.resolveTimestampsAsync('compute');
    await monitor.captureGpuSamples(async () => {
      await system.update(1 / 30);
    });
  }
  if (!backend.isWebGPUBackend) monitor.publish();
  renderer.dispose();
}

async function run() {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: false,
  });
  renderer.setSize(1, 1);
  await renderer.init();
  const backend = renderer.backend as {
    device?: {
      limits?: {
        maxBufferSize?: number;
        maxStorageBufferBindingSize?: number;
        maxStorageBuffersPerShaderStage?: number;
      };
      lost?: Promise<{ message?: string; reason?: string }>;
    };
    isWebGPUBackend?: boolean;
  };
  const webgpu = backend.isWebGPUBackend === true;
  root.dataset.backend = webgpu ? 'WebGPU' : 'WebGL2';
  required<HTMLElement>('#backend-value').textContent = root.dataset.backend;
  const adapter = createThreeKernelAdapter({
    backend: webgpu ? 'webgpu' : 'webgl2',
    ...(backend.device?.limits?.maxBufferSize === undefined
      ? {}
      : { maxBufferSize: backend.device.limits.maxBufferSize }),
    ...(backend.device?.limits?.maxStorageBufferBindingSize === undefined
      ? {}
      : { maxStorageBufferBindingSize: backend.device.limits.maxStorageBufferBindingSize }),
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);

  if (!webgpu) {
    const instance = new VFXSystem(runtime).spawn(fluidEffect());
    const unsupported = instance.diagnostics.some(
      ({ code }) => code === 'NACHI_GRID3D_WEBGL2_UNSUPPORTED',
    );
    await measurePerformance(true);
    const validation = {
      consoleClean: consoleMessages.length === 0,
      webgl2UnsupportedDiagnostic: unsupported,
    };
    root.dataset.spikeResult = JSON.stringify({
      backend: 'WebGL2',
      diagnostics: instance.diagnostics.map(({ code }) => code),
      ok: Object.values(validation).every(Boolean),
      validation,
    });
    root.dataset.spikeStatus = 'complete';
    root.dataset.sceneReady = 'true';
    required<HTMLElement>('#status-value').textContent = unsupported
      ? 'Explicitly unsupported'
      : 'Diagnostic missing';
    renderer.dispose();
    return;
  }

  const mainSystem = new VFXSystem(runtime);
  const mainInstance = mainSystem.spawn(fluidEffect());
  for (let frame = 0; frame < 12; frame += 1) await mainSystem.update(1 / 30);
  const t1 = await gridView(mainInstance).capture();
  for (let frame = 12; frame < MAIN_CAPTURE_FRAME; frame += 1) {
    await mainSystem.update(1 / 30);
  }
  const t2 = await gridView(mainInstance).capture();
  const centerT1 = densityCenterY(t1);
  const centerT2 = densityCenterY(t2);

  const directionGrid = defineGrid3D({
    channels: {
      density: { type: 'f32' },
      velocity: { default: [1.2, 0.32, -0.55], type: 'vec3' },
    },
    resolution: [9, 7, 5],
  });
  const directionEffect = defineEffect({
    elements: {
      fluid: directionGrid,
      source: defineSimStage({
        phase: 'before-particles',
        target: 'fluid',
        update: grid3DInject({
          center: [3.5 / 9, 2.5 / 7, 2.5 / 5],
          radius: 0.055,
          values: { density: 4 },
        }),
      }),
      advect: defineSimStage({ target: 'fluid', update: grid3DAdvect() }),
    },
  });
  const directionSystem = new VFXSystem(runtime);
  const directionInstance = directionSystem.spawn(directionEffect);
  await directionSystem.update(0.5);
  const directionDensity = grid3DSnapshotChannel(
    await gridView(directionInstance).capture(),
    'density',
  );
  const at = (x: number, y: number, z: number) =>
    directionDensity[grid3DCellIndex(x, y, z, directionGrid.resolution)] ?? 0;
  const direction = {
    downstream: at(4, 2, 2),
    upstream: at(2, 2, 2),
    yAlias: at(3, 4, 2),
    zAlias: at(3, 2, 4),
  };

  const pressureEffect = (iterations: number) =>
    defineEffect({
      elements: {
        fluid: fluidGrid([9, 7, 5]),
        source: defineSimStage({
          phase: 'before-particles',
          target: 'fluid',
          update: grid3DInject({
            center: [0.38, 0.31, 0.52],
            radius: 0.09,
            values: { velocity: [3, 0.4, -1.2] },
          }),
        }),
        pressure: defineSimStage({
          iterations,
          target: 'fluid',
          update: grid3DPressureJacobi(),
        }),
      },
    });
  const pressureRun = async (iterations: number) => {
    const system = new VFXSystem(runtime);
    const instance = system.spawn(pressureEffect(iterations));
    await system.update(0.2);
    return grid3DSnapshotChannel(await gridView(instance).capture(), 'pressure');
  };
  const pressureDifference = maximumDifference(await pressureRun(1), await pressureRun(6));

  const transferGrid = defineGrid3D({
    channels: {
      density: { type: 'f32' },
      velocity: { type: 'vec3' },
      temperature: { type: 'f32' },
    },
    resolution: [4, 3, 2],
  });
  const transferSystem = new VFXSystem(runtime);
  const transferInstance = transferSystem.spawn(
    defineEffect({ elements: { fluid: transferGrid } }),
  );
  await transferSystem.update(0);
  const transferValue = 0.3;
  await gridView(transferInstance).rasterizeParticles(
    [
      [0.1, 0.1, 0.1],
      [0.1, 0.1, 0.1],
      [0.8, 0.7, 0.8],
    ],
    'temperature',
    transferValue,
  );
  const rasterized = grid3DSnapshotChannel(
    await gridView(transferInstance).capture(),
    'temperature',
  );
  const fixedPointValue = Math.trunc(transferValue * 4096) / 4096;
  const rasterizedOrigin = rasterized[grid3DCellIndex(0, 0, 0, transferGrid.resolution)] ?? 0;
  const rasterizedFarCorner = rasterized[grid3DCellIndex(3, 2, 1, transferGrid.resolution)] ?? 0;

  const cloud = sampleCloud(t2.resolution);
  const sampledDensity = await gridView(mainInstance).sampleParticles(cloud, 'density');
  const visual = paintParticles(cloud, sampledDensity);

  // The 600-frame stability gate uses a deliberately tiny volume and is excluded from perf v1.
  const stressSystem = new VFXSystem(runtime);
  const stressInstance = stressSystem.spawn(fluidEffect([8, 8, 8], 1));
  for (let frame = 0; frame < 600; frame += 1) await stressSystem.update(1 / 60);
  const stressDensity = grid3DSnapshotChannel(await gridView(stressInstance).capture(), 'density');
  const stressMaximum = stressDensity.reduce((maximum, value) => Math.max(maximum, value), 0);
  const stable = stressDensity.every(Number.isFinite) && stressMaximum > 0 && stressMaximum < 20;

  await measurePerformance(false);
  const diagnostics = stressInstance.diagnostics.map(({ code }) => code);
  const stressState = stressInstance.state;
  const memory = gridView(mainInstance).memoryEstimate;
  const validation = {
    axisAsymmetricAdvection:
      direction.downstream > direction.upstream + 1e-4 &&
      direction.downstream > direction.yAlias + 1e-4 &&
      direction.downstream > direction.zAlias + 1e-4,
    consoleClean: consoleMessages.length === 0,
    densityCenterRises: centerT2 > centerT1 + 0.01,
    gridToParticleVolumeDraw: visual.drawn > VOLUME_DRAW_THRESHOLD,
    longRun600Stable: stable && diagnostics.length === 0 && stressState === 'active',
    memoryWithinDeviceLimit:
      backend.device?.limits?.maxStorageBufferBindingSize === undefined ||
      memory.stateBufferBytes <= backend.device.limits.maxStorageBufferBindingSize,
    particleToGridAtomicRasterize:
      Math.abs(rasterizedOrigin - fixedPointValue * 2) <= 1 / 4096 &&
      Math.abs(rasterizedFarCorner - fixedPointValue) <= 1 / 4096,
    pressureIterationsEffective: pressureDifference > 1e-5,
    risingPlumeVisible: visual.maximumDrawnY > 0.7 && visual.verticalSpan > 0.5,
    visualBounds:
      visual.foregroundRatio > 0.01 &&
      visual.foregroundRatio < 0.78 &&
      visual.saturatedRatio < 0.01,
  };
  const result = {
    backend: 'WebGPU',
    evidence: {
      centerOfMassY: { t1: centerT1, t2: centerT2 },
      direction,
      fixture: {
        buoyancy: { densityWeight: 0.08, temperatureBuoyancy: 1.65 },
        capture: { frames: MAIN_CAPTURE_FRAME, seconds: MAIN_CAPTURE_SECONDS },
        drawThreshold: VOLUME_DRAW_THRESHOLD,
        source: {
          density: 3.4,
          radius: 0.09,
          temperature: 8.5,
          velocity: [0.7, 2.1, -0.55],
        },
        swirlVelocity: 2.4,
      },
      memory,
      particleRasterize: {
        expected: { farCorner: fixedPointValue, origin: fixedPointValue * 2 },
        measured: { farCorner: rasterizedFarCorner, origin: rasterizedOrigin },
      },
      pressureDifference,
      stress: { diagnostics, frames: 600, maximumDensity: stressMaximum, state: stressState },
      visual,
    },
    ok: Object.values(validation).every(Boolean),
    schema: 'nachi.golden-fluid.v1',
    validation,
  };
  renderer.dispose();
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'golden-fluid.png', selector: '#fluid-visual' },
  ]);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = result.ok ? 'All checks passed' : 'Failed';
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = message;
  originalError(error);
});
