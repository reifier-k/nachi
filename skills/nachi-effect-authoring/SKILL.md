---
name: nachi-effect-authoring
description: Author game skill effects (hit sparks, slashes, heals, beams, ultimates) with the @nachi-vfx TSL/WebGPU particle library. Use whenever creating, tuning, or debugging visual effects that import @nachi-vfx packages — provides the bootstrap recipe, full module catalog, timeline choreography, and scale-based production recipes so implementation can start immediately without surveying library source code.
---

# nachi-vfx エフェクト制作スキル

`@nachi-vfx/*`（Three.js r185 / WebGPU / TSL ネイティブの Niagara パリティ VFX ライブラリ）で
ゲームのスキルエフェクトを作るためのスキル。

**最重要ルール: このスキルと同梱リファレンスの情報だけで実装を開始してよい。**
パッケージのソースコードや型定義の事前調査は不要。ここに書かれていないオプション名や
挙動が必要になったときだけ、該当パッケージの `src/index.ts`（barrel export）と
`src/types.ts` をピンポイントで読むこと。全体調査は時間の無駄であり、やらない。

## 同梱リファレンス

- [references/library-usage.md](references/library-usage.md) — ライブラリ使用法の全カタログ
  （ブートストラップ、エミッタ定義、全モジュール一覧とオプション、パラメータ、
  timeline / trails / mesh-fx / post / tsl-kit / format / react、落とし穴）
- [references/effect-recipes.md](references/effect-recipes.md) — スキルエフェクト制作のコツ
  （レイヤリング理論、規模別レシピ S/M/L/XL、タイミング設計、色と HDR、チューニング手順）

## 30 秒サマリ

1. **インストール**: `pnpm add @nachi-vfx/core @nachi-vfx/three three@0.185.1`
   （+ 開発時 `@types/three@0.185.0`）。Three は **0.185.1 固定**。他バージョン不可。
2. **ブートストラップ**（アプリ起動時に 1 回）:
   `WebGPURenderer` → `createThreeKernelAdapter({ backend: 'webgpu' })` →
   `createThreeRuntimeRenderer(renderer, adapter)` → `new VFXSystem(runtimeRenderer, scene)`。
3. **エフェクト定義**（純粋データ、モジュールスコープに置く）:
   `defineEffect({ elements: { name: defineEmitter({ capacity, spawn, init, update, render }) } })`。
4. **再生**: `system.spawn(effect, { position, seed })` →
   各エミッタの draw を **手動で materialize して scene に add**（下の落とし穴 #1）→
   毎フレーム `await system.update(dt)` → `instance.state === 'complete'` で
   `instance.release()` + draw 破棄。
5. **振り付けが要るスキル**（複数要素の時間差再生）は `@nachi-vfx/timeline` の
   `defineEffect` + `timeline([at(t, play('key'), cameraShake(...))], { duration })` を使う。

## 最小動作コード（コピーして開始してよい）

```ts
import {
  VFXSystem, billboard, burst, colorOverLife, defineEffect, defineEmitter,
  drag, gradient, gravity, lifetime, positionSphere, range, sizeOverLife,
  curve, velocityCone,
} from '@nachi-vfx/core';
import {
  createThreeKernelAdapter, createThreeRuntimeRenderer,
  disposeThreeDraw, materializeThreeSpriteDraw,
} from '@nachi-vfx/three';
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1, 5);

const adapter = createThreeKernelAdapter({ backend: 'webgpu' });
const runtimeRenderer = createThreeRuntimeRenderer(renderer, adapter);
const system = new VFXSystem(runtimeRenderer, scene);

const hitSpark = defineEffect({
  elements: {
    sparks: defineEmitter({
      capacity: 256,
      spawn: burst({ count: 80 }),
      init: [
        positionSphere({ radius: 0.05 }),
        velocityCone({ direction: [0, 1, 0], angle: 60, speed: range(3, 7) }),
        lifetime(range(0.2, 0.5)),
      ],
      update: [
        gravity(-9.8), drag(0.4),
        sizeOverLife(curve([0, 1], [1, 0])),
        colorOverLife(gradient('#fff6d8', '#ffb347', '#ff3a1000')),
      ],
      render: billboard({
        blending: 'additive',
        alignment: { mode: 'velocity-stretch', factor: 0.6 },
      }),
    }),
  },
});

const instance = system.spawn(hitSpark, { position: [0, 1, 0], seed: 42 });
const emitter = instance.getEmitter('sparks');
if (!emitter) throw new Error('sparks emitter missing');
const draw = materializeThreeSpriteDraw(emitter.program, emitter.kernels);
scene.add(draw);

renderer.setAnimationLoop(async () => {
  await system.update(); // 引数省略で実時間デルタ(上限0.25s)
  if (instance.state === 'complete') {
    scene.remove(draw);
    disposeThreeDraw(emitter.kernels, draw, renderer);
    instance.release();
    renderer.setAnimationLoop(null);
    return;
  }
  renderer.render(scene, camera);
});
```

