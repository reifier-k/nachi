import type { ScalarInput } from '@nachi-vfx/tsl-kit';
import { FloatType, HalfFloatType, NoColorSpace } from 'three';
import type * as THREE from 'three/webgpu';
import {
  attribute,
  float,
  int,
  ivec2,
  mix,
  normalize,
  positionLocal,
  textureLoad,
  transformNormalToView,
  uniform,
  vec3,
  varying,
  vertexIndex,
} from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';
import type UniformNode from 'three/src/nodes/core/UniformNode.js';

import { MeshFxDiagnosticError, finite, invalid, positive } from './diagnostics.js';

export type VatInterpolation = 'nearest' | 'linear';
export type VatFrameOrder = 'top-to-bottom' | 'bottom-to-top';
export type VatAxisMap = 'xyz' | 'xzy' | 'xz-y';
export type VatPositionMode = 'offset' | 'absolute';
export type VatPositionEncoding = 'float' | 'remapped';
export type VatNormalEncoding = 'unorm' | 'signed';
export type VatVertexLookup = 'uv1' | 'vertex-index';

export interface VatRemapRange {
  /** Blender VAT's global minimum: encoded zero maps to this scalar. */
  readonly min: number;
  /** Blender VAT's global maximum: encoded one maps to this scalar. */
  readonly max: number;
}

export interface VatConfig {
  readonly positionTexture: THREE.Texture;
  readonly normalTexture?: THREE.Texture;
  readonly frameCount: number;
  readonly fps: number;
  readonly interpolation?: VatInterpolation;
  readonly frameRange?: readonly [start: number, end: number];
  readonly loop?: boolean;
  /** Official exporter order is top-to-bottom; its Y-flip option produces bottom-to-top. */
  readonly frameOrder?: VatFrameOrder;
  /** `xzy` matches the exporter example; `xz-y` preserves chirality for Z-up to Y-up. */
  readonly axisMap?: VatAxisMap;
  readonly positionMode?: VatPositionMode;
  readonly positionEncoding?: VatPositionEncoding;
  readonly positionRange?: VatRemapRange;
  readonly normalEncoding?: VatNormalEncoding;
  /** Blender's generated `vertex_anim` UV exports as uv1; vertex-index is an explicit raw fallback. */
  readonly vertexLookup?: VatVertexLookup;
  /** Omit for a package-owned clock uniform, or supply an effect-local TSL node. */
  readonly time?: ScalarInput;
  /** VAT bounds are dynamic; disabling culling is the safe v1 default. */
  readonly disableFrustumCulling?: boolean;
}

export interface VatFrameSample {
  readonly frame0: number;
  readonly frame1: number;
  readonly mix: number;
}

export interface VatControls {
  readonly time: UniformNode<'float', number> | null;
  readonly frameCount: number;
  readonly frameRange: readonly [start: number, end: number];
  readonly fps: number;
  setTime(value: number): void;
  setFrame(value: number): void;
  sampleAtTime(value: number): VatFrameSample;
}

type NodeMaterialLike = THREE.Material & {
  readonly isNodeMaterial: true;
  normalNode: Node<'vec3'> | null;
  positionNode: Node<'vec3'> | null;
};

export type VatMesh = THREE.Mesh<THREE.BufferGeometry, NodeMaterialLike>;

type VatBinding = Readonly<{
  config: VatConfig;
  controls: VatControls;
}>;

type VatBindingMetadata = {
  baseNormalNode: Node<'vec3'> | null;
  basePositionNode: Node<'vec3'> | null;
  readonly bindings: VatBinding[];
  readonly material: NodeMaterialLike;
  appliedNormalNode: Node<'vec3'> | null | undefined;
  appliedPositionNode: Node<'vec3'> | null | undefined;
  normalBindingIndex: number;
};

type VatBindingActivity = Readonly<{
  readonly materialMatches: boolean;
  readonly metadata: VatBindingMetadata;
  readonly normalBindingIndex: number;
  readonly normalActive: boolean;
  readonly positionActive: boolean;
}>;

const vatBindings = new WeakMap<THREE.Mesh, VatBindingMetadata>();

