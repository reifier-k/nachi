import { describe, expect, it } from 'vitest';

import {
  VfxDiagnosticError,
  BUILT_IN_ATTRIBUTE_DEFAULTS,
  attribute,
  billboard,
  burst,
  defineEmitter,
  defineParameter,
  gravity,
  packedComponentIndex,
  packedElementIndex,
  resolveAttributeSchema,
  resolvePackedAttributeAddress,
  TSL_STORAGE_TYPE_PHYSICAL_LENGTHS,
} from '../src/index.js';
import type {
  AttributeDefinition,
  ModuleAccess,
  ModuleDefinition,
  ModuleStage,
  ResolvedAttribute,
  ResolvedAttributeStorage,
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
  it('defines deterministic defaults for every built-in attribute', () => {
    expect(BUILT_IN_ATTRIBUTE_DEFAULTS).toEqual({
      age: 0,
      alive: false,
      color: [1, 1, 1, 1],
      lifetime: 1,
      mass: 1,
      normalizedAge: 0,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      size: 1,
      spawnGeneration: 0,
      spriteRotation: 0,
      surfaceNormal: [0, 1, 0],
      velocity: [0, 0, 0],
    });
  });

  it.each([0, -5, 1.5, Number.NaN])('diagnoses invalid emitter capacity %s', (capacity) => {
    const result = resolveAttributeSchema({
      capacity,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'NACHI_CAPACITY_INVALID',
        path: 'capacity',
        phase: 'compile',
        severity: 'error',
      }),
    ]);
  });

  it('diagnoses attribute defaults with the wrong logical type or component count', () => {
    const invalid = (name: string, type: string, defaultValue: unknown) =>
      ({ default: defaultValue, kind: 'attribute', name, type }) as unknown as AttributeDefinition;
    const result = resolveAttributeSchema({
      attributes: {
        badBool: invalid('badBool', 'bool', 0),
        badFloat: invalid('badFloat', 'f32', [0]),
        badMat3: invalid(
          'badMat3',
          'mat3',
          Array.from({ length: 8 }, () => 0),
        ),
        badVec3: invalid('badVec3', 'vec3', [0, 0]),
      },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      Array.from({ length: 4 }, () => 'NACHI_ATTRIBUTE_DEFAULT_TYPE_MISMATCH'),
    );
    expect(result.diagnostics.map(({ path }) => path)).toEqual([
      'attributes.badBool.default',
      'attributes.badFloat.default',
      'attributes.badMat3.default',
      'attributes.badVec3.default',
    ]);
  });

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
    expect(result.value?.storageArrays).toHaveLength(8);
    expect(result.value?.capacity).toBe(1);
    expect(result.value?.storageArrays.every((storage) => storage.kind === 'instanced-array')).toBe(
      true,
    );
    expect(result.value?.storageArrays.every((storage) => storage.length >= 1)).toBe(true);
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
      'alive',
      'color',
      'size',
      'spriteRotation',
      'spawnGeneration',
    ]);
    expect(result.value?.attributes.every(({ source }) => source === 'built-in')).toBe(true);
    expect(result.value?.byName.position?.default).toEqual([0, 0, 0]);
    expect(result.value?.byName.velocity?.default).toEqual([0, 0, 0]);
    expect(result.value?.attributes.map(({ storageIndex }) => storageIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(result.value?.storageArrays.map(({ name }) => name)).toEqual([
      'packed_float',
      'packed_uint',
      'color',
    ]);
  });

  it('generates WGSL-safe, collision-free physical buffer names', () => {
    const result = resolveAttributeSchema({
      attributes: {
        '9heat-value': attribute('9heat-value', {
          default: [0, 0, 0, 0],
          type: 'vec4',
        }),
        _9heat_value: attribute('_9heat_value', {
          default: [0, 0, 0, 0],
          type: 'vec4',
        }),
        signed: attribute('signed', { default: 0, type: 'i32' }),
        temperature: attribute('temperature', { default: 0, type: 'f32' }),
      },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });
    const names = result.value?.storageArrays.map(({ name }) => name) ?? [];

    expect(names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('packed_float');
    expect(names).toContain('packed_int');
    expect(names).toContain('packed_uint');
    expect(names).toContain('_9heat_value');
    expect(names).toContain('_9heat_value_2');
  });

  it('rejects custom attribute names using the physical packed_ prefix', () => {
    const result = resolveAttributeSchema({
      attributes: {
        packed_float: attribute('packed_float', { default: 0, type: 'f32' }),
        packed_intensity: attribute('packed_intensity', { default: 0, type: 'f32' }),
      },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'NACHI_ATTRIBUTE_RESERVED_PREFIX',
          path: 'attributes.packed_float',
        }),
        expect.objectContaining({
          code: 'NACHI_ATTRIBUTE_RESERVED_PREFIX',
          path: 'attributes.packed_intensity',
        }),
      ]),
    );
  });

  it('round-trips every logical type through packed particle-major storage', () => {
    const result = resolveAttributeSchema({
      attributes: {
        aScalar: attribute('aScalar', { default: 0, type: 'f32' }),
        bVec3: attribute('bVec3', { default: [0, 0, 0], type: 'vec3' }),
        boolMixed: attribute('boolMixed', { default: false, type: 'bool' }),
        cVec3: attribute('cVec3', { default: [0, 0, 0], type: 'vec3' }),
        colorValue: attribute('colorValue', { default: [0, 0, 0, 0], type: 'color' }),
        dVec2: attribute('dVec2', { default: [0, 0], type: 'vec2' }),
        eVec2: attribute('eVec2', { default: [0, 0], type: 'vec2' }),
        fScalar: attribute('fScalar', { default: 0, type: 'f32' }),
        gScalar: attribute('gScalar', { default: 0, type: 'f32' }),
        intA: attribute('intA', { default: 0, type: 'i32' }),
        intB: attribute('intB', { default: 0, type: 'i32' }),
        mat3Value: attribute('mat3Value', {
          default: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          type: 'mat3',
        }),
        mat4Value: attribute('mat4Value', {
          default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          type: 'mat4',
        }),
        quatValue: attribute('quatValue', { default: [0, 0, 0, 1], type: 'quat' }),
        uintMixed: attribute('uintMixed', { default: 0, type: 'u32' }),
        vec4Value: attribute('vec4Value', { default: [0, 0, 0, 0], type: 'vec4' }),
      },
      capacity: 3,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });
    expect(result.ok).toBe(true);
    const schema = result.value!;
    const physical = schema.storageArrays.map((storage) => {
      const length = storage.length * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type];
      return storage.componentType === 'uint'
        ? new Uint32Array(length)
        : storage.componentType === 'int'
          ? new Int32Array(length)
          : new Float32Array(length);
    });
    const expected = new Map<string, number[]>();
    const paddedComponent = (attribute: ResolvedAttribute, component: number): number =>
      attribute.logicalType === 'mat3'
        ? Math.floor(component / 3) * 4 + (component % 3)
        : component;
    const physicalIndex = (
      attribute: ResolvedAttribute,
      storage: ResolvedAttributeStorage,
      particle: number,
      component: number,
    ): number => {
      if (storage.packed) {
        const address = resolvePackedAttributeAddress(attribute, storage);
        return packedElementIndex(particle, address) * 4 + address.offset + component;
      }
      return (
        particle * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type] +
        paddedComponent(attribute, component)
      );
    };

    for (const [attributeIndex, resolved] of schema.attributes.entries()) {
      const storage = schema.storageArrays[resolved.physical.bufferIndex]!;
      const array = physical[storage.index]!;
      const values: number[] = [];
      for (let particle = 0; particle < schema.capacity; particle += 1) {
        for (let component = 0; component < resolved.components; component += 1) {
          const value =
            resolved.logicalType === 'bool'
              ? (particle + component + attributeIndex) % 2
              : (attributeIndex + 1) * 100 + particle * 20 + component + 1;
          array[physicalIndex(resolved, storage, particle, component)] = value;
          values.push(value);
        }
      }
      expected.set(resolved.name, values);
    }

    expect(schema.byName.bVec3?.physical).toMatchObject({ group: 0, offset: 1 });
    expect(schema.byName.cVec3?.physical).toMatchObject({ group: 1, offset: 0 });
    expect(schema.byName.boolMixed?.physical).toMatchObject({ group: 0, offset: 2 });
    expect(schema.byName.uintMixed?.physical).toMatchObject({ group: 0, offset: 3 });
    const cVec3 = schema.byName.cVec3!;
    const floatStorage = schema.storageArrays[cVec3.physical.bufferIndex]!;
    const cVec3Address = resolvePackedAttributeAddress(cVec3, floatStorage);
    expect(packedElementIndex(2, cVec3Address)).toBe(2 * floatStorage.groupCount + 1);

    for (const resolved of schema.attributes) {
      const storage = schema.storageArrays[resolved.physical.bufferIndex]!;
      const array = physical[storage.index]!;
      const actual: number[] = [];
      for (let particle = 0; particle < schema.capacity; particle += 1) {
        for (let component = 0; component < resolved.components; component += 1) {
          const index = storage.packed
            ? packedComponentIndex(
                particle,
                resolvePackedAttributeAddress(resolved, storage),
                component,
              )
            : physicalIndex(resolved, storage, particle, component);
          actual.push(array[index] ?? Number.NaN);
        }
      }
      expect(actual, resolved.name).toEqual(expected.get(resolved.name));
    }
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
      expect.objectContaining({ name: 'alive', storageIndex: 0 }),
      expect.objectContaining({ name: 'spawnGeneration', storageIndex: 1 }),
      expect.objectContaining({
        name: 'heat',
        source: 'custom',
        storageIndex: 2,
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

  it('always materializes the M2 lifecycle attributes', () => {
    const result = resolveAttributeSchema({
      capacity: 3,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.value?.attributes.map(({ name }) => name)).toEqual(['alive', 'spawnGeneration']);
  });

  it('stores alive and spawnGeneration as uint arrays', () => {
    const result = resolveAttributeSchema({
      capacity: 3,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.value?.byName.alive).toMatchObject({ logicalType: 'bool', storageType: 'uint' });
    expect(result.value?.byName.spawnGeneration).toMatchObject({
      logicalType: 'u32',
      storageType: 'uint',
    });
  });

  it('reserves spawnGeneration against custom redeclaration', () => {
    const result = resolveAttributeSchema({
      attributes: {
        spawnGeneration: attribute('spawnGeneration', { default: 0, type: 'u32' }),
      },
      capacity: 1,
      render: testModule('render'),
      spawn: testModule('spawn'),
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'NACHI_ATTRIBUTE_RESERVED_NAME' }),
    );
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
    expect(result.value?.attributes.map(({ name }) => name)).toEqual(['alive', 'spawnGeneration']);
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

  it('rejects parameter declarations outside the User namespace', () => {
    let caught: unknown;
    try {
      defineEmitter({
        capacity: 1,
        parameters: {
          'System.time': defineParameter('System.time', { default: 0, type: 'f32' }),
        },
        render: testModule('render'),
        spawn: testModule('spawn'),
      });
    } catch (error) {
      caught = error;
    }

    expect(diagnosticCodes(caught)).toEqual(['NACHI_PARAMETER_NAMESPACE_INVALID']);
  });
});
