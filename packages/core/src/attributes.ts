import { collectEmitterModules } from './emitter-modules.js';
import type {
  AttributeComponentCount,
  AttributeDefinition,
  AttributeSchema,
  AttributeType,
  CompileResult,
  EmitterConfig,
  EmptyParameterSchema,
  ParameterSchema,
  ResolvedAttribute,
  ResolvedAttributeSchema,
  TslStorageType,
  VfxDiagnostic,
} from './types.js';

type AttributeLayout = {
  readonly components: AttributeComponentCount;
  readonly storageType: TslStorageType;
};

const ATTRIBUTE_LAYOUTS: Readonly<Record<AttributeType, AttributeLayout>> = {
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
};

export function resolveTslStorageType(type: AttributeType): TslStorageType {
  return ATTRIBUTE_LAYOUTS[type].storageType;
}

export const BUILT_IN_ATTRIBUTE_DEFAULTS = {
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
  spriteRotation: 0,
  spawnGeneration: 0,
  velocity: [0, 0, 0],
} as const;

const BUILT_IN_ATTRIBUTES = [
  ['position', 'vec3', BUILT_IN_ATTRIBUTE_DEFAULTS.position],
  ['velocity', 'vec3', BUILT_IN_ATTRIBUTE_DEFAULTS.velocity],
  ['age', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.age],
  ['lifetime', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.lifetime],
  ['normalizedAge', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.normalizedAge],
  ['alive', 'bool', BUILT_IN_ATTRIBUTE_DEFAULTS.alive],
  ['color', 'color', BUILT_IN_ATTRIBUTE_DEFAULTS.color],
  ['size', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.size],
  ['scale', 'vec3', BUILT_IN_ATTRIBUTE_DEFAULTS.scale],
  ['rotation', 'quat', BUILT_IN_ATTRIBUTE_DEFAULTS.rotation],
  ['spriteRotation', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.spriteRotation],
  ['spawnGeneration', 'u32', BUILT_IN_ATTRIBUTE_DEFAULTS.spawnGeneration],
  ['mass', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.mass],
] as const satisfies readonly (readonly [string, AttributeType, unknown])[];

const BUILT_IN_TYPES = new Map<string, AttributeType>(
  BUILT_IN_ATTRIBUTES.map(([name, type]) => [name, type]),
);

function isAttributeType(value: unknown): value is AttributeType {
  return typeof value === 'string' && Object.hasOwn(ATTRIBUTE_LAYOUTS, value);
}

function diagnostic(code: string, message: string, path: string): VfxDiagnostic {
  return { code, message, path, phase: 'compile', severity: 'error' };
}

function readParticleAttribute(reference: string): string | undefined {
  return reference.startsWith('Particles.') ? reference.slice('Particles.'.length) : undefined;
}

function isNumericArray(value: unknown, length: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component))
  );
}

function isDirectAttributeValue(type: AttributeType, value: unknown): boolean {
  switch (type) {
    case 'bool':
      return typeof value === 'boolean';
    case 'f32':
      return typeof value === 'number' && Number.isFinite(value);
    case 'i32':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= -2_147_483_648 &&
        value <= 2_147_483_647
      );
    case 'u32':
      return (
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4_294_967_295
      );
    case 'vec2':
      return isNumericArray(value, 2);
    case 'vec3':
      return isNumericArray(value, 3);
    case 'color':
    case 'quat':
    case 'vec4':
      return isNumericArray(value, 4);
    case 'mat3':
      return isNumericArray(value, 9);
    case 'mat4':
      return isNumericArray(value, 16);
  }
}

function isAttributeDefaultCompatible(type: AttributeType, value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return isDirectAttributeValue(type, value);
  }
  if (value.kind === 'range' && 'min' in value && 'max' in value) {
    return isDirectAttributeValue(type, value.min) && isDirectAttributeValue(type, value.max);
  }
  if (value.kind === 'curve' && 'keys' in value && Array.isArray(value.keys)) {
    return value.keys.every(
      (key) =>
        typeof key === 'object' &&
        key !== null &&
        'value' in key &&
        isDirectAttributeValue(type, key.value),
    );
  }
  if (value.kind === 'parameter') {
    return !('fallback' in value) || isDirectAttributeValue(type, value.fallback);
  }
  return false;
}

