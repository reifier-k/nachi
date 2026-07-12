import {
  billboard,
  burst,
  colorOverLife,
  createCoreKernelModuleRegistry,
  curlNoise,
  curve,
  defineEmitter,
  drag,
  gradient,
  gravity,
  intensityOverLife,
  lifetime,
  lightIntensity,
  lightRenderer,
  pointAttractor,
  positionSphere,
  range,
  rotationOverLife,
  sizeOverLife,
  velocityCone,
  type TextureRef,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import { cylinder, ring, uvFlow } from '@nachi/mesh-fx';
import { bloomPreset, createPostPipeline, screenDistortion } from '@nachi/post';
import {
  at,
  cameraShake,
  defineEffect,
  fxMaterial,
  marker,
  meshFxElement,
  play,
  timeline,
  VFXSystem,
  type CameraShakeSample,
} from '@nachi/timeline';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
} from '@nachi/three';
import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './showcase-heal.css';

const WIDTH = 640;
const HEIGHT = 360;
const STEP = 1 / 60;
const EFFECT_DURATION = 2.4;
const CLIMAX_TIME = 0.5;
const WAVE_DURATION = 0.7;
const CAPTURE_TIMES = [0.3, 0.56, 0.68, 1.0, 1.32, 2.05] as const;
const CAPTURE_LABELS = [
  'bloom · magic circle',
  'surge · pillar of light',
  'radiance · ring wave',
  'fountain · healing motes',
  'sustain · sparkle flares',
  'afterglow · fading light',
] as const;
const root = document.documentElement;
const headless = new URLSearchParams(location.search).get('headless') === '1';
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

