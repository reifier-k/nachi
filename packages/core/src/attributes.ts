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
  ResolvedAttributeStorage,
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

/** GPU memory length in 4-byte elements, matching three.js getMemoryLengthFromType. */
export const TSL_STORAGE_TYPE_PHYSICAL_LENGTHS: Readonly<Record<TslStorageType, number>> = {
  float: 1,
  int: 1,
  ivec4: 4,
  mat3: 12,
  mat4: 16,
  uint: 1,
  uvec4: 4,
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

export interface PackedAttributeAddress {
  readonly group: number;
  readonly offset: number;
  readonly particleStride: number;
}

export function resolvePackedAttributeAddress(
  attribute: Pick<ResolvedAttribute, 'name' | 'physical'>,
  storage: Pick<ResolvedAttributeStorage, 'groupCount' | 'packed'>,
): PackedAttributeAddress {
  if (!storage.packed || !attribute.physical.packed) {
    throw new Error(`Attribute "${attribute.name}" is not packed.`);
  }
  return {
    group: attribute.physical.group,
    offset: attribute.physical.offset,
    particleStride: storage.groupCount,
  };
}

export function packedElementIndex(
  particleIndex: number,
  address: Pick<PackedAttributeAddress, 'group' | 'particleStride'>,
): number {
  return particleIndex * address.particleStride + address.group;
}

export function packedComponentIndex(
  particleIndex: number,
  address: PackedAttributeAddress,
  component: number,
): number {
  return packedElementIndex(particleIndex, address) * 4 + address.offset + component;
}

export type AttributeStorageBackend = 'webgl2' | 'webgpu';

/**
 * Resolves a logical attribute component into the backend's readback/upload array.
 *
 * WebGPU preserves the compiler's particle-major array of packed vec4 groups. Three r185's
 * WebGL2 transform-feedback fallback instead emits one varying record per storage and invocation;
 * indexed storage elements (and therefore the packed group) do not affect the TF destination.
 */
export function attributeStorageComponentIndex(
  attribute: Pick<ResolvedAttribute, 'logicalType' | 'name' | 'physical'>,
  storage: Pick<ResolvedAttributeStorage, 'groupCount' | 'packed' | 'type'>,
  backend: AttributeStorageBackend,
  particleIndex: number,
  component: number,
): number {
  if (storage.packed) {
    const address = resolvePackedAttributeAddress(attribute, storage);
    const elementIndex =
      backend === 'webgl2' ? particleIndex : packedElementIndex(particleIndex, address);
    return elementIndex * 4 + address.offset + component;
  }
  const physicalComponent =
    attribute.logicalType === 'mat3' ? Math.floor(component / 3) * 4 + (component % 3) : component;
  return particleIndex * TSL_STORAGE_TYPE_PHYSICAL_LENGTHS[storage.type] + physicalComponent;
}

type PackDomain = 'float' | 'int' | 'uint';

function packDomain(type: AttributeType): PackDomain | undefined {
  if (type === 'bool' || type === 'u32') return 'uint';
  if (type === 'i32') return 'int';
  if (type === 'f32' || type === 'vec2' || type === 'vec3') return 'float';
  return undefined;
}

function packedStorageType(domain: PackDomain): TslStorageType {
  return domain === 'float' ? 'vec4' : domain === 'int' ? 'ivec4' : 'uvec4';
}

function wgslIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function uniquePhysicalName(value: string, storages: readonly { readonly name: string }[]): string {
  const base = wgslIdentifier(value);
  let candidate = base;
  let suffix = 2;
  while (storages.some(({ name }) => name === candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function resolveTslStorageType(type: AttributeType): TslStorageType {
  return ATTRIBUTE_LAYOUTS[type].storageType;
}

export const BUILT_IN_ATTRIBUTE_DEFAULTS = {
  age: 0,
  alive: false,
  color: [1, 1, 1, 1],
  intensity: 1,
  lifetime: 1,
  mass: 1,
  normalizedAge: 0,
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  size: 1,
  spriteRotation: 0,
  spawnGeneration: 0,
  spawnOrder: 0,
  surfaceNormal: [0, 1, 0],
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
  ['intensity', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.intensity],
  ['size', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.size],
  ['scale', 'vec3', BUILT_IN_ATTRIBUTE_DEFAULTS.scale],
  ['rotation', 'quat', BUILT_IN_ATTRIBUTE_DEFAULTS.rotation],
  ['spriteRotation', 'f32', BUILT_IN_ATTRIBUTE_DEFAULTS.spriteRotation],
  ['spawnGeneration', 'u32', BUILT_IN_ATTRIBUTE_DEFAULTS.spawnGeneration],
  ['spawnOrder', 'u32', BUILT_IN_ATTRIBUTE_DEFAULTS.spawnOrder],
  ['surfaceNormal', 'vec3', BUILT_IN_ATTRIBUTE_DEFAULTS.surfaceNormal],
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
    if (definition.name.startsWith('packed_')) {
      diagnostics.push(
        diagnostic(
          'NACHI_ATTRIBUTE_RESERVED_PREFIX',
          `Custom attribute "${definition.name}" uses the compiler-reserved "packed_" prefix.`,
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
  // Lifecycle identity is always physical particle data. spawnOrder is the deterministic birth
  // key used by order-sensitive renderer extensions and never follows alive compaction order.
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

  const pendingStorages: Array<{
    attributes: string[];
    componentType: PackDomain;
    groupCount: number;
    groups: number[];
    name: string;
    packed: boolean;
    type: TslStorageType;
  }> = [];
  const packedBufferByDomain = new Map<PackDomain, number>();
  const allocations = new Map<
    string,
    { bufferIndex: number; group: number; offset: 0 | 1 | 2 | 3; packed: boolean }
  >();

  for (const input of resolvedInputs) {
    const layout = ATTRIBUTE_LAYOUTS[input.logicalType];
    const domain = packDomain(input.logicalType);
    if (domain === undefined) {
      const bufferIndex = pendingStorages.length;
      pendingStorages.push({
        attributes: [input.name],
        componentType: 'float',
        groupCount: 1,
        groups: [layout.components],
        name: uniquePhysicalName(input.name, pendingStorages),
        packed: false,
        type: layout.storageType,
      });
      allocations.set(input.name, { bufferIndex, group: 0, offset: 0, packed: false });
      continue;
    }

    let bufferIndex = packedBufferByDomain.get(domain);
    if (bufferIndex === undefined) {
      bufferIndex = pendingStorages.length;
      packedBufferByDomain.set(domain, bufferIndex);
      pendingStorages.push({
        attributes: [],
        componentType: domain,
        groupCount: 0,
        groups: [],
        name: uniquePhysicalName(`packed_${domain}`, pendingStorages),
        packed: true,
        type: packedStorageType(domain),
      });
    }
    const storage = pendingStorages[bufferIndex];
    if (!storage) throw new Error(`Packed storage ${bufferIndex} was not allocated.`);
    let group = storage.groups.findIndex((used) => used + layout.components <= 4);
    if (group < 0) {
      group = storage.groups.length;
      storage.groups.push(0);
    }
    const offset = storage.groups[group] as 0 | 1 | 2 | 3;
    storage.groups[group] = offset + layout.components;
    storage.groupCount = storage.groups.length;
    storage.attributes.push(input.name);
    allocations.set(input.name, { bufferIndex, group, offset, packed: true });
  }

  const attributes: ResolvedAttribute[] = resolvedInputs.map((input, storageIndex) => {
    const physical = allocations.get(input.name);
    if (!physical) throw new Error(`Physical allocation for attribute "${input.name}" is missing.`);
    return {
      ...ATTRIBUTE_LAYOUTS[input.logicalType],
      ...input,
      path: `Particles.${input.name}`,
      physical,
      storageIndex,
    };
  });
  const storageArrays = pendingStorages.map((storage, index) => ({
    attributes: storage.attributes,
    componentType: storage.componentType,
    groupCount: storage.groupCount,
    index,
    kind: 'instanced-array' as const,
    length: config.capacity * storage.groupCount,
    name: storage.name,
    packed: storage.packed,
    type: storage.type,
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
      storageArrays,
    },
  };
}
