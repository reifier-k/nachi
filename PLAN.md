# PLAN — コードファーストVFXライブラリ(Niagaraパリティ)

> このファイルはプロジェクトの憲法。セッション開始時に必ず読むこと。
> 進捗と作業項目は [ROADMAP.md](./ROADMAP.md) を参照。

## ビジョン

**「UE Niagaraのアーキテクチャから、GUIを引き算してコードAPIにしたもの」** を Three.js / WebGPU (TSL) ネイティブで作る。

- 対象品質:鳴潮・原神クラスのアニメゲームVFXがWebで作れること
- GUIエディタは作らない。ただし**宣言的設定オブジェクト=シリアライズモデル**とし、将来GUIを同じデータモデルの上に載せられる設計にする
- スコープは絞らない。Niagaraの機能セットとの対応表(ROADMAP.mdのパリティマトリクス)を維持し、全項目を目標とする
- パリティの解釈:ランタイム+コードによるオーサリング+コードベースのデバッグツール。GUIエディタ・GUIデバッガのみ対象外

## 設計の核

NiagaraもVFX Graphも実体は「宣言的なモジュール合成をGPUシミュレーションコードにコンパイルする仕組み」。
TSL(JSで書け、WGSL/GLSL両方にコンパイルされるThree.jsのシェーダ言語)があるので、
**モジュール(設定オブジェクト+TSL片)→ コンパイル → コンピュートカーネル生成** を純粋なコードで実現できる。

### API設計原則

1. Niagaraの Spawn / Init / Update / Event / Render のステージモデルを踏襲
2. 全モジュールは純粋な設定データ(=そのままJSONにシリアライズ可能)
3. エスケープハッチとして生のTSL式を注入できる(Niagaraのカスタムスクラッチパッド相当)
4. 名前空間付きパラメータ:`System.*` / `Emitter.*` / `Particles.*` / `User.*`
5. パーティクル属性は動的(エミッタごとに任意の属性セットを定義でき、バッファレイアウトにコンパイルされる)

### APIスケッチ(北極星)

```ts
const sparks = defineEmitter({
  capacity: 500,
  spawn: burst({ count: 200 }),
  init: [
    positionSphere({ radius: 0.2 }),
    velocityCone({ direction: [0, 1, 0], angle: 30, speed: range(4, 8) }),
    lifetime(range(0.4, 0.9)),
  ],
  update: [
    gravity(-9.8),
    drag(0.5),
    curlNoise({ strength: 2, frequency: 0.5 }),
    sizeOverLife(curve([0, 0], [0.1, 1], [1, 0])),
    colorOverLife(gradient('#ffd27d', '#ff5a00', '#000000')),
  ],
  events: {
    onDeath: emitTo('smokePuffs', { inherit: ['position', 'velocity'] }),
  },
  render: billboard({
    map: flipbook(explosionTex, { cols: 8, rows: 8, motionVectors: true }),
    blending: 'additive',
    soft: true,
  }),
})

const arc = slashArc({
  angle: 140,
  material: fxMaterial({
    uv: polarUV().flow({ speed: [2, 0] }),
    dissolve: { texture: noiseTex, overLife: curve([0, 0], [1, 1]) },
    fresnel: { color: '#66ddff', power: 2 },
    blending: 'additive',
  }),
})

const skillSlash = defineEffect({
  elements: { arc, sparks, flash, shockwave },
  timeline: [
    at(0.00, play('flash')),
    at(0.05, play('arc'), cameraShake({ strength: 0.3 }), hitStop(40)),
    at(0.08, play('sparks')),
    at(0.10, play('shockwave')),
  ],
})

const fx = new VFXSystem(renderer, scene)
fx.spawn(skillSlash, { position: hitPoint, rotation: swingDir })
```

カスタムビヘイビア(エスケープハッチ):

```ts
update: [
  tslModule(({ position, velocity, age }) => ({
    velocity: velocity.add(myCustomField(position)),
  })),
]
```

## パッケージ構成(pnpmモノレポ)

