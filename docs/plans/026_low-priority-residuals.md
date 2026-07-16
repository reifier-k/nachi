# 026: 低優先残余・文書化バッチ

- 重大度: 低〜中(要検証含む)
- 対象: `@nachi-vfx/core`、`@nachi-vfx/three`、docs/rfc
- 状態: 受入済み(H2-15、fresh独立最終レビューACCEPT、BLOCKER/SHOULD/NIT=0)
- 出典: H1 後続 Codex 探査の残余(2026-07-14)

## 対象一覧

| 出典 | 内容 | 処置方針 |
|---|---|---|
| T2 B-1(解消済み、H2-7へ移管) | pool 再利用時に前世代の `THREE_RENDER_ORDER` 記録が kernel state に残存し、次利用者の materialize 初期値になる(`three/index.ts:486`、通常返却はクリアされず完全破棄時のみ削除) | plan 020 / RFC 006 のdraw-index別base+offset+rank state所有へ統合。pool返却/releaseでassignmentをclearし、actual checkout + update前materialize + retained prepare GPU回帰で2026-07-15に解消。H2-15対象から除外 |
| T3 B-5(低・確実) | WebGPU debug capture の行順・pagination が compaction 順依存(WebGL2 は slot 昇順=backend 間で行順不一致) | 文書化+安定ソートオプションの検討 |
| T4#5(中・要検証) | fixed-step の時間 backlog 破棄(`maxSubSteps`)時に transform の空間 backlog が破棄されず、復帰時に perDistance が停止期間の長い chord へ粒子生成(`system.ts:556/1344` — `droppedSeconds` 増加時の transform ラッチ分岐なし) | 再現プローブ → H1-7 の「停止中距離破棄」規約と整合する transform ラッチを実装 |
| T5 F-08(中・確実) | Three attach で world scale が公開 transform(`EffectWorldTransform`)から脱落(RFC 001 明記の現行制約の再確認) | 制約の再明文化+scale 対応は v2 候補として ROADMAP 残差へ |
| T2 A-1(中・確実) | light pool の子 PointLight 補正(intensity/distance/position/color)が毎 readback で粒子値に上書きされる | 「ランタイム所有プロパティ一覧」を RFC 化(plan 020 の renderOrder 合成と整合)。補正合成 API は v2 候補 |

## 裁定(2026-07-14)

雑務バッチとして 1 タスク化(ユーザー裁定)。T2 B-1はH2-7 PHASE 1で、pool返却がdraw registryをdispose
してもkernel上のorder stateをclearせず、完全releaseだけがdeleteすることを確認し、order ownershipを扱う
plan 020へ移管した。H2-7受入時に実pool回帰を伴って閉じる。残る「要検証」T4#5は実装前に再現プローブで
確度を確定し、実害が確認できなければ文書化へ降格してよい(統括判断)。

## H2-7移管完了(2026-07-15)

T2 B-1は`prepareKernelsForPooling()`とpermanent releaseの双方でdraw registration/order assignmentをclearする
実装へ置換した。`/m10-sort/`はrelease→同一kernel pool checkout→update前materializeで前generation base/rankが
見えず、update後に新rankだけが合成されること、late materializationとretained prepared drawが最新assignmentを
受け取ることを実GPUで検証した。詳細値・fault isolation・全域gateはplan 020 PHASE 2へ記録済みであり、本plan
からの重複実装は行わない。

## T4#5 再現プローブと採用裁定(2026-07-16)

現行HEAD `a1191ee` に対し、`stepSeconds=0.1`、`maxSubSteps=2`、`perDistance(2)` の決定的unit
プローブを先に実行した。初期化後にtransformをx=0からx=10へ移し、`update(0.05)`ではsubstep 0、spawn
submission 0、system time 0のまま空間履歴だけを残した。続く無移動の`update(0.95)`では時間backlog
0.8秒を破棄し、local/system timeは0.2秒だけ進んだ一方、残っていた10-unit chordを最初のsubstepが消費して
`spawnCount=20`、spawn submission 1となった（probe 1/1 PASS）。すなわち「時間は破棄済みだが、その区間の
空間移動は復帰時に生成へ変換される」という実害を確度100%で再現した。

