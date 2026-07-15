import {
  VFXSystem,
  attribute,
  billboard,
  boids,
  burst,
  collideBox,
  collidePlane,
  collideSphere,
  compileEmitter,
  createCoreKernelModuleRegistry,
  defineEffect,
  defineEmitter,
  defineNeighborGrid,
  killVolume,
  lifetime,
  linearForce,
  neighborGridTslModule,
  pointAttractor,
  positionSphere,
  tslModule,
  velocityCone,
  vortex,
  type AttributeSnapshot,
  type InitModule,
  type UpdateModule,
  type Vec3,
  type VfxDiagnostic,
  type VfxRuntimeRenderer,
} from '@nachi-vfx/core';
import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi-vfx/three';
import * as THREE from 'three/webgpu';
import { context, uint, vec3 } from 'three/tsl';

import { createPerformanceMonitor } from './perf';
import { createPlaygroundRenderer } from './webgpu-renderer';
import './m12-space.css';

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const headless = query.get('headless') === '1';
const requestedBackend = query.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
const fault = query.get('fault');
root.dataset.headless = String(headless);
root.dataset.rendererStatus = 'initializing';
root.dataset.spikeStatus = 'initializing';

const messages: string[] = [];
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  messages.push(`warning: ${values.map(String).join(' ')}`);
  originalWarn(...values);
};
console.error = (...values: unknown[]) => {
  messages.push(`error: ${values.map(String).join(' ')}`);
  originalError(...values);
};

