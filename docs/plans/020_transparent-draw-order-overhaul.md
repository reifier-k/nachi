# 020: 透明描画順の全面対応(sorted 既定見直し・renderOrder 合成・decal 拡張)

- 重大度: 高(破壊的成分あり=RFC 起票の上で断行)
- 対象: `@nachi/core`、`@nachi/three`、RFC(新設または RFC 001 拡張)
- 状態: 起票(H2-7、実装未着手。RFC 起票→設計確定→実装の 2 段構え)
- 出典: H1 後続 Codex 探査 T3 C-1/C-2 + T2 A-2 + T5 F-03(2026-07-14)

## 症状(静的監査、確度=確実)

1. **T3 C-1**: `sorted` 未指定の billboard / lit / mesh alpha は atomic compaction 順が
   instance 描画順になり、normal/premultiplied alpha で結果が非決定
   (mesh は `depthWrite:true` により近接透明 mesh の depth reject も併発)。
2. **T3 C-2**: decal には sorted オプション自体がなく、常時 compaction 順 NormalBlending。
   重なった decal の最終色がラン間で変わる。
3. **T2 A-2**: 透明エミッタの自動ソートが `renderOrder = 1000 + rank` でユーザー設定を丸上書き
   (`system.ts:3261` → `three/index.ts:1079`)。合成・オフセット API なし。
4. **T5 F-03**: decal 投影姿勢が `Particles.rotation` 既定(identity)のままで spawn 回転を
   継承しない(中心は追従するが投影 box の向きが変わらない)。

## 裁定(2026-07-14)

**全面対応**(推奨の小改修+文書化を超えるユーザー裁定)。方針:

1. 透明(alpha/premultiplied)renderer の `sorted` 既定を true 方向へ見直す
   (破壊的=core major 成分。perf 影響と quality tier の sorted ゲートの扱いを含め
   RFC で確定してから実装する)。
2. 自動 renderOrder ソートをユーザー値と合成する(base+rank 方式、オフセット API)。
3. decal へ sorted 経路+spawn 回転継承を追加。
4. unsorted 選択時の意味論(compaction 順=非決定)を RFC に明記し、WBOIT との選択指針を統合。

## 受け入れ基準

1. RFC(既定・合成規約・decal 拡張・性能影響・quality tier 整合)がレビュー承認されている。
2. 異色半透明の重なり fixture でラン間・spawn 回数間の描画順が決定的(GPU 実測)。
3. ユーザー renderOrder(オフセット)が自動ソートと合成され、システム外オブジェクトとの
   相対順を制御できる(プローブ)。
4. decal: sorted 有効時の重なり順決定性+回転 spawn で投影姿勢が追従(新 GPU 回帰)。
5. sorted 既定変更の perf 比較(perf v2 median)と、`setQualityTier()` の sorted ゲート
   (再コンパイル境界)整合。
6. 全ゴールデン・ショーケースの差分を構造比較で裁定(順序変化由来の意図差分のみ再記録)。

## 互換性 / リスク

- 既定変更は core major 成分(0.x でも RFC 004 §6 方式で severity 確定、降格しない)。
- 予算直撃のため quality tier での sorted 降格経路を必ず残す。
- 実装順は H2 内で決定性系(019/018)の後が安全(順序差分の弁別のため)。
