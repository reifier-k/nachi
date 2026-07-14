# 025: showcase 追従修正(post 中心の再投影・ice jitter 正規化)

- 重大度: 中(F-02)/低(F-06)
- 対象: `apps/showcase`(6 ページ)
- 状態: 起票(H2-14、実装未着手)
- 出典: H1 後続 Codex 探査 T5 F-02/F-06(task-mrklav03-g4d8is、2026-07-14)

## 症状(静的監査、確度=確実)

1. **F-02**: 6 ページ全てで shockwave 等の post 中心を初期カメラで一度だけ world→screen UV 化
   している(`beam.ts:1019` ほか、slash/barrier/machina/heal/ice に同型)。ライブ閲覧で
   orbit/pan/zoom/FOV 操作や camera shake 中に、画面エフェクトが world 上の着弾点から分離する。
2. **F-06**: ice の custom Init が `positionSphere` の生成した **world position** を `jitter` と
   称して再解釈し、別の world position で上書きしている(`ice.ts:496/667`)。現行は原点 spawn の
   ため潜在だが、ページを雛形として流用・offset/rotation 追加すると移動量が軸ごとに混入する。

## 裁定(2026-07-14)

**採用**。post 中心の毎フレーム再投影化(6 ページ)と ice jitter の正規化(ローカル乱数由来へ)。

## 受け入れ基準

1. 固定カメラの headless 基準に差分が出ない(≤0.5%、実質 0 想定=基準再記録不要)。
2. カメラを動かす手動確認で shockwave 中心が着弾点へ追従(ユーザー補助検証リストへ記載)。
3. ice は offset/rotation を与えた再 spawn でも分布形状が保存される(プローブまたは目視)。
4. 6 ページ spike ok:true+console 清浄維持。

## 互換性 / リスク

- ページローカル修正のみ。ライブラリ API 影響なし(changeset 不要)。
