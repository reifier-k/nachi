# 014: timeline mesh-fx 状態所有権の完結(clone スナップショット / userVisible / geometry 共有)

- 重大度: 高(C-1)/中(A-3、C-2)
- 対象: `@nachi-vfx/timeline`、`@nachi-vfx/mesh-fx`、RFC 001
- 状態: 受入済み(H2-9、2026-07-15)
- 出典: H1 後続 Codex 探査 T2 C-1 / A-3 / C-2(task-mrkla9gn-byrcd0、2026-07-14)

## 症状(静的監査)

1. **C-1(確実)**: timeline `fxMaterial()` の clone が source material を copy せず作成時 config
   から再生成する(`timeline/runtime.ts:258` → `authoring.ts:293` の `materialConfigs.get(material)`)。
   `setOpacity()` 済みの現在値、`side` / `depthTest` / `colorWrite` 等の Three material 設定、
   `name` / `userData` が spawn clone へ引き継がれない。plan 009 で導入した公式 setter の値が
   黙って巻き戻る。DoubleSide 等の欠落では視点によりメッシュが消え得る。
2. **A-3(確実)**: timeline mesh-fx clone の `visible` は play / stop / 自然終了が直接書き換える
   (`runtime.ts:687/812/849`)。plan 004 の `runtimeVisible∧userVisible` 合成に相当する状態が
   timeline mesh には存在しない。
3. **C-2(要検証)**: `resource.mesh.clone()` は Three r185 の `Mesh.copy()` により geometry を
   生参照共有する。clone / source 側の attribute・drawRange 変更が全インスタンスへ波及する。

## 裁定(2026-07-14)

**スナップショット+合成を採用(全部)**。clone は source material の現在状態
(uniform 値・render state)を引き継ぐ形へ変更し、timeline mesh にも userVisible 合成を導入。
geometry 共有は「不変借用リソース」として RFC 明文化(コピーはしない)。
plan 001 / 004 / 009 の完結編。

## 修正前の実プローブ(2026-07-15)

Three r185を使うtimeline単体プローブを修正前HEADで実行し、3件を次のように弁別した。

- C-1: sourceを`opacity: 0.8`で作成後に`setOpacity(0.2)`、`DoubleSide`、
  `depthTest=false`、`colorWrite=false`、`name`、nested `userData`を設定したが、spawn cloneは順に
  `0.8`、`FrontSide(0)`、`true`、`true`、空文字、`{}`だった。作成時configからの再生成で現在状態を
  失うことを確認した。
- A-3: time-zero play後にcloneの`visible=false`をユーザー操作として書き、stop後に再playすると
  `visible=true`へ上書きされた。runtime/userの二成分状態がないことを確認した。
- C-2: `clone.geometry === source.geometry`とposition attribute identityがともに`true`だった。
  Threeの`Mesh.clone()`はgeometryをコピーせず、生参照を共有する。

公開visibility APIは`TimelineEffectInstance.setUserVisible(elementKey, visible)`とし、mesh runtimeが
`runtimeVisible`とdefault-trueの`userVisible`を保持して、唯一の反映点で`mesh.visible =
runtimeVisible && userVisible`を公開する。対象はadapt済みtimeline mesh-fx要素に型で絞り、実行時にも
不明/非mesh keyを拒否する。

## 受け入れ基準

1. `fxMaterial({opacity:0.8})`+`setOpacity(0.2)` 後の spawn clone が 0.2 で始まる。
   side / depthTest 等の変更も引き継がれる(プローブ)。clone 独立性(A→B 非漏洩、
   H1-6 の 12 プローブ)は維持。
2. opacityOverLife との排他(NACHI_MESH_FX_OPACITY_BINDING_CONFLICT)等の既存規約が不変。
3. timeline mesh に `setUserVisible()` 相当を導入し、play / loop / 自然終了を跨いで user 設定が
   保存される(draw registry 側 plan 004 と同じ合成規約)。
4. geometry 共有の所有権規約(不変借用・dispose 責務)を RFC 001 と mesh-fx README に明記。
5. showcase 6 ページ+m9 系の回帰緑(スナップショット化の数値互換は H1-6 方式で実証)。

## 互換性 / リスク

- 「spawn 前に source を触ると反映される」への変化は事実上のバグ修正だが、作成時 config 固定に
  依存した使い方があると挙動変化(timeline minor、changeset 明記)。

## 実装結果

- material cloneは保存済みauthoring configから独立したNodeMaterial graphとpackage-owned uniformを
  再生成した後、Three r185の`MeshBasicMaterial.prototype.copy`契約でspawn時点の通常material状態を
  snapshotする。source/clone双方がowned uniformを持つopacity/time/normalizedLifeは公式setter経由で
  現在値を移す。source node graphはcopyせず、uniform/userData/clipping planeはclone間で独立する。
  texture等の外部所有リソースはThreeの通常の共有参照規約を維持する。
- `TimelineMeshFxElementKey<Definition>`と
  `TimelineEffectInstance.setUserVisible(meshKey, visible)`を公開した。adapt済みmesh keyだけを型で許可し、
  unknown/non-meshは`RangeError`、non-booleanは`TypeError`、release後は既存guardで拒否する。
  constructor/materialize、play、stop、自然終了、loop reset/replay、instance stop、transform、complete、
  release/error cleanupを`runtimeVisible && userVisible`の単一反映点へ集約した。新規instanceは必ず
  `userVisible=true`から始まる。
