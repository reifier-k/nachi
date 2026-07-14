import {
  dissolve,
  distortionUV,
  flowMap,
  fresnel,
  polarUV,
  rimLight,
  uvFlow,
} from '@nachi-vfx/tsl-kit';
import {
  blendFlowMapSamplesCpu,
  distortionUVCpu,
  flowMapPhasesCpu,
  polarUVCpu,
  uvFlowCpu,
} from '@nachi-vfx/tsl-kit/math';
import * as THREE from 'three/webgpu';
import { texture, uniform, vec3 } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m8-tslkit.css';

const SIZE = 64;
const PANEL_COUNT = 7;
const root = document.documentElement;
const query = new URLSearchParams(window.location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const statusValue = required<HTMLElement>('#status-value');
const backendValue = required<HTMLElement>('#backend-value');
const visualCanvas = required<HTMLCanvasElement>('#tslkit-visual');
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

type Pixels = Uint8Array | Uint8ClampedArray | Float32Array;
type Rgb = readonly [number, number, number];

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M8 tsl-kit UI element: ${selector}`);
  return element;
}

function makeDataTexture(
  width: number,
  pixel: (x: number) => readonly [number, number, number, number],
): THREE.DataTexture {
  const data = new Uint8Array(width * 4);
  for (let x = 0; x < width; x += 1) data.set(pixel(x), x * 4);
  const result = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  result.colorSpace = THREE.NoColorSpace;
  result.minFilter = THREE.NearestFilter;
  result.magFilter = THREE.NearestFilter;
  result.wrapS = THREE.RepeatWrapping;
  result.wrapT = THREE.RepeatWrapping;
  result.needsUpdate = true;
  return result;
}

function channel(pixels: Pixels, x: number, y: number, component: 0 | 1 | 2 | 3): number {
  return pixels[(y * SIZE + x) * 4 + component] ?? 0;
}

function rgbEnergy(pixels: Pixels, x: number, y: number): number {
  return channel(pixels, x, y, 0) + channel(pixels, x, y, 1) + channel(pixels, x, y, 2);
}

function irregularTexel(index: number): Rgb {
  const red = (index * 73 + index * index * 19) % 256;
  return [red, 255 - red, (index * 41) % 256];
}

function sampleIrregularMap(uvX: number): Rgb {
  const wrapped = uvX - Math.floor(uvX);
  const index = Math.min(15, Math.floor(wrapped * 16));
  return irregularTexel(index);
}

function rgbMatches(
  pixels: Pixels,
  x: number,
  y: number,
  expected: readonly number[],
  tolerance = 2,
): boolean {
  return ([0, 1, 2] as const).every(
    (component) =>
      Math.abs(channel(pixels, x, y, component) - (expected[component] ?? 0)) <= tolerance,
  );
}

/** Converts a raw readback row to geometry UV. WebGPU rows are top-down; WebGL rows are bottom-up. */
function readbackUv(x: number, row: number, isWebGpu: boolean): readonly [number, number] {
  return [(x + 0.5) / SIZE, isWebGpu ? 1 - (row + 0.5) / SIZE : (row + 0.5) / SIZE];
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE);
  renderer.setClearColor(0x000000, 0);
  await renderer.init();
  const isWebGpu = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backend = isWebGpu ? 'WebGPU' : 'WebGL2';
  const expectedBackend = requestedBackend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (backend !== expectedBackend) {
    throw new Error(`Backend mismatch: requested ${expectedBackend}, active ${backend}.`);
  }
  backendValue.textContent = backend;
  root.dataset.backend = backend;
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const irregularMap = makeDataTexture(16, (x) => {
    const [red, green, blue] = irregularTexel(x);
    return [red, green, blue, 255];
  });
  const splitNoise = makeDataTexture(2, (x) =>
    x === 0 ? [64, 128, 128, 255] : [191, 128, 128, 255],
  );
  const directionalNoise = makeDataTexture(1, () => [255, 128, 128, 255]);

  const target = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  const plane = new THREE.PlaneGeometry(2, 2);
  const sphere = new THREE.SphereGeometry(0.82, 48, 24);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);

  const render = async (
    material: THREE.MeshBasicNodeMaterial,
    geometry: THREE.BufferGeometry = plane,
  ): Promise<Uint8Array> => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    const readback = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
    return new Uint8Array(readback);
  };

  const cut = dissolve({
    edgeColor: '#ff4020',
    edgeWidth: 0.3,
    noiseTexture: splitNoise,
    threshold: uniform(0.5),
  });
  const dissolveMaterial = new THREE.MeshBasicNodeMaterial();
  dissolveMaterial.colorNode = vec3(0.04, 0.02, 0.02).add(cut.rgb);
  dissolveMaterial.opacityNode = cut.a;
  dissolveMaterial.alphaTest = 0.5;
  const dissolvePixels = await render(dissolveMaterial);

  const flowTime = uniform(0);
  const uvFlowMaterial = new THREE.MeshBasicNodeMaterial();
  uvFlowMaterial.colorNode = texture(irregularMap, uvFlow({ speed: [0.5, 0], time: flowTime })).rgb;
  const uvFlowAtZero = await render(uvFlowMaterial);
  flowTime.value = 0.5;
  const uvFlowAtOne = await render(uvFlowMaterial);

  const polar = polarUV({ rotation: Math.PI / 8 });
  const polarMaterial = new THREE.MeshBasicNodeMaterial();
  polarMaterial.colorNode = vec3(polar.x, polar.y, 0);
  const polarPixels = await render(polarMaterial);

  const fresnelMaterial = new THREE.MeshBasicNodeMaterial();
  fresnelMaterial.colorNode = fresnel({ color: '#ffffff', power: 2 });
  const fresnelPixels = await render(fresnelMaterial, sphere);

  const rimMaterial = new THREE.MeshBasicNodeMaterial();
  rimMaterial.colorNode = rimLight({
    baseColor: '#081020',
    intensity: 0.8,
    lightColor: '#40bfff',
    power: 2,
  });
  const rimPixels = await render(rimMaterial, sphere);

  const distortionStrength = uniform(0);
  const distortionMaterial = new THREE.MeshBasicNodeMaterial();
  distortionMaterial.colorNode = texture(
    irregularMap,
    distortionUV({
      noiseTexture: directionalNoise,
      speed: [0, 0],
      strength: distortionStrength,
      time: uniform(0),
    }),
  ).rgb;
  const distortionAtZero = await render(distortionMaterial);
  distortionStrength.value = 0.19;
  const distortionPixels = await render(distortionMaterial);

  const flowMapTime = uniform(0);
  const flowMapMaterial = new THREE.MeshBasicNodeMaterial();
  flowMapMaterial.colorNode = flowMap({
    flowTexture: directionalNoise,
    map: irregularMap,
    strength: 0.28,
    time: flowMapTime,
  }).rgb;
  const flowMapAtZero = await render(flowMapMaterial);
  flowMapTime.value = 0.21;
  const flowMapPixels = await render(flowMapMaterial);
  renderer.setRenderTarget(null);

  const polarSamples = [8, 56].map((row) => {
    const x = 48;
    const expected = polarUVCpu(readbackUv(x, row, isWebGpu), { rotation: Math.PI / 8 });
    const actual = [channel(polarPixels, x, row, 0), channel(polarPixels, x, row, 1)] as const;
    return { actual, expected, row, x };
  });
  const sampleX = 27;
  const sampleRow = 19;
  const sampleUv = readbackUv(sampleX, sampleRow, isWebGpu);
  const expectedUvFlowAtZero = sampleIrregularMap(uvFlowCpu(sampleUv, [0.5, 0], 0)[0]);
  const expectedUvFlow = sampleIrregularMap(uvFlowCpu(sampleUv, [0.5, 0], 0.5)[0]);
  const expectedDistortionAtZero = sampleIrregularMap(
    distortionUVCpu(sampleUv, [1, 128 / 255], 0)[0],
  );
  const expectedDistortion = sampleIrregularMap(distortionUVCpu(sampleUv, [1, 128 / 255], 0.19)[0]);
  const expectedFlowPhases = flowMapPhasesCpu({
    flow: [1, 2 * (128 / 255) - 1],
    strength: 0.28,
    time: 0.21,
    uv: sampleUv,
  });
  const expectedFlowMap = blendFlowMapSamplesCpu(
    sampleIrregularMap(expectedFlowPhases.uv0[0]),
    sampleIrregularMap(expectedFlowPhases.uv1[0]),
    expectedFlowPhases.weight0,
  );
  const expectedFlowMapAtZero = sampleIrregularMap(sampleUv[0]);

  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['render'],
    mode: new URLSearchParams(location.search).get('headless') === '1' ? 'headless' : 'visual',
    page: 'm8-tslkit',
  });
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();

  // Offscreen render-target readback is linear working-space data quantized to bytes.
  // These fixed thresholds intentionally describe linear readback values, not sRGB literals.
  const validation = {
    consoleClean: consoleMessages.length === 0,
    dissolveCutBoundary:
      rgbEnergy(dissolvePixels, 16, 32) < 8 && channel(dissolvePixels, 48, 32, 0) > 100,
    distortionTexels:
      rgbMatches(distortionAtZero, sampleX, sampleRow, expectedDistortionAtZero) &&
      rgbMatches(distortionPixels, sampleX, sampleRow, expectedDistortion),
    flowMapTexels:
      rgbMatches(flowMapAtZero, sampleX, sampleRow, expectedFlowMapAtZero) &&
      rgbMatches(flowMapPixels, sampleX, sampleRow, expectedFlowMap, 3),
    fresnelProfile:
      rgbEnergy(fresnelPixels, 32, 32) < 24 &&
      rgbEnergy(fresnelPixels, 8, 32) > rgbEnergy(fresnelPixels, 32, 32) + 80,
    polarCoordinates: polarSamples.every(({ actual, expected }) =>
      actual.every((value, component) =>
        Number.isFinite(expected[component])
          ? Math.abs(value - Math.round((expected[component] ?? 0) * 255)) <= 2
          : false,
      ),
    ),
    rimLightComposite:
      rgbEnergy(rimPixels, 32, 32) >= 1 &&
      rgbEnergy(rimPixels, 32, 32) <= 24 &&
      rgbEnergy(rimPixels, 8, 32) > rgbEnergy(rimPixels, 32, 32) + 40,
    uvFlowTexels:
      rgbMatches(uvFlowAtZero, sampleX, sampleRow, expectedUvFlowAtZero) &&
      rgbMatches(uvFlowAtOne, sampleX, sampleRow, expectedUvFlow),
    visualReadback: [
      dissolvePixels,
      uvFlowAtOne,
      polarPixels,
      fresnelPixels,
      rimPixels,
      distortionPixels,
      flowMapPixels,
    ].every((pixels) => pixels.some((value, index) => index % 4 !== 3 && value > 12)),
  };

  paintPanels(
    visualCanvas,
    [
      dissolvePixels,
      uvFlowAtOne,
      polarPixels,
      fresnelPixels,
      rimPixels,
      distortionPixels,
      flowMapPixels,
    ],
    isWebGpu,
  );
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm8-tslkit.png', selector: '#tslkit-visual' },
  ]);

  const result = {
    backend,
    ok: Object.values(validation).every(Boolean),
    requestedBackend,
    readback: {
      dissolve: {
        discardedEnergy: rgbEnergy(dissolvePixels, 16, 32),
        edgeRed: channel(dissolvePixels, 48, 32, 0),
      },
      fresnel: {
        center: rgbEnergy(fresnelPixels, 32, 32),
        edge: rgbEnergy(fresnelPixels, 8, 32),
      },
      expectedTexels: {
        distortion: [expectedDistortionAtZero, expectedDistortion],
        flowMap: [expectedFlowMapAtZero, expectedFlowMap],
        uvFlow: [expectedUvFlowAtZero, expectedUvFlow],
      },
      polar: polarSamples,
      source: 'offscreen-render-target-readback',
    },
    validation,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M8 tsl-kit checks passed' : 'M8 tsl-kit checks failed';

  target.dispose();
  plane.dispose();
  sphere.dispose();
  irregularMap.dispose();
  splitNoise.dispose();
  directionalNoise.dispose();
}

function paintPanels(
  canvas: HTMLCanvasElement,
  panels: readonly Uint8Array[],
  sourceIsTopDown: boolean,
): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable for M8 readback presentation.');
  for (let panel = 0; panel < panels.length; panel += 1) {
    const source = panels[panel]!;
    const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const sourceY = sourceIsTopDown ? y : SIZE - 1 - y;
        const sourceOffset = (sourceY * SIZE + x) * 4;
        const targetOffset = (y * SIZE + x) * 4;
        rgba[targetOffset] = source[sourceOffset] ?? 0;
        rgba[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
        rgba[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
        rgba[targetOffset + 3] = 255;
      }
    }
    context.putImageData(new ImageData(rgba, SIZE, SIZE), panel * SIZE, 0);
  }
  if (panels.length !== PANEL_COUNT) throw new Error('M8 visual panel count drifted.');
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
