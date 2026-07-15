import { bloom as threeBloom } from 'three/addons/tsl/display/BloomNode.js';
import * as THREE from 'three/webgpu';
import type Node from 'three/src/nodes/core/Node.js';
import type UniformNode from 'three/src/nodes/core/UniformNode.js';

import {
  POST_STANDARD_ORDER,
  validatePostPipelineConfig,
  validateHeatHazeRegion,
  validateShockwaveSource,
} from './authoring.js';
import { externalBinding, finite, invalid, invalidOrder } from './diagnostics.js';
import {
  abs,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  pass,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec4,
} from './tsl.js';
import type {
  BloomPass,
  HeatHazeRegion,
  PostPassKind,
  PostPipelineConfig,
  RadialBlurPass,
  ScalarInput,
  ScreenDistortionPass,
  ShockwaveSource,
  Vec2Input,
} from './types.js';

type Sampler = (coordinate: Node<'vec2'>) => Node<'vec4'>;
type OwnedScalar = {
  readonly node: Node<'float'>;
  readonly uniform: UniformNode<'float', number> | null;
};
type OwnedVec2 = {
  readonly node: Node<'vec2'>;
  readonly uniform: UniformNode<'vec2', THREE.Vector2> | null;
};

interface ShockwaveControls {
  readonly fields: Readonly<{
    center: OwnedVec2;
    duration: OwnedScalar;
    enabled: OwnedScalar;
    radius: OwnedScalar;
    ringWidth: OwnedScalar;
    speed: OwnedScalar;
    startTime: OwnedScalar;
    strength: OwnedScalar;
  }>;
}

interface HeatHazeControls {
  readonly fields: Readonly<{
    center: OwnedVec2;
    enabled: OwnedScalar;
    feather: OwnedScalar;
    scale: OwnedScalar;
    size: OwnedVec2;
    speed: OwnedVec2;
    strength: OwnedScalar;
  }>;
}

export interface PostPipelineControls {
  setTime(value: number): void;
  setShockwave(index: number, source: Readonly<Required<ShockwaveSource>>): void;
  setHeatHaze(index: number, region: Readonly<Required<HeatHazeRegion>>): void;
}

export interface PostPrepareProgress {
  readonly completed: 0 | 1;
  readonly total: 1;
}

export interface PostPrepareOptions {
  readonly onProgress?: (progress: PostPrepareProgress) => void;
  /** Final output used by the live render loop. Defaults to the canvas. */
  readonly outputTarget?: THREE.RenderTarget | null;
  readonly signal?: AbortSignal;
}

