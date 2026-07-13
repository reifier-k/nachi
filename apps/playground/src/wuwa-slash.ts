import {
  billboard,
  burst,
  collidePlane,
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
  perDistance,
  pointAttractor,
  positionSphere,
  range,
  sizeOverLife,
  velocityCone,
  VFXSystem as CoreVFXSystem,
  type TextureRef,
  type Vec3,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import { ring, slashArc } from '@nachi/mesh-fx';
import { bloomPreset, createPostPipeline, screenDistortion } from '@nachi/post';
import {
  at,
  cameraShake,
  defineEffect,
  fxMaterial,
  hitStop,
  marker,
  meshFxElement,
  play,
  timeline,
  VFXSystem,
  type CameraShakeSample,
} from '@nachi/timeline';
import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '@nachi/trails';
import { materializeThreeRibbonDraw, readRibbonSegments } from '@nachi/trails/three';
import * as THREE from 'three/webgpu';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
  createThreeTransformSource,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
} from '@nachi/three';
import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './wuwa-slash.css';

const WIDTH = 640;
const HEIGHT = 360;
const STEP = 1 / 60;
const EFFECT_DURATION = 2.0;
const IMPACT_TIME = 0.45;
const COUNTER_TIME = 0.6;
const SLASH_A = { end: 0.63, start: IMPACT_TIME } as const;
const SLASH_B = { end: 0.76, start: COUNTER_TIME } as const;
const CAPTURE_TIMES = [0.3, 0.47, 0.55, 0.64, 0.84, 1.18] as const;
const CAPTURE_LABELS = [
  'charge · rune circle',
  'impact · main crescent',
  'burst · sparks + flash',
  'counter slash + shockwave',
  'afterglow · embers',
  'dissipation',
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
  if (!value) throw new Error(`Missing wuwa-slash element: ${selector}`);
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

/** Tiling fbm used by every dissolve. */
function noiseTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x9a17);
  return grayscaleDataTexture([128, 128], (u, v) => fbm(noise, u * 9.3, v * 9.3));
}

/**
 * Angular sweep ramp mixed with noise. Driving a dissolve threshold across it
 * reveals the slash arc from one angular edge to the other instead of fading
 * it in uniformly.
 */
