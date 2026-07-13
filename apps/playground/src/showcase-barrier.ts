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
  type TextureRef,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import { fxMaterial as meshFxMaterial, ring, uvFlow } from '@nachi/mesh-fx';
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
import { uniform } from 'three/tsl';
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
import './showcase-barrier.css';

const WIDTH = 640;
const HEIGHT = 360;
const STEP = 1 / 60;
const EFFECT_DURATION = 2.6;
const DEPLOY_TIME = 0.55;
const DOME_RADIUS = 1.6;
const DOME_GROW_DURATION = 0.4;
const SHOCK_DURATION = 0.6;
const CAPTURE_TIMES = [0.3, 0.62, 0.78, 1.1, 1.5, 2.2] as const;
const CAPTURE_LABELS = [
  'anticipation · magic circle',
  'deployment · dome snap',
  'overshoot · shock ring',
  'reinforcement · shield cells',
  'energy streams · hex shell',
  'sustain · afterglow',
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
  if (!value) throw new Error(`Missing showcase-barrier element: ${selector}`);
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
  const noise = createValueNoise(0xba17);
  return grayscaleDataTexture([128, 128], (u, v) => fbm(noise, u * 9.1, v * 9.1));
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
  if (!context) throw new Error('showcase-barrier requires a 2D canvas context.');
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
 * Tileable hexagon wireframe shell for the dome. Cell period divides the
 * canvas exactly on both axes so RepeatWrapping and uvFlow drift stay
 * seam-free. Colors are drawn into the canvas because fxMaterial `map`
 * replaces the material color.
 */
function hexShellTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x4e11);
  const width = 1024;
  const height = 512;
  const columns = 16;
  const rowPairs = 4;
  const cellWidth = width / columns;
  const periodY = height / rowPairs;
  const radius = periodY / 3;
  const texture = canvasTexture(width, height, (context) => {
    const hexPath = (cx: number, cy: number, inset: number) => {
      const w = cellWidth / 2 - inset;
      const r = radius - inset;
      context.beginPath();
      context.moveTo(cx, cy - r);
      context.lineTo(cx + w, cy - r / 2);
      context.lineTo(cx + w, cy + r / 2);
      context.lineTo(cx, cy + r);
      context.lineTo(cx - w, cy + r / 2);
      context.lineTo(cx - w, cy - r / 2);
      context.closePath();
    };
    const rows = Math.ceil(height / (radius * 1.5)) + 2;
    context.globalCompositeOperation = 'lighter';
    for (let row = -1; row <= rows; row += 1) {
      const cy = row * radius * 1.5;
      const offset = row % 2 === 0 ? 0 : cellWidth / 2;
      for (let column = -1; column <= columns; column += 1) {
        const cx = column * cellWidth + offset;
        const charge = random();
        // Sparse charged cells: faint azure fill so the shell reads as
        // discrete shield cells rather than pure wireframe.
        if (charge > 0.68) {
          hexPath(cx, cy, 5);
          context.fillStyle = `rgba(28, 92, 235, ${(0.1 + (charge - 0.68) * 0.6).toFixed(3)})`;
          context.fill();
        }
        // Wide soft under-glow pass, then the crisp saturated line pass.
        hexPath(cx, cy, 0);
        context.strokeStyle = 'rgba(30, 90, 240, 0.42)';
        context.lineWidth = 8;
        context.stroke();
        hexPath(cx, cy, 0);
        context.strokeStyle = 'rgba(46, 166, 255, 0.6)';
        context.lineWidth = 2.2;
        context.stroke();
        // Vertex nodes: azure-leaning so bloom does not wash them to white.
        context.fillStyle = 'rgba(150, 216, 255, 0.6)';
        for (const [vx, vy] of [
          [cx, cy - radius],
          [cx + cellWidth / 2, cy - radius / 2],
          [cx + cellWidth / 2, cy + radius / 2],
        ] as const) {
          context.beginPath();
          context.arc(vx, vy, 2.1, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
  });
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Azure glyph strip for the outer rune ring (u = angle, v = radial). */
function runeStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0xa213);
  return canvasTexture(1024, 96, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.strokeStyle = '#4fc8ff';
    context.lineWidth = 3;
    context.strokeRect(2, 8, 1020, 2);
    context.strokeRect(2, 86, 1020, 2);
    for (let x = 10; x < 1014; x += 24) {
      const kind = Math.floor(random() * 5);
      const cx = x + random() * 5;
      const cy = 30 + random() * 34;
      const scale = 8 + random() * 9;
      context.strokeStyle = random() > 0.34 ? '#4fc8ff' : '#dff4ff';
      context.lineWidth = 1.6 + random() * 1.6;
      context.beginPath();
      if (kind === 0) {
        // Angular wedge chevron.
        context.moveTo(cx - scale * 0.6, cy + scale * 0.6);
        context.lineTo(cx, cy - scale * 0.7);
        context.lineTo(cx + scale * 0.6, cy + scale * 0.6);
      } else if (kind === 1) {
        context.moveTo(cx, cy - scale * 0.7);
        context.lineTo(cx + scale * 0.6, cy + scale * 0.5);
        context.lineTo(cx - scale * 0.6, cy + scale * 0.5);
        context.closePath();
      } else if (kind === 2) {
        // Split wedge column.
        context.moveTo(cx - scale * 0.4, cy - scale * 0.8);
        context.lineTo(cx - scale * 0.4, cy + scale * 0.8);
        context.moveTo(cx + scale * 0.4, cy - scale * 0.5);
        context.lineTo(cx + scale * 0.4, cy + scale * 0.5);
      } else if (kind === 3) {
        context.moveTo(cx, cy - scale * 0.7);
        context.lineTo(cx + scale * 0.55, cy);
        context.lineTo(cx, cy + scale * 0.7);
        context.lineTo(cx - scale * 0.55, cy);
        context.closePath();
      } else {
        // Notched bracket.
        context.moveTo(cx + scale * 0.5, cy - scale * 0.7);
        context.lineTo(cx - scale * 0.3, cy - scale * 0.7);
        context.lineTo(cx - scale * 0.3, cy + scale * 0.7);
        context.lineTo(cx + scale * 0.5, cy + scale * 0.7);
      }
      context.stroke();
    }
  });
}

/** White-cyan tick dashes for the counter-rotating inner ring. */
function tickStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x71c6);
  return canvasTexture(512, 48, (context) => {
    context.globalCompositeOperation = 'lighter';
    for (let x = 0; x < 512; x += 14) {
      const tall = random() > 0.66;
      context.fillStyle = tall ? '#eafcff' : '#4fc8ff';
      context.fillRect(x + 3, tall ? 8 : 17, tall ? 3 : 7, tall ? 32 : 14);
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

/** Plain soft radial glow for motes and streams. */
function glowSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    return Math.exp(-(x * x + y * y) * 5.5);
  });
}

