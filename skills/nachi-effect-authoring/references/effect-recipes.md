# スキルエフェクト制作レシピ（規模別）

対象: ゲームのスキル/戦闘エフェクト。鳴潮・原神クラスのアニメゲーム VFX を基準にした
実践則。ショーケース 6 エフェクト（slash / heal / barrier / beam / ice / machina）で
実証済みのパターンだけを載せている。

---

## 0. 共通レイヤリング理論

見栄えのするスキルエフェクトは、ほぼ常に次の 7 層の組み合わせでできている。
規模が上がる＝層が増える・層あたりの要素が増える、というだけで構造は同じ。

| 層 | 実装 | 役割 |
|---|---|---|
| 1. 予兆（魔法陣/ルーン） | `ring` / `magicCircle` + `fxMaterial`（dissolve + `uvFlow`） | 「来るぞ」の合図。0.3–0.6 秒 |
| 2. 閃光 | `lightRenderer` エミッタ + `lightIntensity(12–20)` + `intensityOverLife` で急減衰 | ヒット瞬間の白飛び。bloom を発火させる |
| 3. 主役メッシュ | `slashArc`（斬撃）/ `cylinder`（ビーム・光柱）/ ドーム / リング | エフェクトの「形」。dissolve で出現・消滅 |
| 4. 火花 | `billboard` + `velocity-stretch` + `gravity` + `collidePlane({ mode: 'bounce' })` | 物理感。寿命 0.2–0.6 秒 |
| 5. グロー粒/靄 | 加算 `billboard`（柔らかいグロースプライト）+ `curlNoise` | ボリューム感の水増し |
| 6. 衝撃波 | post の `screenDistortion` shockwave（+ メッシュのリング拡大） | 画面全体への波及 |
| 7. 残滓 | 低レートの embers / drift motes、`curlNoise` 漂い | 余韻。1–2 秒かけて減衰 |

タイミングの骨格は常に **予兆 → クライマックス → 余韻**。クライマックス（閃光+主役+
シェイク+衝撃波）は同一フレームか 2–3 フレーム以内に集中させ、余韻だけを長く引く。

### 色と HDR の定石

- 色は `gradient()` に hex 直書き。**終端は 8 桁 hex の α=00**（`'#ff3a1000'`）で
  フェードアウトさせる（白→彩度の高い中間色→暗色/透明、の 3 段が基本）。
- 「光っている感」は色ではなく強度で作る: 加算ブレンド + `lightIntensity` /
  `intensityOverLife` のカーブを 1.0 より大きく振り、
  `bloomPreset('intense', { radius: 0.62, strength: 0.85, threshold: 0.5 })` +
  `ACESFilmicToneMapping` に拾わせる（ショーケース全 6 種共通の標準ルック）。
- 属性色は 2 色系で（例: シアン主体+金のアクセント）。全層同色にすると安っぽくなる。

### 単発とループ

ビルダー関数に `loop: boolean` を 1 つ通し、
`timeline(events, { duration, ...(loop ? { loop: true } : {}) })` だけ切り替えるのが定石。
デモ/デバッグはループ、ゲーム内は単発 + `state === 'complete'` で release。

---

## 1. 規模 S — ヒットスパーク・被弾・足音（エミッタ 1–3、timeline 不要）

**構成**: core + three のみ。`defineEffect({ elements })` に burst エミッタを 1–3 個。
振り付けは不要（全部同時発火 + `lifecycle.startDelay` で十分）。

**レシピ（標準ヒットスパーク）**:

- `sparks`: `burst({ count: 40–120 })` + `velocityCone`（角度 40–70°、`speed: range(3, 8)`）
  + `gravity` + `drag(0.3–0.6)` + `velocity-stretch` billboard + 加算。寿命 `range(0.2, 0.5)`。
- `flash`: `lightRenderer({ maxLights: 1, radiusScale: 3 })` + `lightIntensity(16)` +
  `intensityOverLife(curve([0, 20], [0.25, 7], [1, 0]))`。寿命 0.2–0.3 秒。
- （任意）`puff`: count 4–8 の煙玉。`sizeOverLife` で膨張、alpha ブレンド。

**コツ**:

