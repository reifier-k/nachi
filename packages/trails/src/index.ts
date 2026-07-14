import {
  VfxDiagnosticError,
  attribute,
  type AttributeDefinition,
  type BlendingMode,
  type CompiledDrawVertexDescription,
  type InitModule,
  type KernelModuleRegistry,
  type RenderModule,
  type TextureRef,
  type VfxDiagnostic,
} from '@nachi-vfx/core';

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

function diagnostic(code: string, message: string, path: string): VfxDiagnostic {
  return { code, message, path, phase: 'compile', severity: 'error' };
}

function collectRibbonIdDiagnostics(value: RibbonIdInput, path: string): VfxDiagnostic[] {
  return typeof value !== 'number' && (!Number.isSafeInteger(value.count) || value.count < 1)
    ? [
        diagnostic(
          'NACHI_RIBBON_ID_COUNT_INVALID',
          'Alternating ribbonId count must be a positive safe integer.',
          `${path}.count`,
        ),
      ]
    : [];
}

function collectRibbonDiagnostics(options: RibbonOptions, path: string): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const maxRibbons = options.maxRibbons ?? 1;
  const taper = { end: options.taper?.end ?? 0.15, start: options.taper?.start ?? 0.15 };
  if (
    options.blending !== undefined &&
    options.blending !== 'additive' &&
    options.blending !== 'alpha' &&
    options.blending !== 'multiply' &&
    options.blending !== 'premultiplied'
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_BLENDING_INVALID',
        'Ribbon blending must be "additive", "alpha", "multiply", or "premultiplied".',
        `${path}.blending`,
      ),
    );
  }
  if (!Number.isFinite(options.width) || options.width <= 0) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_WIDTH_INVALID',
        'Ribbon width must be a positive finite number.',
        `${path}.width`,
      ),
    );
  }
  if (!Number.isSafeInteger(maxRibbons) || maxRibbons <= 0 || maxRibbons > 64) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_COUNT_INVALID',
        'Ribbon maxRibbons must be a positive safe integer no greater than 64.',
        `${path}.maxRibbons`,
      ),
    );
  }
  if (
    !Number.isFinite(taper.start) ||
    !Number.isFinite(taper.end) ||
    taper.start < 0 ||
    taper.end < 0 ||
    taper.start + taper.end > 1
  ) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_TAPER_INVALID',
        'Ribbon taper fractions must be finite, non-negative, and sum to at most one.',
        `${path}.taper`,
      ),
    );
  }
  const uv = options.uv ?? { mode: 'stretched' as const };
  if (uv.mode === 'tiled' && (!Number.isFinite(uv.tileLength) || uv.tileLength <= 0)) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_TILE_LENGTH_INVALID',
        'Ribbon tiled UV mode requires a positive finite tileLength.',
        `${path}.uv.tileLength`,
      ),
    );
  }
  return diagnostics;
}

function throwIfInvalid(diagnostics: readonly VfxDiagnostic[]): void {
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
}

declare module '@nachi-vfx/core' {
  interface CompiledDrawDescriptionMap {
    readonly ribbon: CompiledRibbonDrawDescription;
  }
}

export function ribbonIdAttribute(): AttributeDefinition<'ribbonId', 'u32'> {
  return attribute('ribbonId', { default: 0, type: 'u32' });
}

export function ribbonId(value: RibbonIdInput): InitModule {
  throwIfInvalid(collectRibbonIdDiagnostics(value, 'config.value'));
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
  throwIfInvalid(collectRibbonDiagnostics(options, 'config'));
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
    validate(context) {
      const { value } = context.module.config as { readonly value: RibbonIdInput };
      for (const item of collectRibbonIdDiagnostics(value, `${context.path}.config.value`)) {
        context.diagnostic(item.code, item.message, item.path, item.severity);
      }
    },
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
      const configDiagnostics = collectRibbonDiagnostics(options, `${context.path}.config`);
      for (const item of configDiagnostics) {
        context.diagnostic(item.code, item.message, item.path, item.severity);
      }
      if (configDiagnostics.some(({ severity }) => severity === 'error')) return undefined;
      const uv = options.uv ?? { mode: 'stretched' as const };
      const vertex = context.vertex(['color', 'position'], {
        additionalStorageBuffers: [
          'NachiRibbonSegmentIndices',
          'NachiRibbonSegmentUvT',
          'NachiRibbonSegmentWidths',
        ],
        lifecycle: false,
      });
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
