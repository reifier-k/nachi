import {
  Grid2DStageRegistry,
  Grid3DStageRegistry,
  defineGrid2D,
  defineGrid2DStageFunction,
  defineGrid3D,
  defineGrid3DStageFunction,
  defineSimStage,
  grid3DTslModule,
  gridTslModule,
  type Grid2DStageFactory,
  type Grid3DStageFactory,
  type KernelNode,
} from '@nachi-vfx/core';
import { createThreeKernelAdapter } from '@nachi-vfx/three';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';

import { Grid2DRuntime } from '../../../packages/core/src/grid2d';
import { Grid3DRuntime } from '../../../packages/core/src/grid3d';

function kernelShader(kernel: unknown): string {
  const renderer = {
    backend: {
      capabilities: { getUniformBufferLimit: () => 64 },
      compatibilityMode: false,
    },
    contextNode: context({}),
    getMRT: () => null,
    getRenderTarget: () => null,
    hasFeature: () => false,
  };
  const NodeBuilder = THREE.WGSLNodeBuilder as unknown as new (
    object: unknown,
    renderer: unknown,
  ) => { build(): void; computeShader: string };
  const builder = new NodeBuilder(kernel, renderer);
  builder.build();
  return builder.computeShader;
}

function codegenRenderer(shaders: string[]) {
  return {
    kernelAdapter: createThreeKernelAdapter({ backend: 'webgpu' }),
    submitCompute(kernel: unknown) {
      shaders.push(kernelShader(kernel));
    },
  };
}

describe('custom Grid2D/3D Three r185 materialization', () => {
  it('builds equivalent inline/registered Grid2D WGSL containing the factory calculation', async () => {
    const factory: Grid2DStageFactory = ({ cell, deltaTime, read, sample }) => ({
      density: (read('density') as KernelNode)
        .mul(0.375)
        .add((sample('density', [cell[0].add(1), cell[1]]) as KernelNode).mul(deltaTime))
        .add(6.125),
    });
    const registration = defineGrid2DStageFunction('test/real-grid2d-codegen', factory);
    const grid = defineGrid2D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 3],
    });
    const build = async (kind: 'inline' | 'registered') => {
      const shaders: string[] = [];
      const runtime = new Grid2DRuntime(
        grid,
        codegenRenderer(shaders) as never,
        [
          defineSimStage({
            target: 'grid',
            update: gridTslModule(kind === 'inline' ? factory : registration),
          }),
        ],
        kind === 'registered' ? new Grid2DStageRegistry().register(registration) : undefined,
      );
      await runtime.preparePipelines();
      return shaders;
    };
    const inlineShaders = await build('inline');
    const registeredShaders = await build('registered');
    const factoryShader = inlineShaders.find((shader) => shader.includes('6.125'));

    expect(inlineShaders.length).toBeGreaterThan(4);
    expect(inlineShaders.every((shader) => shader.includes('@compute'))).toBe(true);
    expect(registeredShaders).toEqual(inlineShaders);
    expect(factoryShader).toContain('NachiGrid2DState');
    expect(factoryShader).toContain('* 0.375');
    expect(factoryShader).toContain('* object.nodeUniform');
  });

  it('builds equivalent inline/registered Grid3D WGSL containing the factory calculation', async () => {
    const factory: Grid3DStageFactory = ({ cell, deltaTime, read, sample }) => ({
      density: (read('density') as KernelNode)
        .mul(0.625)
        .add((sample('density', [cell[0].add(1), cell[1], cell[2]]) as KernelNode).mul(deltaTime))
        .sub(2.75),
    });
    const registration = defineGrid3DStageFunction('test/real-grid3d-codegen', factory);
    const grid = defineGrid3D({
      channels: { density: { type: 'f32' } },
      resolution: [4, 3, 2],
    });
    const build = async (kind: 'inline' | 'registered') => {
      const shaders: string[] = [];
      const runtime = new Grid3DRuntime(
        grid,
        codegenRenderer(shaders) as never,
        [
          defineSimStage({
            target: 'grid',
            update: grid3DTslModule(kind === 'inline' ? factory : registration),
          }),
        ],
        kind === 'registered' ? new Grid3DStageRegistry().register(registration) : undefined,
      );
      await runtime.preparePipelines();
      return shaders;
    };
    const inlineShaders = await build('inline');
    const registeredShaders = await build('registered');
    const factoryShader = inlineShaders.find((shader) => shader.includes('2.75'));

    expect(inlineShaders.length).toBeGreaterThan(4);
    expect(inlineShaders.every((shader) => shader.includes('@compute'))).toBe(true);
    expect(registeredShaders).toEqual(inlineShaders);
    expect(factoryShader).toContain('NachiGrid3DState');
    expect(factoryShader).toContain('* 0.625');
    expect(factoryShader).toContain('* object.nodeUniform');
  });
});
