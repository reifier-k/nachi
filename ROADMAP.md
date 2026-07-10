# ROADMAP — Niagaraパリティへの道

> 状態: 🚧 = 進行中 / ✅ = 完了 / ⬜ = 未着手。各項目は1セッションで完了できる粒度を目安に分割してある。
> セッション終了時に必ず本ファイルを更新すること。ビジョンと設計原則は [PLAN.md](./PLAN.md)。

## 監査プロトコル

各マイルストーンは最後の項目として **🔍 マイルストーン監査** を持つ。監査は**実装したセッションとは別のセッションで**実施する(新鮮な目で見るため)。監査セッションでは新機能を実装しない。

**実施体制**:統括(Claude本体)は監査を自ら行わず、**Codexサブエージェント(`/codex:rescue --model gpt-5.6-sol --effort xhigh`)とClaudeサブエージェントの両方を起動し、下記の標準手順をそれぞれ独立に実施させる**。統括は両者の結果を突き合わせ、片方しか検出しなかった指摘も含めて全件を処理(解消または却下理由の記録)したうえで合否を判定する。この体制は最終監査FAにも適用する。

**マイルストーン監査の標準手順(各監査エージェントが独立に実施):**

1. **ビルド健全性**:全パッケージの型チェック・全テストがグリーンであること
2. **コードレビュー**:`/code-review`(効率レベル high 以上)を実行。指摘は解消するか、却下理由をセッションログに明記
3. **パリティ検証**:当該マイルストーンのパリティマトリクス項目を playground の実挙動で1つずつ確認し、「Niagaraの同機能と比べて何ができないか」を差分として記録。確認できた項目のみ ✅ にする
4. **ゴールデン回帰**:達成済みゴールデンエフェクト全本のスクリーンショット回帰比較(壊れていないこと)
5. **パフォーマンス計測**:計測ハーネスで前回監査時との比較。劣化があれば原因を特定してから通過。数値をセッションログに記録
6. **API整合**:公開APIを API RFC(docs/rfc/001-api.md)と突き合わせ。逸脱は RFC 更新か実装修正で解消(黙認しない)
7. **ドキュメント**:PLAN.md 決定事項ログ・README・パリティマトリクスが実態と一致していることを確認

監査で不合格項目が出た場合、チェックボックスを外して差し戻し、修正後に監査を再実施する。

**最終監査(1.0リリースゲート)** は M12 の後に独立マイルストーン FA として実施(本ファイル末尾)。

## Niagaraパリティマトリクス

| Niagara機能 | 対応マイルストーン | 状態 |
|---|---|---|
| System/Emitter階層・エミッタ継承 | M9 | ⬜ |
| 動的パーティクル属性(カスタム属性→バッファコンパイル) | M1 | ⬜ |
| 名前空間パラメータ (System/Emitter/Particles/User) | M1 | ⬜ |
| GPUシミュレーション(コンピュート) | M1–M2 | ⬜ |
| Spawn: rate / burst / per-distance | M2 | ⬜ |
| エミッタライフサイクル(duration/loop/prewarm) | M2 | ⬜ |
| ローカル時間・タイムスケール(ヒットストップ) | M2 | ⬜ |
| スプライトレンダラ(整列モード・cutout・フリップブック) | M3 | ⬜ |
| メッシュレンダラ(インスタンス・向きモード) | M3 | ⬜ |
| ソフトパーティクル | M3 | ⬜ |
| フォース群(重力/抗力/渦/引力/カールノイズ) | M4 | ⬜ |
| ベクタフィールド(FGAインポート) | M4 | ⬜ |
| 向き制御・回転・kill volume | M4 | ⬜ |
| GPUイベント&サブエミッタ(属性継承) | M5 | ⬜ |
| 深度バッファ衝突 | M6 | ⬜ |
| 解析的コライダ/SDF衝突 | M6 | ⬜ |
| メッシュ表面サンプリング(静的+スキン) | M6 | ⬜ |
| ソケット/ボーン追従 | M6 | ⬜ |
| リボンレンダラ(マルチリボン・UVモード) | M7 | ⬜ |
| ライトレンダラ | M7 | ⬜ |
| デカールレンダラ | M7 | ⬜ |
| マテリアル表現(dissolve/flow/fresnel = UEマテリアル相当) | M8 | ⬜ |
| VAT(頂点アニメーションテクスチャ)ランタイム | M8 | ⬜ |
| タイムライン/Sequencer統合 | M9 | ⬜ |
| ユーザーパラメータのランタイムAPI | M9 | ⬜ |
| ポスト連携(歪み・ブルーム)・lit particles | M10 | ⬜ |
| αソート/OIT | M10 | ⬜ |
| スケーラビリティ(品質段階・significance・プーリング) | M11 | ⬜ |
| sim caching(ベイク&リプレイ) | M11 | ⬜ |
| デバッガ(属性スプレッドシート・プロファイラ) | M11 | ⬜ |
| アセットフォーマット&ローダ | M12 | ⬜ |
| Grid2D/3D流体(Niagara Fluids相当) | M12 | ⬜ |
| Neighbor grid / boids / PBD | M12 | ⬜ |

