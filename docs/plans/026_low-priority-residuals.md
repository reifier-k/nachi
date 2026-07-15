# 026: 低優先残余・文書化バッチ

- 重大度: 低〜中(要検証含む)
- 対象: `@nachi-vfx/core`、`@nachi-vfx/three`、docs/rfc
- 状態: 起票(H2-15、実装未着手)
- 出典: H1 後続 Codex 探査の残余(2026-07-14)

## 対象一覧

| 出典 | 内容 | 処置方針 |
|---|---|---|
| T2 B-1(解消済み、H2-7へ移管) | pool 再利用時に前世代の `THREE_RENDER_ORDER` 記録が kernel state に残存し、次利用者の materialize 初期値になる(`three/index.ts:486`、通常返却はクリアされず完全破棄時のみ削除) | plan 020 / RFC 006 のdraw-index別base+offset+rank state所有へ統合。pool返却/releaseでassignmentをclearし、actual checkout + update前materialize + retained prepare GPU回帰で2026-07-15に解消。H2-15対象から除外 |
| T3 B-5(低・確実) | WebGPU debug capture の行順・pagination が compaction 順依存(WebGL2 は slot 昇順=backend 間で行順不一致) | 文書化+安定ソートオプションの検討 |
| T4#5(中・要検証) | fixed-step の時間 backlog 破棄(`maxSubSteps`)時に transform の空間 backlog が破棄されず、復帰時に perDistance が停止期間の長い chord へ粒子生成(`system.ts:556/1344` — `droppedSeconds` 増加時の transform ラッチ分岐なし) | 再現プローブ → H1-7 の「停止中距離破棄」規約と整合する transform ラッチを実装 |
| T5 F-08(中・確実) | Three attach で world scale が公開 transform(`EffectWorldTransform`)から脱落(RFC 001 明記の現行制約の再確認) | 制約の再明文化+scale 対応は v2 候補として ROADMAP 残差へ |
| T2 A-1(中・確実) | light pool の子 PointLight 補正(intensity/distance/position/color)が毎 readback で粒子値に上書きされる | 「ランタイム所有プロパティ一覧」を RFC 化(plan 020 の renderOrder 合成と整合)。補正合成 API は v2 候補 |

## 裁定(2026-07-14)

雑務バッチとして 1 タスク化(ユーザー裁定)。T2 B-1はH2-7 PHASE 1で、pool返却がdraw registryをdispose
してもkernel上のorder stateをclearせず、完全releaseだけがdeleteすることを確認し、order ownershipを扱う
plan 020へ移管した。H2-7受入時に実pool回帰を伴って閉じる。残る「要検証」T4#5は実装前に再現プローブで
確度を確定し、実害が確認できなければ文書化へ降格してよい(統括判断)。

## H2-7移管完了(2026-07-15)

T2 B-1は`prepareKernelsForPooling()`とpermanent releaseの双方でdraw registration/order assignmentをclearする
実装へ置換した。`/m10-sort/`はrelease→同一kernel pool checkout→update前materializeで前generation base/rankが
見えず、update後に新rankだけが合成されること、late materializationとretained prepared drawが最新assignmentを
受け取ることを実GPUで検証した。詳細値・fault isolation・全域gateはplan 020 PHASE 2へ記録済みであり、本plan
からの重複実装は行わない。

## 受け入れ基準

1. 移管後に残る要検証1件（T4#5）の再現プローブ結果がセッションログに記録され、採否が確定している。
2. 採用分の修正+回帰、降格分の RFC/README 明文化が完了している。
3. 全域回帰緑。changeset は採用分の実装内容に応じて起票。