H1-7の履歴規約は、hit stop、culling、および通常のfixed substepを含む各consumed system stepでcurrentを
commitし、停止中距離を再利用しない。pool checkout/初期化前syncはprevious=current、loop activationは
pending distanceを破棄する。`maxSubSteps` dropだけに同等のlatch境界がなく、この規約から外れていた。
よってT4#5を**採用**し、新たな`fixedStepDroppedSeconds`が発生した更新だけ、attachment/manual transformの
currentを履歴へlatchして空間backlogを破棄してから、保持された通常substepを実行する。rate/time spawn、
明示deltaのdrop報告、dropのないpartial/fixed partition、drop後の連続距離、rotationを含む完全transform履歴、
hit stop/culling/loop/poolの既存規約は変更しない。

実装後は同じ0.05+0.95秒、10-unit probeがdrop 0.8秒/local time 0.2秒を保ったままspawn submission 0に
なり、次の1 unit移動+0.1秒で`spawnCount=2`、phase start/step=`0.5/0.5`として連続再開した。latchだけを
no-op化するfault injectionは旧`spawnCount=20`、phase=`0.05/0.05`を再現し、時間accumulatorやspawn kernel
ではなく履歴境界を弁別した。dropなしでceilingへちょうど到達する0.05+0.15秒は1-unit chord→2粒を保持し、
rate(10)はdrop時も保持2 substepで1粒ずつ生成した。previous/current matrix、quaternion、
`interpolationActive=0`もlatch後に一致する。

timelineはfixed accumulatorを外側で所有し、旧実装ではdrop後の0.1秒×2を明示deltaとしてcoreへ渡すため、
core側にdrop情報がなく同じ10-unit chordを最初のsegmentが消費する同型経路だった。内部bridgeを追加し、
timeline attachment sync→transform backlog latch→最初の保持boundary segmentの順を固定した。実core
perDistance child統合でtimeline drop 0.8秒、spawn 0、次の1 unitで2粒を確認した。bridgeはcomposition
runtime専用の`@internal` methodであり、一般application向けteleport/reset APIとしては公開契約化しない。

## T3 B-5 安定capture順の採用裁定(2026-07-16)

現行`captureAttributes()`はpagination指定時も全alive membership、選択storage、およびlineage列をreadback・
展開してからsliceする。既定WebGPU行順はatomic compaction、WebGL2はalive flagのphysical-slot昇順scanで、
同じphysical membershipでもpage境界が一致しない。追加GPU readback 0で解消できるため、互換な既定
`order: 'compaction'`を保ち、opt-in `order: 'physical-slot'`を**採用**した。sort後にoffset/limitを適用し、
rowの`aliveIndex`は元compact indexを保持する。opt-in追加コストはalive数Aに対してCPU `O(A log A)`、一時
entry `O(A)`。既定pathにはentry/sort/duplicate scan/page slice allocationを追加しない。

WebGPU membership `[3,0,2]`とWebGL2 `[0,2,3]`のoffset 1/limit 1はともにphysical slot 2、heat 30、
lineage `(generation=3, order=102)`を返し、元`aliveIndex`だけがそれぞれ2/1となる。重複slotというhostile
membershipはdataを隠さず、physical slot→元aliveIndexでtie-breakし
`NACHI_DEBUG_DUPLICATE_PHYSICAL_SLOT`を返す。これは同一physical membershipのcompaction順差だけを除去する
物理identity順であり、persistent logical lineage順ではない。WebGPU free-listとWebGL2 prefixでslot allocation
自体が異なる場合のlogical row/page parityは保証しない。u32 wrap/generation順まで含むlineage order APIは
別契約になるため本batchでは追加しない。

## T5 F-08 / T2 A-1 文書裁定とv2残差(2026-07-16)

F-08はv1挙動を変更せず制約を再明文化した。`EffectWorldTransform`とThreeの
`createThreeTransformSource()`はworld position/quaternionだけを渡しworld scaleを落とす。parent scaleが
child world positionへ与える影響は残るが、emitter basis/offset、perDistance world unit、particle size、
grid/collider寸法はscaleしない。**v2 residual roadmap**は、(1) `EffectWorldTransform.scale`の有限vec3型、
(2) spawn/setTransform/attachment/React/Three snapshotとserialization、(3) previous/current scale interpolation、
(4) perDistanceをtranslation chordのままにするかscaled origin軌跡へ変えるか、(5) non-uniform scale下の
rotation分解・normal/velocity/collider/grid単位、(6) pool/reset/cache互換、(7) v1 asset/reader migrationを
一括で設計・回帰する。Threeだけ先行してmatrix scaleを混入させない。

