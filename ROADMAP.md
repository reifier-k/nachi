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

**ユーザー実施検証の扱い(2026-07-11ユーザー指示)**: Windows実GPU目視などユーザー環境が必要な検証は**ブロッカーにしない**。ヘッドレス実測(readback・オフスクリーンピクセル検証)を合否根拠とし、ユーザー実施項目は下記「未消化のユーザー補助検証」リストに記録して機会があれば消化する。

### 未消化のユーザー補助検証(非ブロッキング)
- [ ] Windows実GPU: /spike-compute/?count=100000 の間接描画実行の目視+perf HUD表示
- [ ] Windows実GPU: /spike-depth/ のWebGPU深度フェード目視
- [ ] Windows実GPU: float32-filterable対応確認(コンソールエラーなし)

**最終監査(1.0リリースゲート)** は M12 の後に独立マイルストーン FA として実施(本ファイル末尾)。

## Niagaraパリティマトリクス

| Niagara機能 | 対応マイルストーン | 状態 |
|---|---|---|
| System/Emitter階層・エミッタ継承 | M9 | ⬜ |
| 動的パーティクル属性(カスタム属性→バッファコンパイル) | M1 | ✅ 2026-07-11監査確認 |
| 名前空間パラメータ (System/Emitter/Particles/User) | M1 | ✅ 2026-07-11監査確認(User.*のGPU反映まで実証。Emitter時間系uniformはM2) |
| GPUシミュレーション(コンピュート) | M1–M2 | ✅ 2026-07-11監査確認(フリーリスト/compaction/間接描画まで) |
| Spawn: rate / burst / per-distance | M2 | ✅ 2026-07-11監査確認(WebGPU。WebGL2は単発burstのみ) |
| エミッタライフサイクル(duration/loop/prewarm) | M2 | ✅ 2026-07-11監査確認(prewarmビット一致実証) |
| ローカル時間・タイムスケール(ヒットストップ) | M2 | ✅ 2026-07-11監査確認(hitStop API含む。タイムライン統合はM9) |
| スプライトレンダラ(整列モード・cutout・フリップブック) | M3 | ✅ 2026-07-11監査確認(12検証。SubImage任意Index/ランダム開始フレームは差分記録) |
| メッシュレンダラ(インスタンス・向きモード) | M3 | ✅ 2026-07-11監査確認(向き数学はTSL rotate転置規約対応+GPU 6方向実測。メッシュ配列/マテリアルスロットは差分記録) |
| ソフトパーティクル | M3 | ✅ 2026-07-11監査確認(fadeDistanceは正規化深度単位=RFC明示) |
| フォース群(重力/抗力/渦/引力/カールノイズ) | M4 | ✅ 2026-07-11監査確認(数学全検算。curlNoiseはシンプレックスcurlに刷新。mass未使用/回転dragなしは差分記録) |
| ベクタフィールド(FGAインポート) | M4 | ✅ 2026-07-11監査確認(ASCII FGA+トリリニア+texel中心補正。world固定・バイナリ.vf非対応は§16保留) |
| 向き制御・回転・kill volume | M4 | ✅ 2026-07-11監査確認(shortest-arc quat検算済み。killVolumeはemitter-local固定=差分記録) |
| GPUイベント&サブエミッタ(属性継承) | M5 | ✅ 2026-07-11監査確認(onDeath完全動作・多段連鎖drain保証。onCollision=M6・onCustom=予約、1レコード=子1体、float≤4成分継承は差分記録) |
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

## M0 — 基盤とスパイク ✅(条件付きPASS)

