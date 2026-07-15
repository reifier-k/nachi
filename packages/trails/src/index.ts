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

function collectRibbonIdDiagnostics(value: unknown, path: string): VfxDiagnostic[] {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
      ? []
      : [
          diagnostic(
            'NACHI_RIBBON_ID_VALUE_INVALID',
            'ribbonId must be a non-negative safe integer within the u32 range.',
            path,
          ),
        ];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [
      diagnostic(
        'NACHI_RIBBON_ID_VALUE_INVALID',
        'ribbonId must be a u32 integer or alternating configuration.',
        path,
      ),
    ];
  }
  const input = value as Readonly<Record<string, unknown>>;
  const diagnostics: VfxDiagnostic[] = [];
  if (input.mode !== 'alternating') {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_ID_MODE_INVALID',
        'ribbonId mode must be "alternating".',
        `${path}.mode`,
      ),
    );
  }
  const countValid =
    Number.isSafeInteger(input.count) &&
    (input.count as number) >= 1 &&
    (input.count as number) <= 0xffff_ffff;
  if (!countValid) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_ID_COUNT_INVALID',
        'Alternating ribbonId count must be a positive integer within the u32 range.',
        `${path}.count`,
      ),
    );
  }
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_ID_OFFSET_INVALID',
        'Alternating ribbonId offset must be a non-negative safe integer.',
        `${path}.offset`,
      ),
    );
  } else if (countValid && (offset as number) + (input.count as number) - 1 > 0xffff_ffff) {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_ID_OFFSET_INVALID',
        'Alternating ribbonId range must remain within u32.',
        `${path}.offset`,
      ),
    );
  }
  return diagnostics;
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
  if (uv.mode !== 'stretched' && uv.mode !== 'tiled') {
    diagnostics.push(
      diagnostic(
        'NACHI_RIBBON_UV_MODE_INVALID',
        'Ribbon UV mode must be "stretched" or "tiled".',
        `${path}.uv.mode`,
      ),
    );
  } else if (uv.mode === 'tiled' && (!Number.isFinite(uv.tileLength) || uv.tileLength <= 0)) {
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

function maximumRibbonId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Readonly<Record<string, unknown>>;
  const offset = input.offset ?? 0;
  if (
    input.mode !== 'alternating' ||
    !Number.isSafeInteger(input.count) ||
    (input.count as number) < 1 ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0
  ) {
    return undefined;
  }
  return (offset as number) + (input.count as number) - 1;
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
      const authoredRibbonIds = (context.definition.init ?? [])
        .filter((module) => module.type === 'trails/ribbon-id')
        .map((module) =>
          maximumRibbonId((module.config as Readonly<Record<string, unknown>>).value),
        )
        .filter((value): value is number => value !== undefined);
      const highestRibbonId = authoredRibbonIds.length === 0 ? 0 : Math.max(...authoredRibbonIds);
      if (highestRibbonId >= maxRibbons) {
        context.diagnostic(
          'NACHI_RIBBON_ID_OUT_OF_RANGE',
          `Ribbon maxRibbons ${maxRibbons} does not cover authored ribbonId ${highestRibbonId}.`,
          `${context.path}.config.maxRibbons`,
        );
        return undefined;
      }
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

export const VERSION = '0.1.0' as const;
