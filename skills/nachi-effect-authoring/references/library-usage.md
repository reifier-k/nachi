# @nachi-vfx ライブラリ使用法カタログ

対象バージョン: v0.2.2（全 9 パッケージは fixed group で同一バージョン）。
全パッケージ ESM のみ。Three.js は **0.185.1 固定**（`@types/three@0.185.0`）。

パッケージ一覧と役割:

| パッケージ | 役割 |
|---|---|
| `@nachi-vfx/core` | 定義 API・コンパイラ・パーティクルランタイム（`VFXSystem`）。Three 非依存 |
| `@nachi-vfx/three` | Three.js WebGPU アダプタと draw materializer。core と必ずペアで使う |
| `@nachi-vfx/timeline` | 振り付け（`timeline`/`at`/`play`）、ヒットストップ、カメラシェイク、mesh-fx 要素のライフサイクル |
| `@nachi-vfx/mesh-fx` | 手続きメッシュ（斬撃アーク・リング・円筒・魔法陣）+ `fxMaterial` + VAT |
| `@nachi-vfx/trails` | リボン/トレイルのレンダーモジュール（WebGPU 専用） |
| `@nachi-vfx/post` | ブルーム・画面歪み・ラジアルブラー・WBOIT |
| `@nachi-vfx/tsl-kit` | 素の TSL ノード部品（dissolve/fresnel/uvFlow 等）。単体利用可 |
| `@nachi-vfx/format` | `nachi-effect` JSON のシリアライズ/ロード |
| `@nachi-vfx/react` | R3F バインディング（ライフサイクルのみ） |

---

## 1. ブートストラップ（core + three）

```ts
import { VFXSystem, createCoreKernelModuleRegistry } from '@nachi-vfx/core';
import { createThreeKernelAdapter, createThreeRuntimeRenderer } from '@nachi-vfx/three';
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();

const adapter = createThreeKernelAdapter({ backend: 'webgpu' }); // 'webgl' でフォールバック
const runtimeRenderer = createThreeRuntimeRenderer(renderer, adapter);

// trails 等の拡張レンダーモジュールを使う場合のみ registry を渡す
const system = new VFXSystem(runtimeRenderer, scene, {
  // registry: registerTrails(createCoreKernelModuleRegistry()),
  // qualityTier: 'auto' | 'low' | 'medium' | 'high' | 'epic'(既定),
  // fixedTimeStep: { stepSeconds: 1 / 60, maxSubSteps: 4 },
  // significanceBudget: { maxActiveInstances, maxParticles },
});
```

毎フレーム:

```ts
await system.update(deltaSeconds); // 省略時は実測デルタ(上限 0.25s)。Promise を必ず await
renderer.render(scene, camera);
```

カメラ依存機能（ソート・soft・距離/フラスタムカリング・collideSceneDepth）を使うなら
カメラ/ビューポート変更時に:

```ts
system.setCamera({
  viewMatrix: camera.matrixWorldInverse.elements,
  projectionMatrix: camera.projectionMatrix.elements,
  viewportSize: [width, height],
});
```

ロード画面での事前コンパイル: `await system.prepare(effect)`（`maxPoolSize > 0` が条件）。
Three 側のシェーダ事前コンパイルは `createThreeEffectPreparer(renderer, scene, camera)`。

### spawn と draw の materialize（最重要）

`system.spawn()` はシーンに何も追加しない。エミッタごとに draw を作って自分で add する:

```ts
const instance = system.spawn(effect, {
  position: [0, 1, 0],       // 省略可
  rotation: [0, 0, 0, 1],    // クォータニオン、省略可
  seed: 42,                  // 決定論的乱数のシード
  parameters: { 'User.power': 2 },
  timeScale: 1,
  priority: 0,               // significance 用
});

const view = instance.getEmitter('sparks'); // VfxEmitterRuntimeView
const draw = materializeThreeSpriteDraw(view.program, view.kernels, 0, {
  resolveTexture,            // TextureRef を使う場合のみ
  // renderOrder: 1000,      // ホスト側描画順ベース
});
scene.add(draw);
```

