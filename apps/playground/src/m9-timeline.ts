import {
  billboard,
  burst,
  colorOverLife,
  curve,
  defineEmitter,
  gradient,
  lifetime,
  lightIntensity,
  lightRenderer,
  positionSphere,
  range,
  sizeOverLife,
  velocityCone,
  type KernelTslAdapter,
  type VfxEmitterRuntimeView,
} from '@nachi-vfx/core';
import { ring, slashArc } from '@nachi-vfx/mesh-fx';
import {
  VFXSystem,
  at,
  cameraShake,
  defineEffect,
  fxMaterial,
  hitStop,
  marker,
  meshFxElement,
  play,
  stop,
  timeline,
  type CameraShakeSample,
} from '@nachi-vfx/timeline';
import * as THREE from 'three/webgpu';

import { createPerformanceMonitor } from './perf';
import { compactRgba8Readback } from './readback';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeLightDraw,
  materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import { readStorage } from './three-runtime-readback';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m9-timeline.css';

const WIDTH = 480;
const HEIGHT = 300;
const OVER_LIFE_PROBE_SIZE = 64;
const OVER_LIFE_PROBE_COLOR = '#50dfff';
const OVER_LIFE_PROBE_NOISE = 32;
const OVER_LIFE_PROBE_LIFE = 0.25;
const STEP = 1 / 60;
const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const disableOverLifeProbe = query.get('disableOverLife') === '1';
const disableOpacityOverLifeProbe = query.get('disableOpacityOverLife') === '1';
const forceFailure = query.get('forceFailure');
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

