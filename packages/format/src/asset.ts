import {
  VfxDiagnosticError,
  MAX_EMITTER_CAPACITY,
  MAX_PBD_ITERATIONS,
  MAX_PREWARM_SECONDS,
  defineEffect,
  defineEmitter,
  type AttributeType,
  type EffectDefinition,
  type EffectElementDefinition,
  type EffectElements,
  type EffectConfig,
  type EmitterConfig,
  type EmitterOverrideConfig,
  type JsonValue,
  type ParameterSchema,
  type VfxDiagnostic,
} from '@nachi/core';

import { defaultEffectAssetMigrations } from './migrations.js';
import {
  EFFECT_ASSET_FORMAT,
  EFFECT_ASSET_VERSION,
  type EffectAssetDocumentV1,
  type LoadEffectOptions,
} from './types.js';

type DiagnosticPhase = 'deserialize' | 'serialize';
type UnknownRecord = Record<string, unknown>;

const EFFECT_FIELDS = new Set(['elements', 'kind', 'parameters', 'scalability', 'timeline']);
const EMITTER_FIELDS = new Set([
  'attributes',
  'bounds',
  'capacity',
  'events',
  'init',
  'integration',
  'kind',
  'lifecycle',
  'offset',
  'parameters',
  'quality',
  'render',
  'spawn',
  'update',
]);
const MODULE_FIELDS = new Set(['access', 'config', 'kind', 'label', 'stage', 'type', 'version']);
const ATTRIBUTE_TYPES = new Set<AttributeType>([
  'bool',
  'color',
  'f32',
  'i32',
  'mat3',
  'mat4',
  'quat',
  'u32',
  'vec2',
  'vec3',
  'vec4',
]);
const MODULE_STAGES = new Set(['event', 'init', 'render', 'spawn', 'update']);
const MAX_JSON_DEPTH = 256;
const GRID2D_BUILTIN_STAGE_SOURCES = new Set([
  'core/grid2d-advect',
  'core/grid2d-buoyancy',
  'core/grid2d-inject',
  'core/grid2d-pressure-jacobi',
  'core/grid2d-project-velocity',
]);
const GRID3D_BUILTIN_STAGE_SOURCES = new Set([
  'core/grid3d-advect',
  'core/grid3d-buoyancy',
  'core/grid3d-inject',
  'core/grid3d-pressure-jacobi',
  'core/grid3d-project-velocity',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmitterReference(value: string): boolean {
  const hash = value.indexOf('#');
  return hash >= 0 && hash < value.length - 1 && value.indexOf('#', hash + 1) < 0;
}

function generatorNumberShape(value: unknown): string | undefined {
  if (typeof value === 'number') return 'scalar';
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > 4 ||
    !value.every((item) => typeof item === 'number')
  ) {
    return undefined;
  }
  return `vec${value.length}`;
}

function jsonClone(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(jsonClone);
  return Object.fromEntries(
    Object.entries(value as UnknownRecord).map(([key, item]) => [key, jsonClone(item)]),
  );
}

function pushDiagnostic(
  diagnostics: VfxDiagnostic[],
  phase: DiagnosticPhase,
  code: string,
  message: string,
  path?: string,
  hint?: string,
): void {
  diagnostics.push({
    code,
    message,
    ...(path === undefined ? {} : { path }),
    phase,
    severity: 'error',
    ...(hint === undefined ? {} : { hint }),
  });
}

class AssetValidator {
  readonly diagnostics: VfxDiagnostic[] = [];
  readonly #jsonActive = new Set<object>();

  constructor(readonly phase: DiagnosticPhase) {}

  document(value: unknown): value is UnknownRecord {
    if (!this.record(value, '$')) return false;
    this.unknownFields(value, new Set(['effect', 'format', 'version']), '$');
    this.required(value, ['effect', 'format', 'version'], '$');
    if (value.format !== EFFECT_ASSET_FORMAT) {
      this.error(
        'NACHI_ASSET_FORMAT_INVALID',
        `Asset format must be "${EFFECT_ASSET_FORMAT}".`,
        '$.format',
      );
    }
    if (!Number.isSafeInteger(value.version) || value.version !== EFFECT_ASSET_VERSION) {
      this.error(
        'NACHI_ASSET_VERSION_UNSUPPORTED',
        `Asset version must be ${EFFECT_ASSET_VERSION} after migration.`,
        '$.version',
      );
    }
    this.effect(value.effect, '$.effect');
    return true;
  }

  effect(value: unknown, path: string): value is UnknownRecord {
    if (!this.record(value, path)) return false;
    this.unknownFields(value, EFFECT_FIELDS, path);
    this.required(value, ['elements', 'kind'], path);
    if (value.kind !== 'effect') this.literal(value.kind, 'effect', `${path}.kind`);
    if (this.record(value.elements, `${path}.elements`)) {
      for (const [key, element] of Object.entries(value.elements)) {
        if (key.includes('#')) {
          this.error(
            'NACHI_ASSET_ELEMENT_KEY_INVALID',
            'Effect element keys must not contain "#" because it delimits emitter references.',
            `${path}.elements.${key}`,
          );
        }
        this.element(element, `${path}.elements.${key}`);
      }
    }
    if (value.parameters !== undefined) this.parameters(value.parameters, `${path}.parameters`);
    if (value.scalability !== undefined) this.scalability(value.scalability, `${path}.scalability`);
    if (value.timeline !== undefined) this.timeline(value.timeline, `${path}.timeline`);
    return true;
  }

  element(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    if (value.kind === 'emitter') this.emitter(value, path);
    else if (value.kind === 'visual-element') this.visualElement(value, path);
    else if (value.kind === 'emitter-extends') this.emitterExtension(value, path);
    else if (value.kind === 'grid2d') this.grid2D(value, path);
    else if (value.kind === 'grid3d') this.grid3D(value, path);
    else if (value.kind === 'neighbor-grid') this.neighborGrid(value, path);
    else if (value.kind === 'sim-stage') this.simStage(value, path);
    else
      this.error(
        'NACHI_ASSET_ELEMENT_KIND_UNKNOWN',
        'Effect elements must be emitter, Grid2D, Grid3D, NeighborGrid, simulation-stage, emitter-extends, or visual-element definitions.',
        `${path}.kind`,
      );
  }

  grid2D(value: UnknownRecord, path: string): void {
    this.unknownFields(
      value,
      new Set(['boundary', 'channels', 'kind', 'resolution', 'version']),
      path,
    );
    this.required(value, ['boundary', 'channels', 'kind', 'resolution', 'version'], path);
    if (value.version !== 1) this.literal(value.version, '1', `${path}.version`);
    if (value.boundary !== 'clamp') this.literal(value.boundary, 'clamp', `${path}.boundary`);
    this.numberTuple(value.resolution, 2, `${path}.resolution`);
    if (Array.isArray(value.resolution)) {
      value.resolution.forEach((dimension, index) => {
        if (!Number.isSafeInteger(dimension) || (dimension as number) <= 0)
          this.type('positive integer', dimension, `${path}.resolution[${index}]`);
      });
    }
    if (this.record(value.channels, `${path}.channels`)) {
      if (Object.keys(value.channels).length === 0) {
        this.error(
          'NACHI_ASSET_VALUE_INVALID',
          'Grid2D requires at least one channel.',
          `${path}.channels`,
        );
      }
      for (const [name, channel] of Object.entries(value.channels)) {
        const itemPath = `${path}.channels.${name}`;
        if (!this.record(channel, itemPath)) continue;
        this.unknownFields(channel, new Set(['default', 'type']), itemPath);
        this.required(channel, ['type'], itemPath);
        if (channel.type !== 'f32' && channel.type !== 'vec2')
          this.type('f32 or vec2', channel.type, `${itemPath}.type`);
        if (channel.default !== undefined) {
          if (channel.type === 'vec2') {
            this.numberTuple(channel.default, 2, `${itemPath}.default`);
          } else {
            this.finiteNumber(channel.default, `${itemPath}.default`);
          }
        }
      }
    }
  }

  grid3D(value: UnknownRecord, path: string): void {
    this.unknownFields(
      value,
      new Set(['boundary', 'channels', 'kind', 'resolution', 'version']),
      path,
    );
    this.required(value, ['boundary', 'channels', 'kind', 'resolution', 'version'], path);
    if (value.version !== 1) this.literal(value.version, '1', `${path}.version`);
    if (value.boundary !== 'clamp') this.literal(value.boundary, 'clamp', `${path}.boundary`);
    this.numberTuple(value.resolution, 3, `${path}.resolution`);
    if (Array.isArray(value.resolution)) {
      value.resolution.forEach((dimension, index) => {
        if (!Number.isSafeInteger(dimension) || (dimension as number) <= 0)
          this.type('positive integer', dimension, `${path}.resolution[${index}]`);
      });
    }
    if (this.record(value.channels, `${path}.channels`)) {
      if (Object.keys(value.channels).length === 0) {
        this.error(
          'NACHI_ASSET_VALUE_INVALID',
          'Grid3D requires at least one channel.',
          `${path}.channels`,
        );
      }
      for (const [name, channel] of Object.entries(value.channels)) {
        const itemPath = `${path}.channels.${name}`;
        if (!this.record(channel, itemPath)) continue;
        this.unknownFields(channel, new Set(['default', 'type']), itemPath);
        this.required(channel, ['type'], itemPath);
        if (channel.type !== 'f32' && channel.type !== 'vec3')
          this.type('f32 or vec3', channel.type, `${itemPath}.type`);
        if (channel.default !== undefined) {
          if (channel.type === 'vec3') {
            this.numberTuple(channel.default, 3, `${itemPath}.default`);
          } else {
            this.finiteNumber(channel.default, `${itemPath}.default`);
          }
        }
      }
    }
  }

  neighborGrid(value: UnknownRecord, path: string): void {
    this.unknownFields(
      value,
      new Set(['cellCapacity', 'cellSize', 'kind', 'origin', 'resolution', 'version']),
      path,
    );
    this.required(
      value,
      ['cellCapacity', 'cellSize', 'kind', 'origin', 'resolution', 'version'],
      path,
    );
    if (value.version !== 1) this.literal(value.version, '1', `${path}.version`);
    this.numberTuple(value.resolution, 3, `${path}.resolution`);
    if (Array.isArray(value.resolution)) {
      value.resolution.forEach((dimension, index) => {
        if (!Number.isSafeInteger(dimension) || (dimension as number) <= 0)
          this.type('positive integer', dimension, `${path}.resolution[${index}]`);
      });
    }
    if (!Number.isSafeInteger(value.cellCapacity) || (value.cellCapacity as number) <= 0) {
      this.type('positive integer', value.cellCapacity, `${path}.cellCapacity`);
    }
    this.finiteNumber(value.cellSize, `${path}.cellSize`);
    if (typeof value.cellSize === 'number' && value.cellSize <= 0) {
      this.error('NACHI_ASSET_VALUE_INVALID', 'cellSize must be positive.', `${path}.cellSize`);
    }
    this.numberTuple(value.origin, 3, `${path}.origin`);
  }

  simStage(value: UnknownRecord, path: string): void {
    this.unknownFields(
      value,
      new Set(['iterations', 'kind', 'phase', 'target', 'update', 'version']),
      path,
    );
    this.required(value, ['iterations', 'kind', 'phase', 'target', 'update', 'version'], path);
    if (value.version !== 1) this.literal(value.version, '1', `${path}.version`);
    if (!Number.isSafeInteger(value.iterations) || (value.iterations as number) <= 0)
      this.type('positive integer', value.iterations, `${path}.iterations`);
    if (value.phase !== 'before-particles' && value.phase !== 'after-particles')
      this.type('simulation-stage phase', value.phase, `${path}.phase`);
    if (typeof value.target !== 'string' || value.target.length === 0)
      this.type('non-empty string', value.target, `${path}.target`);
    if (!this.record(value.update, `${path}.update`)) return;
    this.unknownFields(
      value.update,
      new Set(['config', 'kind', 'source', 'version']),
      `${path}.update`,
    );
    this.required(value.update, ['config', 'kind', 'source', 'version'], `${path}.update`);
    const isGrid2D = value.update.kind === 'grid2d-stage-module';
    const isGrid3D = value.update.kind === 'grid3d-stage-module';
    if (!isGrid2D && !isGrid3D)
      this.type(
        'grid2d-stage-module or grid3d-stage-module',
        value.update.kind,
        `${path}.update.kind`,
      );
    if (value.update.version !== 1)
      this.literal(value.update.version, '1', `${path}.update.version`);
    if (value.update.source === 'inline') {
      this.error(
        'NACHI_ASSET_INLINE_FUNCTION',
        'Inline grid TSL factories are authoring-only.',
        `${path}.update.source`,
        'Use the matching defineGrid2DStageFunction()/defineGrid3DStageFunction() registration.',
      );
    } else if (typeof value.update.source !== 'string') {
      if (this.record(value.update.source, `${path}.update.source`)) {
        this.unknownFields(
          value.update.source,
          new Set(['id', 'kind', 'version']),
          `${path}.update.source`,
        );
        const expectedRefKind = isGrid3D ? 'grid3d-function-ref' : 'grid2d-function-ref';
        if (value.update.source.kind !== expectedRefKind)
          this.literal(value.update.source.kind, expectedRefKind, `${path}.update.source.kind`);
        if (typeof value.update.source.id !== 'string' || value.update.source.id.length === 0)
          this.type('non-empty string', value.update.source.id, `${path}.update.source.id`);
        if (
          !Number.isSafeInteger(value.update.source.version) ||
          (value.update.source.version as number) < 1
        )
          this.type(
            'positive integer',
            value.update.source.version,
            `${path}.update.source.version`,
          );
      }
    }
    if (this.record(value.update.config, `${path}.update.config`))
      this.json(value.update.config, `${path}.update.config`);
  }

  emitter(value: UnknownRecord, path: string): void {
    this.unknownFields(value, EMITTER_FIELDS, path);
    this.required(value, ['capacity', 'kind', 'render', 'spawn'], path);
    if (value.kind !== 'emitter') this.literal(value.kind, 'emitter', `${path}.kind`);
    if (!Number.isSafeInteger(value.capacity) || (value.capacity as number) <= 0) {
      this.error(
        'NACHI_ASSET_VALUE_INVALID',
        'Emitter capacity must be a positive safe integer.',
        `${path}.capacity`,
      );
    } else if ((value.capacity as number) > MAX_EMITTER_CAPACITY) {
      this.error(
        'NACHI_ASSET_CAPACITY_LIMIT_EXCEEDED',
        `Emitter capacity must not exceed ${MAX_EMITTER_CAPACITY}.`,
        `${path}.capacity`,
      );
    }
    if (value.attributes !== undefined) this.attributes(value.attributes, `${path}.attributes`);
    if (value.bounds !== undefined) this.bounds(value.bounds, `${path}.bounds`);
    if (value.events !== undefined) this.events(value.events, `${path}.events`);
    if (value.init !== undefined) this.moduleArray(value.init, 'init', `${path}.init`);
    if (
      value.integration !== undefined &&
      value.integration !== 'euler' &&
      value.integration !== 'none'
    ) {
      this.error(
        'NACHI_ASSET_VALUE_INVALID',
        'Emitter integration must be "euler" or "none".',
        `${path}.integration`,
      );
    }
    if (value.lifecycle !== undefined) this.lifecycle(value.lifecycle, `${path}.lifecycle`);
    if (value.offset !== undefined) this.numberTuple(value.offset, 3, `${path}.offset`);
    if (value.parameters !== undefined) this.parameters(value.parameters, `${path}.parameters`);
    if (value.quality !== undefined) this.quality(value.quality, `${path}.quality`);
    this.moduleOrArray(value.render, 'render', `${path}.render`);
    this.moduleOrArray(value.spawn, 'spawn', `${path}.spawn`);
    if (value.update !== undefined) this.moduleArray(value.update, 'update', `${path}.update`);
  }

  emitterExtension(value: UnknownRecord, path: string): void {
    this.unknownFields(value, new Set(['extends', 'kind', 'overrides']), path);
    this.required(value, ['extends', 'kind', 'overrides'], path);
    if (typeof value.extends !== 'string' || value.extends.length === 0) {
      this.type('non-empty string', value.extends, `${path}.extends`);
    } else if (!isEmitterReference(value.extends)) {
      this.error(
        'NACHI_ASSET_EXTENDS_REFERENCE_INVALID',
        'Emitter extends references use exactly one "#" in "#element" or "asset-id#element" syntax.',
        `${path}.extends`,
      );
    }
    if (!this.record(value.overrides, `${path}.overrides`)) return;
    this.emitterOverrides(value.overrides, `${path}.overrides`);
  }

  emitterOverrides(value: UnknownRecord, path: string): void {
    const fields = new Set([
      'attributes',
      'bounds',
      'capacity',
      'events',
      'init',
      'integration',
      'lifecycle',
      'offset',
      'parameters',
      'quality',
      'render',
      'spawn',
      'update',
    ]);
    this.unknownFields(value, fields, path);
    if (value.attributes !== undefined) this.attributes(value.attributes, `${path}.attributes`);
    if (value.bounds !== undefined) this.bounds(value.bounds, `${path}.bounds`);
    if (
      value.capacity !== undefined &&
      (!Number.isSafeInteger(value.capacity) || (value.capacity as number) <= 0)
    ) {
      this.error(
        'NACHI_ASSET_VALUE_INVALID',
        'Capacity must be a positive safe integer.',
        `${path}.capacity`,
      );
    }
    if (value.events !== undefined) this.events(value.events, `${path}.events`);
    if (value.init !== undefined) this.moduleOverride(value.init, 'init', `${path}.init`);
    if (
      value.integration !== undefined &&
      value.integration !== 'euler' &&
      value.integration !== 'none'
    ) {
      this.error(
        'NACHI_ASSET_VALUE_INVALID',
        'Integration must be "euler" or "none".',
        `${path}.integration`,
      );
    }
    if (value.lifecycle !== undefined) this.lifecycle(value.lifecycle, `${path}.lifecycle`);
    if (value.offset !== undefined) this.numberTuple(value.offset, 3, `${path}.offset`);
    if (value.parameters !== undefined) this.parameters(value.parameters, `${path}.parameters`);
    if (value.quality !== undefined) this.quality(value.quality, `${path}.quality`);
    if (value.render !== undefined) this.moduleOverride(value.render, 'render', `${path}.render`);
    if (value.spawn !== undefined) this.moduleOrArray(value.spawn, 'spawn', `${path}.spawn`);
    if (value.update !== undefined) this.moduleOverride(value.update, 'update', `${path}.update`);
  }

  moduleOverride(value: unknown, stage: string, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['mode', 'modules', 'order', 'remove']), path);
    if (
      value.mode !== undefined &&
      value.mode !== 'append' &&
      value.mode !== 'merge' &&
      value.mode !== 'replace'
    ) {
      this.error('NACHI_ASSET_VALUE_INVALID', 'Module override mode is invalid.', `${path}.mode`);
    }
    if (value.modules !== undefined) this.moduleArray(value.modules, stage, `${path}.modules`);
    for (const field of ['order', 'remove'] as const) {
      const selectors = value[field];
      if (selectors === undefined) continue;
      if (!Array.isArray(selectors)) this.type('array', selectors, `${path}.${field}`);
      else {
        this.denseArray(selectors, `${path}.${field}`);
        selectors.forEach((selector, index) => {
          if (typeof selector !== 'string' && !Number.isSafeInteger(selector)) {
            this.type('string or integer', selector, `${path}.${field}[${index}]`);
          }
        });
      }
    }
  }

  visualElement(value: UnknownRecord, path: string): void {
    this.unknownFields(value, new Set(['config', 'kind', 'type', 'version']), path);
    this.required(value, ['config', 'kind', 'type', 'version'], path);
    if (typeof value.type !== 'string' || value.type.length === 0)
      this.type('non-empty string', value.type, `${path}.type`);
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
      this.type('positive integer', value.version, `${path}.version`);
    }
    if (this.record(value.config, `${path}.config`)) this.json(value.config, `${path}.config`);
  }

  moduleOrArray(value: unknown, stage: string, path: string): void {
    if (Array.isArray(value)) this.moduleArray(value, stage, path);
    else this.module(value, stage, path);
  }

  moduleArray(value: unknown, stage: string, path: string): void {
    if (!Array.isArray(value)) {
      this.type('array', value, path);
      return;
    }
    this.denseArray(value, path);
    value.forEach((module, index) => this.module(module, stage, `${path}[${index}]`));
  }

  module(value: unknown, expectedStage: string, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, MODULE_FIELDS, path);
    this.required(value, ['config', 'kind', 'stage', 'type', 'version'], path);
    if (value.kind !== 'module') this.literal(value.kind, 'module', `${path}.kind`);
    if (value.stage !== expectedStage || !MODULE_STAGES.has(String(value.stage))) {
      this.error(
        'NACHI_ASSET_MODULE_STAGE_INVALID',
        `Module stage must be "${expectedStage}" at this location.`,
        `${path}.stage`,
      );
    }
    if (typeof value.type !== 'string' || value.type.length === 0)
      this.type('non-empty string', value.type, `${path}.type`);
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 1)
      this.type('positive integer', value.version, `${path}.version`);
    if (value.label !== undefined && typeof value.label !== 'string')
      this.type('string', value.label, `${path}.label`);
    if (this.record(value.config, `${path}.config`)) {
      if (value.type === 'core/position-sphere') {
        this.positionSphereConfig(value.config, `${path}.config`);
      } else {
        this.json(value.config, `${path}.config`);
      }
      if (
        value.type === 'core/pbd-distance-constraint' &&
        typeof value.config.iterations === 'number' &&
        value.config.iterations > MAX_PBD_ITERATIONS
      ) {
        this.error(
          'NACHI_ASSET_PBD_ITERATIONS_LIMIT_EXCEEDED',
          `PBD iterations must not exceed ${MAX_PBD_ITERATIONS}.`,
          `${path}.config.iterations`,
        );
      }
    }
    if (value.access !== undefined) this.access(value.access, `${path}.access`);
  }

  positionSphereConfig(value: UnknownRecord, path: string): void {
    this.json(value, path);
    this.unknownFields(value, new Set(['arc', 'center', 'radius', 'surfaceOnly']), path);
    this.required(value, ['radius'], path);
    this.numericValueInput(value.radius, 'scalar', `${path}.radius`);
    if (value.center !== undefined) {
      this.numericValueInput(value.center, 'vec3', `${path}.center`);
    }
    if (value.surfaceOnly !== undefined && typeof value.surfaceOnly !== 'boolean') {
      this.type('boolean', value.surfaceOnly, `${path}.surfaceOnly`);
    }
    if (value.arc === undefined) return;
    if (!this.record(value.arc, `${path}.arc`)) return;
    this.unknownFields(value.arc, new Set(['axis', 'thetaMax']), `${path}.arc`);
    this.required(value.arc, ['thetaMax'], `${path}.arc`);
    this.numericValueInput(value.arc.thetaMax, 'scalar', `${path}.arc.thetaMax`);
    if (value.arc.axis !== undefined) {
      this.numberTuple(value.arc.axis, 3, `${path}.arc.axis`);
    }
  }

  numericValueInput(value: unknown, expectedShape: string, path: string): void {
    const check = (candidate: unknown, candidatePath: string): void => {
      const shape = generatorNumberShape(candidate);
      if (shape === undefined) {
        const alreadyDiagnosed = this.diagnostics.some(
          (diagnostic) =>
            diagnostic.path === candidatePath ||
            diagnostic.path?.startsWith(`${candidatePath}.`) ||
            diagnostic.path?.startsWith(`${candidatePath}[`),
        );
        if (!alreadyDiagnosed) {
          this.type('finite number or 2-4 component number array', candidate, candidatePath);
        }
      } else if (shape !== expectedShape) {
        this.error(
          'NACHI_ASSET_TYPE_MISMATCH',
          `Expected ${expectedShape} value input, received ${shape}.`,
          candidatePath,
        );
      }
    };
    if (!isRecord(value) || !('kind' in value)) {
      check(value, path);
      return;
    }
    if (value.kind === 'range') {
      check(value.min, `${path}.min`);
      check(value.max, `${path}.max`);
      return;
    }
    if (value.kind === 'curve' && Array.isArray(value.keys)) {
      value.keys.forEach((key, index) => {
        if (isRecord(key)) check(key.value, `${path}.keys[${index}].value`);
      });
      return;
    }
    if (value.kind === 'parameter') {
      if (value.fallback !== undefined) check(value.fallback, `${path}.fallback`);
      return;
    }
    this.type(`${expectedShape} value input`, value, path);
  }

  access(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['optionalReads', 'reads', 'writes']), path);
    this.required(value, ['reads', 'writes'], path);
    this.stringArray(value.reads, `${path}.reads`);
    this.stringArray(value.writes, `${path}.writes`);
    if (value.optionalReads !== undefined)
      this.stringArray(value.optionalReads, `${path}.optionalReads`);
  }

  attributes(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    for (const [key, attribute] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (!this.record(attribute, itemPath)) continue;
      this.unknownFields(
        attribute,
        new Set(['default', 'kind', 'name', 'transient', 'type']),
        itemPath,
      );
      this.required(attribute, ['default', 'kind', 'name', 'type'], itemPath);
      if (attribute.kind !== 'attribute')
        this.literal(attribute.kind, 'attribute', `${itemPath}.kind`);
      if (attribute.name !== key) {
        this.error(
          'NACHI_ASSET_VALUE_INVALID',
          `Attribute name must match record key "${key}".`,
          `${itemPath}.name`,
        );
      }
      if (!ATTRIBUTE_TYPES.has(attribute.type as AttributeType))
        this.type('attribute type', attribute.type, `${itemPath}.type`);
      this.json(attribute.default, `${itemPath}.default`);
      if (
        ATTRIBUTE_TYPES.has(attribute.type as AttributeType) &&
        !(
          isRecord(attribute.default) &&
          (attribute.default.kind === 'curve' ||
            attribute.default.kind === 'parameter' ||
            attribute.default.kind === 'range')
        )
      ) {
        this.typedValue(attribute.type as AttributeType, attribute.default, `${itemPath}.default`);
      }
      if (attribute.transient !== undefined && typeof attribute.transient !== 'boolean')
        this.type('boolean', attribute.transient, `${itemPath}.transient`);
    }
  }

  parameters(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    for (const [key, parameter] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (!this.record(parameter, itemPath)) continue;
      this.unknownFields(
        parameter,
        new Set(['default', 'kind', 'mutable', 'path', 'type']),
        itemPath,
      );
      this.required(parameter, ['default', 'kind', 'path', 'type'], itemPath);
      if (parameter.kind !== 'parameter-definition')
        this.literal(parameter.kind, 'parameter-definition', `${itemPath}.kind`);
      if (parameter.path !== key || !key.startsWith('User.')) {
        this.error(
          'NACHI_ASSET_VALUE_INVALID',
          'Parameter key/path must match and use the User.* namespace.',
          `${itemPath}.path`,
        );
      }
      if (!ATTRIBUTE_TYPES.has(parameter.type as AttributeType))
        this.type('attribute type', parameter.type, `${itemPath}.type`);
      this.json(parameter.default, `${itemPath}.default`);
      if (ATTRIBUTE_TYPES.has(parameter.type as AttributeType)) {
        this.typedValue(parameter.type as AttributeType, parameter.default, `${itemPath}.default`);
      }
      if (parameter.mutable !== undefined && typeof parameter.mutable !== 'boolean')
        this.type('boolean', parameter.mutable, `${itemPath}.mutable`);
    }
  }

  events(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    for (const [name, handlers] of Object.entries(value))
      this.moduleOrArray(handlers, 'event', `${path}.${name}`);
  }

  bounds(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['center', 'radius']), path);
    this.required(value, ['radius'], path);
    this.finiteNumber(value.radius, `${path}.radius`);
    if (value.center !== undefined) this.numberTuple(value.center, 3, `${path}.center`);
  }

  lifecycle(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['duration', 'loopCount', 'prewarm', 'startDelay']), path);
    for (const field of ['duration', 'prewarm', 'startDelay'] as const) {
      if (value[field] !== undefined) this.finiteNumber(value[field], `${path}.${field}`);
    }
    if (typeof value.prewarm === 'number' && value.prewarm > MAX_PREWARM_SECONDS) {
      this.error(
        'NACHI_ASSET_PREWARM_LIMIT_EXCEEDED',
        `Emitter prewarm must not exceed ${MAX_PREWARM_SECONDS} seconds.`,
        `${path}.prewarm`,
      );
    }
    if (
      value.loopCount !== undefined &&
      value.loopCount !== 'infinite' &&
      !Number.isSafeInteger(value.loopCount)
    ) {
      this.type('integer or "infinite"', value.loopCount, `${path}.loopCount`);
    }
  }

  quality(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['epic', 'high', 'low', 'medium']), path);
    for (const [tier, item] of Object.entries(value)) {
      const itemPath = `${path}.${tier}`;
      if (!this.record(item, itemPath)) continue;
      this.unknownFields(item, new Set(['capacityScale', 'features', 'spawnRateScale']), itemPath);
      if (item.capacityScale !== undefined)
        this.finiteNumber(item.capacityScale, `${itemPath}.capacityScale`);
      if (item.spawnRateScale !== undefined)
        this.finiteNumber(item.spawnRateScale, `${itemPath}.spawnRateScale`);
      if (item.features !== undefined) {
        if (!this.record(item.features, `${itemPath}.features`)) continue;
        this.unknownFields(
          item.features,
          new Set(['lit', 'soft', 'sorted']),
          `${itemPath}.features`,
        );
        for (const [name, enabled] of Object.entries(item.features)) {
          if (typeof enabled !== 'boolean')
            this.type('boolean', enabled, `${itemPath}.features.${name}`);
        }
      }
    }
  }

  scalability(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['culling', 'significance']), path);
    if (value.culling !== undefined && this.record(value.culling, `${path}.culling`)) {
      this.unknownFields(value.culling, new Set(['distance', 'frustum']), `${path}.culling`);
      if (value.culling.frustum !== undefined && typeof value.culling.frustum !== 'boolean')
        this.type('boolean', value.culling.frustum, `${path}.culling.frustum`);
      if (
        value.culling.distance !== undefined &&
        this.record(value.culling.distance, `${path}.culling.distance`)
      ) {
        this.unknownFields(
          value.culling.distance,
          new Set(['fadeEnd', 'fadeStart']),
          `${path}.culling.distance`,
        );
        this.required(value.culling.distance, ['fadeEnd'], `${path}.culling.distance`);
        this.finiteNumber(value.culling.distance.fadeEnd, `${path}.culling.distance.fadeEnd`);
        if (value.culling.distance.fadeStart !== undefined)
          this.finiteNumber(value.culling.distance.fadeStart, `${path}.culling.distance.fadeStart`);
      }
    }
    if (
      value.significance !== undefined &&
      this.record(value.significance, `${path}.significance`)
    ) {
      this.unknownFields(value.significance, new Set(['priority']), `${path}.significance`);
      if (value.significance.priority !== undefined)
        this.finiteNumber(value.significance.priority, `${path}.significance.priority`);
    }
  }

  timeline(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      this.denseArray(value, path);
      value.forEach((entry, index) => this.timelineEntry(entry, `${path}[${index}]`));
      return;
    }
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['duration', 'entries', 'kind', 'loop', 'speed']), path);
    this.required(value, ['entries', 'kind'], path);
    if (value.kind !== 'timeline') this.literal(value.kind, 'timeline', `${path}.kind`);
    if (value.duration !== undefined) this.finiteNumber(value.duration, `${path}.duration`);
    if (value.speed !== undefined) this.finiteNumber(value.speed, `${path}.speed`);
    if (
      value.loop !== undefined &&
      typeof value.loop !== 'boolean' &&
      !Number.isSafeInteger(value.loop)
    ) {
      this.type('boolean or integer', value.loop, `${path}.loop`);
    }
    if (typeof value.loop === 'number' && (!Number.isSafeInteger(value.loop) || value.loop <= 0)) {
      this.error(
        'NACHI_ASSET_TIMELINE_LOOP_INVALID',
        'Timeline loop count must be a positive safe integer.',
        `${path}.loop`,
      );
    }
    if (!Array.isArray(value.entries)) this.type('array', value.entries, `${path}.entries`);
    else {
      this.denseArray(value.entries, `${path}.entries`);
      value.entries.forEach((entry, index) =>
        this.timelineEntry(entry, `${path}.entries[${index}]`),
      );
      const times = value.entries.flatMap((entry) =>
        isRecord(entry) && typeof entry.at === 'number' && Number.isFinite(entry.at)
          ? [entry.at]
          : [],
      );
      const lastTime = times.length === 0 ? 0 : Math.max(...times);
      const duration = value.duration ?? lastTime;
      if (
        typeof duration === 'number' &&
        (!Number.isFinite(duration) || duration < lastTime || duration < 0)
      ) {
        this.error(
          'NACHI_ASSET_TIMELINE_DURATION_INVALID',
          'Timeline duration must be finite and no earlier than its last entry.',
          `${path}.duration`,
        );
      }
      if (
        (value.loop === true || (typeof value.loop === 'number' && value.loop > 1)) &&
        typeof duration === 'number' &&
        duration <= 0
      ) {
        this.error(
          'NACHI_ASSET_TIMELINE_LOOP_DURATION_REQUIRED',
          'A looping timeline requires a positive duration.',
          `${path}.duration`,
        );
      }
    }
  }

  timelineEntry(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    this.unknownFields(value, new Set(['actions', 'at']), path);
    this.required(value, ['actions', 'at'], path);
    this.finiteNumber(value.at, `${path}.at`);
    if (typeof value.at === 'number' && Number.isFinite(value.at) && value.at < 0) {
      this.error(
        'NACHI_ASSET_TIMELINE_TIME_INVALID',
        'Timeline entry time must be non-negative.',
        `${path}.at`,
      );
    }
    if (!Array.isArray(value.actions)) this.type('array', value.actions, `${path}.actions`);
    else {
      this.denseArray(value.actions, `${path}.actions`);
      value.actions.forEach((action, index) =>
        this.timelineAction(action, `${path}.actions[${index}]`),
      );
    }
  }

  timelineAction(value: unknown, path: string): void {
    if (!this.record(value, path)) return;
    const kind = value.kind;
    const fields =
      kind === 'play' || kind === 'stop'
        ? new Set(['kind', 'target'])
        : kind === 'camera-shake'
          ? new Set(['duration', 'frequency', 'kind', 'strength'])
          : kind === 'hit-stop'
            ? new Set(['durationMs', 'kind', 'timeScale'])
            : kind === 'marker'
              ? new Set(['kind', 'name', 'payload'])
              : undefined;
    if (!fields) {
      this.error(
        'NACHI_ASSET_TIMELINE_ACTION_UNKNOWN',
        `Unknown timeline action "${String(kind)}".`,
        `${path}.kind`,
      );
      return;
    }
    this.unknownFields(value, fields, path);
    if (kind === 'play' || kind === 'stop') {
      this.required(value, ['kind', 'target'], path);
      if (typeof value.target !== 'string') this.type('string', value.target, `${path}.target`);
    } else if (kind === 'camera-shake') {
      this.required(value, ['kind', 'strength'], path);
      this.finiteNumber(value.strength, `${path}.strength`);
      if (value.duration !== undefined) this.finiteNumber(value.duration, `${path}.duration`);
      if (value.frequency !== undefined) this.finiteNumber(value.frequency, `${path}.frequency`);
    } else if (kind === 'hit-stop') {
      this.required(value, ['durationMs', 'kind'], path);
      this.finiteNumber(value.durationMs, `${path}.durationMs`);
      if (value.timeScale !== undefined) this.finiteNumber(value.timeScale, `${path}.timeScale`);
    } else {
      this.required(value, ['kind', 'name'], path);
      if (typeof value.name !== 'string') this.type('string', value.name, `${path}.name`);
      if (value.payload !== undefined) this.json(value.payload, `${path}.payload`);
    }
  }

  json(value: unknown, path: string, depth = 0): void {
    if (depth > MAX_JSON_DEPTH) {
      this.error(
        'NACHI_ASSET_MAX_DEPTH_EXCEEDED',
        `JSON asset data must not exceed ${MAX_JSON_DEPTH} nested containers.`,
        path,
      );
      return;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        this.error('NACHI_ASSET_NON_FINITE_NUMBER', 'JSON numbers must be finite.', path);
      return;
    }
    if (Array.isArray(value)) {
      this.denseArray(value, path);
      value.forEach((item, index) => this.json(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!this.record(value, path)) return;
    if (this.#jsonActive.has(value)) {
      this.error(
        'NACHI_ASSET_CYCLIC_VALUE',
        'Cyclic object graphs are not valid JSON asset data.',
        path,
      );
      return;
    }
    this.#jsonActive.add(value);
    const kind = value.kind;
    if (kind === 'range') {
      this.unknownFields(value, new Set(['distribution', 'kind', 'max', 'min']), path);
      this.required(value, ['distribution', 'kind', 'max', 'min'], path);
      if (value.distribution !== 'uniform')
        this.literal(value.distribution, 'uniform', `${path}.distribution`);
      const minShape = this.generatorNumber(value.min, `${path}.min`);
      const maxShape = this.generatorNumber(value.max, `${path}.max`);
      if (minShape !== undefined && maxShape !== undefined && minShape !== maxShape) {
        this.error(
          'NACHI_ASSET_TYPE_MISMATCH',
          'Range min and max must use the same scalar or vector shape.',
          path,
        );
      }
    } else if (kind === 'curve') {
      this.unknownFields(value, new Set(['keys', 'kind']), path);
      this.required(value, ['keys', 'kind'], path);
      if (!Array.isArray(value.keys)) {
        this.type('array', value.keys, `${path}.keys`);
      } else {
        this.denseArray(value.keys, `${path}.keys`);
        if (value.keys.length < 2) {
          this.error(
            'NACHI_ASSET_VALUE_INVALID',
            'Curve generators require at least two keys.',
            `${path}.keys`,
          );
        }
        let expectedShape: string | undefined;
        value.keys.forEach((key, index) => {
          const keyPath = `${path}.keys[${index}]`;
          if (!this.record(key, keyPath)) return;
          this.unknownFields(key, new Set(['interpolation', 'time', 'value']), keyPath);
          this.required(key, ['time', 'value'], keyPath);
          this.finiteNumber(key.time, `${keyPath}.time`);
          if (
            key.interpolation !== undefined &&
            key.interpolation !== 'constant' &&
            key.interpolation !== 'cubic' &&
            key.interpolation !== 'linear'
          ) {
            this.error(
              'NACHI_ASSET_VALUE_INVALID',
              'Curve interpolation must be "constant", "cubic", or "linear".',
              `${keyPath}.interpolation`,
            );
          }
          const shape = this.generatorNumber(key.value, `${keyPath}.value`);
          expectedShape ??= shape;
          if (shape !== undefined && expectedShape !== undefined && shape !== expectedShape) {
            this.error(
              'NACHI_ASSET_TYPE_MISMATCH',
              'Curve key values must use the same scalar or vector shape.',
              `${keyPath}.value`,
            );
          }
        });
      }
    } else if (kind === 'gradient') {
      this.unknownFields(value, new Set(['kind', 'stops']), path);
      this.required(value, ['kind', 'stops'], path);
      if (!Array.isArray(value.stops)) {
        this.type('array', value.stops, `${path}.stops`);
      } else {
        this.denseArray(value.stops, `${path}.stops`);
        if (value.stops.length < 2) {
          this.error(
            'NACHI_ASSET_VALUE_INVALID',
            'Gradient generators require at least two stops.',
            `${path}.stops`,
          );
        }
        value.stops.forEach((stop, index) => {
          const stopPath = `${path}.stops[${index}]`;
          if (!this.record(stop, stopPath)) return;
          this.unknownFields(stop, new Set(['color', 'position']), stopPath);
          this.required(stop, ['color', 'position'], stopPath);
          this.color(stop.color, `${stopPath}.color`);
          this.finiteNumber(stop.position, `${stopPath}.position`);
        });
      }
    } else if (kind === 'parameter') {
      this.unknownFields(value, new Set(['fallback', 'kind', 'path']), path);
      this.required(value, ['kind', 'path'], path);
      if (typeof value.path !== 'string') this.type('string', value.path, `${path}.path`);
    } else if (kind === 'asset-ref') {
      this.unknownFields(value, new Set(['assetType', 'kind', 'uri']), path);
      this.required(value, ['assetType', 'kind', 'uri'], path);
      if (typeof value.assetType !== 'string')
        this.type('string', value.assetType, `${path}.assetType`);
      if (typeof value.uri !== 'string') this.type('string', value.uri, `${path}.uri`);
    } else if (kind === 'function-ref' || kind === 'callback-ref') {
      this.unknownFields(value, new Set(['id', 'kind', 'version']), path);
      this.required(value, ['id', 'kind', 'version'], path);
      if (typeof value.id !== 'string') this.type('string', value.id, `${path}.id`);
      if (!Number.isSafeInteger(value.version) || (value.version as number) < 1)
        this.type('positive integer', value.version, `${path}.version`);
    } else if (kind === 'inline') {
      this.error(
        'NACHI_ASSET_INLINE_FUNCTION_UNRESOLVED',
        'Inline tslModule factories are authoring-only and cannot be stored in JSON.',
        path,
        'Register the factory and serialize its function-ref instead.',
      );
    }
    for (const [key, item] of Object.entries(value)) this.json(item, `${path}.${key}`, depth + 1);
    this.#jsonActive.delete(value);
  }

  denseArray(value: readonly unknown[], path: string): void {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        this.error(
          'NACHI_ASSET_SPARSE_ARRAY',
          'Sparse arrays are not valid JSON asset data.',
          `${path}[${index}]`,
        );
      }
    }
  }

  generatorNumber(value: unknown, path: string): string | undefined {
    if (typeof value === 'number') {
      this.finiteNumber(value, path);
      return 'scalar';
    }
    if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
      this.type('finite number or 2-4 component number array', value, path);
      return undefined;
    }
    this.denseArray(value, path);
    value.forEach((item, index) => this.finiteNumber(item, `${path}[${index}]`));
    return `vec${value.length}`;
  }

  color(value: unknown, path: string): void {
    if (typeof value === 'string') {
      if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value)) {
        this.error(
          'NACHI_ASSET_VALUE_INVALID',
          'Color strings must use #RGB, #RGBA, #RRGGBB, or #RRGGBBAA syntax.',
          path,
        );
      }
      return;
    }
    if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)) {
      this.type('color string or 3-4 component number array', value, path);
      return;
    }
    this.denseArray(value, path);
    value.forEach((item, index) => this.finiteNumber(item, `${path}[${index}]`));
  }

  record(value: unknown, path: string): value is UnknownRecord {
    if (!isPlainRecord(value)) {
      this.type('plain object', value, path);
      return false;
    }
    return true;
  }

  required(value: UnknownRecord, fields: readonly string[], path: string): void {
    for (const field of fields) {
      if (!(field in value)) {
        this.error(
          'NACHI_ASSET_REQUIRED_FIELD',
          `Required field "${field}" is missing.`,
          `${path}.${field}`,
        );
      }
    }
  }

  unknownFields(value: UnknownRecord, fields: ReadonlySet<string>, path: string): void {
    for (const field of Object.keys(value)) {
      if (!fields.has(field)) {
        this.error('NACHI_ASSET_UNKNOWN_FIELD', `Unknown field "${field}".`, `${path}.${field}`);
      }
    }
  }

  stringArray(value: unknown, path: string): void {
    if (!Array.isArray(value)) {
      this.type('array', value, path);
      return;
    }
    this.denseArray(value, path);
    value.forEach((item, index) => {
      if (typeof item !== 'string') this.type('string', item, `${path}[${index}]`);
    });
  }

  numberTuple(value: unknown, length: number, path: string): void {
    if (!Array.isArray(value) || value.length !== length) {
      this.type(`${length}-component number array`, value, path);
      return;
    }
    this.denseArray(value, path);
    value.forEach((item, index) => this.finiteNumber(item, `${path}[${index}]`));
  }

  typedValue(type: AttributeType, value: unknown, path: string): void {
    const tupleLength =
      type === 'vec2'
        ? 2
        : type === 'vec3'
          ? 3
          : type === 'vec4' || type === 'color' || type === 'quat'
            ? 4
            : type === 'mat3'
              ? 9
              : type === 'mat4'
                ? 16
                : undefined;
    if (tupleLength !== undefined) {
      this.numberTuple(value, tupleLength, path);
      return;
    }
    if (type === 'bool') {
      if (typeof value !== 'boolean') this.type('boolean', value, path);
      return;
    }
    if (type === 'f32') {
      this.finiteNumber(value, path);
      return;
    }
    if (!Number.isSafeInteger(value) || (type === 'u32' && (value as number) < 0)) {
      this.type(type === 'u32' ? 'non-negative safe integer' : 'safe integer', value, path);
    }
  }

  finiteNumber(value: unknown, path: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value))
      this.type('finite number', value, path);
  }

  literal(value: unknown, expected: string, path: string): void {
    this.error(
      'NACHI_ASSET_VALUE_INVALID',
      `Expected literal "${expected}", received ${String(value)}.`,
      path,
    );
  }

  type(expected: string, value: unknown, path: string): void {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    this.error('NACHI_ASSET_TYPE_MISMATCH', `Expected ${expected}, received ${actual}.`, path);
  }

  error(code: string, message: string, path?: string, hint?: string): void {
    pushDiagnostic(this.diagnostics, this.phase, code, message, path, hint);
  }
}

