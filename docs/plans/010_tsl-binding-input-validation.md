# 010: tslModule バインディング入力の検証/自動変換

- 重大度: 中(silent failure → 不可解な GPU エラー)
- 対象: `@nachi/core`(tslModule バインディングプロキシ、TslExpression 型)
- 状態: 実装済み・受入済み(2026-07-14、受入コミット `85f4948`)
- 出典: showcase-ice 制作エージェント

## 症状

`tslModule` のバインディング経由で得た `TslExpression` に対し、型シグネチャ上は
`add(value: Vec3 | ...)` が**プレーン配列 `[x, y, z]` を受理**する。コンパイルは通り、
実行時に GPU 送信段で

```
NACHI_GPU_SUBMISSION_FAILED: bNode.getNodeType is not a function
```

という呼び出し元と無関係な箇所・無関係な文言で失敗する。原因(配列を TSL ノードに
変換せずに渡していた)へ辿り着くまでの手掛かりがない。

## 根本原因

バインディングプロキシが引数をそのまま Three TSL ノードグラフへ流しており、
`Vec3`(number タプル)→ `vec3(...)` ノードへの変換も、非ノード入力の拒否もしていない。
型定義は authoring 便宜のために `Vec3` を許しているが、実装が追随していない。

## 改善案

二択(併用可):

1. **自動変換(推奨)**: プロキシの各演算引数で `number` → `float(...)`、
   `readonly [n,n,n]` → `vec3(...)` 等の lowering を行う。作者体験が最良で、
   型シグネチャと実装が一致する。
2. **ビルド時拒否**: 変換対象外の非ノード入力を検出したら、モジュール path 付きの
   `NACHI_TSL_BINDING_INPUT_INVALID` 診断を compile 段で投げる(GPU 送信まで
   到達させない)。

いずれの場合も、`NACHI_GPU_SUBMISSION_FAILED` にはカーネル種別・エミッタ path を
必ず添える(現状は素の例外文言のみで、どのモジュールが原因か分からない)。

## 受け入れ基準

1. `binding.velocity.add([0, 1, 0])` が(案 1)正しく動く、または(案 2)compile 診断で
   モジュール path とともに拒否される。
2. GPU 送信失敗の診断に、原因カーネル/エミッタの特定情報が含まれる。
3. 既存の正当な tslModule 使用箇所(m8-tslkit 等)が全緑。

## 互換性 / リスク

- 案 1 は挙動追加のみで後方互換。数値リテラルの暗黙 float 化は TSL 慣行と一致する。
- 変換テーブルの網羅漏れに注意(mat3/mat4/quat)。attributes.ts の型対応表を単一情報源にする。