A-1もv1挙動を変更せず、selection readback適用ごとにruntimeが所有するchild PointLight propertyを
`visible`、`intensity`（派生`power`を含む）、`distance`、selected時の`position`/`color`と確定した。
inactive slotはintensity/distance 0だがposition/colorはstale値を保持し得る。ユーザーの直接補正は次の
readbackで保持されない。group visibilityだけは既存`setUserVisible()`合成を持つ。**v2 residual roadmap**は
particle-owned baseの後へ永続的な`intensityScale`、`distanceScale`、`positionOffset`、`colorMultiplier`を
適用するcomposition object/setterを候補とし、H2-7の`setRenderOrderBase()`と同じbase-plus-user modifier
ownership、validation、pool再利用/resetを定義する。T2 B-1はH2-7解消済みのため実装変更していない。

## fresh review 4S修正(2026-07-16)

初回独立reviewは`0B/4S/0N`だった。S1は累積dropが`2**53`へ達した後の追加`delta=1`で、core/timeline
ともtransform latch callが`1→1`のまま増えないことを実測した。S2は`stepSeconds=1e-12`を許すため、
accumulatorが2 stepを返しcore timeが`2e-12`へ進む一方、core transform stepとtimeline boundaryは
`1e-10` epsilon以下を消費せずtimeline timeが0になる不整合だった。S3は`order: null`が既定値として通り、
S4はcapacity 4のphysical slot 4がheat/generation/orderすべて0のrowになりdiagnosticもなかった。

- S1: `FixedStepAccumulator.lastAdvanceDroppedSeconds`を追加し、各`advance()`の今回drop量を累積counterと
  独立に保持する。core/timeline ownerは累積before/after比較を廃止し、この値が正のときlatchする。修正後は
  累積値が`2**53`のままでも追加dropで両ownerのlatchが`1→2`、停止chord spawn 0、次の1 unitで2粒。
  累積が`Infinity`になった後も今回drop `0.8`を観測し、次のno-drop advanceでは0へ戻る。
- S2: core/timelineが共有するAccumulator constructorで`stepSeconds > 1e-10`を必須化した。`0`、`1e-12`、
  `1e-10`は`RangeError: stepSeconds must be greater than 1e-10 seconds.`、`1.000001e-10`は両systemで
  受理する。通常のfixed値とcumulative getterの意味は変更しない。
- S3: `order`は省略/`undefined`だけを既定`compaction`とし、`null`、数値、object、未知文字列を
  `NACHI_DEBUG_ATTRIBUTE_ORDER_INVALID` / `options.order`で構造化拒否する。
- S4: `[0, capacity)`外のmembershipを`NACHI_DEBUG_PHYSICAL_SLOT_OUT_OF_RANGE` /
  `aliveIndices.<compact-index>`で拒否する。既定compactionはreturned pageの既存loop内だけをallocationなしで
  検証し、page外はscanしない。physical-slot順はsort entry作成前に全membershipを検証するためpage外も拒否。
  invalid first、page外、空membership、`0xffffffff`境界を固定し、duplicate warningとは区別した。

S1/S2はCPU scheduler metadata/constructor validation、S3/S4はCPU formatter validationだけの変更で、
shader/kernel/materialおよび通常値のGPU経路を変えない。影響評価に加えて、fresh修正後の最終ワークツリーでも
権限付きauthoritative GPU/goldenを再実行した。

## 再レビューS5修正(2026-07-16)

初回reviewの4Sは再レビューですべてCLOSEDとなり、結果は`0B/1S/0N`だった。新S5は
`stepSeconds=Number.MAX_VALUE`、`maxSubSteps=2`をconstructorが許し、`advance(MAX_VALUE/2)`後の
`advance(MAX_VALUE)`でceilingと加算値がともに`Infinity`になる経路だった。旧実装は
`Infinity - Infinity`から今回drop、累積drop、accumulatorをすべて`NaN`にし、ownerの`drop > 0`判定も
falseとなってtransform latchを欠落した。

constructorは`stepSeconds * maxSubSteps`が有限であることを必須化し、違反を
`RangeError: stepSeconds * maxSubSteps must be a finite number.`で拒否する。したがって`MAX_VALUE * 2`は
core/timeline両boundaryで拒否し、`(MAX_VALUE/2) * 2 = MAX_VALUE`は受理する。`advance()`は有限上限から
現在のaccumulatorを引いた残容量、`min(delta, remainingCapacity)`の保持量、`delta - retained`のdrop量を
順に求め、clamp前の`accumulator + delta`を作らない。

