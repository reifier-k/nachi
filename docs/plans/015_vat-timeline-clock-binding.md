# 015: VAT の timeline 時計自動バインドと clone 保持

- 重大度: 高
- 対象: `@nachi/mesh-fx`(vat.ts)、`@nachi/timeline`、RFC 001(M9 責務)
- 状態: 起票(H2-10、実装未着手)
- 出典: H1 後続 Codex 探査 T4#3(task-mrklb7a0-200ucr、2026-07-14)

## 症状(静的監査、確度=確実)

`applyVat()` の package-owned clock(`vat.ts:91` — `uniform(0)`)は timeline の
timeScale / hitStop / pause / mesh life と一切バインドされない(timeline が時刻を配る対象は
`'fx' in mesh.material` の fxMaterial のみ=`runtime.ts:318/678`)。`meshFxElement()` へ
VAT 適用 mesh を渡すと、通常 NodeMaterial では VAT が時刻 0 で静止し得る。さらに timeline
`fxMaterial()` への VAT 後付けは、clone が `cloneTimelineFxMaterial()` で config 再生成するため
VAT の `positionNode` 変更ごと失われる。plan 005(時計共有)と同型の VAT 版であり、
RFC 001 は M9 の automatic element-lifecycle binding 責務を予定している。

## 裁定(2026-07-14)

**自動バインド+clone 対応を採用**。meshFxElement が VAT controls を検出して
localTime / timeScale / hitStop を自動同期し、clone で VAT 適用を保持する。

## 受け入れ基準

1. VAT 適用 mesh 要素が timeline の timeScale 変更・hitStop・pause へ追従する
   (GPU 実測: hitStop 中の頂点静止を m8-vat 系または m9 系リグで固定)。
2. timeline fxMaterial+VAT 併用の clone で VAT positionNode / uniform が保持され、
   clone 間で時刻が独立する。
3. 明示 `config.time`(外部ノード)指定時は自動バインドしない(現行契約の保存)。
4. 非 timeline 利用(単体 VAT)の既存挙動・m8-vat 両バックエンド回帰が不変。
5. RFC 001 の M9 責務節へバインド規約を明記。plan 014 の clone スナップショット化と整合させる。

## 互換性 / リスク

- timeline に載せた VAT の進行が変わる(意図に合う方向だが、自前で時刻駆動していたページには
  変化。mesh-fx / timeline minor)。plan 014 と同一バッチでの実装が安全。
