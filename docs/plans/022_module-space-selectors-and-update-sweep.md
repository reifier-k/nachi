# 022: 空間 selector 拡張・RFC 004 表完備・update 段 transform 補間(sweep)

- 重大度: 高(大型。H1-7 相当の重さ)
- 対象: `@nachi/core`、`@nachi/format`、RFC 004 / 001
- 状態: 起票(H2-6、実装未着手)
- 出典: H1 後続 Codex 探査 T5 F-04/F-05/F-07 + T4#1(2026-07-14)

## 症状(静的監査)

1. **F-04(確実)**: `velocityCone.direction` が world 固定で emitter 回転に追従せず
   (`compiler.ts:5007` — `Emitter.transform` 非読み)、H1-5 で emitter 追従になった位置分布と
   初速方向が回転 spawn で分離する(RFC 004 既載の意図的制約だが、位置と速度の非対称が残る)。
2. **F-05(要検証)**: `gravity(Vec3)` / `linearForce` は RFC 004 表に行が無く暗黙 world 固定
   (`compiler.ts:5074/5286`)。linearForce のローカル推進用途が成立しない。
3. **F-07(確実)**: RFC 004 表は perDistance の world 距離、Grid Runtime の normalized 座標、
   Grid velocity の cell/sec 単位などを未収録で、新 API 追加時の網羅監査表として不完全。
4. **T4#1(要検証)**: emitter 追従の collidePlane/Sphere/Box・killVolume・vortex/pointAttractor 等の
   update 段モジュールは現在 transform の終点サンプリング(`compiler.ts:4779` ほか)。高速移動・
   低 fps でフレーム間の移動経路を走査せず、衝突/kill の取りこぼし・終点テレポート・fps 依存の
   力場加速が起こる。plan 003 は「init 以外は current transform」と明示的にスコープ外化していた。

## 裁定(2026-07-14)

**sweep まで実装**(推奨の selector+表完備を含む全面対応のユーザー裁定):

1. velocityCone / linearForce へ space selector 追加(省略時既定は現状 'world' 維持=非破壊。
   'emitter' 指定で回転追従)。gravity は world 固定を明記。
2. RFC 004 表を全モジュール+単位系(perDistance / Grid 座標 / scale 非対応)へ完備し、
   新 API 追加時のチェックリストと位置づける。
3. **update 段の emitter 追従モジュールへフレーム内 transform 補間(sweep)を導入**:
   H1-7 の `previousTransform` 基盤を流用し、update 段の `Emitter.transform` 読みを
   サブフレーム位相での補間読みへ拡張する。静止時はビット一致を構成的に保証(H1-7 方式)。
   連続衝突判定(CCD)までは行わず「補間 transform での評価」に留める範囲を RFC で確定する。

## 受け入れ基準

1. selector: 明示 'world' は変更前 WGSL と SHA-256 一致(H1-5 方式)。'emitter' 指定の回転追従を
   GPU 回帰で固定。format strict 対応+往復テスト。
2. sweep: 高速移動エミッタ+emitter 追従 collider/killVolume の fixture で、ステップ分割
   (1 step vs 4 substep)による結果差が縮小することを実測(H1-7 の wuwa ビード検証方式)。
   静止時は全対象モジュールでビット一致。
3. previousTransform リセット経路(H1-7 の点検リスト: 構築 / プール checkout / 初期化前 sync /
   error / fixedTimeStep / quality restart / カリング再開)の網羅を再点検し、以後に追加された
   経路も含める。
4. RFC 004 改訂(表完備+update 段補間の契約+CCD 非対応の明記)。
5. perf 比較(update 段の transform 補間コスト、perf v2 median)。

## 互換性 / リスク

- selector 追加自体は非破壊。update 段補間は移動中の実挙動が変わる(core minor、
  基準再記録の可能性)。
- H1-7・H1-8 で確立した「停止中距離破棄」「ソケットラッチ」規約との相互作用を回帰ピンで監視
  (受入済みチェックの緩和は原則却下=H1-8 知見)。
