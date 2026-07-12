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
  rate,
  sizeOverLife,
  velocityCone,
  VFXSystem as CoreVFXSystem,
  type TextureRef,
  type Vec3,
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
import './showcase-beam.css';

const WIDTH = 640;
const HEIGHT = 360;
const STEP = 1 / 60;
const EFFECT_DURATION = 2.6;
const FIRE_TIME = 0.7;
const IMPACT_START = FIRE_TIME + 0.075;
const CUTOFF_TIME = 1.7;
const BEAM_LENGTH = 4.6;
const HEADLESS_FRAMES = 172;
const MUZZLE_POSITION: Vec3 = [-2.3, 0.1, 0];
const IMPACT_POSITION: Vec3 = [2.3, 0, 0];
const CAPTURE_TIMES = [0.62, 0.73, 0.95, 1.38, 1.78, 2.18] as const;
const CAPTURE_LABELS = [
  'charge · plasma converge',
  'fire · lance extension',
  'impact · blowback spray',
  'sustain · width pulse',
  'cutoff · residual trail',
  'afterglow · crater embers',
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
  if (!value) throw new Error(`Missing showcase-beam element: ${selector}`);
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

/** Tiling fbm used by the noise dissolves (sheath, rings, circle). */
function noiseTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x6b3a);
  return grayscaleDataTexture([128, 128], (u, v) => fbm(noise, u * 8.7, v * 8.7));
}

/**
 * Beam extension ramp: bright at the caster end (v = 0) so a falling dissolve
 * threshold reveals the lance caster-first, sweeping toward the enemy.
 */
function beamRampTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x3e11);
  const texture = grayscaleDataTexture(
    [64, 256],
    (u, v) => 0.2 + (1 - v) * 0.72 + fbm(noise, u * 5, v * 11) * 0.06,
  );
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/**
 * Residual trail ramp: dark at the caster end so a rising threshold erodes
 * the ionized trail caster-first after the beam snaps off.
 */
function residualRampTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x51ce);
  const texture = grayscaleDataTexture(
    [64, 256],
    (u, v) => 0.1 + v * 0.6 + fbm(noise, u * 6, v * 9) * 0.24,
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
  if (!context) throw new Error('showcase-beam requires a 2D canvas context.');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** White-hot inner core: uniform around the circumference, soft ends. */
function beamCoreTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 512, (context) => {
    const body = context.createLinearGradient(0, 0, 0, 512);
    body.addColorStop(0, 'rgba(0,0,0,0)');
    body.addColorStop(0.05, '#f2e6ff');
    body.addColorStop(0.12, '#ffffff');
    body.addColorStop(0.88, '#ffffff');
    body.addColorStop(0.95, '#f2e6ff');
    body.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = body;
    context.fillRect(0, 0, 64, 512);
  });
}

/**
 * Soft violet aura for the outer glow shell: brightness follows sin(2*pi*u)
 * around the circumference so the projected tube fades out at its silhouette
 * edges (u = 0 and u = 0.5) instead of reading as a flat ribbon.
 */
function glowShellTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 512, (context) => {
    context.fillStyle = '#8f4be0';
    context.fillRect(0, 0, 128, 512);
    context.globalCompositeOperation = 'multiply';
    const falloff = context.createLinearGradient(0, 0, 128, 0);
    falloff.addColorStop(0, '#000');
    falloff.addColorStop(0.06, '#333');
    falloff.addColorStop(0.14, '#999');
    falloff.addColorStop(0.25, '#fff');
    falloff.addColorStop(0.36, '#999');
    falloff.addColorStop(0.44, '#333');
    falloff.addColorStop(0.5, '#000');
    falloff.addColorStop(1, '#000');
    context.fillStyle = falloff;
    context.fillRect(0, 0, 128, 512);
    const ends = context.createLinearGradient(0, 0, 0, 512);
    ends.addColorStop(0, '#000');
    ends.addColorStop(0.07, '#fff');
    ends.addColorStop(0.93, '#fff');
    ends.addColorStop(1, '#000');
    context.fillStyle = ends;
    context.fillRect(0, 0, 128, 512);
  });
}

/**
 * Violet plasma sheath: streaks run along the beam axis (canvas y = UV v) and
 * wrap vertically so the fast uvFlow scroll tiles seamlessly.
 */
function sheathTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x5ea7);
  const texture = canvasTexture(128, 512, (context) => {
    context.fillStyle = 'rgb(122,42,170)';
    context.fillRect(0, 0, 128, 512);
    context.globalCompositeOperation = 'lighter';
    for (let index = 0; index < 96; index += 1) {
      const x = random() * 128;
      const y = random() * 512;
      const length = 50 + random() * 220;
      const pick = random();
      context.strokeStyle = pick > 0.86 ? '#ffffff' : pick > 0.46 ? '#ff5fd0' : '#c86bff';
      context.globalAlpha = 0.2 + random() * 0.55;
      context.lineWidth = 0.8 + random() * 3;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x, y + length);
      context.stroke();
      if (y + length > 512) {
        context.beginPath();
        context.moveTo(x, y - 512);
        context.lineTo(x, y - 512 + length);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'multiply';
    const falloff = context.createLinearGradient(0, 0, 128, 0);
    falloff.addColorStop(0, '#000');
    falloff.addColorStop(0.05, '#888');
    falloff.addColorStop(0.25, '#fff');
    falloff.addColorStop(0.45, '#888');
    falloff.addColorStop(0.5, '#000');
    falloff.addColorStop(1, '#000');
    context.fillStyle = falloff;
    context.fillRect(0, 0, 128, 512);
  });
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Violet glyph strip mapped onto the vertical charge circle (u = angle). */
function glyphStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x91f7);
  return canvasTexture(1024, 96, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.strokeStyle = '#c86bff';
    context.lineWidth = 3;
    context.strokeRect(2, 8, 1020, 2);
    context.strokeRect(2, 86, 1020, 2);
    for (let x = 12; x < 1012; x += 26) {
      const kind = Math.floor(random() * 5);
      const cx = x + random() * 6;
      const cy = 30 + random() * 34;
      const scale = 8 + random() * 9;
      const pick = random();
      context.strokeStyle = pick > 0.72 ? '#6be0ff' : pick > 0.3 ? '#c86bff' : '#efe0ff';
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

/** Cyan tick dashes for the counter-rotating inner charge ring. */
function tickStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x7cc1);
  return canvasTexture(512, 48, (context) => {
    context.globalCompositeOperation = 'lighter';
    for (let x = 0; x < 512; x += 16) {
      const tall = random() > 0.62;
      context.fillStyle = tall ? '#d8f6ff' : '#6be0ff';
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

/** Plain soft radial glow for orbs, motes, and embers. */
function glowSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    return Math.exp(-(x * x + y * y) * 5.5);
  });
}

/** Eight-point star flare for the muzzle flash. */
function starSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([96, 96], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const radius = Math.hypot(x, y);
    const glow = Math.exp(-radius * radius * 5.5);
    const cross =
      Math.exp(-Math.abs(x) * 16) * Math.exp(-Math.abs(y) * 1.5) +
      Math.exp(-Math.abs(y) * 16) * Math.exp(-Math.abs(x) * 1.5);
    const diagonal =
      Math.exp(-Math.abs(x - y) * 12) * Math.exp(-radius * 2.4) +
      Math.exp(-Math.abs(x + y) * 12) * Math.exp(-radius * 2.4);
    return glow + cross * 0.8 + diagonal * 0.4;
  });
}

// ---------------------------------------------------------------------------
// Effect authoring.
// ---------------------------------------------------------------------------

const GLOW_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-beam/glow',
};
const SPARK_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-beam/spark',
};
const STAR_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://showcase-beam/star',
};

interface EffectTextures {
  readonly beamCore: THREE.Texture;
  readonly glowShell: THREE.Texture;
  readonly glyphs: THREE.Texture;
  readonly noise: THREE.Texture;
  readonly ramp: THREE.Texture;
  readonly residualRamp: THREE.Texture;
  readonly sheath: THREE.Texture;
  readonly ticks: THREE.Texture;
}

/**
 * Timeline effect: the beam itself plus the caster circle and both shock
 * rings. All static placement is baked into the geometry because the timeline
 * runtime overwrites clone position/quaternion with the effect transform.
 */
