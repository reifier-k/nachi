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
  pointAttractor,
  positionSphere,
  range,
  sizeOverLife,
  velocityCone,
  VFXSystem as CoreVFXSystem,
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
  hitStop,
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
import './showcase-machina.css';

const WIDTH = 640;
const HEIGHT = 360;
const STEP = 1 / 60;
const EFFECT_DURATION = 2.8;
const COLUMN_TIME = 0.5;
const BARRAGE_START = 0.9;
const STRIKE_INTERVAL = 0.1;
const FINAL_TIME = 1.55;
const AFTERGLOW_TIME = 1.72;
/** World-space y of the effect origin (circle plane sits just above the floor). */
const GROUND_Y = -0.9;
/** Scattered orbital strike points around the circle; the final strike is the column axis. */
const STRIKES = [
  { radius: 0.07, x: 1.0, z: 0.55 },
  { radius: 0.06, x: -1.2, z: -0.3 },
  { radius: 0.08, x: 0.4, z: -0.95 },
  { radius: 0.06, x: -0.6, z: 0.85 },
  { radius: 0.07, x: 1.5, z: -0.55 },
  { radius: 0.065, x: -1.55, z: 0.3 },
] as const;
const FINAL_STRIKE_INDEX = STRIKES.length;
const CAPTURE_TIMES = [0.3, 0.7, 0.98, 1.38, 1.63, 2.3] as const;
const CAPTURE_LABELS = [
  'boot · circuit circle',
  'charge · circuit column',
  'barrage · first strikes',
  'barrage · full volley',
  'final strike · hit stop',
  'afterglow · light shafts',
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
  if (!value) throw new Error(`Missing showcase-machina element: ${selector}`);
  return value;
}

// ---------------------------------------------------------------------------
// Procedural textures. Everything is generated from seeded expressions so the
// page is fully self-contained and deterministic for the screenshot baseline.
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

/** Tiling fbm used by the flat ring and shock dissolves. */
function noiseTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x3c17);
  return grayscaleDataTexture([128, 128], (u, v) => fbm(noise, u * 9.3, v * 9.3));
}

/**
 * Much finer fbm for the cylinders and beams: their dissolve sweeps read as
 * fine energy sparkle instead of fat squiggle contours at column scale.
 */
function fineNoiseTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x71f3);
  return grayscaleDataTexture([128, 128], (u, v) => fbm(noise, u * 21, v * 21));
}

function canvasTexture(
  width: number,
  height: number,
  wrapVertical: boolean,
  draw: (context: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('showcase-machina requires a 2D canvas context.');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = wrapVertical ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  return texture;
}

/**
 * PCB trace strip for the outer ring (u = angle, v = radial). Right-angle
 * copper runs between lanes, annular via dots at the joints, and occasional
 * solder pads, in amber with sparse cyan data lines.
 */
function pcbTraceTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x9cb1);
  return canvasTexture(1024, 96, false, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.globalAlpha = 0.5;
    context.fillStyle = '#ff9a2e';
    context.fillRect(0, 5, 1024, 2);
    context.fillRect(0, 89, 1024, 2);
    context.globalAlpha = 1;
    const lanes = [20, 38, 56, 74];
    const via = (x: number, y: number, color: string) => {
      context.strokeStyle = color;
      context.lineWidth = 2.2;
      context.beginPath();
      context.arc(x, y, 4, 0, Math.PI * 2);
      context.stroke();
    };
    for (let trace = 0; trace < 24; trace += 1) {
      let lane = Math.floor(random() * lanes.length);
      let x = random() * 1024;
      const pick = random();
      const color = pick < 0.16 ? '#54e0ff' : pick < 0.55 ? '#ff9a2e' : '#ffc94a';
      context.strokeStyle = color;
      context.lineWidth = random() < 0.35 ? 3.5 : 2.5;
      via(x, lanes[lane]!, color);
      const hops = 2 + Math.floor(random() * 3);
      for (let hop = 0; hop < hops; hop += 1) {
        const run = 40 + random() * 90;
        context.beginPath();
        context.moveTo(x, lanes[lane]!);
        context.lineTo(x + run, lanes[lane]!);
        context.stroke();
        x += run;
        if (hop < hops - 1) {
          const next = Math.max(0, Math.min(lanes.length - 1, lane + (random() < 0.5 ? -1 : 1)));
          if (next !== lane) {
            context.beginPath();
            context.moveTo(x, lanes[lane]!);
            context.lineTo(x, lanes[next]!);
            context.stroke();
            lane = next;
          }
        }
      }
      if (random() < 0.5) via(x, lanes[lane]!, color);
      else {
        context.fillStyle = color;
        context.fillRect(x - 3, lanes[lane]! - 4.5, 6, 9);
      }
    }
  });
}

/** Dashed data segments for the counter-rotating middle ring. */
function dataDashTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0xda5b);
  return canvasTexture(512, 40, false, (context) => {
    context.globalCompositeOperation = 'lighter';
    for (const y of [9, 24]) {
      let x = random() * 24;
      while (x < 512) {
        const length = 10 + random() * 26;
        const pick = random();
        context.fillStyle = pick < 0.4 ? '#54e0ff' : pick < 0.85 ? '#ffc94a' : '#f4f8ff';
        context.globalAlpha = 0.55 + random() * 0.45;
        context.fillRect(x, y, length, 6);
        context.fillStyle = '#ffffff';
        context.fillRect(x + length - 3, y, 3, 6);
        x += length + 8 + random() * 20;
      }
    }
    context.globalAlpha = 1;
  });
}

