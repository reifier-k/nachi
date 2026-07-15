# 016: 測定 dt の既定クランプ

- 重大度: 高
- 対象: `@nachi-vfx/core` / `@nachi-vfx/timeline`(update 時間源)、RFC 001
- 状態: 受入済み(H2-11、2026-07-16)
- 出典: H1 後続 Codex 探査 T4#4(task-mrklb7a0-200ucr、2026-07-14)

## 症状(静的監査、確度=確実)

delta 省略の `update()` は `#measuredDelta()` の経過 wall time を無上限で 1 回の variable step へ
供給する(`system.ts:3103/3637`、上限・timestamp 再初期化経路なし)。タブ非表示・RAF 停止・
アプリ側 pause からの復帰時に巨大 dt が積分へ直行し、粒子位置の大ジャンプ・寿命/timeline/mesh-fx の
即時完了・rate 蓄積の急増・grid simulation の不安定化が起こり得る。

## 裁定(2026-07-14)

**既定クランプを導入**。測定 dt に既定上限(例 0.25s)を設け、設定で変更 / 無効化可能にする。
明示 delta は不変(catch-up 用途は明示経路で維持)。

## 受け入れ基準

1. 測定 dt が上限を超えるフレームでクランプされ、破棄秒数が観測値として計上される
   (fixedTimeStep の `droppedSeconds` 既存規約と整合する報告面)。
2. 明示 delta 渡し・fixedTimeStep 併用時の挙動が不変。
3. 上限の設定変更・無効化(Infinity)が機能する。
4. RFC 001 へ時間源の規約(既定値含む)を明記。
5. ゴールデン・ショーケース(全て明示 delta 駆動)に影響しないことを回帰で確認。

## 互換性 / リスク

- 既定挙動の変更(core minor)。復帰時 catch-up に依存していたアプリは設定で戻せる。
- plan 026 の T4#5(fixed-step の空間 backlog)と関連するが、本プランは測定 dt の入口のみを扱う。

## 修正前プローブ(2026-07-16)

injected `now` を1000msから2000msへ進め、引数なし `update()` を2回呼んだ。

- core実emitter: `system.time=1.0`、instance local time `1.0`、`System.deltaTime=1.0`、
  `Emitter.deltaTime=1.0`、`rate(4)` の `spawnCount=4`。1秒がlifetime/spawn/integration入力へ
  無上限で直行することを確認した。
- timeline実mesh/action: core/timeline/mesh local timeがすべて `1.0`、0.75秒markerが同じ呼び出しで
  発火した。timelineが自前測定した1秒をcoreへ明示segmentとして渡すため、core入口だけでは防げない。
- 明示deltaとfixed-stepは既存テストで別経路であり、修正前probeはvariable measured pathを単独で
  実測した。

## 実装裁定

- `VfxSystemOptions.maxMeasuredDeltaSeconds` をcore/timeline共通optionとし、既定 `0.25`、正の有限値、
  または上限無効化の `Infinity` だけをconstructorで同期受理する。0、負、NaN、負Infinity、型崩れは
  `RangeError`。
- 引数なし `update()` だけ `used=min(raw,max)` とし、明示 `update(deltaSeconds)` は上限と
  measured-dropを完全にbypassする。明示呼び出しは既存どおり `now` をsampleせず、最後の測定timestampも
  resetしない。次の省略呼び出しは前回の省略呼び出しからのwall gapを測る。
- 最初の省略呼び出しはtimestampを確立して0。同値/逆行する有限timestampは0かつ次のbaseline。
  非有限sampleはRangeError。測定とdrop計上はqueue登録前なので、並行呼び出しはinvocation順にsampleを
  予約し、後段updateが失敗してもsampleを消費する現行境界を維持する。system reset APIはなく、effectの
  stop/release/poolもtimestamp/counterをresetしない。
- 累積getter `measuredDeltaDroppedSeconds`、`fixedStepDroppedSeconds`、合計 `droppedSeconds` を両systemへ
  公開した。profileのframe-local値へ混ぜない。clamp後deltaだけを既存`FixedStepAccumulator`へ渡すため、
  measured dropと`maxSubSteps` backlog dropは二重計上されない。明示deltaもfixed backlogは従来どおり
  発生し得る。
- timelineは測定/clamp/fixed partitionを所有し、内部coreへ明示boundary segmentだけを渡す。
  mesh/VAT/action/shake/child-emitterが同じsegmentを消費する。React/useFrameとshowcaseの明示delta経路は
  不変。
- fixed partition、`maxSubSteps`、transform backlog、timeScale、hit stop、continuous/perDistance spawn、
  lifecycleの意味は変更しない。T4#5 transform backlogはH2-15のまま。

## 恒常回帰と証拠