function createPlasmaLance(textures: EffectTextures, loop: boolean) {
  const beamCoreMesh = cylinder({
    height: BEAM_LENGTH,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#fff0ff',
        edgeWidth: 0.05,
        overLife: curve([0, 1], [0.075, 0.04], [0.94, 0.06], [1, 1]),
        texture: textures.ramp,
      },
      map: textures.beamCore,
    }),
    radialSegments: 40,
    radius: 0.13,
  });
  beamCoreMesh.name = 'beam-core';
  // rotateZ(-PI/2) lays the cylinder along +X with UV v = 0 at the caster, so
  // the V-ramp dissolve sweeps caster -> enemy and uvFlow scrolls the same axis.
  beamCoreMesh.geometry.rotateZ(-Math.PI / 2);
  beamCoreMesh.geometry.translate(0, 0.05, 0);

  const beamSheathMesh = cylinder({
    height: BEAM_LENGTH,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#ff5fd0',
        edgeWidth: 0.09,
        overLife: curve([0, 1], [0.05, 0.1], [0.93, 0.14], [1, 1]),
        texture: textures.noise,
      },
      map: textures.sheath,
      opacity: 0.95,
      uv: uvFlow({ speed: [0, -3.2] }),
    }),
    radialSegments: 48,
    radius: 0.3,
  });
  beamSheathMesh.name = 'beam-sheath';
  beamSheathMesh.geometry.rotateZ(-Math.PI / 2);
  beamSheathMesh.geometry.translate(0, 0.05, 0);

  const beamGlowMesh = cylinder({
    height: BEAM_LENGTH,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#6a35c8',
        edgeWidth: 0.015,
        overLife: curve([0, 1], [0.06, 0.05], [0.92, 0.07], [1, 1]),
        texture: textures.ramp,
      },
      map: textures.glowShell,
      opacity: 0.5,
    }),
    radialSegments: 48,
    radius: 0.5,
  });
  beamGlowMesh.name = 'beam-glow';
  beamGlowMesh.geometry.rotateZ(-Math.PI / 2);
  beamGlowMesh.geometry.translate(0, 0.05, 0);

  const beamResidualMesh = cylinder({
    height: BEAM_LENGTH,
    material: fxMaterial({
      blending: 'additive',
      color: '#b39aff',
      dissolve: {
        edgeColor: '#ff9df0',
        edgeWidth: 0.07,
        overLife: curve([0, 0.42], [0.3, 0.56], [1, 1]),
        texture: textures.residualRamp,
      },
      opacity: 0.75,
    }),
    radialSegments: 32,
    radius: 0.06,
  });
  beamResidualMesh.name = 'beam-residual';
  beamResidualMesh.geometry.rotateZ(-Math.PI / 2);
  beamResidualMesh.geometry.translate(0, 0.05, 0);

  const circleGlyphsMesh = ring({
    innerRadius: 0.62,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#e8d4ff',
        edgeWidth: 0.08,
        overLife: curve([0, 1], [0.06, 0.07], [0.68, 0.1], [1, 1]),
        texture: textures.noise,
      },
      map: textures.glyphs,
      opacity: 0.9,
      uv: uvFlow({ speed: [0.22, 0] }),
    }),
    outerRadius: 0.95,
    segments: 96,
  });
  circleGlyphsMesh.name = 'beam-circle-glyphs';
  // Vertical magic circle facing the enemy: XY ring plane rotated into YZ.
  circleGlyphsMesh.geometry.rotateY(Math.PI / 2);
  circleGlyphsMesh.geometry.translate(-2.3, 0.1, 0);

  const circleTicksMesh = ring({
    innerRadius: 0.4,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#d8f6ff',
        edgeWidth: 0.08,
        overLife: curve([0, 1], [0.08, 0.08], [0.66, 0.12], [1, 1]),
        texture: textures.noise,
      },
      map: textures.ticks,
      opacity: 0.8,
      uv: uvFlow({ speed: [-0.4, 0] }),
    }),
    outerRadius: 0.52,
    segments: 96,
  });
  circleTicksMesh.name = 'beam-circle-ticks';
  circleTicksMesh.geometry.rotateY(Math.PI / 2);
  circleTicksMesh.geometry.translate(-2.3, 0.1, 0);

  const muzzleRingMesh = ring({
    innerRadius: 0.55,
    material: fxMaterial({
      blending: 'additive',
      color: '#6be0ff',
      dissolve: {
        edgeColor: '#d8f6ff',
        edgeWidth: 0.06,
        overLife: curve([0, 0.1], [0.5, 0.3], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.75,
    }),
    outerRadius: 0.66,
    segments: 80,
  });
  muzzleRingMesh.name = 'beam-muzzle-ring';
  muzzleRingMesh.geometry.rotateY(Math.PI / 2);
  muzzleRingMesh.geometry.translate(-2.3, 0.1, 0);

  const impactRingMesh = ring({
    innerRadius: 0.9,
    material: fxMaterial({
      blending: 'additive',
      color: '#ff5fd0',
      dissolve: {
        edgeColor: '#ffd9fa',
        edgeWidth: 0.06,
        overLife: curve([0, 0.12], [0.6, 0.5], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.5,
    }),
    outerRadius: 1,
    segments: 96,
  });
  impactRingMesh.name = 'beam-impact-ring';
  // Faces -X so the camera-side front face stays visible at the enemy end.
  impactRingMesh.geometry.rotateY(-Math.PI / 2);
  impactRingMesh.geometry.translate(2.3, 0, 0);

  return defineEffect({
    elements: {
      beamCore: meshFxElement(beamCoreMesh, { duration: 1.06 }),
      beamGlow: meshFxElement(beamGlowMesh, { duration: 1.08 }),
      beamResidual: meshFxElement(beamResidualMesh, { duration: 0.75 }),
      beamSheath: meshFxElement(beamSheathMesh, { duration: 1.0 }),
      circleGlyphs: meshFxElement(circleGlyphsMesh, { duration: 2.5 }),
      circleTicks: meshFxElement(circleTicksMesh, { duration: 2.5 }),
      impactRing: meshFxElement(impactRingMesh, { duration: 0.45 }),
      muzzleRing: meshFxElement(muzzleRingMesh, { duration: 0.35 }),
    },
    timeline: timeline(
      [
        at(0.02, play('circleGlyphs'), play('circleTicks'), marker('charge')),
        at(
          FIRE_TIME,
          play('beamCore'),
          play('beamGlow'),
          play('muzzleRing'),
          cameraShake({ duration: 0.42, frequency: 30, strength: 0.5 }),
          marker('fire'),
        ),
        at(FIRE_TIME + 0.03, hitStop(70)),
        // The sheath wraps the core just after the extension sweep finishes,
        // so the lance front stays a clean ramp reveal instead of noise blobs.
        at(FIRE_TIME + 0.06, play('beamSheath')),
        at(FIRE_TIME + 0.08, play('impactRing')),
        at(0.95, cameraShake({ duration: 0.55, frequency: 13, strength: 0.07 })),
        at(
          CUTOFF_TIME,
          play('beamResidual'),
          cameraShake({ duration: 0.25, frequency: 18, strength: 0.09 }),
          marker('cutoff'),
        ),
      ],
      { duration: EFFECT_DURATION, ...(loop ? { loop: true } : {}) },
    ),
  });
}

/** Caster-side charge: converging streaks, pulsing orb, motes, build light. */
function createChargeEffect() {
  const glowLight = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.74), lightIntensity(2)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 0], [0.55, 5], [0.94, 15], [1, 3])),
      colorOverLife(gradient('#6be0ff', '#c86bff', '#f2e2ff')),
    ],
  });
  const inflow = defineEmitter({
    capacity: 260,
    init: [
      positionSphere({ radius: 1.35, surfaceOnly: true }),
      velocityCone({ angle: 80, direction: [0, 1, 0], speed: range(0.3, 0.8) }),
      lifetime(range(0.3, 0.45)),
    ],
    lifecycle: { duration: 0.6 },
    render: billboard({
      alignment: { factor: 0.55, mode: 'velocity-stretch' },
      blending: 'additive',
      map: GLOW_REF,
    }),
    // rate() instead of cycled bursts: burst cycles that overlap particle deaths
    // render nothing in a core system (library bug found during this page).
    spawn: rate(210),
    update: [
      // pointAttractor position is simulation-space: target the muzzle, not [0,0,0].
      pointAttractor({ falloff: 1, position: [-2.3, 0.1, 0], strength: 30 }),
      drag(0.5),
      sizeOverLife(curve([0, 0.07], [0.5, 0.17], [1, 0.03])),
      colorOverLife(gradient('#ffffff', '#e8fbff', '#8ce8ff', '#c86bff00')),
    ],
  });
  const motes = defineEmitter({
    capacity: 70,
    init: [
      positionSphere({ radius: 0.55 }),
      velocityCone({ angle: 55, direction: [0, 1, 0], speed: range(0.25, 0.7) }),
      lifetime(range(0.45, 0.8)),
    ],
    lifecycle: { duration: 0.62 },
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: rate(48),
    update: [
      curlNoise({ frequency: 2.1, strength: 0.7 }),
      drag(1.1),
      sizeOverLife(curve([0, 0.015], [0.3, 0.09], [1, 0])),
      colorOverLife(gradient('#bfeaff', '#6be0ff', '#7a3fd600')),
    ],
  });
  const orb = defineEmitter({
    capacity: 6,
    init: [positionSphere({ radius: 0.02 }), lifetime(0.7)],
    integration: 'none',
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 4 }),
    update: [
      sizeOverLife(
        curve(
          [0, 0.04],
          [0.22, 0.34],
          [0.38, 0.26],
          [0.58, 0.52],
          [0.74, 0.42],
          [0.92, 0.72],
          [1, 0.05],
        ),
      ),
      colorOverLife(gradient('#ffffff', '#e8c8ff', '#c86bff', '#ff5fd0')),
    ],
  });
  return defineEffect({ elements: { glowLight, inflow, motes, orb } });
}

