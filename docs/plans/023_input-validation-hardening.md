# 023: 入力検証ハードニングバッチ(12 件)

- 重大度: 高 5 / 中 7(一括)
- 対象: `@nachi-vfx/core`、`@nachi-vfx/format`、`@nachi-vfx/timeline`、`@nachi-vfx/trails`、`@nachi-vfx/post`、`@nachi-vfx/mesh-fx`
- 状態: 起票(H2-13、実装未着手)
- 出典: H1 後続 Codex 探査 T1#2〜#11 + T4#2/#6(2026-07-14)

## 対象一覧

| # | 出典 | 内容 | 重大度 |
|---|---|---|---|
| 1 | T1#4 | 通常 ValueInput(lifetime/gravity/drag/velocity 等)の非有限・型混在が factory/compile を素通り(`module-validation.ts` の一般 ValueInput branch 不在) | 高 |
| 2 | T1#5 | `turbulence.octaves` の NaN/非整数が無診断で octave ループ 0 回=非有限グラフ化(`compiler.ts:5312`) | 高 |
| 3 | T1#7 | spawn/setTransform/attachment の非有限 transform が GPU uniform へ直行(`system.ts:2467/2818`) | 高 |
| 4 | T1#8 | format の timeline action 検証が authoring より弱い(負 hitStop 等が load 通過→実行時に timeline 全体 error 化) | 高 |
| 5 | T1#9 | post の公開 `PostPipelineConfig` 直接構築で factory validator 迂回(`samples:0`=0 除算ノード、`pipeline.ts:102`) | 高 |
| 6 | T1#6 | 範囲外 collision mode が診断なく bounce へフォールバック(`compiler.ts:4813`) | 中 |
| 7 | T1#10 | trails の ribbonId/offset/未知 uv.mode の検証不足(未知 mode は stretched へ無音フォールバック) | 中 |
| 8 | T1#11 | mesh-fx VAT の外部 `time` 非有限・boolean 文字列が truthy 誤解釈(`vat.ts:91/200`) | 中 |
| 9 | T1#2 | normalizedAge 読み+lifetime/age 未導入が無診断で先頭値固定(NACHI_LIFETIME_WITHOUT_AGE の逆方向) | 中 |
| 10 | T1#3 | trails `maxRibbons` 既定 1 が ribbonId 範囲と不整合でも strand 無音破棄(整合性診断なし) | 中 |
| 11 | T4#6 | timeline spawn 時のみ timeScale 不変条件(有限・非負)を検証しない(`runtime.ts:375`) | 中 |
| 12 | T4#2 | timeline 初回 `update(0)` が attachment 同期前に time-zero play を処理し、古いポーズで初期化(`runtime.ts:1100/1131`) | 中 |

## 裁定(2026-07-14)

**全件バッチ採用**。H1-3 の共有バリデータ方式(ファクトリ早期 throw+compile 段共有=JSON 経路の
診断維持)への編入を基本とし、各パッケージの独自 validator も同一規約(有限性・enum 語彙・型)へ
揃える。#12 のみ検証でなく処理順の修正(初回 update(0) でも attachment sync を先行させる)。

## 受け入れ基準

1. 各項目に「不正入力 → ファクトリまたは load 段で診断」の unit を追加(H1-3 の棚卸し表を更新)。
2. #4/#8: format 往復テストへ負例を追加し、authoring / format / runtime の検証対称性を表で確認。
3. #9: helper 経由と直接構築の両方で validator が走る(公開 constructor での再検証)。
4. #12: attach → 初回 update(0) → at:0 play の順でも子エミッタが最新ポーズで初期化される回帰。
5. 意図的診断ページの opt-out 整合(H1-3 の全構築サイト走査を再実行)。
6. 全域回帰緑。新設診断コードは NACHI_* 命名規約+RFC 列挙へ追記。

## 互換性 / リスク

- 従来「通ってしまっていた」不正入力が診断化する=厳格化(各パッケージ minor)。
- format の strict 化は load の後方互換に注意(v1 封筒は不変、診断コード追加のみ)。
