import * as THREE from 'three/webgpu';
import type Node from 'three/src/nodes/core/Node.js';
import { depth, float, max, min, mrt, screenUV, texture, vec4 } from 'three/tsl';

import { invalid, wboitWebgl2Unsupported } from './diagnostics.js';

export const WBOIT_ACCUM_ATTACHMENT = 'nachiWboitAccum';
export const WBOIT_REVEALAGE_ATTACHMENT = 'nachiWboitRevealage';

export interface WboitLayer {
  readonly alpha: number;
  readonly color: readonly [number, number, number];
  /** WebGPU normalized fragment depth in [0, 1]. */
  readonly depth: number;
}

export interface WboitComposite {
  readonly accum: readonly [number, number, number, number];
  readonly color: readonly [number, number, number, number];
  readonly revealage: number;
}

/** McGuire-Bavoil depth/coverage weight, mirrored exactly by createWboitOutput(). */
export function wboitWeight(alpha: number, normalizedDepth: number): number {
  const coverage = Math.min(1, Math.max(0, alpha) * 10) + 0.01;
  const depthTerm = 1 - Math.min(1, Math.max(0, normalizedDepth)) * 0.9;
  return Math.min(3_000, Math.max(0.01, coverage ** 3 * 1e8 * depthTerm ** 3));
}

/** CPU reference used by numerical verification and authoring tools. */
export function compositeWboitLayers(layers: readonly WboitLayer[]): WboitComposite {
  const accum: [number, number, number, number] = [0, 0, 0, 0];
  let revealage = 1;
  for (const layer of layers) {
    const alpha = Math.min(1, Math.max(0, layer.alpha));
    const weight = wboitWeight(alpha, layer.depth);
    for (let channel = 0; channel < 3; channel += 1) {
      accum[channel] = accum[channel]! + (layer.color[channel] ?? 0) * alpha * weight;
    }
    accum[3] = accum[3] + alpha * weight;
    revealage *= 1 - alpha;
  }
  const denominator = Math.max(accum[3]!, 1e-5);
  return {
    accum: accum as [number, number, number, number],
    color: [
      accum[0]! / denominator,
      accum[1]! / denominator,
      accum[2]! / denominator,
      1 - revealage,
    ],
    revealage,
  };
}

function weightNode(alpha: Node<'float'>, normalizedDepth: Node<'float'>): Node<'float'> {
  const coverage = min(1, alpha.clamp(0, 1).mul(10)).add(0.01);
  const depthTerm = float(1).sub(normalizedDepth.clamp(0, 1).mul(0.9));
  return coverage.pow(3).mul(1e8).mul(depthTerm.pow(3)).clamp(0.01, 3_000);
}

/** MRT fragment output assigned to NodeMaterial.mrtNode (not outputNode). */
export function createWboitOutput(
  color: Node<'vec3'>,
  alpha: Node<'float'>,
  normalizedDepth: Node<'float'> = depth,
) {
  const boundedAlpha = alpha.clamp(0, 1);
  const weight = weightNode(boundedAlpha, normalizedDepth);
  return mrt({
    [WBOIT_ACCUM_ATTACHMENT]: vec4(color.mul(boundedAlpha).mul(weight), boundedAlpha.mul(weight)),
    [WBOIT_REVEALAGE_ATTACHMENT]: boundedAlpha,
  });
}

export interface WboitPipelineOptions {
  /** Pass webgl2 explicitly to obtain the stable unsupported-backend diagnostic before rendering. */
  readonly backend?: 'webgl2' | 'webgpu';
  readonly height?: number;
  readonly width?: number;
}

function assertNativeWebgpu(renderer: THREE.WebGPURenderer, requested?: 'webgl2' | 'webgpu'): void {
  const backend = renderer.backend as {
    readonly compatibilityMode?: boolean;
    readonly isWebGLBackend?: boolean;
  };
  if (
    requested === 'webgl2' ||
    backend.isWebGLBackend === true ||
    backend.compatibilityMode === true
  ) {
    wboitWebgl2Unsupported('wboit.backend');
  }
}

/**
 * Owns the two-target weighted OIT accumulation and fullscreen composite. The supplied scene must
 * contain only materials whose mrtNode was created by createWboitOutput().
 */
