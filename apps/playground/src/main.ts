import * as THREE from 'three/webgpu';
import { color, mix, normalLocal, positionLocal, sin, time } from 'three/tsl';
import { Pane } from 'tweakpane';

import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './style.css';

const sceneHost = document.querySelector<HTMLDivElement>('#scene');
const backendValue = document.querySelector<HTMLElement>('#backend-value');
const fpsValue = document.querySelector<HTMLElement>('#fps-value');
const frameValue = document.querySelector<HTMLElement>('#frame-value');
const statusValue = document.querySelector<HTMLElement>('#status-value');

if (!sceneHost || !backendValue || !fpsValue || !frameValue || !statusValue) {
  throw new Error('Playground UI failed to initialize.');
}

const requestedBackend = new URLSearchParams(window.location.search).get('backend')?.toLowerCase();
const forceWebGL = requestedBackend === 'webgl';
document.documentElement.dataset.backendRequested = requestedBackend ?? 'auto';
document.documentElement.dataset.rendererStatus = 'initializing';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050813);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.15, 4.6);

const renderer = await createPlaygroundRenderer({
  antialias: true,
  forceWebGL,
  trackTimestamp: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
sceneHost.append(renderer.domElement);

await renderer.init();

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

const backend = renderer.backend as RendererBackendLike;
const activeBackend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
const performanceMonitor = createPerformanceMonitor(renderer, {
  gpuScopes: ['render'],
  mode: 'visual',
  page: 'playground',
});
backendValue.textContent = activeBackend;
document.documentElement.dataset.backend = activeBackend;
document.documentElement.dataset.rendererStatus = 'ready';
statusValue.textContent = 'Ready';

let rendererFailed = false;

if (backend.isWebGPUBackend && backend.device) {
  void backend.device.lost.then((info) => {
    rendererFailed = true;
    const reason = info.reason ?? 'unknown';
    const message = info.message ?? '';
    const detail = message ? `${reason}: ${message}` : reason;

    document.documentElement.dataset.rendererStatus = 'device-lost';
    document.documentElement.dataset.deviceLostReason = reason;
    document.documentElement.dataset.deviceLostMessage = message;
    statusValue.textContent = `Device lost (${detail})`;
    fpsValue.textContent = 'Stopped';
    frameValue.textContent = '-- ms';
    void renderer.setAnimationLoop(null);
  });
}

scene.add(new THREE.HemisphereLight(0xa8eaff, 0x120624, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 4.5);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);

const material = new THREE.MeshStandardNodeMaterial({
  metalness: 0.2,
  roughness: 0.25,
});

// Both the vertex and fragment stages use composed TSL expressions. The animated normal
// displacement proves vertex-node compilation while the gradient/pulse proves color-node compilation.
const wave = sin(positionLocal.y.mul(5).add(time.mul(2.2))).mul(0.09);
material.positionNode = positionLocal.add(normalLocal.mul(wave));

const verticalGradient = positionLocal.y.add(0.85).div(1.7).clamp(0, 1);
const movingPulse = sin(time.mul(3).add(positionLocal.x.mul(4)))
  .mul(0.5)
  .add(0.5);
const colorMix = verticalGradient.mul(0.72).add(movingPulse.mul(0.28)).clamp(0, 1);
material.colorNode = mix(color('#20c8ff'), color('#ff4fd8'), colorMix);

const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.9, 0.28, 192, 32), material);
scene.add(mesh);

const settings = {
  rotationSpeed: 0.65,
};

const pane = new Pane({ title: 'Live controls' });
pane.addBinding(settings, 'rotationSpeed', {
  label: 'Rotation speed',
  min: 0,
  max: 2,
  step: 0.05,
});

let previousTimestamp: number | undefined;
let smoothedFrameMs = 1000 / 60;
let lastStatsUpdate = 0;
let sceneReady = false;

renderer.setAnimationLoop((timestamp: number) => {
  if (rendererFailed) return;

  const frameMs =
    previousTimestamp === undefined ? 1000 / 60 : Math.max(timestamp - previousTimestamp, 0.01);
  const deltaSeconds = Math.min(frameMs / 1000, 0.1);
  previousTimestamp = timestamp;
  mesh.rotation.x += deltaSeconds * settings.rotationSpeed * 0.45;
  mesh.rotation.y += deltaSeconds * settings.rotationSpeed;

  smoothedFrameMs += (frameMs - smoothedFrameMs) * 0.08;

  if (timestamp - lastStatsUpdate >= 250) {
    fpsValue.textContent = (1000 / smoothedFrameMs).toFixed(0);
    frameValue.textContent = `${smoothedFrameMs.toFixed(1)} ms`;
    lastStatsUpdate = timestamp;
  }

  renderer.render(scene, camera);
  performanceMonitor.recordFrame(timestamp);

  if (!sceneReady) {
    sceneReady = true;
    requestAnimationFrame(() => {
      document.documentElement.dataset.sceneReady = 'true';
    });
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