```
packages/
  core/       — 属性システム、モジュール→TSLカーネルコンパイラ、バッファ管理、
                生存管理(フリーリスト+drawIndirect)、スケジューラ、パラメータ名前空間
  tsl-kit/    — TSLシェーダ部品集(dissolve, uvFlow, polarUV, fresnel, depthFade,
                distortion, flipbook, curlNoise, sdf…)。単体利用可 → 採用の入口
  mesh-fx/    — 手続き的FXメッシュ(斬撃アーク、リング、円筒、魔法陣)+ fxMaterial + VATランタイム
  trails/     — リボン/トレイルレンダラ、ストレッチビルボード
  timeline/   — シーケンサ、ヒットストップ、カメラシェイク、イベント→ゲームプレイコールバック
  post/       — スクリーン歪み、ラジアルブラー、ブルームプリセット(TSLポストパイプライン統合)
  format/     — JSONスキーマ、シリアライザ/ローダ、バージョニング&マイグレーション
  react/      — R3Fバインディング
apps/
  playground/ — Vite + tweakpaneインスペクタ + デモギャラリー + ゴールデンエフェクト
```

## 主要な技術方針

- **WebGPUファースト**。WebGL2はWebGPURendererのWebGL2バックエンド(transform feedbackエミュレーション)経由で、対応範囲はM0スパイクの実測で確定し、機能制限を明文化する
- 乱数:パーティクルインデックス+シードのハッシュ(PCG系)で決定論的。`Math.random`禁止
- カーブ/グラデーション:LUTテクスチャにベイク(Niagara方式)
- 時間:エフェクトローカル時間をワールド時間から分離(ヒットストップ・タイムスケール対応)、fixed timestepオプション、prewarm対応
- 半透明ソート:加算合成を第一級に。αブレンドはエミッタ単位粗ソート → GPUバイトニックソート → WBOIT(加重OIT)オプションの三段構え
- TSL APIの変動リスク:TSL importを薄いアダプタ層で包み、対応three.jsバージョンをpinする
- sim caching(シミュレーションのベイク&リプレイ)をNiagara同様にサポート — Webではロード時プリコンピュートとして特に価値が高い

## 品質基準:ゴールデンエフェクト

「Niagaraに匹敵」を測定可能にする受け入れテスト。各マイルストーンの完了条件はこれらの再現度で判定する。

1. **斬撃**:アークメッシュ+トレイル+火花+ヒットフラッシュ+シェイク/ヒットストップ
2. **爆発**:モーションベクタ付きフリップブック+衝撃波歪み+破片(メッシュパーティクル)+煙(αソート)
3. **チャージ魔法陣**:極座標UV魔法陣+収束パーティクル+ビーム+ライトレンダラ
4. **環境ループ**:落ち葉・蛍(ループ、カリング、大量インスタンス、significance管理)
5. **必殺技カットイン**:全要素+ポスト+タイムラインの総合振り付け(JSONからロードして再生)
6. **キャラクター付随**:スキンメッシュ表面からのスポーン+ソケット追従(バフオーラ等)
7. **流体風の煙**:Grid2D/3Dシミュレーション(Niagara Fluids相当・ストレッチ目標)

パフォーマンス予算:ミドル帯ノートiGPUで「パーティクル5万+エミッタ10本+ポスト一式」60fps、ミドル帯スマホ30fps。

参考資料:kurie氏のZenn(zenn.dev/kurie)の鳴潮エフェクト分解記事群が表現構造の教科書。

## 競合と差別化(2026-07時点の調査結果)

- **three.quarks**:最も機能が揃うがCPUシミュレーション。アーキテクチャが根本的に異なり合流は非現実的
- **Three-VFX** (mustache-dev):GPUコンピュートだが2026年1月生まれ・R3F前提
- **quarks.art**:商用クローズドの唯一のWebエディタ
- **EffekseerForWeb**:WebGPU版は2026年5月にリポジトリ発足したばかり
- OSSの「TSLネイティブ×フルスコープ×フレームワーク非依存」は空席。ここを取る

## 開発環境(2026-07-10 実測)

