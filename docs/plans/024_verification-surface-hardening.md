# 024: 検証基盤ハードニング(T6 全 10 件)

- 重大度: 高 4 / 中 6(一括)
- 対象: `tools/`、`.github/workflows`、`apps/playground`、`apps/showcase`(公開 API 影響なし)
- 状態: 起票(H2-1、実装未着手。**以降の全 H2 タスクの検収面を強化するため先行**)
- 出典: H1 後続 Codex 探査 T6#1〜#10(task-mrklbn1b-b71g92、2026-07-14)

## 対象一覧

| # | 内容 | 重大度 |
|---|---|---|
| 1 | 常設 CI GPU 回帰が golden 7 のみ(36 ページ中)。Grid2D/WBOIT/VAT/texture 付き trail/NeighborGrid/showcase 6 作が常設外(`tools/golden-runner.mjs:5`) | 高 |
| 2 | 基準 PNG 欠落が `--update-screenshots` なしでも「新規作成・合格」になる=PNG 削除が CI 通過(`tools/spike-runner.mjs:244`) | 高 |
| 3 | 公開 `gridTslModule()` / `grid3DTslModule()` の正常カスタム stage に実 codegen 面がない(FakeAdapter+負例のみ、実行ページも組み込み stage のみ) | 高 |
| 4 | VAT 公開 variant(bottom-to-top / xz-y / absolute / signed / vertex-index / 外部 time node)が実 codegen 未実行 | 中 |
| 5 | showcase の `getElementState()` 全計測が evidence 止まりで合否非集約。`allPanelsHaveForeground()` の既定下限 0(=1 画素でも通る) | 高 |
| 6 | スクショ比較が変化画素数のみ・全画面一律 0.5% で、小領域要素(spark/ring/葉)の大幅縮退が合格域(golden-ambient leaves 約 323px vs 閾値 384px 等) | 中 |
| 7 | runner が console/pageerror を収集するだけで合否に入れない(import 時 warning 検出不能を含む) | 中 |
| 8 | m12-neighbors の `onBuildDiagnostic:null` が WebGPU 正常系まで抑制(WebGL2 拒否分岐に限定すべき) | 中 |
| 9 | perf snapshot / WebGPU profiler 値が JSON 存在確認のみで合否非集約(`status:'pending'` でも緑) | 中 |
| 10 | spike-compute の indirect draw 実行が headless で恒常スキップ(`drawExecuted:false` のまま ok) | 中 |

## 裁定(2026-07-14)

**全 10 件一括**。CI 時間増は段階収容(代表 mN ページ+showcase の選抜 → 拡大)で吸収し、
閾値再設計(#6)は「ページ毎の主要素画素占有に基づく下限」方式で行う。

## 受け入れ基準

1. #2 を最優先: 基準 PNG 欠落は `--update-screenshots` なしでは必ず fail。CI 後の dirty tree /
   新規生成 PNG 検査を追加。
2. #1: CI へ代表ページ群を追加(SwiftShader での実行時間を計測し選抜理由を記録)。
   showcase サーバー起動を含む。
3. #3/#4: custom grid stage・VAT variant の Three 実 codegen(WGSLNodeBuilder.build)回帰を
   H1-3 方式で常設。
4. #5: showcase 6 ページの要素状態チェックを合否へ集約(全滅・恒常 0 を赤にする最低限から)。
   `allPanelsHaveForeground` の既定下限を非 0 へ。
5. #6: 小領域要素を持つページ(golden-ambient leaves / golden-slash sparks /
   golden-character ring 等)へ領域別チェックまたは下限強化。偽実装での弁別性を確認
   (恒真化しないこと)。
6. #7: console/pageerror の合否化(意図的診断ページの opt-out 契約は維持)。
   #8: opt-out を WebGL2 拒否分岐に限定。
7. #9: perf snapshot の `status` / `complete` の最低限合否化(性能値そのものの合否化はしない=
   SwiftShader 値を性能主張にしない既存規約の維持)。
8. #10: headless での indirect draw 実行方策(1×1 readback ドレイン下の最小 draw)を検討し、
   不可能なら visual 限定であることを ok 出力に明示する。

## 互換性 / リスク

- 公開 API 影響なし(changeset 不要見込み)。CI 時間増は計測して上限を決める。
- 合否集約の追加で既存ページが赤くなる場合は「真の欠陥」か「チェック較正」かを H1-4 知見
  (公差は WGSL 仕様の演算誤差許容から導出)で切り分ける。