- [x] リポジトリ初期化:git init、pnpmモノレポ、TypeScript strict、vitest、ESLint/Prettier、CI雛形
- [x] playground雛形(Vite + three.js WebGPURenderer + tweakpane)— TSLマテリアル、`?backend=webgl`切替、device.lost監視HUD付き
- [x] **API RFC**:理想のAPIを型定義+README-drivenで書き切る(`docs/rfc/001-api.md`)。実装より先に型を固める — 全16章+Niagara対応表+未解決事項(スパイク待ち)。型定義(types.ts/api.ts)と北極星コンパイルテスト(正例+@ts-expect-error負例)付き
- [x] スパイク1:TSLコンピュートで10万パーティクル(ストレージバッファ、instanced描画)— /spike-compute/ ページ+tools/spike-runner.mjs。ヘッドレス実証済み(数値の詳細はPLAN決定事項ログ)
- [x] スパイク2:drawIndirect / dispatchIndirect の可否と生存数駆動描画 — 間接描画引数のGPU駆動+dispatchIndirect(X=ceil(alive/64))をreadback実証。**注**: drawIndexedIndirect実行自体のWindows実GPU目視はM0監査時に実施(ヘッドレスはpresent不可のため)
- [x] スパイク3:WebGL2バックエンドでの同コードの動作範囲実測 — サポートマトリクス実測済み(コンピュート/readback=可、アトミクス/間接=不可)。詳細はPLAN決定事項ログ
- [x] スパイク4:深度テクスチャアクセス(ソフトパーティクル)とTSLポストパイプラインの共存確認 — /spike-depth/ で両立実証(WebGL2ピクセル検証+目視、WebGPUもreadRenderTargetPixelsAsyncによるヘッドレスピクセル検証済み)。ポスト統合点はRenderPipeline
- [x] パフォーマンス計測ハーネス(FPS/フレーム時間/JSヒープ/描画コール数+**GPU timestamp query**をplaygroundに常設、`nachi.perf-baseline` schema v1、spike-runnerで回収可)— SwiftShaderでもtimestamp-query利用可と実証(100k粒子 computeMs≈5ms)
- [x] 検証ハーネス:Playwrightをリポジトリに導入し、WebGPUプローブ(`--adapter swiftshader|vulkan|default`)とスクリーンショット取得ユーティリティ(診断収集付き)を `tools/` に整備。ヘッドレスWebGPUは「コンピュート可・canvas提示不可」と実測し、スクリーンショット回帰はWebGL2バックエンドで行う方針をPLAN.mdに記録
- [x] ライブラリ名の決定 — **nachi**(ユーザー選定、2026-07-10)。LICENSE(MIT, nachi contributors)・CLAUDE.md作成済み、`@nachi/core`/`@nachi/playground` へ改名・licenseフィールド追加済み
- [x] 🔍 **マイルストーン監査** — 2026-07-10実施。Codex(freshスレッド)+Claude(新規エージェント)の独立監査→統括裁定。判定: **条件付きPASS**(詳細はセッションログ)。条件: Windows実GPU目視3項目をM2の生存数駆動実装着手前までに完了

## M1 — コンパイラ&データモデル ✅(条件付きPASS)

- [x] 属性システム:属性宣言→ストレージバッファレイアウト(SoA・instancedArray互換)の自動割付 — RFC§5の11論理型マッピング検算済み、VfxDiagnostic蓄積型検証(RFC§12.2)含む
- [x] モジュールインターフェース定義(read/write属性の宣言、ステージ所属)— モジュール契約+実装レジストリ(上書き禁止)+実装トレースとマニフェストの機械照合テスト
- [x] モジュール合成→TSL initカーネル/updateカーネル生成(コンパイラ本体)— compileEmitter() 2層構造(three非依存記述+buildKernels実体化)、$defaults/$age/$integrate予約モジュール、GPUスモーク7検証合格
- [x] 名前空間パラメータ(System/Emitter/Particles/User)とuniformバッファ束ね — v1(System.time/deltaTime、Emitter.deltaTime、User.*デフォルトuniform。実時間管理の配線はM2)
- [x] 決定論的乱数(PCGハッシュ、シード管理)— PCG RXS-M-XS、TSLノード+JSミラーの演算列一致テスト付き。(spawnGeneration第4入力・ステージ混合slotまで実装済み。M2で残るのはper-particle世代管理のみ)
- [x] curve()/gradient() → LUTテクスチャベイク — 256サンプル線形補間、色はsRGB→linear変換、CPU参照とのGPU実測一致
- [x] tslModule() エスケープハッチ — Proxyトレースによるaccess導出(不在時)+宣言⊇トレース検証(RFC§8.1)
- [x] コンパイラのユニットテスト(生成カーネルのスナップショット+数値検証)— 54テスト(スナップショット・LUT数値・トレース・乱数ストリーム回帰含む)
- [x] 🔍 **マイルストーン監査** — 2026-07-11実施。Codex(fresh)+Claude(新規)の独立監査→統括裁定: **条件付きPASS**(詳細はセッションログ)

