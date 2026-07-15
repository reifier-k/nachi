import {
  VFXSystem,
  defineEffect,
  defineGrid2D,
  defineSimStage,
  grid2DSnapshotChannel,
  gridAdvect,
  gridBuoyancy,
  gridInject,
  gridPressureJacobi,
  gridProjectVelocity,
  sampleGrid2DBilinear,
  type EffectDefinition,
  type EffectElements,
  type Grid2DRuntimeView,
  type ParameterSchema,
  type VfxRuntimeRenderer,
} from '@nachi-vfx/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi-vfx/three';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m12-grid.css';

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
root.dataset.headless = String(headless);

const messages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  messages.push(values.map(String).join(' '));
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  messages.push(values.map(String).join(' '));
  originalError(...values);
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing M12 Grid2D UI element ${selector}.`);
  return value;
}

function smokeGrid(resolution: readonly [number, number] = [48, 48]) {
  return defineGrid2D({
    channels: {
      density: { default: 0, type: 'f32' },
      temperature: { default: 0, type: 'f32' },
      velocity: { default: [0.12, 0.55], type: 'vec2' },
      pressure: { default: 0, type: 'f32' },
    },
    resolution,
  });
}

function mainEffect() {
  const fluid = smokeGrid();
  return defineEffect({
    elements: {
      fluid,
      source: defineSimStage({
        phase: 'before-particles',
        target: 'fluid',
        update: gridInject({
          center: [0.38, 0.14],
          radius: 0.075,
          values: { density: 2.6, temperature: 4.5, velocity: [0.08, 0.6] },
        }),
      }),
      advect: defineSimStage({
        target: 'fluid',
        update: gridAdvect({ dissipation: { density: 0.42, temperature: 0.7, velocity: 0.08 } }),
      }),
      buoyancy: defineSimStage({
        target: 'fluid',
        update: gridBuoyancy({ densityWeight: 0.16, temperatureBuoyancy: 0.72 }),
      }),
      pressure: defineSimStage({ iterations: 8, target: 'fluid', update: gridPressureJacobi() }),
      project: defineSimStage({ target: 'fluid', update: gridProjectVelocity() }),
    },
  });
}

function countedRuntime(base: VfxRuntimeRenderer) {
  let submissions = 0;
  const runtime: VfxRuntimeRenderer = {
    ...base,
    submitCompute(kernel) {
      submissions += 1;
      return base.submitCompute(kernel);
    },
  };
  return { runtime, submissions: () => submissions };
}

function gridView(instance: { getGrid2D(key: string): Grid2DRuntimeView | undefined }) {
  const grid = instance.getGrid2D('fluid');
  if (!grid) throw new Error('Grid2D runtime view is unavailable.');
  return grid;
}

async function simulate<Elements extends EffectElements, Parameters extends ParameterSchema>(
  runtime: VfxRuntimeRenderer,
  effect: EffectDefinition<Elements, Parameters>,
  delta: number,
  frames = 1,
) {
  const system = new VFXSystem(runtime);
  const instance = system.spawn(effect);
  for (let frame = 0; frame < frames; frame += 1) await system.update(delta);
  return { instance, snapshot: await gridView(instance).capture(), system };
}

function maximumDifference(left: ArrayLike<number>, right: ArrayLike<number>) {
  let maximum = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return maximum;
}

function paintSmoke(
  density: Float32Array,
  temperature: Float32Array,
  resolution: readonly [number, number],
) {
  const canvas = required<HTMLCanvasElement>('#grid-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('M12 Grid2D visual canvas has no 2D context.');
  const [width, height] = resolution;
  const image = new ImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * width + x;
      const destination = ((height - 1 - y) * width + x) * 4;
      const d = Math.min(1, Math.max(0, density[source] ?? 0));
      const t = Math.min(1, Math.max(0, (temperature[source] ?? 0) * 0.5));
      image.data[destination] = Math.round(255 * Math.min(1, d * 0.72 + t));
      image.data[destination + 1] = Math.round(255 * Math.min(1, d * 0.78 + t * 0.38));
      image.data[destination + 2] = Math.round(255 * Math.min(1, d * 0.92 + t * 0.08));
      image.data[destination + 3] = 255;
    }
  }
  const staging = document.createElement('canvas');
  staging.width = width;
  staging.height = height;
  staging.getContext('2d')!.putImageData(image, 0, 0);
  context.imageSmoothingEnabled = true;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(staging, 0, 0, canvas.width, canvas.height);
}

async function run() {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setSize(1, 1);
  await renderer.init();
  const backend = renderer.backend as {
    readonly device?: {
      readonly limits?: { readonly maxStorageBuffersPerShaderStage?: number };
      readonly lost?: Promise<{ message?: string; reason?: string }>;
    };
    readonly isWebGPUBackend?: boolean;
  };
  const webgpu = backend.isWebGPUBackend === true;
  root.dataset.backend = webgpu ? 'WebGPU' : 'WebGL2';
  required<HTMLElement>('#backend-value').textContent = root.dataset.backend;
  const adapter = createThreeKernelAdapter({
    backend: webgpu ? 'webgpu' : 'webgl2',
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : {
          maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage,
        }),
  });
  const baseRuntime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const counter = countedRuntime(baseRuntime);
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: webgpu ? ['compute'] : ['render'],
    mode: headless ? 'headless' : 'visual',
    page: 'm12-grid',
  });

  if (!webgpu) {
    const system = new VFXSystem(counter.runtime, undefined, { onBuildDiagnostic: null });
    const instance = system.spawn(mainEffect());
    const unsupported = instance.diagnostics.some(
      ({ code }) => code === 'NACHI_GRID2D_WEBGL2_UNSUPPORTED',
    );
    const result = {
      backend: 'WebGL2',
      diagnostics: instance.diagnostics.map(({ code }) => code),
      ok: unsupported && messages.length === 0,
      validation: { consoleClean: messages.length === 0, webgl2UnsupportedDiagnostic: unsupported },
    };
    root.dataset.spikeResult = JSON.stringify(result);
    root.dataset.spikeStatus = 'complete';
    root.dataset.sceneReady = 'true';
    required<HTMLElement>('#status-value').textContent = result.ok
      ? 'Explicitly unsupported'
      : 'Diagnostic missing';
    const target = new THREE.RenderTarget(1, 1);
    renderer.setRenderTarget(target);
    await monitor.captureGpuSamples(async () => {
      renderer.render(new THREE.Scene(), new THREE.Camera());
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    });
    renderer.setRenderTarget(null);
    target.dispose();
    return;
  }

  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm12-grid.png', selector: '#grid-visual' },
  ]);

  const analyticFluid = defineGrid2D({
    channels: {
      density: { type: 'f32' },
      velocity: { default: [0, 0], type: 'vec2' },
    },
    resolution: [5, 3],
  });
  const analyticEffect = defineEffect({
    elements: {
      fluid: analyticFluid,
      source: defineSimStage({
        phase: 'before-particles',
        target: 'fluid',
        update: gridInject({ center: [0.5, 0.5], radius: 0.05, values: { density: 2 } }),
      }),
      decay: defineSimStage({
        target: 'fluid',
        update: gridAdvect({ dissipation: { density: 0.5 } }),
      }),
    },
  });
  const analytic = await simulate(counter.runtime, analyticEffect, 0.25);
  const analyticDensity = grid2DSnapshotChannel(analytic.snapshot, 'density');
  const analyticActual = analyticDensity[1 * 5 + 2] ?? 0;
  const analyticExpected = 0.5 * Math.exp(-0.5 * 0.25);

  const directionFluid = defineGrid2D({
    channels: {
      density: { type: 'f32' },
      velocity: { default: [1.2, 0.35], type: 'vec2' },
    },
    resolution: [9, 7],
  });
  const directionEffect = defineEffect({
    elements: {
      fluid: directionFluid,
      source: defineSimStage({
        phase: 'before-particles',
        target: 'fluid',
        update: gridInject({ center: [3.5 / 9, 2.5 / 7], radius: 0.06, values: { density: 4 } }),
      }),
      advect: defineSimStage({ target: 'fluid', update: gridAdvect() }),
    },
  });
  const direction = await simulate(counter.runtime, directionEffect, 0.5);
  const directionDensity = grid2DSnapshotChannel(direction.snapshot, 'density');
  const downstream = directionDensity[2 * 9 + 4] ?? 0;
  const upstream = directionDensity[2 * 9 + 2] ?? 0;
  const yMirror = directionDensity[(7 - 1 - 2) * 9 + 4] ?? 0;
  const transposeAlias = directionDensity[4 * 9 + 2] ?? 0;

  const pressureEffect = (iterations: number) =>
    defineEffect({
      elements: {
        fluid: smokeGrid([11, 9]),
        source: defineSimStage({
          phase: 'before-particles',
          target: 'fluid',
          update: gridInject({
            center: [0.31, 0.27],
            radius: 0.08,
            values: { velocity: [3, 0.4] },
          }),
        }),
        pressure: defineSimStage({ iterations, target: 'fluid', update: gridPressureJacobi() }),
      },
    });
  const pressureOne = await simulate(counter.runtime, pressureEffect(1), 0.2);
  const pressureMany = await simulate(counter.runtime, pressureEffect(7), 0.2);
  const pressureDifference = maximumDifference(
    grid2DSnapshotChannel(pressureOne.snapshot, 'pressure'),
    grid2DSnapshotChannel(pressureMany.snapshot, 'pressure'),
  );

  const samplePoint = [4.35, 2.2] as const;
  const cpuParticleSample = sampleGrid2DBilinear(directionDensity, [9, 7], samplePoint);
  const particleSample = (
    await gridView(direction.instance).sampleParticles(
      [[(samplePoint[0] + 0.5) / 9, (samplePoint[1] + 0.5) / 7]],
      'density',
    )
  )[0]!;
  const x0 = Math.floor(samplePoint[0]);
  const y0 = Math.floor(samplePoint[1]);
  const tx = samplePoint[0] - x0;
  const ty = samplePoint[1] - y0;
  const independentSample =
    (directionDensity[y0 * 9 + x0]! * (1 - tx) + directionDensity[y0 * 9 + x0 + 1]! * tx) *
      (1 - ty) +
    (directionDensity[(y0 + 1) * 9 + x0]! * (1 - tx) +
      directionDensity[(y0 + 1) * 9 + x0 + 1]! * tx) *
      ty;

  const transferEffect = defineEffect({
    elements: {
      fluid: defineGrid2D({ channels: { density: { type: 'f32' } }, resolution: [4, 3] }),
    },
  });
  const transferSystem = new VFXSystem(counter.runtime);
  const transferInstance = transferSystem.spawn(transferEffect);
  await transferSystem.update(0);
  await gridView(transferInstance).rasterizeParticles(
    [
      [0.1, 0.1],
      [0.1, 0.1],
      [0.8, 0.7],
    ],
    'density',
    0.5,
  );
  const rasterized = grid2DSnapshotChannel(await gridView(transferInstance).capture(), 'density');

  const main = await simulate(counter.runtime, mainEffect(), 1 / 30, 30);
  const density = grid2DSnapshotChannel(main.snapshot, 'density');
  const temperature = grid2DSnapshotChannel(main.snapshot, 'temperature');
  paintSmoke(density, temperature, main.snapshot.resolution);
  await monitor.captureGpuSamples(async () => {
    await main.system.update(1 / 30);
  });

  const validation = {
    analyticInjectionAndDissipation: Math.abs(analyticActual - analyticExpected) <= 2e-5,
    consoleClean: messages.length === 0,
    gridToParticleSampleNumeric:
      Math.abs(particleSample - independentSample) <= 2e-5 &&
      Math.abs(cpuParticleSample - independentSample) <= 1e-7,
    iterationCountEffective: pressureDifference > 1e-5,
    liveComputeSubmissionCount:
      counter.submissions() > 30 * 20 && gridView(main.instance).submissionCount > 30 * 20,
    nonSymmetricAdvection:
      downstream > upstream + 1e-4 &&
      downstream > yMirror + 1e-4 &&
      downstream > transposeAlias + 1e-4,
    visualDensityNonEmpty: density.some((value) => value > 0.02),
    particleToGridAtomicRasterize:
      Math.abs(rasterized[0]! - 1) <= 1 / 4096 &&
      Math.abs(rasterized[2 * 4 + 3]! - 0.5) <= 1 / 4096,
  };
  const result = {
    backend: 'WebGPU',
    checks: {
      analytic: { actual: analyticActual, expected: analyticExpected },
      direction: { downstream, transposeAlias, upstream, yMirror },
      particleSample: {
        actual: particleSample,
        cpu: cpuParticleSample,
        expected: independentSample,
      },
      rasterized: [...rasterized],
      pressureDifference,
      submissions: { all: counter.submissions(), main: gridView(main.instance).submissionCount },
    },
    ok: Object.values(validation).every(Boolean),
    validation,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = 'complete';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'All checks passed'
    : 'Validation failed';
  required<HTMLElement>('#submission-value').textContent = String(result.checks.submissions.main);
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false, requestedBackend });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = `Failed: ${message}`;
});
