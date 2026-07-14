# 001: timeline mesh-fx クローンの作者ローカル変換を合成する

- 重大度: 高(silent failure / 作者体験)
- 対象: `@nachi/timeline` (`packages/timeline/src/runtime.ts`)
- 状態: 実装済み・受入済み(2026-07-14、受入コミット `df565d7`)
- 裁定: 2026-07-13 ユーザー承認 — **合成案を採用**(挙動変更、changeset minor)。代替案(警告のみ)は棄却。
  実装時はショーケース各ページのジオメトリ焼き込み回避策をローカル変換指定へ置換すること。

## 症状

`slashArc()` / `ring()` 等で作った `MeshFxMesh` に `mesh.rotation.x = -Math.PI / 2` や
`mesh.position.y = -0.93` を設定して `meshFxElement()` に渡しても、**再生時に完全に無視される**。
地面に寝かせたはずの魔法陣がカメラ正面向きで表示される。警告・診断は一切出ない。

wuwa-slash 制作時の実測: 地面配置の rune ring 2 枚と傾けた slashArc 2 枚がすべて
エフェクト原点・単位姿勢で描画され、原因特定に複数イテレーションを要した。

## 根本原因

`packages/timeline/src/runtime.ts` の `setMeshTransform()` が、クローンの
`position` / `quaternion` を**エフェクトインスタンスの spawn transform で上書き**する。
`cloneMesh()`(`resource.mesh.clone()`)は作者の変換をコピーするが、直後の上書きで消える。
`scale` だけは触られないため「scale は生きるが姿勢は死ぬ」という非直感的な状態になっている。

## 改善案

作者メッシュの変換を「エフェクトに対するローカルオフセット」として合成する:

```
cloneWorld = effectTransform * authoredLocalTransform
```

- `cloneMesh()` 時に作者の `position/quaternion/scale` を `authoredLocal` として退避。
- `setMeshTransform()` を `compose(effect, authoredLocal)` に変更(scale も合成対象に含め、
  既存のページ駆動 scale アニメーションとの衝突を避けるため「ランタイムが scale を書くのは
  play 時の初期化 1 回のみ」という現行挙動は維持する)。
- シリアライズ(`@nachi/format`)には影響しない: mesh-fx リソースはもともと文書外の
  ライブリソースであり、変換はリソース側に付随する。

代替案(非推奨): 現状を仕様と割り切り、`meshFxElement()` で非単位変換を検出したら
`NACHI_MESH_FX_TRANSFORM_IGNORED` 警告診断を出す。silent failure は解消するが、
ジオメトリ焼き込み(`geometry.rotateX/translate`)という回避策を作者に強い続ける。

## 受け入れ基準

1. 作者が `mesh.rotation.x = -Math.PI/2; mesh.position.y = -0.9` を設定した ring 要素が、
   エフェクトを `position: [1,0,0]` で spawn したとき「(1,-0.9,0) に寝た状態」で描画される。
2. 既存の golden-ultimate(作者変換が単位のまま)の描画・チェックが不変。
3. ページ側から clone の `scale` を毎フレーム上書きする既存パターン(衝撃波リング拡大)が
   引き続き機能する。
4. `m9-timeline` / `golden-*` スパイクが全て緑。

## 互換性 / リスク

- 作者変換が単位でない既存コンテンツは見た目が変わる(=これまで黙って無視されていたものが
  効き始める)。リポジトリ内の既存ページは単位変換のみなので影響なし。挙動変更として
  changeset の minor に記載する。