- **ツールチェーン**:Node v24.18.0 / pnpm 10.28.2 / npm 11.16.0 / git 2.53.0(WSL2, 24コア, 30GB RAM)
- **GPUの現実**:WSL2に `/dev/dxg` はあるがVulkanは **lavapipe(CPUソフトウェア実装)のみ**。Ubuntu の mesa には dozen(Vulkan-on-D3D12)が含まれず、**Linux側から実GPUのWebGPUは使えない**
- **三層検証戦略**:
  1. **ヘッドレス(CPU)** — Playwright + Chromium(swiftshader / lavapipe)。決定論的なので正しさ検証・スクリーンショット回帰用。性能計測には使わない
  2. **実GPU** — WSL2のdevサーバをWindows側ブラウザ(localhost共有)で開く。性能計測・目視確認はここで
  3. **実機** — モバイル予算(30fps)はスマホ実機で検証(M11以降)
- **Playwright**:Chromium 149(chromium-1228)を `~/.cache/ms-playwright` に導入済み。システムライブラリ(libnss3等)導入済み
- **ヘッドレスWebGPU:動作確認済み(2026-07-10)**。アダプタは SwiftShader(CPU)、コンピュートシェーダ実行+バッファreadback成功。運用上の注意:
  - `navigator.gpu` は **Secure Context のみ** — テストは必ず localhost URL 経由(`about:blank` / `data:` では undefined になる)
  - launch は `channel: 'chromium'`(フルChromiumの新ヘッドレス)+ `--enable-unsafe-webgpu`。headless shell は使わない
  - lavapipe は選択されず SwiftShader にフォールバックする(どちらもCPUで実用差なし)
  - **ヘッドレスWebGPUはコンピュート/readbackのみ可。canvas提示は不可**(初回present直後にデバイス破棄、2026-07-10にthree.js抜きの素WebGPUで切り分け済み)。スクリーンショット回帰は `forceWebGL: true`(WebGL2バックエンド)で行う — TSLは両バックエンドにコンパイルされるため同一シーンで検証可能。WebGPUバックエンドの目視はWindows実GPU層で実施
- **Codexサンドボックスの制約(実測)**:ネットワーク不可(pnpm install不可)・localhostリッスン不可(devサーバ/プローブ実行不可)。ローカルバイナリ実行は可(node_modules導入済みなら typecheck/lint/test は実行可能)。インストールとブラウザ検証は統括の検収工程で実施する
- **MCP**:`.mcp.json` に Playwright MCP を設定(ブラウザ操作・コンソール読取・スクリーンショット)。初回セッションで承認が必要

## セッションプロトコル(/goal 運用)

### 役割分担(固定)

- **Claude本体 = 統括(オーケストレーター)**。仕様整理・委譲・検収・進行管理・ドキュメント更新に徹し、**原則自ら実装しない**
- **Codex = 実装担当**。`/codex:rescue --model gpt-5.6-sol --effort xhigh` で委譲する。**モデルとeffortはこの指定を厳守**(変更はユーザー判断のみ)
- **Claudeサブエージェント = レビュー担当**。実装完了ごとに起動してコードレビュー
- **監査 = CodexとClaudeの両サブエージェント**が独立実施(ROADMAP.mdの監査プロトコル参照)

### 実装セッションのループ

1. `PLAN.md` と `ROADMAP.md` を読む(コンテキスト復元)
2. ROADMAPの次の未完了項目を選び、統括が**実装仕様**をまとめる(目的・受け入れ条件・対象パッケージ・API RFC上の制約・テスト要件)
3. `/codex:rescue --model gpt-5.6-sol --effort xhigh` に実装を委譲
4. 実装後、**Claudeサブエージェントを起動してレビュー**(正しさ・API RFC整合・PLAN方針準拠・テスト妥当性)。指摘はCodexに差し戻して修正、再レビュー
5. レビュー通過後、統括が動作検証(テスト+playgroundのスクリーンショット確認)して**コミット**(conventional commits)
6. `ROADMAP.md` のチェックボックスとセッションログを更新。設計判断は本ファイルの決定事項ログへ(理由も残す)
7. 実装バッチの完了定義に、実態と整合する `README.md` / `CLAUDE.md` の更新を含める
8. 壊れた状態でセッションを終えない

### 監査セッション

マイルストーン監査・最終監査は、**Codexサブエージェント(`/codex:rescue --model gpt-5.6-sol --effort xhigh`)とClaudeサブエージェントの両方を起動して独立に監査**させ、統括が両者の結果を突き合わせて合否を判定する。監査セッションでは新機能を実装しない。

### 決定事項ログ