export class PostPipeline {
  readonly renderPipeline: THREE.RenderPipeline;
  /** Render target used internally by the scene pass. */
  readonly sceneRenderTarget: THREE.RenderTarget;
  readonly controls: PostPipelineControls;
  readonly order: readonly PostPassKind[];
  readonly #effectDisposables: readonly { dispose(): void }[];
  readonly #renderer: THREE.WebGPURenderer;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    config: PostPipelineConfig,
  ) {
    this.#renderer = renderer;
    validatePostPipelineConfig(config);
    this.order = resolveOrder(config);
    const scenePass = pass(scene, camera);
    // PassNode applies these values lazily on its first update. Publish the final context now so
    // draw preparers can compile against the exact scene-pass cache key before that first frame.
    scenePass.renderTarget.samples = renderer.samples;
    scenePass.renderTarget.texture.type = renderer.getOutputBufferType();
    if (renderer.reversedDepthBuffer && scenePass.renderTarget.depthTexture) {
      scenePass.renderTarget.depthTexture.type = THREE.FloatType;
    }
    this.sceneRenderTarget = scenePass.renderTarget;
    const sceneColor = scenePass.getTextureNode('output');
    let sampler: Sampler = (coordinate) => vec4(sceneColor.sample(coordinate));
    let timeControl: OwnedScalar | null = null;
    let shockwaveControls: readonly ShockwaveControls[] = [];
    let heatHazeControls: readonly HeatHazeControls[] = [];
    const effectDisposables: { dispose(): void }[] = [scenePass];

    for (const kind of this.order) {
      if (kind === 'distortion') {
        const lowered = lowerDistortion(config.distortion!);
        sampler = applyDistortion(sampler, lowered);
        timeControl = lowered.time;
        shockwaveControls = lowered.shockwaves;
        heatHazeControls = lowered.heatHaze;
      } else if (kind === 'radialBlur') {
        sampler = applyRadialBlur(sampler, config.radialBlur!);
      } else {
        sampler = applyBloom(sampler, config.bloom!, effectDisposables);
      }
    }

    const renderPipeline = new THREE.RenderPipeline(renderer);
    renderPipeline.outputColorTransform = config.outputColorTransform ?? true;
    renderPipeline.outputNode = sampler(screenUV);
    this.renderPipeline = renderPipeline;
    this.#effectDisposables = effectDisposables;
    this.controls = Object.freeze({
      setTime(value: number): void {
        if (!timeControl)
          invalid('post.controls.setTime', 'requires a configured screen-distortion pass');
        if (!timeControl.uniform) externalBinding('screenDistortion.time');
        timeControl.uniform.value = finite(value, 'screenDistortion.time');
      },
      setShockwave(index: number, source: Readonly<Required<ShockwaveSource>>): void {
        const target = shockwaveControls[index];
        if (!target) invalid('post.controls.setShockwave.index', `has no shockwave slot ${index}`);
        validateShockwaveSource(source, index);
        const values = {
          center: controlVec2(
            target.fields.center,
            source.center,
            `screenDistortion.shockwaves[${index}].center`,
          ),
          radius: controlScalar(
            target.fields.radius,
            source.radius,
            `screenDistortion.shockwaves[${index}].radius`,
          ),
          ringWidth: controlScalar(
            target.fields.ringWidth,
            source.ringWidth,
            `screenDistortion.shockwaves[${index}].ringWidth`,
          ),
          strength: controlScalar(
            target.fields.strength,
            source.strength,
            `screenDistortion.shockwaves[${index}].strength`,
          ),
          speed: controlScalar(
            target.fields.speed,
            source.speed,
            `screenDistortion.shockwaves[${index}].speed`,
          ),
          startTime: controlScalar(
            target.fields.startTime,
            source.startTime,
            `screenDistortion.shockwaves[${index}].startTime`,
          ),
          duration: controlScalar(
            target.fields.duration,
            source.duration,
            `screenDistortion.shockwaves[${index}].duration`,
          ),
          enabled: controlScalar(
            target.fields.enabled,
            source.enabled,
            `screenDistortion.shockwaves[${index}].enabled`,
          ),
        };
        assignVec2(target.fields.center, values.center);
        assignScalar(target.fields.radius, values.radius);
        assignScalar(target.fields.ringWidth, values.ringWidth);
        assignScalar(target.fields.strength, values.strength);
        assignScalar(target.fields.speed, values.speed);
        assignScalar(target.fields.startTime, values.startTime);
        assignScalar(target.fields.duration, values.duration);
        assignScalar(target.fields.enabled, values.enabled);
      },
      setHeatHaze(index: number, region: Readonly<Required<HeatHazeRegion>>): void {
        const target = heatHazeControls[index];
        if (!target) invalid('post.controls.setHeatHaze.index', `has no heat-haze slot ${index}`);
        validateHeatHazeRegion(region, index);
        const values = {
          center: controlVec2(
            target.fields.center,
            region.center,
            `screenDistortion.heatHaze[${index}].center`,
          ),
          size: controlVec2(
            target.fields.size,
            region.size,
            `screenDistortion.heatHaze[${index}].size`,
          ),
          strength: controlScalar(
            target.fields.strength,
            region.strength,
            `screenDistortion.heatHaze[${index}].strength`,
          ),
          scale: controlScalar(
            target.fields.scale,
            region.scale,
            `screenDistortion.heatHaze[${index}].scale`,
          ),
          speed: controlVec2(
            target.fields.speed,
            region.speed,
            `screenDistortion.heatHaze[${index}].speed`,
          ),
          feather: controlScalar(
            target.fields.feather,
            region.feather,
            `screenDistortion.heatHaze[${index}].feather`,
          ),
          enabled: controlScalar(
            target.fields.enabled,
            region.enabled,
            `screenDistortion.heatHaze[${index}].enabled`,
          ),
        };
        assignVec2(target.fields.center, values.center);
        assignVec2(target.fields.size, values.size);
        assignScalar(target.fields.strength, values.strength);
        assignScalar(target.fields.scale, values.scale);
        assignVec2(target.fields.speed, values.speed);
        assignScalar(target.fields.feather, values.feather);
        assignScalar(target.fields.enabled, values.enabled);
      },
    });
  }

  render(): void {
    this.renderPipeline.render();
  }

  async prepare(options: PostPrepareOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    options.onProgress?.({ completed: 0, total: 1 });
    const previousTarget = this.#renderer.getRenderTarget();
    const previousMrt = this.#renderer.getMRT();
    try {
      // The final composite pipeline key includes the output format, sample count, and color
      // space. Rendering to the live output is the only reliable way to prepare that exact key.
      this.#renderer.setRenderTarget(options.outputTarget ?? null);
      this.#renderer.setMRT(null);
      this.render();
      await Promise.resolve();
      options.signal?.throwIfAborted();
      options.onProgress?.({ completed: 1, total: 1 });
    } finally {
      this.#renderer.setRenderTarget(previousTarget);
      this.#renderer.setMRT(previousMrt);
    }
  }

  dispose(): void {
    for (const disposable of this.#effectDisposables) disposable.dispose();
    this.renderPipeline.dispose();
  }
}