/**
 * Applies a Blender-compatible one-frame-per-row VAT to an ordinary Three NodeMaterial mesh.
 * Position and optional normal textures are sampled in the TSL vertex stage.
 */
export function applyVat(mesh: THREE.Mesh, config: VatConfig): VatControls {
  const validated = validateVat(mesh, config);
  const material = validated.material;
  const previous = vatBindings.get(mesh);
  const continuesTrackedPosition =
    previous?.material === material && previous.appliedPositionNode === material.positionNode;
  if (
    continuesTrackedPosition &&
    previous.normalBindingIndex >= 0 &&
    previous.appliedNormalNode !== material.normalNode
  ) {
    // A manually replaced normal no longer consumes the prior VAT normal clock. Position VAT
    // layers remain active and can continue composing without turning that authored normal back
    // into a timeline-owned binding.
    previous.normalBindingIndex = -1;
  }
  const metadata: VatBindingMetadata = continuesTrackedPosition
    ? previous
    : {
        baseNormalNode: material.normalNode,
        basePositionNode: material.positionNode,
        bindings: [],
        material,
        appliedNormalNode: material.normalNode,
        appliedPositionNode: material.positionNode,
        normalBindingIndex: -1,
      };
  const timeUniform = config.time === undefined ? uniform(0) : null;
  const timeNode = config.time ?? timeUniform!;
  const frameNodes = buildFrameNodes(timeNode, validated);
  const firstPosition = sampleFrame(config.positionTexture, frameNodes.frame0, validated);
  const secondPosition = sampleFrame(config.positionTexture, frameNodes.frame1, validated);
  let vatPosition = mix(firstPosition, secondPosition, frameNodes.mix);
  if (config.positionEncoding === 'remapped') {
    const range = config.positionRange!;
    vatPosition = vatPosition.mul(range.max - range.min).add(range.min);
  }
  vatPosition = swizzle(vatPosition, validated.axisMap);

  const basePosition = vec3(material.positionNode ?? positionLocal);
  material.positionNode =
    validated.positionMode === 'absolute' ? vatPosition : basePosition.add(vatPosition);

  if (config.normalTexture) {
    const firstNormal = sampleFrame(config.normalTexture, frameNodes.frame0, validated);
    const secondNormal = sampleFrame(config.normalTexture, frameNodes.frame1, validated);
    let vatNormal = mix(firstNormal, secondNormal, frameNodes.mix);
    if (validated.normalEncoding === 'unorm') vatNormal = vatNormal.mul(2).sub(1);
    vatNormal = normalize(swizzle(vatNormal, validated.axisMap));
    // varying() forces the texture reads into the vertex stage, then interpolates the decoded
    // normal across fragments. Sampling the VAT from material.normalNode directly would sample
    // per fragment using interpolated lookup coordinates and is explicitly not compatible.
    material.normalNode = varying(transformNormalToView(vatNormal)).normalize();
  }
  material.needsUpdate = true;
  if (config.disableFrustumCulling ?? true) mesh.frustumCulled = false;

  const controls: VatControls = Object.freeze({
    time: timeUniform,
    frameCount: validated.frameCount,
    frameRange: Object.freeze([validated.start, validated.end] as const),
    fps: validated.fps,
    setTime(value: number): void {
      if (!timeUniform) invalid('applyVat.time', 'is externally bound and cannot be assigned');
      const checked = validateTime(value, validated);
      timeUniform.value = checked;
    },
    setFrame(value: number): void {
      if (!timeUniform) invalid('applyVat.time', 'is externally bound and cannot be assigned');
      const frame = validateFrame(value, validated);
      timeUniform.value = (frame - validated.start) / validated.fps;
    },
    sampleAtTime(value: number): VatFrameSample {
      return resolveVatFrames(value, {
        fps: validated.fps,
        frameCount: validated.frameCount,
        frameRange: [validated.start, validated.end],
        interpolation: validated.interpolation,
        loop: validated.loop,
      });
    },
  });
  const bindingIndex = metadata.bindings.length;
  metadata.bindings.push(Object.freeze({ config: snapshotVatConfig(config), controls }));
  if (config.normalTexture) metadata.normalBindingIndex = bindingIndex;
  metadata.appliedNormalNode = material.normalNode;
  metadata.appliedPositionNode = material.positionNode;
  vatBindings.set(mesh, metadata);
  compactVatBindings(vatBindingActivity(mesh)!);
  return controls;
}

