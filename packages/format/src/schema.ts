import { EFFECT_ASSET_FORMAT, EFFECT_ASSET_VERSION } from './types.js';

/** Draft 2020-12 schema for the stable envelope and extensible declarative effect body. */
export const effectAssetSchemaV1 = {
  $id: 'https://nachi.dev/schema/effect-v1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  $defs: {
    element: {
      oneOf: [
        { $ref: '#/$defs/emitter' },
        { $ref: '#/$defs/visualElement' },
        { $ref: '#/$defs/emitterExtension' },
        { $ref: '#/$defs/grid2d' },
        { $ref: '#/$defs/grid3d' },
        { $ref: '#/$defs/neighborGrid' },
        { $ref: '#/$defs/simStage' },
      ],
    },
    grid2d: {
      additionalProperties: false,
      properties: {
        boundary: { const: 'clamp' },
        channels: {
          additionalProperties: { $ref: '#/$defs/grid2dChannel' },
          minProperties: 1,
          type: 'object',
        },
        kind: { const: 'grid2d' },
        resolution: {
          items: { minimum: 1, type: 'integer' },
          maxItems: 2,
          minItems: 2,
          type: 'array',
        },
        version: { const: 1 },
      },
      required: ['kind', 'version', 'resolution', 'channels', 'boundary'],
      type: 'object',
    },
    grid2dChannel: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            default: { type: 'number' },
            type: { const: 'f32' },
          },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            default: {
              items: { type: 'number' },
              maxItems: 2,
              minItems: 2,
              type: 'array',
            },
            type: { const: 'vec2' },
          },
          required: ['type'],
          type: 'object',
        },
      ],
    },
    grid2dStageFunctionRef: {
      additionalProperties: false,
      properties: {
        id: { minLength: 1, type: 'string' },
        kind: { const: 'grid2d-function-ref' },
        version: { minimum: 1, type: 'integer' },
      },
      required: ['id', 'kind', 'version'],
      type: 'object',
    },
    grid2dStageModule: {
      additionalProperties: false,
      properties: {
        config: { type: 'object' },
        kind: { const: 'grid2d-stage-module' },
        source: {
          oneOf: [
            { minLength: 1, not: { const: 'inline' }, type: 'string' },
            { $ref: '#/$defs/grid2dStageFunctionRef' },
          ],
        },
        version: { const: 1 },
      },
      required: ['config', 'kind', 'source', 'version'],
      type: 'object',
    },
    grid3d: {
      additionalProperties: false,
      properties: {
        boundary: { const: 'clamp' },
        channels: {
          additionalProperties: { $ref: '#/$defs/grid3dChannel' },
          minProperties: 1,
          type: 'object',
        },
        kind: { const: 'grid3d' },
        resolution: {
          items: { minimum: 1, type: 'integer' },
          maxItems: 3,
          minItems: 3,
          type: 'array',
        },
        version: { const: 1 },
      },
      required: ['kind', 'version', 'resolution', 'channels', 'boundary'],
      type: 'object',
    },
    grid3dChannel: {
      oneOf: [
        {
          additionalProperties: false,
          properties: { default: { type: 'number' }, type: { const: 'f32' } },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            default: {
              items: { type: 'number' },
              maxItems: 3,
              minItems: 3,
              type: 'array',
            },
            type: { const: 'vec3' },
          },
          required: ['type'],
          type: 'object',
        },
      ],
    },
    grid3dStageFunctionRef: {
      additionalProperties: false,
      properties: {
        id: { minLength: 1, type: 'string' },
        kind: { const: 'grid3d-function-ref' },
        version: { minimum: 1, type: 'integer' },
      },
      required: ['id', 'kind', 'version'],
      type: 'object',
    },
    grid3dStageModule: {
      additionalProperties: false,
      properties: {
        config: { type: 'object' },
        kind: { const: 'grid3d-stage-module' },
        source: {
          oneOf: [
            { minLength: 1, not: { const: 'inline' }, type: 'string' },
            { $ref: '#/$defs/grid3dStageFunctionRef' },
          ],
        },
        version: { const: 1 },
      },
      required: ['config', 'kind', 'source', 'version'],
      type: 'object',
    },
    neighborGrid: {
      additionalProperties: false,
      properties: {
        cellCapacity: { minimum: 1, type: 'integer' },
        cellSize: { exclusiveMinimum: 0, type: 'number' },
        kind: { const: 'neighbor-grid' },
        origin: {
          items: { type: 'number' },
          maxItems: 3,
          minItems: 3,
          type: 'array',
        },
        resolution: {
          items: { minimum: 1, type: 'integer' },
          maxItems: 3,
          minItems: 3,
          type: 'array',
        },
        version: { const: 1 },
      },
      required: ['kind', 'version', 'resolution', 'cellCapacity', 'cellSize', 'origin'],
      type: 'object',
    },
    simStage: {
      additionalProperties: false,
      properties: {
        iterations: { minimum: 1, type: 'integer' },
        kind: { const: 'sim-stage' },
        phase: { enum: ['before-particles', 'after-particles'] },
        target: { minLength: 1, type: 'string' },
        update: {
          oneOf: [{ $ref: '#/$defs/grid2dStageModule' }, { $ref: '#/$defs/grid3dStageModule' }],
        },
        version: { const: 1 },
      },
      required: ['kind', 'version', 'target', 'phase', 'iterations', 'update'],
      type: 'object',
    },
    emitter: {
      additionalProperties: false,
      properties: {
        attributes: { type: 'object' },
        bounds: { type: 'object' },
        capacity: { minimum: 1, type: 'integer' },
        events: { type: 'object' },
        init: { items: { $ref: '#/$defs/module' }, type: 'array' },
        integration: { enum: ['euler', 'none'] },
        kind: { const: 'emitter' },
        lifecycle: { type: 'object' },
        parameters: { type: 'object' },
        quality: { type: 'object' },
        render: { $ref: '#/$defs/moduleOrArray' },
        spawn: { $ref: '#/$defs/moduleOrArray' },
        update: { items: { $ref: '#/$defs/module' }, type: 'array' },
      },
      required: ['kind', 'capacity', 'spawn', 'render'],
      type: 'object',
    },
    emitterExtension: {
      additionalProperties: false,
      properties: {
        extends: { pattern: '^[^#]*#[^#]+$', type: 'string' },
        kind: { const: 'emitter-extends' },
        overrides: { type: 'object' },
      },
      required: ['kind', 'extends', 'overrides'],
      type: 'object',
    },
    module: {
      additionalProperties: false,
      properties: {
        access: {
          additionalProperties: false,
          properties: {
            optionalReads: { items: { type: 'string' }, type: 'array' },
            reads: { items: { type: 'string' }, type: 'array' },
            writes: { items: { type: 'string' }, type: 'array' },
          },
          required: ['reads', 'writes'],
          type: 'object',
        },
        config: { type: 'object' },
        kind: { const: 'module' },
        label: { type: 'string' },
        stage: { enum: ['spawn', 'init', 'update', 'event', 'render'] },
        type: { minLength: 1, type: 'string' },
        version: { minimum: 1, type: 'integer' },
      },
      required: ['kind', 'type', 'version', 'stage', 'config'],
      type: 'object',
    },
    moduleOrArray: {
      oneOf: [{ $ref: '#/$defs/module' }, { items: { $ref: '#/$defs/module' }, type: 'array' }],
    },
    visualElement: {
      additionalProperties: false,
      properties: {
        config: { type: 'object' },
        kind: { const: 'visual-element' },
        type: { minLength: 1, type: 'string' },
        version: { minimum: 1, type: 'integer' },
      },
      required: ['kind', 'type', 'version', 'config'],
      type: 'object',
    },
  },
  properties: {
    effect: {
      additionalProperties: false,
      properties: {
        elements: {
          additionalProperties: { $ref: '#/$defs/element' },
          propertyNames: { pattern: '^[^#]*$' },
          type: 'object',
        },
        kind: { const: 'effect' },
        parameters: { type: 'object' },
        scalability: { type: 'object' },
        timeline: { oneOf: [{ type: 'array' }, { type: 'object' }] },
      },
      required: ['kind', 'elements'],
      type: 'object',
    },
    format: { const: EFFECT_ASSET_FORMAT },
    version: { const: EFFECT_ASSET_VERSION },
  },
  required: ['format', 'version', 'effect'],
  title: 'Nachi effect asset v1',
  type: 'object',
} as const;