export class WboitPipeline {
  readonly target: THREE.RenderTarget;
  readonly #accumulationMrt: ReturnType<typeof mrt>;
  readonly #camera: THREE.Camera;
  readonly #compositeQuad: THREE.QuadMesh;
  readonly #initializeMrt: ReturnType<typeof mrt>;
  readonly #initializeQuad: THREE.QuadMesh;
  readonly #renderer: THREE.WebGPURenderer;
  readonly #scene: THREE.Scene;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    options: WboitPipelineOptions = {},
  ) {
    assertNativeWebgpu(renderer, options.backend);
    this.#renderer = renderer;
    this.#scene = scene;
    this.#camera = camera;
    const width = options.width ?? 1;
    const height = options.height ?? 1;
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      invalid('wboit.size', 'requires positive integer width and height');
    }
    const target = new THREE.RenderTarget(width, height, {
      count: 2,
      depthBuffer: true,
      generateMipmaps: false,
      type: THREE.HalfFloatType,
    });
    const accumTexture = target.textures[0]!;
    accumTexture.name = WBOIT_ACCUM_ATTACHMENT;
    accumTexture.format = THREE.RGBAFormat;
    accumTexture.type = THREE.HalfFloatType;
    const revealageTexture = target.textures[1]!;
    revealageTexture.name = WBOIT_REVEALAGE_ATTACHMENT;
    revealageTexture.format = THREE.RedFormat;
    revealageTexture.type = THREE.UnsignedByteType;
    this.target = target;

    const initializeMrt = mrt({
      [WBOIT_ACCUM_ATTACHMENT]: vec4(0),
      [WBOIT_REVEALAGE_ATTACHMENT]: float(1),
    });
    this.#initializeMrt = initializeMrt;
    const initializeMaterial = new THREE.NodeMaterial();
    initializeMaterial.depthTest = false;
    initializeMaterial.depthWrite = false;
    initializeMaterial.outputNode = vec4(0);
    this.#initializeQuad = new THREE.QuadMesh(initializeMaterial);

    const accumulationMrt = mrt({
      [WBOIT_ACCUM_ATTACHMENT]: vec4(0),
      [WBOIT_REVEALAGE_ATTACHMENT]: float(0),
    });
    const additive = new THREE.BlendMode(THREE.CustomBlending);
    additive.blendEquation = THREE.AddEquation;
    additive.blendSrc = THREE.OneFactor;
    additive.blendDst = THREE.OneFactor;
    additive.blendSrcAlpha = THREE.OneFactor;
    additive.blendDstAlpha = THREE.OneFactor;
    const reveal = new THREE.BlendMode(THREE.CustomBlending);
    reveal.blendEquation = THREE.AddEquation;
    reveal.blendSrc = THREE.ZeroFactor;
    reveal.blendDst = THREE.OneMinusSrcColorFactor;
    reveal.blendSrcAlpha = THREE.ZeroFactor;
    reveal.blendDstAlpha = THREE.OneMinusSrcColorFactor;
    accumulationMrt.setBlendMode(WBOIT_ACCUM_ATTACHMENT, additive);
    accumulationMrt.setBlendMode(WBOIT_REVEALAGE_ATTACHMENT, reveal);
    this.#accumulationMrt = accumulationMrt;

    const accum = texture(accumTexture, screenUV);
    const revealage = texture(revealageTexture, screenUV).r.clamp(0, 1);
    const compositeMaterial = new THREE.NodeMaterial();
    compositeMaterial.transparent = true;
    compositeMaterial.depthTest = false;
    compositeMaterial.depthWrite = false;
    compositeMaterial.blending = THREE.NormalBlending;
    compositeMaterial.outputNode = vec4(accum.rgb.div(max(accum.a, 1e-5)), float(1).sub(revealage));
    this.#compositeQuad = new THREE.QuadMesh(compositeMaterial);
  }

  setSize(width: number, height: number): void {
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      invalid('wboit.size', 'requires positive integer width and height');
    }
    this.target.setSize(width, height);
  }

  /** Accumulates transparent geometry, then alpha-composites it over the current output target. */
  render(outputTarget: THREE.RenderTarget | null = this.#renderer.getRenderTarget()): void {
    const renderer = this.#renderer;
    assertNativeWebgpu(renderer);
    if (outputTarget === this.target) {
      invalid('wboit.outputTarget', 'must not alias the accumulation target');
    }
    const previousTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(this.target);
      renderer.setMRT(this.#initializeMrt);
      renderer.autoClear = false;
      renderer.clear(true, true, false);
      this.#initializeQuad.render(renderer);
      renderer.setMRT(this.#accumulationMrt);
      renderer.render(this.#scene, this.#camera);
      renderer.setMRT(null);
      renderer.setRenderTarget(outputTarget);
      this.#compositeQuad.render(renderer);
    } finally {
      renderer.setMRT(previousMrt);
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
  }

  dispose(): void {
    this.target.dispose();
    (this.#initializeQuad.material as THREE.Material).dispose();
    (this.#compositeQuad.material as THREE.Material).dispose();
  }
}

export function createWboitPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options?: WboitPipelineOptions,
): WboitPipeline {
  return new WboitPipeline(renderer, scene, camera, options);
}
