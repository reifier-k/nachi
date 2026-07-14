# 改善プラン一覧 (docs/plans)

実効果オーサリング・スプリント(2026-07-12、`/wuwa-slash/` および showcase 5作例の制作)で
表面化した、ライブラリ側の瑕疵・体験上の欠陥に対する改善プラン集。各プランは 1 ファイル 1 議題で、
症状(実際に踏んだ再現)・根本原因・改善案・受け入れ基準・互換性リスクを記載する。

RFC が必要な規模のものは、実装前に `docs/rfc` へ昇格させることを前提とした「入口ドキュメント」で
あり、ここでの記述は規範ではない。

| # | プラン | 重大度 | 概要 |
| --- | --- | --- | --- |
| [001](./001_timeline-meshfx-transform-composition.md) | timeline mesh-fx のローカル変換合成 | 高 | 作者が設定したメッシュ姿勢が毎 play で黙って破棄される |
| [002](./002_eager-render-module-validation.md) | レンダーモジュールの早期検証と失敗の可視化 | 高 | 不正な ribbon taper 等が「無音の error state」になり デバッグ困難 |
| [003](./003_perdistance-interpolated-spawn.md) | perDistance のフレーム内補間スポーン | 中 | 高速移動エミッタで同一点に粒子が積まれ加算アーティファクト化 |
| [004](./004_draw-visibility-override.md) | ドロー可視性のユーザーオーバーライド | 中 | ランタイムが visible を毎フレーム管理し、手動の切り分け・演出制御が不可能 |
| [005](./005_effect-local-clock-for-companion-systems.md) | エフェクトローカル時計の共有 | 中 | hitStop がタイムライン内にしか効かず、随伴システム(トレイル等)と時間がずれる |
| [006](./006_headless-readback-drain.md) | ヘッドレス readback の信頼性(+ツーリング追記) | 低 | readback 無しフレームが続くと初回フルサイズ読み出しが空を返す |
| [007](./007_burst-cycle-spawn-bugs.md) | burst 多サイクルのスポーン/描画バグ群 | 高 | 死亡と後続サイクルが重なると何も描画されない(最小再現あり) |
| [008](./008_emitter-local-offsets-and-spaces.md) | エミッタローカル配置オフセットと空間指定 | 高 | 多点配置が毎回 tslModule 自作か第 2 システムを要求する |
| [009](./009_fxmaterial-runtime-controls-and-dissolve-uv.md) | fxMaterial 実行時コントロールと dissolve UV 分離 | 中 | opacity が固定・dissolve UV が map と共有でリビール表現が制限される |
| [010](./010_tsl-binding-input-validation.md) | tslModule バインディング入力の検証/自動変換 | 中 | 配列入力がコンパイルを通り GPU 送信段で不可解に失敗する |
| [011](./011_spawn-order-keyed-init-randomness.md) | init 乱数の spawnOrder キー化 | 高 | スロット再利用でラン間非決定+「凍結パターン」分布歪み(H1-1 検収中に発見) |

## 共通の背景

001–006 は wuwa-slash(鳴潮風斬撃)制作時の直接観測、007–010 は showcase 5作例
(heal/barrier/ice/machina/beam)を並行制作したサブエージェント群の独立報告の集約
(同一痛点の重複報告は統合済み)。いずれも以下の実測に基づく:

- 検証環境: WSL2 + headless Chromium + SwiftShader WebGPU、`tools/spike-runner.mjs`。
- どの症状も unit テストや既存 mN ページでは顕在化せず、「タイムライン+複数システム+高速ソケット+
  ヘッドレス画素検証」という実プロダクション相当の組み合わせで初めて露見した。
- 001/002/007 は作者を数時間単位で迷わせる種類の欠陥(silent failure / 無音の描画消失)であり
  優先度を高くしている。008 は 5 体中 4 体の制作エージェントが独立に報告した最頻出の体験欠陥。

## ユーザー裁定 (2026-07-13)

- **001**: 合成案を採用(挙動変更を許容、minor)。警告のみ案は棄却。
- **007**: (a) は案 A(スポーン包絡からの既定 duration 導出)を採用。(b) は無条件修正。
- **008**: 追加 API に加え、RFC 起票の上で既定空間の 'emitter' 統一(破壊的変更)まで断行。
- 実施計画は ROADMAP.md の **H1 ミルストーン** に展開済み。全項目とも「ショーケース 6 ページの
  追従修正と回帰緑」を DoD に含む。

## 採用見送り・小粒メモ

- barrier 報告「ドーム表面に沿う接線速度・表面拘束モジュールが欲しい」: 有用だが v1 スコープ外の
  新機能要望として ROADMAP 側で扱う(瑕疵ではない)。
