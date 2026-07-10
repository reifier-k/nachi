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
7. 壊れた状態でセッションを終えない

### 監査セッション

マイルストーン監査・最終監査は、**Codexサブエージェント(`/codex:rescue --model gpt-5.6-sol --effort xhigh`)とClaudeサブエージェントの両方を起動して独立に監査**させ、統括が両者の結果を突き合わせて合否を判定する。監査セッションでは新機能を実装しない。

### 決定事項ログ

- 2026-07-10: スコープはNiagaraフルパリティ(GUIのみ対象外)。コードファースト。TSL/WebGPUネイティブ。宣言的設定=シリアライズモデル
- 2026-07-10: ライブラリ名は未定(M0で決定)。それまでパッケージは `@vfx/*` プレースホルダ
- 2026-07-10: 監査プロトコル導入。全マイルストーンに監査項目(実装と別セッションで実施)+ M12後に最終監査FA(1.0リリースゲート)。手順はROADMAP.md冒頭に定義
- 2026-07-10: 検証は三層(ヘッドレスCPU=正しさ/Windows実GPU=性能/実機=モバイル)。WSL2から実GPUのWebGPUは不可と実測確認
- 2026-07-10: 開発体制確定 — Claude本体=統括(実装しない)/Codex=実装(`/codex:rescue --model gpt-5.6-sol --effort xhigh` 厳守)/Claudeサブエージェント=実装レビュー/監査=Codex+Claude両サブエージェントの独立実施を統括が統合判定

## 未決事項

- [ ] ライブラリ名
- [ ] ライセンス(MIT想定)
- [ ] WebGL2フォールバックの正式サポート範囲(M0スパイク後に確定)
- [ ] Grid流体(M12)の実装深度:Niagara Fluids完全互換は目標としつつ、Grid2Dスモーク/炎を先行