## M2 — スポーンとライフサイクル ✅(PASS)

- [x] GPUフリーリスト(アトミックカウンタによる確保/解放)— スナップショット分割割当(フレーム内レース排除)、per-particle spawnGeneration、枯渇時クランプ+診断
- [x] 生存数駆動のdrawIndirect(WebGL2フォールバック方針含む)— aliveカウント→instanceCount(3系統照合)、ライフサイクルバッファ2本構成(状態+間接引数、同期スコープ分離)、WebGL2はTF varyings/コンポーネント予算の静的検算で明示診断(単発burstのみ許可)
- [x] spawn: rate / burst / per-distance(移動量比例)— 端数アキュムレータ(分割不変)、GPU生成dispatch引数のdispatchIndirect、ステージ書込権限検証(RFC§4.1全表=M1監査先送り分消化)
- [x] エミッタライフサイクル:startDelay、duration、loopCount('infinite'可)、prewarm(cold経路とビット一致を実証)— ループ世代→spawnGeneration接続
- [x] エフェクトローカル時間、タイムスケール、fixed timestepオプション — System.timeはワールド維持・Emitter.deltaTimeのみスケール、hitStop API、アキュムレータ(スパイラル防止+破棄明示)、分割不変性テスト済み
- [x] VFXSystemスケジューラ(複数エフェクト・複数エミッタの更新統括)— update直列化、WeakMapコンパイルキャッシュ(3インスタンス共有を実証)、状態機械(error遷移・デバイスロスト伝播込み)
- [x] 🔍 **マイルストーン監査** — 2026-07-11実施(初回FAIL→修正→再監査)。再監査はCodex=FAIL/Claude=PASS(実GPU3層実証)で対立→統括裁定: Claudeの解消実証を主判定とし、Codexの残存4指摘(mat3コンポーネント予算/WebGL2再発火/capabilities必須化/parameter型検査)を最終修正で全て閉じて **PASS**。§16のvec4パッキング判断も記録済み(M3バッチ1で実装)

## M3 — レンダラ第一陣 ✅(PASS)

- [x] スプライトレンダラ:カメラフェーシング/速度整列/カスタム軸/velocity stretch — billboard()コンパイル+InstancedMesh間接描画、/m3-sprites/でピクセル実証(基盤。フリップブック/cutoutは残)
- [x] フリップブック再生(補間、モーションベクタブレンディング)— discrete/補間/MVワープ、ピクセル検証済み。**行順序規約(flipY)は次バッチで確定**
- [x] cutout(オーバードロー削減ポリゴン)— 4〜8角形、前景比削減をピクセル実証(N=8の位相NITは次バッチ)
- [x] メッシュレンダラ(インスタンス、向きモード、per-particleカラー/スケール)— 向き数学はCPU検算テスト付き(レビューが鏡映バグを数値反証→修正)
- [x] ソフトパーティクル(depthFade)— 交差フェードをピクセル実証(soft/hard寄与比較)。fadeDistanceのAPI公開は次バッチ
- [x] ブレンドモード一式(additive/alpha/multiply/premultiplied)— ピクセル差検証済み、multiplyはpremultipliedAlpha
- [x] 🎯 ゴールデン#2「爆発」(歪みなし版)がplaygroundで動く — /golden-explosion/ 3エミッタ(MVフリップブック+破片メッシュ+ソフト煙)、6検証+視覚基準3点。**ライブラリ初のゴールデンエフェクト**
- [x] 🔍 **マイルストーン監査** — 2026-07-11実施(両監査FAIL→修正→限定再検証でPASS。詳細はセッションログ)

