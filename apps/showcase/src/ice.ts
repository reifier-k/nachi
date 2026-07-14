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
  positionSphere,
  range,
  sizeOverLife,
  tslModule,
  velocityCone,
  type TextureRef,
  type TslExpression,
  type Vec3,
  type VfxEmitterRuntimeView,
} from '@nachi/core';
import { cone, ring, uvFlow, type MeshFxMesh } from '@nachi/mesh-fx';
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
  type TimelineEntry,
} from '@nachi/timeline';
import * as THREE from 'three/webgpu';
import { cos, float, fract, mix, sin, step, vec3 } from 'three/tsl';

import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  createThreeTextureResolver,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
} from '@nachi/three';
import {
  allPanelsHaveForeground,
  createDrainedReadback,
  createPerformanceMonitor,
  createPlaygroundRenderer,
  createTimestampQueryPoolDrain,
} from './harness';
import { attachShowcaseTuning } from './tuning';
import './ice.css';
import './embed.css';

const WIDTH = 640;
const HEIGHT = 360;
const STEP = 1 / 60;
const EFFECT_DURATION = 2.6;
const FLOOR_Y = -0.95;
const CIRCLE_Y = -0.93;
const PILLAR_RING_RADIUS = 1.05;
const RING_PILLAR_COUNT = 7;
const RING_STEP = (Math.PI * 2) / RING_PILLAR_COUNT;
const RING_PHASE = 0.45;
const ERUPT_BASE = 0.55;
const ERUPT_STEP = 0.055;
const CENTER_TIME = 0.95;
const PILLAR_END = 2.45;
const GROW_TIME = 0.13;
const HEADLESS_FRAMES = 175;
const CAPTURE_TIMES = [0.4, 0.66, 1.14, 1.5, 2.06, 2.42] as const;
const CAPTURE_LABELS = [
  'bloom · icicle circle',
  'eruption · first spikes',
  'impact · frozen forest',
  'tableau · glitter + snow',
  'shatter · crumble',
  'afterglow · snow dust',
] as const;
const root = document.documentElement;
const headless = new URLSearchParams(location.search).get('headless') === '1';
if (new URLSearchParams(location.search).get('embed') === '1') root.dataset.embed = '1';
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
  if (!value) throw new Error(`Missing ice element: ${selector}`);
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

/** Tiling fbm used by the circle, frost ring, and base ring dissolves. */
function noiseTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x1cec);
  return grayscaleDataTexture([128, 128], (u, v) => fbm(noise, u * 9.1, v * 9.1));
}

/**
 * Vertical ramp mixed with noise for the pillar dissolves. Cone V runs base→tip,
 * so the base is brightest: sweeping the threshold from 1 to ~0 grows the
 * pillar bottom-to-top, and sweeping back up crumbles it tip-first.
 */
function pillarDissolveTexture(): THREE.DataTexture {
  const noise = createValueNoise(0x51ce);
  return grayscaleDataTexture(
    [128, 128],
    (u, v) => 0.14 + (1 - v) * 0.6 + fbm(noise, u * 7.3, v * 7.3) * 0.26,
  );
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
  if (!context) throw new Error('ice requires a 2D canvas context.');
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
 * Icy pillar body: deep blue base rising through cyan into a glacial white tip
 * (canvas top = cone V→1 = tip), with vertical crystal streaks.
 */
function pillarBodyTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x1ceb0d);
  return canvasTexture(256, 256, (context) => {
    const body = context.createLinearGradient(0, 256, 0, 0);
    body.addColorStop(0, '#051230');
    body.addColorStop(0.35, '#16418f');
    body.addColorStop(0.62, '#1f63b6');
    body.addColorStop(0.86, '#4fb3ec');
    body.addColorStop(0.96, '#8fd8f8');
    body.addColorStop(1, '#eafcff');
    context.fillStyle = body;
    context.fillRect(0, 0, 256, 256);
    context.globalCompositeOperation = 'lighter';
    for (let index = 0; index < 60; index += 1) {
      const x = random() * 256;
      const bottom = 256 - random() * 40;
      const length = 60 + random() * 180;
      context.strokeStyle = random() > 0.7 ? '#eafcff' : random() > 0.4 ? '#9fe8ff' : '#5fc8ff';
      context.globalAlpha = 0.05 + random() * 0.2;
      context.lineWidth = 0.7 + random() * 2;
      context.beginPath();
      context.moveTo(x, bottom);
      context.lineTo(x + (random() - 0.5) * 10, bottom - length);
      context.stroke();
    }
    context.globalAlpha = 1;
  });
}