/**
 * @internal Rebuilds every tracked `applyVat()` layer on a mesh clone and returns the cloned
 * controls. Textures and explicit external TSL nodes retain their shared-reference contract;
 * omitted clocks receive fresh uniforms whose source values are snapshotted before timeline play.
 */
export function cloneVatBindings(
  source: THREE.Mesh,
  clone: THREE.Mesh,
  baseGraph: 'cloned-material' | 'source-before-vat' = 'source-before-vat',
): readonly VatControls[] {
  const activity = currentVatBindingActivity(source);
  if (!activity) return Object.freeze([]);
  const { metadata } = activity;
  const sourceMaterial = nodeMaterial(source.material);
  if (!activity.materialMatches && !sourceMaterial) return Object.freeze([]);
  const material = requiredNodeMaterial(clone.material);
  if (!activity.materialMatches || (!activity.positionActive && !activity.normalActive)) {
    material.positionNode = sourceMaterial!.positionNode;
    material.normalNode = sourceMaterial!.normalNode;
    material.needsUpdate = true;
    return Object.freeze([]);
  }
  if (baseGraph === 'source-before-vat') {
    material.positionNode = metadata.basePositionNode;
    material.normalNode = metadata.baseNormalNode;
  } else {
    // Timeline fxMaterial regeneration owns its ordinary package graph, but an explicitly authored
    // position/normal node that existed before VAT is an external binding and must remain shared.
    material.positionNode = metadata.basePositionNode ?? material.positionNode;
    material.normalNode = metadata.baseNormalNode ?? material.normalNode;
  }
  const frustumCulled = source.frustumCulled;
  for (const index of reachableVatBindingIndices(activity)) {
    const binding = metadata.bindings[index]!;
    const cloned = applyVat(clone, binding.config);
    if (cloned.time && binding.controls.time) {
      setVatTimelineTime(cloned, binding.controls.time.value);
    }
  }
  if (!activity.positionActive && sourceMaterial) {
    material.positionNode = sourceMaterial.positionNode;
  }
  if (!activity.normalActive && sourceMaterial) {
    material.normalNode = sourceMaterial.normalNode;
  }
  material.needsUpdate = true;
  // Mesh.clone() snapshots the source object's current culling choice. Reapplying the VAT config
  // must not undo an author's later conservative-bounds opt-in.
  clone.frustumCulled = frustumCulled;
  return getVatControls(clone);
}

/** @internal Returns controls for the VAT layers currently tracked on a mesh. */
export function getVatControls(mesh: THREE.Mesh): readonly VatControls[] {
  const activity = currentVatBindingActivity(mesh);
  if (!activity?.materialMatches) return Object.freeze([]);
  return Object.freeze(
    activeVatControls(
      activity,
      activity.metadata.bindings.map(({ controls }) => controls),
    ),
  );
}

function vatBindingActivity(mesh: THREE.Mesh): VatBindingActivity | undefined {
  const metadata = vatBindings.get(mesh);
  if (!metadata) return undefined;
  const materialMatches = metadata.material === mesh.material;
  const normalBindingIndex = metadata.normalBindingIndex;
  return {
    materialMatches,
    metadata,
    normalBindingIndex,
    normalActive:
      materialMatches &&
      normalBindingIndex >= 0 &&
      metadata.appliedNormalNode === metadata.material.normalNode,
    positionActive:
      materialMatches && metadata.appliedPositionNode === metadata.material.positionNode,
  };
}

function currentVatBindingActivity(mesh: THREE.Mesh): VatBindingActivity | undefined {
  let activity = vatBindingActivity(mesh);
  if (!activity?.materialMatches) return activity;
  compactVatBindings(activity);
  activity = vatBindingActivity(mesh);
  return activity;
}

function activeVatControls(
  activity: VatBindingActivity,
  controls: readonly VatControls[],
): VatControls[] {
  return reachableVatBindingIndices(activity).map((index) => controls[index]!);
}

