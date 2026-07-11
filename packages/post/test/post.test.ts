import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { bloomPreset, createPostPipeline, radialBlur, screenDistortion } from '../src/index.js';
import { heatHazeOffsetCpu, radialBlurSampleUvs, shockwaveOffsetCpu } from '../src/math.js';

type GraphNode = {
  readonly constructor: { readonly name: string };
  readonly inputNode?: GraphNode;
  readonly renderTarget?: THREE.RenderTarget;
  readonly value?: unknown;
  traverse(callback: (node: GraphNode) => void): void;
};

function graphNodes(pipeline: ReturnType<typeof createPostPipeline>): readonly GraphNode[] {
  const nodes: GraphNode[] = [];
  (pipeline.renderPipeline.outputNode as unknown as GraphNode).traverse((node) => nodes.push(node));
  return nodes;
}

function bloomInputNodeKinds(pipeline: ReturnType<typeof createPostPipeline>): Set<string> {
  const nodes = graphNodes(pipeline);
  const bloom = nodes.find((node) => node.constructor.name === 'BloomNode');
  if (!bloom?.inputNode) throw new Error('Expected the pipeline graph to contain a BloomNode.');
  const kinds = new Set<string>();
  bloom.inputNode.traverse((node) => kinds.add(node.constructor.name));
  return kinds;
}

describe('@nachi/post authoring', () => {
  it('provides immutable bloom presets with overrides', () => {
    const soft = bloomPreset('soft');
    const intense = bloomPreset('intense', { threshold: 1.2 });
    expect(soft.config).toEqual({ strength: 0.65, radius: 0.35, threshold: 0.8 });
    expect(intense.config.threshold).toBe(1.2);
    expect(Object.isFrozen(soft.config)).toBe(true);
  });

  it('validates pass configuration synchronously', () => {
    expect(() => screenDistortion({})).toThrow(/requires at least one/);
    expect(() => radialBlur({ samples: 0 })).toThrow(/NACHI_POST_INVALID_PARAMETER/);
    expect(() => bloomPreset('soft', { radius: 1.1 })).toThrow(/within \[0, 1\]/);
  });

  it('enforces a real pass permutation and the standalone/external time split', () => {
    const renderer = {
      outputColorSpace: THREE.NoColorSpace,
      toneMapping: THREE.NoToneMapping,
    } as unknown as THREE.WebGPURenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const distortion = screenDistortion({
      shockwaves: [
        { center: [0.4, 0.6], duration: 1, radius: 0.2, ringWidth: 0.1, strength: 0.02 },
      ],
      time: 0,
    });
    const pipeline = createPostPipeline(renderer, scene, camera, {
      bloom: bloomPreset('soft'),
      distortion,
      order: ['bloom', 'distortion'],
    });
    expect(pipeline.order).toEqual(['bloom', 'distortion']);
    expect(() => pipeline.controls.setTime(1)).toThrow(/NACHI_POST_EXTERNAL_BINDING/);
    pipeline.dispose();
    expect(() =>
      createPostPipeline(renderer, scene, camera, {
        bloom: bloomPreset('soft'),
        distortion,
        order: ['distortion', 'distortion'],
      }),
    ).toThrow(/NACHI_POST_INVALID_ORDER/);
  });

  it('rewires the bloom input when distortion and bloom order changes', () => {
    const renderer = {
      outputColorSpace: THREE.NoColorSpace,
      toneMapping: THREE.NoToneMapping,
    } as unknown as THREE.WebGPURenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const distortion = screenDistortion({
      shockwaves: [
        { center: [0.4, 0.6], duration: 1, radius: 0.2, ringWidth: 0.1, strength: 0.02 },
      ],
    });
    const config = { bloom: bloomPreset('soft'), distortion };
    const distortionThenBloom = createPostPipeline(renderer, scene, camera, {
      ...config,
      order: ['distortion', 'bloom'],
    });
    const bloomThenDistortion = createPostPipeline(renderer, scene, camera, {
      ...config,
      order: ['bloom', 'distortion'],
    });

    const distortionThenBloomInput = bloomInputNodeKinds(distortionThenBloom);
    const bloomThenDistortionInput = bloomInputNodeKinds(bloomThenDistortion);
    expect(distortionThenBloomInput).toContain('MathNode');
    expect(distortionThenBloomInput).toContain('OperatorNode');
    expect(bloomThenDistortionInput).not.toContain('MathNode');
    expect(bloomThenDistortionInput).not.toContain('OperatorNode');

    distortionThenBloom.dispose();
    bloomThenDistortion.dispose();
  });

  it('disposes the scene pass render target with the pipeline', () => {
    const renderer = {
      outputColorSpace: THREE.NoColorSpace,
      toneMapping: THREE.NoToneMapping,
    } as unknown as THREE.WebGPURenderer;
    const pipeline = createPostPipeline(renderer, new THREE.Scene(), new THREE.Camera(), {
      radialBlur: radialBlur(),
    });
    const scenePass = graphNodes(pipeline).find(
      (node) => node.constructor.name === 'PassNode' && node.renderTarget,
    );
    if (!scenePass?.renderTarget) throw new Error('Expected a scene PassNode render target.');
    let disposeEvents = 0;
    scenePass.renderTarget.addEventListener('dispose', () => {
      disposeEvents += 1;
    });

    pipeline.dispose();

    expect(disposeEvents).toBe(1);
  });

  it('validates control updates atomically with the authoring constraints', () => {
    const renderer = {
      outputColorSpace: THREE.NoColorSpace,
      toneMapping: THREE.NoToneMapping,
    } as unknown as THREE.WebGPURenderer;
    const shockwave = {
      center: [0.4, 0.6],
      duration: 1,
      enabled: 1,
      radius: 0.2,
      ringWidth: 0.1,
      speed: 0,
      startTime: 0,
      strength: 0.02,
    } as const;
    const heatHaze = {
      center: [0.5, 0.5],
      enabled: 1,
      feather: 0.2,
      scale: 24,
      size: [0.7, 0.5],
      speed: [0.1, -0.05],
      strength: 0.01,
    } as const;
    const pipeline = createPostPipeline(renderer, new THREE.Scene(), new THREE.Camera(), {
      distortion: screenDistortion({ heatHaze: [heatHaze], shockwaves: [shockwave] }),
    });
    const centerUniform = graphNodes(pipeline).find(
      (node) =>
        node.constructor.name === 'UniformNode' &&
        node.value instanceof THREE.Vector2 &&
        node.value.equals(new THREE.Vector2(...shockwave.center)),
    );
    if (!(centerUniform?.value instanceof THREE.Vector2)) {
      throw new Error('Expected the package-owned shockwave center uniform.');
    }

    expect(() =>
      pipeline.controls.setShockwave(0, {
        ...shockwave,
        center: [0.1, 0.2],
        duration: 0,
      }),
    ).toThrow(/duration: must be finite and > 0/);
    expect(centerUniform.value.toArray()).toEqual([...shockwave.center]);
    expect(() => pipeline.controls.setShockwave(0, { ...shockwave, ringWidth: -0.01 })).toThrow(
      /ringWidth: must be finite and > 0/,
    );
    expect(() => pipeline.controls.setHeatHaze(0, { ...heatHaze, feather: 0 })).toThrow(
      /feather: must be finite and > 0/,
    );

    pipeline.dispose();
  });

  it('reports setTime as unavailable when distortion is not configured', () => {
    const renderer = {
      outputColorSpace: THREE.NoColorSpace,
      toneMapping: THREE.NoToneMapping,
    } as unknown as THREE.WebGPURenderer;
    const pipeline = createPostPipeline(renderer, new THREE.Scene(), new THREE.Camera(), {
      radialBlur: radialBlur(),
    });

    expect(() => pipeline.controls.setTime(0)).toThrow(/requires a configured screen-distortion/);
    pipeline.dispose();
  });
});