最大有限組合せでpartial=`MAX_VALUE/4`を保持後、delta=`MAX_VALUE`を渡す回帰は、2 substep、
accumulator 0、今回/累積drop=`4.49423283715579e307`（finite、非`NaN`）となる。次のno-drop advanceは
今回dropを0へ戻す。core/timeline実ownerもsystem time=`MAX_VALUE`、latch 1、停止chord spawn 0で一致した。
有限dropの累積加算結果は従来どおり`Infinity`になり得るが`NaN`にはしない。scheduler算術を変更したため、
CPU全域後に権限付きGPU/goldenを再実行し、双方の成功を確認した。

## 実装・検証ログ(2026-07-16)

- 実装: core-owned fixed dropとtimeline-owned fixed dropのtransform latch、timeline→coreの`@internal`
  bridge、debug captureのopt-in physical-slot order、runtime validation/duplicate warningを追加。既定capture
  pathにはstable-order用entry/sort/duplicate scan/page slice allocationを追加していない。
- focused: core/debug/timeline 15/15 PASS。旧faultはdrop 0.8秒、spawn 20、phase 0.05/0.05を再現し、修正は
  spawn 0→次1 unitで2、phase 0.5/0.5。timeline実core childもspawn 0→2。Three 2/2 PASSで、world
  scaleがpositionへ反映されても公開transformにscale fieldがないこと、PointLightの直接補正した
  visible/intensity/distance/position/colorが次readbackでruntime値へ戻ることを固定。
- fresh review focused: core/debug/timeline 20/20 PASS。2**53/Infinity、epsilon上下、untyped order、physical
  membershipのreturned/full/page外/empty/u32境界を含む。
- S5 focused: core/timeline 11/11 PASS。非有限ceiling拒否、最大有限ceiling、overflow-safe partial/drop、
  core/timeline owner latchを含む。
- 全域: `pnpm test` 1021/1021、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、
  `pnpm esm-all`、`pnpm exec changeset status`、`git diff --check`はすべてPASS。changesetはcore minor、
  timeline patchを追加。
- GPU/golden: sandbox内では19/19・7/7がいずれも約0.25秒でinvalid JSONとなり、個別spikeのChromium
  `setsockopt: Operation not permitted (1)`/SIGTRAPとVite listen `EPERM`から製品assert到達前の環境制約と
  弁別した。その後、統括がloopback serverを明示起動した権限付き環境で同一ワークツリーをcanonical再実行し、
  初回GPU playground 13 + showcase 6 = 19/19 PASS（合計`73.726s`）、golden 7/7 PASSを確認した。
  さらに初回review 4S修正後の最終ワークツリーも再実行し、GPU 19/19 PASS（合計`72.832s`）、
  golden 7/7 PASSを確認した。S5 scheduler算術修正後の最終ワークツリーもGPU 19/19 PASS
  （`totalDurationMs=72793`）、golden 7/7 PASS。server 2本は停止済み。
- baseline/cleanup: tracked baselineは23枚、変更・未追跡なし。path付きfile hash一覧のmanifest SHA-256は
  `7b1ebcba49acb72e20f3c33471043c50cff24613a537f1a936fbcd3123a17b24`。`.tmp`/`.bak`は0、
  `artifacts`/`test-results`/`report`は清掃済み。Vite/Chromium/runnerの残存processなし、5173/5174の
  listenerなし。

## 受け入れ基準

1. 移管後に残る要検証1件（T4#5）の再現プローブ結果がセッションログに記録され、採否が確定している。
2. 採用分の修正+回帰、降格分の RFC/README 明文化が完了している。
3. CPU全域、canonical GPU 19/19、golden 7/7が緑。changeset は採用分の実装内容に応じて起票。

## fresh独立最終レビュー(2026-07-16)

- 初回は`0B/4S/0N`、再レビューは初回4S CLOSEDの上で`0B/1S/0N`、最終再レビューは
  **ACCEPT / BLOCKER=0 / SHOULD=0 / NIT=0**。累積drop精度、epsilon以下fixed step、untyped order、
  capacity外membership、fixed ceiling積/加算overflowの全5 SHOULDをCLOSEDとした。
- reviewer自身のfocused 4 files/404 tests、full 36 files/1021 tests、S1–S5独立boundary probe、
  `git diff --check`がPASS。統括のtypecheck/lint/format/build/ESM/changeset、S5後GPU 19/19
  (`72.793s`)、golden 7/7、baseline 23枚不変、生成物/process/listener清掃も受入証跡として照合した。
