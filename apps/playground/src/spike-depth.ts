import * as THREE from 'three/webgpu';
import {
  color,
  cos,
  float,
  linearDepth,
  pass,
  screenUV,
  sin,
  time,
  uniform,
  uv,
  vec2,
  viewportDepthTexture,
} from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import './spike-depth.css';

type BackendName = 'WebGL2' | 'WebGPU';
type DeviceLostInfoLike = { message?: string; reason?: string };
type RendererBackendLike = {
  device?: { lost: Promise<DeviceLostInfoLike> };
  isWebGPUBackend?: boolean;
};

type DepthReadbackComparison = {
  changedPixelRatio: number;
  fadeOnPartiallyVisible: boolean;
  meanAbsoluteDifference: number;
  ok: boolean;
  sampledPixels: number;
};

type DepthResult = {
  ok: boolean;
  activeBackend: BackendName;
  depthAccess: {
    nodePath: 'linearDepth(viewportDepthTexture(screenUV))';
    status: 'encoded';
  };
  depthFade: 'off' | 'on';
  mode: 'headless' | 'visual';
  postProcessing: {
    className: 'RenderPipeline';
    status: 'encoded';
  };
  readback: DepthReadbackComparison | null;
  presented: boolean;
  renderTarget: 'canvas' | 'offscreen';
  requestedBackend: 'webgl' | 'webgpu';
};

const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const requestedBackend = readBackend();
const headless = query.get('headless') === '1';
const staticMode = query.get('static') === '1';

root.dataset.backendRequested = requestedBackend;
root.dataset.depthFade = query.get('fade') === '0' ? 'off' : 'on';
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