export function createPostPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  config: PostPipelineConfig,
): PostPipeline {
  return new PostPipeline(renderer, scene, camera, config);
}

function resolveOrder(config: PostPipelineConfig): readonly PostPassKind[] {
  const present = POST_STANDARD_ORDER.filter((kind) => config[kind] !== undefined);
  const order = config.order ?? present;
  if (order.length !== present.length || new Set(order).size !== order.length) {
    invalidOrder('post.order', 'must contain every configured pass exactly once');
  }
  for (const kind of order) {
    if (!POST_STANDARD_ORDER.includes(kind) || config[kind] === undefined) {
      invalidOrder('post.order', `contains absent or unknown pass ${kind}`);
    }
  }
  if (order.length === 0) invalidOrder('post.order', 'requires at least one configured pass');
  return Object.freeze([...order]);
}

function lowerDistortion(pass: ScreenDistortionPass): {
  readonly time: OwnedScalar;
  readonly shockwaves: readonly ShockwaveControls[];
  readonly heatHaze: readonly HeatHazeControls[];
} {
  const time = timeBinding(pass.config.time);
  const shockwaves = (pass.config.shockwaves ?? []).map((source) => ({
    fields: Object.freeze({
      center: ownedVec2(source.center),
      radius: ownedScalar(source.radius),
      ringWidth: ownedScalar(source.ringWidth),
      strength: ownedScalar(source.strength),
      speed: ownedScalar(source.speed, 0),
      startTime: ownedScalar(source.startTime, 0),
      duration: ownedScalar(source.duration, 1),
      enabled: ownedScalar(source.enabled, 1),
    }),
  }));
  const heatHaze = (pass.config.heatHaze ?? []).map((region) => ({
    fields: Object.freeze({
      center: ownedVec2(region.center),
      size: ownedVec2(region.size),
      strength: ownedScalar(region.strength),
      scale: ownedScalar(region.scale, 32),
      speed: ownedVec2(region.speed, [0.11, -0.07]),
      feather: ownedScalar(region.feather, 0.2),
      enabled: ownedScalar(region.enabled, 1),
    }),
  }));
  return { time, shockwaves, heatHaze };
}

function timeBinding(input: ScalarInput | undefined): OwnedScalar {
  if (input === undefined) {
    const result = uniform(0);
    return { node: result, uniform: result };
  }
  const floatInput = float as unknown as (value: ScalarInput) => Node<'float'>;
  return { node: floatInput(input), uniform: null };
}

function applyDistortion(previous: Sampler, lowered: ReturnType<typeof lowerDistortion>): Sampler {
  return (coordinate) => {
    let offset: Node<'vec2'> = vec2(0);
    for (const source of lowered.shockwaves) {
      const fields = source.fields;
      const delta = coordinate.sub(fields.center.node);
      const distance = length(delta);
      const elapsed = lowered.time.node.sub(fields.startTime.node);
      const radius = fields.radius.node.add(fields.speed.node.mul(max(elapsed, 0)));
      const ring = float(1)
        .sub(abs(distance.sub(radius)).div(fields.ringWidth.node))
        .clamp(0, 1);
      const active = elapsed
        .step(0)
        .mul(float(1).sub(elapsed.div(fields.duration.node)).clamp(0, 1));
      const direction = delta.div(max(distance, 0.000_001));
      offset = offset.add(
        direction.mul(fields.strength.node).mul(ring).mul(active).mul(fields.enabled.node),
      );
    }
    for (const region of lowered.heatHaze) {
      const fields = region.fields;
      const normalized = abs(coordinate.sub(fields.center.node)).div(fields.size.node.mul(0.5));
      const edge = float(1).sub(max(normalized.x, normalized.y));
      const mask = smoothstep(0, fields.feather.node, edge);
      const point = coordinate
        .mul(fields.scale.node)
        .add(fields.speed.node.mul(lowered.time.node).mul(fields.scale.node));
      const xNoise = valueNoise(point, 12.9898, 78.233);
      const yNoise = valueNoise(point, 39.3468, 11.1351);
      offset = offset.add(
        vec2(xNoise, yNoise).mul(fields.strength.node).mul(mask).mul(fields.enabled.node),
      );
    }
    return previous(coordinate.add(offset).clamp(0.001, 0.999));
  };
}