function reachableVatBindingIndices(activity: VatBindingActivity): number[] {
  const indices = new Set<number>();
  const { bindings } = activity.metadata;
  if (activity.positionActive) {
    let positionStart = 0;
    for (let index = 0; index < bindings.length; index += 1) {
      if (bindings[index]!.config.positionMode === 'absolute') positionStart = index;
    }
    for (let index = positionStart; index < bindings.length; index += 1) indices.add(index);
  }
  if (activity.normalActive) indices.add(activity.normalBindingIndex);
  return [...indices].sort((left, right) => left - right);
}

function compactVatBindings(activity: VatBindingActivity): void {
  const { metadata } = activity;
  const indices = reachableVatBindingIndices(activity);
  const activeNormalBinding = activity.normalActive
    ? metadata.bindings[activity.normalBindingIndex]
    : undefined;
  const reachableBindings = indices.map((index) => {
    const binding = metadata.bindings[index]!;
    if (binding === activeNormalBinding || binding.config.normalTexture === undefined)
      return binding;
    const positionOnlyConfig = { ...binding.config };
    delete positionOnlyConfig.normalTexture;
    return Object.freeze({
      config: Object.freeze(positionOnlyConfig),
      controls: binding.controls,
    });
  });
  metadata.bindings.splice(0, metadata.bindings.length, ...reachableBindings);
  metadata.normalBindingIndex =
    activeNormalBinding === undefined ? -1 : reachableBindings.indexOf(activeNormalBinding);
  if (!activity.positionActive) {
    metadata.basePositionNode = metadata.material.positionNode;
    metadata.appliedPositionNode = undefined;
  }
  if (!activity.normalActive) {
    metadata.baseNormalNode = metadata.material.normalNode;
    metadata.appliedNormalNode = undefined;
  }
}

function nodeMaterial(material: THREE.Material | THREE.Material[]): NodeMaterialLike | null {
  if (
    Array.isArray(material) ||
    (material as { isNodeMaterial?: boolean }).isNodeMaterial !== true
  ) {
    return null;
  }
  return material as NodeMaterialLike;
}

/**
 * @internal Writes timeline element-local time to a package-owned VAT clock. Unlike standalone
 * `setTime()`, this permits a non-looping element to outlive its clip so the shader can hold the
 * final frame. Timeline deltas are still required to be finite and non-negative.
 */
export function setVatTimelineTime(controls: VatControls, value: number): void {
  if (!controls.time) invalid('applyVat.time', 'is externally bound and cannot be assigned');
  finite(value, 'timeline.vat.time');
  if (value < 0) invalid('timeline.vat.time', 'must be >= 0');
  controls.time.value = value;
}

function snapshotVatConfig(config: VatConfig): VatConfig {
  return Object.freeze({
    ...config,
    ...(config.frameRange === undefined
      ? {}
      : { frameRange: Object.freeze([...config.frameRange] as [number, number]) }),
    ...(config.positionRange === undefined
      ? {}
      : { positionRange: Object.freeze({ ...config.positionRange }) }),
  });
}

export function resolveVatFrames(
  time: number,
  config: Pick<VatConfig, 'fps' | 'frameCount' | 'frameRange' | 'interpolation' | 'loop'>,
): VatFrameSample {
  const frameCount = integer(config.frameCount, 'applyVat.frameCount', 1);
  const fps = positive(config.fps, 'applyVat.fps');
  const [start, end] = validateRange(config.frameRange, frameCount);
  const validated = {
    end,
    fps,
    interpolation: validateInterpolation(config.interpolation, 'resolveVatFrames.interpolation'),
    loop: config.loop ?? true,
    start,
  } as const;
  const checkedTime = validateTime(time, validated);
  const span = end - start + 1;
  const raw = start + checkedTime * fps;
  const phase = validated.loop ? start + positiveModulo(raw - start, span) : Math.min(end, raw);
  if (validated.interpolation === 'nearest') {
    const rounded = Math.floor(phase + 0.5);
    return {
      frame0: rounded > end ? start : rounded,
      frame1: rounded > end ? start : rounded,
      mix: 0,
    };
  }
  const frame0 = Math.floor(phase);
  const frame1 = frame0 === end ? (validated.loop ? start : end) : frame0 + 1;
  return { frame0, frame1, mix: phase - frame0 };
}