function sweepTexture(reverse: boolean): THREE.DataTexture {
  const noise = createValueNoise(0x51a5);
  const texture = grayscaleDataTexture([256, 64], (u, v) => {
    const ramp = reverse ? 1 - u : u;
    return 0.08 + ramp * 0.62 + fbm(noise, u * 7, v * 4) * 0.3;
  });
  texture.wrapS = THREE.ClampToEdgeWrapping;
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
  if (!context) throw new Error('wuwa-slash requires a 2D canvas context.');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/**
 * Anime-style blade body: bright leading edge along the outer radius (v→1)
 * plus horizontal speed-line streaks along the sweep direction (u).
 */
function bladeTexture(core: string, tint: string, deep: string): THREE.CanvasTexture {
  const random = createSeededRandom(0xb1ade);
  return canvasTexture(512, 128, (context) => {
    const body = context.createLinearGradient(0, 128, 0, 0);
    body.addColorStop(0, 'rgba(0,0,0,0)');
    body.addColorStop(0.45, deep);
    body.addColorStop(0.82, tint);
    body.addColorStop(0.95, core);
    body.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = body;
    context.fillRect(0, 0, 512, 128);
    context.globalCompositeOperation = 'lighter';
    for (let index = 0; index < 90; index += 1) {
      const y = random() * 118 + 5;
      const length = 40 + random() * 260;
      const x = random() * 512;
      const alpha = 0.08 + random() * 0.5;
      context.strokeStyle = random() > 0.72 ? core : tint;
      context.globalAlpha = alpha;
      context.lineWidth = 0.6 + random() * 2.2;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + length, y);
      context.stroke();
      if (x + length > 512) {
        context.beginPath();
        context.moveTo(x - 512, y);
        context.lineTo(x + length - 512, y);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    // Fade both angular ends to black so the revealed arc tapers into
    // crescent tips instead of ending in a solid bright slab. The material
    // samples only RGB, so darken the pixels directly.
    context.globalCompositeOperation = 'source-over';
    const leftFade = context.createLinearGradient(0, 0, 96, 0);
    leftFade.addColorStop(0, 'rgba(0,0,0,1)');
    leftFade.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = leftFade;
    context.fillRect(0, 0, 96, 128);
    const rightFade = context.createLinearGradient(512 - 96, 0, 512, 0);
    rightFade.addColorStop(0, 'rgba(0,0,0,0)');
    rightFade.addColorStop(1, 'rgba(0,0,0,1)');
    context.fillStyle = rightFade;
    context.fillRect(512 - 96, 0, 96, 128);
  });
}

/** Gold glyph strip mapped onto the outer rune ring (u = angle, v = radial). */
function runeStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x201e);
  return canvasTexture(1024, 96, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.strokeStyle = '#ffd870';
    context.lineWidth = 3;
    context.strokeRect(2, 8, 1020, 2);
    context.strokeRect(2, 86, 1020, 2);
    for (let x = 12; x < 1012; x += 26) {
      const kind = Math.floor(random() * 5);
      const cx = x + random() * 6;
      const cy = 30 + random() * 34;
      const scale = 8 + random() * 9;
      context.strokeStyle = random() > 0.3 ? '#ffd870' : '#fff3c8';
      context.lineWidth = 1.6 + random() * 1.6;
      context.beginPath();
      if (kind === 0) {
        context.rect(cx - scale / 2, cy - scale / 2, scale, scale);
      } else if (kind === 1) {
        context.moveTo(cx, cy - scale * 0.7);
        context.lineTo(cx + scale * 0.6, cy + scale * 0.5);
        context.lineTo(cx - scale * 0.6, cy + scale * 0.5);
        context.closePath();
      } else if (kind === 2) {
        context.arc(cx, cy, scale * 0.55, 0, Math.PI * 2);
      } else if (kind === 3) {
        context.moveTo(cx, cy - scale * 0.8);
        context.lineTo(cx, cy + scale * 0.8);
        context.moveTo(cx - scale * 0.5, cy);
        context.lineTo(cx + scale * 0.5, cy);
      } else {
        context.moveTo(cx, cy - scale * 0.7);
        context.lineTo(cx + scale * 0.55, cy);
        context.lineTo(cx, cy + scale * 0.7);
        context.lineTo(cx - scale * 0.55, cy);
        context.closePath();
      }
      context.stroke();
    }
  });
}

/** Cyan tick dashes for the counter-rotating inner ring. */
function tickStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x71c5);
  return canvasTexture(512, 48, (context) => {
    context.globalCompositeOperation = 'lighter';
    for (let x = 0; x < 512; x += 16) {
      const tall = random() > 0.62;
      context.fillStyle = tall ? '#c9f6ff' : '#59d8ff';
      context.fillRect(x + 3, tall ? 8 : 17, tall ? 4 : 8, tall ? 32 : 14);
    }
  });
}

/** Radial glow with a subtle four-point flare, tinted by particle color. */
function sparkSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const radius = Math.hypot(x, y);
    const glow = Math.exp(-radius * radius * 7);
    const flare =
      Math.exp(-Math.abs(x) * 11) * Math.exp(-Math.abs(y) * 2.4) +
      Math.exp(-Math.abs(y) * 11) * Math.exp(-Math.abs(x) * 2.4);
    return glow + flare * 0.55;
  });
}

/** Plain soft radial glow for embers and charge streaks. */
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

const SPARK_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://wuwa-slash/spark',
};
const GLOW_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://wuwa-slash/glow',
};

