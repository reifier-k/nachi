# RFC 004: モジュールの座標空間

> Language: [English](./004-module-spaces.md) / 日本語 (このページ)

- **状態:** 提案中。既定空間の裁定は承認済み、実装はH1-5
- **対象:** `@nachi/core` のエミッターモジュールと `@nachi/format` の互換正規化
- **規範的参照:** [RFC 001](./001-api.ja.md) §4.3、§9、[RFC 003](./003-versioning.ja.md) §2-4
- **裁定日:** 2026-07-13

## 1. 一覧の抽出方法

この一覧はヘルパー名だけでなく実装から抽出した。`packages/core/src/types.ts`、`grid2d.ts`、
`grid3d.ts` の `position`、`center`、`axis`、`normal`、`direction`、`origin`、field boundsを列挙し、
`packages/core/src/compiler.ts`、`system.ts`、Threeレンダラーの具現化コードにある全消費点を照合した。
作者向け座標を持たなくてもworld-spaceのパーティクル位置を暗黙に消費するもの
(`collideSdf`、light、decal、scene depth)は、裁定の制約となる固定フレームなので表に残す。

## 2. 現行の空間一覧(H1-5実施前)

「固定」は `space` セレクタがなく、変更対象となる省略時既定もないことを意味する。シミュレーション中の
パーティクル位置と速度は一貫してworld-spaceへ格納される。

| API / モジュール                              | 空間入力または消費点                             | 省略時の現行空間                                                  | `space` 指定可否        | H1-5の既定変更                      |
| --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ----------------------- | ----------------------------------- |
| `EmitterConfig.offset`                        | エミッター要素原点の平行移動                     | emitter-local固定。`instanceTransform * translate(offset)` で合成 | 不可                    | なし(H1-4で追加)                    |
| `EmitterBounds.center`                        | culling/significance用の保守的球中心             | emitter-local固定                                                 | 不可                    | なし                                |
| `positionSphere`                              | `center`、`arc.axis`、表面の球冠/内部の球分      | emitter-local固定。結果を一度だけworldへ変換                      | 不可                    | なし(center/arcはH1-4で追加)        |
| `positionMeshSurface`                         | メッシュ頂点とサンプル法線                       | mesh/emitter-local固定。一度だけworldへ変換                       | 不可                    | なし                                |
| `velocityCone`                                | `direction`                                      | world-space方向固定                                               | 不可                    | なし。将来のセレクタは別作業        |
| `vortex`                                      | `center`、`axis`                                 | **world**                                                         | 可: `world` / `emitter` | **省略時既定を`emitter`へ変更**     |
| `pointAttractor`                              | `position`(および距離/radius評価)                | **world**                                                         | 可: `world` / `emitter` | **省略時既定を`emitter`へ変更**     |
| `turbulence`、`curlNoise`                     | 手続き的fieldの暗黙サンプル位置                  | world-space粒子位置固定                                           | 不可                    | なし。将来のセレクタは別作業        |
| `vectorField`                                 | field boundsと暗黙サンプル位置                   | field/world座標固定                                               | 不可                    | なし。将来のfield transformは別作業 |
| `collidePlane`                                | `normal`、`offset`                               | **world**                                                         | 可: `world` / `emitter` | **省略時既定を`emitter`へ変更**     |
| `collideSphere`                               | `center`、`radius`                               | **world**                                                         | 可: `world` / `emitter` | **省略時既定を`emitter`へ変更**     |
| `collideBox`                                  | `center`、`size`                                 | **world**                                                         | 可: `world` / `emitter` | **省略時既定を`emitter`へ変更**     |
| `collideSceneDepth`                           | 粒子位置、camera行列、copy済みdepth              | world/view/screen pipeline固定                                    | 不可                    | なし。本質的にcamera/worldへ結合    |
| `collideSdf`                                  | SDF boundsと暗黙サンプル位置                     | field/world座標固定                                               | 不可                    | なし。将来のfield transformは別作業 |
| `killVolume`                                  | `center`、planeの`normal`/`offset`、shape寸法    | emitter-local固定                                                 | 不可                    | なし                                |
| `billboard` custom-axis alignment             | `alignment.axis`                                 | world-space方向固定(viewへ変換)                                   | 不可                    | なし                                |
| `billboard.sortCenter`                        | 粗い透明sort中心                                 | emitter-local固定                                                 | 不可                    | なし                                |
| `meshRenderer` custom-axis alignment          | `alignment.axis`                                 | world-space方向固定                                               | 不可                    | なし                                |
| `meshRenderer.sortCenter`                     | 粗い透明sort中心                                 | emitter-local固定                                                 | 不可                    | なし                                |
| `lightRenderer`                               | 暗黙の`Particles.position`                       | world-space粒子位置固定                                           | 不可                    | なし                                |
| `decalRenderer`                               | 暗黙の`Particles.position`/rotationとscene depth | world-space projection box固定                                    | 不可                    | なし。本質的にworld/depthへ結合     |
| `emitTo(..., { inherit: ['position', ...] })` | event payloadのposition/velocity                 | world-space粒子snapshot固定                                       | 不可                    | なし                                |
| `NeighborGrid` / `boids` / PBD                | gridの`origin`、粒子位置                         | world-space grid固定                                              | 不可                    | なし                                |
| `gridInject`、`grid3DInject`                  | `center`                                         | emitter frameと独立した正規化Grid2D/Grid3D座標固定                | 不可                    | なし                                |

