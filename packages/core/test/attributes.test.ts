import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  attribute,
  billboard,
  burst,
  defineEmitter,
  defineParameter,
  gravity,
  resolveAttributeSchema,
} from '../src/index.js';
import type {
  AttributeDefinition,
  ModuleAccess,
  ModuleDefinition,
  ModuleStage,
} from '../src/index.js';

function testModule<Stage extends ModuleStage>(
  stage: Stage,
  access: ModuleAccess = { reads: [], writes: [] },
  label?: string,
): ModuleDefinition<Stage, Record<string, never>> {
  const definition = {
    access,
    config: {},
    kind: 'module' as const,
    stage,
    type: `test/${stage}`,
    version: 1,
  };
  return label === undefined ? definition : { ...definition, label };
}

function diagnosticCodes(error: unknown): string[] {
  expect(error).toBeInstanceOf(VfxDiagnosticError);
  return error instanceof VfxDiagnosticError
    ? error.diagnostics.map((diagnostic) => diagnostic.code)
    : [];
}

describe('resolved attribute schema', () => {
  it('maps all eleven logical types to TSL instanced-array storage types', () => {
    const result = resolveAttributeSchema({
      attributes: {
        boolValue: attribute('boolValue', { default: false, type: 'bool' }),
        colorValue: attribute('colorValue', { default: [1, 1, 1, 1], type: 'color' }),
        floatValue: attribute('floatValue', { default: 0, type: 'f32' }),
        intValue: attribute('intValue', { default: 0, type: 'i32' }),
        mat3Value: attribute('mat3Value', {
          default: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          type: 'mat3',
        }),
        mat4Value: attribute('mat4Value', {
          default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          type: 'mat4',
        }),
        quatValue: attribute('quatValue', { default: [0, 0, 0, 1], type: 'quat' }),
        uintValue: attribute('uintValue', { default: 0, type: 'u32' }),
        vec2Value: attribute('vec2Value', { default: [0, 0], type: 'vec2' }),
        vec3Value: attribute('vec3Value', { default: [0, 0, 0], type: 'vec3' }),
        vec4Value: attribute('vec4Value', { default: [0, 0, 0, 0], type: 'vec4' }),
      },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.ok).toBe(true);
    const layouts = Object.fromEntries(
      result.value?.attributes.map(({ components, logicalType, storageType }) => [
        logicalType,
        { components, storageType },
      ]) ?? [],
    );
    expect(layouts).toEqual({
      bool: { components: 1, storageType: 'uint' },
      color: { components: 4, storageType: 'vec4' },
      f32: { components: 1, storageType: 'float' },
      i32: { components: 1, storageType: 'int' },
      mat3: { components: 9, storageType: 'mat3' },
      mat4: { components: 16, storageType: 'mat4' },
      quat: { components: 4, storageType: 'vec4' },
      u32: { components: 1, storageType: 'uint' },
      vec2: { components: 2, storageType: 'vec2' },
      vec3: { components: 3, storageType: 'vec3' },
      vec4: { components: 4, storageType: 'vec4' },
    });
    expect(result.value?.storageArrays).toHaveLength(11);
    expect(result.value?.capacity).toBe(1);
    expect(result.value?.storageArrays.every((storage) => storage.kind === 'instanced-array')).toBe(
      true,
    );
    expect(result.value?.storageArrays.every((storage) => storage.length === 1)).toBe(true);
  });

  it('resolves used built-ins in canonical SoA order', () => {
    const emitter = defineEmitter({
      capacity: 16,
      render: billboard({}),
      spawn: burst({ count: 1 }),
      update: [gravity(-9.8)],
    });
    const result = resolveAttributeSchema(emitter);

    expect(result.value?.layout).toBe('soa');
    expect(result.value?.attributes.map(({ name }) => name)).toEqual([
      'position',
      'velocity',
      'color',
      'size',
      'spriteRotation',
    ]);
    expect(result.value?.attributes.every(({ source }) => source === 'built-in')).toBe(true);
    expect(result.value?.storageArrays.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('retains an unused custom attribute and its transient metadata', () => {
    const result = resolveAttributeSchema({
      attributes: {
        heat: attribute('heat', { default: 0, transient: true, type: 'f32' }),
      },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.value?.attributes).toEqual([
      expect.objectContaining({
        name: 'heat',
        source: 'custom',
        storageIndex: 0,
        storageType: 'float',
        transient: true,
      }),
    ]);
  });

  it('diagnoses an unknown logical type', () => {
    const invalidDefinition = {
      default: 0,
      kind: 'attribute',
      name: 'mystery',
      type: 'texture',
    } as unknown as AttributeDefinition;
    const result = resolveAttributeSchema({
      attributes: { mystery: invalidDefinition },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_ATTRIBUTE_UNKNOWN_TYPE',
        path: 'attributes.mystery.type',
        phase: 'compile',
        severity: 'error',
      }),
    ]);
  });

  it('diagnoses a custom declaration that collides with a built-in name', () => {
    const result = resolveAttributeSchema({
      attributes: {
        position: attribute('position', { default: [0, 0, 0], type: 'vec3' }),
      },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.diagnostics.map(({ code }) => code)).toEqual(['NACHI_ATTRIBUTE_RESERVED_NAME']);
  });

  it('accumulates duplicate declarations and key/name mismatches', () => {
    const heat = attribute('heat', { default: 0, type: 'f32' });
    const result = resolveAttributeSchema({
      attributes: { heat, heatAlias: heat },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_ATTRIBUTE_KEY_MISMATCH',
      'NACHI_ATTRIBUTE_DUPLICATE',
    ]);
  });

  it('accumulates unknown required reads and writes across a module manifest', () => {
    const result = resolveAttributeSchema({
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
      update: [
        testModule('update', {
          reads: ['Particles.missingRead'],
          writes: ['Particles.missingWrite'],
        }),
      ],
    });

    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'NACHI_ATTRIBUTE_UNKNOWN_REFERENCE',
      'NACHI_ATTRIBUTE_UNKNOWN_REFERENCE',
    ]);
    expect(result.diagnostics.map(({ path }) => path)).toEqual([
      'update[0].access.reads[0]',
      'update[0].access.writes[0]',
    ]);
  });

  it('allows a missing optional particle read without allocating it', () => {
    const result = resolveAttributeSchema({
      capacity: 1,
      render: testModule('render', {
        optionalReads: ['Particles.optionalInput'],
        reads: [],
        writes: [],
      }),
      spawn: testModule('spawn'),
    });

    expect(result).toMatchObject({ diagnostics: [], ok: true });
    expect(result.value?.attributes).toEqual([]);
  });

  it('throws one diagnostic error containing independent normalization failures', () => {
    const reservedSpawn = { ...burst({ count: 1 }), label: '$spawn' };
    let caught: unknown;

    try {
      defineEmitter({
        attributes: {
          heatAlias: attribute('heat', { default: 0, type: 'f32' }),
        },
        capacity: 1,
        parameters: {
          'User.alias': defineParameter('User.actual', { default: 1, type: 'f32' }),
        },
        render: testModule('render'),
        spawn: reservedSpawn,
        update: [testModule('update', { reads: ['Particles.unknown'], writes: [] }, '$update')],
      });
    } catch (error) {
      caught = error;
    }

    expect(diagnosticCodes(caught)).toEqual([
      'NACHI_ATTRIBUTE_KEY_MISMATCH',
      'NACHI_ATTRIBUTE_UNKNOWN_REFERENCE',
      'NACHI_MODULE_RESERVED_LABEL',
      'NACHI_MODULE_RESERVED_LABEL',
      'NACHI_PARAMETER_KEY_MISMATCH',
    ]);
  });

  it('rejects duplicate labels within a stage but permits the same label across stages', () => {
    expect(() =>
      defineEmitter({
        capacity: 1,
        render: testModule('render'),
        spawn: testModule('spawn'),
        update: [
          testModule('update', undefined, 'stable'),
          testModule('update', undefined, 'stable'),
        ],
      }),
    ).toThrow('duplicated in the update stage');

    expect(() =>
      defineEmitter({
        capacity: 1,
        render: testModule('render', undefined, 'shared'),
        spawn: testModule('spawn', undefined, 'shared'),
      }),
    ).not.toThrow();
  });
});