- 2026-07-10: スコープはNiagaraフルパリティ(GUIのみ対象外)。コードファースト。TSL/WebGPUネイティブ。宣言的設定=シリアライズモデル
- 2026-07-10: ライブラリ名を **nachi** に決定(ユーザー選定。那智の滝由来=Niagara(滝)へのオマージュ。npm空き確認済み)。パッケージは `@nachi/*`(当初の `@vfx/*` プレースホルダから改名済み)、LICENSE holderは「nachi contributors」
- 2026-07-10: 監査プロトコル導入。全マイルストーンに監査項目(実装と別セッションで実施)+ M12後に最終監査FA(1.0リリースゲート)。手順はROADMAP.md冒頭に定義
- 2026-07-10: 検証は三層(ヘッドレスCPU=正しさ/Windows実GPU=性能/実機=モバイル)。WSL2から実GPUのWebGPUは不可と実測確認
- 2026-07-10: 開発体制確定 — Claude本体=統括(実装しない)/Codex=実装(`/codex:rescue --model gpt-5.6-sol --effort xhigh` 厳守)/Claudeサブエージェント=実装レビュー/監査=Codex+Claude両サブエージェントの独立実施を統括が統合判定
- 2026-07-11: **ユーザー指示により「ユーザー確認は非ブロッカー」と確定**。Windows実GPU目視などユーザー環境が必要な検証は「機会があれば実施する補助検証」(ROADMAPに未消化リストとして記録)とし、自律進行はヘッドレス実測(readback・オフスクリーンピクセル検証)を合否根拠とする。監査の「条件付きPASS」の条件からユーザー実施項目を外し、以後のマイルストーンゲートにしない
- 2026-07-12: **M10完了(監査込み条件付きPASS、両監査ともBLOCKER 0)**。ポスト統合と半透明: `@nachi/post`(shockwave/heat haze/radialBlur/bloom、RenderPipeline統合)+αソート三段(粗ソート+GPU bitonic+WBOIT)+lit particles+**ゴールデン#2完全版・#5達成(6/7)**。確定知見: ①**単一compute pass内の複数dispatchにステージ間同期保証なし**(WGSL仕様。bitonic等の多パスアルゴはsubmit分割必須 — レビュー提案の束ね最適化で実測ミスソートが発生し確定) ②**TSL演算は左辺型を継承**(u32属性の小数演算はサイレントunderflow=toFloat()明示) ③**GPUソートはupdate時再実行**(setCamera単独では反映されない) ④litビルボードはライトとの奥行き配置必須(同一平面z=0で受光ゼロ)+MeshStandardのsetupPositionView差し替えでSprite変換を共有する縫合方式 ⑤three RenderPipeline.dispose()はPassNode RTを解放しない(リーク=明示dispose必須) ⑥診断ガードの強化は層状の真因を順に露出させる(8桁hex未対応→lifecycle未指定→参照タイミング→受光配置、の連鎖デバッグ) ⑦#RGBA/#RRGGBBAA color対応をcoreへ実装(透明グラデ停止色は常用パターン)
- 2026-07-12: **M9完了(監査込み条件付きPASS)**。合成とタイムライン: エミッタ継承(キー指定マージ・JSON往復)+User.*型付きランタイムAPI+エフェクトプーリング(ビット一致respawn)+`@nachi/timeline`(**北極星skillSlash例が実働**)。確定知見: ①**ラッパーAPIはcoreの検証契約を保存前に適用する**(store-before-forwardは遅延・遠隔の誤動作源=immutable書換の抜け道になった) ②**システム更新はper-instance例外封じ込め+外部デルタ保全が必須**(1インスタンスのthrowが全体を恒久rejectしうる。coreの#advanceInstanceパターンをラッパーにも) ③**release/attach等のライフサイクル交差はレビューで実測プローブ必須**(attachTo済みrelease→全体フリーズを検出) ④タイムラインの時間意味論は境界分割(action/loop/mesh-life/shake-end/hitStop)で分割不変性を保証 ⑤ドキュメント陳腐化の再発3回→完了定義に文書更新を組込(本ファイルのセッションプロトコル更新)
- 2026-07-12: **M10バッチ2実装**。α半透明の三段構えを実装: `setCamera`によるエミッタ粗ソート、compaction非破壊の独立indirection GPU bitonic、`@nachi/post` native-WebGPU WBOIT。確定判断: ①sortはframe-local depth+physical index tieで決定化しpersistent ID問題を拡大しない ②2^n最遠番兵はprefixへ集め、draw開始を`P-aliveCount`にして除外 ③WBOIT revealage R8は`ONE_MINUS_SRC_COLOR` attachment blend、material接続はthree r185契約の`mrtNode` ④sortedとWBOITは併用可能だが通常は排他的(近似OITにsort費用は不要)。詳細はRFC§9.5/§13.7/§16。
- 2026-07-12: **M11バッチ2(sim caching)設計確定**。bakeは固定frame stepでrender module reads由来の論理属性+lossless alive indirectionのみを記録し、metadata JSON+単一ArrayBuffer(little-endian)へFloat32または成分別min/max u16量子化で格納(誤差上界e/131070)。replayは既存物理packingへの毎フレームstorage upload(v1は全フレームGPU常駐にしない)で、simulationカーネルを一切スケジュールしない。float補間は同一physical slotが両端aliveの場合のみ。loopは連続duplicated endpoint必須で、**ループ窓はコールドスタート不可=warmup後の周期窓でbakeする**。キャッシュはsourceBackendを記録しクロスバックエンド再生を診断拒否、fixedTimeStep systemのbakeも診断拒否(共有system進行の無音フレーム欠落防止)。**確定知見: bake/replay両側が同じデコーダを共有する数値比較は自己言及**(WebGL2の物理レイアウト系統誤差を検出できなかった→解析値など独立期待値との照合を最低1本常設)(RFC§10.5/§16)
- 2026-07-12: **M11バッチ3(デバッガ)設計確定**。属性スプレッドシートは`instance.debug.captureAttributes(emitterId,{attributes,offset,limit})`=オンデマンドGPU readbackスナップショット(型付き論理属性復元+physical slot/spawn系譜+明示truncation)、プロファイラは`system.debug.captureProfile()`=フレームローカル集計(alive/capacity/spawn/dispatch/indirect draw/host ms、GPU時間はperf計測と共有しtimestamp query二重発行なし、不能時はunavailable明示で推定値偽装しない)。capture系はsystemの更新キューへFIFO直列化し断裂スナップショットを防ぐ。**確定知見: three r185 WebGL2フォールバックはstorage毎にSEPARATE_ATTRIBS TFを1本出力しindexed accessのindexを破棄=1 vec4/particleに縮退**(WebGPUのpacked group `particle×groupCount+group`と物理レイアウトが異なる→`attributeStorageComponentIndex()`にバックエンド別アドレッシングを一元化。WebGL2でpacked group≥1の列はgroup0の値がエイリアス=列metadata`aliased`+診断で明示)(RFC§10.6/§16)
- 2026-07-12: **M11バッチ1設計確定**。qualityのspawn/capacity/fadeはランタイム値、soft/lit/sortedはcompile+pool構造variant。live構造切替はGPU状態を破棄せず次spawn境界。完全カリングはローカル/lifecycle/particle時間をpauseしcatch-upなし。significanceは`4*priority+2*screenOccupancy+1/(1+distance)`、stable instance id tieで決定化し、instance超過=cull、particle超過=spawn抑制(RFC§10.4/§16)。ゴールデン#4の大量インスタンス/significance要件をcoreで満たす。
- 2026-07-12: **M10バッチ3実装**。lit billboardは`MeshStandardNodeMaterial`の物理照明経路を維持し、r185 `SpriteNodeMaterial.setupPositionView`だけを再利用する方式に確定。タンジェント法線はbillboard回転後のview XY基底で変換し、three契約どおりview-space `normalNode`へ直接渡す。ゴールデン#2完全版(shockwave+sorted smoke)とコード定義ゴールデン#5を実装し、JSONロードはM12に維持。
- 2026-07-11: **M8完了(監査込み条件付きPASS)**。メッシュFX&tsl-kit: `@nachi/tsl-kit`(7シェーダ部品、core非依存、npm公開準備)+`@nachi/mesh-fx`(手続きジオメトリ5種+fxMaterial+VATランタイム=flement Blender VAT拡張互換)+**ゴールデン#3「チャージ魔法陣」達成(5/7)**。確定知見: ①**three r185のWebGPU readbackは256バイト行整列パディング込み配列を返す**(非整列幅は数値検証が2行目以降破損。共有readback.tsで密変換+長さトリップワイヤ。既存ページは寸法の偶然で無事だった) ②**threeのnormalNodeはビュー空間契約**(オブジェクト空間代入は軸整列構成で構造的偽陰性=回転メッシュ弁別ケースを常設) ③**readback検証の期待値は鏡像仮説でも合格しない非対称サンプル点を選ぶ**+リニア空間閾値(sRGB想定は偽判定) ④**CPUミラーのみの検証は自己言及**(偽実装でも合格=GPU実測byte照合が必須。教訓の新設検証への横展開漏れが2回発生) ⑤**npm公開準備は「バンドラなしNode ESM実import」までゲートする**(`.js`拡張子欠落は型チェック・packでは検出不能→check-package-esm.mjsをbuildに常設) ⑥Blender VATのxzy swizzleは行列式-1の鏡映(upstream仕様の忠実な継承。右手系はxz-y)
- 2026-07-11: **M7完了(監査込み条件付きPASS)**。レンダラ第二陣: `@nachi/trails`(初の外部モジュールパッケージ=レジストリ拡張点実証)+リボン/トレイル(GPU birth-index ring)+ライト(GPU top-N→固定小バッファreadback→PointLightプール)+デカール(深度再構成投影)+**ゴールデン#1「斬撃」達成(4/7)**。確定知見: ①**screenUV(v下向き)↔WebGPU NDC(y上向き)の変換はoneMinus必須** — M6深度カーネルがy鏡像texelをサンプルしていた(y対称シーンでは構造的に検出不能→y非対称スモーク常設) ②**indirect引数バッファはCPU全量アップロードがGPU compaction結果を潰す** — 生成時1回の全語アップロード後は`addUpdateRange`部分更新に限定(このlatentバグでM6以来golden-characterのパーティクルが全不描画だった=旧視覚基準に写っていたのはスペキュラのみ) ③**視覚検証は下限だけでなく飽和上限もゲート**(未調整の既定size=1が白飽和として初露出) ④**短フレームスモークは飽和・長時間破綻を見逃す**(free-list飽和のspawnOrder穴→リボン消滅はcapacity×3フレーム飽和シナリオで捕捉) ⑤リボン順序はcompaction順非依存(spawnOrder予約=min(requested,freeCount)で失敗spawnが順序を消費しない契約) ⑥外部レンダラ統合の完了状態はcoreの`EffectInstanceState`型を直接受ける(独自の状態名コピーは型不整合を隠蔽) ⑦timestamp計測は長時間ループから分離し、consoleCleanゲートで再発を恒久検出化
- 2026-07-11: **M6完了(監査込み条件付きPASS、両監査FAIL→2項目差し戻し→修正→限定再検証)**。衝突一式(解析/深度/SDF)+メッシュ表面サンプリング+ソケット追従、ゴールデン#6「キャラクター付随」達成(3/7)。確定知見: ①**深度規約はWebGPU NDC z∈[0,1]で統一**(three r185 WebGPURendererはレンダー時にカメラ射影をWebGPU規約へ書き換えるため、GL式`ndc.z*0.5+0.5`/`depth*2-1`変換は誤り。監査は「GL式カーネル×sRGB符号化深度コピーの2バグが偶然相殺して偽合格」を数値実証 — スモーク許容帯は物理期待値±0.02級まで絞らないと系統誤差を隠蔽する) ②**深度コピーは線形float非sRGB必須**(RenderPipelineの`outputColorTransform`デフォルトtrueはsRGB符号化+8bit量子化で深度を破壊=当該深度で1ステップ≈1.33ワールド単位) ③**three r185のPassNodeはFRAME単位のupdateBefore重複排除を持つ** — 提示ループ外でRenderPipeline.render()を連打するとシーン再レンダーがスキップされ古い内容を黙って返す。プリパスはDepthTexture付きRTへの明示renderer.render()2段構成にし、スモークにstale検出トリップワイヤを置く ④**視覚基準画像は取得時に内容を目視確認する**(golden-characterの基準が「failed」ステータスカードのスクショだった=スクショ回帰は基準自体の汚染を検出できない) ⑤ヘッドレスの視覚経路はcanvas presentでなくオフスクリーンRT→readback→2Dキャンバス提示(explosionパターン)で統一 ⑥切り分けは当て推量でなく証拠駆動readback(カーネル無実の証明はCPU再現+単独GPUプローブ+同一ページ内先行実行の3経路で確定)
- 2026-07-11: **M7バッチ1リボン順序方式を確定**。alive compaction順は使用せず、spawn/event prepareの単一GPU invocationが`min(requested, freeCount)`個の連続`spawnOrder`範囲を予約し、capacity長birth-index ringへphysical indexを記録する。失敗spawnは順序を消費しない。描画準備はGPU上で`ribbonId`ごとにbirth ringを時系列走査し、stale/dead点を除外してsegment bufferを生成する。これによりfree-list/compactionのatomic順非決定性とリボン接続順を分離し、CPU readbackなしで中間kill後の再接続も保証する。`@nachi/trails`を外部パッケージとして新設し、coreのレジストリ拡張を実証。v1はWebGPU限定、最新capacity出生の保持限界、`O(maxRibbons*capacity)`直列準備、u32 wrap前の再起動、1 emitter 1 render moduleを制約とする(RFC§9.3/§16)。
- 2026-07-11: **M7バッチ2ライト/デカール方式を確定**。ライトは既定8・最大64のCPU `THREE.PointLight`プールを採用し、GPU単一invocationのtop-N選択結果だけを固定小バッファへ書き、二重バッファで1フレーム遅延・1回readbackする。three r185 WebGPUは固定maxLightsを公開せず解析ライト数に応じてノード/シェーダコストが増えるため、/golden-slash/で8/16/32灯をオフスクリーン実測しつつ既定8で費用を拘束する。エミッシブ+ブルームは実照明の代替でなくM10ポストへ分離。デカールはCPU DecalGeometryやoriented-quad縮退でなく、M6の線形float前フレーム深度コピーとWebGPU NDC z∈[0,1]を再利用するインスタンス投影ボックス方式を採用。単一カメラ・1フレーム遅延・WebGPU限定を明示診断する(RFC§9.4/§16)。
- 2026-07-11: **M7バッチ2レビューBLOCKER修正**。three r185の`screenUV`/render-target textureは左上原点(v下)、WebGPU NDCはy上のため、深度投影は`v=0.5-0.5*ndc.y`、逆投影は`ndc.y=1-2v`で統一する。M6の従来検証は全てy対称で鏡像を検出できなかったため、X軸回転面+y≠0粒子の常設GPUトリップワイヤを追加。間接描画word0のmaterialize後CPU更新は`addUpdateRange(word0,1)`に限定し、GPUが書いたinstanceCountを全量再アップロードで潰さない。ライトプールは全灯visible固定+intensity=0消灯、完了/停止/解放時disposeで単一LightsNodeシェーダvariantを維持する。
- 2026-07-11: **M5完了(監査込み条件付きPASS)**。onDeath→emitTo連鎖が動作(2/7ゴールデンに続く重要契約)。確定知見: ①完了判定はイベントグラフ深度分のdrainを要する(固定1フレーム猶予では多段連鎖の最終イベントが消える) ②interval readback使用時はemission完了・イベント消費フレームで強制flush ③長時間ループのスモークはtimestamp計測区間を分離(単一updateのdispatch数がプールを超え得る)
- 2026-07-11: **M4完了(監査込み条件付きPASS)**。ゴールデン#4「環境ループ」達成(M4スコープ注記付き)。確定知見: ①視覚回帰は許容誤差0.5%(GPU compaction順の非決定論が加算合成の描画順→8bit量子化に波及しPNGバイト再現は不可能とGPU実証。決定的順序付けはpersistent ID実装時に再検討) ②overLife系の意味論は「絶対カーブ」で統一(velocityは比率形式で実現) ③フォース強度は「strength≈最大加速度」正規化で統一
- 2026-07-11: **M3完了(監査込みPASS)**。ゴールデン#2「爆発」達成。確定知見: ①**three r185のTSL rotate()は列優先構築で標準CCWの転置(逆回転)規約** — 向き系の数学はTHREE.Euler基準でなくTSL実規約のGPU実測で検証すること(2D mat2経路は標準CCWで規約が逆) ②renderモジュールは1エミッタ1個(M7でper-draw引数スロット化) ③fadeDistanceは正規化linear深度単位
- 2026-07-11: **M2完了(監査込みPASS、初回FAIL→修正→再監査)**。確定事項: ライフサイクルバッファは2本構成(writable状態=カウンタ+freeList+aliveIndices/間接引数=spawn3+draw5語。同一同期スコープのIndirect|Storage兼用はWebGPU違反のため分離必須)、mat3等はTSL論理長でなく物理ストライドで実体化(three r185のinstancedArrayは論理長確保)、WebGL2ライフサイクルは単発burstのみ(TF varyings数+per-varyingコンポーネント4の二重予算を静的検算)、compiler専有パス所有権表導入。**vec4属性パッキングはM3バッチ1でレンダラ頂点ステージのストレージバッファ予算と統合設計して実装**(§16に決定記録)
- 2026-07-11: **M1完了(監査込み・条件付きPASS)**。カーネルコンパイラの設計確定: compileEmitter=three非依存記述+buildKernels実体化の2層、$defaults/$age/$integrate予約モジュール、乱数slot=stage hash混合(ステージ間衝突解消)、色は文字列=sRGB→linear/配列=linear、統合VfxRegistryはM12・ステージ書込権限検証はM2/M5へ明示先送り。M1カーネルはWebGPU専用(WebGL2はTF varyings上限で不成立、M2でゲート設計)
- 2026-07-10: **スパイク3/4の実証結果**:①WebGL2実測サポートマトリクス — TSLコンピュート=可(transform feedback、WebGPUとreadback値完全一致=決定論の実証も兼ねる)、readback=可(getBufferSubData)、**アトミクス=不可**(GLSLに降下されずコンパイル失敗)、**間接描画/間接ディスパッチ=不可**(CPU count直接描画にフォールバック)→ **政策含意: WebGL2の生存数駆動はCPUカウント経由に限定、GPUフリーリスト/コンパクションはWebGPU専用。capabilityゲート必須** ②dispatchIndirect実証(WebGPU、dispatch X=ceil(alive/64)をreadback検証)③深度+ポスト共存実証 — `linearDepth(viewportDepthTexture(screenUV))`が両バックエンドで動作、WebGL2でピクセル実証(fade on/off差分30.2%+二重目視)、ポスト統合点は**RenderPipeline**(PostProcessingはr183で非推奨改名)。残: 深度規約(reverse-z/MSAA)、フォールバック方針の形式化(WebGPUピクセル検証はreadRenderTargetPixelsAsyncでヘッドレス化済み・M0監査で合格)
- 2026-07-10: **スパイク1/2の実証結果(three 0.185.1、SwiftShaderヘッドレス)**:①TSLコンピュートで10万粒子シミュレーションが公開APIで成立(`instancedArray`(SoA)+`Fn().compute()`+複数カーネル順序投入)②アトミクス動作確認(`.toAtomic()`+atomicAdd、91,327並行加算の完全一致)③間接描画引数のGPU駆動を実証(`IndirectStorageBufferAttribute`+`geometry.setIndirect`、readbackで引数内容確認。**描画実行自体の確認はWindows実GPU目視待ち**)④`renderer.getArrayBufferAsync`でreadback可。**未回答**: dispatchIndirect実証(APIは存在確認済み)、SoA vs interleaved比較、free-list vs compaction(スパイクは連続prefix生存で回避)、GPU timestamp計測(computeAsync壁時間はencodeのみで性能指標にならない)

## 未決事項

- [x] ライブラリ名(**nachi** に決定、2026-07-10。那智の滝由来=Niagaraへのオマージュ。npm空き確認済み)
- [x] ライセンス(MIT、LICENSE作成済み。holder: nachi contributors)
- [x] WebGL2フォールバックの実測範囲はスパイク3で確定(コンピュート/readback可、アトミクス/間接不可)。capability宣言の形式化はM1以降の設計事項として決定事項ログに記載
- [ ] Grid流体(M12)の実装深度:Niagara Fluids完全互換は目標としつつ、Grid2Dスモーク/炎を先行
