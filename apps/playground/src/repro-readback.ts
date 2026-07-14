import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { createDrainedReadback } from './readback';

const WIDTH = 640;
const HEIGHT = 360;
const DEFAULT_RENDER_FRAMES = 18;

type BackendLike = {
  isWebGPUBackend?: boolean;
};

const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const drainEnabled = readBooleanParameter('drain', false);
const renderFrames = readIntegerParameter('frames', DEFAULT_RENDER_FRAMES, 12, 240);
const statusValue = required<HTMLElement>('#status-value');

root.dataset.backendRequested = 'webgpu';
root.dataset.drain = drainEnabled ? 'enabled' : 'disabled';
root.dataset.headless = 'true';
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';
required<HTMLElement>('#drain-value').textContent = drainEnabled
  ? 'enabled (1x1 each frame)'
  : 'off';
required<HTMLElement>('#frames-value').textContent = String(renderFrames);

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing readback reproduction element: ${selector}`);
  return element;
}

function readBooleanParameter(name: string, fallback: boolean): boolean {
  const value = query.get(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  throw new Error(`${name} must be one of 0, 1, false, or true.`);
}

function readIntegerParameter(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

async function run(): Promise<void> {
  // Keep this reproduction on raw Three r185: no nachi runtime, renderer adapter, or present path.
  const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (backend.isWebGPUBackend !== true)
    throw new Error('The readback reproduction requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  const monitor = createPerformanceMonitor(renderer, {
    mode: 'headless',
    page: 'repro-readback',
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x123b64);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry(1.25, 1.25);
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xff6f91 });
  const quad = new THREE.Mesh(geometry, material);
  scene.add(quad);

  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: false });
  const drainReadback = createDrainedReadback(renderer, target);
  for (let frame = 0; frame < renderFrames; frame += 1) {
    quad.rotation.z = (frame / renderFrames) * Math.PI * 0.25;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    if (drainEnabled) await drainReadback();
  }

  const pixels = new Uint8Array(
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT),
  );
  let nonZeroBytes = 0;
  let maximumByte = 0;
  for (const value of pixels) {
    if (value !== 0) nonZeroBytes += 1;
    maximumByte = Math.max(maximumByte, value);
  }
  const allZero = nonZeroBytes === 0;
  const checks = {
    activeBackendWebGPU: backend.isWebGPUBackend === true,
    drainedModeHasPixels: !drainEnabled || !allZero,
    fullReadbackCompleted: pixels.byteLength >= WIDTH * HEIGHT * 4,
    renderedRequestedFrames: renderFrames >= 12,
  };
  const result = {
    checks,
    comparisonKey: {
      drain: drainEnabled,
      drainReadbacks: drainEnabled ? renderFrames : 0,
      frames: renderFrames,
      height: HEIGHT,
      readbackFreeFrames: drainEnabled ? 0 : renderFrames,
      width: WIDTH,
    },
    observation: {
      allZero,
      byteLength: pixels.byteLength,
      interpretation: allZero ? 'empty-first-full-readback' : 'pixels-present',
      maximumByte,
      nonZeroBytes,
    },
    ok: Object.values(checks).every(Boolean),
    schema: 'three-r185.readback-drain-repro.v1',
    threeRevision: THREE.REVISION,
  };
  monitor.publish();
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  root.dataset.sceneReady = 'true';
  statusValue.textContent = allZero
    ? 'full readback was all zero'
    : 'full readback contained pixels';

  target.dispose();
  geometry.dispose();
  material.dispose();
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  statusValue.textContent = message;
});