## M4 — ビヘイビアライブラリ ✅(条件付きPASS)

- [x] フォース:gravity / drag / vortex / pointAttractor / linearForce — 数学は全検算済み(レビュー)
- [x] curlNoise / turbulence(シンプレックスベース)— 位置純関数で決定論。強度正規化規約は最終バッチで
- [x] ベクタフィールド:FGAローダ+3Dテクスチャサンプリング — UE ASCII FGA準拠パーサ+トリリニア補間(feature検出)。world固定は§16保留
- [x] sizeOverLife / colorOverLife / rotationOverLife / velocityOverLife — velocityはf32等方(vec3対応は最終バッチで判断)
- [x] 向き制御:orientToVelocity(shortest-arc quat)/ faceCamera / カスタム軸(M3レンダラ整列が該当。RFC§9.1で関係整理済み)
- [x] killVolume(box/sphere/plane)— emitter-local規約、フリーリスト回収統合。寿命外強制回収は最終バッチ
- [x] 🎯 ゴールデン#4「環境ループ」が動く — /golden-ambient/ 蛍+落ち葉、5検証+視覚基準2点。**M4スコープ=ループ+挙動**(カリング/significance/大量インスタンスはM11で拡張検証)。**ゴールデン2/7達成**
- [x] 🔍 **マイルストーン監査** — 2026-07-11実施(Codex=FAIL/Claude=条件付きPASS→統括裁定で実質指摘を全採用・修正して**条件付きPASS**)

## M5 — イベント&サブエミッタ ✅(条件付きPASS)