- capacity はバースト数の 2–4 倍あれば十分。むやみに盛らない（数百程度）。
- 頻発するエフェクトなので、ロード時に `system.prepare(effect)` で事前コンパイルし、
  スポーンヒッチをなくす。
- 同種を大量に出す場合は `scalability.culling.distance` と `significanceBudget` を最初から宣言。
- **サイズと寿命を疑え**: S 規模で見栄えが悪い原因の 9 割は「大きすぎ・長すぎ」。
  火花の寿命 0.5 秒超は間延びする。

## 2. 規模 M — 通常スキル: ヒール・バリア・単発魔法（要素 8–15、単一 defineEffect + timeline）

**参照実装**: `apps/showcase/src/heal.ts`（11 要素、最良の入門）、`barrier.ts`（13 要素）。

**構成**: timeline パッケージの `defineEffect` 1 個に全要素を入れ、`timeline([at(...)])` で
振り付ける。mesh-fx（ring / cylinder）と post（bloom + shockwave 1 発）を導入する規模。

**レシピ（ヒール/バフ系）**: 魔法陣 2 枚（内外周・逆回転 `uvFlow`）→ クライマックスで
光柱 `cylinder` + `lightRenderer` 閃光 + 地面波 `ring` + `cameraShake({ strength: 0.2–0.3 })`
→ `curlNoise` 上昇（`gravity([0, +0.55, 0])` で上向き重力）の噴水粒 → キラキラ余韻。

**レシピ（バリア/展開系）**: ルーン円 → 展開バースト + ドーム出現（ページ側 scale アニメに
`easeOutBack` でオーバーシュート）→ 補強セル → 周回ストリーム → 漂い粒。

**コツ**:

- timeline の時刻は `const CLIMAX_TIME = 0.5` のように**名前付き定数**にし、全要素の
  `at()` をそこから相対で書く。後からテンポ調整するとき 1 箇所で済む。
- `meshFxElement(mesh, { duration })` の duration は要素の見た目寿命。dissolve の
  `overLife` カーブがこの duration に正規化される。
- 多段の粒放出は emitter を増やさず `burst({ count, cycles, interval })` で 1 エミッタに畳む。
- 魔法陣のテクスチャは手続き生成（Canvas 2D / ノイズ DataTexture）にすると
  アセット管理もスクリーンショット回帰も決定論的になる。
- shockwave は 1 発で十分。M 規模で画面を歪ませすぎない。

## 3. 規模 L — 大技: 斬撃・ビーム（要素 20 前後、複数システム/トレイル導入）

**参照実装**: `apps/showcase/src/slash.ts`（9 要素 + トレイル 2 系統）、
`beam.ts`(22 要素、5 つの defineEffect × 2 システム)。

**構成の新要素**:

- **二系統 VFXSystem パターン**: 振り付け本体は timeline `VFXSystem`、ワールド座標に
  置きたい粒（銃口・着弾点・軌跡）は core `VFXSystem`（`CoreVFXSystem` と別名 import）で
  別 spawn し、`instance.bindCompanion(fxInstance)` か時刻比較で同期する。
  トレイルはローカル時計でなく実時間で伸びるので、この分離が必要になる。
- **トレイル**: `perDistance` スポーン + `ribbon` + ソケット `Object3D` を剣先軌道で動かして
  `attachTo`。詳細は library-usage.md §5。
- **サブエフェクトの時刻発火**: `FIRE_TIME` / `IMPACT_START` などの定数と
  `instance.localTime` を毎フレーム比較して `coreSystem.spawn(...)` する
  （beam.ts のパターン。タイムライン外の要素はこれで撃つ）。
- **ページ駆動アニメ**: 拡大リングは YZ 平面ベイクメッシュの `scale.set(1, s, s)`、
  ビームの脈動は sheath/glow の幅を ~14Hz で揺らすなど、Three オブジェクトを
  直接アニメさせてよい（全部パーティクルでやろうとしない）。

**コツ**:

- 斬撃の主役は `slashArc` + スイープ用テクスチャの dissolve（弧に沿って出現→消滅）。
  パーティクルで「斬撃の形」を作ろうとしない。ビームは同軸 `cylinder` を
  3–4 本（core / sheath / glow / residual）重ねて太さと柔らかさを両立する。