/**
 * Outer circle strip (u = angle, v = radial; canvas top = outer rim). A row of
 * downward-pointing icicle silhouettes with cyan edges and white cores hangs
 * from the outer rim, pointing in toward the circle center.
 */
function icicleStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x1c1c);
  return canvasTexture(1024, 128, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.globalAlpha = 0.65;
    context.fillStyle = '#5fc8ff';
    context.fillRect(0, 5, 1024, 3);
    context.fillStyle = '#eafcff';
    context.fillRect(0, 8, 1024, 1);
    context.globalAlpha = 0.45;
    context.fillStyle = '#5fc8ff';
    context.fillRect(0, 120, 1024, 2);
    context.globalAlpha = 1;
    let x = 4;
    while (x < 1010) {
      const width = 12 + random() * 16;
      const height = 34 + random() * 72;
      const lean = (random() - 0.5) * 6;
      const tipX = x + width / 2 + lean;
      const tipY = 12 + height;
      // Cyan edge silhouette.
      context.fillStyle = '#2f7ecc';
      context.beginPath();
      context.moveTo(x, 12);
      context.lineTo(x + width, 12);
      context.lineTo(tipX, tipY);
      context.closePath();
      context.fill();
      context.strokeStyle = '#5fc8ff';
      context.lineWidth = 1.8;
      context.stroke();
      // White core, inset and slightly shorter.
      context.fillStyle = '#dff6ff';
      context.beginPath();
      context.moveTo(x + width * 0.28, 13);
      context.lineTo(x + width * 0.72, 13);
      context.lineTo(tipX, 12 + height * 0.82);
      context.closePath();
      context.fill();
      // Frost dot between icicles.
      if (random() > 0.55) {
        context.fillStyle = '#9fe8ff';
        context.beginPath();
        context.arc(x + width + 4, 20 + random() * 12, 1.6, 0, Math.PI * 2);
        context.fill();
      }
      x += width + 7 + random() * 9;
    }
  });
}

/** Inner circle strip: six-pointed snowflake spokes and tick marks. */
function snowflakeStripTexture(): THREE.CanvasTexture {
  const random = createSeededRandom(0x5f1a);
  return canvasTexture(512, 64, (context) => {
    context.globalCompositeOperation = 'lighter';
    context.fillStyle = '#5fc8ff';
    context.fillRect(0, 3, 512, 2);
    context.fillRect(0, 59, 512, 2);
    for (let x = 10; x < 500; x += 36) {
      const cx = x + 9;
      const cy = 32;
      const arm = 10 + random() * 4;
      const spin = random() * 0.6;
      for (let k = 0; k < 3; k += 1) {
        const angle = spin + (k * Math.PI) / 3;
        const dx = Math.cos(angle) * arm;
        const dy = Math.sin(angle) * arm;
        context.strokeStyle = '#9fe8ff';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(cx - dx, cy - dy);
        context.lineTo(cx + dx, cy + dy);
        context.stroke();
        context.strokeStyle = '#eafcff';
        context.lineWidth = 0.9;
        context.beginPath();
        context.moveTo(cx - dx * 0.55, cy - dy * 0.55);
        context.lineTo(cx + dx * 0.55, cy + dy * 0.55);
        context.stroke();
      }
      context.fillStyle = '#eafcff';
      context.beginPath();
      context.arc(cx, cy, 1.7, 0, Math.PI * 2);
      context.fill();
      // Tick between snowflakes.
      context.fillStyle = '#5fc8ff';
      context.fillRect(x + 24, 26, 3, 12);
    }
  });
}

/** Radial glow with a four-point flare, tinted by particle color. */
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

/** Plain soft radial glow for haze and snow dust. */
function glowSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    return Math.exp(-(x * x + y * y) * 5.5);
  });
}