type ValidatedVat = Readonly<{
  axisMap: VatAxisMap;
  end: number;
  fps: number;
  frameCount: number;
  frameOrder: VatFrameOrder;
  interpolation: VatInterpolation;
  loop: boolean;
  material: NodeMaterialLike;
  normalEncoding: VatNormalEncoding;
  positionMode: VatPositionMode;
  start: number;
  textureHeight: number;
  textureWidth: number;
  vertexLookup: VatVertexLookup;
}>;

function validateVat(mesh: THREE.Mesh, config: VatConfig): ValidatedVat {
  const material = requiredNodeMaterial(mesh.material);
  const position = mesh.geometry?.getAttribute('position');
  if (!position) invalid('applyVat.mesh.geometry.position', 'is required');
  const frameCount = integer(config.frameCount, 'applyVat.frameCount', 1);
  const fps = positive(config.fps, 'applyVat.fps');
  if (typeof config.time === 'number') finite(config.time, 'applyVat.time');
  else if (
    config.time !== undefined &&
    (typeof config.time !== 'object' || config.time === null || config.time.isNode !== true)
  ) {
    invalid('applyVat.time', 'must be a finite number or TSL node');
  }
  if (config.loop !== undefined && typeof config.loop !== 'boolean') {
    invalid('applyVat.loop', 'must be a boolean');
  }
  if (
    config.disableFrustumCulling !== undefined &&
    typeof config.disableFrustumCulling !== 'boolean'
  ) {
    invalid('applyVat.disableFrustumCulling', 'must be a boolean');
  }
  const [start, end] = validateRange(config.frameRange, frameCount);
  const dimensions = validatePositionTexture(config.positionTexture, position.count, frameCount);
  if (config.normalTexture) {
    const normalDimensions = textureDimensions(
      requiredTexture(config.normalTexture, 'applyVat.normalTexture'),
      'applyVat.normalTexture',
    );
    if (
      normalDimensions.width !== dimensions.width ||
      normalDimensions.height !== dimensions.height
    ) {
      diagnostic(
        'NACHI_VAT_LAYOUT_MISMATCH',
        'applyVat.normalTexture',
        `must match the ${dimensions.width}x${dimensions.height} position texture`,
      );
    }
    requireDataTextureColorSpace(config.normalTexture, 'applyVat.normalTexture');
  }
  const interpolation = validateInterpolation(config.interpolation, 'applyVat.interpolation');
  const frameOrder = config.frameOrder ?? 'top-to-bottom';
  if (frameOrder !== 'top-to-bottom' && frameOrder !== 'bottom-to-top') {
    invalid('applyVat.frameOrder', 'must be top-to-bottom or bottom-to-top');
  }
  const axisMap = config.axisMap ?? 'xzy';
  if (axisMap !== 'xyz' && axisMap !== 'xzy' && axisMap !== 'xz-y') {
    invalid('applyVat.axisMap', 'must be xyz, xzy, or xz-y');
  }
  const positionMode = config.positionMode ?? 'offset';
  if (positionMode !== 'offset' && positionMode !== 'absolute') {
    invalid('applyVat.positionMode', 'must be offset or absolute');
  }
  const positionEncoding = config.positionEncoding ?? 'float';
  if (positionEncoding !== 'float' && positionEncoding !== 'remapped') {
    invalid('applyVat.positionEncoding', 'must be float or remapped');
  }
  if (positionEncoding === 'remapped') validateRemap(config.positionRange);
  if (positionEncoding === 'float' && config.positionRange !== undefined) {
    invalid('applyVat.positionRange', 'is only valid with positionEncoding "remapped"');
  }
  const normalEncoding = config.normalEncoding ?? 'unorm';
  if (normalEncoding !== 'unorm' && normalEncoding !== 'signed') {
    invalid('applyVat.normalEncoding', 'must be unorm or signed');
  }
  const vertexLookup = config.vertexLookup ?? 'uv1';
  if (vertexLookup !== 'uv1' && vertexLookup !== 'vertex-index') {
    invalid('applyVat.vertexLookup', 'must be uv1 or vertex-index');
  }
  if (vertexLookup === 'uv1') validateLookupUv(mesh.geometry, position.count);
  return {
    axisMap,
    end,
    fps,
    frameCount,
    frameOrder,
    interpolation,
    loop: config.loop ?? true,
    material,
    normalEncoding,
    positionMode,
    start,
    textureHeight: dimensions.height,
    textureWidth: dimensions.width,
    vertexLookup,
  };
}