## M0 — 基盤とスパイク 🚧

- [x] リポジトリ初期化:git init、pnpmモノレポ、TypeScript strict、vitest、ESLint/Prettier、CI雛形
- [x] playground雛形(Vite + three.js WebGPURenderer + tweakpane)— TSLマテリアル、`?backend=webgl`切替、device.lost監視HUD付き
- [x] **API RFC**:理想のAPIを型定義+README-drivenで書き切る(`docs/rfc/001-api.md`)。実装より先に型を固める — 全16章+Niagara対応表+未解決事項(スパイク待ち)。型定義(types.ts/api.ts)と北極星コンパイルテスト(正例+@ts-expect-error負例)付き
- [x] スパイク1:TSLコンピュートで10万パーティクル(ストレージバッファ、instanced描画)— /spike-compute/ ページ+tools/spike-runner.mjs。ヘッドレス実証済み(数値の詳細はPLAN決定事項ログ)
- [x] スパイク2:drawIndirect / dispatchIndirect の可否と生存数駆動描画 — 間接描画引数のGPU駆動+dispatchIndirect(X=ceil(alive/64))をreadback実証。**注**: drawIndexedIndirect実行自体のWindows実GPU目視はM0監査時に実施(ヘッドレスはpresent不可のため)
- [x] スパイク3:WebGL2バックエンドでの同コードの動作範囲実測 — サポートマトリクス実測済み(コンピュート/readback=可、アトミクス/間接=不可)。詳細はPLAN決定事項ログ
- [x] スパイク4:深度テクスチャアクセス(ソフトパーティクル)とTSLポストパイプラインの共存確認 — /spike-depth/ で両立実証(WebGL2ピクセル検証+目視、WebGPUはencode成功まで)。ポスト統合点はRenderPipeline
- [x] パフォーマンス計測ハーネス(FPS/フレーム時間/JSヒープ/描画コール数+**GPU timestamp query**をplaygroundに常設、`vfx.perf-baseline` schema v1、spike-runnerで回収可)— SwiftShaderでもtimestamp-query利用可と実証(100k粒子 computeMs≈5ms)
- [x] 検証ハーネス:Playwrightをリポジトリに導入し、WebGPUプローブ(`--adapter swiftshader|vulkan|default`)とスクリーンショット取得ユーティリティ(診断収集付き)を `tools/` に整備。ヘッドレスWebGPUは「コンピュート可・canvas提示不可」と実測し、スクリーンショット回帰はWebGL2バックエンドで行う方針をPLAN.mdに記録
- [ ] ライブラリ名の決定(**ユーザー判断待ち**。LICENSE=MIT・CLAUDE.mdは作成済み。名前決定後: LICENSE holder更新・@vfx/*改名・package.jsonにlicenseフィールド追加)
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M1 — コンパイラ&データモデル

- [ ] 属性システム:属性宣言→ストレージバッファレイアウト(std430相当)の自動割付
- [ ] モジュールインターフェース定義(read/write属性の宣言、ステージ所属)
- [ ] モジュール合成→TSL initカーネル/updateカーネル生成(コンパイラ本体)
- [ ] 名前空間パラメータ(System/Emitter/Particles/User)とuniformバッファ束ね
- [ ] 決定論的乱数(PCGハッシュ、シード管理)
- [ ] curve()/gradient() → LUTテクスチャベイク
- [ ] tslModule() エスケープハッチ
- [ ] コンパイラのユニットテスト(生成カーネルのスナップショット+数値検証)
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M2 — スポーンとライフサイクル

- [ ] GPUフリーリスト(アトミックカウンタによる確保/解放)
- [ ] 生存数駆動のdrawIndirect(WebGL2フォールバック方針含む)
- [ ] spawn: rate / burst / per-distance(移動量比例)
- [ ] エミッタライフサイクル:duration、loop回数、遅延、prewarm
- [ ] エフェクトローカル時間、タイムスケール、fixed timestepオプション
- [ ] VFXSystemスケジューラ(複数エフェクト・複数エミッタの更新統括)
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M3 — レンダラ第一陣

- [ ] スプライトレンダラ:カメラフェーシング/速度整列/カスタム軸/velocity stretch
- [ ] フリップブック再生(補間、モーションベクタブレンディング)
- [ ] cutout(オーバードロー削減ポリゴン)
- [ ] メッシュレンダラ(インスタンス、向きモード、per-particleカラー/スケール)
- [ ] ソフトパーティクル(depthFade)
- [ ] ブレンドモード一式(additive/alpha/multiply/premultiplied)
- [ ] 🎯 ゴールデン#2「爆発」(歪みなし版)がplaygroundで動く
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M4 — ビヘイビアライブラリ

- [ ] フォース:gravity / drag / vortex / pointAttractor / linearForce
- [ ] curlNoise / turbulence(シンプレックスベース)
- [ ] ベクタフィールド:FGAローダ+3Dテクスチャサンプリング
- [ ] sizeOverLife / colorOverLife / rotationOverLife / velocityOverLife
- [ ] 向き制御:orientToVelocity / faceCamera / カスタム
- [ ] killVolume(box/sphere/plane)、寿命外強制回収
- [ ] 🎯 ゴールデン#4「環境ループ」が動く
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M5 — イベント&サブエミッタ

- [ ] GPUイベント基盤:appendバッファ+次フレーム消費
- [ ] onDeath / onCollision / onCustom イベント発火
- [ ] イベントハンドラエミッタ(属性継承つきスポーン)
- [ ] イベント→JSコールバック(ゲームプレイ連携、readback節度の設計)
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M6 — ワールドインタラクション

- [ ] 深度バッファ衝突(バウンス・摩擦・消滅)
- [ ] 解析的コライダ:plane / sphere / box
- [ ] SDFテクスチャ衝突(SDFベイクユーティリティ含む)
- [ ] 静的メッシュ表面サンプリング(スポーン位置・法線)
- [ ] スキンメッシュ表面サンプリング(TSLでのスキニング済み頂点取得)
- [ ] ソケット/ボーン追従(Object3D/Bone参照のトランスフォーム束縛)
- [ ] 🎯 ゴールデン#6「キャラクター付随」が動く
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M7 — レンダラ第二陣

- [ ] リボン/トレイルレンダラ:パーティクル連結、マルチリボン、UVモード(tiled/stretched)
- [ ] 幅カーブ・テーパー、武器軌跡ユースケース
- [ ] ライトレンダラ(上限管理つきPointLightプール or エミッシブ+ブルーム方式の選定)
- [ ] デカールレンダラ
- [ ] 🎯 ゴールデン#1「斬撃」(ポスト以外)が動く
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M8 — メッシュFX & tsl-kit

- [ ] tsl-kit:dissolve / uvFlow / polarUV / fresnel / rimLight / distortionUV / flowMap
- [ ] fxMaterial(部品を宣言的に合成するマテリアルファクトリ)
- [ ] mesh-fx:slashArc / ring / cylinder / cone / 魔法陣(手続き的ジオメトリ+UV設計)
- [ ] VATランタイム(Blender公式VATアドオンの出力と互換)
- [ ] tsl-kit単体npm公開準備(独立README、通常マテリアルでの使用例)
- [ ] 🎯 ゴールデン#3「チャージ魔法陣」が動く
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M9 — 合成とタイムライン

- [ ] defineEffect:エミッタ+メッシュFXの束ね、エミッタ継承・オーバーライド
- [ ] timeline:at()/play()/stop()、トラック評価、ループ・スピード制御
- [ ] cameraShake / hitStop(ローカル時間との統合)
- [ ] User.*パラメータのランタイム設定API(型付き)
- [ ] エフェクト全体のプーリングと再利用(spawn/release)
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M10 — ポスト統合と半透明

- [ ] スクリーン歪みパス(shockwave / heat haze)
- [ ] ラジアルブラー、ブルームプリセット(TSLポストパイプライン統合)
- [ ] αソート:エミッタ単位粗ソート → GPUバイトニックソート
- [ ] WBOIT(加重OIT)オプション
- [ ] lit particles(ノーマルマップ付きスプライトのライティング)
- [ ] 🎯 ゴールデン#2完全版・#5「必殺技カットイン」が動く
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M11 — スケーラビリティ&デバッグ

- [ ] 品質段階(quality tiers)とデバイス自動判定
- [ ] 距離/視錐台カリング、significance manager(予算内で重要エフェクト優先)
- [ ] sim caching:ベイク&リプレイ(ロード時プリコンピュート)
- [ ] 属性スプレッドシート(GPU readbackによるデバッグ表示)
- [ ] プロファイラオーバーレイ(エミッタ別コスト)
- [ ] モバイル実機検証と最適化パス
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## M12 — アセット&エコシステム&上級シム

- [ ] JSONアセットフォーマットv1(スキーマ、シリアライザ、ローダ、バージョンマイグレーション)
- [ ] 🎯 ゴールデン#5がJSONからロードして再生できる
- [ ] R3Fバインディング(@vfx/react)
- [ ] ドキュメントサイト+デモギャラリー公開
- [ ] npm公開(changesets等でリリース自動化)
- [ ] Grid2Dスモーク/炎シミュレーション(sim stages基盤)
- [ ] Grid3D流体(Niagara Fluids相当、ストレッチ)
- [ ] neighbor grid(boids)、PBD的拘束(ストレッチ)
- [ ] Effekseerインポータ調査(実装判断はここで)
- [ ] 🎯 ゴールデン#7「流体風の煙」が動く
- [ ] 🔍 **マイルストーン監査**(別セッションで監査プロトコルを実施し、結果をセッションログに記録)

## FA — 最終監査(1.0リリースゲート)

全マイルストーン監査の通過が前提。ここは「作った本人以外の目」を最大限入れるフェーズ。

- [ ] パリティマトリクス全項目の実挙動再検証(1項目ずつ動かし、Niagaraとの残差分を `docs/parity-report.md` に最終文書化)
- [ ] ゴールデンエフェクト7本の全回帰+実GPU(Windows側ブラウザ)での目視・性能確認
- [ ] パフォーマンス予算の最終計測:ミドル帯ノートiGPUで5万パーティクル+エミッタ10本+ポスト一式60fps、ミドル帯スマホ実機で30fps
- [ ] 全体コードレビュー:`/code-review ultra`(ユーザー起動)によるマルチエージェントレビュー、指摘の全件処理
- [ ] `/security-review` + 依存関係監査(npm audit、ライセンス互換、サプライチェーン確認)
- [ ] API安定性レビュー:RFC最終整合、semver方針の明文化、非推奨・実験的APIの整理
- [ ] ドキュメント完全性:全公開APIリファレンス、入門ガイド、Niagaraユーザー向け対応表、デモギャラリー
- [ ] バンドルサイズ計測と予算判定(tree-shaking検証、パッケージ別サイズ表)
- [ ] npm publish dry-run、README/CHANGELOG最終化
- [ ] **1.0リリース判定**(不合格項目は該当マイルストーンへ差し戻し、修正後にFA再実施)

## セッションログ

| 日付 | セッション成果 |
|---|---|
| 2026-07-10 | エコシステム調査、計画策定、PLAN.md/ROADMAP.md作成 |
| 2026-07-10 | 環境セットアップ:Playwright+Chromium導入、ヘッドレスWebGPU動作確認(SwiftShader・compute成功・要localhost)、監査プロトコル+FA新設、.mcp.json(Playwright MCP)作成 |
| 2026-07-10 | M0項目1/2/9完了:雛形実装(Codex, thread 019f4b46)→検収→Claudeレビュー(FAIL: tweakpane型崩壊+ヘッドレスcanvas提示不可)→Codex修正→再レビューPASS→コミット。持ち越しNIT2件(probe引数検証のObject.hasOwn化、screenshotのバックエンド一致検証)は次回委譲に含める。Codexジョブランナーが2回ともゾンビ化(実体turnは完走)→rolloutログ直接監視で運用 |
| 2026-07-10 | M0項目3完了:API RFC起草(Codex)+前回NIT2件修正→Claude設計レビュー(FAIL: BLOCKER2件=defineEffectパラメータ制約バグ・tslModule空マニフェスト自己矛盾、SHOULD7・NIT9)→Codex全件修正→再レビューPASS(検証パスで型プローブ+実行スモーク)→コミット |
| 2026-07-10 | スパイク1完了・スパイク2ほぼ完了:/spike-compute/実装(Codex)+RFC持ち越し4件解消→統括検収(ヘッドレス実測: atomicOk/indirectOk全true、aliveCount=91327一致)→Claudeレビュー PASS(独立再現済み)→コミット |
| 2026-07-10 | スパイク2完遂・3・4完了:WebGL2サポートマトリクス実測、dispatchIndirect実証、深度+ポスト共存実証(/spike-depth/)、前回持ち越し7件全解消→Claudeレビュー PASS(全数値を独立再現)→コミット。**次回委譲への持ち越し**: [SHOULD] PostProcessing→RenderPipeline改名、[NIT] depth-fade比較に部分可視アサーション/runnerのadapterInfo→webgpuAdapterInfo改名/dispatchプローブのガード外し/WebGL2アトミックプローブのエラーシグネチャ照合/WebGPU深度スパイクのreadRenderTargetPixelsAsyncピクセル検証化。**ユーザー対応待ち**: Windows実GPU目視(/spike-compute/ と /spike-depth/)はM0監査時に |
| 2026-07-10 | M0最終バッチ完了:常設perf計測(GPU timestamp query対応、SwiftShaderで実測成功=真のGPU時間5ms vs encode 0.03msの乖離を定量化)、LICENSE(MIT)、CLAUDE.md、持ち越し6件+検収発見の退行(正規表現語順)+runnerエラー隠蔽を修正→Claudeレビュー PASS→コミット。**持ち越しNIT3件**: fade閾値0.35の校正根拠コメント+定数一元化/perf.tsのavailable→pending戻り/packages/core/package.jsonにlicenseフィールド。**M0残**: ライブラリ名決定(ユーザー判断)、マイルストーン監査(別セッション、Windows目視3項目=間接描画実行・WebGPU深度フェード・perf HUD含む) |