- geometryはThree r185どおりsource/全cloneで同じ参照を使う。attributeと`drawRange`のmutation波及、
  timeline releaseがgeometryをdisposeしないこと、最後にapplication ownerだけがdisposeすることを
  単体回帰に固定し、RFC 001日英とmesh-fx/timeline READMEへ所有権と時機を明記した。
- `/m9-compose/`と`/m9-timeline/`をH2-1常設runnerへ追加した。後者はback-facing DoubleSide描画、
  current opacity/render state、source/clone独立性、geometry identity、stop/replayを跨ぐuser hideを実GPUと
  pixel readbackで検証する。headlessでは新規PNG baselineを要求せず、既存visual出力を変更しない。
  `?forceFailure=timeline-user-visible`はこのaggregateだけを故障させる。
- timeline minor changeset `timeline-meshfx-state-ownership.md`を追加した。H2-10 VAT時計/clone保持には
  触れていない。

## 検証証跡(2026-07-15)

- focused: timeline + mesh-fxの2 files / 71 tests成功。timeline単体は50 testsで、current
  opacity/time/lifeと20項目超のThree state snapshot、source/A/Bのnode graph・owned uniform独立性、
  stencil state、texture共有、opacityOverLife conflict、geometry借用/dispose、visibilityの型/runtime境界と
  全lifecycle、新規instance resetを含む。
- full: `pnpm test`は32 files / 794 tests成功。全workspace `typecheck`、`lint`、`format:check`、
  `build`、全package ESM gate、`changeset status`に成功した。
- M9 timeline正常系は17 checksすべてtrue。state ownership probeは
  `graphIndependent/opacityCausal/stateSnapshot/stateIndependent/geometryBorrowed/visibilityComposed=true`。
  back-facing current opacity 0.2のpixel energy=`153`に対し、同じauthoring stateでopacity 0.8のcontrolは
  `612`、比率=`0.25`だった。clone後にsource opacityを0.9へ変えてもcloneは`153`を維持し、stop/replay中
  hidden=`0`、restore=`153`だった。既存M9数値も
  action order/times、flash=`1`、sparks=`36`、curve changed=`99,664 px`、visual foreground ratio
  `0.2162152778`を維持した。
- isolated faultはrunner exit 1となり、同じ17 checksのうち`meshFxStateOwnershipGpu`だけfalseだった。
  fault時pixelはreplay=`153`、詳細`visibilityComposed=false`で、snapshot/独立性/geometryはtrueのまま。
- M9 composeは全10 validation成功。pooling buffer reuse、dirty-lane reset、event pooling、inheritance、
  user parameter、readbackの既存数値を維持した。
- `pnpm verify:gpu`はplayground 13 + showcase 6 = 19/19成功、総計71.293秒。M9 timelineのwarmed
  4 + 16 sampleはcompute median/p95=`0.195/0.407 ms`、render=`0.216/0.334 ms`、
  total=`0.410/0.573 ms`。M9 composeはcompute=`0.112/0.159 ms`、render=`0.120/0.179 ms`、
  total=`0.248/0.286 ms`。SwiftShader上の現状測定であり、H2-9前はM9が常設sample windowを完了して
  いなかったため比較可能なoverhead率は主張しない。
- golden runnerは7/7成功。tracked baselineは23 PNGのままでdiffなし。H2-9による意図した見た目変更・
  baseline更新はない。M9 headlessの新規常設面もreadback契約のみで、baselineを追加していない。

## 初回独立レビュー所見のclose(2026-07-15)

- SHOULD(material snapshotの因果性): source/A/Bの`opacityNode` / `colorNode`とowned opacity/time/life
  uniform root identityを単体テストで非共有に固定し、stencil stateと外部texture共有も追加した。GPUでは
  current 0.2=`153`、authoring 0.8 control=`612`、比率0.25とsource後変更0.9でもclone=`153`を検証し、
  stale authoring opacityやgraph aliasでは通らない契約へ変更した。
- SHOULD(cleanup所有権): normal release、constructor error、prepare非retained成功、preparer throw、abort、
  retained transferの各経路でclone materialのdispose回数とsource material/geometry非disposeを検証した。
  timeline READMEとRFC日英にtemporary/retained preparationのmaterial所有権とgeometry借用期間を明記した。
- NIT(`Object3D.visible`直書き): timeline READMEとRFC日英に直書きは永続APIではなく、次のruntime publishで
  上書きされ得ることを明記し、`setUserVisible()`のみを利用するよう案内した。

## 最終独立レビュー・受入(2026-07-15)

- fresh読み取り専用再レビュー: **ACCEPT**。BLOCKER / SHOULD / NIT = `0 / 0 / 0`。
- 独立再実行: focused 2 files / 71 tests、full 32 files / 794 tests、全workspace typecheck、lint、format、
  build、全package ESM、changeset status、diff checkがすべてPASS。
- M9 timeline normalは17/17、isolated faultはexit 1かつ`meshFxStateOwnershipGpu`だけfalse、M9 composeは
  10/10。full GPU suiteは19/19、`72.454 s`、goldenは7/7。tracked baseline 23枚はdiffなし。
- reviewerは初回2 SHOULD / 1 NITのclose、公開型と全visibility遷移、material/geometry/prepare所有権、
  日英RFC/README、timeline minor changeset、H2-10非混入、resource/process cleanupを独立確認した。
  pre-change比較可能値がなくoverhead率を主張しない点は、相対性能閾値が受入契約になく現行sample windowが
  完走しているため受入阻害ではないと裁定した。

以上によりH2-9を受入済みとする。