materializer の対応表（すべて `@nachi-vfx/three`、ribbon のみ `@nachi-vfx/trails/three`）:

| render モジュール | materializer |
|---|---|
| `billboard` / `faceCamera` | `materializeThreeSpriteDraw(program, kernels, drawIndex?, opts?)` |
| `meshRenderer` | `materializeThreeMeshDraw(...)`（`resolveGeometry` が必要） |
| `lightRenderer` | `materializeThreeLightDraw(...)` |
| `decalRenderer` | `materializeThreeDecalDraw(...)` |
| `ribbon`（trails） | `materializeThreeRibbonDraw(program, kernels, drawIndex?, opts?)` |

破棄: `scene.remove(draw)` → `disposeThreeDraw(view.kernels, draw, renderer)` →
`instance.release()`。draw はエミッタカーネルに寿命が紐づくため、release 前に処理する。

### アセット参照（テクスチャ / ジオメトリ）

モジュール config はシリアライズ可能な純データなので、実リソースではなく参照を書く:

```ts
const GLOW_REF: TextureRef = { kind: 'asset-ref', assetType: 'texture', uri: 'fx://glow' };
// 定義側: billboard({ map: GLOW_REF })
// 実行側: materialize 時に解決
const resolveTexture = createThreeTextureResolver(new Map([[GLOW_REF.uri, glowTexture]]));
```

ジオメトリも同様に `GeometryRef` + `createThreeGeometryResolver`。

### インスタンスのライフサイクル

`instance.state`: `'active' | 'complete' | 'error' | 'released' | 'stopped'`。
単発エフェクトは update 後に `state === 'complete'` を検知して release する。
そのほか: `setParameter(path, value)`（`User.*` のみ）、`setTransform(pos, rot?)`、
`setTimeScale(n)`、`attachTo(source)` / `detach()`（`createThreeTransformSource(object3d)` で
Three の Object3D に追従）、`on('death', cb)`、`stop()`、`release()`、
`instance.scalability`（カリング状態）、`instance.debug.captureAttributes()`。

---

## 2. エミッタ定義の解剖（core）

```ts
defineEmitter({
  capacity: 512,                 // 必須。最大パーティクル数（上限 2^22）
  spawn: burst({ count: 80 }),   // 必須。単体または配列
  render: billboard({ ... }),    // 必須。単体または配列
  init: [...],                   // スポーン時に 1 回
  update: [...],                 // 毎フレーム
  events: { onDeath: emitTo('smoke', { inherit: ['position', 'velocity'] }) },
  lifecycle: { duration: 1.2, loopCount: 1, prewarm: 0, startDelay: 0 },
  integration: 'euler',          // 'euler'(velocity→position 積分) | 'none'
  attributes: { myAttr: attribute('myAttr', { type: 'f32', default: 0 }) },
  parameters: { 'User.power': defineParameter('User.power', { type: 'f32', default: 1, mutable: true }) },
  offset: [0, 0.5, 0],
  bounds: { radius: 3 },         // カリング境界
  quality: { low: { capacityScale: 0.4, features: { sorted: false } } },
})
```

継承: `defineEmitter(base, overrides)`。エフェクト合成: `defineEffect({ elements, parameters?, scalability? })`。

### 値ジェネレータ（数値を書ける場所ならどこでも使える）

- `range(min, max)` — パーティクルごとの一様乱数（シード決定論的）
- `curve([t0, v0], [t1, v1], ...)` — 正規化寿命 0–1 上のカーブ（LUT にベイク）
- `gradient('#ffd27d', '#ff5a00', '#00000000')` — 色グラデーション。**末尾 2 桁で α**（フェードアウトは `'#rrggbb00'`）
- `parameter('User.power', fallback?)` — パラメータ参照

