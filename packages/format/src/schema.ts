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
      ],
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