/** Muzzle flash at fire: star burst, forward spark spray, flash light. */
function createFlashEffect() {
  const flashLight = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.42), lightIntensity(20)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 34], [0.3, 11], [1, 0])),
      colorOverLife(gradient('#ffffff', '#e0b3ff')),
    ],
  });
  const sparks = defineEmitter({
    capacity: 70,
    init: [
      positionSphere({ radius: 0.05 }),
      velocityCone({ angle: 36, direction: [1, 0.22, 0], speed: range(2.5, 8) }),
      lifetime(range(0.15, 0.4)),
    ],
    render: billboard({
      alignment: { factor: 0.6, mode: 'velocity-stretch' },
      blending: 'additive',
      map: SPARK_REF,
    }),
    spawn: burst({ count: 48 }),
    update: [
      gravity([0, -3, 0]),
      drag(1.6),
      sizeOverLife(curve([0, 0.045], [0.4, 0.025], [1, 0.003])),
      colorOverLife(gradient('#ffffff', '#d8f6ff', '#c86bff00')),
    ],
  });
  const star = defineEmitter({
    capacity: 4,
    init: [positionSphere({ radius: 0.01 }), lifetime(0.26)],
    integration: 'none',
    render: billboard({ blending: 'additive', map: STAR_REF }),
    spawn: burst({ count: 2 }),
    update: [
      sizeOverLife(curve([0, 0.4], [0.18, 1.6], [1, 0.03])),
      colorOverLife(gradient('#ffffff', '#ffd6ff', '#c86bff00')),
    ],
  });
  return defineEffect({ elements: { flashLight, sparks, star } });
}