### spawn モジュール

| モジュール | 説明 |
|---|---|
| `burst({ count, cycles?, interval? })` | 一斉放出。`cycles`/`interval` で多段バースト |
| `rate(n)` または `rate({ rate: n })` | 毎秒 n 個の連続放出 |
| `perDistance(n)` | 移動 1 ワールド単位あたり n 個（トレイル用） |

### init モジュール

| モジュール | 主なオプション |
|---|---|
| `positionSphere` | `{ radius, center?, surfaceOnly?, arc?: { thetaMax, axis? } }` |
| `positionMeshSurface` | メッシュ表面スポーン（`MeshRef` + resolver） |
| `velocityCone` | `{ direction: Vec3, angle, speed, space?: 'emitter'\|'world' }` |
| `velocityMeshNormal` | メッシュ法線方向の初速 |
| `lifetime(value)` | 寿命秒。`range()` 可 |
| `lightIntensity(value)` | `lightRenderer` 用の光強度 |

### update モジュール

力場: `gravity(-9.8 | [x,y,z])`, `drag(0.5)`, `curlNoise({ frequency, strength })`,
`vortex({ axis, strength, center?, inwardStrength? })`, `pointAttractor({ position, strength, falloff?, radius? })`,
`linearForce({ force })`, `turbulence({ frequency, strength, octaves? })`, `vectorField(...)`,
`boids(...)` / `pbdDistanceConstraint(...)`（NeighborGrid 必須）。

寿命駆動: `sizeOverLife(curve)`, `intensityOverLife(curve)`, `rotationOverLife(curve)`,
`velocityOverLife(curve)`, `colorOverLife(gradient)`, `orientToVelocity()`。

衝突/削除: `collidePlane` / `collideSphere` / `collideBox`（`{ mode: 'bounce'|'kill'|'stick', ... }`）,
`collideSceneDepth()`（カメラ必須）, `collideSdf(...)`, `killVolume(...)`。

カスタム TSL（エスケープハッチ）:

```ts
tslModule(({ position, velocity, age }) => ({
  velocity: velocity.add(myField(position)),
}))
```

再利用するなら `defineTslFunction(id, factory, version?)` で登録型にする。

### render モジュール

`billboard(options)`:

```ts
billboard({
  blending: 'additive' | 'alpha' | 'multiply' | 'premultiplied', // 既定 'alpha'
  alignment: { mode: 'camera-facing' }                    // 既定
           | { mode: 'velocity-aligned' }
           | { mode: 'velocity-stretch', factor? }        // 火花に最適
           | { mode: 'custom-axis', axis },
  map: TEXTURE_REF | flipbook(TEXTURE_REF, { cols, rows, interpolate?, motionVectors? }),
  soft: true | { fadeDistance },   // シーン深度フェード
  lit: true | { normalMap, roughness, metalness }, // 物理ライティング（normalMap は NoColorSpace）
  sorted: true,                    // alpha/premultiplied の既定。WebGPU 専用
  sortCenter: [0, 0, 0],
  renderOrderOffset: 0,
  cutout: { vertices: 4..8 },      // オーバードロー削減
})
```

`faceCamera(opts?)` は camera-facing のプリセット。
`meshRenderer({ geometry: GeometryRef, alignment?: none|velocity|quaternion|custom-axis, ... })`。
`lightRenderer({ maxLights?: 8, radiusScale?: 1, priority? })` — 点光源パーティクル。閃光に使う。
`decalRenderer({ map?, sizeScale?, fadeOverLife?: true, blending? })` — 接地痕・焦げ跡。

### パラメータ

名前空間 `User.* / Emitter.* / Particles.* / System.*`。実行時に書けるのは `User.*` のみ。
型: `'f32' | 'i32' | 'u32' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'quat' | 'mat3' | 'mat4'`。

