# 009: fxMaterial の実行時コントロール拡充と dissolve UV の分離

- 重大度: 中(表現力。3/5 の制作エージェントが独立に報告)
- 対象: `@nachi/mesh-fx`(material.ts)、`@nachi/timeline`(fxMaterial ラッパー)
- 状態: 実装済み・受入済み(2026-07-14、受入コミット `c2d9235`)
- 出典: showcase-barrier / showcase-machina / showcase-beam 制作エージェント

## 症状

1. **不透明度/強度がコンパイル時固定**: `fxMaterial.opacity` は数値のみで、実行時に
   フェード・呼吸(パルス)させる公式手段がない。barrier は `fresnel.power` が
   `ScalarInput`(ノード)を受けることを利用して独自 uniform を「密輸」して呼吸を実装した。
   timeline 要素では「dissolve を使った侵食」しか減衰手段がなく、`edgeColor` の発光で
   **消える前にむしろ明るくなる**(barrier)。
2. **dissolve が map と同じ UV ノードを共有**: `uv: uvFlow(...)` を指定すると dissolve の
   サンプル UV も一緒に流れるため、「テクスチャは高速スクロール+ランプディゾルブで
   方向リビール」が 1 要素で両立できない(machina の光柱・beam の鞘。どちらも
   別要素分割や scale アニメで回避)。
3. **edgeColor が map 非変調で加算される**: 正面向きシリンダー等で等値線状の色板が
   モデル全面に走る(machina/beam)。ホールド閾値をノイズ値域の下に置く運用知識が必要。

## 改善案

1. `FxMaterialConfig.opacity` を `ScalarInput` 許容に拡張し、省略時は
   `fx.setOpacity(value)` 可能な書き込みユニフォームを生やす(`time`/`normalizedLife` と
   同じパターン)。timeline ラッパーには `opacityOverLife?: OverLifeInput` を追加し、
   `normalizedLife` から降ろす。
2. `FxDissolveConfig.uv?: PolarUvAuthoring | CartesianUvFlowAuthoring | 'static'` を追加。
   省略時は現行どおり map と共有(後方互換)、`'static'` で素の `uv()` を使う。
3. `FxDissolveConfig.edgeIntensity?: number` と `edgeModulate?: 'none' | 'map'` を追加し、
   エッジ発光を map 輝度で変調できるようにする(既定 'none' = 現行互換)。
4. ドキュメント: 「ホールド閾値はノイズテクスチャの値域の下限未満に置く」
   「ノイズ周波数はメッシュスケールに合わせる」を fxMaterial ガイドに明記(machina #4)。

## 受け入れ基準

1. `fx.setOpacity(0.5)` が additive/alpha 両ブレンドで即時反映される。
2. timeline 要素が `opacityOverLife` で「明るくならずに」フェードアウトできる
   (barrier のリング減衰ケースをスパイクに追加)。
3. `dissolve: { uv: 'static' }` + `uv: uvFlow(...)` で、スクロールとランプリビールが
   1 要素で両立する(machina の柱をリファレンスに)。
4. 既存 golden / m8-meshfx スパイク全緑(既定値は全て現行挙動)。

## 互換性 / リスク

- すべて追加オプション+省略時現行挙動で後方互換。
- `@nachi/format` のシリアライズに material 構成が入る場合は対応フィールドの追補が必要
  (現状 mesh-fx リソースは文書外なので影響は限定的)。