function validatePositionTexture(
  texture: THREE.Texture,
  vertexCount: number,
  frameCount: number,
): { readonly width: number; readonly height: number } {
  requiredTexture(texture, 'applyVat.positionTexture');
  if (texture.type !== FloatType && texture.type !== HalfFloatType) {
    diagnostic(
      'NACHI_VAT_FLOAT_TEXTURE_REQUIRED',
      'applyVat.positionTexture',
      'must be a FloatType or HalfFloatType non-color texture (for example a loaded OpenEXR)',
    );
  }
  requireDataTextureColorSpace(texture, 'applyVat.positionTexture');
  const dimensions = textureDimensions(texture, 'applyVat.positionTexture');
  if (dimensions.width !== vertexCount) {
    diagnostic(
      'NACHI_VAT_VERTEX_COUNT_MISMATCH',
      'applyVat.positionTexture.image.width',
      `is ${dimensions.width}, but mesh position count is ${vertexCount}`,
    );
  }
  if (dimensions.height !== frameCount) {
    diagnostic(
      'NACHI_VAT_LAYOUT_MISMATCH',
      'applyVat.positionTexture.image.height',
      `is ${dimensions.height}, but one-frame-per-row frameCount is ${frameCount}`,
    );
  }
  return dimensions;
}

function buildFrameNodes(time: ScalarInput, config: ValidatedVat) {
  const timeNode = typeof time === 'number' ? float(time) : time.toFloat();
  const span = config.end - config.start + 1;
  const raw = timeNode.mul(config.fps).add(config.start);
  const phase = config.loop
    ? raw.sub(config.start).mod(span).add(config.start)
    : raw.clamp(config.start, config.end);
  if (config.interpolation === 'nearest') {
    let nearest = phase.add(0.5).floor();
    if (config.loop) nearest = nearest.sub(config.start).mod(span).add(config.start);
    else nearest = nearest.min(config.end);
    return { frame0: nearest, frame1: nearest, mix: float(0) };
  }
  const frame0 = phase.floor();
  const frame1 = config.loop
    ? frame0.add(1).sub(config.start).mod(span).add(config.start)
    : frame0.add(1).min(config.end);
  return { frame0, frame1, mix: phase.fract() };
}

function sampleFrame(texture: THREE.Texture, frame: Node<'float'>, config: ValidatedVat) {
  const row =
    config.frameOrder === 'top-to-bottom' ? frame : float(config.textureHeight - 1).sub(frame);
  const column =
    config.vertexLookup === 'vertex-index'
      ? int(vertexIndex)
      : int(
          (attribute('uv1', 'vec2') as Node<'vec2'>).x
            .mul(config.textureWidth)
            .floor()
            .min(config.textureWidth - 1),
        );
  return textureLoad(texture, ivec2(column, int(row)), 0).xyz;
}

function swizzle(node: Node<'vec3'>, axisMap: VatAxisMap): Node<'vec3'> {
  if (axisMap === 'xzy') return node.xzy;
  if (axisMap === 'xz-y') return vec3(node.x, node.z, node.y.negate());
  return node.xyz;
}

function validateRange(
  range: VatConfig['frameRange'],
  frameCount: number,
): readonly [number, number] {
  const start = integer(range?.[0] ?? 0, 'applyVat.frameRange[0]', 0);
  const end = integer(range?.[1] ?? frameCount - 1, 'applyVat.frameRange[1]', 0);
  if (start > end || end >= frameCount) {
    diagnostic(
      'NACHI_VAT_FRAME_RANGE',
      'applyVat.frameRange',
      `must satisfy 0 <= start <= end < frameCount (${frameCount})`,
    );
  }
  return [start, end];
}