```ts
parameters: { 'User.charge': defineParameter('User.charge', { type: 'f32', default: 0, mutable: true }) }
// モジュール内で: sizeOverLife(...) の値などに parameter('User.charge')
// 実行時: instance.setParameter('User.charge', 0.8)
```

子エミッタの `User.*` はエフェクトレベルに自動合成される（型/既定値の衝突はエラー）。

### ライフサイクルと品質

- `lifecycle.duration` 省略時: rate/perDistance エミッタは無限ループ、burst のみのエミッタは
  バースト完了+寿命猶予で自動的に有限になる。ループには正の `duration` が必須。
- `loopCount: n | 'infinite'`、`prewarm`（事前シミュレーション秒）、`startDelay`。
- 品質: システム `qualityTier`（`'auto'` でデバイス推定）。low/medium は sorted/lit/soft が
  自動でオフになる。エミッタ `quality.{tier}.capacityScale / spawnRateScale / features` で調整。
  実行中の `setQualityTier()` は構造変更が必要なとき `NACHI_QUALITY_RESTART_REQUIRED` を発行。
- `scalability: { culling: { distance: { fadeEnd, fadeStart? }, frustum? }, significance: { priority? } }`
  をエフェクトに宣言すると距離フェード/カリング（完全カリング中はローカル時間と GPU シミュレーションが停止）。

---

## 3. timeline（振り付け・ヒットストップ・カメラシェイク）

timeline 付きエフェクトは **timeline パッケージの** `defineEffect` / `VFXSystem` を使う:

```ts
import {
  VFXSystem, at, cameraShake, defineEffect, fxMaterial, hitStop,
  marker, meshFxElement, play, stop, timeline,
} from '@nachi-vfx/timeline';

const effect = defineEffect({
  elements: {
    circle: meshFxElement(circleMesh, { duration: 1.2 }), // mesh-fx メッシュを要素化
    flash: flashEmitter,                                   // core エミッタもそのまま要素になる
    sparks: sparkEmitter,
  },
  timeline: timeline([
    at(0.0, play('circle'), marker('charge')),
    at(0.5, play('flash'), cameraShake({ strength: 0.5, duration: 0.42, frequency: 30 }),
            hitStop(40 /* durationMs, 第2引数 timeScale は既定 0 */)),
    at(0.55, play('sparks')),
  ], { duration: 2.0, loop: false /* , speed */ }),
});

const system = new VFXSystem(runtimeRenderer, scene, {
  registry,
  cameraShakeTarget: (sample) => { latestShake = sample; }, // カメラに手動適用
});
```

- アクション: `play(key)` / `stop(key)` / `marker(name)` / `hitStop(durationMs, timeScale?)` /
  `cameraShake({ strength, duration?, frequency? })`。
- timeline の `fxMaterial` は mesh-fx 版のラッパで、`opacityOverLife` と
  `dissolve.overLife`（curve）を要素のローカル寿命に自動バインドする。`time` は timeline が
  所有するので渡さない。
- mesh-fx 要素の draw は timeline VFXSystem が管理する（エミッタの draw materialize は引き続き手動）。
- ヒットストップの手動発火: `instance.applyHitStop(...)`（デバッグパネル参照）。
- core の `VFXSystem` と併用する場合は `import { VFXSystem as CoreVFXSystem } from '@nachi-vfx/core'`。

## 4. mesh-fx（手続きメッシュ + fxMaterial + VAT）

```ts
import { cone, cylinder, fxMaterial, magicCircle, polarUV, ring, slashArc, uvFlow } from '@nachi-vfx/mesh-fx';

const crescent = slashArc({
  angle: 140, radius: 1.6, innerRadius: 0.9, taper: 0.35, rotation: 0.4,
  material: fxMaterial({
    blending: 'additive',
    map: bladeTexture,                       // mesh-fx は実 Three テクスチャを直接受ける
    uv: polarUV().flow({ speed: [2, 0] }),   // または uvFlow({ speed: [x, y] })
    dissolve: {
      texture: noiseTexture,
      overLife: curve([0, 0], [1, 1]),       // timeline 版 fxMaterial なら寿命駆動
      edgeColor: '#66ddff', edgeWidth: 0.08, edgeIntensity: 2,
    },
    fresnel: { color: '#66ddff', power: 2 },
    opacity: 1, depthWrite: false,
  }),
});
```

