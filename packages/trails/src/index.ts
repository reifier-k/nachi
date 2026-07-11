import {
  attribute,
  type AttributeDefinition,
  type BlendingMode,
  type CompiledDrawVertexDescription,
  type InitModule,
  type KernelModuleRegistry,
  type RenderModule,
  type TextureRef,
} from '@nachi/core';

export type RibbonUvMode =
  | { readonly mode: 'stretched' }
  | { readonly mode: 'tiled'; readonly tileLength: number };

export interface RibbonOptions {
  readonly blending?: BlendingMode;
  readonly map?: TextureRef;
  /** Number of ribbonId values scanned by the GPU preparation pass. */
  readonly maxRibbons?: number;
  readonly taper?: { readonly end?: number; readonly start?: number };
  readonly uv?: RibbonUvMode;
  readonly width: number;
}

export type RibbonIdInput =
  | number
  | { readonly count: number; readonly mode: 'alternating'; readonly offset?: number };

export interface CompiledRibbonDrawDescription {
  readonly fragment: { readonly blending: BlendingMode; readonly map?: TextureRef };
  readonly geometry: {
    readonly maxSegments: number;
    readonly topology: 'triangle-list';
  };
  readonly kind: 'ribbon';
  readonly ordering: {
    readonly key: readonly ['Particles.ribbonId', 'Particles.spawnOrder'];
    readonly source: 'gpu-birth-ring';
  };
  readonly path: string;
  readonly requiresBackend: 'webgpu';
  readonly uv: RibbonUvMode;
  readonly vertex: CompiledDrawVertexDescription & {
    readonly maxRibbons: number;
    readonly taper: { readonly end: number; readonly start: number };
    readonly width: number;
  };
}

declare module '@nachi/core' {
  interface CompiledDrawDescriptionMap {
    readonly ribbon: CompiledRibbonDrawDescription;
  }
}

export function ribbonIdAttribute(): AttributeDefinition<'ribbonId', 'u32'> {
  return attribute('ribbonId', { default: 0, type: 'u32' });
}

export function ribbonId(value: RibbonIdInput): InitModule {
  return {
    access: {
      reads: ['Particles.spawnOrder'],
      writes: ['Particles.ribbonId'],
    },
    config: { value },
    kind: 'module',
    stage: 'init',
    type: 'trails/ribbon-id',
    version: 1,
  };
}

export function ribbon(options: RibbonOptions): RenderModule {
  return {
    access: {
      reads: [
        'Particles.alive',
        'Particles.color',
        'Particles.position',
        'Particles.ribbonId',
        'Particles.spawnOrder',
      ],
      writes: [],
    },
    config: options,
    kind: 'module',
    stage: 'render',
    type: 'trails/ribbon',
    version: 1,
  };
}

export function registerTrails(registry: KernelModuleRegistry): KernelModuleRegistry {
  registry.register({
    access: { reads: ['Particles.spawnOrder'], writes: ['Particles.ribbonId'] },
    build(context) {
      const { value } = context.module.config as { readonly value: RibbonIdInput };
      if (typeof value === 'number') {
        context.write('ribbonId', context.adapter.constant(value, 'u32'));
        return;
      }
      const order = context.attribute('spawnOrder');
      const count = context.adapter.uint(value.count);
      const remainder = order.sub(order.div(count).mul(count));
      context.write('ribbonId', remainder.add(context.adapter.uint(value.offset ?? 0)));
    },
    stage: 'init',
    type: 'trails/ribbon-id',
    version: 1,
  });

  registry.register({
    access: {
      reads: [
        'Particles.alive',
        'Particles.color',
        'Particles.position',
        'Particles.ribbonId',
        'Particles.spawnOrder',
      ],
      writes: [],
    },
    compileDraw(context) {
      const options = context.module.config as RibbonOptions;
      const maxRibbons = options.maxRibbons ?? 1;
      const taper = { end: options.taper?.end ?? 0.15, start: options.taper?.start ?? 0.15 };
      if (!Number.isFinite(options.width) || options.width <= 0) {
        context.diagnostic(
          'NACHI_RIBBON_WIDTH_INVALID',
          'Ribbon width must be a positive finite number.',
          `${context.path}.config.width`,
        );
      }
      if (!Number.isSafeInteger(maxRibbons) || maxRibbons <= 0 || maxRibbons > 64) {
        context.diagnostic(
          'NACHI_RIBBON_COUNT_INVALID',
          'Ribbon maxRibbons must be a positive safe integer no greater than 64.',
          `${context.path}.config.maxRibbons`,
        );
      }
      if (
        !Number.isFinite(taper.start) ||
        !Number.isFinite(taper.end) ||
        taper.start < 0 ||
        taper.end < 0 ||
        taper.start + taper.end > 1
      ) {
        context.diagnostic(
          'NACHI_RIBBON_TAPER_INVALID',
          'Ribbon taper fractions must be finite, non-negative, and sum to at most one.',
          `${context.path}.config.taper`,
        );
      }
      const uv = options.uv ?? { mode: 'stretched' as const };
      if (uv.mode === 'tiled' && (!Number.isFinite(uv.tileLength) || uv.tileLength <= 0)) {
        context.diagnostic(
          'NACHI_RIBBON_TILE_LENGTH_INVALID',
          'Ribbon tiled UV mode requires a positive finite tileLength.',
          `${context.path}.config.uv.tileLength`,
        );
      }
      const vertex = context.vertex(['alive', 'color', 'position', 'ribbonId', 'spawnOrder']);
      if (!vertex) return undefined;
      return {
        fragment: {
          blending: options.blending ?? 'alpha',
          ...(options.map === undefined ? {} : { map: options.map }),
        },
        geometry: {
          maxSegments: Math.max(0, context.capacity - 1),
          topology: 'triangle-list',
        },
        kind: 'ribbon',
        ordering: {
          key: ['Particles.ribbonId', 'Particles.spawnOrder'],
          source: 'gpu-birth-ring',
        },
        path: context.path,
        requiresBackend: 'webgpu',
        uv,
        vertex: { ...vertex, maxRibbons, taper, width: options.width },
      } satisfies CompiledRibbonDrawDescription;
    },
    stage: 'render',
    type: 'trails/ribbon',
    version: 1,
  });
  return registry;
}

export const VERSION = '0.0.0' as const;