/**
 * Concentric polygon strip for the inner ring: a hexagon outline (amber), a
 * fainter cyan octagon, and radial ticks along the inner edge. The annulus
 * maps u to angle and v to radius, so the polygon radius profile is drawn as
 * a curve across the strip; canvas y = 0 is the outer edge (flipY).
 */
function polygonTickTexture(): THREE.CanvasTexture {
  return canvasTexture(1024, 64, false, (context) => {
    context.globalCompositeOperation = 'lighter';
    const polygonY = (u: number, sides: number): number => {
      const period = (Math.PI * 2) / sides;
      const theta = ((u * Math.PI * 2) % period) - period / 2;
      const r = 1 / Math.cos(theta);
      const norm = (r - 1) / (1 / Math.cos(period / 2) - 1);
      const v = 0.32 + norm * 0.42;
      return (1 - v) * 64;
    };
    const stroke = (sides: number, color: string, width: number, alpha: number) => {
      context.strokeStyle = color;
      context.lineWidth = width;
      context.globalAlpha = alpha;
      context.beginPath();
      for (let x = 0; x <= 1024; x += 2) {
        const y = polygonY(x / 1024, sides);
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    };
    stroke(6, '#ffc94a', 2.6, 0.95);
    stroke(8, '#54e0ff', 1.4, 0.55);
    context.globalAlpha = 0.85;
    for (let index = 0; index < 32; index += 1) {
      const x = index * 32;
      const major = index % 4 === 0;
      context.fillStyle = major ? '#fff6da' : '#ff9a2e';
      context.fillRect(x, major ? 44 : 50, major ? 3 : 2.5, major ? 16 : 10);
    }
    context.globalAlpha = 0.5;
    context.fillStyle = '#ff9a2e';
    context.fillRect(0, 60, 1024, 1.6);
    context.globalAlpha = 1;
  });
}

/**
 * Vertical circuit traces for the column of light (v tiles vertically so the
 * texture can scroll upward forever). Copper verticals with lane jogs, via
 * dots, bright white tick heads, and faint horizontal bus rails.
 */
function circuitColumnTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0xc01c);
  return canvasTexture(512, 512, true, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.globalAlpha = 0.1;
    context.fillStyle = '#ff9a2e';
    for (const railY of [64, 192, 320, 448]) context.fillRect(0, railY, 512, 2);
    context.globalAlpha = 1;
    const laneX = (lane: number) => ((lane * 36.5 + 10) % 512 + 512) % 512;
    for (let run = 0; run < 38; run += 1) {
      let lane = Math.floor(random() * 14);
      let y = random() * 512;
      const pick = random();
      const color = pick < 0.18 ? '#2f98b8' : pick < 0.62 ? '#b86a1c' : '#d98a2a';
      context.strokeStyle = color;
      context.lineWidth = 2;
      const hops = 2 + Math.floor(random() * 2);
      for (let hop = 0; hop < hops; hop += 1) {
        const length = 80 + random() * 140;
        context.beginPath();
        context.moveTo(laneX(lane), y);
        context.lineTo(laneX(lane), y + length);
        context.stroke();
        y += length;
        if (hop < hops - 1 && random() < 0.45) {
          const next = lane + (random() < 0.5 ? -1 : 1);
          context.beginPath();
          context.moveTo(laneX(lane), y);
          context.lineTo(laneX(next), y);
          context.stroke();
          lane = next;
        }
      }
      context.beginPath();
      context.arc(laneX(lane), y % 512, 2.8, 0, Math.PI * 2);
      context.stroke();
    }
    for (let tick = 0; tick < 22; tick += 1) {
      const x = laneX(Math.floor(random() * 14));
      const y = random() * 512;
      context.globalAlpha = 0.25 + random() * 0.25;
      context.fillStyle = '#ffe9b0';
      context.fillRect(x - 1.5, y, 3, 8 + random() * 8);
    }
    context.globalAlpha = 1;
  });
}

/** Thin cyan data streams for the counter-scrolling inner column. */
function innerStreamTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x1cee);
  return canvasTexture(256, 512, true, (context) => {
    context.globalCompositeOperation = 'lighter';
    for (let lane = 0; lane < 14; lane += 1) {
      const x = lane * 18.3 + 4;
      let y = random() * 512;
      while (y < 512 + 64) {
        const length = 24 + random() * 46;
        const pick = random();
        context.fillStyle = pick < 0.55 ? '#54e0ff' : pick < 0.85 ? '#2a8fc0' : '#9ef4ff';
        context.globalAlpha = 0.35 + random() * 0.5;
        context.fillRect(x, y % 512, 2.5, length);
        context.globalAlpha = 0.7;
        context.fillStyle = '#e8fdff';
        context.fillRect(x - 0.5, y % 512, 3.5, 5);
        y += length + 30 + random() * 80;
      }
    }
    context.globalAlpha = 1;
  });
}

/** Orbital beam body: amber base with white pulse bands that race along v. */
function beamTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0xbea3);
  return canvasTexture(64, 256, true, (context) => {
    context.fillStyle = '#5c3810';
    context.fillRect(0, 0, 64, 256);
    context.globalCompositeOperation = 'lighter';
    for (let band = 0; band < 9; band += 1) {
      const y = random() * 256;
      const height = 8 + random() * 16;
      context.globalAlpha = 0.25 + random() * 0.25;
      context.fillStyle = '#ffc94a';
      context.fillRect(0, y, 64, height);
    }
    for (let line = 0; line < 7; line += 1) {
      const y = random() * 256;
      context.globalAlpha = 0.3 + random() * 0.25;
      context.fillStyle = '#fff2d0';
      context.fillRect(0, y, 64, 2 + random() * 2);
    }
    context.globalAlpha = 1;
  });
}