/** Hexagon outline glint used by the shield-cell twinkles. */
function hexCellSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = (u * 2 - 1) * 1.15;
    const y = (v * 2 - 1) * 1.15;
    const qx = Math.abs(x);
    const qy = Math.abs(y);
    const distance = Math.max(qx * 0.866025 + qy * 0.5, qy) - 0.82;
    const outline = Math.exp(-distance * distance * 220);
    const core = Math.exp(-(x * x + y * y) * 3.2) * 0.55;
    return Math.min(1, outline + core);
  });
}

// ---------------------------------------------------------------------------
// Effect authoring.
// ---------------------------------------------------------------------------

const SPARK_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-barrier/spark',
};
const GLOW_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-barrier/glow',
};
const HEX_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-barrier/hexcell',
};

interface EffectTextures {
  readonly noise: THREE.Texture;
  readonly runes: THREE.Texture;
  readonly ticks: THREE.Texture;
}

function createBarrierEffect(textures: EffectTextures, loop: boolean) {
  const motes = defineEmitter({
    capacity: 320,
    init: [
      positionSphere({ radius: 2.7, surfaceOnly: true }),
      lifetime(range(0.4, 0.62)),
    ],
    render: billboard({
      alignment: { factor: 0.75, mode: 'velocity-stretch' },
      blending: 'additive',
      map: GLOW_REF,
    }),
    spawn: burst({ count: 72, cycles: 4, interval: 0.1 }),
    update: [
      pointAttractor({ falloff: 1, position: [0, 0.4, 0], strength: 30 }),
      drag(0.45),
      sizeOverLife(curve([0, 0.016], [0.4, 0.09], [1, 0.018])),
      colorOverLife(gradient('#eaffff', '#4fc8ff', '#2b6fff00')),
    ],
  });
  const coreGlow = defineEmitter({
    capacity: 4,
    init: [positionSphere({ radius: 0.04 }), lifetime(0.5)],
    integration: 'none',
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 2 }),
    update: [
      sizeOverLife(curve([0, 0.06], [0.7, 0.7], [1, 1.15])),
      colorOverLife(gradient('#0c2a5a', '#2b6fff', '#bfe9ff')),
    ],
  });
  // Persistent faint interior luminance so the dome does not read as a hollow
  // black shell after deployment.
  const domeCore = defineEmitter({
    capacity: 4,
    init: [positionSphere({ radius: 0.05 }), lifetime(2.0)],
    integration: 'none',
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 2 }),
    update: [
      sizeOverLife(curve([0, 0.4], [0.12, 1.6], [0.85, 1.45], [1, 0.7])),
      colorOverLife(gradient('#1c4d8f', '#16406e', '#0e2c5400')),
    ],
  });
  const deployBurst = defineEmitter({
    capacity: 180,
    init: [
      positionSphere({ radius: 0.12 }),
      velocityCone({ angle: 80, direction: [0, 1, 0], speed: range(3, 8.5) }),
      lifetime(range(0.3, 0.7)),
    ],
    render: billboard({
      alignment: { factor: 0.6, mode: 'velocity-stretch' },
      blending: 'additive',
      map: SPARK_REF,
    }),
    spawn: burst({ count: 130 }),
    update: [
      gravity([0, -7.5, 0]),
      drag(1.1),
      collidePlane({ bounce: 0.4, friction: 0.3, mode: 'bounce', normal: [0, 1, 0], offset: 0.03 }),
      sizeOverLife(curve([0, 0.055], [0.4, 0.028], [1, 0.004])),
      colorOverLife(gradient('#ffffff', '#bfe9ff', '#4fc8ff', '#2b6fff00')),
    ],
  });
  const flash = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.4), lightIntensity(16)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 24], [0.25, 8], [1, 0])),
      colorOverLife(gradient('#ffffff', '#7fd8ff')),
    ],
  });
  const shieldCells = defineEmitter({
    capacity: 460,
    init: [
      positionSphere({ radius: DOME_RADIUS + 0.05, surfaceOnly: true }),
      lifetime(range(0.3, 0.6)),
    ],
    integration: 'none',
    render: billboard({ blending: 'additive', map: HEX_REF }),
    spawn: burst({ count: 40, cycles: 9, interval: 0.1 }),
    update: [
      sizeOverLife(curve([0, 0.02], [0.4, 0.42], [1, 0.02])),
      colorOverLife(gradient('#ffffff', '#bfe9ff', '#4fc8ff00')),
    ],
  });
  const streams = defineEmitter({
    capacity: 380,
    init: [
      positionSphere({ radius: DOME_RADIUS - 0.06, surfaceOnly: true }),
      velocityCone({ angle: 22, direction: [0, 1, 0], speed: range(0.5, 1.15) }),
      lifetime(range(0.6, 1.05)),
    ],
    render: billboard({
      alignment: { factor: 0.9, mode: 'velocity-stretch' },
      blending: 'additive',
      map: GLOW_REF,
    }),
    spawn: burst({ count: 30, cycles: 11, interval: 0.1 }),
    update: [
      pointAttractor({ falloff: 1, position: [0, 2.2, 0], strength: 5.5 }),
      drag(1.0),
      sizeOverLife(curve([0, 0.016], [0.4, 0.13], [1, 0])),
      colorOverLife(gradient('#ffffff', '#5fc8ff', '#9a6cff00')),
    ],
  });
  const driftMotes = defineEmitter({
    capacity: 220,
    init: [positionSphere({ radius: 1.9 }), lifetime(range(0.8, 1.3))],
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 26, cycles: 6, interval: 0.15 }),
    update: [
      curlNoise({ frequency: 1.1, strength: 0.9 }),
      gravity([0, 0.35, 0]),
      drag(1.2),
      sizeOverLife(curve([0, 0], [0.3, 0.12], [1, 0])),
      colorOverLife(gradient('#bfaaff', '#8f7dff', '#6a4dff00')),
    ],
  });

  const circleFillMesh = ring({
    innerRadius: 0.05,
    material: fxMaterial({
      blending: 'additive',
      color: '#2b6fff',
      dissolve: {
        edgeColor: '#4fc8ff',
        edgeWidth: 0.05,
        overLife: curve([0, 1], [0.14, 0.2], [0.6, 0.24], [0.9, 0.6], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.26,
    }),
    outerRadius: 1.12,
    segments: 96,
  });
  circleFillMesh.name = 'barrier-circle-fill';
  circleFillMesh.rotation.x = -Math.PI / 2;
  circleFillMesh.position.y = 0.01;
  const circleOuterMesh = ring({
    innerRadius: 1.78,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#9fdcff',
        edgeWidth: 0.04,
        overLife: curve([0, 1], [0.09, 0.05], [0.62, 0.09], [0.9, 0.5], [1, 1]),
        texture: textures.noise,
      },
      map: textures.runes,
      opacity: 0.9,
      uv: uvFlow({ speed: [0.07, 0] }),
    }),
    outerRadius: 2.16,
    segments: 128,
  });
  circleOuterMesh.name = 'barrier-circle-outer';
  circleOuterMesh.rotation.x = -Math.PI / 2;
  circleOuterMesh.position.y = 0.02;
  const circleInnerMesh = ring({
    innerRadius: 1.16,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#9fdcff',
        edgeWidth: 0.04,
        overLife: curve([0, 1], [0.12, 0.07], [0.6, 0.1], [0.9, 0.52], [1, 1]),
        texture: textures.noise,
      },
      map: textures.ticks,
      opacity: 0.85,
      uv: uvFlow({ speed: [-0.13, 0] }),
    }),
    outerRadius: 1.44,
    segments: 128,
  });
  circleInnerMesh.name = 'barrier-circle-inner';
  circleInnerMesh.rotation.x = -Math.PI / 2;
  circleInnerMesh.position.y = 0.015;

  // Sealed base rim: a thin bright ring that snaps in with the dome and stays
  // for the whole hold, anchoring the hemisphere to the ground.
  const baseRimMesh = ring({
    innerRadius: DOME_RADIUS - 0.05,
    material: fxMaterial({
      blending: 'additive',
      color: '#4fc8ff',
      dissolve: {
        edgeColor: '#eafcff',
        edgeWidth: 0.05,
        overLife: curve([0, 0.9], [0.06, 0.08], [0.85, 0.14], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.85,
    }),
    outerRadius: DOME_RADIUS + 0.07,
    segments: 128,
  });
  baseRimMesh.name = 'barrier-base-rim';
  baseRimMesh.rotation.x = -Math.PI / 2;
  baseRimMesh.position.y = 0.03;

  const shockMesh = ring({
    innerRadius: 0.86,
    material: fxMaterial({
      blending: 'additive',
      color: '#7fd8ff',
      dissolve: {
        edgeColor: '#eafcff',
        edgeWidth: 0.05,
        overLife: curve([0, 0.08], [0.5, 0.38], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.5,
    }),
    outerRadius: 1.0,
    segments: 96,
  });
  shockMesh.name = 'barrier-shock';
  // Keep the offset baked because clone scale animates the expanding shock.
  shockMesh.geometry.rotateX(-Math.PI / 2);
  shockMesh.geometry.translate(0, 0.04, 0);

  return defineEffect({
    elements: {
      baseRim: meshFxElement(baseRimMesh, { duration: EFFECT_DURATION - DEPLOY_TIME }),
      circleFill: meshFxElement(circleFillMesh, { duration: EFFECT_DURATION }),
      circleInner: meshFxElement(circleInnerMesh, { duration: EFFECT_DURATION }),
      circleOuter: meshFxElement(circleOuterMesh, { duration: EFFECT_DURATION }),
      coreGlow,
      deployBurst,
      domeCore,
      driftMotes,
      flash,
      motes,
      shieldCells,
      shock: meshFxElement(shockMesh, { duration: SHOCK_DURATION }),
      streams,
    },
    timeline: timeline(
      [
        at(0, play('circleOuter'), play('circleInner'), play('circleFill'), marker('anticipation')),
        at(0.05, play('motes'), play('coreGlow')),
        at(
          DEPLOY_TIME,
          play('flash'),
          play('deployBurst'),
          play('shock'),
          play('domeCore'),
          play('baseRim'),
          cameraShake({ duration: 0.35, frequency: 28, strength: 0.3 }),
          marker('deploy'),
        ),
        at(0.6, hitStop(50)),
        at(0.72, play('shieldCells'), marker('reinforce')),
        at(0.78, play('streams')),
        at(1.6, play('driftMotes'), marker('sustain')),
      ],
      { duration: EFFECT_DURATION, ...(loop ? { loop: true } : {}) },
    ),
  });
}

// ---------------------------------------------------------------------------
// Choreography helpers.
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Ease-out with a mild elastic-style overshoot for the dome snap. */
function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
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
  if (!backend.isWebGPUBackend) throw new Error('Aegis barrier requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  required<HTMLElement>('#mode-value').textContent = headless
    ? 'headless keyframe capture'
    : 'live loop';

  const textures: EffectTextures = {
    noise: noiseTexture(),
    runes: runeStripTexture(),
    ticks: tickStripTexture(),
  };
  const spark = sparkSpriteTexture();
  const glow = glowSpriteTexture();
  const hexCell = hexCellSpriteTexture();
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [SPARK_REF.uri, spark],
      [GLOW_REF.uri, glow],
      [HEX_REF.uri, hexCell],
    ]),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02040c);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardNodeMaterial({ color: 0x0d1830, metalness: 0.25, roughness: 0.52 }),
  );
  ground.rotation.x = -Math.PI / 2;
  const pool = new THREE.PointLight(0x2e5fbf, 26, 0, 2);
  pool.position.set(0, 3.2, 0);
  scene.add(ground, new THREE.HemisphereLight(0x4a6f9f, 0x060a14, 1.1), pool);

  // The hero: a self-managed hemispherical energy dome. It is deliberately not
  // a timeline element — scale, dissolve life, uv time, and fresnel breathing
  // are all driven per-frame from the page loop.
  const domeBreath = uniform(2.55);
  const domeMaterial = meshFxMaterial({
    blending: 'additive',
    dissolve: {
      edgeColor: '#9fdcff',
      edgeWidth: 0.07,
      overLife: [
        [0, 1],
        [0.07, 0],
        [0.5, 0.06],
        [0.88, 0],
        [1, 1],
      ],
      texture: textures.noise,
    },
    fresnel: { color: '#a8a4ff', power: domeBreath },
    map: hexShellTexture(),
    opacity: 0.85,
    uv: uvFlow({ speed: [0.02, 0.006] }),
  });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(DOME_RADIUS, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    domeMaterial,
  );
  dome.name = 'barrier-dome';
  dome.visible = false;
  scene.add(dome);

  const camera = new THREE.PerspectiveCamera(42, WIDTH / HEIGHT, 0.1, 40);
  const cameraBasePosition = new THREE.Vector3(2.9, 2.05, 5.1);
  camera.position.copy(cameraBasePosition);
  camera.lookAt(0, 0.72, 0);
  const cameraBaseRotation = camera.rotation.clone();

  const projected = new THREE.Vector3(0, 0.85, 0).project(camera);
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
  const effect = createBarrierEffect(textures, !headless);
  const instance = system.spawn(effect, { position: [0, 0, 0], seed: 0xba21 });

  const actions: Array<{ kind: string; localTime: number; target?: string }> = [];
  const markers: string[] = [];
  const playedEmitters = new Map<string, VfxEmitterRuntimeView>();
  instance.onAction(({ action, emitter, localTime }) => {
    const target = 'target' in action ? action.target : undefined;
    actions.push({ kind: action.kind, localTime, ...(target === undefined ? {} : { target }) });
    if (action.kind === 'play' && target !== undefined && emitter !== undefined) {
      playedEmitters.set(target, emitter);
    }
  });
  for (const name of ['anticipation', 'deploy', 'reinforce', 'sustain']) {
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
          duration: 0.8,
          radius: 0.02,
          ringWidth: 0.15,
          speed: 0.9,
          startTime: DEPLOY_TIME,
          strength: 0.05,
        },
      ],
    }),
  });

  const localNow = () => instance.localTime % EFFECT_DURATION;

  // Sub-stepping mirrors the other showcase pages: every particle spawned in
  // one frame lands on a consistent simulation cadence.
  const SUBSTEPS = 4;
  const step = async (delta: number) => {
    for (let subStep = 0; subStep < SUBSTEPS; subStep += 1) {
      await system.update(delta / SUBSTEPS);
    }
    materializeNewDraws();
    if (lightDraw) await lightDraw.update(renderer);
    const local = localNow();
    const grow = clamp01((local - DEPLOY_TIME) / DOME_GROW_DURATION);
    dome.visible = local >= DEPLOY_TIME;
    dome.scale.setScalar(Math.max(0.001, 0.2 + 0.8 * easeOutBack(grow)));
    domeMaterial.fx.setNormalizedLife(
      clamp01((local - DEPLOY_TIME) / (EFFECT_DURATION - DEPLOY_TIME)),
    );
    domeMaterial.fx.setTime(local);
    domeBreath.value = 2.55 + Math.sin(Math.max(0, local - 0.95) * 4.2) * 0.5;
    const shockState = instance.getElementState('shock');
    const shockClone = findMeshFx('barrier-shock');
    if (shockClone && shockState?.playing) {
      const q = Math.min(1, shockState.localTime / SHOCK_DURATION);
      const scale = 0.35 + 3.0 * (1 - (1 - q) ** 3);
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
    post.controls.setTime(local);
  };

  if (headless) {
    // Short warmed GPU sample window for the nachi.perf-baseline record. It
    // respawns the effect so compute work is still in flight while sampling.
    const perfWindow = async () => {
      system.spawn(effect, { position: [0, 0, 0], seed: 0xba22 });
      const perfTarget = new THREE.RenderTarget(96, 64, { depthBuffer: true });
      const monitor = createPerformanceMonitor(renderer, {
        gpuScopes: ['compute', 'render'],
        mode: 'headless',
        page: 'showcase-barrier',
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
  // loops itself and the dome restarts with each cycle's local clock.
  required<HTMLCanvasElement>('#barrier-visual').style.display = 'none';
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
  required<HTMLElement>('#status-value').textContent = 'looping · watch the deployment';
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
    'baseRim',
    'circleFill',
    'circleInner',
    'circleOuter',
    'coreGlow',
    'deployBurst',
    'domeCore',
    'driftMotes',
    'flash',
    'motes',
    'shieldCells',
    'shock',
    'streams',
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
  for (let frame = 0; frame < 150; frame += 1) {
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

  const canvas = required<HTMLCanvasElement>('#barrier-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('showcase-barrier requires the contact sheet canvas.');
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
  const deploy = panelStats[1] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const shell = panelStats[4] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const sustain = panelStats[5] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const checks = {
    allFramesCaptured: captures.length === CAPTURE_TIMES.length,
    consoleClean: consoleMessages.length === 0,
    deployVisible: deploy.foregroundRatio > 0.035 && deploy.saturatedRatio < 0.3,
    domeVisible: shell.foregroundRatio > 0.05 && shell.saturatedRatio < 0.25,
    stateHealthy: instance.state !== 'error',
    sustainVisible: sustain.foregroundRatio > 0.02 && sustain.saturatedRatio < 0.2,
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
    schema: 'nachi.showcase-barrier.v1',
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'showcase-barrier.png', selector: '#barrier-visual' },
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