/** Six-armed frost crystal for motes and falling snow. */
function flakeSpriteTexture(): THREE.DataTexture {
  return grayscaleDataTexture([64, 64], (u, v) => {
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const radius = Math.hypot(x, y);
    let arms = 0;
    for (let k = 0; k < 3; k += 1) {
      const angle = (k * Math.PI) / 3;
      const perpendicular = Math.abs(x * Math.sin(angle) - y * Math.cos(angle));
      arms += Math.exp(-perpendicular * 14) * Math.exp(-radius * 2.6);
    }
    return Math.exp(-radius * radius * 9) * 0.85 + arms * 0.5;
  });
}

// ---------------------------------------------------------------------------
// Effect authoring.
// ---------------------------------------------------------------------------

const SPARK_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://ice/spark',
};
const GLOW_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://ice/glow',
};
const FLAKE_REF: TextureRef = {
  assetType: 'texture',
  kind: 'asset-ref',
  uri: 'procedural://ice/flake',
};

interface EffectTextures {
  readonly icicles: THREE.Texture;
  readonly noise: THREE.Texture;
  readonly pillarBody: THREE.Texture;
  readonly pillarDissolve: THREE.Texture;
  readonly snowflakes: THREE.Texture;
}

interface PillarSpec {
  readonly angle: number;
  readonly height: number;
  readonly radius: number;
  readonly ringRadius: number;
  /** Local time when the crumble dissolve begins. */
  readonly shatter: number;
  readonly start: number;
  readonly suffix: string;
  readonly thetaStart: number;
  readonly tilt: number;
}

const PILLAR_HEIGHTS = [2.05, 1.7, 2.2, 1.75, 2.1, 1.65, 1.9] as const;
const PILLAR_RADII = [0.21, 0.17, 0.235, 0.18, 0.225, 0.165, 0.2] as const;
const PILLAR_TILTS = [0.13, 0.16, 0.11, 0.15, 0.12, 0.17, 0.14] as const;
const ERUPTION_ORDER = [0, 4, 2, 6, 1, 5, 3] as const;

const RING_PILLARS: readonly PillarSpec[] = Array.from(
  { length: RING_PILLAR_COUNT },
  (_, index) => {
    const orderIndex = (ERUPTION_ORDER as readonly number[]).indexOf(index);
    return {
      angle: RING_PHASE + index * RING_STEP,
      height: PILLAR_HEIGHTS[index]!,
      radius: PILLAR_RADII[index]!,
      ringRadius: PILLAR_RING_RADIUS,
      shatter: 1.8 + orderIndex * 0.025,
      start: ERUPT_BASE + orderIndex * ERUPT_STEP,
      suffix: `${index}`,
      thetaStart: index * 0.83,
      tilt: PILLAR_TILTS[index]!,
    };
  },
);

const CENTER_PILLAR: PillarSpec = {
  angle: 0,
  height: 2.75,
  radius: 0.32,
  ringRadius: 0,
  shatter: 2.1,
  start: CENTER_TIME,
  suffix: 'C',
  thetaStart: 0.4,
  tilt: 0.02,
};

const ALL_PILLARS: readonly PillarSpec[] = [...RING_PILLARS, CENTER_PILLAR];

/** Adds a constant world-space offset after the position init modules ran. */
function offsetInit(offset: Vec3) {
  const [x, y, z] = offset;
  return tslModule(
    ({ position }) => ({
      // The runtime bindings are raw TSL nodes; plain arrays are not
      // convertible, so the constant offset must be a vec3 node.
      position: position.add(vec3(x, y, z) as unknown as TslExpression<Vec3>),
    }),
    {
      access: { reads: ['Particles.position'], writes: ['Particles.position'] },
      stage: 'init',
    },
  );
}

/**
 * Scatters twinkle particles along the eight pillar axes: spawnOrder picks a
 * pillar slot (7 ring pillars + the center), positionSphere jitter provides
 * the radial offset and the normalized height along that pillar.
 */
