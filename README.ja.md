# nachi

> Language: [English](./README.md) / 日本語 (このページ)

> [!WARNING]
> **HEAVY EXPERIMENTAL — v0.1.0は本番利用できる段階ではありません。** API、挙動、性能、互換性、
> パッケージ境界はリリース間で大きく変わる可能性があります。

Three.js向けのコードファーストかつTSL/WebGPUネイティブなVFXライブラリで、Niagaraのステージ型シミュレーションモデルを基に設計されています。
Nachi v0.1.0は実験的なプレビューです。M12ではJSONアセット、高度なシミュレーション、React Three
Fiberバインディング、リリース自動化、ビルド可能なドキュメントギャラリーが含まれています。

## パッケージ

| パッケージ         | 用途                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@nachi/core`     | 定義、パーティクルモジュール、コンパイラ、GPUスケジューラ、スケーラビリティ、シミュレーションキャッシュ、デバッガ、Grid2D/3D、近傍グリッド |
| `@nachi/three`    | Three.js WebGPUカーネル／ランタイムアダプター、リソースリゾルバー、パーティクル描画マテリアライザー                       |
| `@nachi/format`   | 厳密な`nachi-effect` v1 JSONスキーマ、シリアライザー／ローダー、マイグレーション、アセット継承                             |
| `@nachi/react`    | 薄いR3Fプロバイダー、フック、コンポーネントライフサイクル、`Object3D`アタッチメント                                       |
| `@nachi/timeline` | エフェクトローカルなシーケンシング、カメラシェイク、ヒットストップ、マーカー、mesh-fxライフサイクル                        |
| `@nachi/trails`   | GPUリボンとトレイル                                                                                                        |
| `@nachi/mesh-fx`  | プロシージャルなエフェクトジオメトリ、`fxMaterial`、Blender VAT再生                                                        |
| `@nachi/post`     | RenderPipelineのディストーション、放射状ブラー、ブルームプリセット、WebGPU WBOIT                                          |
| `@nachi/tsl-kit`  | スタンドアロンのThree.js TSLシェーダービルディングブロック                                                                |

このリポジトリには、Viteベースの[プレイグラウンド](./apps/playground)と静的な
[ドキュメントサイト](./apps/docs)も含まれています。

## コントリビューション

バグ報告、機能要望、詳細なユースケースのフィードバックはGitHub Issuesで歓迎します。外部からのPull
Requestは受け付けず、採用した変更はメンテナーが実装・レビューします。Issueで実質的に貢献した方には、
希望に応じてCo-author creditを付与します。詳細は[CONTRIBUTING.ja.md](./CONTRIBUTING.ja.md)を参照して
ください。脆弱性は[SECURITY.md](./SECURITY.md)に従って非公開で報告してください。

## インストール

Three.jsのコア機能を利用する場合:

```sh
pnpm add @nachi/core @nachi/three three@0.185.1
```

React Three Fiberを利用する場合は、React、R3F、Threeをピア依存として維持します:

```sh
pnpm add @nachi/core @nachi/three @nachi/react react@^19 @react-three/fiber@^9 three@0.185.1
```

Three.jsの型を公開するパッケージ(`@nachi/three`、`@nachi/tsl-kit`、`@nachi/mesh-fx`、`@nachi/trails`、
`@nachi/timeline`、`@nachi/post`、`@nachi/react`)は、TypeScriptプロジェクトにおいて別途公開されている
対応する型定義も必要とします:

```sh
pnpm add -D @types/three@0.185.0
```

`three@0.185.1`がサポートおよびテスト対象のランタイムです。これらの連携パッケージを異なるThreeの
マイナーバージョンに合わせて重複排除(dedupe)しないでください。

`VFXSystemProvider`はデフォルトで、各更新の前にアクティブなR3Fカメラとピクセルビューポートをコアと
同期します。アプリケーション自身が`system.setCamera()`を呼び出す場合にのみ、`syncCamera={false}`を
指定してください。

## クイックスタート

```ts
import {
  VFXSystem,
  billboard,
  burst,
  defineEffect,
  defineEmitter,
  drag,
  gravity,
  lifetime,
  positionSphere,
} from '@nachi/core';
import {
  createThreeKernelAdapter,
  createThreeRuntimeRenderer,
  materializeThreeSpriteDraw,
} from '@nachi/three';
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.append(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1, 5);

