import {
  attribute,
  pcgRandomFloat,
  resolveModuleSlot,
  resolveRandomSampleSlot,
  type InitModule,
  type KernelModuleRegistry,
  type ModuleAccess,
  type Vec3,
} from '@nachi-vfx/core';

const PILLAR_RING_RADIUS = 1.05;
const RING_STEP = (Math.PI * 2) / 7;
const RING_PHASE = 0.45;
const FLOOR_Y = -0.95;

export const ICE_SPARKLE_JITTER_ATTRIBUTE = 'iceSparkleJitter';
export const ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS = [1, 2, 4] as const;
/** Compiler defaults are normalized at index 0; this is authored Init slot 0. */
export const ICE_SPARKLE_JITTER_NORMALIZED_STAGE_INDEX = 1;

export const iceSparkleJitterAttribute = attribute(ICE_SPARKLE_JITTER_ATTRIBUTE, {
  default: [0, 0, 0],
  type: 'vec3',
});

export const ICE_SPARKLE_JITTER_ACCESS = {
  reads: ['Emitter.seed', 'Particles.spawnOrder'],
  writes: [`Particles.${ICE_SPARKLE_JITTER_ATTRIBUTE}`],
} as const satisfies ModuleAccess;

export const ICE_SPARKLE_PLACEMENT_ACCESS = {
  reads: [
    'Emitter.spawnInterpolatedTransform',
    `Particles.${ICE_SPARKLE_JITTER_ATTRIBUTE}`,
    'Particles.spawnOrder',
  ],
  writes: ['Particles.position'],
} as const satisfies ModuleAccess;

const jitterInit: InitModule = {
  access: ICE_SPARKLE_JITTER_ACCESS,
  config: {},
  kind: 'module',
  stage: 'init',
  type: 'showcase/ice-sparkle-local-jitter',
  version: 1,
};

const placementInit: InitModule = {
  access: ICE_SPARKLE_PLACEMENT_ACCESS,
  config: {},
  kind: 'module',
  stage: 'init',
  type: 'showcase/ice-sparkle-placement',
  version: 1,
};

/**
 * Slot 0 owns a local jitter attribute and intentionally consumes the same
 * keyed samples as positionSphere. Slot 1 places that local sample and applies
 * the spawn transform exactly once, while lifetime remains in slot 2.
 */
export const iceSparkleInitModules = [jitterInit, placementInit] as const;

export function registerIceSparklePlacement(registry: KernelModuleRegistry): void {
  registry.register({
    access: ICE_SPARKLE_JITTER_ACCESS,
    build(context) {
      const z = context.random(ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS[0]).mul(2).sub(1);
      const azimuth = context.random(ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS[1]).mul(Math.PI * 2);
      const horizontal = context.adapter.constant(1, 'f32').sub(z.mul(z)).clamp(0, 1).sqrt();
      const distance = context.random(ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS[2]).pow(1 / 3);
      context.write(
        ICE_SPARKLE_JITTER_ATTRIBUTE,
        context.adapter
          .vec3(
            context.adapter.cos(azimuth).mul(horizontal),
            z,
            context.adapter.sin(azimuth).mul(horizontal),
          )
          .mul(distance),
      );
    },
    stage: 'init',
    type: jitterInit.type,
    version: jitterInit.version,
  });
  registry.register({
    access: ICE_SPARKLE_PLACEMENT_ACCESS,
    build(context) {
      const modulo = context.adapter.mod;
      if (!modulo) throw new Error('Ice sparkle placement requires integer modulo support.');
      const transform = context.uniform('Emitter.spawnInterpolatedTransform');
      const jitter = context.attribute(ICE_SPARKLE_JITTER_ATTRIBUTE);
      const slot = modulo(context.attribute('spawnOrder'), 8)
        .toFloat()
        .mul(1 / 8);
      const centerness = context.adapter.select(slot.greaterThanEqual(0.8), 1, 0);
      const theta = slot.mul(8 * RING_STEP).add(RING_PHASE);
      const radius = context.adapter.constant(1, 'f32').sub(centerness).mul(PILLAR_RING_RADIUS);
      const span = context.adapter.constant(1.5, 'f32').add(centerness.mul(0.9));
      const local = context.adapter.vec3(
        context.adapter.cos(theta).mul(radius).add(jitter.x.mul(0.2)),
        jitter.y
          .mul(0.5)
          .add(0.5)
          .mul(span)
          .add(FLOOR_Y + 0.05),
        context.adapter.sin(theta).mul(radius).add(jitter.z.mul(0.2)),
      );
      const world = transform.mul(context.adapter.vec4(local.x, local.y, local.z, 1)).xyz;
      context.write('position', world);
    },
    stage: 'init',
    type: placementInit.type,
    version: placementInit.version,
  });
}

/** CPU mirror used by the offset/rotation regression probe. */
export function sampleIceSparkleJitter(spawnOrder: number, seed: number): Vec3 {
  const moduleSlot = resolveModuleSlot(
    { stage: 'init' },
    ICE_SPARKLE_JITTER_NORMALIZED_STAGE_INDEX,
  );
  const random = (sampleOffset: number) =>
    pcgRandomFloat(spawnOrder, seed, resolveRandomSampleSlot(moduleSlot, sampleOffset), 0);
  const z = random(ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS[0]) * 2 - 1;
  const azimuth = random(ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS[1]) * Math.PI * 2;
  const horizontal = Math.sqrt(Math.max(0, 1 - z * z));
  const distance = Math.cbrt(random(ICE_SPARKLE_RANDOM_SAMPLE_OFFSETS[2]));
  return [
    Math.cos(azimuth) * horizontal * distance,
    z * distance,
    Math.sin(azimuth) * horizontal * distance,
  ];
}

export function placeIceSparkleLocal(jitter: Vec3, spawnOrder: number): Vec3 {
  const slot = (spawnOrder % 8) / 8;
  const centerness = slot >= 0.8 ? 1 : 0;
  const theta = slot * 8 * RING_STEP + RING_PHASE;
  const radius = (1 - centerness) * PILLAR_RING_RADIUS;
  const span = 1.5 + centerness * 0.9;
  return [
    Math.cos(theta) * radius + jitter[0] * 0.2,
    (jitter[1] * 0.5 + 0.5) * span + FLOOR_Y + 0.05,
    Math.sin(theta) * radius + jitter[2] * 0.2,
  ];
}

export function sampleIceSparkleLocal(spawnOrder: number, seed: number): Vec3 {
  return placeIceSparkleLocal(sampleIceSparkleJitter(spawnOrder, seed), spawnOrder);
}