function required<ElementType extends Element>(selector: string): ElementType {
  const value = document.querySelector<ElementType>(selector);
  if (!value) throw new Error(`Missing M9 timeline element: ${selector}`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noiseTexture(): THREE.DataTexture {
  const values = [10, 220, 65, 180, 245, 40, 150, 90, 120, 250, 25, 205, 75, 135, 235, 15];
  const data = new Uint8Array(values.flatMap((value) => [value, value, value, 255]));
  const texture = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createSkillSlash(noise: THREE.Texture) {
  const sparks = defineEmitter({
    capacity: 64,
    spawn: burst({ count: 36 }),
    init: [
      positionSphere({ radius: 0.08 }),
      velocityCone({ direction: [0.8, 0.45, 0], angle: 52, speed: range(2.2, 5.5) }),
      lifetime(range(0.35, 0.7)),
    ],
    update: [
      sizeOverLife(curve([0, 0.09], [0.15, 0.045], [1, 0])),
      colorOverLife(gradient('#fff5c2', '#ff8b35', '#58113f')),
    ],
    render: billboard({ blending: 'additive' }),
  });
  const flash = defineEmitter({
    capacity: 1,
    spawn: burst({ count: 1 }),
    init: [positionSphere({ radius: 0 }), lifetime(0.5), lightIntensity(4)],
    update: [sizeOverLife(curve([0, 2], [1, 0])), colorOverLife(gradient('#d9f8ff', '#49a9ff'))],
    render: lightRenderer({ maxLights: 1, radiusScale: 1.5 }),
  });
  const arc = meshFxElement(
    slashArc({
      angle: 140,
      innerRadius: 0.72,
      radius: 1.55,
      rotation: 12,
      taper: 0.72,
      material: fxMaterial({
        color: '#50dfff',
        dissolve: {
          texture: noise,
          overLife: curve([0, 0], [0.3, 0.22], [1, 1]),
          edgeColor: '#ffffff',
          edgeWidth: 0.08,
        },
        fresnel: { color: '#b9f7ff', power: 2 },
        blending: 'additive',
      }),
    }),
    { duration: 1 },
  );
  const shockwave = meshFxElement(
    ring({
      innerRadius: 0.75,
      outerRadius: 0.88,
      material: fxMaterial({ color: '#8a5dff', blending: 'additive', opacity: 0.82 }),
      segments: 72,
    }),
    { duration: 0.1 },
  );
  return defineEffect({
    elements: { arc, sparks, flash, shockwave },
    timeline: timeline(
      [
        at(0, play('flash')),
        at(0.05, play('arc'), cameraShake({ strength: 0.3 }), hitStop(40), marker('impact')),
        at(0.08, play('sparks')),
        at(0.1, play('shockwave')),
        at(0.2, stop('shockwave')),
        at(0.35, stop('sparks')),
        at(0.45, stop('arc')),
      ],
      { duration: 0.5 },
    ),
  });
}

function adapter(_renderer: THREE.WebGPURenderer, backend: BackendLike): KernelTslAdapter {
  return createThreeKernelAdapter({
    backend: 'webgpu',
    linearFloat32Filtering: backend.device?.features?.has('float32-filterable') === true,
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
}

async function aliveCount(
  renderer: THREE.WebGPURenderer,
  view: VfxEmitterRuntimeView,
): Promise<number> {
  const words = (await readStorage(renderer, view.kernels.aliveCount, 'uint')) as Uint32Array;
  return words[view.kernels.counterOffsets.aliveCount] ?? -1;
}

function imageStats(pixels: Uint8Array) {
  let foreground = 0;
  let saturated = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const energy = (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0);
    if (energy > 24) foreground += 1;
    if (energy > 744) saturated += 1;
  }
  const count = pixels.length / 4;
  return { foregroundRatio: foreground / count, saturatedRatio: saturated / count };
}

function changedPixels(left: Uint8Array, right: Uint8Array): number {
  let count = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    if (
      left[offset] !== right[offset] ||
      left[offset + 1] !== right[offset + 1] ||
      left[offset + 2] !== right[offset + 2]
    )
      count += 1;
  }
  return count;
}

async function meshFxStateOwnershipGpuProbe(renderer: THREE.WebGPURenderer) {
  const material = fxMaterial({ blending: 'additive', color: '#ffffff', opacity: 0.8 });
  material.fx.setOpacity(0.2);
  material.side = THREE.DoubleSide;
  material.depthTest = false;
  material.colorWrite = true;
  material.name = 'm9-current-state';
  material.userData = { ownership: { source: 9 } };
  const source = ring({ innerRadius: 0.35, material, outerRadius: 0.75, segments: 48 });
  source.name = 'm9-state-ownership';
  const effect = defineEffect({
    elements: { ring: meshFxElement(source, { duration: 0.04 }) },
    timeline: timeline([at(0, play('ring')), at(0.04, stop('ring')), at(0.06, play('ring'))], {
      duration: 0.1,
    }),
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const system = new VFXSystem({}, scene);
  const instance = system.spawn(effect);
  const clone = scene.getObjectByName('m9-state-ownership') as THREE.Mesh;
  const cloneMaterial = clone.material as ReturnType<typeof fxMaterial>;
  const authoringMaterial = fxMaterial({
    blending: 'additive',
    color: '#ffffff',
    opacity: 0.8,
  });
  authoringMaterial.side = THREE.DoubleSide;
  const authoringSource = ring({
    innerRadius: 0.35,
    material: authoringMaterial,
    outerRadius: 0.75,
    segments: 48,
  });
  const authoringEffect = defineEffect({ elements: { ring: authoringSource } });
  const authoringScene = new THREE.Scene();
  authoringScene.background = new THREE.Color(0);
  const authoringSystem = new VFXSystem({}, authoringScene);
  const authoringInstance = authoringSystem.spawn(authoringEffect);
  const target = new THREE.RenderTarget(64, 64, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = -3;
  camera.lookAt(0, 0, 0);
  const captureMaximumEnergy = async (captureScene: THREE.Scene) => {
    renderer.setRenderTarget(target);
    renderer.render(captureScene, camera);
    const pixels = compactRgba8Readback(
      new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64)),
      64,
      64,
      true,
    );
    let maximum = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      maximum = Math.max(
        maximum,
        (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0),
      );
    }
    return maximum;
  };

  await system.update(0);
  await authoringSystem.update(0);
  const currentOpacityEnergy = await captureMaximumEnergy(scene);
  const authoringOpacityEnergy = await captureMaximumEnergy(authoringScene);
  material.fx.setOpacity(0.9);
  material.side = THREE.FrontSide;
  material.userData.ownership.source = 0;
  const afterSourceMutationEnergy = await captureMaximumEnergy(scene);
  instance.setUserVisible('ring', false);
  await system.update(0.06);
  if (forceFailure === 'timeline-user-visible') instance.setUserVisible('ring', true);
  const replayHiddenEnergy = await captureMaximumEnergy(scene);
  const replayState = instance.getElementState('ring');
  instance.setUserVisible('ring', true);
  const restoredEnergy = await captureMaximumEnergy(scene);

  const stateSnapshot =
    cloneMaterial.fx.opacity?.value === 0.2 &&
    cloneMaterial.side === THREE.DoubleSide &&
    cloneMaterial.depthTest === false &&
    cloneMaterial.colorWrite === true &&
    cloneMaterial.name === 'm9-current-state' &&
    cloneMaterial.userData.ownership?.source === 9;
  const graphIndependent =
    cloneMaterial.opacityNode !== material.opacityNode &&
    cloneMaterial.colorNode !== material.colorNode &&
    cloneMaterial.fx.opacity !== material.fx.opacity &&
    cloneMaterial.fx.time !== material.fx.time &&
    cloneMaterial.fx.normalizedLife !== material.fx.normalizedLife;
  const stateIndependent =
    cloneMaterial.fx.opacity?.value === 0.2 &&
    cloneMaterial.side === THREE.DoubleSide &&
    cloneMaterial.userData.ownership?.source === 9 &&
    cloneMaterial.userData.ownership !== material.userData.ownership;
  const opacityRatio = currentOpacityEnergy / authoringOpacityEnergy;
  const opacityCausal =
    currentOpacityEnergy >= 140 &&
    currentOpacityEnergy <= 170 &&
    authoringOpacityEnergy >= 590 &&
    authoringOpacityEnergy <= 630 &&
    opacityRatio >= 0.22 &&
    opacityRatio <= 0.28 &&
    afterSourceMutationEnergy === currentOpacityEnergy;
  const geometryBorrowed =
    clone.geometry === source.geometry &&
    clone.geometry.getAttribute('position') === source.geometry.getAttribute('position');
  const visibilityComposed =
    replayState?.playing === true &&
    replayState.visible === false &&
    replayHiddenEnergy === 0 &&
    restoredEnergy === currentOpacityEnergy;
  const ok =
    stateSnapshot &&
    stateIndependent &&
    graphIndependent &&
    opacityCausal &&
    geometryBorrowed &&
    visibilityComposed;
  instance.release();
  authoringInstance.release();
  renderer.setRenderTarget(null);
  material.dispose();
  source.geometry.dispose();
  authoringMaterial.dispose();
  authoringSource.geometry.dispose();
  target.dispose();
  return {
    fault: forceFailure,
    geometryBorrowed,
    graphIndependent,
    ok,
    opacityCausal,
    pixels: {
      afterSourceMutationEnergy,
      authoringOpacityEnergy,
      currentOpacityEnergy,
      opacityRatio,
      replayHiddenEnergy,
      restoredEnergy,
    },
    stateIndependent,
    stateSnapshot,
    visibilityComposed,
  };
}

type Rgb = readonly [number, number, number];

function rgb(pixels: Uint8Array, x: number, y: number, width: number): Rgb {
  const offset = (y * width + x) * 4;
  return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
}

function rgbMatches(actual: Rgb, expected: Rgb): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= 4);
}

function overLifeProbeTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array([OVER_LIFE_PROBE_NOISE, OVER_LIFE_PROBE_NOISE, OVER_LIFE_PROBE_NOISE, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

async function meshFxOverLifeGpuProbe(
  renderer: THREE.WebGPURenderer,
  runtime: ReturnType<typeof createThreeRuntimeRenderer>,
) {
  const noise = overLifeProbeTexture();
  const overLife = curve([0, 0], [0.3, 0.22], [1, 1]);
  const probe = defineEffect({
    elements: {
      arc: meshFxElement(
        slashArc({
          angle: 90,
          innerRadius: 0.5,
          radius: 1.5,
          material: fxMaterial({
            blending: 'additive',
            color: OVER_LIFE_PROBE_COLOR,
            dissolve: {
              edgeWidth: 0.08,
              overLife: disableOverLifeProbe ? 0 : overLife,
              texture: noise,
            },
          }),
          taper: 0,
        }),
        { duration: 1 },
      ),
    },
    timeline: timeline([at(0, play('arc'))], { duration: 1 }),
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 10);
  camera.position.z = 5;
  const target = new THREE.RenderTarget(OVER_LIFE_PROBE_SIZE, OVER_LIFE_PROBE_SIZE, {
    depthBuffer: true,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  const system = new VFXSystem(runtime, scene);
  system.spawn(probe);
  await system.update(0);
  const capture = async () => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    return compactRgba8Readback(
      new Uint8Array(
        await renderer.readRenderTargetPixelsAsync(
          target,
          0,
          0,
          OVER_LIFE_PROBE_SIZE,
          OVER_LIFE_PROBE_SIZE,
        ),
      ),
      OVER_LIFE_PROBE_SIZE,
      OVER_LIFE_PROBE_SIZE,
      true,
    );
  };
  const atLifeZero = await capture();
  await system.update(OVER_LIFE_PROBE_LIFE);
  const atLifeQuarter = await capture();
  const sample = new THREE.Vector3(1, 0, 0).project(camera);
  const sampleX = Math.floor((sample.x * 0.5 + 0.5) * OVER_LIFE_PROBE_SIZE);
  const sampleY = Math.floor((sample.y * 0.5 + 0.5) * OVER_LIFE_PROBE_SIZE);
  const color = new THREE.Color(OVER_LIFE_PROBE_COLOR);
  const expectedVisible = [
    Math.round(color.r * 255),
    Math.round(color.g * 255),
    Math.round(color.b * 255),
  ] as const;
  const expectedDissolved = [0, 0, 0] as const;
  const actualAtLifeZero = rgb(atLifeZero, sampleX, sampleY, OVER_LIFE_PROBE_SIZE);
  const actualAtLifeQuarter = rgb(atLifeQuarter, sampleX, sampleY, OVER_LIFE_PROBE_SIZE);
  const thresholdAtLifeQuarter = (0.22 / 0.3) * OVER_LIFE_PROBE_LIFE;
  const ok =
    OVER_LIFE_PROBE_NOISE / 255 > 0.08 &&
    OVER_LIFE_PROBE_NOISE / 255 < thresholdAtLifeQuarter &&
    rgbMatches(actualAtLifeZero, expectedVisible) &&
    rgbMatches(actualAtLifeQuarter, expectedDissolved);
  target.dispose();
  noise.dispose();
  return {
    actual: { atLifeQuarter: actualAtLifeQuarter, atLifeZero: actualAtLifeZero },
    disabled: disableOverLifeProbe,
    expected: { atLifeQuarter: expectedDissolved, atLifeZero: expectedVisible },
    life: OVER_LIFE_PROBE_LIFE,
    noise: OVER_LIFE_PROBE_NOISE / 255,
    ok,
    sample: { x: sampleX, y: sampleY },
    threshold: thresholdAtLifeQuarter,
  };
}

async function meshFxOpacityOverLifeGpuProbe(
  renderer: THREE.WebGPURenderer,
  runtime: ReturnType<typeof createThreeRuntimeRenderer>,
) {
  const noiseValue = 140;
  const noise = new THREE.DataTexture(
    new Uint8Array([noiseValue, noiseValue, noiseValue, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  noise.colorSpace = THREE.NoColorSpace;
  noise.magFilter = THREE.NearestFilter;
  noise.minFilter = THREE.NearestFilter;
  noise.needsUpdate = true;
  const probe = defineEffect({
    elements: {
      ring: meshFxElement(
        ring({
          innerRadius: 0.55,
          material: fxMaterial({
            blending: 'additive',
            color: '#2070ff',
            dissolve: {
              edgeColor: '#ffffff',
              edgeWidth: 0.2,
              overLife: curve([0, 0.1], [0.5, 0.4], [1, 0.7]),
              texture: noise,
            },
            opacityOverLife: disableOpacityOverLifeProbe
              ? 1
              : curve([0, 0.5], [0.4, 0.5], [0.5, 0.04], [1, 0]),
          }),
          outerRadius: 0.9,
          segments: 64,
        }),
        { duration: 1 },
      ),
    },
    timeline: timeline([at(0, play('ring'))], { duration: 1 }),
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const target = new THREE.RenderTarget(OVER_LIFE_PROBE_SIZE, OVER_LIFE_PROBE_SIZE, {
    depthBuffer: true,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  const system = new VFXSystem(runtime, scene);
  system.spawn(probe);
  await system.update(0);
  const capture = async (): Promise<Rgb> => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = compactRgba8Readback(
      new Uint8Array(
        await renderer.readRenderTargetPixelsAsync(
          target,
          0,
          0,
          OVER_LIFE_PROBE_SIZE,
          OVER_LIFE_PROBE_SIZE,
        ),
      ),
      OVER_LIFE_PROBE_SIZE,
      OVER_LIFE_PROBE_SIZE,
      true,
    );
    return rgb(pixels, 56, 32, OVER_LIFE_PROBE_SIZE);
  };
  const initial = await capture();
  await system.update(0.5);
  const edgePhase = await capture();
  await system.update(0.25);
  const faded = await capture();
  const energy = (value: Rgb) => value[0] + value[1] + value[2];
  const energies = {
    edgePhase: energy(edgePhase),
    faded: energy(faded),
    initial: energy(initial),
  };
  const ok =
    energies.initial > 40 &&
    energies.edgePhase > 0 &&
    energies.edgePhase < energies.initial &&
    energies.faded < energies.edgePhase;
  target.dispose();
  noise.dispose();
  return {
    actual: { edgePhase, faded, initial },
    disabled: disableOpacityOverLifeProbe,
    energies,
    noise: noiseValue / 255,
    ok,
  };
}

function paint(pixels: Uint8Array): void {
  const output = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < HEIGHT; y += 1) {
    const source = y * WIDTH * 4;
    const target = (HEIGHT - 1 - y) * WIDTH * 4;
    output.set(pixels.subarray(source, source + WIDTH * 4), target);
  }
  required<HTMLCanvasElement>('#timeline-visual')
    .getContext('2d')
    ?.putImageData(new ImageData(output, WIDTH, HEIGHT), 0, 0);
}

async function deterministicShakeProbe() {
  const samples = async () => {
    const values: CameraShakeSample[] = [];
    const probe = defineEffect({
      elements: {
        wave: ring({ material: fxMaterial({ color: '#ffffff' }) }),
      },
      timeline: timeline(
        [at(0, play('wave'), cameraShake({ duration: 0.12, frequency: 18, strength: 0.3 }))],
        { duration: 0.2 },
      ),
    });
    const system = new VFXSystem({}, new THREE.Scene(), {
      cameraShakeTarget: (sample) => values.push(sample),
    });
    system.spawn(probe, { seed: 0x1234abcd });
    for (let index = 0; index < 7; index += 1) await system.update(0.02);
    return values.map(({ decay, rotation, translation }) => ({ decay, rotation, translation }));
  };
  const first = await samples();
  const second = await samples();
  const decays = first.map(({ decay }) => decay).filter((value) => value > 0);
  return {
    byteEqual: JSON.stringify(first) === JSON.stringify(second),
    decays,
    monotonicDecay: decays.every((value, index) => index === 0 || value <= decays[index - 1]!),
    zeroTail: first.at(-1)?.decay === 0,
  };
}

async function loopSpeedProbe() {
  const probe = defineEffect({
    elements: { wave: ring({ material: fxMaterial() }) },
    timeline: timeline([at(0, play('wave')), at(0.05, stop('wave'))], {
      duration: 0.1,
      loop: 2,
      speed: 2,
    }),
  });
  const system = new VFXSystem({}, new THREE.Scene());
  const instance = system.spawn(probe);
  await system.update(0.025);
  const stoppedAtQuarterWorld = instance.getElementState('wave')?.playing === false;
  await system.update(0.025);
  return {
    cycle: instance.cycle,
    localTime: instance.localTime,
    restarted: instance.getElementState('wave')?.playing === true,
    stoppedAtQuarterWorld,
  };
}

async function stressProbe(runtime: ReturnType<typeof createThreeRuntimeRenderer>) {
  const stressEmitter = defineEmitter({
    capacity: 24,
    init: [lifetime(1)],
    integration: 'none',
    render: billboard({ blending: 'additive' }),
    spawn: burst({ count: 24 }),
  });
  const stressEffect = defineEffect({
    elements: { particles: stressEmitter },
    timeline: timeline([at(0, play('particles'))], { duration: 0.2, loop: true }),
  });
  const system = new VFXSystem(runtime, undefined, {
    fixedTimeStep: { stepSeconds: STEP },
    maxPoolSize: 1,
  });
  const instance = system.spawn(stressEffect, { seed: 99 });
  for (let frame = 0; frame < 600; frame += 1) await system.update(STEP);
  return {
    diagnostics: instance.diagnostics.map(({ code }) => code),
    playing: instance.getElementState('particles')?.playing === true,
    worldTime: system.time,
  };
}

async function measurePerformance(): Promise<void> {
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: true });
  renderer.setSize(64, 64);
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('M9 timeline perf requires WebGPU.');
  const runtime = createThreeRuntimeRenderer(
    renderer,
    adapter(renderer, backend),
    backend.device?.lost,
  );
  const scene = new THREE.Scene();
  const system = new VFXSystem(runtime, scene, { aliveCountReadbackInterval: 1 });
  system.spawn(createSkillSlash(noiseTexture()), { seed: 42 });
  const monitor = createPerformanceMonitor(renderer, {
    gpuScopes: ['compute', 'render'],
    mode: headless ? 'headless' : 'visual',
    page: 'm9-timeline',
  });
  await system.update(0.12);
  const target = new THREE.RenderTarget(64, 64);
  renderer.setRenderTarget(target);
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 10);
  camera.position.z = 5;
  await monitor.captureGpuSamples(async () => {
    await system.update(1 / 120);
    renderer.render(scene, camera);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  });
  renderer.setRenderTarget(null);
  target.dispose();
  renderer.dispose();
}

async function run(): Promise<void> {
  if (forceFailure !== null && forceFailure !== 'timeline-user-visible') {
    throw new Error(`Unknown M9 timeline fault: ${forceFailure}`);
  }
  root.dataset.rendererStatus = 'initializing';
  root.dataset.spikeStatus = 'running';
  const renderer = await createPlaygroundRenderer({ antialias: false, trackTimestamp: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  const backend = renderer.backend as BackendLike;
  if (!backend.isWebGPUBackend) throw new Error('M9 timeline smoke requires WebGPU.');
  root.dataset.backend = 'WebGPU';
  root.dataset.rendererStatus = 'ready';
  required<HTMLElement>('#backend-value').textContent = 'WebGPU';

  const runtime = createThreeRuntimeRenderer(
    renderer,
    adapter(renderer, backend),
    backend.device?.lost,
  );
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02050d);
  const receiver = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x10182a, roughness: 0.72 }),
  );
  receiver.position.z = -0.2;
  scene.add(receiver, new THREE.HemisphereLight(0x7fcfff, 0x050712, 0.35));
  const camera = new THREE.OrthographicCamera(-2.4, 2.4, 1.5, -1.5, 0.1, 20);
  camera.position.z = 5;
  const target = new THREE.RenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
  target.texture.colorSpace = THREE.NoColorSpace;
  const capture = async () => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    return compactRgba8Readback(
      new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT)),
      WIDTH,
      HEIGHT,
      true,
    );
  };

  const actionLog: Array<{ kind: string; localTime: number; worldTime: number }> = [];
  const shakeSamples: CameraShakeSample[] = [];
  const system = new VFXSystem(runtime, scene, {
    aliveCountReadbackInterval: 1,
    cameraShakeTarget: (sample) => shakeSamples.push(sample),
  });
  const effect = createSkillSlash(noiseTexture());
  const instance = system.spawn(effect, { position: [0.1, 0.05, 0], seed: 7109 });
  instance.onAction(({ action, localTime }) =>
    actionLog.push({ kind: action.kind, localTime, worldTime: system.time }),
  );
  let markerCount = 0;
  instance.onMarker('impact', () => {
    markerCount += 1;
  });
  const flashDeferredUntilUpdate = instance.getElementState('flash')?.playing !== true;

  await system.update(0.04);
  const flashView = instance.getEmitter('flash');
  if (!flashView) throw new Error('Flash emitter was not played at timeline time zero.');
  const flashAlive = await aliveCount(renderer, flashView);
  await system.update(0.01);
  const arcFirst = await capture();
  const arcVisibleAtPlay = instance.getElementState('arc')?.visible === true;
  await system.update(0.04);
  const hitStopSeparation = { localTime: instance.localTime, worldTime: system.time };
  await system.update(0.03);
  await system.update(0.01);
  const sparksView = instance.getEmitter('sparks');
  if (!sparksView) throw new Error('Sparks emitter did not play at 0.08 local seconds.');
  const sparksAlive = await aliveCount(renderer, sparksView);
  await system.update(0.01);
  const shockwaveVisible = instance.getElementState('shockwave')?.visible === true;

  const sparksDraw = materializeThreeSpriteDraw(sparksView.program, sparksView.kernels);
  scene.add(sparksDraw);
  const lightDraw = materializeThreeLightDraw(flashView.program, flashView.kernels);
  await lightDraw.update(renderer);
  await lightDraw.update(renderer);
  scene.add(lightDraw.group);
  const visualPixels = await capture();
  paint(visualPixels);

  await system.update(0.1);
  await system.update(0.1);
  const arcSecond = await capture();
  const curveChanged = changedPixels(arcFirst, arcSecond);
  const overLifeGpu = await meshFxOverLifeGpuProbe(renderer, runtime);
  const opacityOverLifeGpu = await meshFxOpacityOverLifeGpuProbe(renderer, runtime);
  const stateOwnershipGpu = await meshFxStateOwnershipGpuProbe(renderer);
  await system.update(0.15);
  const stopEffects = {
    arcHidden: instance.getElementState('arc')?.visible === false,
    shockwaveHidden: instance.getElementState('shockwave')?.visible === false,
    sparksStopped: instance.getElementState('sparks')?.playing === false,
  };

  const [shake, loop, stress] = await Promise.all([
    deterministicShakeProbe(),
    loopSpeedProbe(),
    stressProbe(runtime),
  ]);
  const visual = imageStats(visualPixels);
  const checks = {
    actionOrder:
      actionLog.map(({ kind }) => kind).join(',') ===
      'play,play,camera-shake,hit-stop,marker,play,play,stop,stop,stop',
    actionTimes: actionLog.every(
      ({ localTime }, index) =>
        Math.abs(localTime - [0, 0.05, 0.05, 0.05, 0.05, 0.08, 0.1, 0.2, 0.35, 0.45][index]!) <
        1e-7,
    ),
    aliveCounts: flashAlive === 1 && sparksAlive === 36,
    cameraShakeDeterministic: shake.byteEqual,
    cameraShakeDecay: shake.monotonicDecay && shake.zeroTail,
    consoleClean: consoleMessages.length === 0,
    curveChanged: curveChanged > 24,
    hitStopSeparation:
      Math.abs(hitStopSeparation.localTime - 0.05) < 1e-8 &&
      Math.abs(hitStopSeparation.worldTime - 0.09) < 1e-8,
    loopSpeed:
      loop.stoppedAtQuarterWorld &&
      loop.restarted &&
      loop.cycle === 1 &&
      Math.abs(loop.localTime) < 1e-8,
    markerCallback: markerCount === 1,
    meshFxOverLifeGpu: overLifeGpu.ok,
    meshFxOpacityOverLifeGpu: opacityOverLifeGpu.ok,
    meshFxStateOwnershipGpu: stateOwnershipGpu.ok,
    playEffects: flashDeferredUntilUpdate && arcVisibleAtPlay && shockwaveVisible,
    stopEffects: Object.values(stopEffects).every(Boolean),
    stress600:
      stress.playing && stress.diagnostics.length === 0 && Math.abs(stress.worldTime - 10) < 1e-5,
    visualReadback:
      visual.foregroundRatio > 0.01 &&
      visual.foregroundRatio < 0.55 &&
      visual.saturatedRatio < 0.08,
  };
  const ok = Object.values(checks).every(Boolean);
  const result = {
    checks,
    evidence: {
      actionLog,
      alive: { flash: flashAlive, sparks: sparksAlive },
      cameraShake: { deterministic: shake, sampleCount: shakeSamples.length },
      curveGpu: {
        changedPixels: curveChanged,
        expectedTexelSample: overLifeGpu,
        opacityFadeSample: opacityOverLifeGpu,
        times: [0.05, 0.3],
      },
      stateOwnershipGpu,
      hitStopSeparation,
      linearReadbackThreshold: 24,
      loop,
      stress,
      visual,
    },
    ok,
    schema: 'nachi.m9-timeline-smoke.v1',
  };
  await measurePerformance();
  root.dataset.artifactScreenshots = JSON.stringify(
    headless ? [] : [{ filename: 'm9-timeline.png', selector: '#timeline-visual' }],
  );
  root.dataset.spikeResult = JSON.stringify(result);
  root.dataset.sceneReady = 'true';
  root.dataset.spikeStatus = 'complete';
  required<HTMLElement>('#contract-value').textContent = ok ? 'all checks passed' : 'failed';
  target.dispose();
  lightDraw.dispose();
  renderer.dispose();
}

void run().catch((error) => {
  const text = message(error);
  root.dataset.rendererStatus = 'error';
  root.dataset.spikeError = text;
  root.dataset.spikeResult = JSON.stringify({ error: text, ok: false });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#contract-value').textContent = text;
  console.error(error);
});
