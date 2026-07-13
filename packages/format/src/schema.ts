import { EFFECT_ASSET_FORMAT, EFFECT_ASSET_VERSION } from './types.js';

/** Draft 2020-12 schema for the stable envelope and closed format-owned effect structures. */
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
    attribute: {
      additionalProperties: false,
      properties: {
        default: {},
        kind: { const: 'attribute' },
        name: { minLength: 1, type: 'string' },
        transient: { type: 'boolean' },
        type: {
          enum: [
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
          ],
        },
      },
      required: ['kind', 'name', 'type', 'default'],
      type: 'object',
    },
    attributes: {
      additionalProperties: { $ref: '#/$defs/attribute' },
      type: 'object',
    },
    bounds: {
      additionalProperties: false,
      properties: {
        center: { items: { type: 'number' }, maxItems: 3, minItems: 3, type: 'array' },
        radius: { type: 'number' },
      },
      required: ['radius'],
      type: 'object',
    },
    vec3: {
      items: { type: 'number' },
      maxItems: 3,
      minItems: 3,
      type: 'array',
    },
    positionSphereArc: {
      additionalProperties: false,
      properties: {
        axis: { $ref: '#/$defs/vec3' },
        thetaMax: {},
      },
      required: ['thetaMax'],
      type: 'object',
    },
    positionSphereConfig: {
      additionalProperties: false,
      properties: {
        arc: { $ref: '#/$defs/positionSphereArc' },
        center: {},
        radius: {},
        surfaceOnly: { type: 'boolean' },
      },
      required: ['radius'],
      type: 'object',
    },
    events: {
      additionalProperties: { $ref: '#/$defs/moduleOrArray' },
      type: 'object',
    },
    lifecycle: {
      additionalProperties: false,
      properties: {
        duration: { type: 'number' },
        loopCount: { oneOf: [{ const: 'infinite' }, { type: 'integer' }] },
        prewarm: { type: 'number' },
        startDelay: { type: 'number' },
      },
      type: 'object',
    },
    parameter: {
      additionalProperties: false,
      properties: {
        default: {},
        kind: { const: 'parameter-definition' },
        mutable: { type: 'boolean' },
        path: { pattern: '^User\\.', type: 'string' },
        type: {
          enum: [
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
          ],
        },
      },
      required: ['kind', 'path', 'type', 'default'],
      type: 'object',
    },
    parameters: {
      additionalProperties: { $ref: '#/$defs/parameter' },
      propertyNames: { pattern: '^User\\.' },
      type: 'object',
    },
    qualityFeatures: {
      additionalProperties: false,
      properties: {
        lit: { type: 'boolean' },
        soft: { type: 'boolean' },
        sorted: { type: 'boolean' },
      },
      type: 'object',
    },
    qualityTier: {
      additionalProperties: false,
      properties: {
        capacityScale: { type: 'number' },
        features: { $ref: '#/$defs/qualityFeatures' },
        spawnRateScale: { type: 'number' },
      },
      type: 'object',
    },
    quality: {
      additionalProperties: false,
      properties: {
        epic: { $ref: '#/$defs/qualityTier' },
        high: { $ref: '#/$defs/qualityTier' },
        low: { $ref: '#/$defs/qualityTier' },
        medium: { $ref: '#/$defs/qualityTier' },
      },
      type: 'object',
    },
    moduleOverride: {
      additionalProperties: false,
      properties: {
        mode: { enum: ['append', 'merge', 'replace'] },
        modules: { items: { $ref: '#/$defs/module' }, type: 'array' },
        order: { items: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, type: 'array' },
        remove: { items: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, type: 'array' },
      },
      type: 'object',
    },
    emitterOverrides: {
      additionalProperties: false,
      properties: {
        attributes: { $ref: '#/$defs/attributes' },
        bounds: { $ref: '#/$defs/bounds' },
        capacity: { minimum: 1, type: 'integer' },
        events: { $ref: '#/$defs/events' },
        init: { $ref: '#/$defs/moduleOverride' },
        integration: { enum: ['euler', 'none'] },
        lifecycle: { $ref: '#/$defs/lifecycle' },
        offset: { $ref: '#/$defs/vec3' },
        parameters: { $ref: '#/$defs/parameters' },
        quality: { $ref: '#/$defs/quality' },
        render: { $ref: '#/$defs/moduleOverride' },
        spawn: { $ref: '#/$defs/moduleOrArray' },
        update: { $ref: '#/$defs/moduleOverride' },
      },
      type: 'object',
    },
    scalability: {
      additionalProperties: false,
      properties: {
        culling: {
          additionalProperties: false,
          properties: {
            distance: {
              additionalProperties: false,
              properties: { fadeEnd: { type: 'number' }, fadeStart: { type: 'number' } },
              required: ['fadeEnd'],
              type: 'object',
            },
            frustum: { type: 'boolean' },
          },
          type: 'object',
        },
        significance: {
          additionalProperties: false,
          properties: { priority: { type: 'number' } },
          type: 'object',
        },
      },
      type: 'object',
    },
    timelineAction: {
      oneOf: [
        {
          additionalProperties: false,
          properties: { kind: { enum: ['play', 'stop'] }, target: { type: 'string' } },
          required: ['kind', 'target'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            duration: { type: 'number' },
            frequency: { type: 'number' },
            kind: { const: 'camera-shake' },
            strength: { type: 'number' },
          },
          required: ['kind', 'strength'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            durationMs: { type: 'number' },
            kind: { const: 'hit-stop' },
            timeScale: { type: 'number' },
          },
          required: ['kind', 'durationMs'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: { kind: { const: 'marker' }, name: { type: 'string' }, payload: {} },
          required: ['kind', 'name'],
          type: 'object',
        },
      ],
    },
    timelineEntry: {
      additionalProperties: false,
      properties: {
        actions: { items: { $ref: '#/$defs/timelineAction' }, type: 'array' },
        at: { type: 'number' },
      },
      required: ['at', 'actions'],
      type: 'object',
    },
    timeline: {
      oneOf: [
        { items: { $ref: '#/$defs/timelineEntry' }, type: 'array' },
        {
          additionalProperties: false,
          properties: {
            duration: { type: 'number' },
            entries: { items: { $ref: '#/$defs/timelineEntry' }, type: 'array' },
            kind: { const: 'timeline' },
            loop: { oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
            speed: { type: 'number' },
          },
          required: ['kind', 'entries'],
          type: 'object',
        },
      ],
    },
    emitter: {
      additionalProperties: false,
      properties: {
        attributes: { $ref: '#/$defs/attributes' },
        bounds: { $ref: '#/$defs/bounds' },
        capacity: { minimum: 1, type: 'integer' },
        events: { $ref: '#/$defs/events' },
        init: { items: { $ref: '#/$defs/module' }, type: 'array' },
        integration: { enum: ['euler', 'none'] },
        kind: { const: 'emitter' },
        lifecycle: { $ref: '#/$defs/lifecycle' },
        offset: { $ref: '#/$defs/vec3' },
        parameters: { $ref: '#/$defs/parameters' },
        quality: { $ref: '#/$defs/quality' },
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
        overrides: { $ref: '#/$defs/emitterOverrides' },
      },
      required: ['kind', 'extends', 'overrides'],
      type: 'object',
    },
    module: {
      additionalProperties: false,
      allOf: [
        {
          if: {
            properties: { type: { const: 'core/position-sphere' } },
            required: ['type'],
          },
          then: { properties: { config: { $ref: '#/$defs/positionSphereConfig' } } },
        },
      ],
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
        parameters: { $ref: '#/$defs/parameters' },
        scalability: { $ref: '#/$defs/scalability' },
        timeline: { $ref: '#/$defs/timeline' },
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