const sceneHost = requireElement<HTMLDivElement>('#scene');
const backendValue = requireElement<HTMLElement>('#backend-value');
const fadeValue = requireElement<HTMLElement>('#fade-value');
const depthValue = requireElement<HTMLElement>('#depth-value');
const postValue = requireElement<HTMLElement>('#post-value');
const statusValue = requireElement<HTMLElement>('#status-value');

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing depth spike UI element: ${selector}`);
  return element;
}

function readBackend(): 'webgl' | 'webgpu' {
  const value = query.get('backend')?.toLowerCase() ?? 'webgl';
  if (value !== 'webgl' && value !== 'webgpu') {
    throw new Error('backend must be either "webgpu" or "webgl".');
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installWebGlShaderErrorTrap(renderer: THREE.WebGPURenderer): void {
  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    const logs = [
      gl.getProgramInfoLog(program),
      gl.getShaderInfoLog(vertexShader),
      gl.getShaderInfoLog(fragmentShader),
    ].filter((value): value is string => Boolean(value?.trim()));
    throw new Error(logs.join('\n') || 'WebGL shader compilation failed.');
  };
}

function recordFailure(error: unknown): void {
  const message = errorMessage(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeStatus = 'error';
  root.dataset.depthResult = JSON.stringify({ ok: false, error: message });
  root.dataset.spikeResult = root.dataset.depthResult;
  statusValue.textContent = `Error: ${message}`;
}

async function runDepthSpike(): Promise<void> {
  const width = Math.max(window.innerWidth, 640);
  const height = Math.max(window.innerHeight, 360);
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setPixelRatio(headless ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  if (!headless) sceneHost.append(renderer.domElement);

  await renderer.init();
  const backend = renderer.backend as RendererBackendLike;
  const activeBackend: BackendName = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  const expectedBackend: BackendName = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (activeBackend !== expectedBackend) {
    throw new Error(`Backend mismatch: requested ${expectedBackend}, active ${activeBackend}.`);
  }
  if (activeBackend === 'WebGL2') installWebGlShaderErrorTrap(renderer);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['render'],
    mode: headless ? 'headless' : 'visual',
    page: 'spike-depth',
  });

  backendValue.textContent = activeBackend;
  root.dataset.backend = activeBackend;
  root.dataset.rendererStatus = 'ready';

  if (backend.device) {
    void backend.device.lost.then((info) => {
      const reason = info.reason ?? 'unknown';
      const message = info.message ?? '';
      root.dataset.deviceLostMessage = message;
      root.dataset.deviceLostReason = reason;
      root.dataset.rendererStatus = 'device-lost';
      root.dataset.spikeStatus = 'device-lost';
      root.dataset.depthResult = JSON.stringify({
        ok: false,
        error: `WebGPU device lost (${reason})${message ? `: ${message}` : ''}`,
      });
      root.dataset.spikeResult = root.dataset.depthResult;
      statusValue.textContent = `Device lost (${reason})`;
      void renderer.setAnimationLoop(null);
    });
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x071123);
  const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 50);
  camera.position.set(0, 1.25, 6.2);
  camera.lookAt(0, 0.15, 0);

  scene.add(new THREE.HemisphereLight(0x9cecff, 0x180a31, 2.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 4.2);
  keyLight.position.set(3, 5, 4);
  scene.add(keyLight);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({ color: 0x102542, metalness: 0.15, roughness: 0.78 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.25;
  scene.add(floor);

  const centerBox = new THREE.Mesh(
    new THREE.BoxGeometry(1.65, 1.65, 1.65),
    new THREE.MeshStandardMaterial({ color: 0xff5d7d, metalness: 0.18, roughness: 0.26 }),
  );
  centerBox.position.set(0, -0.35, 0);
  centerBox.rotation.set(0.18, 0.48, 0.08);
  scene.add(centerBox);

  const sideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.72, 48, 24),
    new THREE.MeshStandardMaterial({ color: 0x39d9ff, metalness: 0.32, roughness: 0.2 }),
  );
  sideSphere.position.set(-2.05, -0.48, -0.55);
  scene.add(sideSphere);

  const rearTorus = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.62, 0.2, 96, 16),
    new THREE.MeshStandardMaterial({ color: 0xffcc52, roughness: 0.34 }),
  );
  rearTorus.position.set(2, -0.28, -1.1);
  scene.add(rearTorus);

  const depthFadeEnabled = uniform(root.dataset.depthFade === 'on');
  const particleUv = uv();
  const radialAlpha = float(1).sub(particleUv.sub(0.5).length().mul(2)).clamp(0, 1).pow(0.7);
  const opaqueLinearDepth = linearDepth(viewportDepthTexture(screenUV));
  const particleLinearDepth = linearDepth();
  const intersectionFade = opaqueLinearDepth.sub(particleLinearDepth).div(0.035).clamp(0, 1);
  const selectedFade = depthFadeEnabled.select(intersectionFade, float(1));

  const spriteMaterial = new THREE.SpriteNodeMaterial({
    depthTest: true,
    depthWrite: false,
    transparent: true,
  });
  spriteMaterial.colorNode = color('#7cecff');
  spriteMaterial.opacityNode = radialAlpha.mul(selectedFade).mul(0.88);
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.position.set(0, -0.15, 0.72);
  sprite.scale.set(3.65, 3.65, 1);
  sprite.renderOrder = 10;
  scene.add(sprite);

  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  const distortionTime = staticMode ? float(0) : time;
  const distortion = vec2(
    sin(screenUV.y.mul(31).add(distortionTime.mul(1.7))),
    cos(screenUV.x.mul(27).sub(distortionTime.mul(1.3))),
  ).mul(0.009);
  const distortedColor = sceneColor.sample(screenUV.add(distortion).clamp(0.002, 0.998));
  const renderPipeline = new THREE.RenderPipeline(renderer);
  renderPipeline.outputNode = distortedColor;

  const updateFadeState = (): void => {
    const enabled = root.dataset.depthFade !== 'off';
    depthFadeEnabled.value = enabled;
    const normalizedState = enabled ? 'on' : 'off';
    if (root.dataset.depthFade !== normalizedState) root.dataset.depthFade = normalizedState;
    root.dataset.depthFadeApplied = String(enabled);
    fadeValue.textContent = enabled ? 'On' : 'Off';
  };
  updateFadeState();
  new MutationObserver(updateFadeState).observe(root, {
    attributeFilter: ['data-depth-fade'],
    attributes: true,
  });

  const createResult = (
    presented: boolean,
    readback: DepthReadbackComparison | null = null,
  ): DepthResult => ({
    activeBackend,
    depthAccess: {
      nodePath: 'linearDepth(viewportDepthTexture(screenUV))',
      status: 'encoded',
    },
    depthFade: root.dataset.depthFade === 'off' ? 'off' : 'on',
    mode: headless ? 'headless' : 'visual',
    ok: readback?.ok ?? true,
    postProcessing: { className: 'RenderPipeline', status: 'encoded' },
    presented,
    readback,
    renderTarget: headless ? 'offscreen' : 'canvas',
    requestedBackend,
  });

  const publishResult = (
    presented: boolean,
    readback: DepthReadbackComparison | null = null,
  ): DepthResult => {
    const result = createResult(presented, readback);
    root.dataset.depthResult = JSON.stringify(result);
    root.dataset.spikeResult = root.dataset.depthResult;
    root.dataset.depthAccess = 'encoded';
    root.dataset.postProcessing = 'encoded';
    depthValue.textContent = 'Encoded';
    postValue.textContent = 'Encoded';
    return result;
  };

  if (headless) {
    const targetWidth = 640;
    const targetHeight = 360;
    const offscreenTarget = new THREE.RenderTarget(targetWidth, targetHeight, {
      depthBuffer: true,
    });
    renderer.setRenderTarget(offscreenTarget);

    root.dataset.depthFade = 'on';
    updateFadeState();
    renderPipeline.render();
    const fadeOnPixels = await renderer.readRenderTargetPixelsAsync(
      offscreenTarget,
      0,
      0,
      targetWidth,
      targetHeight,
    );

    root.dataset.depthFade = 'off';
    updateFadeState();
    renderPipeline.render();
    const fadeOffPixels = await renderer.readRenderTargetPixelsAsync(
      offscreenTarget,
      0,
      0,
      targetWidth,
      targetHeight,
    );

    const readback = compareDepthReadbacks(fadeOnPixels, fadeOffPixels);
    root.dataset.depthFade = 'on';
    updateFadeState();
    renderer.setRenderTarget(null);
    const result = publishResult(false, readback);
    await performanceMonitor.resolveGpuTimestamps();
    performanceMonitor.publish();
    root.dataset.rendererStatus = 'ready';
    root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
    statusValue.textContent = result.ok
      ? `${activeBackend} offscreen depth readback verified (no canvas present)`
      : `${activeBackend} offscreen depth readback comparison failed`;
    return;
  }

  let firstFrame = true;
  renderer.setAnimationLoop((timestamp: number) => {
    if (!staticMode) {
      centerBox.rotation.y += 0.0025;
      rearTorus.rotation.x += 0.003;
      rearTorus.rotation.y -= 0.004;
    }
    renderPipeline.render();
    performanceMonitor.recordFrame(timestamp);
    publishResult(true);
    root.dataset.spikeStatus = 'running';
    statusValue.textContent = 'Depth fade and distortion running';
    if (firstFrame) {
      firstFrame = false;
      requestAnimationFrame(() => {
        root.dataset.sceneReady = 'true';
      });
    }
  });

  window.addEventListener('resize', () => {
    const nextWidth = window.innerWidth;
    const nextHeight = window.innerHeight;
    camera.aspect = nextWidth / nextHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(nextWidth, nextHeight);
  });
}

void runDepthSpike().catch(recordFailure);

function compareDepthReadbacks(
  fadeOnPixels: ArrayLike<number>,
  fadeOffPixels: ArrayLike<number>,
): DepthReadbackComparison {
  if (fadeOnPixels.length !== fadeOffPixels.length || fadeOnPixels.length === 0) {
    throw new Error('Depth readback buffers were empty or had mismatched lengths.');
  }

  let totalDifference = 0;
  let changedPixels = 0;
  const pixelCount = fadeOnPixels.length / 4;
  for (let offset = 0; offset < fadeOnPixels.length; offset += 4) {
    const difference =
      (Math.abs((fadeOnPixels[offset] ?? 0) - (fadeOffPixels[offset] ?? 0)) +
        Math.abs((fadeOnPixels[offset + 1] ?? 0) - (fadeOffPixels[offset + 1] ?? 0)) +
        Math.abs((fadeOnPixels[offset + 2] ?? 0) - (fadeOffPixels[offset + 2] ?? 0))) /
      3;
    totalDifference += difference;
    if (difference > 8) changedPixels += 1;
  }

  const meanAbsoluteDifference = totalDifference / pixelCount;
  const changedPixelRatio = changedPixels / pixelCount;
  const fadeOnPartiallyVisible = changedPixelRatio < 0.35;
  return {
    changedPixelRatio: Number(changedPixelRatio.toFixed(5)),
    fadeOnPartiallyVisible,
    meanAbsoluteDifference: Number(meanAbsoluteDifference.toFixed(3)),
    ok: meanAbsoluteDifference > 1 && changedPixelRatio > 0.01 && fadeOnPartiallyVisible,
    sampledPixels: pixelCount,
  };
}