## 3. 問題

現在は座標フィールド名から作成規則を予測できない。`positionSphere` のcenterと `killVolume` は
インスタンスに追従する一方、spaceを省略した `pointAttractor`、`vortex`、解析的colliderはworld座標へ
残る。したがって型エラーなしに、エフェクトインスタンスの移動によって粒子とforce/colliderが分離する。
既存の `space: 'emitter'` 経路は `Emitter.transform` による平行移動と回転を含む望ましい意味論を
すでに持っており、問題は既定値の不統一と一覧の欠如である。

world固定の消費点は別カテゴリである。scene depthとdecalは必然的にworld/cameraデータへ作用し、SDFと
vector fieldリソースは現在world-aligned boundsを定義する。本RFCはこれらの固定フレームを省略時既定と
みなさず、H1-5で黙って再解釈してはならない。

## 4. 裁定

`space: 'world' | 'emitter'` を公開するすべてのモジュールで、省略は `emitter` を意味する。
emitter-local固定のモジュールはすでにこの作成規則へ適合している。本質的にworld/camera/gridへ結合する
消費点とセレクタを持たないモジュールは、表にある固定空間を維持する。

H1-5で省略時既定を変更するのは次の5つである。

- `vortex`
- `pointAttractor`
- `collidePlane`
- `collideSphere`
- `collideBox`

H1-4は `positionSphere.center`、`positionSphere.arc`、`EmitterConfig.offset` の追加のみを行い、
この既定変更は実施しない。H1-5は型/コメント、core codegen、診断、英日RFC 001、JSON互換正規化、
GPU回帰を同時に更新しなければならない。

## 5. 移行とシリアライズ済みアセット

旧挙動を意図するコードファースト定義は、影響モジュールへ `space: 'world'` を追加しなければならない。
すでにどちらかを明示した定義は変化しない。エフェクト追従を意図した省略定義はソース修正不要で、H1-5後に
追従を開始する。

既存の `nachi-effect` version 1文書は旧意味論を維持しなければならない。したがってH1-5はv1 JSONを
黙って再解釈せず、次の互換規則を実装する。

1. `@nachi/format` は、影響するv1モジュールで `space` が省略されている場合、明示的な
   `space: 'world'` としてロードする。
2. H1-5の作成ヘルパーは、新しい既定をシリアライズ済みmodule config内の明示的な
   `space: 'emitter'` として具現化する。
3. 再シリアライズは正規かつ明示的になり、新旧readerが一致する。サポート済みv1文書の意味は変わらず、
   両方のselector literalはすでにv1 module shapeへ属するため、envelopeはversion 1を維持する。

format互換正規化を通らない低レベルcore定義では、H1-5後の省略selectorは新しい `emitter` 規則に従う。

## 6. SemVerとchangeset

H1-5はRFC 003 §3.1と§3.5に基づく **`@nachi/core` のmajor変更** である。文書化された公開既定値と、
同一コードファースト定義に対する決定的結果を変更する。`@nachi/format` は、追加的な互換正規化と正規な
明示出力に対する **minor** changesetを必要とする。legacy v1の意味を保持するため、asset envelopeの
major/version bumpは不要である。

パッケージはまだ1.0として実publishされておらず、協調された1.0 major changesetは適用待ちである。
release ownerはH1-5を初回release plan適用前にlandし、この裁定を1.0.0へ含められる。ただし重大度は
downgradeされない。RFC 003は1.0未満でも同じpatch/minor/major分類を要求する。H1-5が1.0.0 publish後に
landする場合、`@nachi/core` は次のmajor releaseを必要とする。

現在のH1-4バッチは追加的であり、`@nachi/core` と `@nachi/format` に別々の **minor** changesetを持つ。

## 7. H1-5で必要な検証

- 明示的な`world`がH1-5前のgraphを再現し、明示的な`emitter`がinstanceの平行移動/回転へ追従することを
  source migration testで証明する。
- selector省略のversion 1 format fixtureが明示的な`world`としてロードされ、正規に再シリアライズされる。
- 影響する全モジュールで実Three WGSL codegenをbuildする。FakeAdapterだけのcoverageは不十分である。
- m4-behaviors GPU readbackの明示的なemitter-space point-attractor checkを維持し、showcase pageを
  便乗変更せず、default対explicitを弁別するcheckを追加する。