## 規模の決め方（詳細は effect-recipes.md）

| 規模 | 例 | 構成 | 使うパッケージ |
|---|---|---|---|
| S: ヒットスパーク・被弾 | 火花+閃光 | エミッタ 1–3、timeline 不要 | core + three |
| M: 通常スキル | ヒール・バリア | 単一 `defineEffect` に 8–15 要素 + timeline | + timeline, mesh-fx, post |
| L: 大技 | 斬撃・ビーム | 20 要素前後、複数システム、トレイル | + trails、二系統 VFXSystem |
| XL: 必殺技 | 多段攻撃・全画面 | 30–40 要素をコードで量産、カスタム TSL | + tslModule、要素の map 生成 |

## 落とし穴トップ 7（全リストは library-usage.md）

1. **spawn しても何も表示されない**: draw の materialize と `scene.add` は手動。
   billboard→`materializeThreeSpriteDraw` / mesh→`...MeshDraw` / light→`...LightDraw` /
   decal→`...DecalDraw` / ribbon→`materializeThreeRibbonDraw`（`@nachi-vfx/trails/three`）。
2. **`system.update()` は Promise**。必ず `await` してから `renderer.render`。
3. **テクスチャは直接渡さない**: モジュール config には
   `{ kind: 'asset-ref', assetType: 'texture', uri: '...' }`（`TextureRef`）を書き、
   実テクスチャは materialize 時の `{ resolveTexture: createThreeTextureResolver(map) }` で解決。
4. **trails / ribbon はレジストリ登録が必要**:
   `new VFXSystem(rr, scene, { registry: registerTrails(createCoreKernelModuleRegistry()) })`。
   WebGPU 専用。
5. **カメラ同期**: ソート・soft・距離カリング・collideSceneDepth を使うなら
   `system.setCamera({ viewMatrix, projectionMatrix, viewportSize })` を更新すること
   （R3F では `VFXSystemProvider` が自動で行う）。
6. **timeline 付きエフェクトは `@nachi-vfx/timeline` の `defineEffect` と `VFXSystem`** を使う
   （core の同名 API は timeline アクションを実行しない）。両方使うときは
   `import { VFXSystem as CoreVFXSystem } from '@nachi-vfx/core'` と別名にする。
7. **乱数は `seed` と `range()` で決定論的**。`Math.random()` をエフェクト定義に混ぜない。

## このリポジトリ（nachi 本体）で作業する場合

- 完成見本: `apps/showcase/src/` の `heal.ts`（最小・最良の入門）、`slash.ts`（トレイル）、
  `beam.ts`（複数システム連携）、`machina.ts` / `ice.ts`（要素量産・カスタム TSL）。
- 検証: `pnpm dev` を起動してから
  `node tools/spike-runner.mjs http://127.0.0.1:5173/<page>/?backend=webgpu`。
  ヘッドレス WebGPU はキャンバス提示不可（compute/readback のみ）。
  スクリーンショットは `--backend webgl`。
