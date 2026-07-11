import type Node from 'three/src/nodes/core/Node.js';

export type ScalarNode = Node<'float'> | Node<'int'> | Node<'uint'> | Node<'bool'>;
export type ScalarInput = number | ScalarNode;
export type Vec2Input = readonly [number, number] | Node<'vec2'>;

export type PostPassKind = 'distortion' | 'radialBlur' | 'bloom';

export interface ShockwaveSource {
  readonly center: Vec2Input;
  readonly radius: ScalarInput;
  readonly ringWidth: ScalarInput;
  readonly strength: ScalarInput;
  readonly speed?: ScalarInput;
  readonly startTime?: ScalarInput;
  readonly duration?: ScalarInput;
  readonly enabled?: ScalarInput;
}

export interface HeatHazeRegion {
  readonly center: Vec2Input;
  readonly size: Vec2Input;
  readonly strength: ScalarInput;
  readonly scale?: ScalarInput;
  readonly speed?: Vec2Input;
  readonly feather?: ScalarInput;
  readonly enabled?: ScalarInput;
}

export interface ScreenDistortionConfig {
  readonly shockwaves?: readonly ShockwaveSource[];
  readonly heatHaze?: readonly HeatHazeRegion[];
  /** Omit for a package-owned writable uniform; number and Node inputs are externally owned. */
  readonly time?: ScalarInput;
}

export interface ScreenDistortionPass {
  readonly kind: 'distortion';
  readonly config: Readonly<ScreenDistortionConfig>;
}

export interface RadialBlurConfig {
  readonly center?: Vec2Input;
  readonly strength?: ScalarInput;
  readonly samples?: number;
}

export interface RadialBlurPass {
  readonly kind: 'radialBlur';
  readonly config: Readonly<RadialBlurConfig>;
}

export type BloomPresetName = 'soft' | 'intense' | 'cinematic';

export interface BloomConfig {
  readonly strength: ScalarInput;
  readonly radius: ScalarInput;
  readonly threshold: ScalarInput;
  readonly resolutionScale?: number;
}

export interface BloomPass {
  readonly kind: 'bloom';
  readonly preset: BloomPresetName;
  readonly config: Readonly<BloomConfig>;
}

export interface PostPasses {
  readonly distortion?: ScreenDistortionPass;
  readonly radialBlur?: RadialBlurPass;
  readonly bloom?: BloomPass;
}

export interface PostPipelineConfig extends PostPasses {
  /** Defaults to distortion -> radialBlur -> bloom after absent passes are removed. */
  readonly order?: readonly PostPassKind[];
  /** Defaults to Three RenderPipeline's output transform. */
  readonly outputColorTransform?: boolean;
}