function collectSerializableDiagnostics(value: unknown, phase: DiagnosticPhase): VfxDiagnostic[] {
  const diagnostics: VfxDiagnostic[] = [];
  const active = new Set<object>();
  const visit = (item: unknown, path: string, depth = 0): void => {
    if (depth > MAX_JSON_DEPTH) {
      pushDiagnostic(
        diagnostics,
        phase,
        'NACHI_ASSET_MAX_DEPTH_EXCEEDED',
        `JSON asset data must not exceed ${MAX_JSON_DEPTH} nested containers.`,
        path,
      );
      return;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item))
        pushDiagnostic(
          diagnostics,
          phase,
          'NACHI_ASSET_NON_FINITE_NUMBER',
          'JSON numbers must be finite.',
          path,
        );
      return;
    }
    if (typeof item === 'function') {
      pushDiagnostic(
        diagnostics,
        phase,
        'NACHI_ASSET_NON_SERIALIZABLE',
        'Functions cannot be stored in a nachi effect asset.',
        path,
        'Use a registered function-ref or callback-ref.',
      );
      return;
    }
    if (typeof item === 'undefined' || typeof item === 'symbol' || typeof item === 'bigint') {
      pushDiagnostic(
        diagnostics,
        phase,
        'NACHI_ASSET_NON_SERIALIZABLE',
        `${typeof item} is not a JSON value.`,
        path,
      );
      return;
    }
    if (active.has(item)) {
      pushDiagnostic(
        diagnostics,
        phase,
        'NACHI_ASSET_CYCLIC_VALUE',
        'Cyclic JavaScript object graphs cannot be serialized.',
        path,
      );
      return;
    }
    if (!Array.isArray(item) && !isPlainRecord(item)) {
      pushDiagnostic(
        diagnostics,
        phase,
        'NACHI_ASSET_NON_SERIALIZABLE',
        'Class instances, Three.js resources, DOM objects, and GPU objects are outside the declarative JSON subset.',
        path,
      );
      return;
    }
    active.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item)) {
          pushDiagnostic(
            diagnostics,
            phase,
            'NACHI_ASSET_SPARSE_ARRAY',
            'Sparse arrays are not valid JSON asset data.',
            `${path}[${index}]`,
          );
          continue;
        }
        visit(item[index], `${path}[${index}]`, depth + 1);
      }
    } else {
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key === 'symbol') {
          pushDiagnostic(
            diagnostics,
            phase,
            'NACHI_ASSET_NON_SERIALIZABLE',
            'Symbol-keyed fields are not JSON.',
            path,
          );
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (
          key === 'factory' &&
          item.kind === 'module' &&
          (item.type === 'core/tsl-module' || item.type === 'core/neighbor-grid-tsl') &&
          descriptor?.enumerable === false &&
          'value' in descriptor &&
          typeof descriptor.value === 'function'
        ) {
          continue;
        }
        if (
          key === 'factory' &&
          (item.kind === 'grid2d-stage-module' || item.kind === 'grid3d-stage-module') &&
          item.source === 'inline' &&
          descriptor?.enumerable === false
        ) {
          pushDiagnostic(
            diagnostics,
            phase,
            'NACHI_ASSET_INLINE_FUNCTION',
            'Inline grid TSL factories are authoring-only.',
            `${path}.source`,
            'Use a matching registered Grid2D/Grid3D function reference.',
          );
          continue;
        }
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          pushDiagnostic(
            diagnostics,
            phase,
            'NACHI_ASSET_NON_SERIALIZABLE',
            'Non-enumerable fields and property accessors are not part of the declarative JSON subset.',
            `${path}.${key}`,
          );
          continue;
        }
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    }
    active.delete(item);
  };
  visit(value, 'effect');
  return diagnostics;
}

function parseInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new VfxDiagnosticError([
      {
        code: 'NACHI_ASSET_JSON_INVALID',
        message: `Effect asset is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        path: '$',
        phase: 'deserialize',
        severity: 'error',
      },
    ]);
  }
}

function gridStageSourceDiagnostics(
  input: unknown,
  options: LoadEffectOptions,
): readonly VfxDiagnostic[] {
  if (!isRecord(input) || !isRecord(input.effect) || !isRecord(input.effect.elements)) return [];
  const diagnostics: VfxDiagnostic[] = [];
  for (const [key, element] of Object.entries(input.effect.elements)) {
    if (!isRecord(element) || element.kind !== 'sim-stage' || !isRecord(element.update)) continue;
    const source = element.update.source;
    const path = `$.effect.elements.${key}.update.source`;
    const isGrid3D = element.update.kind === 'grid3d-stage-module';
    if (typeof source === 'string') {
      const builtins = isGrid3D ? GRID3D_BUILTIN_STAGE_SOURCES : GRID2D_BUILTIN_STAGE_SOURCES;
      if (source !== 'inline' && !builtins.has(source)) {
        pushDiagnostic(
          diagnostics,
          'deserialize',
          'NACHI_ASSET_GRID_STAGE_SOURCE_UNKNOWN',
          `Unknown ${isGrid3D ? 'Grid3D' : 'Grid2D'} built-in stage source "${source}".`,
          path,
        );
      }
      continue;
    }
    if (!isRecord(source)) continue;
    const registry = isGrid3D ? options.grid3DStageRegistry : options.grid2DStageRegistry;
    const resolved = isGrid3D
      ? options.grid3DStageRegistry?.resolve(source as never)
      : options.grid2DStageRegistry?.resolve(source as never);
    if (!registry || resolved === undefined) {
      pushDiagnostic(
        diagnostics,
        'deserialize',
        'NACHI_ASSET_GRID_STAGE_FUNCTION_UNRESOLVED',
        `${isGrid3D ? 'Grid3D' : 'Grid2D'} stage function "${String(source.id)}@${String(source.version)}" is not registered.`,
        path,
      );
    }
  }
  return diagnostics;
}

function gridStageConfigDiagnostics(input: unknown): readonly VfxDiagnostic[] {
  if (!isRecord(input) || !isRecord(input.effect) || !isRecord(input.effect.elements)) return [];
  const elements = input.effect.elements;
  const diagnostics: VfxDiagnostic[] = [];
  for (const [key, element] of Object.entries(elements)) {
    if (!isRecord(element) || element.kind !== 'sim-stage' || !isRecord(element.update)) continue;
    if (
      element.update.source !== 'core/grid2d-inject' &&
      element.update.source !== 'core/grid3d-inject'
    )
      continue;
    if (typeof element.target !== 'string' || !isRecord(element.update.config)) continue;
    const target = elements[element.target];
    if (!isRecord(target) || !isRecord(target.channels)) continue;
    const values = element.update.config.values;
    if (!isRecord(values)) continue;
    const dimensions = element.update.source === 'core/grid3d-inject' ? 3 : 2;
    for (const [name, value] of Object.entries(values)) {
      const declaration = target.channels[name];
      const type = isRecord(declaration) ? declaration.type : undefined;
      const valid =
        type === 'f32'
          ? typeof value === 'number' && Number.isFinite(value)
          : type === `vec${dimensions}` &&
            Array.isArray(value) &&
            value.length === dimensions &&
            value.every((component) => typeof component === 'number' && Number.isFinite(component));
      if (!valid) {
        pushDiagnostic(
          diagnostics,
          'deserialize',
          dimensions === 3
            ? 'NACHI_GRID3D_STAGE_VALUE_INVALID'
            : 'NACHI_GRID2D_STAGE_VALUE_INVALID',
          `Grid inject value for "${name}" must match the target channel type and contain only finite components.`,
          `$.effect.elements.${key}.update.config.values.${name}`,
        );
      }
    }
  }
  return diagnostics;
}

export function validateEffectAsset(
  input: unknown,
  options: LoadEffectOptions = {},
): readonly VfxDiagnostic[] {
  const validator = new AssetValidator('deserialize');
  validator.document(input);
  return [
    ...validator.diagnostics,
    ...gridStageSourceDiagnostics(input, options),
    ...gridStageConfigDiagnostics(input),
  ];
}

export function serializeEffect<
  Elements extends EffectElements,
  Parameters extends ParameterSchema,
>(definition: EffectDefinition<Elements, Parameters>): EffectAssetDocumentV1 {
  const diagnostics = collectSerializableDiagnostics(definition, 'serialize');
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  const document = {
    format: EFFECT_ASSET_FORMAT,
    version: EFFECT_ASSET_VERSION,
    effect: jsonClone(definition),
  } satisfies EffectAssetDocumentV1;
  const validator = new AssetValidator('serialize');
  validator.document(document);
  const validationDiagnostics = [...validator.diagnostics, ...gridStageConfigDiagnostics(document)];
  if (validationDiagnostics.length > 0) throw new VfxDiagnosticError(validationDiagnostics);
  return document;
}

function migratedDocument(input: unknown, options: LoadEffectOptions): UnknownRecord {
  const parsed = parseInput(input);
  const migrated = (options.migrations ?? defaultEffectAssetMigrations).migrate(
    parsed,
    EFFECT_ASSET_VERSION,
  );
  const validator = new AssetValidator('deserialize');
  validator.document(migrated);
  const diagnostics = [
    ...validator.diagnostics,
    ...gridStageSourceDiagnostics(migrated, options),
    ...gridStageConfigDiagnostics(migrated),
  ];
  if (diagnostics.length > 0) throw new VfxDiagnosticError(diagnostics);
  return jsonClone(migrated) as UnknownRecord;
}

function definitionDiagnostics(error: VfxDiagnosticError, path: string): readonly VfxDiagnostic[] {
  return error.diagnostics.map((item) => ({
    code: 'NACHI_ASSET_DEFINITION_INVALID',
    message: item.message,
    path: item.path === undefined ? path : `${path}.${item.path}`,
    phase: 'deserialize' as const,
    severity: 'error' as const,
    hint: `Underlying definition diagnostic: ${item.code}`,
  }));
}

class EffectLoader {
  readonly #documents = new Map<string, UnknownRecord>();
  readonly #resolvedElements = new Map<string, EffectElementDefinition>();
  readonly #resolving = new Set<string>();

  constructor(readonly options: LoadEffectOptions) {}

  load(
    document: UnknownRecord,
    assetId: string,
  ): EffectDefinition<EffectElements, ParameterSchema> {
    this.#documents.set(assetId, document.effect as UnknownRecord);
    const effect = document.effect as UnknownRecord;
    const rawElements = effect.elements as UnknownRecord;
    const elements = Object.fromEntries(
      Object.keys(rawElements).map((key) => [
        key,
        this.resolveElement(assetId, key, `$.effect.elements.${key}`),
      ]),
    ) as EffectElements;
    try {
      const config = {
        elements,
        ...(effect.parameters === undefined
          ? {}
          : { parameters: effect.parameters as ParameterSchema }),
        ...(effect.scalability === undefined
          ? {}
          : { scalability: effect.scalability as EffectDefinition['scalability'] }),
        ...(effect.timeline === undefined
          ? {}
          : { timeline: effect.timeline as EffectDefinition['timeline'] }),
      } as EffectConfig<EffectElements, ParameterSchema>;
      return defineEffect(config) as EffectDefinition<EffectElements, ParameterSchema>;
    } catch (error) {
      if (!(error instanceof VfxDiagnosticError)) throw error;
      throw new VfxDiagnosticError(definitionDiagnostics(error, '$.effect'));
    }
  }

  resolveElement(assetId: string, key: string, path: string): EffectElementDefinition {
    const identity = `${assetId}#${key}`;
    const cached = this.#resolvedElements.get(identity);
    if (cached) return cached;
    if (this.#resolving.has(identity)) {
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_ASSET_EXTENDS_CYCLE',
          message: `Asset emitter inheritance contains a cycle at ${identity}.`,
          path,
          phase: 'deserialize',
          severity: 'error',
        },
      ]);
    }
    const effect = this.#documentEffect(assetId, path);
    const elements = effect.elements as UnknownRecord;
    const raw = elements[key];
    if (!isRecord(raw)) {
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_ASSET_EXTENDS_TARGET_UNKNOWN',
          message: `Asset element "${key}" does not exist in ${assetId}.`,
          path,
          phase: 'deserialize',
          severity: 'error',
        },
      ]);
    }
    this.#resolving.add(identity);
    try {
      let resolved: EffectElementDefinition;
      if (raw.kind === 'emitter-extends') {
        const reference = raw.extends as string;
        const { referencedAssetId, referencedKey } = this.#parseReference(
          reference,
          assetId,
          `${path}.extends`,
        );
        const base = this.resolveElement(referencedAssetId, referencedKey, `${path}.extends`);
        if (base.kind !== 'emitter') {
          throw new VfxDiagnosticError([
            {
              code: 'NACHI_ASSET_EXTENDS_BASE_TYPE_MISMATCH',
              message: `Asset inheritance target ${reference} is not an emitter.`,
              path: `${path}.extends`,
              phase: 'deserialize',
              severity: 'error',
            },
          ]);
        }
        try {
          resolved = defineEmitter(base, raw.overrides as EmitterOverrideConfig);
        } catch (error) {
          if (!(error instanceof VfxDiagnosticError)) throw error;
          throw new VfxDiagnosticError(definitionDiagnostics(error, `${path}.overrides`));
        }
      } else if (raw.kind === 'emitter') {
        const { kind: _kind, ...config } = raw;
        void _kind;
        try {
          resolved = defineEmitter(config as unknown as EmitterConfig);
        } catch (error) {
          if (!(error instanceof VfxDiagnosticError)) throw error;
          throw new VfxDiagnosticError(definitionDiagnostics(error, path));
        }
      } else {
        resolved = jsonClone(raw) as unknown as EffectElementDefinition;
      }
      this.#resolvedElements.set(identity, resolved);
      return resolved;
    } finally {
      this.#resolving.delete(identity);
    }
  }

  #parseReference(
    reference: string,
    currentAssetId: string,
    path: string,
  ): { readonly referencedAssetId: string; readonly referencedKey: string } {
    const hash = reference.indexOf('#');
    if (!isEmitterReference(reference)) {
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_ASSET_EXTENDS_REFERENCE_INVALID',
          message: 'Emitter extends references use "#element" or "asset-id#element" syntax.',
          path,
          phase: 'deserialize',
          severity: 'error',
        },
      ]);
    }
    const assetPart = reference.slice(0, hash);
    const referencedAssetId = assetPart.length === 0 ? currentAssetId : assetPart;
    const referencedKey = reference.slice(hash + 1);
    if (!this.#documents.has(referencedAssetId))
      this.#loadExternalDocument(referencedAssetId, path);
    return { referencedAssetId, referencedKey };
  }

  #loadExternalDocument(assetId: string, path: string): void {
    if (!this.options.resolveAsset) {
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_ASSET_RESOLVER_REQUIRED',
          message: `Resolving external emitter asset "${assetId}" requires LoadEffectOptions.resolveAsset.`,
          path,
          phase: 'deserialize',
          severity: 'error',
        },
      ]);
    }
    let input: unknown;
    try {
      input = this.options.resolveAsset(assetId);
    } catch (error) {
      throw new VfxDiagnosticError([
        {
          code: 'NACHI_ASSET_REFERENCE_LOAD_FAILED',
          message: `Failed to load referenced asset "${assetId}": ${error instanceof Error ? error.message : String(error)}`,
          path,
          phase: 'deserialize',
          severity: 'error',
        },
      ]);
    }
    const document = migratedDocument(input, this.options);
    this.#documents.set(assetId, document.effect as UnknownRecord);
  }

  #documentEffect(assetId: string, path: string): UnknownRecord {
    const effect = this.#documents.get(assetId);
    if (effect) return effect;
    this.#loadExternalDocument(assetId, path);
    return this.#documents.get(assetId)!;
  }
}

export function loadEffect(
  input: unknown,
  options: LoadEffectOptions = {},
): EffectDefinition<EffectElements, ParameterSchema> {
  const document = migratedDocument(input, options);
  return new EffectLoader(options).load(document, options.assetId ?? '$root');
}