const sparklePlacement = tslModule(
  ({ position, spawnOrder }) => {
    const jitter = vec3(position as never);
    const slot = fract(spawnOrder.toFloat().mul(1 / 8) as never);
    const centerness = step(0.8, slot);
    const theta = slot.mul(8 * RING_STEP).add(RING_PHASE);
    const radius = float(1).sub(centerness).mul(PILLAR_RING_RADIUS);
    const span = mix(float(1.5), float(2.4), centerness);
    return {
      position: vec3(
        cos(theta).mul(radius).add(jitter.x.mul(0.2)),
        jitter.y
          .mul(0.5)
          .add(0.5)
          .mul(span)
          .add(FLOOR_Y + 0.05),
        sin(theta).mul(radius).add(jitter.z.mul(0.2)),
      ) as unknown as TslExpression<Vec3>,
    };
  },
  {
    access: {
      reads: ['Particles.position', 'Particles.spawnOrder'],
      writes: ['Particles.position'],
    },
    stage: 'init',
  },
);

function shardEmitter(spec: PillarSpec) {
  const isCenter = spec.ringRadius === 0;
  const baseX = Math.cos(spec.angle) * spec.ringRadius;
  const baseZ = Math.sin(spec.angle) * spec.ringRadius;
  const direction: Vec3 = isCenter
    ? [0, 1, 0]
    : [Math.cos(spec.angle) * 0.45, 1.3, Math.sin(spec.angle) * 0.45];
  return defineEmitter({
    capacity: isCenter ? 72 : 48,
    init: [
      positionSphere({ radius: 0.09 }),
      offsetInit([baseX, FLOOR_Y + 0.12, baseZ]),
      velocityCone({ angle: 26, direction, speed: isCenter ? range(4, 9) : range(3.2, 7) }),
      lifetime(range(0.28, 0.55)),
    ],
    render: billboard({
      alignment: { factor: 0.85, mode: 'velocity-stretch' },
      blending: 'additive',
      map: SPARK_REF,
    }),
    spawn: burst({ count: isCenter ? 60 : 34 }),
    update: [
      gravity([0, -11, 0]),
      drag(0.7),
      collidePlane({
        bounce: 0.35,
        friction: 0.3,
        mode: 'bounce',
        normal: [0, 1, 0],
        offset: CIRCLE_Y,
        space: 'world',
      }),
      sizeOverLife(curve([0, 0.052], [0.35, 0.03], [1, 0.005])),
      colorOverLife(gradient('#ffffff', '#c9f2ff', '#5fc8ff', '#1c4fae00')),
    ],
  });
}

function buildPillarMesh(spec: PillarSpec, textures: EffectTextures): MeshFxMesh {
  const duration = PILLAR_END - spec.start;
  const grow = Math.min(0.9, GROW_TIME / duration);
  const shatterAt = Math.min(0.94, (spec.shatter - spec.start) / duration);
  const crumbled = Math.min(
    0.99,
    Math.max(shatterAt + 0.02, (spec.shatter + 0.42 - spec.start) / duration),
  );
  const mesh = cone({
    height: spec.height,
    heightSegments: 3,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#ccf6ff',
        edgeWidth: 0.06,
        overLife: curve([0, 1], [grow, 0.05], [shatterAt, 0.08], [crumbled, 1], [1, 1]),
        texture: textures.pillarDissolve,
      },
      fresnel: { color: '#5fc8ff', power: 3 },
      map: textures.pillarBody,
      opacity: 0.9,
    }),
    radialSegments: 7,
    radius: spec.radius,
    thetaStart: spec.thetaStart,
  });
  mesh.name = `ice-pillar-${spec.suffix}`;
  // Keep the base at the local origin so any authored scale grows from it.
  mesh.geometry.translate(0, spec.height / 2, 0);
  mesh.quaternion.setFromAxisAngle(
    new THREE.Vector3(Math.sin(spec.angle), 0, -Math.cos(spec.angle)),
    spec.tilt,
  );
  mesh.position.set(
    Math.cos(spec.angle) * spec.ringRadius,
    FLOOR_Y + 0.01,
    Math.sin(spec.angle) * spec.ringRadius,
  );
  return mesh;
}

