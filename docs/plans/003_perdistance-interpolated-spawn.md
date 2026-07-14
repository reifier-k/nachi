# 003: perDistance スポーンのフレーム内トランスフォーム補間

- 重大度: 中(視覚品質 / Niagara パリティ)
- 対象: `@nachi-vfx/core`(spawn カーネル、`core/per-distance` および `core/rate`)
- 状態: 実装済み

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

`rate()` にも同じ位相補間を適用する。spawn 時刻の age サブステップ補正は v1 の対象外とし、
将来の明示的なオプションとして RFC 001 に記録する。

## 実装した契約

- `RuntimeEmitter` は最後にシミュレーションした合成済み transform を保持する。正の時間を
  進める各ステップでは、attach/socket/`setTransform()` の同期結果を current とし、直前の
  シミュレーション値を `Emitter.previousTransform` に公開する。
- 初回 spawn とプールからの再取得では `previousTransform = transform`、
  `interpolationActive = 0` にリセットする。`update(0)` は履歴を進めない。
- 行列がビット単位で等しいときは CPU が `Emitter.interpolationActive = 0` を設定する。
  init カーネルはこの場合、従来どおり `Emitter.transform` を直接読み、lerp/slerp を実行しない。
- 補間が有効な通常の rate/burst バッチでは、位相分母 `N` を CPU 側クランプ
  (要求数 ∧ 物理 capacity ∧ 論理可用性)後のバッチサイズに固定し、`spawnOrder` から導いた
  バッチ内 index を `i` として `phase = (i + 0.5) / N` とする。GPU free-list 飽和は
  さらに生成数を減らすが位相は再分配せず、最先頭の発火位置を保持する。これは perDistance の
  承認済みドロップ意味論(先頭 N 個の発火位置を保持し、再分配しない)と一貫する。
  compaction の割り当て順には依存しない。
- `perDistance({ rate: R })` ではステップ距離を `D`、ステップ開始時の距離アキュムレータを
  `r` (`0 <= r < 1`) とし、`phaseStart = (1 - r) / (R * D)`、
  `phaseStep = 1 / (R * D)` とする。各発火位置そのものを current segment 上の位相へ変換する。
  `D` はステップ間スナップショットの直線 chord 長であり、1ステップ前に複数回 `setTransform()`
  しても折れ線は蓄積せず、最後のcurrentまでの純変位だけを消費する。
- `Emitter.spawnInterpolatedTransform` は translation を lerp、rotation を最短経路の quaternion
  slerp で合成する仮想 init 入力である。init 以外の段と event spawn は current transform を使う。
- `setTransform()` は連続運動として補間する。瞬間移動用の previous reset API は将来課題である。
- カリング中や有効time scaleが0のhitStop中も、正のsystem stepごとにtransform履歴を追従する。
  その間の移動距離はスポーンせず破棄し、再開時の一括発火とstale補間ビードを防ぐ。

## previous transform のリセット経路

1. 新規 `RuntimeEmitter` の生成。
2. `RuntimeEmitter` をプールから再取得して新しい effect instance に割り当てる経路。
3. 初期化完了前の transform/attachment 同期。初回の origin から補間しない。

各経路は current の合成済み transform と rotation を previous uniform に複製し、
`interpolationActive` を無効化する。

## 既存ページへの影響調査

`rate()` / `perDistance()` と `setTransform()` / attach を機械走査し、位置 init の有無と
transform の実移動を確認した。

- 意図的に分布が変わる: `golden-slash`(移動 emitter + rate)、
  `m7-ribbons`(移動 emitter + rate)、`wuwa-slash`(移動 emitter + perDistance)。
- 回帰検査専用: `m2-runtime`(perDistance/rate/静止時ビット一致を検査)。
- 分布は変わらない: `m11-scale` は移動 rate emitter だが emitter transform を読む position init が
  なく、`golden-character` の rate aura は attach 先 transform が静止している。
- `golden-ultimate`、`golden-charge`、`showcase-beam`、`golden-ambient` など、その他の
  rate/burst 使用ページには移動 emitter と transform 依存 position init の組み合わせがない。

`wuwa-slash` はページ側の 4 サブステップ回避を削除し、1 フレーム 1 update に戻した。
headless spike は ribbon segment の物理間隔が `1 / 22 unit` と WGSL 誤差予算以内であることを検査する。

## 受け入れ基準

1. 1 ステップに 0.5 unit 移動するエミッタ + `perDistance(20)` で、生成粒の位置が移動線分上に
   最大間隔 ~1/20 unit で分布する(現状: 全粒が線分終端の 1 点)。
2. 静止エミッタの挙動・決定性(seed 再現)が不変。
3. `m2-runtime` / `m4-behaviors` / golden 系スパイクが全て緑。
4. wuwa-slash のページ側 4 サブステップ回避策を 1 サブステップに戻してもビードが出ない。

GPU readback の位置許容値は f32 machine epsilon に演算回数の上限を掛けた値
(`32 * 2^-23`)とし、perDistance の最大間隔 `1 / 20 unit` に加算する。

## 互換性 / リスク

- 移動エミッタでのスポーン位置分布が変わる(改善方向)。決定性は保たれるが
  既存スクリーンショットベースラインの再記録が必要になり得る。
- GPU 側の変換バインディングが 1 本増える(prev transform)。ストレージ/ユニフォーム予算は軽微。