function applyRadialBlur(previous: Sampler, pass: RadialBlurPass): Sampler {
  const center = ownedVec2(pass.config.center, [0.5, 0.5]).node;
  const strength = ownedScalar(pass.config.strength, 0.15).node;
  const samples = pass.config.samples ?? 8;
  return (coordinate) => {
    if (samples === 1) return previous(coordinate);
    let sum: Node<'vec4'> = vec4(0);
    for (let index = 0; index < samples; index += 1) {
      const phase = index / (samples - 1);
      const sampleUv = coordinate.add(center.sub(coordinate).mul(strength).mul(phase));
      sum = sum.add(previous(sampleUv.clamp(0.001, 0.999)));
    }
    return sum.div(samples);
  };
}

function applyBloom(
  previous: Sampler,
  pass: BloomPass,
  disposables: { dispose(): void }[],
): Sampler {
  const input = previous(screenUV);
  const bloomFactory = threeBloom as unknown as (
    node: Node<'vec4'>,
    strength: ScalarInput,
    radius: ScalarInput,
    threshold: ScalarInput,
  ) => {
    dispose(): void;
    getTextureNode(): { sample(coordinate: Node<'vec2'>): Node<'vec4'> };
    setResolutionScale(scale: number): void;
  };
  const bloomNode = bloomFactory(
    input,
    pass.config.strength,
    pass.config.radius,
    pass.config.threshold,
  );
  disposables.push(bloomNode);
  bloomNode.setResolutionScale(pass.config.resolutionScale ?? 0.5);
  const bloomTexture = bloomNode.getTextureNode();
  return (coordinate) => previous(coordinate).add(bloomTexture.sample(coordinate));
}

function valueNoise(
  point: Node<'vec2'>,
  xCoefficient: number,
  yCoefficient: number,
): Node<'float'> {
  const cell = floor(point);
  const local = fract(point);
  const interpolation = local.mul(local).mul(float(3).sub(local.mul(2)));
  const bottom = mix(
    hashNoise(cell, xCoefficient, yCoefficient),
    hashNoise(cell.add(vec2(1, 0)), xCoefficient, yCoefficient),
    interpolation.x,
  );
  const top = mix(
    hashNoise(cell.add(vec2(0, 1)), xCoefficient, yCoefficient),
    hashNoise(cell.add(vec2(1, 1)), xCoefficient, yCoefficient),
    interpolation.x,
  );
  return mix(bottom, top, interpolation.y);
}

function hashNoise(point: Node<'vec2'>, xCoefficient: number, yCoefficient: number): Node<'float'> {
  const phase = point.x.mul(xCoefficient).add(point.y.mul(yCoefficient));
  return fract(sin(phase).mul(43_758.5453)).mul(2).sub(1);
}

function ownedScalar(input: ScalarInput | undefined, fallback = 0): OwnedScalar {
  if (input === undefined || typeof input === 'number') {
    const result = uniform(input ?? fallback);
    return { node: result, uniform: result };
  }
  return { node: float(input), uniform: null };
}

function ownedVec2(
  input: Vec2Input | undefined,
  fallback: readonly [number, number] = [0, 0],
): OwnedVec2 {
  if (input === undefined || Array.isArray(input)) {
    const value = input ?? fallback;
    const result = uniform(new THREE.Vector2(value[0], value[1]));
    return { node: result, uniform: result };
  }
  return { node: vec2(input as Node<'vec2'>), uniform: null };
}

function controlScalar(binding: OwnedScalar, value: ScalarInput, path: string): number {
  if (!binding.uniform || typeof value !== 'number') externalBinding(path);
  return value;
}

function controlVec2(
  binding: OwnedVec2,
  value: Vec2Input,
  path: string,
): readonly [number, number] {
  if (!binding.uniform || !Array.isArray(value)) externalBinding(path);
  return value as readonly [number, number];
}

function assignScalar(binding: OwnedScalar, value: number): void {
  binding.uniform!.value = value;
}

function assignVec2(binding: OwnedVec2, value: readonly [number, number]): void {
  binding.uniform!.value.set(value[0], value[1]);
}
