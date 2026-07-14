# 017: runtime 診断の既定 console 昇格(H1-3 の runtime 拡張)

- 重大度: 高(#12)/中(#13、#14)
- 対象: `@nachi/core`、`@nachi/three`(light pool)、`@nachi/timeline`、RFC 001
- 状態: 起票(H2-12、実装未着手)
- 出典: H1 後続 Codex 探査 T1#12/#13/#14(task-mrkl9puw-hbbgor、2026-07-14)

## 症状(静的監査、確度=確実)

1. **#12**: GPU submission 失敗・device loss・attachment 例外・timeline action/callback 失敗は
   `markError()` で instance state に積まれるだけ(`system.ts:3648/3700`、`timeline/runtime.ts:1167`)。
   H1-3 の既定 console 昇格は build 診断限定で、作者が `state` / `diagnostics` を poll しない限り
   エフェクトは無音停止する。react の `update().catch()` にも instance 内で吸収されたエラーは
   到達しない。(RFC 上 onBuildDiagnostic が runtime を扱わないこと自体は明記済み=規範の拡張が必要)
2. **#13**: `NACHI_LIGHT_LIMIT_EXCEEDED` は `ThreeLightPoolOptions.onDiagnostic` 任意指定のみで、
   `createThreeEffectPreparer()` の既定経路から配送されない(`three/index.ts:2067`)。
3. **#14**: 実 free-list 不足・event queue overflow の診断は readback opt-in 時のみ
   (`system.ts:1726` 以降。RFC 明記済みの意図的性能設計)。

## 裁定(2026-07-14)

**console 昇格を runtime へ拡張**。H1-3 と同じ方式(既定 console 1 行、ハンドラ設定可、
null opt-out、ハンドラ例外封じ込め)を runtime 診断へ延長。light 上限は preparer から自動接続。
容量飽和は readback 有効時のみ(既存性能設計は変えない)。

## 受け入れ基準

1. markError 経路の全診断コードが既定 console に 1 行で乗る(意図的発火ページは opt-out)。
   ハンドラ throw は H1-3 同様に封じ込め。
2. light 上限診断が preparer 既定経路で配送される(m10-lit 系で実測)。
3. readback 有効時の overflow 診断が既定 console へ乗る。readback 無効時は現状維持(RFC 再明記)。
4. react binding が error 遷移を握り潰さない(M12 バッチ 5 の error 状態ゲート規約と整合)。
5. RFC 001 の診断配送契約(build / runtime の二層)を改訂。全 playground/showcase ページの
   opt-out 棚卸し(H1-3 の 108 サイト走査方式)を再実行。

## 互換性 / リスク

- 既定で console 出力が増える(挙動変化はログのみ、core/three minor)。
- plan 024 の console 合否集約と相互作用するため、H2-1(検証基盤)完了後に実装する。
