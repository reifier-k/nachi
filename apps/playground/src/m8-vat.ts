import { MeshFxDiagnosticError, applyVat } from '@nachi-vfx/mesh-fx';
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m8-vat.css';

const SIZE = 96;
const FRAME_COUNT = 4;
const FPS = 4;
const VERTEX_COUNT = 9;
const POSITION_RANGE = { min: -0.25, max: 0.25 } as const;
const FOREGROUND_ENERGY_THRESHOLD = 24;
const SATURATED_ENERGY_THRESHOLD = 744;
const VAT_DIFFERENCE_THRESHOLD = 12;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
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
root.dataset.spikeStatus = 'running';

type Rgb = readonly [number, number, number];
type Vec2 = readonly [number, number];

const centers: readonly Vec2[] = [
  [-0.55, -0.31],
  [0.08, 0.19],
  [0.52, -0.12],
];
const colors: readonly Rgb[] = [
  [1, 0.06, 0.03],
  [0.03, 1, 0.08],
  [0.05, 0.09, 1],
];

function required<ElementType extends Element>(selector: string): ElementType {
  const value = document.querySelector<ElementType>(selector);
  if (!value) throw new Error(`Missing M8 VAT element: ${selector}`);
  return value;
}

function analyticOffset(vertex: number, frame: number): Vec2 {
  const triangle = Math.floor(vertex / 3);
  const phase = (frame / (FRAME_COUNT - 1)) * Math.PI * 2;
  return [0.18 * Math.sin(phase + triangle * 0.73), 0.12 * Math.cos(phase * 0.5 + triangle * 0.41)];
}

function createGeometry(): THREE.BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const corners: readonly Vec2[] = [
    [-0.075, -0.055],
    [0.085, -0.04],
    [-0.01, 0.09],
  ];
  for (let triangle = 0; triangle < centers.length; triangle += 1) {
    for (const corner of corners) {
      position.push(centers[triangle]![0] + corner[0], centers[triangle]![1] + corner[1], 0);
      color.push(...colors[triangle]!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.setAttribute(
    'uv1',
    new THREE.Float32BufferAttribute(
      Array.from({ length: VERTEX_COUNT }, (_, index) => [(index + 0.5) / VERTEX_COUNT, 0]).flat(),
      2,
    ),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function createPositionTexture(): THREE.DataTexture {
  const data = new Float32Array(VERTEX_COUNT * FRAME_COUNT * 4);
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    for (let vertex = 0; vertex < VERTEX_COUNT; vertex += 1) {
      const offset = analyticOffset(vertex, frame);
      data.set(
        [
          (offset[0] - POSITION_RANGE.min) / (POSITION_RANGE.max - POSITION_RANGE.min),
          (offset[1] - POSITION_RANGE.min) / (POSITION_RANGE.max - POSITION_RANGE.min),
          (0 - POSITION_RANGE.min) / (POSITION_RANGE.max - POSITION_RANGE.min),
          1,
        ],
        (frame * VERTEX_COUNT + vertex) * 4,
      );
    }
  }
  const texture = new THREE.DataTexture(
    data,
    VERTEX_COUNT,
    FRAME_COUNT,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function createZeroPositionTexture(vertices: number, frames: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Float32Array(vertices * frames * 4),
    vertices,
    frames,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createNormalTexture(): THREE.DataTexture {
  const data = new Uint8Array(3 * 2 * 4);
  for (let vertex = 0; vertex < 3; vertex += 1) {
    data.set([128, 128, 255, 255], vertex * 4);
    data.set([255, 128, 128, 255], (3 + vertex) * 4);
  }
  const texture = new THREE.DataTexture(data, 3, 2, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function centroid(pixels: Uint8Array, channel: number, topDown: boolean): Vec2 {
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let row = 0; row < SIZE; row += 1) {
    const worldRow = topDown ? SIZE - 1 - row : row;
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (row * SIZE + x) * 4;
      const primary = pixels[offset + channel] ?? 0;
      const secondary = Math.max(
        pixels[offset + ((channel + 1) % 3)] ?? 0,
        pixels[offset + ((channel + 2) % 3)] ?? 0,
      );
      const value = Math.max(0, primary - secondary - 8);
      weight += value;
      sumX += (x + 0.5) * value;
      sumY += (worldRow + 0.5) * value;
    }
  }
  return [sumX / weight, sumY / weight];
}

function expectedCenter(triangle: number, frame0: number, frame1: number, mix: number): Vec2 {
  const first = analyticOffset(triangle * 3, frame0);
  const second = analyticOffset(triangle * 3, frame1);
  const worldX = centers[triangle]![0] + first[0] * (1 - mix) + second[0] * mix;
  const worldY = centers[triangle]![1] + first[1] * (1 - mix) + second[1] * mix;
  return [((worldX + 1) * SIZE) / 2, ((worldY + 1) * SIZE) / 2];
}

function maxCentroidError(actual: readonly Vec2[], expected: readonly Vec2[]): number {
  return Math.max(
    ...actual.map((point, index) =>
      Math.hypot(point[0] - expected[index]![0], point[1] - expected[index]![1]),
    ),
  );
}

function energy(pixels: Uint8Array): number {
  let result = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    result += (pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0);
  }
  return result;
}

function imageStats(pixels: Uint8Array): {
  foregroundPixels: number;
  foregroundRatio: number;
  saturatedPixels: number;
  saturatedRatio: number;
} {
  let foregroundPixels = 0;
  let saturatedPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const pixelEnergy = (pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0);
    if (pixelEnergy > FOREGROUND_ENERGY_THRESHOLD) foregroundPixels += 1;
    if (pixelEnergy > SATURATED_ENERGY_THRESHOLD) saturatedPixels += 1;
  }
  const pixelCount = pixels.length / 4;
  return {
    foregroundPixels,
    foregroundRatio: foregroundPixels / pixelCount,
    saturatedPixels,
    saturatedRatio: saturatedPixels / pixelCount,
  };
}

function changedPixels(left: Uint8Array, right: Uint8Array): number {
  let changed = 0;
  for (let index = 0; index < left.length; index += 4) {
    const difference =
      Math.abs((left[index] ?? 0) - (right[index] ?? 0)) +
      Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)) +
      Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0));
    if (difference > VAT_DIFFERENCE_THRESHOLD) changed += 1;
  }
  return changed;
}

