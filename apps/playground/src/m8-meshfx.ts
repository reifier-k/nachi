import {
  createConeGeometry,
  createCylinderGeometry,
  createMagicCircleGeometry,
  createRingGeometry,
  createSlashArcGeometry,
  fxMaterial,
  polarUV,
  uvFlow,
} from '@nachi/mesh-fx';
import { polarUVCpu, uvFlowCpu } from '@nachi/tsl-kit/math';
import * as THREE from 'three/webgpu';
import { color, uv, vec3 } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m8-meshfx.css';

const SIZE = 96;
const MAP_WIDTH = 16;
const LINEAR_BYTE_TOLERANCE = 3;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const statusValue = required<HTMLElement>('#status-value');
const backendValue = required<HTMLElement>('#backend-value');
const visualCanvas = required<HTMLCanvasElement>('#meshfx-visual');
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

type Pixels = Uint8Array;
type Rgb = readonly [number, number, number];

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing M8 mesh-fx UI element: ${selector}`);
  return element;
}

function irregularTexel(index: number): Rgb {
  const red = (index * 67 + index * index * 11) % 256;
  return [red, 255 - red, (index * 29) % 256];
}

function irregularTexture(width: number, noise = false): THREE.DataTexture {
  const data = new Uint8Array(width * 4);
  for (let index = 0; index < width; index += 1) {
    const texel = noise
      ? ([40 + index * 12, 40 + index * 12, 40 + index * 12] as const)
      : irregularTexel(index);
    data.set([...texel, 255], index * 4);
  }
  const result = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  result.colorSpace = THREE.NoColorSpace;
  result.minFilter = THREE.NearestFilter;
  result.magFilter = THREE.NearestFilter;
  result.wrapS = THREE.RepeatWrapping;
  result.wrapT = THREE.RepeatWrapping;
  result.needsUpdate = true;
  return result;
}

function sampleIrregularTexture(uvX: number): Rgb {
  const wrapped = uvX - Math.floor(uvX);
  return irregularTexel(Math.min(MAP_WIDTH - 1, Math.floor(wrapped * MAP_WIDTH)));
}

function rgb(pixels: Pixels, x: number, row: number): Rgb {
  const offset = (row * SIZE + x) * 4;
  return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
}

function rgbMatches(actual: Rgb, expected: Rgb): boolean {
  return actual.every(
    (value, component) => Math.abs(value - (expected[component] ?? 0)) <= LINEAR_BYTE_TOLERANCE,
  );
}

function energy(pixels: Pixels, x: number, row: number): number {
  const offset = (row * SIZE + x) * 4;
  return (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0);
}

function foregroundRatio(pixels: Pixels): number {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0) > 24) count += 1;
  }
  return count / (SIZE * SIZE);
}

function readbackRow(worldY: number, webgpu: boolean): number {
  const bottomUp = Math.round((worldY + 1) * 0.5 * SIZE - 0.5);
  return webgpu ? SIZE - 1 - bottomUp : bottomUp;
}

function interpolateUvAtWorld(
  geometry: THREE.BufferGeometry,
  vertices: readonly [number, number, number],
  world: readonly [number, number],
): readonly [number, number] {
  const position = geometry.getAttribute('position');
  const uvAttribute = geometry.getAttribute('uv');
  const [a, b, c] = vertices.map(
    (vertex) => [position.getX(vertex), position.getY(vertex)] as const,
  );
  const denominator = (b![1] - c![1]) * (a![0] - c![0]) + (c![0] - b![0]) * (a![1] - c![1]);
  const weightA =
    ((b![1] - c![1]) * (world[0] - c![0]) + (c![0] - b![0]) * (world[1] - c![1])) / denominator;
  const weightB =
    ((c![1] - a![1]) * (world[0] - c![0]) + (a![0] - c![0]) * (world[1] - c![1])) / denominator;
  const weightC = 1 - weightA - weightB;
  return [
    uvAttribute.getX(vertices[0]) * weightA +
      uvAttribute.getX(vertices[1]) * weightB +
      uvAttribute.getX(vertices[2]) * weightC,
    uvAttribute.getY(vertices[0]) * weightA +
      uvAttribute.getY(vertices[1]) * weightB +
      uvAttribute.getY(vertices[2]) * weightC,
  ];
}

function channelCounts(geometry: THREE.BufferGeometry): readonly number[] {
  return [
    geometry.getAttribute('position').count,
    geometry.getAttribute('normal').count,
    geometry.getAttribute('uv').count,
    geometry.index?.count ?? 0,
  ];
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
  if (backend !== expectedBackend)
    throw new Error(`Backend mismatch: requested ${expectedBackend}, active ${backend}.`);
  backendValue.textContent = backend;
  root.dataset.backend = backend;
  root.dataset.rendererStatus = 'ready';
  root.dataset.spikeStatus = 'running';

  const target = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  const render = async (mesh: THREE.Mesh): Promise<Pixels> => {
    const scene = new THREE.Scene();
    scene.add(mesh);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    return compactRgba8Readback(
      new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE)),
      SIZE,
      SIZE,
      isWebGpu,
    );
  };

  const arcGeometry = createSlashArcGeometry({
    angle: 140,
    radius: 0.9,
    innerRadius: 0.38,
    segments: 20,
    taper: 0.35,
    rotation: 17,
  });
  const ringGeometry = createRingGeometry({
    innerRadius: 0.48,
    outerRadius: 0.82,
    segments: 37,
    thetaStart: 0.19,
  });
  const cylinderGeometry = createCylinderGeometry({
    radius: 0.48,
    height: 1.5,
    radialSegments: 29,
    heightSegments: 3,
    thetaStart: 0.13,
  });
  const coneGeometry = createConeGeometry({
    radius: 0.72,
    height: 1.55,
    radialSegments: 31,
    heightSegments: 3,
    thetaStart: 0.21,
  });
  const magicGeometry = createMagicCircleGeometry({
    radius: 0.84,
    rings: 3,
    segments: 43,
    thetaStart: 0.17,
  });

  const map = irregularTexture(MAP_WIDTH);
  const noise = irregularTexture(MAP_WIDTH, true);
  const arcMaterial = fxMaterial({
    map,
    uv: polarUV({ rotation: Math.PI / 9 }).flow({ speed: [0.37, 0.11] }),
    dissolve: {
      texture: noise,
      overLife: [
        [0, 0.1],
        [1, 0.95],
      ],
      edgeColor: '#ff5b20',
      edgeWidth: 0.06,
    },
    blending: 'additive',
  });
  const arc = new THREE.Mesh(arcGeometry, arcMaterial);
  arcMaterial.fx.setTime(0);
  arcMaterial.fx.setNormalizedLife(0.2);
  const arcAtZero = await render(arc);
  arcMaterial.fx.setTime(0.6);
  const arcAtOne = await render(arc);
  arcMaterial.fx.setNormalizedLife(0.8);
  const arcDissolved = await render(arc);

  const uvMaterial = new THREE.MeshBasicNodeMaterial();
  uvMaterial.colorNode = vec3(uv().x, uv().y, uv().x.oneMinus().mul(0.25));
  const ringPixels = await render(new THREE.Mesh(ringGeometry, uvMaterial));
  const cylinderMesh = new THREE.Mesh(cylinderGeometry, uvMaterial);
  cylinderMesh.rotation.x = -0.22;
  cylinderMesh.rotation.y = 0.42;
  const cylinderPixels = await render(cylinderMesh);
  const coneMesh = new THREE.Mesh(coneGeometry, uvMaterial);
  coneMesh.rotation.x = -0.16;
  coneMesh.rotation.y = -0.38;
  const conePixels = await render(coneMesh);
  const magicMaterial = new THREE.MeshBasicNodeMaterial();
  magicMaterial.colorNode = vec3(uv().x, uv().y, color('#20c8ff').b);
  const magicPixels = await render(new THREE.Mesh(magicGeometry, magicMaterial));

  const fresnelMaterial = fxMaterial({
    color: '#020408',
    fresnel: { color: '#66ddff', power: 2 },
    blending: 'additive',
  });
  const fresnelCylinder = new THREE.Mesh(
    createCylinderGeometry({ radius: 0.62, height: 1.5, radialSegments: 48, heightSegments: 2 }),
    fresnelMaterial,
  );
  const fresnelPixels = await render(fresnelCylinder);

  const opacityGeometry = new THREE.PlaneGeometry(1, 1);
  const opacityPhases = async (blending: 'additive' | 'alpha') => {
    const material = fxMaterial({ blending, color: '#ffffff' });
    const mesh = new THREE.Mesh(opacityGeometry, material);
    material.fx.setOpacity(1);
    const full = await render(mesh);
    material.fx.setOpacity(0.5);
    const half = await render(mesh);
    const center = SIZE / 2;
    const result = {
      full: energy(full, center, center),
      half: energy(half, center, center),
    };
    material.dispose();
    return result;
  };
  const alphaOpacity = await opacityPhases('alpha');
  const additiveOpacity = await opacityPhases('additive');

  const uvSeparationGeometry = new THREE.PlaneGeometry(2, 2);
  const uvSeparationMaterial = fxMaterial({
    dissolve: {
      edgeWidth: 0,
      overLife: 0.5,
      texture: noise,
      uv: 'static',
    },
    map,
    uv: uvFlow({ speed: [0.5, 0] }),
  });
  const uvSeparationMesh = new THREE.Mesh(uvSeparationGeometry, uvSeparationMaterial);
  uvSeparationMaterial.fx.setTime(0);
  const uvSeparationAtZero = await render(uvSeparationMesh);
  uvSeparationMaterial.fx.setTime(1);
  const uvSeparationAtOne = await render(uvSeparationMesh);
  renderer.setRenderTarget(null);

  // Start from a barycentric interior point, then snap to the covered pixel center and interpolate
  // its exact UV. Its nonzero x/y and explicit y-mirror make a mirrored readback fail this check.
  const position = arcGeometry.getAttribute('position');
  const sampleVertices = [24, 25, 26] as const;
  const weights = [0.2, 0.5, 0.3] as const;
  const approximateSampleWorld = sampleVertices.reduce(
    (result, vertex, index) =>
      [
        result[0] + position.getX(vertex) * weights[index]!,
        result[1] + position.getY(vertex) * weights[index]!,
      ] as [number, number],
    [0, 0] as [number, number],
  );
  const sampleX = Math.round((approximateSampleWorld[0] + 1) * 0.5 * SIZE - 0.5);
  const sampleBottomRow = Math.round((approximateSampleWorld[1] + 1) * 0.5 * SIZE - 0.5);
  const sampleWorld: readonly [number, number] = [
    ((sampleX + 0.5) / SIZE) * 2 - 1,
    ((sampleBottomRow + 0.5) / SIZE) * 2 - 1,
  ];
  const sampleUv = interpolateUvAtWorld(arcGeometry, sampleVertices, sampleWorld);
  const transformedAtZero = uvFlowCpu(
    polarUVCpu(sampleUv, { rotation: Math.PI / 9 }),
    [0.37, 0.11],
    0,
  );
  const transformedAtOne = uvFlowCpu(
    polarUVCpu(sampleUv, { rotation: Math.PI / 9 }),
    [0.37, 0.11],
    0.6,
  );
  const expectedAtZero = sampleIrregularTexture(transformedAtZero[0]);
  const expectedAtOne = sampleIrregularTexture(transformedAtOne[0]);
  const sampleRow = readbackRow(sampleWorld[1], isWebGpu);
  const mirrorRow = readbackRow(-sampleWorld[1], isWebGpu);
  const sampleRgbAtZero = rgb(arcAtZero, sampleX, sampleRow);
  const sampleRgbAtOne = rgb(arcAtOne, sampleX, sampleRow);
  const sampleAtZero = energy(arcAtZero, sampleX, sampleRow);
  const sampleAtOne = energy(arcAtOne, sampleX, sampleRow);
  const sampleDissolved = energy(arcDissolved, sampleX, sampleRow);
  const mirrorAtZero = energy(arcAtZero, sampleX, mirrorRow);
  const fresnelCenter = energy(fresnelPixels, SIZE / 2, SIZE / 2);
  const fresnelEdge = energy(fresnelPixels, 21, SIZE / 2);
  const uvSeparationSampleX = 72;
  const uvSeparationSampleRow = readbackRow(0, isWebGpu);
  const uvSeparationSourceU = (uvSeparationSampleX + 0.5) / SIZE;
  const uvSeparationAtZeroRgb = rgb(uvSeparationAtZero, uvSeparationSampleX, uvSeparationSampleRow);
  const uvSeparationAtOneRgb = rgb(uvSeparationAtOne, uvSeparationSampleX, uvSeparationSampleRow);
  const opacityRatio = (sample: { readonly full: number; readonly half: number }) =>
    sample.half / sample.full;

  const ratios = [
    arcAtZero,
    arcAtOne,
    ringPixels,
    cylinderPixels,
    conePixels,
    magicPixels,
    fresnelPixels,
  ].map(foregroundRatio);
  const geometryCounts = {
    slashArc: channelCounts(arcGeometry),
    ring: channelCounts(ringGeometry),
    cylinder: channelCounts(cylinderGeometry),
    cone: channelCounts(coneGeometry),
    magicCircle: channelCounts(magicGeometry),
  };
  const magicUv = magicGeometry.getAttribute('uv');
  const magicUv1 = magicGeometry.getAttribute('uv1');
  const validation = {
    consoleClean: consoleMessages.length === 0,
    geometryCounts:
      JSON.stringify(geometryCounts) ===
      JSON.stringify({
        slashArc: [42, 42, 42, 120],
        ring: [76, 76, 76, 222],
        cylinder: [120, 120, 120, 522],
        cone: [128, 128, 128, 558],
        magicCircle: [264, 264, 264, 774],
      }),
    magicCircleUvIslands:
      magicUv1.count === 264 && Math.abs(magicUv.getX(1) - 0.664) < 0.002 && magicUv1.getY(1) === 1,
    nonMirrorSample: sampleWorld[1] > 0.1 && sampleAtZero > 60 && sampleAtZero > mirrorAtZero + 25,
    // RGBA8 render-target bytes are linear working-space values; tolerate only quantization noise.
    polarFlowPhases:
      rgbMatches(sampleRgbAtZero, expectedAtZero) && rgbMatches(sampleRgbAtOne, expectedAtOne),
    dissolveOverLife:
      sampleAtOne > 60 && sampleDissolved < 12 && ratios[1]! > foregroundRatio(arcDissolved) * 2,
    fresnelEdge: fresnelCenter < 30 && fresnelEdge > fresnelCenter + 80,
    opacityRuntime:
      alphaOpacity.full > 700 &&
      additiveOpacity.full > 700 &&
      Math.abs(opacityRatio(alphaOpacity) - 0.5) < 0.04 &&
      Math.abs(opacityRatio(additiveOpacity) - 0.5) < 0.04,
    renderedGeometry: ratios.slice(2, 6).every((ratio) => ratio > 0.04 && ratio < 0.7),
    visualReadback:
      ratios.every((ratio) => ratio < 0.72) && ratios.filter((ratio) => ratio > 0.01).length >= 6,
    uvSeparation:
      rgbMatches(uvSeparationAtZeroRgb, sampleIrregularTexture(uvSeparationSourceU)) &&
      rgbMatches(uvSeparationAtOneRgb, sampleIrregularTexture(uvSeparationSourceU + 0.5)),
  };

  paintPanels(
    visualCanvas,
    [arcAtZero, arcAtOne, ringPixels, cylinderPixels, conePixels, magicPixels, fresnelPixels],
    isWebGpu,
  );
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm8-meshfx.png', selector: '#meshfx-visual' },
  ]);
  const performanceMonitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['render'],
    mode: query.get('headless') === '1' ? 'headless' : 'visual',
    page: 'm8-meshfx',
  });
  await performanceMonitor.resolveGpuTimestamps();
  performanceMonitor.publish();
  const result = {
    backend,
    ok: Object.values(validation).every(Boolean),
    requestedBackend,
    readback: {
      geometryCounts,
      ratios,
      sample: {
        actualAtOne: sampleRgbAtOne,
        actualAtZero: sampleRgbAtZero,
        expectedAtOne,
        expectedAtZero,
        mirrorAtZero,
        sampleAtOne,
        sampleAtZero,
        sampleDissolved,
        sampleUv,
        sampleWorld,
        transformedAtOne,
        transformedAtZero,
      },
      fresnel: { center: fresnelCenter, edge: fresnelEdge },
      opacity: { additive: additiveOpacity, alpha: alphaOpacity },
      uvSeparation: {
        actualAtOne: uvSeparationAtOneRgb,
        actualAtZero: uvSeparationAtZeroRgb,
        expectedAtOne: sampleIrregularTexture(uvSeparationSourceU + 0.5),
        expectedAtZero: sampleIrregularTexture(uvSeparationSourceU),
        sourceU: uvSeparationSourceU,
      },
      source: 'cpu-buffer-attributes+offscreen-render-target-readback',
    },
    validation,
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  statusValue.textContent = result.ok ? 'All M8 mesh-fx checks passed' : 'M8 mesh-fx checks failed';

  target.dispose();
  map.dispose();
  noise.dispose();
  [
    arcGeometry,
    ringGeometry,
    cylinderGeometry,
    coneGeometry,
    magicGeometry,
    fresnelCylinder.geometry,
    opacityGeometry,
    uvSeparationGeometry,
  ].forEach((geometry) => geometry.dispose());
  [arcMaterial, uvMaterial, magicMaterial, fresnelMaterial, uvSeparationMaterial].forEach(
    (material) => material.dispose(),
  );
}

function paintPanels(
  canvas: HTMLCanvasElement,
  panels: readonly Pixels[],
  sourceTopDown: boolean,
): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create M8 mesh-fx presentation context.');
  for (let panel = 0; panel < panels.length; panel += 1) {
    const source = panels[panel]!;
    const display = new Uint8ClampedArray(source.length);
    for (let y = 0; y < SIZE; y += 1) {
      const sourceY = sourceTopDown ? y : SIZE - 1 - y;
      display.set(source.subarray(sourceY * SIZE * 4, (sourceY + 1) * SIZE * 4), y * SIZE * 4);
    }
    context.putImageData(new ImageData(display, SIZE, SIZE), panel * SIZE, 0);
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeResult = JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  root.dataset.sceneReady = 'true';
  statusValue.textContent = 'M8 mesh-fx failed';
});