type BackendLike = {
  readonly device?: {
    readonly features?: { has(name: string): boolean };
    readonly limits?: { maxStorageBuffersPerShaderStage?: number };
    readonly lost: Promise<{ message?: string; reason?: string }>;
  };
  readonly isWebGPUBackend?: boolean;
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing showcase-heal element: ${selector}`);
  return value;
}

// ---------------------------------------------------------------------------
// Procedural textures. Everything is generated from expressions so the page is
// fully self-contained and deterministic for the screenshot baseline.
// ---------------------------------------------------------------------------

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function createValueNoise(seed: number): (x: number, y: number) => number {
  const random = createSeededRandom(seed);
  const size = 64;
  const lattice = Float32Array.from({ length: size * size }, () => random());
  const sample = (x: number, y: number) => {
    const xi = ((Math.floor(x) % size) + size) % size;
    const yi = ((Math.floor(y) % size) + size) % size;
    return lattice[yi * size + xi]!;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = smooth(x - Math.floor(x));
    const fy = smooth(y - Math.floor(y));
    const top = sample(x, y) * (1 - fx) + sample(x + 1, y) * fx;
    const bottom = sample(x, y + 1) * (1 - fx) + sample(x + 1, y + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number): number {
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  let weight = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    total += noise(x * frequency, y * frequency) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / weight;
}

function grayscaleDataTexture(
  size: readonly [number, number],
  value: (u: number, v: number) => number,
): THREE.DataTexture {
  const [width, height] = size;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const level = Math.round(
        Math.min(1, Math.max(0, value((x + 0.5) / width, (y + 0.5) / height))) * 255,
      );
      data.set([level, level, level, 255], (y * width + x) * 4);
    }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Tiling fbm used by the circle and ground-wave dissolves. */
function noiseTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x4ea1);
  return grayscaleDataTexture([128, 128], (u, v) => fbm(noise, u * 9.3, v * 9.3));
}

/**
 * Vertical ramp mixed with noise for the light column. Bright texels sit at
 * the base (v = 0), so sweeping the dissolve threshold from 1 downward reveals
 * the pillar from the ground upward, and raising it again sinks the pillar
 * back into the circle.
 */
function columnRampTexture(): THREE.DataTexture {
  const noise = createValueNoise(0xc0a1);
  const texture = grayscaleDataTexture(
    [128, 256],
    (u, v) => 0.8 - v * 0.62 + fbm(noise, u * 6, v * 11) * 0.18,
  );
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function canvasTexture(
  width: number,
  height: number,
  draw: (context: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('showcase-heal requires a 2D canvas context.');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Leaf, petal, and vine glyphs for the outer ring (u = angle, v = radial). */
function leafStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x1eaf);
  return canvasTexture(1024, 96, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.strokeStyle = '#3dffa0';
    context.lineWidth = 3;
    context.strokeRect(2, 8, 1020, 2);
    context.strokeRect(2, 86, 1020, 2);
    context.strokeStyle = '#ffe08a';
    context.lineWidth = 1.4;
    context.strokeRect(2, 15, 1020, 1);
    context.strokeRect(2, 80, 1020, 1);
    for (let x = 14; x < 1014; x += 30) {
      const kind = Math.floor(random() * 4);
      const cx = x + random() * 6;
      const cy = 34 + random() * 28;
      const scale = 9 + random() * 8;
      const gold = random() > 0.65;
      context.strokeStyle = gold ? '#ffe08a' : random() > 0.4 ? '#5fffa8' : '#d9ffe9';
      context.lineWidth = 1.8 + random() * 1.6;
      context.beginPath();
      if (kind === 0) {
        // Leaf: two mirrored arcs plus a center vein.
        context.moveTo(cx, cy - scale);
        context.quadraticCurveTo(cx + scale * 0.85, cy, cx, cy + scale);
        context.quadraticCurveTo(cx - scale * 0.85, cy, cx, cy - scale);
        context.moveTo(cx, cy - scale * 0.7);
        context.lineTo(cx, cy + scale * 0.7);
      } else if (kind === 1) {
        // Vine curl: spiral of shrinking half-arcs.
        context.arc(cx, cy, scale * 0.9, Math.PI * 0.2, Math.PI * 1.25);
        context.arc(cx - scale * 0.28, cy - scale * 0.18, scale * 0.45, Math.PI * 1.25, Math.PI * 2.2);
      } else if (kind === 2) {
        // Petal fan: three petals sharing a base point.
        for (let petal = -1; petal <= 1; petal += 1) {
          const angle = -Math.PI / 2 + petal * 0.62;
          const tipX = cx + Math.cos(angle) * scale * 1.25;
          const tipY = cy + scale * 0.55 + Math.sin(angle) * scale * 1.25;
          context.moveTo(cx, cy + scale * 0.55);
          context.quadraticCurveTo(cx + Math.cos(angle - 0.45) * scale, cy + scale * 0.55 + Math.sin(angle - 0.45) * scale, tipX, tipY);
        }
      } else {
        // Bud: diamond over a short stem.
        context.moveTo(cx, cy - scale * 0.75);
        context.lineTo(cx + scale * 0.45, cy);
        context.lineTo(cx, cy + scale * 0.45);
        context.lineTo(cx - scale * 0.45, cy);
        context.closePath();
        context.moveTo(cx, cy + scale * 0.45);
        context.lineTo(cx, cy + scale);
      }
      context.stroke();
    }
  });
}

/** Soft dot-dash strip for the counter-rotating inner ring. */
function dotStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0xd07d);
  return canvasTexture(512, 48, (context) => {
    context.globalCompositeOperation = 'lighter';
    for (let x = 6; x < 512; x += 22) {
      if (random() > 0.45) {
        const radius = 3.5 + random() * 2.5;
        const glow = context.createRadialGradient(x, 24, 0, x, 24, radius * 2.2);
        glow.addColorStop(0, '#eafff5');
        glow.addColorStop(0.4, '#5fffa8');
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = glow;
        context.beginPath();
        context.arc(x, 24, radius * 2.2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillStyle = random() > 0.5 ? '#ffe08a' : '#8dffc0';
        context.fillRect(x - 6, 21, 13, 5);
      }
    }
  });
}

/**
 * Column body: bright green-white base fading to nothing at the top, with
 * rising light streaks. The canvas bottom row maps to the cylinder base.
 */
function columnBodyTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0xc01b);
  return canvasTexture(256, 512, (context) => {
    const body = context.createLinearGradient(0, 512, 0, 0);
    body.addColorStop(0, 'rgba(170,255,212,0.55)');
    body.addColorStop(0.2, 'rgba(95,255,168,0.48)');
    body.addColorStop(0.5, 'rgba(46,232,138,0.28)');
    body.addColorStop(0.78, 'rgba(255,224,138,0.12)');
    body.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = body;
    context.fillRect(0, 0, 256, 512);
    context.globalCompositeOperation = 'lighter';
    for (let index = 0; index < 46; index += 1) {
      const x = random() * 256;
      const bottom = 300 + random() * 212;
      const top = bottom - (140 + random() * 260);
      const streak = context.createLinearGradient(0, bottom, 0, top);
      const tone = random();
      const color = tone > 0.7 ? '255,224,138' : tone > 0.3 ? '95,255,168' : '223,255,238';
      streak.addColorStop(0, `rgba(${color},${0.08 + random() * 0.22})`);
      streak.addColorStop(1, `rgba(${color},0)`);
      context.fillStyle = streak;
      context.fillRect(x, top, 1 + random() * 2.4, bottom - top);
    }
  });
}

/** Four-point sparkle cross-flare, tinted by particle color. */
function sparkleSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([96, 96], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const radius = Math.hypot(x, y);
    const glow = Math.exp(-radius * radius * 9) * 0.7;
    const flare =
      Math.exp(-Math.abs(x) * 13) * Math.exp(-Math.abs(y) * 1.7) +
      Math.exp(-Math.abs(y) * 13) * Math.exp(-Math.abs(x) * 1.7);
    return glow + flare * 0.9;
  });
}

/** Plain soft radial glow for motes. */
function glowSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    return Math.exp(-(x * x + y * y) * 5.5);
  });
}

// ---------------------------------------------------------------------------
// Effect authoring.
// ---------------------------------------------------------------------------

const SPARKLE_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-heal/sparkle',
};
const GLOW_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-heal/glow',
};

interface EffectTextures {
  readonly columnBody: THREE.Texture;
  readonly columnRamp: THREE.Texture;
  readonly dots: THREE.Texture;
  readonly leaves: THREE.Texture;
  readonly noise: THREE.Texture;
}

function createSanctuaryBloom(textures: EffectTextures, loop: boolean) {
  const motes = defineEmitter({
    capacity: 80,
    init: [
      positionSphere({ radius: 1.7, surfaceOnly: true }),
      lifetime(range(0.36, 0.52)),
    ],
    render: billboard({
      alignment: { factor: 0.85, mode: 'velocity-stretch' },
      blending: 'additive',
      map: GLOW_REF,
    }),
    spawn: burst({ count: 60 }),
    update: [
      pointAttractor({ falloff: 1, position: [0, -0.4, 0], strength: 26 }),
      drag(0.5),
      sizeOverLife(curve([0, 0.022], [0.5, 0.08], [1, 0.012])),
      colorOverLife(gradient('#ffffff', '#5fffa8', '#37ffa000')),
    ],
  });
  const surge = defineEmitter({
    capacity: 96,
    init: [
      positionSphere({ radius: 0.3 }),
      velocityCone({ angle: 16, direction: [0, 1, 0], speed: range(5, 10.5) }),
      lifetime(range(0.3, 0.55)),
    ],
    render: billboard({
      alignment: { factor: 0.85, mode: 'velocity-stretch' },
      blending: 'additive',
      map: GLOW_REF,
    }),
    spawn: burst({ count: 72 }),
    update: [
      drag(0.6),
      sizeOverLife(curve([0, 0.06], [0.4, 0.035], [1, 0.004])),
      colorOverLife(gradient('#ffffff', '#d9ffe9', '#ffd97a00')),
    ],
  });
  const fountain = defineEmitter({
    capacity: 360,
    init: [
      positionSphere({ radius: 0.7 }),
      velocityCone({ angle: 40, direction: [0, 1, 0], speed: range(1.4, 3.0) }),
      lifetime(range(0.9, 1.5)),
    ],
    // Multi-cycle bursts require an explicit lifecycle duration covering the
    // spawn envelope; the default duration completes the emitter immediately
    // and later cycles never fire.
    lifecycle: { duration: 1.3 },
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 34, cycles: 10, interval: 0.14 }),
    update: [
      curlNoise({ frequency: 1.6, strength: 1.5 }),
      gravity([0, 0.55, 0]),
      drag(0.9),
      sizeOverLife(curve([0, 0.025], [0.3, 0.105], [1, 0])),
      colorOverLife(gradient('#d9ffe9', '#3dff9a', '#ffd97a', '#ffd66b00')),
    ],
  });
  const sparkles = defineEmitter({
    capacity: 96,
    init: [
      positionSphere({ radius: 1.25 }),
      velocityCone({ angle: 70, direction: [0, 1, 0], speed: range(0.15, 0.5) }),
      lifetime(range(0.7, 1.1)),
    ],
    lifecycle: { duration: 1.1 },
    render: billboard({ blending: 'additive', map: SPARKLE_REF }),
    spawn: burst({ count: 10, cycles: 6, interval: 0.2 }),
    update: [
      curlNoise({ frequency: 0.7, strength: 0.5 }),
      gravity([0, 0.22, 0]),
      rotationOverLife(curve([0, 0], [1, 1.1])),
      sizeOverLife(curve([0, 0], [0.18, 0.17], [0.75, 0.11], [1, 0])),
      colorOverLife(gradient('#ffffff', '#fff3c8', '#ffe08a00')),
    ],
  });
  const seed = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.4)],
    integration: 'none',
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 1 }),
    update: [
      sizeOverLife(curve([0, 0.02], [0.7, 0.3], [1, 0.46])),
      colorOverLife(gradient('#c9ffe2', '#eafff5', '#ffffff00')),
    ],
  });
  const flash = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.55), lightIntensity(12)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 14], [0.3, 5], [1, 0])),
      colorOverLife(gradient('#fff8e0', '#ffe08a')),
    ],
  });

  const circleOuterMesh = ring({
    innerRadius: 1.24,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#fff3c8',
        edgeWidth: 0.09,
        overLife: curve([0, 1], [0.16, 0.06], [0.78, 0.1], [1, 1]),
        texture: textures.noise,
      },
      map: textures.leaves,
      opacity: 1,
      uv: uvFlow({ speed: [0.05, 0] }),
    }),
    outerRadius: 1.6,
    segments: 96,
  });
  circleOuterMesh.name = 'heal-circle-outer';
  // The timeline runtime resets clone transforms to the effect transform, so
  // every static orientation/offset must be baked into the geometry itself.
  circleOuterMesh.geometry.rotateX(-Math.PI / 2);
  circleOuterMesh.geometry.translate(0, -0.93, 0);
  const circleInnerMesh = ring({
    innerRadius: 0.8,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#eafff5',
        edgeWidth: 0.08,
        overLife: curve([0, 1], [0.2, 0.08], [0.76, 0.12], [1, 1]),
        texture: textures.noise,
      },
      map: textures.dots,
      opacity: 0.95,
      uv: uvFlow({ speed: [-0.08, 0] }),
    }),
    outerRadius: 1.02,
    segments: 96,
  });
  circleInnerMesh.name = 'heal-circle-inner';
  circleInnerMesh.geometry.rotateX(-Math.PI / 2);
  circleInnerMesh.geometry.translate(0, -0.93, 0);

  const columnMesh = cylinder({
    height: 3.4,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#d9ffe9',
        edgeWidth: 0.03,
        overLife: curve([0, 1], [0.1, 0.06], [0.6, 0.16], [0.82, 1], [1, 1]),
        texture: textures.columnRamp,
      },
      map: textures.columnBody,
    }),
    radialSegments: 48,
    radius: 0.5,
  });
  columnMesh.name = 'heal-column';
  columnMesh.geometry.translate(0, 3.4 / 2 - 0.93, 0);

  const waveMaterial = (opacity: number) =>
    fxMaterial({
      blending: 'additive',
      color: '#6dffb4',
      dissolve: {
        edgeColor: '#eafff5',
        edgeWidth: 0.05,
        overLife: curve([0, 0.1], [0.5, 0.35], [1, 1]),
        texture: textures.noise,
      },
      opacity,
    });
  const waveMesh = ring({
    innerRadius: 0.82,
    material: waveMaterial(0.7),
    outerRadius: 1.0,
    segments: 96,
  });
  waveMesh.name = 'heal-wave';
  waveMesh.geometry.rotateX(-Math.PI / 2);
  waveMesh.geometry.translate(0, -0.92, 0);
  const waveMesh2 = ring({
    innerRadius: 0.88,
    material: waveMaterial(0.42),
    outerRadius: 1.0,
    segments: 96,
  });
  waveMesh2.name = 'heal-wave-2';
  waveMesh2.geometry.rotateX(-Math.PI / 2);
  waveMesh2.geometry.translate(0, -0.91, 0);

  return defineEffect({
    elements: {
      circleInner: meshFxElement(circleInnerMesh, { duration: 2.3 }),
      circleOuter: meshFxElement(circleOuterMesh, { duration: 2.3 }),
      column: meshFxElement(columnMesh, { duration: 1.15 }),
      flash,
      fountain,
      groundWave: meshFxElement(waveMesh, { duration: WAVE_DURATION }),
      groundWave2: meshFxElement(waveMesh2, { duration: WAVE_DURATION }),
      motes,
      seed,
      sparkles,
      surge,
    },
    timeline: timeline(
      [
        at(0, play('circleOuter'), play('circleInner'), marker('bloom')),
        at(0.04, play('motes')),
        at(0.14, play('seed')),
        at(
          CLIMAX_TIME,
          play('column'),
          play('groundWave'),
          play('flash'),
          play('surge'),
          cameraShake({ duration: 0.4, frequency: 14, strength: 0.1 }),
          marker('surge'),
        ),
        at(0.58, play('fountain'), marker('fountain')),
        at(0.66, play('groundWave2')),
        at(0.72, play('sparkles')),
      ],
      { duration: EFFECT_DURATION, ...(loop ? { loop: true } : {}) },
    ),
  });
}

// ---------------------------------------------------------------------------
// Choreography helpers.
// ---------------------------------------------------------------------------

function easeOutCubic(p: number): number {
  return 1 - (1 - p) ** 3;
}

function cameraState(camera: THREE.Camera, viewport: readonly [number, number]) {
  camera.updateMatrixWorld(true);
  return {
    projectionMatrix: camera.projectionMatrix.toArray(),
    viewMatrix: camera.matrixWorldInverse.toArray(),
    viewportSize: viewport,
  };
}

// ---------------------------------------------------------------------------
// Scene + runtime setup shared by the headless capture and the live viewer.
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  root.dataset.spikeStatus = 'running';
  root.dataset.rendererStatus = 'initializing';
  const renderer = await createPlaygroundRenderer({
    antialias: !headless,
    trackTimestamp: headless,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('Sanctuary Bloom requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  required<HTMLElement>('#mode-value').textContent = headless
    ? 'headless keyframe capture'
    : 'live loop';

  const textures: EffectTextures = {
    columnBody: columnBodyTexture(),
    columnRamp: columnRampTexture(),
    dots: dotStripTexture(),
    leaves: leafStripTexture(),
    noise: noiseTexture(),
  };
  const sparkle = sparkleSpriteTexture();
  const glow = glowSpriteTexture();
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [SPARKLE_REF.uri, sparkle],
      [GLOW_REF.uri, glow],
    ]),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020a07);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.MeshStandardNodeMaterial({ color: 0x0d1f16, metalness: 0.2, roughness: 0.6 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.95;
  scene.add(ground, new THREE.HemisphereLight(0x2f5c46, 0x040806, 0.5));

  const camera = new THREE.PerspectiveCamera(44, WIDTH / HEIGHT, 0.1, 40);
  const cameraBasePosition = new THREE.Vector3(0.25, 0.9, 5.5);
  camera.position.copy(cameraBasePosition);
  camera.lookAt(0, 0.42, 0);
  const cameraBaseRotation = camera.rotation.clone();

  const projected = new THREE.Vector3(0, -0.9, 0).project(camera);
  const shockCenter: [number, number] = [0.5 + projected.x * 0.5, 0.5 - projected.y * 0.5];

  const registry = createCoreKernelModuleRegistry();
  const adapter = createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  const runtime = createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);

  let latestShake: CameraShakeSample | null = null;
  const system = new VFXSystem(runtime, scene, {
    cameraShakeTarget: (sample) => {
      latestShake = sample;
    },
    registry,
  });
  system.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
  const effect = createSanctuaryBloom(textures, !headless);
  const instance = system.spawn(effect, { position: [0, 0, 0], seed: 0x4ea1 });

  const playedEmitters = new Map<string, VfxEmitterRuntimeView>();
  instance.onAction(({ action, emitter }) => {
    const target = 'target' in action ? action.target : undefined;
    if (action.kind === 'play' && target !== undefined && emitter !== undefined) {
      playedEmitters.set(target, emitter);
    }
  });

  const spriteDraws = new Map<string, { object: THREE.Mesh; view: VfxEmitterRuntimeView }>();
  let lightDraw: ReturnType<typeof materializeThreeLightDraw> | undefined;
  let lightView: VfxEmitterRuntimeView | undefined;
  const materializeNewDraws = () => {
    for (const [key, view] of playedEmitters) {
      if (key === 'flash') {
        if (lightView !== view) {
          lightDraw?.dispose();
          if (lightDraw) scene.remove(lightDraw.group);
          lightDraw = materializeThreeLightDraw(view.program, view.kernels);
          lightView = view;
          scene.add(lightDraw.group);
        }
        continue;
      }
      const existing = spriteDraws.get(key);
      if (existing?.view === view) continue;
      if (existing) scene.remove(existing.object);
      const object = materializeThreeSpriteDraw(view.program, view.kernels, 0, { resolveTexture });
      scene.add(object);
      spriteDraws.set(key, { object, view });
    }
  };

  const findMeshFx = (name: string): THREE.Mesh | undefined =>
    scene.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === name,
    );

  const post = createPostPipeline(renderer, scene, camera, {
    bloom: bloomPreset('intense', { radius: 0.62, strength: 0.85, threshold: 0.5 }),
    distortion: screenDistortion({
      shockwaves: [
        {
          center: shockCenter,
          duration: 0.9,
          radius: 0.02,
          ringWidth: 0.18,
          speed: 0.55,
          startTime: CLIMAX_TIME,
          strength: 0.028,
        },
      ],
    }),
  });

  const localNow = () => instance.localTime % EFFECT_DURATION;

  // Sub-stepping keeps simulation quality identical to the other showcase
  // pages even though this effect has no attached sockets.
  const SUBSTEPS = 4;
  const step = async (delta: number) => {
    for (let subStep = 0; subStep < SUBSTEPS; subStep += 1) {
      await system.update(delta / SUBSTEPS);
    }
    materializeNewDraws();
    if (lightDraw) await lightDraw.update(renderer);
    for (const [key, name] of [
      ['groundWave', 'heal-wave'],
      ['groundWave2', 'heal-wave-2'],
    ] as const) {
      const waveState = instance.getElementState(key);
      const waveClone = findMeshFx(name);
      if (waveClone && waveState?.playing) {
        const q = Math.min(1, waveState.localTime / WAVE_DURATION);
        const spread = 0.25 + 3.35 * easeOutCubic(q);
        // Scale only in the ground plane: the baked y offset must stay put.
        waveClone.scale.set(spread, 1, spread);
      }
    }
    if (latestShake) {
      camera.position
        .copy(cameraBasePosition)
        .add(new THREE.Vector3(...latestShake.translation));
      camera.rotation.set(
        cameraBaseRotation.x + latestShake.rotation[0],
        cameraBaseRotation.y + latestShake.rotation[1],
        cameraBaseRotation.z + latestShake.rotation[2],
      );
    } else {
      camera.position.copy(cameraBasePosition);
      camera.rotation.copy(cameraBaseRotation);
    }
    camera.updateMatrixWorld(true);
    system.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
    post.controls.setTime(localNow());
  };

  if (headless) {
    // Short warmed GPU sample window for the nachi.perf-baseline record. It
    // respawns the effect so compute work is still in flight while sampling.
    const perfWindow = async () => {
      system.spawn(effect, { position: [0, 0, 0], seed: 0x4ea2 });
      const perfTarget = new THREE.RenderTarget(96, 64, { depthBuffer: true });
      const monitor = createPerformanceMonitor(renderer, {
        gpuScopes: ['compute', 'render'],
        mode: 'headless',
        page: 'showcase-heal',
      });
      await monitor.captureGpuSamples(async () => {
        await step(STEP);
        renderer.setRenderTarget(perfTarget);
        post.render();
      });
      perfTarget.dispose();
    };
    await runHeadless(renderer, post, step, instance, perfWindow);
    return;
  }

  // Live viewer: present to the page canvas and loop forever; the timeline
  // loops itself.
  required<HTMLCanvasElement>('#heal-visual').style.display = 'none';
  required<HTMLElement>('#frame-labels').style.display = 'none';
  const stage = required<HTMLElement>('#stage');
  stage.appendChild(renderer.domElement);
  const resize = () => {
    const width = stage.clientWidth;
    const height = Math.round((width * HEIGHT) / WIDTH);
    renderer.setSize(width, height, true);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);
  required<HTMLElement>('#status-value').textContent = 'looping · watch the bloom';
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = 'complete';
  let previous = performance.now();
  const frame = async () => {
    const now = performance.now();
    const delta = Math.min(0.05, (now - previous) / 1000);
    previous = now;
    await step(delta);
    renderer.setRenderTarget(null);
    post.render();
    requestAnimationFrame(() => void frame());
  };
  requestAnimationFrame(() => void frame());
}

// ---------------------------------------------------------------------------
// Headless: deterministic 60 Hz stepping, six keyframes composited into a
// contact sheet, machine-readable spike result.
// ---------------------------------------------------------------------------

async function runHeadless(
  renderer: THREE.WebGPURenderer,
  post: ReturnType<typeof createPostPipeline>,
  step: (delta: number) => Promise<void>,
  instance: {
    readonly localTime: number;
    readonly state: string;
    getElementState(key: string): unknown;
  },
  perfWindow: () => Promise<void>,
): Promise<void> {
  const labels = required<HTMLElement>('#frame-labels');
  labels.innerHTML = CAPTURE_LABELS.map((label) => `<span>${label}</span>`).join('');
  const elementKeys = [
    'circleInner',
    'circleOuter',
    'column',
    'flash',
    'fountain',
    'groundWave',
    'groundWave2',
    'motes',
    'seed',
    'sparkles',
    'surge',
  ] as const;
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  const captures: Uint8Array[] = [];
  const captureStates: Array<Record<string, unknown>> = [];
  let captureIndex = 0;
  await step(0);
  // The very first readback from a fresh render target returns empty pixels;
  // warm the readback path up before any measured capture.
  renderer.setRenderTarget(target);
  post.render();
  await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT);
  for (let frame = 0; frame < 140; frame += 1) {
    await step(STEP);
    renderer.setRenderTarget(target);
    post.render();
    // A tiny readback every frame keeps the async readback path drained; a
    // full-size capture after many readback-free frames returns empty pixels.
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    if (frame % 6 === 5) {
      await renderer.resolveTimestampsAsync('compute');
      await renderer.resolveTimestampsAsync('render');
    }
    if (captureIndex < CAPTURE_TIMES.length && instance.localTime >= CAPTURE_TIMES[captureIndex]!) {
      captures.push(
        new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT)),
      );
      captureStates.push({
        localTime: instance.localTime,
        ...Object.fromEntries(elementKeys.map((key) => [key, instance.getElementState(key)])),
      });
      captureIndex += 1;
    }
  }

  const canvas = required<HTMLCanvasElement>('#heal-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('showcase-heal requires the contact sheet canvas.');
  const sheet = context.createImageData(WIDTH * 3, HEIGHT * 2);
  const panelStats: Array<{ foregroundRatio: number; saturatedRatio: number }> = [];
  captures.forEach((pixels, panel) => {
    const panelX = (panel % 3) * WIDTH;
    const panelY = Math.floor(panel / 3) * HEIGHT;
    let foreground = 0;
    let saturated = 0;
    // The post pipeline's readback already returns rows top-down.
    for (let y = 0; y < HEIGHT; y += 1) {
      const sourceY = y;
      for (let x = 0; x < WIDTH; x += 1) {
        const source = (sourceY * WIDTH + x) * 4;
        const output = ((panelY + y) * WIDTH * 3 + panelX + x) * 4;
        const r = pixels[source]!;
        const g = pixels[source + 1]!;
        const b = pixels[source + 2]!;
        sheet.data.set([r, g, b, 255], output);
        if (r + g + b > 42) foreground += 1;
        if (r + g + b > 744) saturated += 1;
      }
    }
    panelStats.push({
      foregroundRatio: foreground / (WIDTH * HEIGHT),
      saturatedRatio: saturated / (WIDTH * HEIGHT),
    });
  });
  context.putImageData(sheet, 0, 0);

  await perfWindow();
  const climax = panelStats[1] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const fountainPanel = panelStats[3] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const checks = {
    allFramesCaptured: captures.length === CAPTURE_TIMES.length,
    climaxVisible: climax.foregroundRatio > 0.03 && climax.saturatedRatio < 0.3,
    consoleClean: consoleMessages.length === 0,
    fountainVisible: fountainPanel.foregroundRatio > 0.015,
    stateHealthy: instance.state !== 'error',
  };
  const result = {
    checks,
    consoleMessages,
    evidence: {
      captureStates,
      captureTimes: CAPTURE_TIMES,
      finalLocalTime: instance.localTime,
      finalState: instance.state,
      panelStats,
    },
    ok: Object.values(checks).every(Boolean),
    schema: 'nachi.showcase-heal.v1',
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'showcase-heal.png', selector: '#heal-visual' },
  ]);
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = result.ok ? 'complete' : 'error';
  required<HTMLElement>('#status-value').textContent = result.ok
    ? 'all checks passed'
    : 'checks failed';
  target.dispose();
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, ok: false });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = message;
  originalError(error);
});