- heal 報告「clone の `scale.setScalar` がジオメトリ焼き込み済みオフセットまで拡大する」:
  001(ローカル変換合成)が入れば焼き込み自体が不要になり解消する。
- 「`texture.repeat` がカスタム UV ノード下で無視される」: Three TSL の仕様に近い。
  fxMaterial ドキュメントに注意書きを追加するのみとする。

## H2 追補: H1 完了後の残存探査 (2026-07-14)

H1 完了後、上記 001–011 と検収中 BLOCKER 群を 6 傾向(T1 無音の失敗 / T2 状態所有権 /
T3 物理 ID / T4 時間 / T5 空間既定 / T6 検証盲点)へ分類し、各傾向を Codex
(gpt-5.6-sol、effort xhigh、read-only)へ並列委譲して同種残存を全域走査した。
結果は残存候補 57 件(高 25 / 中 28 / 低 4)。**全て静的監査で GPU 実測なし**
(「要検証」印の項目は実装前に再現プローブで確度を確定する)。探査レポート全文は
Codex ジョブに永続(`codex-companion.mjs result <id>` で再取得):
T1=task-mrkl9puw-hbbgor / T2=task-mrkla9gn-byrcd0 / T3=task-mrklabwk-qlz4jd /
T4=task-mrklb7a0-200ucr / T5=task-mrklav03-g4d8is / T6=task-mrklbn1b-b71g92。

16 裁定単位を全てユーザー裁定済み(2026-07-14)。14 件は推奨案どおり、2 件は推奨超え
(020 透明描画順=**全面対応**、022 空間残余=**update 段 sweep まで実装**)。
実施計画は ROADMAP.md の **H2 ミルストーン** に展開済み。

| # | プラン | 重大度 | 概要 |
| --- | --- | --- | --- |
| [012](./012_continuous-spawn-duration-derivation.md) | 連続スポーンの省略時 duration 導出 | 高 | rate/perDistance+lifecycle 省略が duration 0=無 spawn(H1-1 残存) |
| [013](./013_neighbor-grid-emitter-space.md) | NeighborGrid の emitter 空間追従 | 高 | 原点 world 固定で移動 spawn 時に近傍系が無音全滅 |
| [014](./014_timeline-meshfx-state-ownership.md) | timeline mesh-fx 状態所有権の完結 | 高 | clone が setter 状態を破棄 / userVisible 合成漏れ / geometry 生共有 |
| [015](./015_vat-timeline-clock-binding.md) | VAT×timeline 時計バインド | 高 | VAT が timeScale/hitStop に非追従、clone で VAT 喪失 |
| [016](./016_measured-delta-clamp.md) | 測定 dt の既定クランプ | 高 | RAF 停止復帰の巨大 dt が無上限で積分へ |
| [017](./017_runtime-diagnostic-delivery.md) | runtime 診断の既定 console 昇格 | 高 | GPU 失敗/device loss 等が markError 止まりで無音停止 |
| [018](./018_determinism-tie-breaks.md) | 決定性 tie-break 残余バッチ | 高 | ID 10 進文字列順の桁境界反転 / light 同点 slot 順 / routing 列挙順 |
| [019](./019_spawn-order-keyed-update-randomness.md) | update 段乱数の spawnOrder キー化 | 高 | H1-10 の据え置き範囲。update range() がラン間非決定 |
| [020](./020_transparent-draw-order-overhaul.md) | 透明描画順の全面対応 | 高 | unsorted=compaction 順 / renderOrder 丸上書き / decal 無 sorted・無回転 |
| [021](./021_sim-cache-lineage.md) | sim-cache の lineage 照合 | 高 | slot 再利用を同一粒子と誤認し teleport 補間 / loop 誤拒否 |
| [022](./022_module-space-selectors-and-update-sweep.md) | 空間 selector+update 段補間 | 高 | velocityCone/linearForce の空間 / RFC 表欠落 / update 段終点サンプリング |
| [023](./023_input-validation-hardening.md) | 入力検証ハードニング(12 件) | 高 | 非有限値・enum 語彙・format 非対称・post 迂回ほか一括 |
| [024](./024_verification-surface-hardening.md) | 検証基盤ハードニング(10 件) | 高 | CI 7/36 ページ / PNG 欠落合格 / evidence 止まり計測ほか一括 |
| [025](./025_showcase-followups.md) | showcase 追従修正 | 中 | post 中心の初期化時のみ投影 / ice の world jitter 再解釈 |
| [026](./026_low-priority-residuals.md) | 低優先残余・文書化バッチ | 低 | pool renderOrder 残存 / capture 行順 / 空間 backlog / scale 制約ほか |