describe('@nachi/post CPU mirrors', () => {
  it('moves a non-axis-aligned shockwave sample outward with a time envelope', () => {
    const source = {
      center: [0.31, 0.43] as const,
      duration: 2,
      radius: 0.25,
      ringWidth: 0.08,
      speed: 0.1,
      strength: 0.04,
    };
    const uv = [0.31 + 0.28 * 0.8, 0.43 + 0.28 * 0.6] as const;
    const offset = shockwaveOffsetCpu(uv, source, 0.3);
    expect(offset[0]).toBeGreaterThan(0.02);
    expect(offset[1]).toBeGreaterThan(0.015);
    expect(shockwaveOffsetCpu(uv, source, 2.1)).toEqual([0, 0]);
  });

  it('changes heat haze over time and honors the disabled control', () => {
    const region = {
      center: [0.5, 0.5] as const,
      size: [0.8, 0.6] as const,
      strength: 0.02,
    };
    const atZero = heatHazeOffsetCpu([0.61, 0.44], region, 0);
    const adjacent = heatHazeOffsetCpu([0.611, 0.441], region, 0);
    const later = heatHazeOffsetCpu([0.61, 0.44], region, 0.7);
    expect(Math.hypot(adjacent[0] - atZero[0], adjacent[1] - atZero[1])).toBeLessThan(0.002);
    expect(later).not.toEqual(atZero);
    expect(heatHazeOffsetCpu([0.61, 0.44], { ...region, enabled: 0 }, 0.7)).toEqual([0, 0]);
  });

  it('keeps the radial center invariant and moves peripheral samples inward', () => {
    expect(radialBlurSampleUvs([0.5, 0.5], [0.5, 0.5], 0.4, 6)).toEqual(
      Array.from({ length: 6 }, () => [0.5, 0.5]),
    );
    const edge = radialBlurSampleUvs([0.9, 0.3], [0.5, 0.5], 0.5, 3);
    expect(edge).toEqual([
      [0.9, 0.3],
      [0.8, 0.35],
      [0.7, 0.4],
    ]);
    expect(radialBlurSampleUvs([0, 1], [0.5, 0.5], 0, 2)).toEqual([
      [0.001, 0.999],
      [0.001, 0.999],
    ]);
  });
});