const kernelAdapter = createThreeKernelAdapter({ backend: 'webgpu' });
const runtimeRenderer = createThreeRuntimeRenderer(renderer, kernelAdapter);

const sparks = defineEmitter({
  capacity: 512,
  spawn: burst({ count: 120 }),
  init: [positionSphere({ radius: 0.2 }), lifetime(0.8)],
  update: [gravity(-9.8), drag(0.35)],
  render: billboard({ blending: 'additive' }),
});

const effect = defineEffect({ elements: { sparks } });
const system = new VFXSystem(runtimeRenderer, scene);
const instance = system.spawn(effect, { position: [0, 1, 0], seed: 42 });
const emitter = instance.getEmitter('sparks');
if (!emitter) throw new Error('The sparks emitter was not created.');

const draw = materializeThreeSpriteDraw(emitter.program, emitter.kernels);
scene.add(draw);

let previousTime = performance.now();
async function frame(time: number) {
  const deltaSeconds = Math.min((time - previousTime) / 1000, 0.1);
  previousTime = time;
  await system.update(deltaSeconds);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// When the effect is no longer needed:
// scene.remove(draw); instance.release(); draw.geometry.dispose(); draw.material.dispose();
```

R3Fでは、同じアダプターを一度だけ作成し、インスタンスのクリーンアップはバインディングに任せます。完全な
マテリアライズの例は[`@nachi/react`](./packages/react/README.md)にあります。

`useEffectInstance()`はフック形式です。ライブな`parameters`、トランスフォーム、タイムスケール、
アタッチメントはコアに転送されます。seedまたはpriorityを変更すると新しいインスタンスが生成されます。
`definition`はモジュールスコープに置く(もしくは参照的に安定した状態を保つ)必要があります。参照が
変わるとインスタンスが再生成されるためです。`attachTo`はライブトランスフォーム全体を所有し、
スケジュールされた各ステップでspawn/propの位置と回転を上書きします。

## アセットと高度なシミュレーション

```ts
import { loadEffect, serializeEffect } from '@nachi/format';

const document = serializeEffect(effect);
const loaded = loadEffect(JSON.stringify(document));
```

シリアライズ可能なのは宣言的なサブセットのみです。インラインコールバック、関数、ライブなThree.js
リソース、クラスインスタンス、循環参照は、パス固有の`NACHI_ASSET_*`診断で失敗します。Grid2D/3D
ステージ、近傍グリッド宣言、組み込みの流体ステージ、boids、PBD制約はv1の宣言的モデルの一部です。
インラインのカスタムグリッド/近傍TSLはコードのみでの利用にとどまります。

シミュレーションキャッシュは`bakeSimulation()`と`replaySimulation()`を使用します。ランタイムの
デバッグには`instance.debug.captureAttributes()`と`system.debug.captureProfile()`を使用します。

Threeの描画オブジェクトは、そのエミッターカーネルにライフタイムが紐付いています。既存のマテリアライズ
済みメッシュを再利用するか、置き換える前にdispose/unmaterializeしてください。インスタンスを解放すると、
そのカーネルがプールに戻る前に登録済みの描画がクリーンアップされるため、再spawn時には新しく
マテリアライズされた描画をアタッチする必要があります。

## 開発とリリースチェック

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
pnpm docs:build
pnpm esm-all
pnpm release:dry  # build + every package ESM import gate + publish-shaped pnpm pack checks
pnpm golden:regress  # with the playground dev server running; headless SwiftShader golden suite
node tools/bundle-size.mjs
node tools/license-report.mjs
```

BiomeはJavaScript、TypeScript、JSON、CSS、HTMLのlintとformatを担当します。MarkdownとYAMLは
自動整形の対象外です。

Changesetsは独立してバージョニングされます。`pnpm changeset`を実行し、リリースのバージョニングを
行う場合は`pnpm version-packages`を実行してください。`release:dry`は公開(publish)を一切行いません。

設計と状況: [PLAN.md](./PLAN.md)、[ROADMAP.md](./ROADMAP.md)、規範的な
[API RFC](./docs/rfc/001-api.md)、および
[Effekseer互換性調査](./docs/rfc/002-effekseer-compatibility.md)。リリース互換性は
[RFC 003](./docs/rfc/003-versioning.md)で定義されています。FAのエビデンスは、
[パリティ](./docs/parity-report.md)、[バンドル](./docs/bundle-report.md)、
[ライセンス](./docs/license-report.md)の各レポートにまとめられています。