/** Enemy-side sustained impact: backward spark spray, embers, flare light. */
function createImpactEffect() {
  const chunks = defineEmitter({
    capacity: 100,
    init: [
      positionSphere({ radius: 0.1 }),
      velocityCone({ angle: 65, direction: [-0.55, 0.85, 0], speed: range(1.2, 3.8) }),
      lifetime(range(0.6, 1.2)),
    ],
    lifecycle: { duration: 1.05 },
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: rate(60),
    update: [
      gravity([0, -8, 0]),
      drag(1.2),
      collidePlane({ bounce: 0.5, friction: 0.3, mode: 'bounce', normal: [0, 1, 0], offset: -0.92 }),
      sizeOverLife(curve([0, 0.02], [0.3, 0.05], [1, 0.004])),
      colorOverLife(gradient('#ffd9fa', '#ff5fd0', '#7a2ea800')),
    ],
  });
  const flare = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(1.12), lightIntensity(10)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3.5 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 30], [0.08, 15], [0.55, 12], [0.9, 7], [1, 0])),
      colorOverLife(gradient('#ffffff', '#ff9df0', '#c86bff')),
    ],
  });
  const haze = defineEmitter({
    capacity: 5,
    init: [positionSphere({ radius: 0.12 }), lifetime(1.05)],
    integration: 'none',
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 3 }),
    update: [
      sizeOverLife(curve([0, 0.16], [0.15, 0.85], [0.8, 0.68], [1, 0.04])),
      colorOverLife(gradient('#ffe6fb', '#ff9df0', '#c86bff00')),
    ],
  });
  const spray = defineEmitter({
    capacity: 300,
    init: [
      positionSphere({ radius: 0.07 }),
      velocityCone({ angle: 42, direction: [-0.78, 0.58, 0.1], speed: range(4, 11) }),
      lifetime(range(0.3, 0.8)),
    ],
    lifecycle: { duration: 1.05 },
    render: billboard({
      alignment: { factor: 0.65, mode: 'velocity-stretch' },
      blending: 'additive',
      map: SPARK_REF,
    }),
    spawn: rate(280),
    update: [
      gravity([0, -9.8, 0]),
      drag(0.9),
      collidePlane({ bounce: 0.4, friction: 0.3, mode: 'bounce', normal: [0, 1, 0], offset: -0.92 }),
      sizeOverLife(curve([0, 0.062], [0.35, 0.035], [1, 0.004])),
      colorOverLife(gradient('#ffffff', '#ffc2f4', '#ff5fd0', '#c86bff00')),
    ],
  });
  return defineEffect({ elements: { chunks, flare, haze, spray } });
}

/** Post-cutoff afterglow at the crater: dim smoke motes, sparse falling sparks. */
function createAfterglowEffect() {
  const craterMotes = defineEmitter({
    capacity: 90,
    init: [
      positionSphere({ radius: 0.4 }),
      velocityCone({ angle: 60, direction: [0, 1, 0], speed: range(0.15, 0.55) }),
      lifetime(range(0.55, 0.95)),
    ],
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 20, cycles: 3, interval: 0.18 }),
    update: [
      curlNoise({ frequency: 1.3, strength: 0.7 }),
      drag(1.3),
      sizeOverLife(curve([0, 0.03], [0.3, 0.16], [1, 0])),
      colorOverLife(gradient('#b89fe8', '#8a70bd', '#2e224400')),
    ],
  });
  const fallSparks = defineEmitter({
    capacity: 45,
    init: [
      positionSphere({ radius: 0.45 }),
      velocityCone({ angle: 70, direction: [-0.25, 1, 0], speed: range(0.4, 1.4) }),
      lifetime(range(0.5, 0.9)),
    ],
    render: billboard({
      alignment: { factor: 0.6, mode: 'velocity-stretch' },
      blending: 'additive',
      map: SPARK_REF,
    }),
    spawn: burst({ count: 8, cycles: 3, interval: 0.22 }),
    update: [
      gravity([0, -6.5, 0]),
      drag(0.6),
      collidePlane({ bounce: 0.3, friction: 0.4, mode: 'bounce', normal: [0, 1, 0], offset: -0.92 }),
      sizeOverLife(curve([0, 0.036], [0.5, 0.02], [1, 0.003])),
      colorOverLife(gradient('#ffe3fb', '#ff5fd0', '#c86bff00')),
    ],
  });
  const emberGlow = defineEmitter({
    capacity: 4,
    init: [positionSphere({ radius: 0.15 }), lifetime(0.85)],
    integration: 'none',
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 3 }),
    update: [
      sizeOverLife(curve([0, 0.5], [0.3, 0.8], [1, 0.1])),
      colorOverLife(gradient('#9a6fe0', '#6b4fa8', '#2a1f4a00')),
    ],
  });
  return defineEffect({ elements: { craterMotes, emberGlow, fallSparks } });
}

