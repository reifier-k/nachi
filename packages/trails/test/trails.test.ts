import {
  burst,
  compileEmitter,
  createCoreKernelModuleRegistry,
  defineEmitter,
  lifetime,
} from '@nachi/core';
import { describe, expect, it } from 'vitest';

import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '../src/index.js';

function compileRibbon(
  options: Parameters<typeof ribbon>[0] = {
    maxRibbons: 2,
    uv: { mode: 'tiled', tileLength: 0.5 },
    width: 0.4,
  },
) {
  const registry = registerTrails(createCoreKernelModuleRegistry());
  return compileEmitter(
    defineEmitter({
      attributes: { ribbonId: ribbonIdAttribute() },
      capacity: 16,
      init: [lifetime(1), ribbonId({ count: 2, mode: 'alternating' })],
      integration: 'none',
      render: ribbon(options),
      spawn: burst({ count: 8 }),
    }),
    { registry },
  );
}

describe('@nachi/trails renderer registration', () => {
  it('compiles through the core registry while retaining trails package ownership', () => {
    const program = compileRibbon();

    expect(program.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(program.attributeSchema.byName).toHaveProperty('spawnOrder');
    expect(program.draws).toHaveLength(1);
    expect(program.draws[0]).toMatchObject({
      kind: 'ribbon',
      ordering: {
        key: ['Particles.ribbonId', 'Particles.spawnOrder'],
        source: 'gpu-birth-ring',
      },
      requiresBackend: 'webgpu',
      uv: { mode: 'tiled', tileLength: 0.5 },
      vertex: { maxRibbons: 2, width: 0.4 },
    });
  });

  it('emits structured diagnostics for invalid width, taper, ribbon count, and tiling', () => {
    const program = compileRibbon({
      maxRibbons: 0,
      taper: { end: 0.7, start: 0.7 },
      uv: { mode: 'tiled', tileLength: 0 },
      width: 0,
    });

    expect(program.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'NACHI_RIBBON_COUNT_INVALID',
        'NACHI_RIBBON_TAPER_INVALID',
        'NACHI_RIBBON_TILE_LENGTH_INVALID',
        'NACHI_RIBBON_WIDTH_INVALID',
      ]),
    );
  });

  it('keeps stretched UV and endpoint taper defaults serializable', () => {
    const definition = ribbon({ width: 0.25 });
    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
    const draw = compileRibbon({ width: 0.25 }).draws[0];
    expect(draw).toMatchObject({
      kind: 'ribbon',
      uv: { mode: 'stretched' },
      vertex: { taper: { end: 0.15, start: 0.15 } },
    });
  });
});