- クライマックスの `cameraShake` は strength 0.5 前後 + `hitStop(40–140 /* ms */)`。
  シェイクはカメラ本体でなく**ベース位置に加算**する形で適用し、ユーザーのオービット操作と
  喧嘩させない（`cameraShakeTarget` でサンプルを受けて自前適用）。
- 衝撃波はワールド座標基点（発生点・着弾点）で管理し、毎フレーム画面座標へ再投影して
  `post.controls.setShockwave` する。
- この規模から `system.prepare()` / `createThreeEffectPreparer` での事前コンパイルが必須。
  初回スポーンのコンパイルヒッチはクライマックスを確実に壊す。

## 4. 規模 XL — 必殺技・カットイン（要素 30–40+、要素のコード量産 + カスタム TSL）

**参照実装**: `apps/showcase/src/machina.ts`（約 40 要素: メッシュ 18 + エミッタ 22）、
`ice.ts`（約 33 要素 + カスタムカーネルモジュール）。

**構成の新要素**:

- **要素をデータから量産する**: 手書きで 40 要素並べない。
  `STRIKES` / `PILLARS` のようなスペック配列を定義し、`.map()` で
  `meshFxElement` / エミッタ / timeline イベントを生成して
  `Object.fromEntries(...)` で `elements` に流し込む。時間差は
  `BASE + index * STEP`（順序をシャッフルした配列 `[0,4,2,6,1,5,3]` で規則性を隠す）。
- **カスタム TSL**: 標準モジュールで表現できない配置/変位は `tslModule()`、
  再利用/シリアライズしたいものは専用モジュールとして registry 登録
  （`ice-sparkle-placement.ts` が見本: `ModuleAccess` の read/write 宣言 + register 関数 +
  GPU readback で配置を検証するプローブまで）。
- **フェーズ設計が主役**: boot → charge → barrage（N 連撃）→ final → afterglow のような
  4–6 フェーズ構成。`marker()` を全フェーズに打ち、キャプチャ/デバッグの基準点にする。

**コツ**:

- 多連撃は「同じ 3 点セット（レーザー + ショックリング + 着弾フラッシュ/火花）× N」で
  作る。1 撃分を関数（`createImpactEmitters(offset)`）にして座標だけ変えるのが正解で、
  撃ごとに新しい表現を発明しない。
- `cameraShake` は要所 3–4 回まで。全撃で揺らすと逆に効かなくなる。final だけ strength を
  上げる。
- 要素数が多いと合計 capacity が膨らむ。1 要素あたりの capacity を絞り
  （フラッシュ 1、火花 100–200、靄 30–60 程度）、合計をパフォーマンス予算
  （ミドル iGPU で粒 5 万 + エミッタ 10 本 + ポスト一式 60fps）内に収める。
- `quality` ティアをこの規模では必ず宣言する（low: 火花半減 + sorted/soft オフ、など）。
- duration 2.5–3 秒を超える必殺技は間延びしやすい。長くするより密度を上げる。

---

## 5. チューニングと検証のワークフロー

1. **ループ再生で作る**: 作業中は `loop: true` + シード固定。テンポ確認が数秒単位で回る。
2. **時間を止めて磨く**: tweakpane で `timeScale` 0.1–0.25 に落とす/ポーズし、
   クライマックスのフレームを静止画として詰める（ショーケースの
   `attachShowcaseTuning` が見本: timeScale / pause / hitStop / 露出 / alive 数の読み出し）。
3. **数値は定数に括り出す**: 時刻・色・強度をファイル冒頭の定数にまとめると、
   チューニングが diff で追える。
4. **このリポジトリ内なら**: `pnpm showcase:dev` 起動 →
   `node tools/spike-runner.mjs http://127.0.0.1:5174/<page>/?backend=webgpu` で
   決定論的検証。ヘッドレス WebGPU はキャンバス提示不可なので、目視は Windows 側
   実 GPU ブラウザ、スクリーンショット回帰は WebGL2（対応ページのみ）で行う。
5. **完了条件を機械化する**: 全要素が一度は生きたか
   （`allTimelineElementsHaveActivity`）、コンタクトシートに前景があるか
   （`allPanelsHaveForeground`）のようなガードを付けると、リグレッションに強い。
