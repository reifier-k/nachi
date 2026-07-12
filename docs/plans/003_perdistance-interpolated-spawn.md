# 003: perDistance スポーンのフレーム内トランスフォーム補間

- 重大度: 中(視覚品質 / Niagara パリティ)
- 対象: `@nachi/core`(spawn カーネル、`core/per-distance` および `core/rate`)
- 状態: 提案

## 症状

エミッタを 1 ステップに数十 cm〜数 m 移動させながら `perDistance()`(または `rate()`)で
スポーンすると、**そのステップで生まれる全パーティクルが同一のエミッタ変換上に配置される**。
ブレードトレイルのような高速スイープでは、60 Hz で 1 フレームに 10 個以上が同一点に積まれ、
加算合成で「光るレンガ」状のビードアーティファクトになる。

wuwa-slash 実測: スイープ速度ピーク ~38 u/s、perDistance(30) で 1 フレーム最大 19 粒が同一点に
スタックした。回避策としてページ側で 1 フレーム 4 サブステップ(`system.update(dt/4)` +
サブステップ毎のソケット更新)を実装して解消したが、これは全ユーザーに強いるべき負担ではない。

## 根本原因

スポーンカーネルの init 段(`positionSphere` 等)が `Emitter.transform` の「現在値」だけを読む。
前ステップの変換が保持されておらず、ステップ内で生まれる N 粒に対する
スポーン位相(0..1)に応じた補間ができない。

## 改善案

Niagara の interpolated spawning 相当を導入する:

1. エミッタごとに `Emitter.previousTransform` を保持(attach 更新時に world matrix をコピー)。
2. スポーンカーネルが粒ごとの spawn 位相 `phase = (index + 0.5) / countThisStep` を算出し、
   init 段に `Emitter.spawnInterpolatedTransform`(prev→current を位相で線形補間+四元数 slerp)
   を提供する。
3. `positionSphere` / `velocityCone` などエミッタ変換を読む init モジュールを補間変換読みに
   切り替える(モジュールの `reads` 宣言追加のみで、公開 API は不変)。
4. `perDistance` の距離アキュムレータも同じ prev→current 線分上で発火位置を算出する
   (等間隔配置が自然に得られる)。

`rate()` にも同じ位相補間を適用する(spawn 時刻の age サブステップ補正も同時に得られる)。

## 受け入れ基準

1. 1 ステップに 0.5 unit 移動するエミッタ + `perDistance(20)` で、生成粒の位置が移動線分上に
   最大間隔 ~1/20 unit で分布する(現状: 全粒が線分終端の 1 点)。
2. 静止エミッタの挙動・決定性(seed 再現)が不変。
3. `m2-runtime` / `m4-behaviors` / golden 系スパイクが全て緑。
4. wuwa-slash のページ側 4 サブステップ回避策を 1 サブステップに戻してもビードが出ない。

## 互換性 / リスク

- 移動エミッタでのスポーン位置分布が変わる(改善方向)。決定性は保たれるが
  既存スクリーンショットベースラインの再記録が必要になり得る。
- GPU 側の変換バインディングが 1 本増える(prev transform)。ストレージ/ユニフォーム予算は軽微。