function buildBaseRingMesh(spec: PillarSpec, textures: EffectTextures): MeshFxMesh {
  const inner = spec.radius * 1.35;
  const mesh = ring({
    innerRadius: inner,
    material: fxMaterial({
      blending: 'additive',
      color: '#8fdcff',
      dissolve: {
        edgeColor: '#eafcff',
        edgeWidth: 0.07,
        overLife: curve([0, 1], [0.12, 0.14], [0.4, 0.32], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.55,
    }),
    outerRadius: inner + 0.22,
    segments: 48,
  });
  mesh.name = `ice-ring-${spec.suffix}`;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(
    Math.cos(spec.angle) * spec.ringRadius,
    CIRCLE_Y + 0.006,
    Math.sin(spec.angle) * spec.ringRadius,
  );
  return mesh;
}

function createGlacialRequiem(textures: EffectTextures, loop: boolean) {
  const haze = defineEmitter({
    capacity: 40,
    init: [
      positionSphere({ radius: 1.25 }),
      offsetInit([0, -0.35, 0]),
      velocityCone({ angle: 80, direction: [0, 1, 0], speed: range(0.06, 0.22) }),
      lifetime(range(1.6, 2.4)),
    ],
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 8, cycles: 4, interval: 0.16 }),
    update: [
      drag(0.4),
      sizeOverLife(curve([0, 0.32], [0.35, 0.7], [1, 0.22])),
      colorOverLife(gradient('#16324f', '#1b3a5f', '#0a1a3000')),
    ],
  });
  const motes = defineEmitter({
    capacity: 110,
    init: [
      positionSphere({ radius: 1.45 }),
      velocityCone({ angle: 75, direction: [0, 1, 0], speed: range(0.1, 0.35) }),
      lifetime(range(0.7, 1.3)),
    ],
    render: billboard({ blending: 'additive', map: FLAKE_REF }),
    spawn: burst({ count: 20, cycles: 6, interval: 0.09 }),
    update: [
      curlNoise({ frequency: 1.6, strength: 0.5 }),
      gravity([0, 0.3, 0]),
      drag(1),
      sizeOverLife(curve([0, 0.01], [0.3, 0.05], [1, 0.006])),
      colorOverLife(gradient('#ffffff', '#bfeeff', '#5fc8ff00')),
    ],
  });
  const sparkle = defineEmitter({
    capacity: 140,
    init: [positionSphere({ radius: 1 }), sparklePlacement, lifetime(range(0.3, 0.55))],
    integration: 'none',
    render: billboard({ blending: 'additive', map: SPARK_REF }),
    spawn: burst({ count: 18, cycles: 9, interval: 0.12 }),
    update: [
      sizeOverLife(curve([0, 0], [0.35, 0.09], [0.7, 0.03], [1, 0])),
      colorOverLife(gradient('#ffffff', '#dffaff', '#9fe8ff00')),
    ],
  });
  const snow = defineEmitter({
    // Eight complete cycles are intentional; keep capacity aligned so none of the 176 flakes are
    // dropped before the earliest 1.3s lifetime can expire.
    capacity: 176,
    init: [positionSphere({ radius: 1.7 }), offsetInit([0, 0.95, 0]), lifetime(range(1.3, 1.9))],
    render: billboard({ blending: 'additive', map: FLAKE_REF }),
    spawn: burst({ count: 22, cycles: 8, interval: 0.2 }),
    update: [
      gravity([0, -0.5, 0]),
      curlNoise({ frequency: 0.9, strength: 0.35 }),
      drag(1.3),
      sizeOverLife(curve([0, 0.008], [0.25, 0.032], [1, 0.003])),
      colorOverLife(gradient('#ffffff', '#d9f4ff', '#9fe8ff00')),
    ],
  });
  const burstDust = defineEmitter({
    capacity: 100,
    init: [
      positionSphere({ radius: 1.15 }),
      offsetInit([0, -0.45, 0]),
      velocityCone({ angle: 70, direction: [0, 1, 0], speed: range(0.7, 2.4) }),
      lifetime(range(0.6, 1.05)),
    ],
    render: billboard({ blending: 'additive', map: GLOW_REF }),
    spawn: burst({ count: 85 }),
    update: [
      drag(2),
      gravity([0, -0.6, 0]),
      sizeOverLife(curve([0, 0.05], [0.35, 0.2], [1, 0.03])),
      colorOverLife(gradient('#e8f8ff', '#a8dcf7', '#5f9fd8', '#1c4fae00')),
    ],
  });
  const flash = defineEmitter({
    capacity: 2,
    init: [positionSphere({ radius: 0 }), lifetime(0.5), lightIntensity(20)],
    integration: 'none',
    render: lightRenderer({ maxLights: 1, radiusScale: 3.5 }),
    spawn: burst({ count: 1 }),
    update: [
      intensityOverLife(curve([0, 28], [0.2, 9], [1, 0])),
      colorOverLife(gradient('#ffffff', '#9fe8ff', '#5fc8ff')),
    ],
  });

  const circleOuterMesh = ring({
    innerRadius: 1.22,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#eafcff',
        edgeWidth: 0.08,
        overLife: curve([0, 1], [0.16, 0.06], [0.88, 0.14], [1, 1]),
        texture: textures.noise,
      },
      map: textures.icicles,
      opacity: 0.72,
      uv: uvFlow({ speed: [0.05, 0] }),
    }),
    outerRadius: 1.68,
    segments: 128,
  });
  circleOuterMesh.name = 'ice-circle-outer';
  // Keep orientation baked: page-driven x/z scale is expressed in world axes.
  circleOuterMesh.geometry.rotateX(-Math.PI / 2);
  circleOuterMesh.geometry.translate(0, CIRCLE_Y, 0);
  const circleInnerMesh = ring({
    innerRadius: 0.72,
    material: fxMaterial({
      blending: 'additive',
      dissolve: {
        edgeColor: '#dff6ff',
        edgeWidth: 0.07,
        overLife: curve([0, 1], [0.18, 0.08], [0.86, 0.16], [1, 1]),
        texture: textures.noise,
      },
      map: textures.snowflakes,
      opacity: 0.7,
      uv: uvFlow({ speed: [-0.075, 0] }),
    }),
    outerRadius: 1.04,
    segments: 96,
  });
  circleInnerMesh.name = 'ice-circle-inner';
  circleInnerMesh.geometry.rotateX(-Math.PI / 2);
  circleInnerMesh.geometry.translate(0, CIRCLE_Y - 0.002, 0);

  const frostWaveMesh = ring({
    innerRadius: 0.88,
    material: fxMaterial({
      blending: 'additive',
      color: '#bfeeff',
      dissolve: {
        edgeColor: '#eafcff',
        edgeWidth: 0.06,
        overLife: curve([0, 0.6], [0.08, 0.14], [0.55, 0.32], [1, 1]),
        texture: textures.noise,
      },
      opacity: 0.65,
    }),
    outerRadius: 1,
    segments: 96,
  });
  frostWaveMesh.name = 'ice-frost-wave';
  // Keep orientation/offset baked for the page-driven ground-plane scale.
  frostWaveMesh.geometry.rotateX(-Math.PI / 2);
  frostWaveMesh.geometry.translate(0, CIRCLE_Y + 0.003, 0);

  const pillarEntries = ALL_PILLARS.map((spec) => [
    `pillar${spec.suffix}`,
    meshFxElement(buildPillarMesh(spec, textures), { duration: PILLAR_END - spec.start }),
  ]);
  const ringEntries = ALL_PILLARS.map((spec) => [
    `ring${spec.suffix}`,
    meshFxElement(buildBaseRingMesh(spec, textures), { duration: 0.75 }),
  ]);
  const shardEntries = ALL_PILLARS.map((spec) => [`shards${spec.suffix}`, shardEmitter(spec)]);

  const events: TimelineEntry<string>[] = [
    at(0, play('circleInner'), play('circleOuter'), play('haze'), marker('bloom')),
    at(0.05, play('motes')),
  ];
  for (const [orderIndex, pillarIndex] of ERUPTION_ORDER.entries()) {
    const start = ERUPT_BASE + orderIndex * ERUPT_STEP;
    const extras =
      orderIndex === 0
        ? [cameraShake({ duration: 0.16, frequency: 26, strength: 0.09 }), marker('erupt')]
        : orderIndex === 3
          ? [cameraShake({ duration: 0.14, frequency: 24, strength: 0.07 })]
          : [];
    events.push(
      at(
        start,
        play(`pillar${pillarIndex}`),
        play(`ring${pillarIndex}`),
        play(`shards${pillarIndex}`),
        ...extras,
      ),
    );
  }
  events.push(
    at(0.92, play('snow')),
    at(
      CENTER_TIME,
      play('flash'),
      play('frostWave'),
      play('pillarC'),
      play('ringC'),
      play('shardsC'),
      cameraShake({ duration: 0.4, frequency: 30, strength: 0.34 }),
      marker('land'),
    ),
    at(1.03, play('sparkle'), marker('tableau')),
    at(
      1.85,
      play('burstDust'),
      cameraShake({ duration: 0.24, frequency: 22, strength: 0.11 }),
      marker('shatter'),
    ),
  );

  return defineEffect({
    elements: {
      burstDust,
      circleInner: meshFxElement(circleInnerMesh, { duration: 2.55 }),
      circleOuter: meshFxElement(circleOuterMesh, { duration: 2.55 }),
      flash,
      frostWave: meshFxElement(frostWaveMesh, { duration: 1.45 }),
      haze,
      motes,
      snow,
      sparkle,
      ...Object.fromEntries(pillarEntries),
      ...Object.fromEntries(ringEntries),
      ...Object.fromEntries(shardEntries),
    },
    timeline: timeline(events, { duration: EFFECT_DURATION, ...(loop ? { loop: true } : {}) }),
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
  if (!backend.isWebGPUBackend) throw new Error('Glacial Requiem requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';
  required<HTMLElement>('#mode-value').textContent = headless
    ? 'headless keyframe capture'
    : 'live loop';

  const textures: EffectTextures = {
    icicles: icicleStripTexture(),
    noise: noiseTexture(),
    pillarBody: pillarBodyTexture(),
    pillarDissolve: pillarDissolveTexture(),
    snowflakes: snowflakeStripTexture(),
  };
  const spark = sparkSpriteTexture();
  const glow = glowSpriteTexture();
  const flake = flakeSpriteTexture();
  const resolveTexture = createThreeTextureResolver(
    new Map([
      [SPARK_REF.uri, spark],
      [GLOW_REF.uri, glow],
      [FLAKE_REF.uri, flake],
    ]),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02060f);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshStandardNodeMaterial({ color: 0x101a2e, metalness: 0.3, roughness: 0.5 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = FLOOR_Y;
  scene.add(ground, new THREE.HemisphereLight(0x40628a, 0x040812, 0.65));

  const camera = new THREE.PerspectiveCamera(42, WIDTH / HEIGHT, 0.1, 40);
  const cameraBasePosition = new THREE.Vector3(0.35, 2.15, 6.4);
  camera.position.copy(cameraBasePosition);
  camera.lookAt(0, 0.42, 0);
  const cameraBaseRotation = camera.rotation.clone();

  const projected = new THREE.Vector3(0, 0.15, 0).project(camera);
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
  const effect = createGlacialRequiem(textures, !headless);
  const instance = system.spawn(effect, { position: [0, 0, 0], seed: 0x1ce0 });

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
  for (const name of ['bloom', 'erupt', 'land', 'tableau', 'shatter']) {
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
          duration: 0.6,
          radius: 0.02,
          ringWidth: 0.13,
          speed: 0.9,
          startTime: CENTER_TIME,
          strength: 0.045,
        },
      ],
    }),
  });

  const localNow = () => instance.localTime % EFFECT_DURATION;

  // Sub-stepping keeps burst staggering and collisions stable at capture rate.
  const SUBSTEPS = 4;
  const step = async (delta: number) => {
    for (let subStep = 0; subStep < SUBSTEPS; subStep += 1) {
      await system.update(delta / SUBSTEPS);
    }
    materializeNewDraws();
    if (lightDraw) await lightDraw.update(renderer);
    const local = localNow();
    // The circle blooms open: page-driven radial scale on both ring clones.
    const bloomScale = 0.5 + 0.5 * easeOutCubic(Math.min(1, local / 0.45));
    for (const name of ['ice-circle-outer', 'ice-circle-inner']) {
      const clone = findMeshFx(name);
      if (clone) clone.scale.set(bloomScale, 1, bloomScale);
    }
    const waveState = instance.getElementState('frostWave');
    const waveClone = findMeshFx('ice-frost-wave');
    if (waveClone && waveState?.playing) {
      const q = Math.min(1, waveState.localTime / 1.2);
      const scale = 0.35 + 2.35 * easeOutCubic(q);
      waveClone.scale.set(scale, 1, scale);
    }
    if (latestShake) {
      camera.position.copy(cameraBasePosition).add(new THREE.Vector3(...latestShake.translation));
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
      system.spawn(effect, { position: [0, 0, 0], seed: 0x1ce1 });
      const perfTarget = new THREE.RenderTarget(96, 64, { depthBuffer: true });
      const monitor = createPerformanceMonitor(renderer, {
        gpuScopes: ['compute', 'render'],
        mode: 'headless',
        page: 'ice',
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
  required<HTMLCanvasElement>('#ice-visual').style.display = 'none';
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
  attachShowcaseTuning({
    camera,
    cameraBasePosition,
    cameraBaseRotation,
    cameraTarget: new THREE.Vector3(0, 0.42, 0),
    instance,
    renderer,
  });
  required<HTMLElement>('#status-value').textContent = 'looping · watch the freeze';
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
    readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly message?: string }>;
    readonly localTime: number;
    readonly state: string;
    getElementState(key: string): unknown;
  },
  perfWindow: () => Promise<void>,
): Promise<void> {
  const labels = required<HTMLElement>('#frame-labels');
  labels.innerHTML = CAPTURE_LABELS.map((label) => `<span>${label}</span>`).join('');
  const elementKeys = [
    'burstDust',
    'circleInner',
    'circleOuter',
    'flash',
    'frostWave',
    'haze',
    'motes',
    'snow',
    'sparkle',
    ...ALL_PILLARS.flatMap((spec) => [
      `pillar${spec.suffix}`,
      `ring${spec.suffix}`,
      `shards${spec.suffix}`,
    ]),
  ];
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  const drainReadback = createDrainedReadback(renderer, target);
  const drainTimestampQueries = createTimestampQueryPoolDrain(renderer);
  const captures: Uint8Array[] = [];
  const captureStates: Array<Record<string, unknown>> = [];
  let captureIndex = 0;
  await step(0);
  renderer.setRenderTarget(target);
  post.render();
  await drainReadback();
  for (let frame = 0; frame < HEADLESS_FRAMES; frame += 1) {
    await step(STEP);
    renderer.setRenderTarget(target);
    post.render();
    await drainReadback();
    await drainTimestampQueries();
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

  const canvas = required<HTMLCanvasElement>('#ice-visual');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('ice requires the contact sheet canvas.');
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
  const eruption = panelStats[1] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const forest = panelStats[2] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const tableau = panelStats[3] ?? { foregroundRatio: 0, saturatedRatio: 1 };
  const checks = {
    allFramesCaptured: captures.length === CAPTURE_TIMES.length,
    allPanelsVisible: allPanelsHaveForeground(panelStats),
    consoleClean: consoleMessages.length === 0,
    eruptionVisible: eruption.foregroundRatio > 0.02 && eruption.saturatedRatio < 0.3,
    forestVisible: forest.foregroundRatio > 0.045 && forest.saturatedRatio < 0.32,
    stateHealthy: instance.state !== 'error',
    tableauVisible: tableau.foregroundRatio > 0.015 && tableau.saturatedRatio < 0.3,
  };
  const result = {
    checks,
    consoleMessages,
    evidence: {
      captureStates,
      captureTimes: CAPTURE_TIMES,
      finalLocalTime: instance.localTime,
      finalState: instance.state,
      instanceDiagnostics: instance.diagnostics.map(
        ({ code, message }) => `${code}: ${message ?? ''}`,
      ),
      panelStats,
    },
    ok: Object.values(checks).every(Boolean),
    schema: 'nachi.ice.v1',
  };
  root.dataset.artifactScreenshots = JSON.stringify([
    { filename: 'ice.png', selector: '#ice-visual' },
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
