import {
  VFXSystem,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  lifetime,
  lightIntensity,
  lightRenderer,
  positionSphere,
  type TextureRef,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
} from './three-kernel-adapter';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m10-lit.css';

const WIDTH = 192;
const HEIGHT = 192;
const STEP = 1 / 60;
const root = document.documentElement;
const messages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  messages.push(`warning: ${values.map(String).join(' ')}`);
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  messages.push(`error: ${values.map(String).join(' ')}`);
  originalError(...values);
};

type BackendLike = {
  readonly device?: {
    readonly features?: { has(name: string): boolean };
    readonly limits?: { maxStorageBuffersPerShaderStage?: number };
    readonly lost: Promise<{ message?: string; reason?: string }>;
  };
  readonly isWebGPUBackend?: boolean;
};

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M10 lit element: ${selector}`);
  return element;
}

function textureRef(uri: string): TextureRef {
  return { assetType: 'texture', kind: 'asset-ref', uri };
}

function normalTexture(): THREE.DataTexture {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = ((x + 0.5) / size) * 1.45 - 0.72;
      const ny = ((y + 0.5) / size) * 0.5 - 0.25;
      const nz = Math.sqrt(Math.max(1 - nx * nx - ny * ny, 0.04));
      const offset = (y * size + x) * 4;
      data[offset] = Math.round((nx * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function difference(left: Uint8Array, right: Uint8Array): { changed: number; mean: number } {
  let changed = 0;
  let total = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const value =
      Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) +
      Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0)) +
      Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0));
    total += value;
    if (value > 6) changed += 1;
  }
  return { changed, mean: total / (WIDTH * HEIGHT * 3) };
}

function regionEnergy(pixels: Uint8Array, x0: number, x1: number): number {
  let total = 0;
  let count = 0;
  for (let y = 52; y < 140; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      total +=
        (pixels[offset] ?? 0) * 0.2126 +
        (pixels[offset + 1] ?? 0) * 0.7152 +
        (pixels[offset + 2] ?? 0) * 0.0722;
      count += 1;
    }
  }
  return total / count;
}

function imageStats(panels: readonly Uint8Array[]) {
  let foreground = 0;
  let saturated = 0;
  let pixels = 0;
  for (const panel of panels) {
    for (let offset = 0; offset < panel.length; offset += 4) {
      const energy = (panel[offset] ?? 0) + (panel[offset + 1] ?? 0) + (panel[offset + 2] ?? 0);
      if (energy > 24) foreground += 1;
      if (energy > 744) saturated += 1;
      pixels += 1;
    }
  }
  return { foregroundRatio: foreground / pixels, saturatedRatio: saturated / pixels };
}

function pointDifference(
  left: Uint8Array,
  right: Uint8Array,
  point: readonly [number, number],
): number {
  const offset = (point[1] * WIDTH + point[0]) * 4;
  return (
    Math.abs(left[offset]! - right[offset]!) +
    Math.abs(left[offset + 1]! - right[offset + 1]!) +
    Math.abs(left[offset + 2]! - right[offset + 2]!)
  );
}

function strongestDifferenceInHalf(
  left: Uint8Array,
  right: Uint8Array,
  half: 'left' | 'right',
): { difference: number; point: readonly [number, number] } {
  const midpoint = Math.floor(WIDTH / 2);
  const x0 = half === 'left' ? 0 : midpoint;
  const x1 = half === 'left' ? midpoint : WIDTH;
  let strongest: { difference: number; point: readonly [number, number] } = {
    difference: -1,
    point: [x0, 0],
  };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const point = [x, y] as const;
      const sample = { difference: pointDifference(left, right, point), point };
      if (sample.difference > strongest.difference) strongest = sample;
    }
  }
  return strongest;
}

function paint(left: Uint8Array, right: Uint8Array): void {
  const canvas = required<HTMLCanvasElement>('#lit-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('M10 lit canvas has no 2D context.');
  const output = context.createImageData(WIDTH * 2, HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let panel = 0; panel < 2; panel += 1) {
      const pixels = panel === 0 ? left : right;
      const sourceY = HEIGHT - 1 - y;
      for (let x = 0; x < WIDTH; x += 1) {
        const source = (sourceY * WIDTH + x) * 4;
        const target = (y * WIDTH * 2 + panel * WIDTH + x) * 4;
        output.data.set(pixels.subarray(source, source + 4), target);
      }
    }
  }
  context.putImageData(output, 0, 0);
}

async function run(): Promise<void> {
  root.dataset.rendererStatus = 'initializing';
  root.dataset.spikeStatus = 'running';
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('M10 lit particles require WebGPU.');
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';

  const normalRef = textureRef('procedural://m10-lit/asymmetric-normal');
  const normalMap = normalTexture();
  const sprite = (lit: boolean | { readonly normalMap: TextureRef }) =>
    defineEmitter({
      capacity: 1,
      init: [positionSphere({ radius: 0 }), lifetime(10)],
      integration: 'none',
      render: billboard({ blending: 'alpha', lit }),
      spawn: burst({ count: 1 }),
    });
  const effect = defineEffect({
    elements: {
      flat: sprite(true),
      mapped: sprite({ normalMap: normalRef }),
      source: defineEmitter({
        capacity: 1,
        // Keep physical-lighting contrast while preserving headroom below the 10% saturation cap.
        init: [positionSphere({ radius: 0 }), lifetime(10), lightIntensity(14)],
        integration: 'none',
        render: lightRenderer({ maxLights: 1, radiusScale: 5 }),
        spawn: burst({ count: 1 }),
      }),
      unlit: sprite(false),
    },
  });
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
  const system = new VFXSystem(runtime, undefined, { aliveCountReadbackInterval: 1 });
  const instance = system.spawn(effect, { seed: 1010 });
  await system.update(0);
  await system.update(STEP);
  const view = (key: string): VfxEmitterRuntimeView => {
    const value = instance.getEmitter(key);
    if (!value) throw new Error(`M10 lit emitter "${key}" is missing.`);
    return value;
  };
  const resolveTexture = createThreeTextureResolver(new Map([[normalRef.uri, normalMap]]));
  const flatView = view('flat');
  const mappedView = view('mapped');
  const unlitView = view('unlit');
  const sourceView = view('source');
  const flatLeft = materializeThreeSpriteDraw(flatView.program, flatView.kernels);
  const flatRight = materializeThreeSpriteDraw(flatView.program, flatView.kernels);
  flatLeft.position.set(-0.83, 0.12, 0);
  flatRight.position.set(0.58, -0.08, 0);
  const mapped = materializeThreeSpriteDraw(mappedView.program, mappedView.kernels, 0, {
    resolveTexture,
  });
  const flatCenter = materializeThreeSpriteDraw(flatView.program, flatView.kernels);
  const unlit = materializeThreeSpriteDraw(unlitView.program, unlitView.kernels);
  const lightDraw = materializeThreeLightDraw(sourceView.program, sourceView.kernels);
  await lightDraw.update(renderer);
  await lightDraw.update(renderer);
  lightDraw.group.position.set(-1.34, 0.37, 1.12);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010204);
  scene.add(lightDraw.group);
  const camera = new THREE.OrthographicCamera(-1.8, 1.8, 1.35, -1.35, 0.1, 10);
  camera.position.z = 4;
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  const capture = async (objects: readonly THREE.Object3D[]): Promise<Uint8Array> => {
    for (const object of objects) scene.add(object);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    const pixels = compactRgba8Readback(
      new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT)),
      WIDTH,
      HEIGHT,
      true,
    );
    for (const object of objects) scene.remove(object);
    return pixels;
  };

  const leftLight = await capture([flatLeft, flatRight]);
  lightDraw.group.position.set(1.08, -0.24, 1.26);
  const rightLight = await capture([flatLeft, flatRight]);
  const leftDominance = {
    left: regionEnergy(leftLight, 34, 82),
    right: regionEnergy(leftLight, 110, 158),
  };
  const rightDominance = {
    left: regionEnergy(rightLight, 34, 82),
    right: regionEnergy(rightLight, 110, 158),
  };

  lightDraw.group.position.x = 1.05;
  const flatPixels = await capture([flatCenter]);
  const mappedPixels = await capture([mapped]);
  const normalMapDifference = difference(flatPixels, mappedPixels);
  // Derive both probes from the rendered diff so raster/backend shifts cannot create dead samples.
  const asymmetricSamples = [
    strongestDifferenceInHalf(flatPixels, mappedPixels, 'left'),
    strongestDifferenceInHalf(flatPixels, mappedPixels, 'right'),
  ];
  lightDraw.group.position.x = -1.1;
  const unlitLeft = await capture([unlit]);
  lightDraw.group.position.x = 1.1;
  const unlitRight = await capture([unlit]);
  const unlitDifference = difference(unlitLeft, unlitRight);
  const visual = imageStats([leftLight, rightLight]);
  const checks = {
    consoleClean: messages.length === 0,
    lightRendererSelected: lightDraw.stats.selectedCount === 1,
    normalMapDifference:
      normalMapDifference.changed > 240 &&
      normalMapDifference.mean > 0.35 &&
      asymmetricSamples.every(({ difference }) => difference > 60),
    unlitNonRegression: unlitDifference.changed === 0 && unlitDifference.mean === 0,
    leftRightSwap:
      leftDominance.left > leftDominance.right * 1.12 &&
      rightDominance.right > rightDominance.left * 1.12,
    // Saturation comes from the fixed-emissive flash/background, independent of light intensity;
    // the upper bound includes margin over the measured 0.103 baseline.
    visualBounds:
      visual.foregroundRatio > 0.01 && visual.foregroundRatio < 0.5 && visual.saturatedRatio < 0.13,
  };
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['render'],
    mode: new URLSearchParams(location.search).get('headless') === '1' ? 'headless' : 'visual',
    page: 'm10-lit',
  });
  scene.add(mapped);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  scene.remove(mapped);
  await monitor.resolveGpuTimestamps();
  monitor.publish();
  checks.consoleClean = messages.length === 0;
  const result = {
    checks,
    evidence: {
      lightRenderer: lightDraw.stats,
      normalMapAsymmetricSamples: asymmetricSamples,
      leftDominance,
      normalMapDifference,
      rightDominance,
      unlitDifference,
      visual,
    },
    ok: Object.values(checks).every(Boolean),
    schema: 'nachi.m10-lit-smoke.v1',
  };
  paint(leftLight, rightLight);
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm10-lit.png', selector: '#lit-visual' },
  ]);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  required<HTMLElement>('#contract-value').textContent = result.ok ? 'all checks passed' : 'failed';
  target.dispose();
  lightDraw.dispose();
  normalMap.dispose();
  renderer.dispose();
}

void run().catch((error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = text;
  root.dataset.spikeResult = JSON.stringify({ error: text, ok: false });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#contract-value').textContent = text;
  console.error(error);
});