/** The final judgment beam: hotter core with white and cyan pulse bands. */
function finalBeamTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0xf1a1);
  return canvasTexture(64, 256, true, (context) => {
    context.fillStyle = '#7c5418';
    context.fillRect(0, 0, 64, 256);
    context.globalCompositeOperation = 'lighter';
    for (let band = 0; band < 10; band += 1) {
      const y = random() * 256;
      const height = 10 + random() * 18;
      context.globalAlpha = 0.3 + random() * 0.25;
      context.fillStyle = band % 3 === 2 ? '#bdf2ff' : '#ffd98a';
      context.fillRect(0, y, 64, height);
    }
    for (let line = 0; line < 8; line += 1) {
      const y = random() * 256;
      context.globalAlpha = 0.4 + random() * 0.25;
      context.fillStyle = '#fff6e8';
      context.fillRect(0, y, 64, 2 + random() * 3);
    }
    context.globalAlpha = 1;
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

/** Plain soft radial glow for scanlines, embers, haze, and impact flashes. */
function glowSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    return Math.exp(-(x * x + y * y) * 5.5);
  });
}

/** Hard-edged pixel block with a faint halo for digital motes. */
function pixelSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([32, 32], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const box = Math.max(Math.abs(x), Math.abs(y));
    const core = box < 0.38 ? 1 : box < 0.52 ? (0.52 - box) / 0.14 : 0;
    return core + Math.exp(-(x * x + y * y) * 4) * 0.25;
  });
}

// ---------------------------------------------------------------------------
// Effect authoring.
// ---------------------------------------------------------------------------

const SPARK_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-machina/spark',
};
const GLOW_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-machina/glow',
};
const PIXEL_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-machina/pixel',
};

interface EffectTextures {
  readonly beam: THREE.Texture;
  readonly beamFinal: THREE.Texture;
  readonly circuit: THREE.Texture;
  readonly dashes: THREE.Texture;
  readonly fineNoise: THREE.Texture;
  readonly noise: THREE.Texture;
  readonly pcb: THREE.Texture;
  readonly polygon: THREE.Texture;
  readonly streams: THREE.Texture;
}