- ジオメトリ: `slashArc`（斬撃）, `ring`（衝撃波/魔法陣の輪）, `cylinder`（ビーム/光柱）,
  `cone`, `magicCircle`（同心魔法陣）。各 `MeshFxMesh` を `meshFxElement(mesh, { duration })` で
  timeline 要素にする。
- 戻り値マテリアルの `.fx` に `setOpacity / setTime / setNormalizedLife` があり、
  timeline を使わないページ駆動アニメにも使える。
- VAT: `applyVat(mesh, { positionTexture, frameCount, fps, normalTexture?, loop?, ... })` →
  `controls.setTime / setFrame`。

## 5. trails（リボン/トレイル、WebGPU 専用）

```ts
import { registerTrails, ribbon, ribbonId, ribbonIdAttribute } from '@nachi-vfx/trails';
import { materializeThreeRibbonDraw } from '@nachi-vfx/trails/three';
import { createCoreKernelModuleRegistry } from '@nachi-vfx/core';

const registry = registerTrails(createCoreKernelModuleRegistry());
const system = new VFXSystem(runtimeRenderer, scene, { registry });

const trail = defineEmitter({
  capacity: 512,
  attributes: { ribbonId: ribbonIdAttribute() },
  spawn: perDistance(22),                       // 移動距離ベースのスポーンが定石
  init: [lifetime(0.3), ribbonId(0)],           // 複数本: ribbonId({ mode: 'alternating', count: n })
  update: [colorOverLife(gradient('#f4feff', '#7ce4ff', '#3a4cff00'))],
  render: ribbon({
    width: 0.24, taper: { start: 0.15, end: 0.25 },
    uv: { mode: 'stretched' },                  // または { mode: 'tiled', tileLength }
    blending: 'additive', maxRibbons: 1,        // 1–64
  }),
});
// draw: materializeThreeRibbonDraw(view.program, view.kernels, 0, opts)
```

エミッタを動かす（`instance.attachTo(socket)` + ソケットを剣先軌道で動かす）ことで軌跡が伸びる。

## 6. post（ブルーム・画面歪み・ラジアルブラー）

```ts
import { bloomPreset, createPostPipeline, radialBlur, screenDistortion } from '@nachi-vfx/post';

const post = createPostPipeline(renderer, scene, camera, {
  bloom: bloomPreset('intense', { radius: 0.62, strength: 0.85, threshold: 0.5 }),
  distortion: screenDistortion({ shockwaves: [{ center, radius, ringWidth, strength, speed, startTime }] }),
  // radialBlur: radialBlur({ center, strength, samples }),
});
await post.prepare();          // 初回ヒッチ防止
// 毎フレーム: renderer.render の代わりに post.render()
// 実行時制御: post.controls.setTime(t) / setShockwave(i, source) / setHeatHaze(i, region)
```

- ショーケース標準のルック: `bloomPreset('intense', { radius: 0.62, strength: 0.85, threshold: 0.5 })`
  + `renderer.toneMapping = THREE.ACESFilmicToneMapping`。
- 衝撃波の center は**スクリーン空間**。ワールド座標から毎フレーム再投影して
  `controls.setShockwave` する（ショーケースの `post-target.ts` の `worldShockwave` /
  `updateWorldShockwaves` パターン）。
- WBOIT は別経路（`createWboitPipeline` / `createWboitOutput` を `mrtNode` へ）。ソートと通常は択一。

## 7. tsl-kit（素の TSL ノード部品）