type BackendLike = {
  readonly device?: {
    readonly features?: { has(name: string): boolean };
    readonly limits?: { readonly maxStorageBuffersPerShaderStage?: number };
    readonly lost?: Promise<{ message?: string; reason?: string }>;
  };
  readonly isWebGPUBackend?: boolean;
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing H2-6 space fixture element ${selector}.`);
  return value;
}

function closeVector(left: Vec3, right: Vec3, tolerance = 2e-5): boolean {
  return left.every((value, axis) => Math.abs(value - right[axis]!) <= tolerance);
}

function rowVector(snapshot: AttributeSnapshot, name: 'position' | 'velocity'): Vec3 {
  const value = snapshot.rows[0]?.attributes[name];
  return Array.isArray(value)
    ? [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0)]
    : [0, 0, 0];
}

function fnvSnapshot(snapshot: AttributeSnapshot): string {
  let hash = 0x811c_9dc5;
  const mix = (word: number) => {
    hash = Math.imul((hash ^ word) >>> 0, 0x0100_0193) >>> 0;
  };
  mix(snapshot.rows.length);
  const scalar = new Float32Array(1);
  const bits = new Uint32Array(scalar.buffer);
  for (const row of [...snapshot.rows].sort((a, b) => (a.spawnOrder ?? 0) - (b.spawnOrder ?? 0))) {
    mix(row.spawnOrder ?? 0xffff_ffff);
    mix(row.physicalSlot);
    for (const name of ['position', 'velocity'] as const) {
      const value = row.attributes[name];
      for (const component of Array.isArray(value) ? value.slice(0, 3) : [0, 0, 0]) {
        scalar[0] = Number(component);
        mix(bits[0] ?? 0);
      }
    }
  }
  return hash.toString(16).padStart(8, '0');
}

function fixtureEmitter(options: {
  readonly init?: readonly InitModule[];
  readonly localPosition?: Vec3;
  readonly update?: readonly UpdateModule[];
}) {
  return defineEmitter({
    capacity: 1,
    init: [
      positionSphere({ center: options.localPosition ?? [0, 0, 0], radius: 0 }),
      velocityCone({ angle: 0, direction: [1, 0, 0], speed: 0 }),
      ...(options.init ?? []),
      lifetime(10),
    ],
    integration: 'none',
    lifecycle: { duration: 10 },
    render: billboard({}),
    spawn: burst({ count: 1 }),
    update: options.update ?? [],
  });
}

function makeRuntime(renderer: THREE.WebGPURenderer, backend: BackendLike): VfxRuntimeRenderer {
  const webgpu = backend.isWebGPUBackend === true;
  const adapter = createThreeKernelAdapter({
    backend: webgpu ? 'webgpu' : 'webgl2',
    ...(backend.device?.limits?.maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { maxStorageBuffersPerShaderStage: backend.device.limits.maxStorageBuffersPerShaderStage }),
  });
  return createThreeRuntimeRenderer(renderer, adapter, backend.device?.lost);
}

async function capture(instance: {
  readonly debug: {
    captureAttributes(
      emitterId: string,
      options: { attributes: readonly string[] },
    ): Promise<AttributeSnapshot>;
  };
}): Promise<AttributeSnapshot> {
  return instance.debug.captureAttributes('particles', { attributes: ['position', 'velocity'] });
}

async function runStatic(
  runtime: VfxRuntimeRenderer,
  emitter: ReturnType<typeof defineEmitter>,
  options: { readonly position?: Vec3; readonly rotation?: Vec3; readonly step?: number } = {},
) {
  const system = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
  const instance = system.spawn(defineEffect({ elements: { particles: emitter } }), {
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
    seed: 0x2606,
  });
  try {
    await system.update(0);
    if ((options.step ?? 0) > 0) await system.update(options.step);
    return await capture(instance);
  } finally {
    instance.release();
  }
}

function kernelShader(kernel: unknown): string {
  const renderer = {
    backend: { capabilities: { getUniformBufferLimit: () => 64 }, compatibilityMode: false },
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function selectorWgslHashes(explicitWorld: boolean) {
  const program = compileEmitter(
    defineEmitter({
      capacity: 1,
      init: [
        velocityCone({
          angle: 0,
          direction: [1, 0, 0],
          ...(explicitWorld ? { space: 'world' as const } : {}),
          speed: 2,
        }),
        lifetime(10),
      ],
      integration: 'none',
      render: billboard({}),
      spawn: burst({ count: 1 }),
      update: [
        linearForce({
          force: [1, 2, 3],
          ...(explicitWorld ? { space: 'world' as const } : {}),
        }),
      ],
    }),
  );
  const kernels = program.buildKernels(createThreeKernelAdapter({ backend: 'webgpu' }));
  return {
    initialize: await sha256(kernelShader(kernels.initialize)),
    update: await sha256(kernelShader(kernels.update)),
  };
}

function legacyEndpointModule(module: UpdateModule): UpdateModule {
  const reads =
    module.type === 'core/kill-volume'
      ? ['Emitter.transform', 'Particles.position']
      : module.type === 'core/point-attractor'
        ? ['Emitter.deltaTime', 'Emitter.transform', 'Particles.position', 'Particles.velocity']
        : ['Emitter.transform', 'Particles.position', 'Particles.velocity'];
  return {
    ...module,
    access: { reads, writes: module.access?.writes ?? [] },
    version: 1,
  } as UpdateModule;
}

async function runMovingVolume(
  runtime: VfxRuntimeRenderer,
  kind: 'collider' | 'kill-volume',
  partitions: 1 | 4,
  legacy = false,
) {
  const current =
    kind === 'collider'
      ? collideSphere({
          center: [0, 0, 0],
          mode: 'kill',
          radius: 0.75,
          ...(!legacy && fault === 'sweep-current' ? { space: 'world' as const } : {}),
        })
      : killVolume({ mode: 'inside', radius: 0.75, shape: 'sphere' });
  const update = [legacy ? legacyEndpointModule(current) : current];
  const system = new VFXSystem(runtime, undefined, {
    aliveCountReadbackInterval: 1,
    maxPoolSize: 0,
  });
  const instance = system.spawn(
    defineEffect({
      elements: { particles: fixtureEmitter({ localPosition: [2, 0, 0], update }) },
    }),
  );
  try {
    await system.update(0);
    for (let step = 1; step <= partitions; step += 1) {
      instance.setTransform([4 * (step / partitions), 0, 0]);
      await system.update(1 / partitions);
    }
    return (await capture(instance)).rows.length;
  } finally {
    instance.release();
  }
}

function forwardCurrentFaultCollider() {
  const type = 'fixture/collide-sphere-forward-current';
  const access = {
    reads: [
      'Emitter.transform',
      'Emitter.updateInterpolatedTransform',
      'Particles.position',
      'Particles.velocity',
    ],
    writes: ['Particles.position', 'Particles.velocity'],
  } as const;
  const registry = createCoreKernelModuleRegistry();
  registry.register({
    access,
    build(context) {
      const adapter = context.adapter;
      const midpoint = context.uniform('Emitter.updateInterpolatedTransform');
      const current = context.uniform('Emitter.transform');
      const position = context.attribute('position');
      const velocity = context.attribute('velocity');
      const inverseMidpoint = adapter.inverse(midpoint);
      const localPosition = inverseMidpoint.mul(
        adapter.vec4(position.x, position.y, position.z, 1),
      ).xyz;
      const localVelocity = inverseMidpoint.mul(
        adapter.vec4(velocity.x, velocity.y, velocity.z, 0),
      ).xyz;
      const distance = localPosition.x
        .mul(localPosition.x)
        .add(localPosition.y.mul(localPosition.y))
        .add(localPosition.z.mul(localPosition.z))
        .sqrt();
      const normal = localPosition.div(distance.clamp(0.000_001, 1e20));
      const normalSpeed = localVelocity.x
        .mul(normal.x)
        .add(localVelocity.y.mul(normal.y))
        .add(localVelocity.z.mul(normal.z));
      const tangent = localVelocity.sub(normal.mul(normalSpeed));
      const outgoingNormalSpeed = adapter.select(
        normalSpeed.lessThan(adapter.constant(0, 'f32')),
        normalSpeed.mul(adapter.constant(-0.5, 'f32')),
        normalSpeed,
      );
      const responseVelocity = tangent.add(normal.mul(outgoingNormalSpeed));
      adapter.branch(distance.lessThan(adapter.constant(1, 'f32')), () => {
        // Deliberate fixture-only fault: local evaluation uses the midpoint, but both forward
        // response paths incorrectly use the current endpoint.
        context.write('position', current.mul(adapter.vec4(normal.x, normal.y, normal.z, 1)).xyz);
        context.write(
          'velocity',
          current.mul(adapter.vec4(responseVelocity.x, responseVelocity.y, responseVelocity.z, 0))
            .xyz,
        );
      });
    },
    stage: 'update',
    type,
    version: 1,
  });
  return {
    module: {
      access,
      config: {},
      kind: 'module',
      stage: 'update',
      type,
      version: 1,
    } as UpdateModule,
    registry,
  };
}

async function runMovingColliderResponse(runtime: VfxRuntimeRenderer) {
  const injected = fault === 'collider-forward-current' ? forwardCurrentFaultCollider() : undefined;
  const update =
    injected?.module ??
    collideSphere({
      bounce: 0.5,
      center: [0, 0, 0],
      friction: 0,
      mode: 'bounce',
      radius: 1,
      space: 'emitter',
    });
  const system = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    ...(injected === undefined ? {} : { registry: injected.registry }),
  });
  const instance = system.spawn(
    defineEffect({
      elements: {
        particles: fixtureEmitter({
          init: [velocityCone({ angle: 0, direction: [0, -1, 0], speed: 1 })],
          localPosition: [2, 0.25, 0],
          update: [update],
        }),
      },
    }),
  );
  try {
    await system.update(0);
    instance.setTransform([4, 0, 0], [0, 0, Math.PI]);
    await system.update(1);
    const snapshot = await capture(instance);
    return {
      position: rowVector(snapshot, 'position'),
      velocity: rowVector(snapshot, 'velocity'),
    };
  } finally {
    instance.release();
  }
}

async function runMovingForce(runtime: VfxRuntimeRenderer, partitions: 1 | 4, legacy = false) {
  const force = pointAttractor({
    falloff: 0,
    position: [0, 0, 0],
    space: 'emitter',
    strength: 1,
  });
  const system = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
  const instance = system.spawn(
    defineEffect({
      elements: {
        particles: fixtureEmitter({
          localPosition: [2, 0, 0],
          update: [legacy ? legacyEndpointModule(force) : force],
        }),
      },
    }),
  );
  try {
    await system.update(0);
    for (let step = 1; step <= partitions; step += 1) {
      instance.setTransform([4 * (step / partitions), 0, 0]);
      await system.update(1 / partitions);
    }
    return rowVector(await capture(instance), 'velocity');
  } finally {
    instance.release();
  }
}

async function stationaryHashes(runtime: VfxRuntimeRenderer) {
  const transform = {
    position: [3, -2, 0] as Vec3,
    rotation: [0, 0, fault === 'stationary-bit' ? Math.PI / 4 : Math.PI / 3] as Vec3,
  };
  const cases: ReadonlyArray<readonly [string, Vec3, UpdateModule]> = [
    [
      'vortex',
      [1, 0, 0],
      vortex({ axis: [0, 0, 1], center: [0, 0, 0], space: 'emitter', strength: 1 }),
    ],
    [
      'pointAttractor',
      [1, 0, 0],
      pointAttractor({ falloff: 0, position: [0, 0, 0], space: 'emitter', strength: 1 }),
    ],
    [
      'collidePlane',
      [0, -0.25, 0],
      collidePlane({ mode: 'stick', normal: [0, 1, 0], offset: 0, space: 'emitter' }),
    ],
    [
      'collideSphere',
      [0.25, 0, 0],
      collideSphere({ center: [0, 0, 0], mode: 'stick', radius: 1, space: 'emitter' }),
    ],
    [
      'collideBox',
      [0.25, 0, 0],
      collideBox({ center: [0, 0, 0], mode: 'stick', size: [2, 2, 2], space: 'emitter' }),
    ],
    ['killVolume', [0, 0, 0], killVolume({ mode: 'inside', radius: 1, shape: 'sphere' })],
  ];
  return Object.fromEntries(
    await Promise.all(
      cases.map(async ([name, localPosition, update]) => {
        const snapshot = await runStatic(
          runtime,
          fixtureEmitter({ localPosition, update: [update] }),
          {
            ...transform,
            step: 0.25,
          },
        );
        return [name, { hash: fnvSnapshot(snapshot), rows: snapshot.rows.length }] as const;
      }),
    ),
  );
}

async function runNeighborCurrentClassification(runtime: VfxRuntimeRenderer) {
  const runtimeDiagnostics: VfxDiagnostic[] = [];
  const grid = defineNeighborGrid({
    cellCapacity: 4,
    cellSize: 1,
    origin: [-4.5, -0.5, -0.5],
    resolution: [1, 1, 1],
  });
  const layout = tslModule(
    ({ spawnOrder }) => ({
      position: vec3(spawnOrder.toFloat().mul(0.2) as never, 0, 0) as never,
      velocity: vec3(0, 0, 0) as never,
    }),
    { stage: 'init' },
  );
  const visitor = neighborGridTslModule(
    {
      access: {
        reads: ['Particles.position'],
        writes: ['Particles.neighborCount'],
      },
      grid: 'neighbors',
      radius: 1,
    },
    (gridContext) => {
      const count = uint(0).toVar();
      gridContext.forEachNeighbor(() => count.addAssign(1));
      return { neighborCount: count as never };
    },
  );
  const system = new VFXSystem(runtime, undefined, {
    maxPoolSize: 0,
    onRuntimeDiagnostic: (diagnostic) => runtimeDiagnostics.push(diagnostic),
  });
  const instance = system.spawn(
    defineEffect({
      elements: {
        neighbors: grid,
        particles: defineEmitter({
          attributes: {
            neighborCount: attribute('neighborCount', { default: 0, type: 'u32' }),
          },
          capacity: 2,
          init: [layout, lifetime(10)],
          integration: 'none',
          lifecycle: { duration: 10 },
          render: billboard({}),
          spawn: burst({ count: 2 }),
          update: [visitor],
        }),
      },
    }),
  );
  try {
    await system.update(0);
    instance.setTransform([fault === 'grid-midpoint' ? 2 : 4, 0, 0]);
    await system.update(1);
    const snapshot = await instance.getNeighborGrid('neighbors')!.capture();
    const attributes = await instance.debug.captureAttributes('particles', {
      attributes: ['neighborCount', 'position'],
    });
    return {
      cellCount: snapshot.counts[0] ?? 0,
      outOfBounds: snapshot.outOfBounds,
      runtimeDiagnostics: runtimeDiagnostics.map(({ code, severity }) => ({ code, severity })),
      visitorCounts: [...attributes.rows]
        .sort((a, b) => (a.spawnOrder ?? 0) - (b.spawnOrder ?? 0))
        .map((row) => Number(row.attributes.neighborCount)),
    };
  } finally {
    instance.release();
  }
}

function draw(selectors: { emitterVelocity: Vec3; worldVelocity: Vec3 }, sweepOk: boolean) {
  const canvas = required<HTMLCanvasElement>('#space-visual');
  const paint = canvas.getContext('2d')!;
  const gradient = paint.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#0a2239');
  gradient.addColorStop(1, '#070512');
  paint.fillStyle = gradient;
  paint.fillRect(0, 0, canvas.width, canvas.height);
  const arrow = (originX: number, vector: Vec3, color: string, label: string) => {
    const originY = 205;
    const x = originX + vector[0] * 60;
    const y = originY - vector[1] * 60;
    paint.strokeStyle = color;
    paint.lineWidth = 5;
    paint.beginPath();
    paint.moveTo(originX, originY);
    paint.lineTo(x, y);
    paint.stroke();
    paint.fillStyle = '#eaf7ff';
    paint.font = '16px system-ui';
    paint.fillText(label, originX - 45, 255);
  };
  arrow(170, selectors.worldVelocity, '#60d9ff', 'world: +X');
  arrow(470, selectors.emitterVelocity, '#ff7ec8', 'emitter: +Y');
  paint.fillStyle = sweepOk ? '#7dffbd' : '#ff718b';
  paint.font = '700 18px system-ui';
  paint.fillText(sweepOk ? 'moving-volume partitions agree' : 'moving-volume mismatch', 190, 60);
}

async function capturePerformance(): Promise<void> {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: true,
  });
  renderer.setSize(1, 1);
  const target = new THREE.RenderTarget(1, 1);
  let instance: { release(): void; setTransform(position: Vec3): void } | undefined;
  try {
    await renderer.init();
    const backend = renderer.backend as BackendLike;
    const runtime = makeRuntime(renderer, backend);
    const monitor = createPerformanceMonitor(renderer, {
      gpuScopes: backend.isWebGPUBackend ? ['compute'] : ['render'],
      gpuSampleSize: 16,
      gpuWarmupSamples: 4,
      mode: headless ? 'headless' : 'visual',
      page: '/m12-space/',
    });
    const system = new VFXSystem(runtime, undefined, { maxPoolSize: 0 });
    instance = system.spawn(
      defineEffect({
        elements: {
          particles: fixtureEmitter({
            localPosition: [2, 0, 0],
            update: [
              pointAttractor({
                falloff: 0,
                position: [0, 0, 0],
                space: 'emitter',
                strength: 1,
              }),
            ],
          }),
        },
      }),
    );
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    renderer.setRenderTarget(target);
    await monitor.captureGpuSamples(async (sample) => {
      instance!.setTransform([sample * 0.01, 0, 0]);
      await system.update(1 / 60);
      renderer.render(scene, camera);
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    });
  } finally {
    instance?.release();
    renderer.setRenderTarget(null);
    target.dispose();
    renderer.dispose();
  }
}

async function run(): Promise<void> {
  const renderer = await createPlaygroundRenderer({
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
    trackTimestamp: false,
  });
  renderer.setSize(1, 1);
  try {
    await renderer.init();
    const backend = renderer.backend as BackendLike;
    const webgpu = backend.isWebGPUBackend === true;
    root.dataset.backend = webgpu ? 'WebGPU' : 'WebGL2';
    root.dataset.rendererStatus = 'ready';
    required<HTMLElement>('#backend-value').textContent = root.dataset.backend;
    const runtime = makeRuntime(renderer, backend);

    const selectorSpace = fault === 'selector-world' ? 'world' : 'emitter';
    const worldVelocity = rowVector(
      await runStatic(
        runtime,
        fixtureEmitter({
          init: [velocityCone({ angle: 0, direction: [1, 0, 0], speed: 2 })],
        }),
        { rotation: [0, 0, Math.PI / 2] },
      ),
      'velocity',
    );
    const explicitWorldVelocity = rowVector(
      await runStatic(
        runtime,
        fixtureEmitter({
          init: [velocityCone({ angle: 0, direction: [1, 0, 0], space: 'world', speed: 2 })],
        }),
        { rotation: [0, 0, Math.PI / 2] },
      ),
      'velocity',
    );
    const emitterVelocity = rowVector(
      await runStatic(
        runtime,
        fixtureEmitter({
          init: [velocityCone({ angle: 0, direction: [1, 0, 0], space: selectorSpace, speed: 2 })],
        }),
        { rotation: [0, 0, Math.PI / 2] },
      ),
      'velocity',
    );
    const worldForceVelocity = rowVector(
      await runStatic(runtime, fixtureEmitter({ update: [linearForce({ force: [1, 0, 0] })] }), {
        rotation: [0, 0, Math.PI / 2],
        step: 0.25,
      }),
      'velocity',
    );
    const emitterForceVelocity = rowVector(
      await runStatic(
        runtime,
        fixtureEmitter({
          update: [linearForce({ force: [1, 0, 0], space: selectorSpace })],
        }),
        { rotation: [0, 0, Math.PI / 2], step: 0.25 },
      ),
      'velocity',
    );

    const collider = {
      four: await runMovingVolume(runtime, 'collider', 4),
      one: await runMovingVolume(runtime, 'collider', 1),
    };
    const kill = {
      four: await runMovingVolume(runtime, 'kill-volume', 4),
      one: await runMovingVolume(runtime, 'kill-volume', 1),
    };
    const force = {
      four: await runMovingForce(runtime, 4),
      one: await runMovingForce(runtime, 1),
    };
    const colliderResponse = await runMovingColliderResponse(runtime);
    const legacyV1 = {
      collider: {
        four: await runMovingVolume(runtime, 'collider', 4, true),
        one: await runMovingVolume(runtime, 'collider', 1, true),
      },
      force: {
        four: await runMovingForce(runtime, 4, true),
        one: await runMovingForce(runtime, 1, true),
      },
      kill: {
        four: await runMovingVolume(runtime, 'kill-volume', 4, true),
        one: await runMovingVolume(runtime, 'kill-volume', 1, true),
      },
      preChangeReferenceHead: '62aab5e',
    };
    const stationary = await stationaryHashes(runtime);
    const stationaryExpected = {
      collideBox: { hash: '409a2c30', rows: 1 },
      collidePlane: { hash: 'a95cc10c', rows: 1 },
      collideSphere: { hash: '409a2c30', rows: 1 },
      killVolume: { hash: '050c5d1f', rows: 0 },
      pointAttractor: { hash: '3fdd6f3f', rows: 1 },
      vortex: { hash: '698930cd', rows: 1 },
    };
    const neighborCurrent = await runNeighborCurrentClassification(runtime);
    const neighborAccess = boids({ grid: 'neighbors', radius: 1 }).access?.reads ?? [];
    const wgsl = webgpu
      ? { explicit: await selectorWgslHashes(true), omitted: await selectorWgslHashes(false) }
      : undefined;
    const oldHashes = {
      initialize: '995776cef488f7ef5a096c8d536c5d1615ad8ef879d083e19c7cd85339da3872',
      update: '2b4577d2bc2ee750d5bd9882c4f115a56aa5905b301facbb6ec3aebca3a15e43',
    };

    const validationBeforePerformance = {
      linearForceSelector:
        closeVector(worldForceVelocity, [0.25, 0, 0]) &&
        closeVector(emitterForceVelocity, [0, 0.25, 0]),
      movingColliderPartitionsAgree: collider.one === 0 && collider.four === 0,
      movingColliderResponse:
        closeVector(colliderResponse.position, [2, 1, 0]) &&
        closeVector(colliderResponse.velocity, [0, 0.5, 0]),
      movingForcePartitionsAgree:
        closeVector(force.one, [0, 0, 0]) && closeVector(force.four, [0, 0, 0]),
      movingKillPartitionsAgree: kill.one === 0 && kill.four === 0,
      moduleVersionBoundary:
        legacyV1.collider.one === 1 &&
        legacyV1.collider.four === 0 &&
        legacyV1.kill.one === 1 &&
        legacyV1.kill.four === 0 &&
        closeVector(legacyV1.force.one, [1, 0, 0]) &&
        closeVector(legacyV1.force.four, [0.25, 0, 0]),
      neighborGridUsesCurrentTransform:
        neighborAccess.includes('Emitter.transform') &&
        !neighborAccess.includes('Emitter.updateInterpolatedTransform') &&
        neighborCurrent.outOfBounds === 0 &&
        neighborCurrent.cellCount === 2 &&
        neighborCurrent.visitorCounts.join(',') === '1,1',
      neighborRuntimeDiagnostics:
        fault === 'grid-midpoint'
          ? neighborCurrent.runtimeDiagnostics.length === 1 &&
            neighborCurrent.runtimeDiagnostics[0]?.code ===
              'NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT' &&
            neighborCurrent.runtimeDiagnostics[0]?.severity === 'warning'
          : neighborCurrent.runtimeDiagnostics.length === 0,
      selectors:
        closeVector(worldVelocity, [2, 0, 0]) &&
        closeVector(explicitWorldVelocity, [2, 0, 0]) &&
        closeVector(emitterVelocity, [0, 2, 0]),
      stationaryCovered:
        Object.keys(stationary).join(',') ===
          'vortex,pointAttractor,collidePlane,collideSphere,collideBox,killVolume' &&
        JSON.stringify(stationary) ===
          JSON.stringify({
            vortex: stationaryExpected.vortex,
            pointAttractor: stationaryExpected.pointAttractor,
            collidePlane: stationaryExpected.collidePlane,
            collideSphere: stationaryExpected.collideSphere,
            collideBox: stationaryExpected.collideBox,
            killVolume: stationaryExpected.killVolume,
          }),
      worldWgslCompatibility:
        wgsl === undefined ||
        (JSON.stringify(wgsl.omitted) === JSON.stringify(oldHashes) &&
          JSON.stringify(wgsl.explicit) === JSON.stringify(oldHashes)),
    };
    const sweepOk =
      validationBeforePerformance.movingColliderPartitionsAgree &&
      validationBeforePerformance.movingKillPartitionsAgree;
    draw({ emitterVelocity, worldVelocity }, sweepOk);
    await capturePerformance();
    const validation = {
      consoleClean: messages.length === 0,
      ...validationBeforePerformance,
    };

    const result = {
      backend: root.dataset.backend,
      checks: {
        moving: { collider, colliderResponse, force, kill, midpointPhase: 0.5 },
        moduleV1EndpointGpu: legacyV1,
        neighborGridTransform: { classification: 'current', result: neighborCurrent },
        selectors: {
          emitterForceVelocity,
          emitterVelocity,
          explicitWorldVelocity,
          worldForceVelocity,
          worldVelocity,
        },
        stationary,
        stationaryExpected,
        wgsl,
      },
      fault,
      ok: Object.values(validation).every(Boolean),
      validation,
    };
    root.dataset.spikeResult = JSON.stringify(result);
    root.dataset.spikeStatus = 'complete';
    root.dataset.sceneReady = 'true';
    required<HTMLElement>('#status-value').textContent = result.ok
      ? 'All checks passed'
      : 'Validation failed';
    required<HTMLElement>('#case-value').textContent = `${Object.keys(validation).length} checks`;
  } finally {
    renderer.dispose();
  }
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.spikeError = message;
  root.dataset.spikeResult = JSON.stringify({ error: message, fault, ok: false });
  root.dataset.spikeStatus = 'error';
  root.dataset.sceneReady = 'true';
  required<HTMLElement>('#status-value').textContent = `Failed: ${message}`;
});