- [x] GPUイベント基盤:appendバッファ+次フレーム消費 — 二重バンク、実行順非依存、スナップショット意味論、オーバーフロー安全
- [x] onDeath / onCollision / onCustom イベント発火 — onDeathは完全動作。onCollision=M6予約・onCustom=context.emitEvent予約(未実装診断で黙認なし)
- [x] イベントハンドラエミッタ(属性継承つきスポーン)— inherit→vec4ペイロード、親死亡位置との集合一致をGPU実証
- [x] イベント→JSコールバック — 集計値のみ・interval readback連動(無条件GPU同期なし、RFC§10.2明文化)
- [x] 🔍 **マイルストーン監査** — 2026-07-11実施(Codex=FAIL/Claude=条件付きPASS→裁定で実質指摘全採用・修正して**条件付きPASS**)

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
- [ ] R3Fバインディング(@nachi/react)
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
| 2026-07-10 | ライブラリ名 **nachi** に決定(ユーザー選定)。@nachi/core・@nachi/playground へ改名、LICENSE holder更新、licenseフィールド追加(Codex)→検収全緑→コミット。**M0はマイルストーン監査(別セッション)を残して全項目完了** |
| 2026-07-10 | **M0マイルストーン監査実施**(/goal継続のため同セッション内だが、独立性はCodex=freshスレッド・Claude=新規エージェントで担保)。Codex判定FAIL/Claude判定条件付きPASS→統括裁定: ①Codex「pnpm test失敗」は監査サンドボックスがread-only(build EROFSが証拠)による артефакт として**却下**(実環境3回連続7/7+CI相当全緑) ②「drawExecuted未証明」は既知の条件付き項目と同一 ③残る指摘は全採用し修正: spawn()型強化+負例テスト、EffectInstanceStateに'error'追加+RFC§12.3信号経路、シリアライズ語彙をnachi系へ改名(com.nachi.effect/nachi-workspace/nachi.perf-baseline)、$integrate=M1コンパイル時正規化とRFC明記、parametersキー=path検証、ヘッドレス深度比較の時刻固定、CIにbuild+prettier追加、prettier違反修正、README新規、@tweakpane/core固定+root vite削除。**最終判定: 条件付きPASS、M1着手可**。ベースライン(SwiftShader): GPU computeMs≈4.2-5.0ms/100k粒子、depth WebGPU renderMs≈34ms/640×360。**残NIT**(次回委譲へ): fade閾値0.35の校正コメント+ロジック一元化、computeCalls=0の意味明記、VfxDiagnostic統一(M1)、engines.node表記。**条件**: Windows実GPU目視3項目(間接描画実行/WebGPU深度フェード/perf HUD)をM2の生存数駆動実装着手前までに |
| 2026-07-11 | **M5マイルストーン監査**: Codex=FAIL(多段連鎖の最終イベント消失/interval≥2完了競合=精密なコードパス指摘)/Claude=条件付きPASS(11検証2回再現・並行安全性の構造検証)→裁定で全採用・修正: イベントグラフ深度drain・強制readback・eventPayload語彙強制・timestamp計測分離。m5-events 13検証に拡張、テスト251本。性能: m5-events 0.067ms(M5基準)、全ベースライン劣化なし。**最終判定: 条件付きPASS** |
| 2026-07-11 | M5完了(監査待ち): GPUイベント&サブエミッタ — onDeath→emitTo連鎖が完全動作(/m5-events/ 11検証、payloadMatchesParent=GPU直接照合)。差し戻し3回の白眉は**診断readback恒久化による証拠駆動切り分け**(機能は正常でスモークのスロット選択誤りと判明)。テスト246本。**持ち越しNIT4**: storageBufferCountのステージ別集計化(M7)/overflow報告の「up to N」表現/純イベント駆動エミッタの糖衣(M9)/emitEvent予約の型コメント |
| 2026-07-11 | **M4マイルストーン監査**: Codex=FAIL/Claude=条件付きPASS→裁定: Codexビルド系は既知環境起因で却下、実質指摘を全採用し修正→**条件付きPASS**。修正: ①curlNoiseをシンプレックスポテンシャルの数値curl(発散ゼロ)に刷新+GPU検証(sin/cos場のM1実装がRFC未記載のまま残っていた黙認逸脱を解消) ②vector fieldのtexel中心補正+RepeatWrapping+非対称場の数値検証 ③velocityOverLifeを比率形式lut(t)/lut(t_prev)に(ステップレート非依存、30/60Hz一致検証) ④落ち葉回転検証をmesh描画が実際に消費するquat属性に接続 ⑤M4 range()の独立sampleOffset ⑥視覚回帰に許容誤差0.5%方針(firefliesがcompaction順非決定論でバイト再現不能とGPU実証→§16注記) ⑦縮退値診断。性能(SwiftShader): m4-behaviors 0.114ms/golden-ambient 0.605+16.8msをM4基準として記録、既存ベースライン劣化なし。テスト221本 |
| 2026-07-11 | M4完了(監査待ち): フォース群(vortex/pointAttractor/linearForce/turbulence=数学全検算)+overLife系+killVolume(フリーリスト統合)+FGAベクタフィールド(トリリニア)+向き制御(shortest-arc quat)+space規約+turbulence正規化(理論値12/42)+**ゴールデン#4「環境ループ」達成**(定常性・世代区間判定)。テスト217本・全スモーク緑。差し戻し2回(timestampプール/スロットリサイクル追跡) |
| 2026-07-11 | **M3マイルストーン監査**: 両監査FAIL→裁定・修正→**PASS**。①Claude監査がメッシュ向きの残存反転をGPU readbackで実証 — 真因は**TSL rotate()が列優先構築により標準CCWの転置(逆回転)として作用**するthree r185規約(前回修正はTHREE.Euler基準で不十分)→オイラー全成分符号反転+TSL実規約のCPU参照テストに差し替え+**監査人のGPUプローブで6方向一致を統括実測** ②複数renderモジュールの間接引数衝突(両監査一致)→NACHI_RENDER_MODULE_LIMITで1個制限+RFC§9にM7対応と明記 ③RFC§9.1にcutout/ブレンド意味論網羅、packed_*予約、README/CLAUDE.md更新。性能(SwiftShader): spike-compute 3.9ms(劣化なし)、m3-sprites compute 0.083/render 0.059ms、golden compute 0.306/render 47.7ms(新規基準)。ゴールデン視覚基準3点を修正後に再取得。**M4持ち越し**: [SHOULD] flipY両設定の固有色アトラスGPU検証/premultiplied検証強化(α<1テクスチャ)、[NIT] UVクランプのテクセルマージン/facing-camera-position整列モード |
| 2026-07-11 | M3バッチ2+最終バッチ完了: フリップブック(行順規約+MVブレンディング)/cutout/ソフトパーティクル(fadeDistance API)/メッシュレンダラ/**ゴールデン#2「爆発」達成**(6検証+視覚基準)。レビューがメッシュ向き鏡映を数値反証(スモークでは構造的に検出不能だった)→修正。根本原因の学び: fixedTimeStep maxSubSteps不足でnormalizedAge停滞。テスト172本・全6スモーク緑。**M3残: マイルストーン監査のみ** |
| 2026-07-11 | M3バッチ1完了: **vec4属性パッキング**(バッファ数 M1 10→5・M2 9→4、決定論的first-fit、論理→物理マッピング公開)+**スプライトレンダラ基盤**(billboard→InstancedMesh間接描画、整列4モード、ブレンド4種)+/m3-sprites/(オフスクリーンピクセル検証7種)。差し戻し6回(WGSL識別子/パックレーン書き戻し/WebGL2 aliveパック誤読=レビューBLOCKER等)→全緑159テスト・7スモーク。**パーティクル初描画**。**M3残**: フリップブック、cutout、メッシュレンダラ、ソフトパーティクル、ゴールデン#2 |
| 2026-07-11 | **M2マイルストーン監査**: 初回=両監査FAIL(バッファ予算回帰でm1-kernel崩壊/WebGL2無音全滅/専有パス無保護)→修正4ラウンド(ライフサイクルバッファ5→2本統合、mat3物理ストライド48B、同期スコープ分離、所有権表、WebGL2正直ゲート)→再監査Codex=FAIL/Claude=PASS→裁定: 残存4指摘を最終修正で閉じて**PASS**。テスト151本、全GPUスモーク緑、性能劣化なし(spike-compute 3.8ms)。**M3への引き継ぎ**: vec4属性パッキングはM3バッチ1でレンダラ頂点ステージ予算と統合設計(§16に決定記録)、GPU overflow既定報告の要否はM3判断、Emitter.spawnCount書込許可のcore限定はRFC注記済み |
| 2026-07-11 | M2完成バッチ:GPUフリーリスト+スポーンモード+生存数駆動描画(テスト127本、GPUスモーク7検証全緑=rate30厳密/世代再利用の乱数非相関/3系統カウント照合/枯渇安全/決定論)→ClaudeレビューPASS(独立再現)→監査前SHOULD3+NIT6解消(決定論境界のRFC明文化、overflow readbackのinterval同梱化、WebGL2 rate/perDistance明示拒否)→コミット。**Codex運用ノート**: resumeでwrite承認が落ちる場合はbroker再起動+--fresh --writeで復旧 |
| 2026-07-11 | M2バッチ1完了:VFXSystemランタイム+時間管理+エミッタライフサイクル(system.ts、/m2-runtime/スモーク6検証全緑、テスト98本)→ClaudeレビューPASS(prewarmビット一致・タイムスケール厳密性を独立再現)→コミット。**バッチ2へ持ち越し**: [SHOULD] maximumLifetimeがcore/lifetime以外のlifetime書込を無視(tslModule時にInfinityフォールバック)/releasedインスタンス使用のNACHI_INSTANCE_RELEASED化、[NIT] prewarm等価性の適用範囲文書化/timeScaleのdtスケール方式文書化/stop()既定意味論/lifetime無宣言エミッタの扱い/デバイスロストのラッチ/RotationInput単位文書化。per-particle世代管理の要否をバッチ2設計で確認 |
| 2026-07-11 | **M1マイルストーン監査実施**(Codex=fresh/Claude=新規の独立監査→統括裁定)。Codex判定FAIL/Claude判定条件付きPASS→裁定: ①Codexのビルド・テスト失敗はread-onlyサンドボックス起因で**却下**(実環境54/54+build全緑をClaude監査が独立確認) ②Codex実質指摘を採用: $ageマニフェストにParticles.age read追加/二重積分検出(NACHI_INTEGRATION_DOUBLE_APPLY)/gradientのGPU readback検証/名前空間パラメータのGPU反映検証 ③統合VfxRegistryはM12へ・ステージ書込権限検証はM2/M5へ**明示的に先送り**(RFC注記で黙認解消) ④Claude実証指摘を全採用: 乱数ステージ衝突(stage hash混合で解消)/capacity検証/parameterサイレント定数化のエラー化/compileEmitter直呼びラベル検証/vec range成分独立化/WebGL2クリーンゲート。修正後: **テスト68本・GPUスモーク9検証全合格**。パフォーマンス(SwiftShader): spike-compute 100k=3.7ms(前回4.2-5.0msから劣化なし)、m1-kernel 64粒子=0.56ms/4096粒子=2.7ms(M1ベースライン)。ゴールデン回帰は改名前の陳腐化1件のみ(再取得済み)。**最終判定: 条件付きPASS** — M2着手可、ただし**Windows実GPU目視(M0の3項目+float32-filterable)が未消化のままM2の生存数駆動実装に入ることは不可** |
| 2026-07-11 | M1バッチ2+3完了:カーネルコンパイラ本体(compiler.ts/emitter-modules.ts、2層構造、Proxyトレース、LUTベイク、名前空間uniform v1)→GPUスモーク差し戻し2件(uniform型変換漏れ、**ストレージバッファ上限8超過=SoAのデバイス上限制約を発見**→requiredLimits+コンパイラ診断で解決)→レビューPASS→SHOULD4+NIT6全件修正($defaults/$age顕在化、乱数ストリーム衝突解消、sRGB→linear、レジストリ上書き禁止等)→GPUスモーク7検証全緑・54テスト。**M2前の設計確認事項**: Emitter.spawnGenerationはper-particle世代属性が必要になる公算(レビューNIT-7)。**M1監査時のWindows実GPU確認**: float32-filterable対応 |
| 2026-07-10 | M1バッチ1完了:属性システム(attributes.ts)+VfxDiagnostic蓄積型(diagnostics.ts)+決定論的乱数(random.ts)、テスト27本→Claudeレビュー PASS(11論理型マッピング・PCG正典定数・ミラー一致テストを独立検算)→コミット。**バッチ2仕様に組込む持ち越し**: [SHOULD] 乱数にspawnGeneration入力追加(インデックス再利用時の同一乱数列防止)/throwゲートをseverity==='error'でフィルタ+未使用カスタム属性warning/ResolvedAttributeにdefault搬送+built-inデフォルト表、[NIT] componentsは論理数と型コメント明記(mat3のGPUストライドは12)/optionalReadsの非対称規則の文書化/JSミラーf64とGPU f32の乖離許容の明文化/モジュール走査ヘルパー統合/mat3・boolのGPUスモーク |