独自 NodeMaterial を組むときに使う: `dissolve({ noiseTexture, threshold, edgeWidth?, edgeColor? })`
（`.rgb` をエッジ発光、`.a` を `opacityNode` + `alphaTest` に）、`fresnel({ color?, power? })`、
`rimLight({ baseColor, ... })`、`uvFlow({ speed, time })`、`polarUV({ center?, rotation? })`、
`distortionUV({ noiseTexture, strength, time })`、`flowMap({ flowTexture, map, time })`。

注意: `uvFlow` / `polarUV` / `fxMaterial` は mesh-fx（オーサリング記述子）と
tsl-kit / timeline（TSL ノード / ラッパ）で同名別物。import 元を混同しない。

## 8. format（JSON シリアライズ）

```ts
import { loadEffect, serializeEffect, validateEffectAsset } from '@nachi-vfx/format';
import { bindMeshFxResources } from '@nachi-vfx/timeline';

const doc = serializeEffect(effect);       // { format: 'nachi-effect', version: 2, effect }
const loaded = loadEffect(JSON.stringify(doc)); // v1 文書は自動マイグレーション
bindMeshFxResources(loaded, ({ resource }) => meshMap.get(resource)?.mesh); // mesh-fx 再結合
```

インライン関数・実 Three リソースはシリアライズ不可（`NACHI_ASSET_*` 診断で失敗）。
エミッタ継承アセットは `resolveAsset`、grid ステージ関数は registry オプションで解決。

## 9. react（R3F バインディング）

```tsx
import { VFXSystemProvider, VFXEffect, useEffectInstance, useVFXSystem } from '@nachi-vfx/react';

<Canvas gl={threeRenderer} camera={{ position: [0, 1, 5] }}>
  <VFXSystemProvider renderer={runtimeRenderer} /* options={...} は参照安定に */>
    <MyEffect />
  </VFXSystemProvider>
</Canvas>

// フック（マウントで spawn、アンマウントで release）
const instance = useEffectInstance(effect, { position: [0, 1, 0], seed: 42, attachTo: object3d });
```

- `definition` はモジュールスコープに置く（参照が変わると respawn）。
- `seed` / `priority` は spawn 専用（変更で作り直し）。`parameters` / transform / `timeScale` /
  `attachTo` はライブ転送。
- draw の materialize と scene への追加は React でも手動（useEffect でやる。パッケージ README 参照）。
- カメラ同期は Provider が自動（`syncCamera={false}` で手動化）。

---

## 10. 落とし穴チェックリスト（全部）

1. draw の materialize + `scene.add` は手動（SKILL.md #1）。release 前に `disposeThreeDraw`。
2. `system.update()` は Promise。await を忘れない。
3. テクスチャ/ジオメトリは `AssetRef` + resolver（mesh-fx の `fxMaterial` だけは実テクスチャ直渡し）。
4. trails は registry 登録 + WebGPU 専用。post / grid / neighbor-grid / ソートも WebGPU 専用。
5. timeline 使用時は timeline パッケージの `defineEffect` / `VFXSystem`。
6. `Math.random()` 禁止。`range()` + spawn `seed` で決定論的に。
7. Three は 0.185.1 固定。`three/webgpu` から import（`three` 素の import と混ぜない）。
8. `gradient` の透明終端は 8 桁 hex（`'#ff3a1000'`）。
9. ループには `lifecycle.duration` 必須。単発完了は `instance.state === 'complete'` で検知。
10. low/medium 品質では sorted/lit/soft が落ちる。品質依存のルックは high/epic 前提と明記する。
11. WebGL2 フォールバックは機能制限が大きい（パックストレージ group≥1 は build エラー、
    リボン/ポスト/グリッド不可）。WebGL2 対応が要件なら group-0 のみの単純エミッタに留める。
12. `lit` の normalMap は `NoColorSpace` 必須。
13. カスタム属性はエミッタ `attributes` で宣言してから init/update で書く。
14. `attachTo` は位置/回転を毎ステップ上書きする（スケールは転送されない）。