function createMachinaJudgment(textures: EffectTextures, loop: boolean) {
  const bootMotes = defineEmitter({
    capacity: 90,
    init: [
      positionSphere({ radius: 1.45, surfaceOnly: true }),
      velocityCone({ angle: 22, direction: [0, 1, 0], speed: range(0.5, 1.3) }),
      lifetime(range(0.45, 0.85)),
    ],
    render: billboard({ blending: 'additive', map: PIXEL_REF }),
    spawn: burst({ count: 24, cycles: 4, interval: 0.1 }),
    update: [
      drag(0.6),
      sizeOverLife(curve([0, 0.018], [0.3, 0.06], [1, 0.006])),
      colorOverLife(gradient('#d9fbff', '#54e0ff', '#1f7fc400')),
    ],
  });
  const scanlines = defineEmitter({
    capacity: 70,
    init: [
      positionSphere({ radius: 1.25, surfaceOnly: true }),
      velocityCone({ angle: 7, direction: [0, 1, 0], speed: range(2.6, 5.2) }),
      lifetime(range(0.1, 0.24)),
    ],
    render: billboard({
      alignment: { factor: 1.15, mode: 'velocity-stretch' },
      blending: 'additive',
      map: GLOW_REF,
    }),
    spawn: burst({ count: 10, cycles: 7, interval: 0.065 }),
    update: [
      sizeOverLife(curve([0, 0.03], [0.4, 0.05], [1, 0.004])),
      colorOverLife(gradient('#ffffff', '#9ef0ff', '#54e0ff00')),
    ],
  });
  const chargeMotes = defineEmitter({
    capacity: 150,
    init: [
      positionSphere({ radius: 0.8 }),
      velocityCone({ angle: 14, direction: [0, 1, 0], speed: range(1.6, 3.4) }),
      lifetime(range(0.35, 0.7)),
    ],
    render: billboard({
      alignment: { factor: 0.7, mode: 'velocity-stretch' },
      blending: 'additive',
      map: PIXEL_REF,
    }),
    spawn: burst({ count: 13, cycles: 8, interval: 0.055 }),
    update: [
      pointAttractor({ falloff: 1, position: [0, 2.2, 0], strength: 10 }),
      drag(0.5),
      sizeOverLife(curve([0, 0.03], [0.5, 0.05], [1, 0.006])),
      colorOverLife(gradient('#fff3d0', '#ffc94a', '#ff9a2e00')),
    ],
  });
  const embers = defineEmitter({
    capacity: 100,
    init: [
      positionSphere({ radius: 1.15 }),
      velocityCone({ angle: 60, direction: [0, 1, 0], speed: range(0.3, 1.0) }),
      lifetime(range(0.8, 1.5)),
    ],
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 20, cycles: 5, interval: 0.13 }),
    update: [
      curlNoise({ frequency: 1.3, strength: 2.4 }),
      gravity([0, 0.7, 0]),
      drag(1.3),
      sizeOverLife(curve([0, 0.012], [0.3, 0.07], [1, 0])),
      colorOverLife(gradient('#ffe9b0', '#ffc94a', '#ff9a2e', '#b8431000')),
    ],
  });
  const haze = defineEmitter({
    capacity: 40,
    init: [
      positionSphere({ radius: 1.3 }),
      velocityCone({ angle: 40, direction: [0, 1, 0], speed: range(0.15, 0.5) }),
      lifetime(range(0.9, 1.6)),
    ],
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 7, cycles: 4, interval: 0.2 }),
    update: [
      curlNoise({ frequency: 0.7, strength: 0.9 }),
      sizeOverLife(curve([0, 0.1], [0.4, 0.4], [1, 0.05])),
      colorOverLife(gradient('#ff9a2e40', '#ffc94a30', '#54e0ff00')),
    ],
  });
  const coreLight = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(1.5), lightIntensity(6)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 2.6 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 0], [0.3, 7], [0.75, 5], [1, 0])),
      colorOverLife(gradient('#ffd98a', '#ff9a2e')),
    ],
  });
  const strikeLight = defineEmitter({
    capacity: 8,
    init: [positionSphere({ radius: 0 }), lifetime(0.16), lightIntensity(10)],
    integration: 'none',
    render: lightRenderer({ maxLights: 2, radiusScale: 2.6 }),
    spawn: burst({ count: 1, cycles: STRIKES.length, interval: STRIKE_INTERVAL }),
    update: [
      intensityOverLife(curve([0, 10], [1, 0])),
      colorOverLife(gradient('#ffffff', '#ffc94a')),
    ],
  });
  const finalLight = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.5), lightIntensity(14)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3.2 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 14], [0.3, 8], [1, 0])),
      colorOverLife(gradient('#ffffff', '#bdf2ff', '#ffc94a')),
    ],
  });

  const circleOuterMesh = ring({
    innerRadius: 1.3,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#ffe9b0',
        edgeWidth: 0.08,
        overLife: curve([0, 1], [0.035, 0.55], [0.055, 0.85], [0.1, 0.08], [0.86, 0.12], [1, 1]),
        texture: textures.noise,
      },
      map: textures.pcb,
      opacity: 0.92,
      uv: uvFlow({ speed: [0.045, 0] }),
    }),
    outerRadius: 1.72,
    segments: 128,
  });
  circleOuterMesh.name = 'machina-circle-outer';
  circleOuterMesh.rotation.x = -Math.PI / 2;
  circleOuterMesh.position.y = 0.02;
  const circleMidMesh = ring({
    innerRadius: 0.98,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#d9fbff',
        edgeWidth: 0.07,
        overLife: curve([0, 1], [0.05, 0.6], [0.07, 0.9], [0.12, 0.1], [0.86, 0.14], [1, 1]),
        texture: textures.noise,
      },
      map: textures.dashes,
      opacity: 0.85,
      uv: uvFlow({ speed: [-0.12, 0] }),
    }),
    outerRadius: 1.2,
    segments: 96,
  });
  circleMidMesh.name = 'machina-circle-mid';
  circleMidMesh.rotation.x = -Math.PI / 2;
  circleMidMesh.position.y = 0.03;
  const circleCoreMesh = ring({
    innerRadius: 0.42,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#fff6da',
        edgeWidth: 0.07,
        overLife: curve([0, 1], [0.06, 0.65], [0.08, 0.95], [0.14, 0.09], [0.88, 0.13], [1, 1]),
        texture: textures.noise,
      },
      map: textures.polygon,
      opacity: 0.9,
      uv: uvFlow({ speed: [0.07, 0] }),
    }),
    outerRadius: 0.9,
    segments: 96,
  });
  circleCoreMesh.name = 'machina-circle-core';
  circleCoreMesh.rotation.x = -Math.PI / 2;
  circleCoreMesh.position.y = 0.04;

  const columnMesh = cylinder({
    height: 3.2,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#ffe9b0',
        edgeWidth: 0.035,
        // Hold thresholds sit below the fbm floor so the edge highlight only
        // flares during the in/out sweeps instead of etching contour lines.
        overLife: curve([0, 1], [0.06, 0.02], [0.6, 0.05], [1, 1]),
        texture: textures.fineNoise,
      },
      map: textures.circuit,
      opacity: 0.62,
      uv: uvFlow({ speed: [0, -1.15] }),
    }),
    radialSegments: 48,
    radius: 0.72,
  });
  columnMesh.name = 'machina-column';
  // Keep the base-pivot bake: clone scale animates the column's vertical growth.
  columnMesh.geometry.translate(0, 1.61, 0);
  const columnInnerMesh = cylinder({
    height: 3.0,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#9adfff',
        edgeWidth: 0.03,
        overLife: curve([0, 1], [0.04, 0.02], [0.55, 0.06], [1, 1]),
        texture: textures.fineNoise,
      },
      map: textures.streams,
      opacity: 0.7,
      uv: uvFlow({ speed: [0, 0.85] }),
    }),
    radialSegments: 40,
    radius: 0.4,
  });
  columnInnerMesh.name = 'machina-column-inner';
  columnInnerMesh.geometry.translate(0, 1.51, 0);

  const laserMesh = (index: number, radius: number, final: boolean) => {
    const mesh = cylinder({
      height: 6,
      material: fxMaterial({
        blending: 'additive',
        dissolve: {
          edgeColor: final ? '#bdf2ff' : '#fff6da',
          edgeWidth: 0.05,
          overLife: final
            ? curve([0, 1], [0.04, 0.015], [0.4, 0.03], [1, 1])
            : curve([0, 1], [0.03, 0.02], [0.35, 0.04], [1, 1]),
          texture: textures.fineNoise,
        },
        map: final ? textures.beamFinal : textures.beam,
        opacity: final ? 0.84 : 0.8,
        uv: uvFlow({ speed: [0, final ? 3.2 : 2.6] }),
      }),
      radialSegments: 24,
      radius,
    });
    mesh.name = final ? 'machina-laser-final' : `machina-laser-${index}`;
    // Keep the beam base at the clone origin used by per-strike choreography.
    mesh.geometry.translate(0, 3, 0);
    return mesh;
  };
  const shockMesh = (index: number, final: boolean) => {
    const mesh = ring({
      innerRadius: final ? 0.2 : 0.16,
      material: fxMaterial({
        blending: 'additive',
        color: final ? '#bdf2ff' : '#ffc94a',
        dissolve: {
          edgeColor: '#fff2d0',
          edgeWidth: 0.05,
          overLife: curve([0, 0.15], [0.55, 0.45], [1, 1]),
          texture: textures.noise,
        },
        opacity: 0.8,
      }),
      outerRadius: final ? 0.42 : 0.3,
      segments: 48,
    });
    mesh.name = final ? 'machina-shock-final' : `machina-shock-${index}`;
    // Keep orientation baked so page-driven x/z scale expands in the ground plane.
    mesh.geometry.rotateX(-Math.PI / 2);
    return mesh;
  };
  const lasers = STRIKES.map((strike, index) => laserMesh(index, strike.radius, false));
  const shocks = STRIKES.map((_, index) => shockMesh(index, false));
  const laserFinalMesh = laserMesh(FINAL_STRIKE_INDEX, 0.17, true);
  const shockFinalMesh = shockMesh(FINAL_STRIKE_INDEX, true);

  return defineEffect({
    elements: {
      bootMotes,
      chargeMotes,
      circleCore: meshFxElement(circleCoreMesh, { duration: 2.75 }),
      circleMid: meshFxElement(circleMidMesh, { duration: 2.75 }),
      circleOuter: meshFxElement(circleOuterMesh, { duration: 2.75 }),
      column: meshFxElement(columnMesh, { duration: 2.05 }),
      columnInner: meshFxElement(columnInnerMesh, { duration: 1.95 }),
      coreLight,
      embers,
      finalLight,
      haze,
      laser0: meshFxElement(lasers[0]!, { duration: 1.35 }),
      laser1: meshFxElement(lasers[1]!, { duration: 1.35 }),
      laser2: meshFxElement(lasers[2]!, { duration: 1.35 }),
      laser3: meshFxElement(lasers[3]!, { duration: 1.35 }),
      laser4: meshFxElement(lasers[4]!, { duration: 1.35 }),
      laser5: meshFxElement(lasers[5]!, { duration: 1.35 }),
      laserFinal: meshFxElement(laserFinalMesh, { duration: 1.15 }),
      scanlines,
      shock0: meshFxElement(shocks[0]!, { duration: 0.45 }),
      shock1: meshFxElement(shocks[1]!, { duration: 0.45 }),
      shock2: meshFxElement(shocks[2]!, { duration: 0.45 }),
      shock3: meshFxElement(shocks[3]!, { duration: 0.45 }),
      shock4: meshFxElement(shocks[4]!, { duration: 0.45 }),
      shock5: meshFxElement(shocks[5]!, { duration: 0.45 }),
      shockFinal: meshFxElement(shockFinalMesh, { duration: 0.6 }),
      strikeLight,
    },
    timeline: timeline(
      [
        at(
          0,
          play('circleOuter'),
          play('circleMid'),
          play('circleCore'),
          play('bootMotes'),
          play('scanlines'),
          marker('boot'),
        ),
        at(
          COLUMN_TIME,
          play('column'),
          play('coreLight'),
          play('chargeMotes'),
          cameraShake({ duration: 0.35, frequency: 16, strength: 0.05 }),
          marker('charge'),
        ),
        at(0.56, play('columnInner')),
        at(
          BARRAGE_START,
          play('laser0'),
          play('shock0'),
          play('strikeLight'),
          cameraShake({ duration: 0.25, frequency: 26, strength: 0.14 }),
          marker('barrage'),
        ),
        at(BARRAGE_START + STRIKE_INTERVAL, play('laser1'), play('shock1')),
        at(BARRAGE_START + STRIKE_INTERVAL * 2, play('laser2'), play('shock2')),
        at(BARRAGE_START + STRIKE_INTERVAL * 3, play('laser3'), play('shock3')),
        at(BARRAGE_START + STRIKE_INTERVAL * 4, play('laser4'), play('shock4')),
        at(BARRAGE_START + STRIKE_INTERVAL * 5, play('laser5'), play('shock5')),
        at(
          FINAL_TIME,
          play('laserFinal'),
          play('shockFinal'),
          play('finalLight'),
          cameraShake({ duration: 0.45, frequency: 30, strength: 0.4 }),
          marker('final'),
        ),
        at(1.62, hitStop(80)),
        at(AFTERGLOW_TIME, play('embers'), marker('afterglow')),
        at(1.78, play('haze')),
      ],
      { duration: EFFECT_DURATION, ...(loop ? { loop: true } : {}) },
    ),
  });
}

