import type {
  AttributeComponentCount,
  AttributeDefinition,
  AttributeSchema,
  AttributeType,
  CompileResult,
  EmitterConfig,
  EmptyParameterSchema,
  ModuleDefinition,
  ModuleStage,
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

const BUILT_IN_ATTRIBUTES = [
  ['position', 'vec3'],
  ['velocity', 'vec3'],
  ['age', 'f32'],
  ['lifetime', 'f32'],
  ['normalizedAge', 'f32'],
  ['alive', 'bool'],
  ['color', 'color'],
  ['size', 'f32'],
  ['scale', 'vec3'],
  ['rotation', 'quat'],
  ['spriteRotation', 'f32'],
  ['mass', 'f32'],
] as const satisfies readonly (readonly [string, AttributeType])[];

const BUILT_IN_TYPES = new Map<string, AttributeType>(BUILT_IN_ATTRIBUTES);

function isAttributeType(value: unknown): value is AttributeType {
  return typeof value === 'string' && Object.hasOwn(ATTRIBUTE_LAYOUTS, value);
}

type LocatedModule = {
  readonly module: ModuleDefinition<ModuleStage, object>;
  readonly path: string;
};

function diagnostic(code: string, message: string, path: string): VfxDiagnostic {
  return { code, message, path, phase: 'compile', severity: 'error' };
}

function appendModules(
  target: LocatedModule[],
  path: string,
  value:
    | ModuleDefinition<ModuleStage, object>
    | readonly ModuleDefinition<ModuleStage, object>[]
    | undefined,
): void {
  if (value === undefined) return;
  const modules = Array.isArray(value) ? value : [value];
  for (const [index, module] of modules.entries()) {
    target.push({ module, path: `${path}[${index}]` });
  }
}

function collectModules(config: EmitterConfig<AttributeSchema, ParameterSchema>): LocatedModule[] {
  const modules: LocatedModule[] = [];
  appendModules(modules, 'spawn', config.spawn);
  appendModules(modules, 'init', config.init);
  appendModules(modules, 'update', config.update);
  for (const [eventName, handlers] of Object.entries(config.events ?? {})) {
    appendModules(modules, `events.${eventName}`, handlers);
  }
  appendModules(modules, 'render', config.render);
  return modules;
}

function readParticleAttribute(reference: string): string | undefined {
  return reference.startsWith('Particles.') ? reference.slice('Particles.'.length) : undefined;
}

export function resolveAttributeSchema<
  const Attributes extends AttributeSchema,
  const Parameters extends ParameterSchema = EmptyParameterSchema,
>(config: EmitterConfig<Attributes, Parameters>): CompileResult<ResolvedAttributeSchema> {
  const diagnostics: VfxDiagnostic[] = [];
  const customAttributes = new Map<string, AttributeDefinition>();
  const declaredNames = new Set<string>();

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
    customAttributes.set(definition.name, definition);
  }

  const usedBuiltIns = new Set<string>();
  for (const { module, path } of collectModules(config)) {
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
    for (const reference of module.access?.optionalReads ?? []) {
      const name = readParticleAttribute(reference);
      if (name !== undefined && BUILT_IN_TYPES.has(name)) usedBuiltIns.add(name);
    }
  }

  const resolvedInputs: Array<{
    readonly logicalType: AttributeType;
    readonly name: string;
    readonly source: 'built-in' | 'custom';
    readonly transient: boolean;
  }> = [];
  for (const [name, logicalType] of BUILT_IN_ATTRIBUTES) {
    if (usedBuiltIns.has(name)) {
      resolvedInputs.push({ logicalType, name, source: 'built-in', transient: false });
    }
  }
  for (const [name, definition] of [...customAttributes.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    resolvedInputs.push({
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