function validateTime(
  value: number,
  config: Pick<ValidatedVat, 'end' | 'fps' | 'loop' | 'start'>,
): number {
  finite(value, 'applyVat.time');
  const maximum = (config.end - config.start) / config.fps;
  if (value < 0 || (!config.loop && value > maximum)) {
    diagnostic(
      'NACHI_VAT_FRAME_RANGE',
      'applyVat.time',
      config.loop ? 'must be >= 0' : `must be within [0, ${maximum}] seconds`,
    );
  }
  return value;
}

function validateFrame(value: number, config: Pick<ValidatedVat, 'end' | 'start'>): number {
  if (!Number.isFinite(value) || value < config.start || value > config.end) {
    diagnostic(
      'NACHI_VAT_FRAME_RANGE',
      'applyVat.frame',
      `must be within [${config.start}, ${config.end}]`,
    );
  }
  return value;
}

function validateInterpolation(value: VatConfig['interpolation'], path: string): VatInterpolation {
  const interpolation = value ?? 'linear';
  if (interpolation !== 'nearest' && interpolation !== 'linear') {
    invalid(path, 'must be nearest or linear');
  }
  return interpolation;
}

function validateRemap(range: VatRemapRange | undefined): void {
  if (!range) invalid('applyVat.positionRange', 'is required for remapped positions');
  finite(range.min, 'applyVat.positionRange.min');
  finite(range.max, 'applyVat.positionRange.max');
  if (range.max <= range.min) invalid('applyVat.positionRange', 'max must be greater than min');
}

function validateLookupUv(geometry: THREE.BufferGeometry, vertexCount: number): void {
  const lookup = geometry.getAttribute('uv1');
  if (!lookup || lookup.itemSize < 2 || lookup.count !== vertexCount) {
    invalid(
      'applyVat.mesh.geometry.uv1',
      'must match the position count and contain Blender vertex_anim lookup UVs',
    );
  }
  for (let index = 0; index < lookup.count; index += 1) {
    const x = lookup.getX(index);
    if (!Number.isFinite(x) || x < 0 || x > 1) {
      invalid(`applyVat.mesh.geometry.uv1[${index}].x`, 'must be finite and within [0, 1]');
    }
  }
}

function requiredNodeMaterial(material: THREE.Material | THREE.Material[]): NodeMaterialLike {
  if (
    Array.isArray(material) ||
    (material as { isNodeMaterial?: boolean }).isNodeMaterial !== true
  ) {
    diagnostic(
      'NACHI_VAT_NODE_MATERIAL_REQUIRED',
      'applyVat.mesh.material',
      'must be one Three.js NodeMaterial, not a material array or legacy material',
    );
  }
  return material as NodeMaterialLike;
}

function requiredTexture(texture: THREE.Texture, path: string): THREE.Texture {
  if (texture?.isTexture !== true) {
    throw new MeshFxDiagnosticError({
      code: 'NACHI_MESH_FX_TEXTURE_REQUIRED',
      message: 'must be a Three.js Texture',
      path,
    });
  }
  return texture;
}

function requireDataTextureColorSpace(texture: THREE.Texture, path: string): void {
  if (texture.colorSpace !== NoColorSpace) {
    invalid(`${path}.colorSpace`, 'must be NoColorSpace so VAT values remain linear');
  }
}

function textureDimensions(
  texture: THREE.Texture,
  path: string,
): { readonly width: number; readonly height: number } {
  const image = texture.image as { width?: unknown; height?: unknown } | undefined;
  const width = image?.width;
  const height = image?.height;
  if (!Number.isSafeInteger(width) || Number(width) <= 0) {
    invalid(`${path}.image.width`, 'must be a positive integer');
  }
  if (!Number.isSafeInteger(height) || Number(height) <= 0) {
    invalid(`${path}.image.height`, 'must be a positive integer');
  }
  return { width: Number(width), height: Number(height) };
}

function integer(value: number, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(path, `must be a safe integer >= ${minimum}`);
  }
  return value;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function diagnostic(
  code: MeshFxDiagnosticError['diagnostic']['code'],
  path: string,
  message: string,
): never {
  throw new MeshFxDiagnosticError({ code, message, path });
}