/** Per-strike ground burst spawned at the strike position by the core system. */
function createImpactEffect(final: boolean) {
  const flash = defineEmitter({
    capacity: 12,
    init: [
      positionSphere({ radius: 0.04 }),
      velocityCone({ angle: 80, direction: [0, 1, 0], speed: range(0.2, 0.9) }),
      lifetime(range(0.1, 0.2)),
    ],
    lifecycle: { duration: 0.9 },
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: final ? 7 : 5 }),
    update: [
      sizeOverLife(
        final ? curve([0, 0.24], [0.3, 0.36], [1, 0.02]) : curve([0, 0.2], [0.3, 0.3], [1, 0.015]),
      ),
      colorOverLife(gradient('#ffffff', final ? '#bdf2ff' : '#ffe2a0', '#ff9a2e00')),
    ],
  });
  const sparks = defineEmitter({
    capacity: final ? 160 : 100,
    init: [
      positionSphere({ radius: 0.05 }),
      velocityCone({ angle: 65, direction: [0, 1, 0], speed: range(3, final ? 10 : 8) }),
      lifetime(range(0.25, 0.7)),
    ],
    lifecycle: { duration: 0.9 },
    render: billboard({
      alignment: { factor: 0.65, mode: 'velocity-stretch' },
      blending: 'additive',
      map: SPARK_REF,
    }),
    spawn: burst({ count: final ? 130 : 80 }),
    update: [
      gravity([0, -9.8, 0]),
      drag(1.0),
      collidePlane({ bounce: 0.4, friction: 0.3, mode: 'bounce', normal: [0, 1, 0], offset: -0.92 }),
      sizeOverLife(curve([0, 0.05], [0.4, 0.028], [1, 0.004])),
      colorOverLife(gradient('#ffffff', '#ffe08a', '#ff9a2e', '#ff3a1000')),
    ],
  });
  return defineEffect({ elements: { flash, sparks } });
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
  if (!backend.isWebGPUBackend) throw new Error('Machina Judgment requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  required<HTMLElement>('#mode-value').textContent = headless
    ? 'headless keyframe capture'
    : 'live loop';

  const textures: EffectTextures = {
    beam: beamTexture(),
    beamFinal: finalBeamTexture(),
    circuit: circuitColumnTexture(),
    dashes: dataDashTexture(),
    fineNoise: fineNoiseTexture(),
    noise: noiseTexture(),
    pcb: pcbTraceTexture(),
    polygon: polygonTickTexture(),
    streams: innerStreamTexture(),
  };
  const spark = sparkSpriteTexture();
  const glow = glowSpriteTexture();
  const pixel = pixelSpriteTexture();
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [SPARK_REF.uri, spark],
      [GLOW_REF.uri, glow],
      [PIXEL_REF.uri, pixel],
    ]),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02040c);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshStandardNodeMaterial({ color: 0x0a0f18, metalness: 0.3, roughness: 0.5 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.95;
  scene.add(ground, new THREE.HemisphereLight(0x24405c, 0x040709, 0.35));

  const camera = new THREE.PerspectiveCamera(42, WIDTH / HEIGHT, 0.1, 40);
  const cameraBasePosition = new THREE.Vector3(0.4, 1.25, 5.9);
  camera.position.copy(cameraBasePosition);
  camera.lookAt(0, 0.3, 0);
  const cameraBaseRotation = camera.rotation.clone();

  const projectPoint = (x: number, y: number, z: number): [number, number] => {
    const projected = new THREE.Vector3(x, y, z).project(camera);
    return [0.5 + projected.x * 0.5, 0.5 - projected.y * 0.5];
  };
  const firstStrikeCenter = projectPoint(STRIKES[0].x, -0.5, STRIKES[0].z);
  const finalStrikeCenter = projectPoint(0, 0.4, 0);

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
  const effect = createMachinaJudgment(textures, !headless);
  const instance = system.spawn(effect, { position: [0, GROUND_Y, 0], seed: 0x77a1 });

  // Impact bursts run on a second core system so each barrage strike can
  // spawn its sparks at the strike's own world position.
  const impactSystem = new CoreVFXSystem(runtime, undefined, { registry });
  impactSystem.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
  const impactEffect = createImpactEffect(false);
  const impactFinalEffect = createImpactEffect(true);

  interface ImpactRuntime {
    age: number;
    readonly draws: Map<string, THREE.Mesh>;
    readonly instance: {
      readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
      readonly state: string;
      getEmitter(key: string): VfxEmitterRuntimeView | undefined;
      release(): void;
    };
  }
  const impacts: ImpactRuntime[] = [];
  const pendingStrikes: number[] = [];
  const strikeIndexByTarget = new Map<string, number>([
    ...STRIKES.map((_, index) => [`laser${index}`, index] as const),
    ['laserFinal', FINAL_STRIKE_INDEX],
  ]);
  const spawnImpact = (strikeIndex: number) => {
    const final = strikeIndex === FINAL_STRIKE_INDEX;
    const strike = final ? { x: 0, z: 0 } : STRIKES[strikeIndex]!;
    const spawned = impactSystem.spawn(final ? impactFinalEffect : impactEffect, {
      position: [strike.x, -0.82, strike.z],
      seed: 0x5100 + strikeIndex,
    });
    impacts.push({ age: 0, draws: new Map(), instance: spawned });
  };

  const actions: Array<{ kind: string; localTime: number; target?: string }> = [];
  const markers: string[] = [];
  const playedEmitters = new Map<string, VfxEmitterRuntimeView>();
  instance.onAction(({ action, emitter, localTime }) => {
    const target = 'target' in action ? action.target : undefined;
    actions.push({ kind: action.kind, localTime, ...(target === undefined ? {} : { target }) });
    if (action.kind !== 'play' || target === undefined) return;
    if (emitter !== undefined) playedEmitters.set(target, emitter);
    const strikeIndex = strikeIndexByTarget.get(target);
    if (strikeIndex !== undefined) pendingStrikes.push(strikeIndex);
  });
  for (const name of ['boot', 'charge', 'barrage', 'final', 'afterglow']) {
    instance.onMarker(name, () => markers.push(name));
  }

  const LIGHT_KEYS = new Set(['coreLight', 'finalLight', 'strikeLight']);
  const spriteDraws = new Map<string, { object: THREE.Mesh; view: VfxEmitterRuntimeView }>();
  const lightDraws = new Map<
    string,
    { draw: ReturnType<typeof materializeThreeLightDraw>; view: VfxEmitterRuntimeView }
  >();
  const materializeNewDraws = () => {
    for (const [key, view] of playedEmitters) {
      if (LIGHT_KEYS.has(key)) {
        const existing = lightDraws.get(key);
        if (existing?.view === view) continue;
        if (existing) {
          existing.draw.dispose();
          scene.remove(existing.draw.group);
        }
        const draw = materializeThreeLightDraw(view.program, view.kernels);
        scene.add(draw.group);
        lightDraws.set(key, { draw, view });
        continue;
      }
      const existing = spriteDraws.get(key);
      if (existing?.view === view) continue;
      if (existing) scene.remove(existing.object);
      const object = materializeThreeSpriteDraw(view.program, view.kernels, 0, { resolveTexture });
      scene.add(object);
      spriteDraws.set(key, { object, view });
    }
    for (const impact of impacts) {
      for (const key of ['flash', 'sparks'] as const) {
        if (impact.draws.has(key)) continue;
        const view = impact.instance.getEmitter(key);
        if (!view) continue;
        const object = materializeThreeSpriteDraw(view.program, view.kernels, 0, {
          resolveTexture,
        });
        scene.add(object);
        impact.draws.set(key, object);
      }
    }
  };

  const findMeshFx = (name: string): THREE.Mesh | undefined =>
    scene.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === name,
    );

  // Clone scale/position are choreographed per frame: scale drives the column
  // climb and laser width pulses, and position moves origin-baked laser and
  // shock geometry to each strike point after the runtime transform reset.
  const animateClones = () => {
    const columnState = instance.getElementState('column');
    const columnClone = findMeshFx('machina-column');
    if (columnClone && columnState?.playing) {
      const p = Math.min(1, columnState.localTime / 0.26);
      columnClone.scale.set(1, 0.04 + 0.96 * easeOutCubic(p), 1);
    }
    const innerState = instance.getElementState('columnInner');
    const innerClone = findMeshFx('machina-column-inner');
    if (innerClone && innerState?.playing) {
      const p = Math.min(1, innerState.localTime / 0.22);
      innerClone.scale.set(1, 0.04 + 0.96 * easeOutCubic(p), 1);
    }
    const strikeClones = (
      laserName: string,
      shockName: string,
      laserKey: string,
      shockKey: string,
      x: number,
      z: number,
      pulse: number,
    ) => {
      const laserState = instance.getElementState(laserKey);
      const laserClone = findMeshFx(laserName);
      if (laserClone && laserState?.playing) {
        laserClone.position.set(x, GROUND_Y, z);
        const width = 1 + pulse * Math.exp(-laserState.localTime * 15);
        laserClone.scale.set(width, 1, width);
      }
      const shockState = instance.getElementState(shockKey);
      const shockClone = findMeshFx(shockName);
      if (shockClone && shockState?.playing) {
        shockClone.position.set(x, GROUND_Y + 0.03, z);
        const q = Math.min(1, shockState.localTime / 0.42);
        const spread = 0.35 + 2.5 * easeOutCubic(q);
        shockClone.scale.set(spread, 1, spread);
      }
    };
    STRIKES.forEach((strike, index) => {
      strikeClones(
        `machina-laser-${index}`,
        `machina-shock-${index}`,
        `laser${index}`,
        `shock${index}`,
        strike.x,
        strike.z,
        1.5,
      );
    });
    strikeClones('machina-laser-final', 'machina-shock-final', 'laserFinal', 'shockFinal', 0, 0, 1.4);
  };

  const post = createPostPipeline(renderer, scene, camera, {
    bloom: bloomPreset('intense', { radius: 0.62, strength: 0.85, threshold: 0.5 }),
    distortion: screenDistortion({
      shockwaves: [
        {
          center: firstStrikeCenter,
          duration: 0.6,
          radius: 0.02,
          ringWidth: 0.12,
          speed: 0.8,
          startTime: BARRAGE_START,
          strength: 0.045,
        },
        {
          center: finalStrikeCenter,
          duration: 0.75,
          radius: 0.02,
          ringWidth: 0.16,
          speed: 0.9,
          startTime: FINAL_TIME,
          strength: 0.065,
        },
      ],
    }),
  });

  const localNow = () => instance.localTime % EFFECT_DURATION;

  // Sub-stepping keeps the burst cadence and collision response stable at the
  // capture rate; every strike spawned in one step lands on the same frame.
  const SUBSTEPS = 4;
  const step = async (delta: number) => {
    while (pendingStrikes.length > 0) spawnImpact(pendingStrikes.shift()!);
    for (let subStep = 0; subStep < SUBSTEPS; subStep += 1) {
      await system.update(delta / SUBSTEPS);
      await impactSystem.update(delta / SUBSTEPS);
    }
    materializeNewDraws();
    for (const { draw } of lightDraws.values()) await draw.update(renderer);
    for (let index = impacts.length - 1; index >= 0; index -= 1) {
      const impact = impacts[index]!;
      impact.age += delta;
      if (!headless && impact.age > 1.5) {
        for (const object of impact.draws.values()) scene.remove(object);
        impact.instance.release();
        impacts.splice(index, 1);
      }
    }
    animateClones();
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
    impactSystem.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
    post.controls.setTime(localNow());
  };

  if (headless) {
    // Short warmed GPU sample window for the nachi.perf-baseline record. It
    // respawns the effect so compute work is still in flight while sampling.
    const perfWindow = async () => {
      system.spawn(effect, { position: [0, GROUND_Y, 0], seed: 0x77a2 });
      const perfTarget = new THREE.RenderTarget(96, 64, { depthBuffer: true });
      const monitor = createPerformanceMonitor(renderer, {
        gpuScopes: ['compute', 'render'],
        mode: 'headless',
        page: 'showcase-machina',
      });
      await monitor.captureGpuSamples(async () => {
        await step(STEP);
        renderer.setRenderTarget(perfTarget);
        post.render();
      });
      perfTarget.dispose();
    };
    await runHeadless(
      renderer,
      post,
      step,
      instance,
      () => impacts,
      () => [...spriteDraws.keys(), ...lightDraws.keys()],
      perfWindow,
    );
    return;
  }

  // Live viewer: present to the page canvas and loop forever; the timeline
  // loops itself and impact instances are recycled by age.
  required<HTMLCanvasElement>('#machina-visual').style.display = 'none';
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
  required<HTMLElement>('#status-value').textContent = 'looping · watch the judgment';
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
  impacts: () => ReadonlyArray<{
    readonly instance: {
      readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
      readonly state: string;
    };
  }>,
  drawKeys: () => readonly string[],
  perfWindow: () => Promise<void>,
): Promise<void> {
  const labels = required<HTMLElement>('#frame-labels');
  labels.innerHTML = CAPTURE_LABELS.map((label) => `<span>${label}</span>`).join('');
  const elementKeys = [
    'circleCore',
    'circleMid',
    'circleOuter',
    'column',
    'columnInner',
    'embers',
    'haze',
    'laser0',
    'laser5',
    'laserFinal',
    'shockFinal',
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
  for (let frame = 0; frame < 195; frame += 1) {
    await step(STEP);
    renderer.setRenderTarget(target);
    post.render();
    // A tiny readback every frame keeps the async readback path drained; a
    // full-size capture after many readback-free frames returns empty pixels.
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    // Derived burst envelopes overlap heavily during the barrage. Drain both timestamp scopes
    // every frame so the page-local compute query pool cannot accumulate enough entries to warn.
    await renderer.resolveTimestampsAsync('compute');
    await renderer.resolveTimestampsAsync('render');
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

  const canvas = required<HTMLCanvasElement>('#machina-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('showcase-machina requires the contact sheet canvas.');
  const sheet = context.createImageData(WIDTH * 3, HEIGHT * 2);
  const panelStats: Array<{ foregroundRatio: number; saturatedRatio: number }> = [];
  captures.forEach((pixels, panel) => {
    const panelX = (panel % 3) * WIDTH;
    const panelY = Math.floor(panel / 3) * HEIGHT;
    let foreground = 0;
    let saturated = 0;
    // The post pipeline's readback already returns rows top-down.
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const source = (y * WIDTH + x) * 4;
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
  const barrage = panelStats[3] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const finalStrike = panelStats[4] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const afterglow = panelStats[5] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const impactDiagnostics = impacts().flatMap(({ instance: impact }) =>
    impact.diagnostics.map(({ code }) => code),
  );
  const checks = {
    afterglowLingers: afterglow.foregroundRatio > 0.012,
    allFramesCaptured: captures.length === CAPTURE_TIMES.length,
    allStrikesLanded: impacts().length === STRIKES.length + 1,
    barrageReads: barrage.foregroundRatio > 0.035 && barrage.saturatedRatio < 0.28,
    consoleClean: consoleMessages.length === 0,
    finalStrikeReads: finalStrike.foregroundRatio > 0.04 && finalStrike.saturatedRatio < 0.3,
    impactsHealthy:
      impactDiagnostics.length === 0 &&
      impacts().every(({ instance: impact }) => impact.state !== 'error'),
    stateHealthy: instance.state !== 'error',
  };
  const result = {
    checks,
    consoleMessages,
    evidence: {
      captureStates,
      captureTimes: CAPTURE_TIMES,
      drawKeys: drawKeys(),
      finalLocalTime: instance.localTime,
      finalState: instance.state,
      impactCount: impacts().length,
      impactDiagnostics,
      panelStats,
    },
    ok: Object.values(checks).every(Boolean),
    schema: 'nachi.showcase-machina.v1',
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'showcase-machina.png', selector: '#machina-visual' },
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