- unit: core default/configured/Infinity/explicit/fixed、drop内訳/合計、FIFO並行呼び出し、
  explicit/measured混在、同値/逆行/非有限clock、invalid option。timelineでも同じclock/drop matrixを固定し、
  実mesh/actionとpackage-owned VAT clockが1秒raw gapで0.25秒だけ進むことを固定した。
- focused: `packages/core/test/system.test.ts`、`packages/timeline/test/timeline.test.ts`、
  `packages/timeline/test/vat-timeline.test.ts` は3 files / 311 tests PASS。queue後段のsynthetic release failure後も
  次の測定が前sampleから進み、timestamp/dropが消費済みである回帰を含む。
- M2 WebGPU time fixture: 実system/particleでraw gap 1秒に対し、defaultはtime/position `0.25`、
  measured drop `0.75`、configured 0.1、Infinity、explicit bypass、fixed-step内訳を公開する。
  `forceFailure=measured-delta-clamp` は証拠値を保持して `measuredDeltaClamp` だけfalseにする。
- direct M2 normal WebGPU(SwiftShader) PASS: raw `1.0` に対しdefault time/position `0.25`、measured drop
  `0.75`; configured time `0.1` / drop `0.9`; Infinity time/position `1.0` / drop `0`; explicit bypass
  time/position `1.0` / drop `0`; fixed time/position `0.2` / measured `0.75` / fixed `0.05` / total `0.8`。
  GPU performance sampleはwarmup 4/4、16/16、median `0.128ms`、p95 `0.272ms`。
- direct faultは期待どおりexit 1。上記証拠値を保ち `measuredDeltaClamp=false` だけがfalseで、他validation、
  console、diagnostic、performanceはPASS。
- package-owned VAT clockはdefault 0.25/drop 0.75とInfinity 1.0/drop 0の両方を固定した。
- full unitは33 files / 864 tests PASS。全workspace typecheck、lint、format、build、package/global ESM、
  changeset status、`git diff --check` はPASS。
- 19-entry GPU suiteは19/19 PASS(`72.546s`)。showcase 6/6を含み、明示delta経路が不変。
  goldenは7/7 PASS。`tools/baselines` は差分なし。
- RFC 001 EN/JA、core/timeline README、tools README、core minor + timeline minor changesetを更新した。
- server/process、artifact、最終差分をcleanupし、fresh最終独立reviewで受入済み。

## 初回fresh review修正(2026-07-16)

初回判定はREJECT(Blocker 0 / Should 2 / Nit 0)。2件とも修正した。

- option default判定をnullish coalescingから `=== undefined` へ変更した。`undefined` だけが既定0.25を
  選択し、`null as unknown as number` はcore/timeline双方でconstructor同期RangeErrorになる恒常テストを
  追加した。
- 非有限 `now()` sampleをlastTimestampへ保存する既存方針は維持し、core/timeline双方でNaNと±Infinityの
  初回およびvalid sample後の回復境界を固定した。`[1000, NaN, 2000, 2100]` は
  `[ok(0), RangeError, RangeError, ok(0.1)]`。`+Infinity` 後の次有限値はclock reversalとして即時
  `ok(0)`、`-Infinity` 後の次有限値は `+Infinity` deltaで一度RangeErrorになった後に回復する。拒否された
  sampleはdropを増やさない。RFC 001 EN/JAにも同じ符号差と初回境界を明記した。
- 修正後再検証はfocused 3 files / 311 tests、full 33 files / 864 tests、全workspace typecheck/lint/
  format/build、global ESM、changeset status、diff checkがすべてPASS。baseline 23枚は差分なしで、関連
  server/process/temp fileの残存もない。

## 最終独立review・受入(2026-07-16)

- 初回とは別担当のfresh rereviewは **ACCEPT (Blocker 0 / Should 0 / Nit 0)**。初回2Sは全てCLOSED。
- `undefined` 限定default、全invalid option、NaN/±Infinityの初回/bridge/回復列、拒否時drop非加算を
  core/timeline実行で再確認した。timelineのqueued core failureでもsample消費後にtime `0.25`、
  measured/total drop `0.75`へ回復した。
- default/configured/Infinity/explicit/fixed、FIFO計測、累積drop内訳、timeline所有partition、
  mesh/VAT/action/marker/childの同一clock列を再監査し、T4#5やH2-12以降の混入なしを確認した。
- focused 3 files / 311 tests、full 33 files / 864 tests、typecheck/lint/format/build、package/global ESM、
  changeset status、diff checkは全てPASS。direct M2 normalと単独fault、canonical GPU 19/19
  (showcase 6/6)、golden 7/7もPASSし、tracked baseline 23枚は差分なし。
- 検証server/runnerとignored artifactを停止・削除し、review時点のH2-11想定13ファイル以外に残存差分が
  ないことを確認した。
