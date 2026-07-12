import {
  VfxDiagnosticError,
  VFXSystem,
  billboard,
  boids,
  burst,
  compileEmitter,
  defineEmitter,
  defineEffect,
  defineNeighborGrid,
  gravity,
  neighborGridTslModule,
  pbdDistanceConstraint,
} from '@nachi/core';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';

import { createThreeKernelAdapter } from './three-kernel-adapter';

const grid = defineNeighborGrid({
  cellCapacity: 8,
  cellSize: 0.5,
  origin: [-2, -2, -2],
  resolution: [8, 8, 8],
});

function updateShader(radius: number): string {
  const emitter = defineEmitter({
    capacity: 4,
    integration: 'none',
    render: billboard({}),
    spawn: burst({ count: 4 }),
    update: [boids({ grid: 'neighbors', radius })],
  });
  const program = compileEmitter(emitter, { neighborGrids: { neighbors: grid } });
  const kernel = program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu' })).update;
  return kernelShader(kernel);
}

function kernelShader(kernel: unknown): string {
  const renderer = {
    backend: { capabilities: { getUniformBufferLimit: () => 64 } },
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

describe('M12 NeighborGrid Three r185 materialization', () => {
  it('builds guarded bucket, boids, and submit-separated PBD kernels', () => {
    const emitter = defineEmitter({
      capacity: 16,
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 8 }),
      update: [
        boids({ grid: 'neighbors', radius: 1 }),
        pbdDistanceConstraint({ distance: 0.25, grid: 'neighbors', iterations: 3 }),
      ],
    });
    const program = compileEmitter(emitter, { neighborGrids: { neighbors: grid } });
    const kernels = program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu' }));
    expect(kernels.neighborGrids.neighbors?.definition).toBe(grid);
    expect(kernels.neighborGrids.neighbors?.pbdIterations).toHaveLength(3);
    expect(() => kernelShader(kernels.update)).not.toThrow();
    expect(() => kernelShader(kernels.neighborGrids.neighbors!.pbdIterations[0])).not.toThrow();
  });

  it('keeps neighbor traversal WGSL structurally bounded across search radii', () => {
    const shaders = [0, 1, 2].map(updateShader);
    const loopCounts = shaders.map((shader) => shader.match(/\bfor \(/g)?.length ?? 0);
    const atomicLoadCounts = shaders.map((shader) => shader.match(/\batomicLoad\(/g)?.length ?? 0);

    expect(loopCounts[0]).toBeGreaterThanOrEqual(4);
    expect(atomicLoadCounts[0]).toBeGreaterThan(0);
    for (const shader of shaders) {
      expect(shader).toContain('neighborX');
      expect(shader).toContain('neighborY');
      expect(shader).toContain('neighborZ');
      expect(shader).toContain('neighborSlot');
    }
    expect(loopCounts).toEqual([loopCounts[0], loopCounts[0], loopCounts[0]]);
    expect(atomicLoadCounts).toEqual([
      atomicLoadCounts[0],
      atomicLoadCounts[0],
      atomicLoadCounts[0],
    ]);
    expect(Math.max(...shaders.map(({ length }) => length))).toBeLessThanOrEqual(
      Math.min(...shaders.map(({ length }) => length)) + 8,
    );
  });

  it('materializes PBD without requiring a declared velocity attribute', () => {
    const emitter = defineEmitter({
      capacity: 2,
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 2 }),
      update: [pbdDistanceConstraint({ distance: 0.2, grid: 'neighbors' })],
    });
    const program = compileEmitter(emitter, { neighborGrids: { neighbors: grid } });
    expect(program.attributeSchema.byName.velocity).toBeUndefined();
    expect(() =>
      program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu' })),
    ).not.toThrow();
  });

  it('materializes code-only TSL with live context state and snapshot neighbor state', () => {
    const custom = neighborGridTslModule(
      {
        access: {
          reads: ['Particles.alive', 'Particles.position', 'Particles.velocity'],
          writes: ['Particles.velocity'],
        },
        grid: 'neighbors',
        radius: 1,
      },
      ({ forEachNeighbor, velocity }) => {
        const next = velocity.toVar();
        forEachNeighbor((neighbor) => {
          next.addAssign(neighbor.velocity);
        });
        return { velocity: next };
      },
    );
    const emitter = defineEmitter({
      capacity: 4,
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 4 }),
      update: [custom],
    });
    const program = compileEmitter(emitter, { neighborGrids: { neighbors: grid } });
    const kernels = program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu' }));
    const shader = kernelShader(kernels.update);
    expect(shader).not.toMatch(
      /NachiNeighborGrid(?:Position|Velocity)_neighbors\.value\[ instanceIndex \]/,
    );
    expect(shader).toMatch(
      /NachiNeighborGridVelocity_neighbors\.value\[ NachiNeighborGridSlots_neighbors\.value/,
    );
  });

  it('preserves gravity when boids follows by reading live self state and snapshot neighbors', () => {
    const emitter = defineEmitter({
      capacity: 2,
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 2 }),
      update: [
        gravity([0, -9.8, 0]),
        boids({ alignment: 0, cohesion: 0, grid: 'neighbors', separation: 0 }),
      ],
    });
    const program = compileEmitter(emitter, { neighborGrids: { neighbors: grid } });
    const shader = kernelShader(
      program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu' })).update,
    );

    expect(shader).toContain('-9.8');
    expect(shader).not.toMatch(
      /NachiNeighborGrid(?:Position|Velocity)_neighbors\.value\[ instanceIndex \]/,
    );
    const gravityOffset = shader.indexOf('-9.8');
    const liveVelocityReads = [
      ...shader.matchAll(
        /vec3<f32>\( NachiParticles_packed_float\.value\[ \( \( instanceIndex \* 2u \) \+ 1u \) \]/g,
      ),
    ];
    expect(liveVelocityReads).toHaveLength(2);
    expect(liveVelocityReads[1]!.index).toBeGreaterThan(gravityOffset);
    expect(shader).toMatch(
      /NachiNeighborGridVelocity_neighbors\.value\[ NachiNeighborGridSlots_neighbors\.value/,
    );
  });

  it('dispatches enough clear invocations for both stats on a one-slot grid', () => {
    const tinyGrid = defineNeighborGrid({ cellCapacity: 1, resolution: [1, 1, 1] });
    const emitter = defineEmitter({
      capacity: 1,
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 1 }),
      update: [boids({ grid: 'neighbors' })],
    });
    const clear = compileEmitter(emitter, {
      neighborGrids: { neighbors: tinyGrid },
    }).buildKernels(createThreeKernelAdapter({ backend: 'webgpu' })).neighborGrids.neighbors!.clear;

    expect((clear as unknown as { readonly count: number }).count).toBe(2);
  });

  it('warns when authored radii truncate boids separation or omit PBD pairs', () => {
    const emitter = defineEmitter({
      capacity: 2,
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 2 }),
      update: [
        boids({ grid: 'neighbors', radius: 1, separationRadius: 1.5 }),
        pbdDistanceConstraint({ distance: 1.1, grid: 'neighbors', radius: 2 }),
      ],
    });
    const diagnostics = compileEmitter(emitter, {
      neighborGrids: { neighbors: grid },
    }).diagnostics;

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_BOIDS_SEPARATION_RADIUS_EXCEEDS_SEARCH',
        path: 'update[0].config.separationRadius',
        severity: 'warning',
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'NACHI_PBD_RADIUS_MISSES_PAIRS',
        path: 'update[1].config.radius',
        severity: 'warning',
      }),
    );
  });

  it('rejects WebGL2 with the explicit atomics diagnostic before materialization', () => {
    const emitter = defineEmitter({
      capacity: 2,
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 2 }),
      update: [boids({ grid: 'neighbors' })],
    });
    const program = compileEmitter(emitter, { neighborGrids: { neighbors: grid } });
    try {
      program.buildKernels(createThreeKernelAdapter({ backend: 'webgl2' }));
      throw new Error('Expected NeighborGrid WebGL2 materialization to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(VfxDiagnosticError);
      expect((error as VfxDiagnosticError).diagnostics.map(({ code }) => code)).toContain(
        'NACHI_NEIGHBOR_GRID_WEBGL2_UNSUPPORTED',
      );
    }
  });

  it('reports an unconsumed effect-owned grid with its structured diagnostic', () => {
    const system = new VFXSystem({
      kernelAdapter: createThreeKernelAdapter({ backend: 'webgpu' }),
      submitCompute() {},
      submitComputeIndirect() {},
    });
    const instance = system.spawn(defineEffect({ elements: { neighbors: grid } }));

    expect(instance.state).toBe('error');
    expect(instance.diagnostics.map(({ code }) => code)).toContain('NACHI_NEIGHBOR_GRID_UNBOUND');
  });

  it('schedules clear/bucket around every Jacobi iteration and a final update snapshot', async () => {
    const emitter = defineEmitter({
      capacity: 2,
      integration: 'none',
      lifecycle: { duration: 10 },
      render: billboard({}),
      spawn: burst({ count: 2 }),
      update: [pbdDistanceConstraint({ distance: 0.2, grid: 'neighbors', iterations: 3 })],
    });
    const system = new VFXSystem({
      kernelAdapter: createThreeKernelAdapter({ backend: 'webgpu' }),
      submitCompute() {},
      submitComputeIndirect() {},
    });
    const instance = system.spawn(
      defineEffect({ elements: { neighbors: grid, particles: emitter } }),
    );
    await system.update(0);
    await system.update(1 / 60);
    expect(instance.diagnostics).toEqual([]);
    expect(instance.state).toBe('active');
    // 3 * (clear + bucket + constraint) + final clear + bucket.
    expect(instance.getNeighborGrid('neighbors')?.submissionCount).toBe(11);
  });
});
