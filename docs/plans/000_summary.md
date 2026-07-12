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

## 共通の背景

001–006 は wuwa-slash(鳴潮風斬撃)制作時の直接観測、007–010 は showcase 5作例
(heal/barrier/ice/machina/beam)を並行制作したサブエージェント群の独立報告の集約
(同一痛点の重複報告は統合済み)。いずれも以下の実測に基づく:

- 検証環境: WSL2 + headless Chromium + SwiftShader WebGPU、`tools/spike-runner.mjs`。
- どの症状も unit テストや既存 mN ページでは顕在化せず、「タイムライン+複数システム+高速ソケット+
  ヘッドレス画素検証」という実プロダクション相当の組み合わせで初めて露見した。
- 001/002/007 は作者を数時間単位で迷わせる種類の欠陥(silent failure / 無音の描画消失)であり
  優先度を高くしている。008 は 5 体中 4 体の制作エージェントが独立に報告した最頻出の体験欠陥。

## 採用見送り・小粒メモ

- barrier 報告「ドーム表面に沿う接線速度・表面拘束モジュールが欲しい」: 有用だが v1 スコープ外の
  新機能要望として ROADMAP 側で扱う(瑕疵ではない)。
- heal 報告「clone の `scale.setScalar` がジオメトリ焼き込み済みオフセットまで拡大する」:
  001(ローカル変換合成)が入れば焼き込み自体が不要になり解消する。
- 「`texture.repeat` がカスタム UV ノード下で無視される」: Three TSL の仕様に近い。
  fxMaterial ドキュメントに注意書きを追加するのみとする。