function paint(
  canvas: HTMLCanvasElement,
  panels: readonly Uint8Array[],
  sourceTopDown: boolean,
): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create VAT presentation context.');
  for (let panel = 0; panel < panels.length; panel += 1) {
    const source = panels[panel]!;
    const display = new Uint8ClampedArray(source.length);
    for (let row = 0; row < SIZE; row += 1) {
      const sourceRow = sourceTopDown ? row : SIZE - 1 - row;
      display.set(
        source.subarray(sourceRow * SIZE * 4, (sourceRow + 1) * SIZE * 4),
        row * SIZE * 4,
      );
    }
    context.putImageData(new ImageData(display, SIZE, SIZE), panel * SIZE, 0);
  }
}

function diagnosticCode(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof MeshFxDiagnosticError ? error.diagnostic.code : null;
  }
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
    throw new Error(`Expected ${expectedBackend}, received ${backend}.`);
  required<HTMLElement>('#backend-value').textContent = backend;
  root.dataset.backend = backend;
  root.dataset.rendererStatus = 'ready';

  const target = new THREE.RenderTarget(SIZE, SIZE, { depthBuffer: true });
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const render = async (scene: THREE.Scene): Promise<Uint8Array> => {
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

  const positionTexture = createPositionTexture();
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = attribute('color', 'vec3');
  const mesh = new THREE.Mesh(createGeometry(), material);
  const controls = applyVat(mesh, {
    axisMap: 'xyz',
    fps: FPS,
    frameCount: FRAME_COUNT,
    frameOrder: 'top-to-bottom',
    interpolation: 'linear',
    loop: true,
    positionEncoding: 'remapped',
    positionRange: POSITION_RANGE,
    positionTexture,
  });
  const scene = new THREE.Scene();
  scene.add(mesh);
  controls.setTime(0);
  const frameZero = await render(scene);
  controls.setTime(0.125);
  const frameLinear = await render(scene);

  // Counterfactual control: this uses the same geometry and vertex colors without applyVat().
  // A no-op/broken VAT path therefore produces zero changed pixels and cannot pass visualBounds.
  const undeformedMaterial = new THREE.MeshBasicNodeMaterial();
  undeformedMaterial.colorNode = attribute('color', 'vec3');
  const undeformedMesh = new THREE.Mesh(createGeometry(), undeformedMaterial);
  const undeformedScene = new THREE.Scene();
  undeformedScene.add(undeformedMesh);
  const undeformed = await render(undeformedScene);

  const nearestMaterial = new THREE.MeshBasicNodeMaterial();
  nearestMaterial.colorNode = attribute('color', 'vec3');
  const nearestMesh = new THREE.Mesh(createGeometry(), nearestMaterial);
  const nearest = applyVat(nearestMesh, {
    fps: FPS,
    frameCount: FRAME_COUNT,
    interpolation: 'nearest',
    positionEncoding: 'remapped',
    positionRange: POSITION_RANGE,
    positionTexture,
  });
  const nearestScene = new THREE.Scene();
  nearestScene.add(nearestMesh);
  nearest.setTime(0.125);
  const frameNearest = await render(nearestScene);

  const rangeMaterial = new THREE.MeshBasicNodeMaterial();
  rangeMaterial.colorNode = attribute('color', 'vec3');
  const rangeMesh = new THREE.Mesh(createGeometry(), rangeMaterial);
  const rangeControls = applyVat(rangeMesh, {
    axisMap: 'xyz',
    fps: FPS,
    frameCount: FRAME_COUNT,
    frameRange: [1, 2],
    interpolation: 'linear',
    loop: true,
    positionEncoding: 'remapped',
    positionRange: POSITION_RANGE,
    positionTexture,
  });
  const rangeScene = new THREE.Scene();
  rangeScene.add(rangeMesh);
  rangeControls.setTime(0.375);
  const frameRangeWrap = await render(rangeScene);

  const normalGeometry = new THREE.BufferGeometry();
  normalGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.55, -0.5, 0, 0.55, -0.5, 0, 0, 0.55, 0], 3),
  );
  normalGeometry.setAttribute(
    'uv1',
    new THREE.Float32BufferAttribute([1 / 6, 0, 3 / 6, 0, 5 / 6, 0], 2),
  );
  normalGeometry.computeVertexNormals();
  const normalMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  const normalMesh = new THREE.Mesh(normalGeometry, normalMaterial);
  normalMesh.rotation.y = Math.PI / 3;
  const normalPosition = createZeroPositionTexture(3, 2);
  const normalTexture = createNormalTexture();
  const normalControls = applyVat(normalMesh, {
    axisMap: 'xyz',
    fps: 1,
    frameCount: 2,
    interpolation: 'nearest',
    loop: false,
    normalTexture,
    positionTexture: normalPosition,
  });
  const normalScene = new THREE.Scene();
  normalScene.add(normalMesh);
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(Math.sin(normalMesh.rotation.y), 0, Math.cos(normalMesh.rotation.y));
  normalScene.add(light);
  normalControls.setFrame(0);
  const normalFront = await render(normalScene);
  normalControls.setFrame(1);
  const normalSide = await render(normalScene);
  renderer.setRenderTarget(null);

  const actualZero = colors.map((_, channel) => centroid(frameZero, channel, isWebGpu));
  const actualLinear = colors.map((_, channel) => centroid(frameLinear, channel, isWebGpu));
  const actualNearest = colors.map((_, channel) => centroid(frameNearest, channel, isWebGpu));
  const actualRangeWrap = colors.map((_, channel) => centroid(frameRangeWrap, channel, isWebGpu));
  const expectedZero = centers.map((_, triangle) => expectedCenter(triangle, 0, 1, 0));
  const expectedLinear = centers.map((_, triangle) => expectedCenter(triangle, 0, 1, 0.5));
  // nearestMesh intentionally uses the default xzy mapping: the analytic Y offset becomes depth,
  // so screen Y stays at the undeformed center while X still follows frame 1.
  const expectedNearest = centers.map((center, triangle) => {
    const offset = analyticOffset(triangle * 3, 1);
    return [((center[0] + offset[0] + 1) * SIZE) / 2, ((center[1] + 1) * SIZE) / 2] as const;
  });
  const expectedRangeWrap = centers.map((_, triangle) => expectedCenter(triangle, 2, 1, 0.5));
  const positionErrors = {
    frameZero: maxCentroidError(actualZero, expectedZero),
    linear: maxCentroidError(actualLinear, expectedLinear),
    nearest: maxCentroidError(actualNearest, expectedNearest),
    rangeWrap: maxCentroidError(actualRangeWrap, expectedRangeWrap),
  };
  const diagnostics = {
    frameRange: diagnosticCode(() => normalControls.setFrame(2)),
    missingTexture: diagnosticCode(() =>
      applyVat(new THREE.Mesh(createGeometry(), new THREE.MeshBasicNodeMaterial()), {
        fps: FPS,
        frameCount: FRAME_COUNT,
        positionTexture: undefined as never,
      }),
    ),
    vertexCount: diagnosticCode(() =>
      applyVat(new THREE.Mesh(createGeometry(), new THREE.MeshBasicNodeMaterial()), {
        fps: FPS,
        frameCount: FRAME_COUNT,
        positionTexture: createZeroPositionTexture(8, FRAME_COUNT),
      }),
    ),
  };
  const normalEnergy = { front: energy(normalFront), side: energy(normalSide) };
  const visual = imageStats(frameLinear);
  const vatDisplacementPixels = changedPixels(frameLinear, undeformed);
  const normalEnergyRatio = normalEnergy.front / Math.max(1, normalEnergy.side);
  const validation = {
    consoleClean: consoleMessages.length === 0,
    diagnostics:
      diagnostics.frameRange === 'NACHI_VAT_FRAME_RANGE' &&
      diagnostics.missingTexture === 'NACHI_MESH_FX_TEXTURE_REQUIRED' &&
      diagnostics.vertexCount === 'NACHI_VAT_VERTEX_COUNT_MISMATCH',
    floatTexture:
      positionTexture.type === THREE.FloatType && positionTexture.colorSpace === THREE.NoColorSpace,
    linearGpuPosition: positionErrors.linear < 2.25,
    nearestGpuPosition: positionErrors.nearest < 2.25,
    normalViewTransform: normalEnergyRatio > 2,
    partialRangeGpuWrap:
      positionErrors.rangeWrap < 2.25 &&
      rangeControls.sampleAtTime(0.375).frame0 === 2 &&
      rangeControls.sampleAtTime(0.375).frame1 === 1,
    rowVertexLayout: positionErrors.frameZero < 2.25,
    visualBounds:
      visual.foregroundRatio > 0.003 &&
      visual.foregroundRatio < 0.08 &&
      visual.saturatedRatio < 0.12 &&
      vatDisplacementPixels > 40,
  };
  paint(
    required<HTMLCanvasElement>('#vat-visual'),
    [frameZero, frameLinear, frameNearest, frameRangeWrap, normalFront, normalSide],
    isWebGpu,
  );
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'm8-vat.png', selector: '#vat-visual' },
  ]);
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['render'],
    mode: query.get('headless') === '1' ? 'headless' : 'visual',
    page: 'm8-vat',
  });
  await monitor.resolveGpuTimestamps();
  monitor.publish();
  const result = {
    backend,
    consoleMessages,
    diagnostics,
    frameSamples: {
      actual: {
        linear: actualLinear,
        nearest: actualNearest,
        rangeWrap: actualRangeWrap,
        zero: actualZero,
      },
      expected: {
        linear: expectedLinear,
        nearest: expectedNearest,
        rangeWrap: expectedRangeWrap,
        zero: expectedZero,
      },
    },
    layout: 'x=vertex, y=frame, one frame per row',
    normalEnergy: {
      ...normalEnergy,
      meshRotationY: normalMesh.rotation.y,
      ratio: normalEnergyRatio,
    },
    ok: Object.values(validation).every(Boolean),
    positionErrors,
    saturatedPixels: visual.saturatedPixels,
    saturatedRatio: visual.saturatedRatio,
    source: 'synthetic-float-vat+offscreen-rgba8-raster-readback',
    texture: {
      colorSpace: positionTexture.colorSpace,
      height: positionTexture.image.height,
      type: positionTexture.type,
      width: positionTexture.image.width,
    },
    validation,
    visual: {
      ...visual,
      foregroundEnergyThreshold: FOREGROUND_ENERGY_THRESHOLD,
      saturatedEnergyThreshold: SATURATED_ENERGY_THRESHOLD,
      vatDifferenceThreshold: VAT_DIFFERENCE_THRESHOLD,
      vatDisplacementPixels,
    },
  };
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'VAT GPU checks passed'
    : 'VAT GPU checks failed';

  target.dispose();
  positionTexture.dispose();
  normalPosition.dispose();
  normalTexture.dispose();
  mesh.geometry.dispose();
  nearestMesh.geometry.dispose();
  rangeMesh.geometry.dispose();
  normalGeometry.dispose();
  undeformedMesh.geometry.dispose();
  material.dispose();
  nearestMaterial.dispose();
  rangeMaterial.dispose();
  normalMaterial.dispose();
  undeformedMaterial.dispose();
}

void run().catch((error: unknown) => {
  console.error(error);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = 'error';
  root.dataset.spikeResult = JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    ok: false,
  });
  required<HTMLElement>('#status-value').textContent = 'VAT runtime failed';
});
