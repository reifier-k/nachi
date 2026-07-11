import {
  bloomPreset,
  createPostPipeline,
  radialBlur,
  screenDistortion,
  type PostPipelineConfig,
} from '@nachi/post';
import * as THREE from 'three/webgpu';
import { texture, uniform, uv } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m10-post.css';

const SIZE = 128;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const backendValue = required<HTMLElement>('#backend-value');
const statusValue = required<HTMLElement>('#status-value');
const visualCanvas = required<HTMLCanvasElement>('#post-visual');
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

root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';
root.dataset.backendRequested = requestedBackend;

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M10 post UI element: ${selector}`);
  return element;
}

type Pixel = readonly [number, number, number, number];
type SceneFixture = {
  readonly camera: THREE.OrthographicCamera;
  readonly dispose: () => void;
  readonly scene: THREE.Scene;
};

function createFixture(pixel: (x: number, y: number) => Pixel): SceneFixture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) data.set(pixel(x, y), (y * SIZE + x) * 4);
  }
  const map = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  map.colorSpace = THREE.NoColorSpace;
  map.flipY = false;
  map.minFilter = THREE.NearestFilter;
  map.magFilter = THREE.NearestFilter;
  map.needsUpdate = true;
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = texture(map, uv()).rgb;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  return {
    camera,
    scene,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}

function edgePattern(x: number, y: number): Pixel {
  const edge = x >= Math.round(SIZE * 0.57);
  const green = (y * 37 + y * y * 3) % 211;
  const blue = (x * 19 + y * 43) % 251;
  return [edge ? 238 : 12, green, blue, 255];
}

function irregularPattern(x: number, y: number): Pixel {
  return [(x * 61 + y * 17) % 256, (x * 13 + y * 71) % 256, (x * 29 + y * 31) % 256, 255];
}

function blurPattern(x: number, y: number): Pixel {
  const center = Math.abs(x - 64) <= 2 && Math.abs(y - 64) <= 2;
  const peripheral = x >= 92 && x <= 96 && Math.abs(y - 64) <= 2;
  return [peripheral ? 255 : 0, center ? 220 : 0, 0, 255];
}

function bloomPattern(x: number, y: number): Pixel {
  const primary = Math.abs(x - 84) <= 1 && Math.abs(y - 42) <= 1;
  const discriminator = x === 45 && y === 91;
  return [primary ? 255 : discriminator ? 210 : 0, primary ? 245 : 0, primary ? 230 : 0, 255];
}

function compositionOrderPattern(x: number, y: number): Pixel {
  const primary = x >= 55 && x <= 61 && y >= 61 && y <= 67;
  const vertical = x >= 76 && x <= 78 && y >= 42 && y <= 58;
  const horizontal = x >= 69 && x <= 85 && y >= 49 && y <= 51;
  return [primary || vertical || horizontal ? 255 : 0, primary ? 248 : 0, primary ? 232 : 0, 255];
}

function absoluteDifference(
  left: Uint8Array,
  right: Uint8Array,
): { changed: number; mean: number; total: number } {
  let total = 0;
  let changed = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const difference =
      Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) +
      Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0)) +
      Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0));
    total += difference;
    if (difference > 3) changed += 1;
  }
  return { changed, mean: total / (SIZE * SIZE * 3), total };
}

function channel(pixels: Uint8Array, x: number, y: number, component: 0 | 1 | 2): number {
  return pixels[(y * SIZE + x) * 4 + component] ?? 0;
}

function firstRedEdge(pixels: Uint8Array, row: number): number {
  for (let x = 1; x < SIZE - 1; x += 1) {
    if (channel(pixels, x, row, 0) >= 128) return x;
  }
  return -1;
}

function ringEnergy(
  pixels: Uint8Array,
  center: readonly [number, number],
  low: number,
  high: number,
): number {
  let energy = 0;
  let count = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x - center[0], y - center[1]);
      if (distance >= low && distance < high) {
        energy += channel(pixels, x, y, 0) + channel(pixels, x, y, 1) + channel(pixels, x, y, 2);
        count += 1;
      }
    }
  }
  return count === 0 ? 0 : energy / count;
}

function brightestPixel(pixels: Uint8Array): readonly [number, number] {
  let bestEnergy = -1;
  let best: readonly [number, number] = [0, 0];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const energy = channel(pixels, x, y, 0) + channel(pixels, x, y, 1) + channel(pixels, x, y, 2);
      if (energy > bestEnergy) {
        bestEnergy = energy;
        best = [x, y];
      }
    }
  }
  return best;
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE);
  renderer.outputColorSpace = THREE.NoColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 1);
  await renderer.init();
  const webgpu = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backend = webgpu ? 'WebGPU' : 'WebGL2';
  const expectedBackend = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (backend !== expectedBackend)
    throw new Error(`Backend mismatch: expected ${expectedBackend}, got ${backend}`);
  backendValue.textContent = backend;
  root.dataset.backend = backend;
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const target = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: false });
  target.texture.colorSpace = THREE.NoColorSpace;
  const pipelines: ReturnType<typeof createPostPipeline>[] = [];
  const fixtures: SceneFixture[] = [];

  const read = async (): Promise<Uint8Array> => {
    const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
    const dense = compactRgba8Readback(new Uint8Array(raw), SIZE, SIZE, webgpu);
    if (webgpu) return dense;
    const topDown = new Uint8Array(dense.length);
    const stride = SIZE * 4;
    for (let y = 0; y < SIZE; y += 1)
      topDown.set(dense.subarray((SIZE - 1 - y) * stride, (SIZE - y) * stride), y * stride);
    return topDown;
  };
  const renderDirect = async (fixture: SceneFixture): Promise<Uint8Array> => {
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(fixture.scene, fixture.camera);
    return read();
  };
  const makePipeline = (fixture: SceneFixture, config: PostPipelineConfig) => {
    const pipeline = createPostPipeline(renderer, fixture.scene, fixture.camera, {
      ...config,
      outputColorTransform: false,
    });
    pipelines.push(pipeline);
    return pipeline;
  };
  const renderPost = async (
    pipeline: ReturnType<typeof createPostPipeline>,
  ): Promise<Uint8Array> => {
    renderer.setRenderTarget(target);
    renderer.clear();
    pipeline.render();
    return read();
  };

  const edgeFixture = createFixture(edgePattern);
  fixtures.push(edgeFixture);
  const edgeBaseline = await renderDirect(edgeFixture);
  const shockwave = screenDistortion({
    shockwaves: [
      {
        center: [0.27, 0.38],
        radius: 0.36,
        ringWidth: 0.09,
        strength: 0.045,
        speed: 0,
        startTime: 0,
        duration: 2,
      },
    ],
  });
  const shockPipeline = makePipeline(edgeFixture, { distortion: shockwave });
  shockPipeline.controls.setTime(0);
  const shockPixels = await renderPost(shockPipeline);
  const sampleRow = Math.round(SIZE * 0.58);
  const baselineEdge = firstRedEdge(edgeBaseline, sampleRow);
  const distortedEdge = firstRedEdge(shockPixels, sampleRow);
  const edgeShiftPixels = baselineEdge - distortedEdge;
  const asymmetricPoint = { center: [0.27, 0.38], point: [0.57, 0.58], radialDelta: [0.3, 0.2] };

  const hazeFixture = createFixture(irregularPattern);
  fixtures.push(hazeFixture);
  const hazePass = screenDistortion({
    heatHaze: [{ center: [0.61, 0.44], size: [0.72, 0.54], strength: 0.018, scale: 23 }],
  });
  const hazePipeline = makePipeline(hazeFixture, { distortion: hazePass });
  hazePipeline.controls.setTime(0.1);
  const hazeAtFirst = await renderPost(hazePipeline);
  hazePipeline.controls.setTime(0.73);
  const hazeAtSecond = await renderPost(hazePipeline);
  const hazeDifference = absoluteDifference(hazeAtFirst, hazeAtSecond);
  const disabledRegion = {
    center: [0.61, 0.44] as const,
    enabled: 0,
    feather: 0.2,
    scale: 23,
    size: [0.72, 0.54] as const,
    speed: [0.11, -0.07] as const,
    strength: 0.018,
  };
  hazePipeline.controls.setHeatHaze(0, disabledRegion);
  hazePipeline.controls.setTime(0.1);
  const hazeDisabledFirst = await renderPost(hazePipeline);
  hazePipeline.controls.setTime(0.73);
  const hazeDisabledSecond = await renderPost(hazePipeline);
  const hazeDisabledDifference = absoluteDifference(hazeDisabledFirst, hazeDisabledSecond);

  const externalCenter = uniform(new THREE.Vector2(0.34, 0.38));
  const externalStrength = uniform(0.035);
  const externalTime = uniform(0.1);
  const externalNodePipeline = makePipeline(hazeFixture, {
    distortion: screenDistortion({
      shockwaves: [
        {
          center: externalCenter,
          duration: 2,
          radius: 0.28,
          ringWidth: 0.12,
          speed: 0.16,
          strength: externalStrength,
        },
      ],
      time: externalTime,
    }),
  });
  const externalInitial = await renderPost(externalNodePipeline);
  externalCenter.value.set(0.66, 0.62);
  const externalCenterChanged = await renderPost(externalNodePipeline);
  const externalCenterDifference = absoluteDifference(externalInitial, externalCenterChanged);
  externalStrength.value = 0;
  const externalStrengthChanged = await renderPost(externalNodePipeline);
  const externalStrengthDifference = absoluteDifference(
    externalCenterChanged,
    externalStrengthChanged,
  );
  externalStrength.value = 0.035;
  externalTime.value = 0.8;
  const externalTimeChanged = await renderPost(externalNodePipeline);
  const externalTimeDifference = absoluteDifference(externalCenterChanged, externalTimeChanged);

  const radialFixture = createFixture(blurPattern);
  fixtures.push(radialFixture);
  const radialBaseline = await renderDirect(radialFixture);
  const radialPipeline = makePipeline(radialFixture, {
    radialBlur: radialBlur({ center: [0.5, 0.5], strength: 0.48, samples: 12 }),
  });
  const radialPixels = await renderPost(radialPipeline);
  const centerDifference = Math.abs(
    channel(radialPixels, 64, 64, 1) - channel(radialBaseline, 64, 64, 1),
  );
  let peripheralSpreadPixels = 0;
  let peripheralSpreadEnergy = 0;
  for (let y = 60; y <= 68; y += 1) {
    for (let x = 98; x < 126; x += 1) {
      const red = channel(radialPixels, x, y, 0);
      peripheralSpreadEnergy += red;
      if (red > 4) peripheralSpreadPixels += 1;
    }
  }

  const bloomFixture = createFixture(bloomPattern);
  fixtures.push(bloomFixture);
  const bloomBaseline = await renderDirect(bloomFixture);
  const bloomPipeline = makePipeline(bloomFixture, {
    bloom: bloomPreset('soft', { strength: 1.2, radius: 0.5, threshold: 0.7 }),
  });
  const bloomPixels = await renderPost(bloomPipeline);
  // Derive the raster center from the control readback so texture-row origin differences cannot
  // make either backend accidentally test the mirrored location.
  const bloomCenter = brightestPixel(bloomBaseline);
  const bloomProfile = {
    inner: ringEnergy(bloomPixels, bloomCenter, 2, 5),
    middle: ringEnergy(bloomPixels, bloomCenter, 5, 10),
    outer: ringEnergy(bloomPixels, bloomCenter, 10, 20),
    baselineMiddle: ringEnergy(bloomBaseline, bloomCenter, 5, 10),
  };

  // Keep every highlight inside the displacement region for either texture-row origin. The
  // spatially varying field also prevents bloom and distortion from collapsing to a local
  // translation, which would make their compositions nearly commute.
  const orderFixture = createFixture(compositionOrderPattern);
  fixtures.push(orderFixture);
  const orderDistortion = screenDistortion({
    heatHaze: [
      {
        center: [0.55, 0.45],
        size: [0.58, 0.58],
        strength: 0.055,
        scale: 37,
        speed: [0, 0],
        feather: 0.12,
      },
    ],
  });
  const orderBloom = bloomPreset('intense', { threshold: 0.68, strength: 1.1 });
  const distortionThenBloom = makePipeline(orderFixture, {
    bloom: orderBloom,
    distortion: orderDistortion,
    order: ['distortion', 'bloom'],
  });
  distortionThenBloom.controls.setTime(0);
  const distortionThenBloomPixels = await renderPost(distortionThenBloom);
  const bloomThenDistortion = makePipeline(orderFixture, {
    bloom: orderBloom,
    distortion: orderDistortion,
    order: ['bloom', 'distortion'],
  });
  bloomThenDistortion.controls.setTime(0);
  const bloomThenDistortionPixels = await renderPost(bloomThenDistortion);
  const orderDifference = absoluteDifference(distortionThenBloomPixels, bloomThenDistortionPixels);

  // Perf v1 is intentionally a separate render after every correctness readback and assertion input.
  const perfPipeline = makePipeline(bloomFixture, {
    bloom: bloomPreset('soft'),
    distortion: shockwave,
    radialBlur: radialBlur({ samples: 8 }),
  });
  perfPipeline.controls.setTime(0.25);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['render'],
    mode: query.get('headless') === '1' ? 'headless' : 'visual',
    page: 'm10-post',
  });
  renderer.setRenderTarget(target);
  perfPipeline.render();
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();

  const validation = {
    bloomDiffusion:
      bloomProfile.inner > bloomProfile.middle &&
      bloomProfile.middle > bloomProfile.outer &&
      bloomProfile.middle > bloomProfile.baselineMiddle + 1,
    compositionOrder: orderDifference.changed > 120 && orderDifference.mean > 0.2,
    consoleClean: consoleMessages.length === 0,
    externalNodeBindings:
      externalCenterDifference.changed > 300 &&
      externalCenterDifference.mean > 0.5 &&
      externalStrengthDifference.changed > 200 &&
      externalStrengthDifference.mean > 0.2 &&
      externalTimeDifference.changed > 200 &&
      externalTimeDifference.mean > 0.2,
    heatHazeDisabledControl: hazeDisabledDifference.total === 0,
    heatHazeTimeDifference: hazeDifference.changed > 500 && hazeDifference.mean > 1,
    radialBlur: centerDifference <= 3 && peripheralSpreadPixels >= 4 && peripheralSpreadEnergy > 30,
    shockwaveDisplacement:
      baselineEdge >= 0 && distortedEdge >= 0 && edgeShiftPixels >= 3 && edgeShiftPixels <= 12,
    visualReadback: [
      shockPixels,
      hazeAtSecond,
      externalTimeChanged,
      radialPixels,
      bloomPixels,
    ].every((pixels) => pixels.some((value, index) => index % 4 !== 3 && value > 8)),
  };

  paintPanels(visualCanvas, [
    shockPixels,
    hazeAtSecond,
    radialPixels,
    bloomPixels,
    distortionThenBloomPixels,
    bloomThenDistortionPixels,
  ]);
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm10-post.png', selector: '#post-visual' },
  ]);
  const result = {
    backend,
    backendCapability: { renderPipeline: true, status: 'supported-and-measured' },
    ok: Object.values(validation).every(Boolean),
    readback: {
      bloomProfile,
      compositionOrder: orderDifference,
      externalNodeBindings: {
        centerDifference: externalCenterDifference,
        strengthDifference: externalStrengthDifference,
        timeDifference: externalTimeDifference,
      },
      heatHaze: { disabledDifference: hazeDisabledDifference, timeDifference: hazeDifference },
      radialBlur: { centerDifference, peripheralSpreadEnergy, peripheralSpreadPixels },
      shockwave: { asymmetricPoint, baselineEdge, distortedEdge, edgeShiftPixels },
      source: 'RenderPipeline offscreen RenderTarget pixel readback',
      thresholdSpace: 'linear working space',
    },
    requestedBackend,
    schema: 'nachi.m10-post-smoke.v1',
    validation,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M10 post checks passed' : 'M10 post checks failed';

  for (const pipeline of pipelines) pipeline.dispose();
  for (const fixture of fixtures) fixture.dispose();
  target.dispose();
}

function paintPanels(canvas: HTMLCanvasElement, panels: readonly Uint8Array[]): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable for M10 readback presentation.');
  for (let panel = 0; panel < panels.length; panel += 1) {
    context.putImageData(
      new ImageData(new Uint8ClampedArray(panels[panel]!), SIZE, SIZE),
      panel * SIZE,
      0,
    );
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  statusValue.textContent = message;
  originalError(error);
});