interface EffectTextures {
  readonly blade: THREE.Texture;
  readonly counterBlade: THREE.Texture;
  readonly noise: THREE.Texture;
  readonly runes: THREE.Texture;
  readonly sweep: THREE.Texture;
  readonly ticks: THREE.Texture;
}

function createResonanceSlash(textures: EffectTextures, loop: boolean) {
  const glint = defineEmitter({
    capacity: 56,
    init: [
      positionSphere({ radius: 1.35, surfaceOnly: true }),
      velocityCone({ angle: 60, direction: [0, 1, 0], speed: range(0.7, 1.4) }),
      lifetime(range(0.3, 0.42)),
    ],
    render: billboard({
      alignment: { factor: 0.9, mode: 'velocity-stretch' },
      blending: 'additive',
      map: GLOW_REF,
    }),
    spawn: burst({ count: 44 }),
    update: [
      pointAttractor({ falloff: 1, position: [0, 0.1, 0], strength: 30 }),
      drag(0.4),
      sizeOverLife(curve([0, 0.02], [0.5, 0.05], [1, 0.008])),
      colorOverLife(gradient('#bff7ff', '#57d4ff', '#2a7dff00')),
    ],
  });
  const sparks = defineEmitter({
    capacity: 160,
    init: [
      positionSphere({ radius: 0.06 }),
      velocityCone({ angle: 70, direction: [0.75, 0.45, 0.1], speed: range(3.5, 10) }),
      lifetime(range(0.25, 0.75)),
    ],
    render: billboard({
      alignment: { factor: 0.6, mode: 'velocity-stretch' },
      blending: 'additive',
      map: SPARK_REF,
    }),
    spawn: burst({ count: 130 }),
    update: [
      gravity([0, -9.5, 0]),
      drag(1.1),
      collidePlane({ bounce: 0.45, friction: 0.25, mode: 'bounce', normal: [0, 1, 0], offset: -0.92 }),
      sizeOverLife(curve([0, 0.055], [0.4, 0.03], [1, 0.004])),
      colorOverLife(gradient('#ffffff', '#ffe08a', '#ff8d2e', '#ff3a1000')),
    ],
  });
  const embers = defineEmitter({
    capacity: 120,
    init: [
      positionSphere({ radius: 0.65 }),
      velocityCone({ angle: 70, direction: [0, 1, 0], speed: range(0.3, 1.2) }),
      lifetime(range(0.9, 1.6)),
    ],
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 20, cycles: 5, interval: 0.09 }),
    update: [
      curlNoise({ frequency: 1.4, strength: 2.6 }),
      gravity([0, 0.6, 0]),
      drag(1.4),
      sizeOverLife(curve([0, 0.015], [0.25, 0.085], [1, 0])),
      colorOverLife(gradient('#e8fdff', '#7deaff', '#9a6cff', '#5b2bd800')),
    ],
  });
  const flash = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.4), lightIntensity(16)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 20], [0.25, 7], [1, 0])),
      colorOverLife(gradient('#ffffff', '#8ce8ff')),
    ],
  });

  const circleOuterMesh = ring({
    innerRadius: 1.24,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#fff3c8',
        edgeWidth: 0.09,
        overLife: curve([0, 1], [0.1, 0.06], [0.74, 0.1], [1, 1]),
        texture: textures.noise,
      },
      map: textures.runes,
      opacity: 0.9,
    }),
    outerRadius: 1.58,
    segments: 96,
  });
  circleOuterMesh.name = 'wuwa-circle-outer';
  circleOuterMesh.rotation.x = -Math.PI / 2;
  circleOuterMesh.position.y = -0.93;
  const circleInnerMesh = ring({
    innerRadius: 0.82,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#eafcff',
        edgeWidth: 0.08,
        overLife: curve([0, 1], [0.14, 0.08], [0.72, 0.12], [1, 1]),
        texture: textures.noise,
      },
      map: textures.ticks,
      opacity: 0.85,
    }),
    outerRadius: 1.04,
    segments: 96,
  });
  circleInnerMesh.name = 'wuwa-circle-inner';
  circleInnerMesh.rotation.x = -Math.PI / 2;
  circleInnerMesh.position.y = -0.93;

  const slashMainMesh = slashArc({
    angle: 145,
    innerRadius: 0.55,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#ffffff',
        edgeWidth: 0.03,
        overLife: curve([0, 1], [0.2, 0.02], [0.62, 0.1], [1, 1]),
        texture: textures.sweep,
      },
      map: textures.blade,
    }),
    radius: 1.95,
    rotation: -18,
    taper: 0.8,
  });
  slashMainMesh.name = 'wuwa-slash-main';
  slashMainMesh.rotation.set(-0.24, 0.16, 0.3);
  slashMainMesh.position.set(0, -0.4, 0.2);
  const slashCounterMesh = slashArc({
    angle: 125,
    innerRadius: 0.45,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#fff7dc',
        edgeWidth: 0.03,
        overLife: curve([0, 1], [0.22, 0.03], [0.6, 0.12], [1, 1]),
        texture: textures.sweep,
      },
      map: textures.counterBlade,
    }),
    radius: 1.6,
    rotation: 190,
    taper: 0.75,
  });
  slashCounterMesh.name = 'wuwa-slash-counter';
  slashCounterMesh.rotation.set(0.18, -0.14, -0.3);
  slashCounterMesh.position.set(0, 0.2, 0.1);

  const shockMesh = ring({
    innerRadius: 0.93,
    material: fxMaterial({
      blending: 'additive',
      color: '#5fd8ff',
      dissolve: {
        edgeColor: '#d8fbff',
        edgeWidth: 0.05,
        overLife: curve([0, 0.12], [0.55, 0.42], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.6,
    }),
    outerRadius: 1.0,
    segments: 96,
  });
  shockMesh.name = 'wuwa-shock';

  return defineEffect({
    elements: {
      circleInner: meshFxElement(circleInnerMesh, { duration: 1.75 }),
      circleOuter: meshFxElement(circleOuterMesh, { duration: 1.75 }),
      embers,
      flash,
      glint,
      shock: meshFxElement(shockMesh, { duration: 0.5 }),
      slashCounter: meshFxElement(slashCounterMesh, { duration: 0.45 }),
      slashMain: meshFxElement(slashMainMesh, { duration: 0.5 }),
      sparks,
    },
    timeline: timeline(
      [
        at(0, play('circleOuter'), play('circleInner'), marker('charge')),
        at(0.06, play('glint')),
        at(
          IMPACT_TIME,
          play('slashMain'),
          play('flash'),
          cameraShake({ duration: 0.3, frequency: 30, strength: 0.3 }),
          marker('impact'),
        ),
        at(0.5, hitStop(70)),
        at(0.52, play('sparks'), play('shock'), marker('burst')),
        at(
          COUNTER_TIME,
          play('slashCounter'),
          cameraShake({ duration: 0.2, frequency: 26, strength: 0.16 }),
        ),
        at(0.66, play('embers')),
      ],
      { duration: EFFECT_DURATION, ...(loop ? { loop: true } : {}) },
    ),
  });
}

function createTrailEffect(
  colors: readonly [string, string, string],
  width: number,
  startDelay: number,
  duration: number,
) {
  const trail = defineEmitter({
    attributes: { ribbonId: ribbonIdAttribute() },
    capacity: 128,
    init: [positionSphere({ radius: 0 }), lifetime(0.3), ribbonId(0)],
    integration: 'none',
    lifecycle: { duration, startDelay },
    render: ribbon({
      blending: 'additive',
      maxRibbons: 1,
      taper: { end: 0.62, start: 0.22 },
      uv: { mode: 'stretched' },
      width,
    }),
    // Distance-based spawning keeps the ribbon quiet while the socket is
    // parked (before its window and during hit stop) and dense mid-sweep.
    spawn: perDistance(22),
    update: [colorOverLife(gradient(...colors))],
  });
  return defineEffect({ elements: { trail } });
}

// ---------------------------------------------------------------------------
// Choreography helpers.
// ---------------------------------------------------------------------------

function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

function sweepProgress(localTime: number, window: { start: number; end: number }): number {
  const p = (localTime - window.start) / (window.end - window.start);
  return easeOut(Math.min(1, Math.max(0, p)));
}

function crescentA(p: number): Vec3 {
  const angle = 2.2 - p * 2.55;
  const radius = 1.62 - 0.3 * Math.sin(p * Math.PI);
  return [
    Math.cos(angle) * radius * 1.06,
    Math.sin(angle) * radius * 0.62 + 0.1,
    0.45 - 0.75 * p,
  ];
}

function crescentB(p: number): Vec3 {
  const angle = -2.75 + p * 2.4;
  const radius = 1.38 - 0.26 * Math.sin(p * Math.PI);
  return [
    Math.cos(angle) * radius * 0.98,
    -Math.sin(angle) * radius * 0.5 + 0.02,
    0.3 - 0.5 * p,
  ];
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
  if (!backend.isWebGPUBackend) throw new Error('Resonance slash requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  required<HTMLElement>('#mode-value').textContent = headless
    ? 'headless keyframe capture'
    : 'live loop';

  const textures: EffectTextures = {
    blade: bladeTexture('#e6fbff', 'rgba(52,182,235,0.62)', 'rgba(10,44,110,0.3)'),
    counterBlade: bladeTexture('#fff6d4', 'rgba(235,178,66,0.62)', 'rgba(140,60,14,0.28)'),
    noise: noiseTexture(),
    runes: runeStripTexture(),
    sweep: sweepTexture(false),
    ticks: tickStripTexture(),
  };
  const spark = sparkSpriteTexture();
  const glow = glowSpriteTexture();
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [SPARK_REF.uri, spark],
      [GLOW_REF.uri, glow],
    ]),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020510);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.MeshStandardNodeMaterial({ color: 0x0e1626, metalness: 0.25, roughness: 0.55 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.95;
  scene.add(ground, new THREE.HemisphereLight(0x39597a, 0x050810, 0.5));

  const camera = new THREE.PerspectiveCamera(42, WIDTH / HEIGHT, 0.1, 40);
  const cameraBasePosition = new THREE.Vector3(0.25, 0.85, 5.6);
  camera.position.copy(cameraBasePosition);
  camera.lookAt(0.1, -0.05, 0);
  const cameraBaseRotation = camera.rotation.clone();

  const projected = new THREE.Vector3(0, 0, 0).project(camera);
  const shockCenter: [number, number] = [0.5 + projected.x * 0.5, 0.5 - projected.y * 0.5];

  const registry = registerTrails(createCoreKernelModuleRegistry());
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
  const effect = createResonanceSlash(textures, !headless);
  const instance = system.spawn(effect, { position: [0, 0, 0], seed: 0x0a11 });

  const trailSystem = new CoreVFXSystem(runtime, undefined, { registry });
  trailSystem.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
  // Windows are wider than the sweep itself: the sweep runs on the timeline's
  // hit-stopped local clock while trail lifecycles run on world time.
  const trailCyan = createTrailEffect(['#f4feff', '#7ce4ff', '#3a4cff00'], 0.24, SLASH_A.start, 0.3);
  const trailGold = createTrailEffect(['#fff7d8', '#ffcf5e', '#d05a1a00'], 0.18, SLASH_B.start, 0.28);
  const socketA = new THREE.Object3D();
  const socketB = new THREE.Object3D();
  scene.add(socketA, socketB);

  interface TrailRuntime {
    draw?: ReturnType<typeof materializeThreeRibbonDraw>;
    readonly instance: {
      readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
      readonly state: string;
      attachTo(source: ReturnType<typeof createThreeTransformSource>): void;
      getEmitter(key: string): VfxEmitterRuntimeView | undefined;
      release(): void;
    };
    readonly socket: THREE.Object3D;
  }
  let trailRuntimes: TrailRuntime[] = [];
  const spawnTrails = (): TrailRuntime[] => {
    const cyan = trailSystem.spawn(trailCyan, { seed: 0x7c1 });
    cyan.attachTo(createThreeTransformSource(socketA));
    const gold = trailSystem.spawn(trailGold, { seed: 0x7c2 });
    gold.attachTo(createThreeTransformSource(socketB));
    return [
      { instance: cyan, socket: socketA },
      { instance: gold, socket: socketB },
    ];
  };
  const releaseTrails = () => {
    for (const trail of trailRuntimes) {
      if (trail.draw) scene.remove(trail.draw.mesh);
      trail.instance.release();
    }
  };
  trailRuntimes = spawnTrails();

  const actions: Array<{ kind: string; localTime: number; target?: string }> = [];
  const markers: string[] = [];
  const playedEmitters = new Map<string, VfxEmitterRuntimeView>();
  let latestCycle = 0;
  instance.onAction(({ action, cycle, emitter, localTime }) => {
    const target = 'target' in action ? action.target : undefined;
    actions.push({ kind: action.kind, localTime, ...(target === undefined ? {} : { target }) });
    latestCycle = Math.max(latestCycle, cycle);
    if (action.kind === 'play' && target !== undefined && emitter !== undefined) {
      playedEmitters.set(target, emitter);
    }
  });
  for (const name of ['charge', 'impact', 'burst']) {
    instance.onMarker(name, () => markers.push(name));
  }

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
          duration: 0.7,
          radius: 0.02,
          ringWidth: 0.14,
          speed: 0.85,
          startTime: IMPACT_TIME,
          strength: 0.05,
        },
        {
          center: shockCenter,
          duration: 0.5,
          radius: 0.02,
          ringWidth: 0.1,
          speed: 0.7,
          startTime: COUNTER_TIME,
          strength: 0.028,
        },
      ],
    }),
  });

  const localNow = () => instance.localTime % EFFECT_DURATION;

  // Sub-stepping keeps distance-based trail spawning smooth: at 60 Hz a full
  // sweep crosses half a world unit per frame and every particle spawned in
  // one step lands on the same emitter transform.
  const SUBSTEPS = 4;
  const step = async (delta: number) => {
    for (let subStep = 0; subStep < SUBSTEPS; subStep += 1) {
      const local = localNow();
      socketA.position.set(...crescentA(sweepProgress(local, SLASH_A)));
      socketB.position.set(...crescentB(sweepProgress(local, SLASH_B)));
      socketA.updateMatrixWorld(true);
      socketB.updateMatrixWorld(true);
      await system.update(delta / SUBSTEPS);
      await trailSystem.update(delta / SUBSTEPS);
    }
    materializeNewDraws();
    for (const trail of trailRuntimes) {
      if (trail.draw) continue;
      const view = trail.instance.getEmitter('trail');
      if (!view) continue;
      trail.draw = materializeThreeRibbonDraw(view.program, view.kernels);
      scene.add(trail.draw.mesh);
    }
    for (const trail of trailRuntimes) if (trail.draw) await trail.draw.prepare(renderer);
    if (lightDraw) await lightDraw.update(renderer);
    const shockState = instance.getElementState('shock');
    const shockClone = findMeshFx('wuwa-shock');
    if (shockClone && shockState?.playing) {
      const q = Math.min(1, shockState.localTime / 0.5);
      const scale = 0.3 + 2.6 * (1 - (1 - q) ** 3);
      shockClone.scale.setScalar(scale);
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
    trailSystem.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
    post.controls.setTime(localNow());
  };

  if (headless) {
    // Short warmed GPU sample window for the nachi.perf-baseline record. It
    // respawns the effect so compute work is still in flight while sampling.
    const perfWindow = async () => {
      system.spawn(effect, { position: [0, 0, 0], seed: 0x0a12 });
      const perfTarget = new THREE.RenderTarget(96, 64, { depthBuffer: true });
      const monitor = createPerformanceMonitor(renderer, {
        gpuScopes: ['compute', 'render'],
        mode: 'headless',
        page: 'wuwa-slash',
      });
      await monitor.captureGpuSamples(async () => {
        await step(STEP);
        renderer.setRenderTarget(perfTarget);
        post.render();
      });
      perfTarget.dispose();
    };
    await runHeadless(renderer, post, step, instance, () => trailRuntimes, perfWindow);
    return;
  }

  // Live viewer: present to the page canvas and loop forever; the timeline
  // loops itself, and blade trails are respawned at every new cycle.
  required<HTMLCanvasElement>('#wuwa-visual').style.display = 'none';
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
  required<HTMLElement>('#status-value').textContent = 'looping · watch the slash';
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = 'complete';
  let renderedCycle = 0;
  let previous = performance.now();
  const frame = async () => {
    const now = performance.now();
    const delta = Math.min(0.05, (now - previous) / 1000);
    previous = now;
    if (latestCycle !== renderedCycle) {
      renderedCycle = latestCycle;
      releaseTrails();
      trailRuntimes = spawnTrails();
    }
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
  trails: () => ReadonlyArray<{
    draw?: ReturnType<typeof materializeThreeRibbonDraw>;
    readonly instance: {
      readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
      readonly state: string;
    };
  }>,
  perfWindow: () => Promise<void>,
): Promise<void> {
  const labels = required<HTMLElement>('#frame-labels');
  labels.innerHTML = CAPTURE_LABELS.map((label) => `<span>${label}</span>`).join('');
  const elementKeys = [
    'circleInner',
    'circleOuter',
    'embers',
    'flash',
    'glint',
    'shock',
    'slashCounter',
    'slashMain',
    'sparks',
  ] as const;
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  const captures: Uint8Array[] = [];
  const captureStates: Array<Record<string, unknown>> = [];
  let captureIndex = 0;
  let trailSegments = { segmentCount: 0 };
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
    // Sample the blade ribbon while its particles are still alive; by the end
    // of the run every trail particle has expired and the count reads zero.
    if (instance.localTime >= 0.47 && instance.localTime <= 0.9) {
      const trailDraw = trails()[0]?.draw;
      if (trailDraw) {
        const sample = await readRibbonSegments(renderer, trailDraw);
        if (sample.segmentCount > trailSegments.segmentCount) trailSegments = sample;
      }
    }
  }

  const canvas = required<HTMLCanvasElement>('#wuwa-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('wuwa-slash requires the contact sheet canvas.');
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
  const impact = panelStats[1] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const trailDiagnostics = trails().flatMap(({ instance: trail }) =>
    trail.diagnostics.map(({ code }) => code),
  );
  const checks = {
    allFramesCaptured: captures.length === CAPTURE_TIMES.length,
    consoleClean: consoleMessages.length === 0,
    impactVisible: impact.foregroundRatio > 0.02 && impact.saturatedRatio < 0.3,
    stateHealthy: instance.state !== 'error',
    trailsHealthy:
      trailDiagnostics.length === 0 &&
      trails().every(({ instance: trail }) => trail.state !== 'error'),
    trailRendered: trailSegments.segmentCount > 20,
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
      trailDiagnostics,
      trailSegments: trailSegments.segmentCount,
    },
    ok: Object.values(checks).every(Boolean),
    schema: 'nachi.wuwa-slash.v1',
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'wuwa-slash.png', selector: '#wuwa-visual' },
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