// ---------------------------------------------------------------------------
// Scene + runtime setup shared by the headless capture and the live viewer.
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

interface CoreInstanceLike {
  readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
  readonly state: string;
  getEmitter(key: string): VfxEmitterRuntimeView | undefined;
  release(): void;
}

interface CoreFxRuntime {
  readonly instance: CoreInstanceLike;
  readonly lightKeys: readonly string[];
  readonly lights: Map<string, ReturnType<typeof materializeThreeLightDraw>>;
  readonly spriteKeys: readonly string[];
  readonly sprites: Map<string, THREE.Object3D>;
}

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
  if (!backend.isWebGPUBackend) throw new Error('Plasma lance requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  required<HTMLElement>('#mode-value').textContent = headless
    ? 'headless keyframe capture'
    : 'live loop';

  const textures: EffectTextures = {
    beamCore: beamCoreTexture(),
    glowShell: glowShellTexture(),
    glyphs: glyphStripTexture(),
    noise: noiseTexture(),
    ramp: beamRampTexture(),
    residualRamp: residualRampTexture(),
    sheath: sheathTexture(),
    ticks: tickStripTexture(),
  };
  const spark = sparkSpriteTexture();
  const glow = glowSpriteTexture();
  const star = starSpriteTexture();
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [GLOW_REF.uri, glow],
      [SPARK_REF.uri, spark],
      [STAR_REF.uri, star],
    ]),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030208);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 9),
    new THREE.MeshStandardNodeMaterial({ color: 0x131022, metalness: 0.3, roughness: 0.5 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.95;
  const enemyCrystal = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.5, 1),
    new THREE.MeshStandardNodeMaterial({ color: 0x241736, metalness: 0.45, roughness: 0.4 }),
  );
  enemyCrystal.position.set(2.88, -0.55, -0.35);
  scene.add(ground, enemyCrystal, new THREE.HemisphereLight(0x584a78, 0x070310, 0.5));

  const camera = new THREE.PerspectiveCamera(42, WIDTH / HEIGHT, 0.1, 40);
  const cameraBasePosition = new THREE.Vector3(0, 1.0, 6.2);
  camera.position.copy(cameraBasePosition);
  camera.lookAt(0, 0.1, 0);
  const cameraBaseRotation = camera.rotation.clone();
  camera.updateMatrixWorld(true);

  const projectPoint = (point: Vec3): [number, number] => {
    const projected = new THREE.Vector3(...point).project(camera);
    return [0.5 + projected.x * 0.5, 0.5 - projected.y * 0.5];
  };
  const muzzleCenter = projectPoint(MUZZLE_POSITION);
  const impactCenter = projectPoint(IMPACT_POSITION);

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
  const effect = createPlasmaLance(textures, !headless);
  const instance = system.spawn(effect, { position: [0, 0, 0], seed: 0xbea0 });

  // Caster/impact particles live in a separate core system so their emitters
  // can be spawned at world offsets while the timeline effect stays at origin.
  const coreSystem = new CoreVFXSystem(runtime, undefined, { registry });
  coreSystem.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
  const chargeEffect = createChargeEffect();
  const flashEffect = createFlashEffect();
  const impactEffect = createImpactEffect();
  const afterglowEffect = createAfterglowEffect();

  const coreFx: CoreFxRuntime[] = [];
  const registerCoreFx = (
    fxInstance: CoreInstanceLike,
    spriteKeys: readonly string[],
    lightKeys: readonly string[],
  ) => {
    coreFx.push({
      instance: fxInstance,
      lightKeys,
      lights: new Map(),
      spriteKeys,
      sprites: new Map(),
    });
  };
  const spawnCharge = () =>
    registerCoreFx(
      coreSystem.spawn(chargeEffect, { position: MUZZLE_POSITION, seed: 0xbea1 }),
      ['inflow', 'motes', 'orb'],
      ['glowLight'],
    );
  const spawnFlash = () =>
    registerCoreFx(
      coreSystem.spawn(flashEffect, { position: MUZZLE_POSITION, seed: 0xbea2 }),
      ['sparks', 'star'],
      ['flashLight'],
    );
  const spawnImpact = () =>
    registerCoreFx(
      coreSystem.spawn(impactEffect, { position: IMPACT_POSITION, seed: 0xbea3 }),
      ['chunks', 'haze', 'spray'],
      ['flare'],
    );
  const spawnAfterglow = () =>
    registerCoreFx(
      coreSystem.spawn(afterglowEffect, { position: IMPACT_POSITION, seed: 0xbea4 }),
      ['craterMotes', 'emberGlow', 'fallSparks'],
      [],
    );
  const releaseCoreFx = () => {
    for (const fx of coreFx) {
      for (const object of fx.sprites.values()) scene.remove(object);
      for (const light of fx.lights.values()) {
        scene.remove(light.group);
        light.dispose();
      }
      fx.instance.release();
    }
    coreFx.length = 0;
  };
  const materializeCoreDraws = () => {
    for (const fx of coreFx) {
      for (const key of fx.spriteKeys) {
        if (fx.sprites.has(key)) continue;
        const view = fx.instance.getEmitter(key);
        if (!view) continue;
        const object = materializeThreeSpriteDraw(view.program, view.kernels, 0, {
          resolveTexture,
        });
        scene.add(object);
        fx.sprites.set(key, object);
      }
      for (const key of fx.lightKeys) {
        if (fx.lights.has(key)) continue;
        const view = fx.instance.getEmitter(key);
        if (!view) continue;
        const light = materializeThreeLightDraw(view.program, view.kernels);
        scene.add(light.group);
        fx.lights.set(key, light);
      }
    }
  };
  spawnCharge();
  let fired = false;
  let impactTriggered = false;
  let cutoffTriggered = false;

  const actions: Array<{ kind: string; localTime: number; target?: string }> = [];
  const markers: string[] = [];
  let latestCycle = 0;
  instance.onAction(({ action, cycle, localTime }) => {
    const target = 'target' in action ? action.target : undefined;
    actions.push({ kind: action.kind, localTime, ...(target === undefined ? {} : { target }) });
    latestCycle = Math.max(latestCycle, cycle);
  });
  for (const name of ['charge', 'fire', 'cutoff']) {
    instance.onMarker(name, () => markers.push(name));
  }

  const findMeshFx = (name: string): THREE.Mesh | undefined =>
    scene.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === name,
    );

  const post = createPostPipeline(renderer, scene, camera, {
    bloom: bloomPreset('intense', { radius: 0.62, strength: 0.85, threshold: 0.5 }),
    distortion: screenDistortion({
      shockwaves: [
        {
          center: muzzleCenter,
          duration: 0.6,
          radius: 0.02,
          ringWidth: 0.13,
          speed: 0.9,
          startTime: FIRE_TIME,
          strength: 0.05,
        },
        {
          center: impactCenter,
          duration: 0.7,
          radius: 0.02,
          ringWidth: 0.12,
          speed: 0.8,
          startTime: FIRE_TIME + 0.08,
          strength: 0.045,
        },
      ],
    }),
  });

  const localNow = () => instance.localTime % EFFECT_DURATION;

  // Sub-stepping keeps the fire/cutoff triggers tight against the timeline's
  // hit-stopped local clock while core-system particles run on world time.
  const SUBSTEPS = 4;
  const step = async (delta: number) => {
    for (let subStep = 0; subStep < SUBSTEPS; subStep += 1) {
      const local = localNow();
      if (!fired && local >= FIRE_TIME) {
        fired = true;
        spawnFlash();
      }
      if (!impactTriggered && local >= IMPACT_START) {
        impactTriggered = true;
        spawnImpact();
      }
      if (!cutoffTriggered && local >= CUTOFF_TIME) {
        cutoffTriggered = true;
        spawnAfterglow();
      }
      await system.update(delta / SUBSTEPS);
      await coreSystem.update(delta / SUBSTEPS);
    }
    materializeCoreDraws();
    for (const fx of coreFx) {
      for (const light of fx.lights.values()) await light.update(renderer);
    }
    // Shock rings expand through page-driven scale: clone position/rotation are
    // owned by the timeline, but clone scale is preserved, and after the
    // geometry bake the rings live in the world YZ plane, so scale.y/z widen
    // them without displacing the baked offsets (scale.x stays 1).
    const muzzleState = instance.getElementState('muzzleRing');
    const muzzleClone = findMeshFx('beam-muzzle-ring');
    if (muzzleClone && muzzleState?.playing) {
      const q = Math.min(1, muzzleState.localTime / 0.35);
      const scale = 0.3 + 1.2 * easeOutCubic(q);
      muzzleClone.scale.set(1, scale, scale);
    }
    const impactState = instance.getElementState('impactRing');
    const impactClone = findMeshFx('beam-impact-ring');
    if (impactClone && impactState?.playing) {
      const q = Math.min(1, impactState.localTime / 0.45);
      const scale = 0.3 + 1.05 * easeOutCubic(q);
      impactClone.scale.set(1, scale, scale);
    }
    // Beam width pulse at ~14 Hz on the sheath (and half-strength on the glow
    // shell); the amplitude ramps in after the extension sweep completes.
    const sheathState = instance.getElementState('beamSheath');
    const sheathClone = findMeshFx('beam-sheath');
    const glowClone = findMeshFx('beam-glow');
    if (sheathClone && glowClone) {
      if (sheathState?.playing) {
        const amplitude = 0.15 * Math.min(1, Math.max(0, (sheathState.localTime - 0.08) / 0.2));
        const wave = Math.sin(sheathState.localTime * Math.PI * 2 * 14);
        const pulse = 1 + amplitude * wave;
        const glowPulse = 1 + amplitude * 0.6 * wave;
        sheathClone.scale.set(1, pulse, pulse);
        glowClone.scale.set(1, glowPulse, glowPulse);
      } else {
        sheathClone.scale.set(1, 1, 1);
        glowClone.scale.set(1, 1, 1);
      }
    }
    if (latestShake) {
      // Horizontal-biased recoil: full lateral kick, damped vertical bounce.
      camera.position
        .copy(cameraBasePosition)
        .add(
          new THREE.Vector3(
            latestShake.translation[0] * 1.35,
            latestShake.translation[1] * 0.35,
            latestShake.translation[2] * 0.6,
          ),
        );
      camera.rotation.set(
        cameraBaseRotation.x + latestShake.rotation[0] * 0.4,
        cameraBaseRotation.y + latestShake.rotation[1],
        cameraBaseRotation.z + latestShake.rotation[2] * 0.5,
      );
    } else {
      camera.position.copy(cameraBasePosition);
      camera.rotation.copy(cameraBaseRotation);
    }
    camera.updateMatrixWorld(true);
    system.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
    coreSystem.setCamera(cameraState(camera, [WIDTH, HEIGHT]));
    post.controls.setTime(localNow());
  };

  if (headless) {
    // Short warmed GPU sample window for the nachi.perf-baseline record. It
    // respawns the effect so compute work is still in flight while sampling.
    const perfWindow = async () => {
      system.spawn(effect, { position: [0, 0, 0], seed: 0xbeaf });
      const perfTarget = new THREE.RenderTarget(96, 64, { depthBuffer: true });
      const monitor = createPerformanceMonitor(renderer, {
        gpuScopes: ['compute', 'render'],
        mode: 'headless',
        page: 'showcase-beam',
      });
      await monitor.captureGpuSamples(async () => {
        await step(STEP);
        renderer.setRenderTarget(perfTarget);
        post.render();
      });
      perfTarget.dispose();
    };
    await runHeadless(renderer, post, step, instance, {
      coreFx: () => coreFx,
      markers,
      perfWindow,
    });
    return;
  }

  // Live viewer: present to the page canvas and loop forever; the timeline
  // loops itself and the core-system stages are respawned at every new cycle.
  required<HTMLCanvasElement>('#beam-visual').style.display = 'none';
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
  required<HTMLElement>('#status-value').textContent = 'looping · watch the lance';
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
      releaseCoreFx();
      spawnCharge();
      fired = false;
      impactTriggered = false;
      cutoffTriggered = false;
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
  context: {
    coreFx: () => readonly CoreFxRuntime[];
    markers: readonly string[];
    perfWindow: () => Promise<void>;
  },
): Promise<void> {
  const labels = required<HTMLElement>('#frame-labels');
  labels.innerHTML = CAPTURE_LABELS.map((label) => `<span>${label}</span>`).join('');
  const elementKeys = [
    'beamCore',
    'beamGlow',
    'beamResidual',
    'beamSheath',
    'circleGlyphs',
    'circleTicks',
    'impactRing',
    'muzzleRing',
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
  for (let frame = 0; frame < HEADLESS_FRAMES; frame += 1) {
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

  const canvas = required<HTMLCanvasElement>('#beam-visual');
  const sheetContext = canvas.getContext('2d');
  if (!sheetContext) throw new Error('showcase-beam requires the contact sheet canvas.');
  const sheet = sheetContext.createImageData(WIDTH * 3, HEIGHT * 2);
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
  sheetContext.putImageData(sheet, 0, 0);

  await context.perfWindow();
  const firePanel = panelStats[1] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const impactPanel = panelStats[2] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const sustainPanel = panelStats[3] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const coreDiagnostics = context
    .coreFx()
    .flatMap(({ instance: fx }) => fx.diagnostics.map(({ code }) => code));
  const checks = {
    allFramesCaptured: captures.length === CAPTURE_TIMES.length,
    beamVisible:
      firePanel.foregroundRatio > 0.025 &&
      impactPanel.foregroundRatio > 0.03 &&
      sustainPanel.foregroundRatio > 0.025,
    consoleClean: consoleMessages.length === 0,
    coreHealthy:
      coreDiagnostics.length === 0 &&
      context.coreFx().every(({ instance: fx }) => fx.state !== 'error'),
    exposureBounded: [firePanel, impactPanel, sustainPanel].every(
      (panel) => panel.saturatedRatio < 0.06,
    ),
    stateHealthy: instance.state !== 'error',
  };
  const result = {
    checks,
    consoleMessages,
    evidence: {
      captureStates,
      captureTimes: CAPTURE_TIMES,
      coreDiagnostics,
      finalLocalTime: instance.localTime,
      finalState: instance.state,
      markers: context.markers,
      panelStats,
    },
    ok: Object.values(checks).every(Boolean),
    schema: 'nachi.showcase-beam.v1',
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'showcase-beam.png', selector: '#beam-visual' },
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