export function resolveAttributeSchema<
  const Attributes extends AttributeSchema,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>(config: EmitterConfig<Attributes, Parameters>): CompileResult<ResolvedAttributeSchema> {
  const diagnostics: VfxDiagnostic[] = [];
  const customAttributes = new Map<string, AttributeDefinition>();
  const declaredNames = new Set<string>();

  if (!Number.isSafeInteger(config.capacity) || config.capacity <= 0) {
    diagnostics.push(
      diagnostic(
        'NACHI_CAPACITY_INVALID',
        `Emitter capacity must be a positive safe integer; received ${String(config.capacity)}.`,
        'capacity',
      ),
    );
  }

  for (const [key, definition] of Object.entries(config.attributes ?? {})) {
    if (key !== definition.name) {
      diagnostics.push(
        diagnostic(
          'NACHI_ATTRIBUTE_KEY_MISMATCH',
          `Attribute key "${key}" must match its declared name "${definition.name}".`,
          `attributes.${key}.name`,
        ),
      );
    }
    if (declaredNames.has(definition.name)) {
      diagnostics.push(
        diagnostic(
          'NACHI_ATTRIBUTE_DUPLICATE',
          `Attribute "${definition.name}" is declared more than once.`,
          `attributes.${key}`,
        ),
      );
      continue;
    }
    declaredNames.add(definition.name);

    if (BUILT_IN_TYPES.has(definition.name)) {
      diagnostics.push(
        diagnostic(
          'NACHI_ATTRIBUTE_RESERVED_NAME',
          `Custom attribute "${definition.name}" collides with a built-in attribute.`,
          `attributes.${key}`,
        ),
      );
      continue;
    }
    if (!isAttributeType(definition.type)) {
      diagnostics.push(
        diagnostic(
          'NACHI_ATTRIBUTE_UNKNOWN_TYPE',
          `Attribute "${definition.name}" uses unknown logical type "${String(definition.type)}".`,
          `attributes.${key}.type`,
        ),
      );
      continue;
    }
    if (!isAttributeDefaultCompatible(definition.type, definition.default)) {
      diagnostics.push(
        diagnostic(
          'NACHI_ATTRIBUTE_DEFAULT_TYPE_MISMATCH',
          `Attribute "${definition.name}" default does not match logical type "${definition.type}".`,
          `attributes.${key}.default`,
        ),
      );
      continue;
    }
    customAttributes.set(definition.name, definition);
  }

  const usedBuiltIns = new Set<string>();
  // M2 lifecycle state is always physical particle data. Keeping both attributes in every
  // resolved schema makes slot reuse and deterministic per-particle generations backend-stable.
  usedBuiltIns.add('alive');
  usedBuiltIns.add('spawnGeneration');
  for (const { module, path } of collectEmitterModules(config)) {
    const requiredAccesses = [
      ['reads', module.access?.reads],
      ['writes', module.access?.writes],
    ] as const;
    for (const [accessKind, references] of requiredAccesses) {
      for (const [index, reference] of (references ?? []).entries()) {
        const name = readParticleAttribute(reference);
        if (name === undefined) continue;
        if (BUILT_IN_TYPES.has(name)) {
          usedBuiltIns.add(name);
        } else if (!customAttributes.has(name)) {
          diagnostics.push(
            diagnostic(
              'NACHI_ATTRIBUTE_UNKNOWN_REFERENCE',
              `Module ${accessKind} unknown particle attribute "${name}".`,
              `${path}.access.${accessKind}[${index}]`,
            ),
          );
        }
      }
    }
    // Missing required reads are errors. Optional reads are asymmetric: a known built-in is
    // allocated, while an absent optional path is intentionally ignored so its fallback can run.
    for (const reference of module.access?.optionalReads ?? []) {
      const name = readParticleAttribute(reference);
      if (name !== undefined && BUILT_IN_TYPES.has(name)) usedBuiltIns.add(name);
    }
  }

  const resolvedInputs: Array<{
    readonly logicalType: AttributeType;
    readonly default: ResolvedAttribute['default'];
    readonly name: string;
    readonly source: 'built-in' | 'custom';
    readonly transient: boolean;
  }> = [];
  for (const [name, logicalType, defaultValue] of BUILT_IN_ATTRIBUTES) {
    if (usedBuiltIns.has(name)) {
      resolvedInputs.push({
        default: defaultValue as ResolvedAttribute['default'],
        logicalType,
        name,
        source: 'built-in',
        transient: false,
      });
    }
  }
  for (const [name, definition] of [...customAttributes.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    resolvedInputs.push({
      default: definition.default as ResolvedAttribute['default'],
      logicalType: definition.type,
      name,
      source: 'custom',
      transient: definition.transient ?? false,
    });
  }

  if (diagnostics.length > 0) return { diagnostics, ok: false };

  const attributes: ResolvedAttribute[] = resolvedInputs.map((input, storageIndex) => ({
    ...ATTRIBUTE_LAYOUTS[input.logicalType],
    ...input,
    path: `Particles.${input.name}`,
    storageIndex,
  }));
  return {
    diagnostics,
    ok: true,
    value: {
      attributes,
      byName: Object.fromEntries(attributes.map((resolved) => [resolved.name, resolved])),
      capacity: config.capacity,
      kind: 'resolved-attribute-schema',
      layout: 'soa',
      storageArrays: attributes.map((resolved) => ({
        attribute: resolved.name,
        index: resolved.storageIndex,
        kind: 'instanced-array',
        length: config.capacity,
        type: resolved.storageType,
      })),
    },
  };
}
