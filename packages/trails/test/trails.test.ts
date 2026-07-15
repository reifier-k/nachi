import {
  VfxDiagnosticError,
  burst,
  compileEmitter,
  createCoreKernelModuleRegistry,
  defineEmitter,
  lifetime,
} from '@nachi-vfx/core';
import { describe, expect, it } from 'vitest';

import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '../src/index.js';

function compileRibbon(
  options: Parameters<typeof ribbon>[0] = {
    maxRibbons: 2,
    uv: { mode: 'tiled', tileLength: 0.5 },
    width: 0.4,
  },
  id: Parameters<typeof ribbonId>[0] = { count: 2, mode: 'alternating' },
) {
  const registry = registerTrails(createCoreKernelModuleRegistry());
  return compileEmitter(
    defineEmitter({
      attributes: { ribbonId: ribbonIdAttribute() },
      capacity: 16,
      init: [lifetime(1), ribbonId(id)],
      integration: 'none',
      render: ribbon(options),
      spawn: burst({ count: 8 }),
    }),
    { registry },
  );
}

function compileRawRibbon(
  options: Parameters<typeof ribbon>[0],
  id: Parameters<typeof ribbonId>[0] = { count: 2, mode: 'alternating' },
) {
  const registry = registerTrails(createCoreKernelModuleRegistry());
  const render = { ...ribbon({ width: 0.4 }), config: options };
  const init = { ...ribbonId(0), config: { value: id } };
  return compileEmitter(
    defineEmitter({
      attributes: { ribbonId: ribbonIdAttribute() },
      capacity: 16,
      init: [lifetime(1), init],
      integration: 'none',
      render,
      spawn: burst({ count: 8 }),
    }),
    { registry },
  );
}

describe('@nachi-vfx/trails renderer registration', () => {
  it('throws taper diagnostics immediately from the ribbon factory', () => {
    try {
      ribbon({ taper: { end: 0.6, start: 0.6 }, width: 0.2 });
      throw new Error('Expected ribbon() to reject an invalid taper.');
    } catch (error) {
      expect(error).toBeInstanceOf(VfxDiagnosticError);
      expect((error as VfxDiagnosticError).diagnostics).toContainEqual(
        expect.objectContaining({ code: 'NACHI_RIBBON_TAPER_INVALID', path: 'config.taper' }),
      );
    }
  });

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
    const program = compileRawRibbon({
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

  it('diagnoses an alternating ribbonId count that would divide by zero on the GPU', () => {
    const program = compileRawRibbon({ width: 0.4 }, { count: 0, mode: 'alternating' });

    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_RIBBON_ID_COUNT_INVALID',
        path: 'init[1].config.value.count',
      }),
    );
  });

  it('keeps alternating count and offset within their u32 implementation boundaries', () => {
    expect(() => ribbonId({ count: 0xffff_ffff, mode: 'alternating' })).not.toThrow();
    expect(() => ribbonId({ count: 2, mode: 'alternating', offset: 0xffff_fffe })).not.toThrow();
    expect(() => ribbonId({ count: 0x1_0000_0000, mode: 'alternating' })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_RIBBON_ID_COUNT_INVALID' })],
      }),
    );
    expect(() => ribbonId({ count: 2, mode: 'alternating', offset: 0xffff_ffff })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_RIBBON_ID_OFFSET_INVALID' })],
      }),
    );

    const validCount = compileRawRibbon(
      { width: 0.4 },
      { count: 0xffff_ffff, mode: 'alternating' },
    );
    expect(validCount.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_RIBBON_ID_COUNT_INVALID',
    );
    const validOffset = compileRawRibbon(
      { width: 0.4 },
      { count: 2, mode: 'alternating', offset: 0xffff_fffe },
    );
    expect(validOffset.diagnostics.map(({ code }) => code)).not.toContain(
      'NACHI_RIBBON_ID_OFFSET_INVALID',
    );
    expect(
      compileRawRibbon({ width: 0.4 }, { count: 0x1_0000_0000, mode: 'alternating' }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'NACHI_RIBBON_ID_COUNT_INVALID' }));
    expect(
      compileRawRibbon({ width: 0.4 }, { count: 2, mode: 'alternating', offset: 0xffff_ffff })
        .diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'NACHI_RIBBON_ID_OFFSET_INVALID' }));
  });

  it.each([
    [Number.NaN, 'NACHI_RIBBON_ID_VALUE_INVALID'],
    [-1, 'NACHI_RIBBON_ID_VALUE_INVALID'],
    [1.5, 'NACHI_RIBBON_ID_VALUE_INVALID'],
    [{ count: 2, mode: 'alternating', offset: -1 }, 'NACHI_RIBBON_ID_OFFSET_INVALID'],
    [{ count: 2, mode: 'alternating', offset: 1.5 }, 'NACHI_RIBBON_ID_OFFSET_INVALID'],
    [{ count: 2, mode: 'round-robin' }, 'NACHI_RIBBON_ID_MODE_INVALID'],
  ])('rejects invalid ribbonId input %j', (input, code) => {
    expect(() => ribbonId(input as never)).toThrowError(
      expect.objectContaining({ diagnostics: [expect.objectContaining({ code })] }),
    );
  });

  it('rejects unknown UV modes instead of silently lowering them as stretched', () => {
    expect(() => ribbon({ uv: { mode: 'atlas' } as never, width: 0.4 })).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'NACHI_RIBBON_UV_MODE_INVALID' })],
      }),
    );
  });

  it('requires maxRibbons to cover every statically authored ribbonId', () => {
    const program = compileRawRibbon({ maxRibbons: 2, width: 0.4 }, 2);
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_RIBBON_ID_OUT_OF_RANGE' }),
    );
    expect(() => compileRibbon({ maxRibbons: 2, width: 0.4 }, 1)).not.toThrow();
  });

  it('diagnoses invalid ribbon blending instead of silently using normal blending', () => {
    const program = compileRawRibbon({ blending: 'screen' as never, width: 0.4 });

    expect(program.draws).toEqual([]);
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_RIBBON_BLENDING_INVALID',
        path: 'render[0].config.blending',
      }),
    );
  });

  it('keeps stretched UV and endpoint taper defaults serializable', () => {
    const definition = ribbon({ width: 0.25 });
    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
    const draw = compileRibbon({ width: 0.25 }, 0).draws[0];
    expect(draw).toMatchObject({
      kind: 'ribbon',
      uv: { mode: 'stretched' },
      vertex: { taper: { end: 0.15, start: 0.15 } },
    });
  });
});
