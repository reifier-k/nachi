# 023: 入力検証ハードニングバッチ(12 件)

- 重大度: 高 5 / 中 7(一括)
- 対象: `@nachi-vfx/core`、`@nachi-vfx/format`、`@nachi-vfx/timeline`、`@nachi-vfx/trails`、`@nachi-vfx/post`、`@nachi-vfx/mesh-fx`
- 状態: 受入済み(H2-13、fresh独立最終review ACCEPT、BLOCKER/SHOULD/NIT=0)
- 出典: H1 後続 Codex 探査 T1#2〜#11 + T4#2/#6(2026-07-14)

## 対象一覧

| # | 出典 | 内容 | 重大度 |
|---|---|---|---|
| 1 | T1#4 | 通常 ValueInput(lifetime/gravity/drag/velocity 等)の非有限・型混在が factory/compile を素通り(`module-validation.ts` の一般 ValueInput branch 不在) | 高 |
| 2 | T1#5 | `turbulence.octaves` の NaN/非整数が無診断で octave ループ 0 回=非有限グラフ化(`compiler.ts:5312`) | 高 |
| 3 | T1#7 | spawn/setTransform/attachment の非有限 transform が GPU uniform へ直行(`system.ts:2467/2818`) | 高 |
| 4 | T1#8 | format の timeline action 検証が authoring より弱い(負 hitStop 等が load 通過→実行時に timeline 全体 error 化) | 高 |
| 5 | T1#9 | post の公開 `PostPipelineConfig` 直接構築で factory validator 迂回(`samples:0`=0 除算ノード、`pipeline.ts:102`) | 高 |
| 6 | T1#6 | 範囲外 collision mode が診断なく bounce へフォールバック(`compiler.ts:4813`) | 中 |
| 7 | T1#10 | trails の ribbonId/offset/未知 uv.mode の検証不足(未知 mode は stretched へ無音フォールバック) | 中 |
| 8 | T1#11 | mesh-fx VAT の外部 `time` 非有限・boolean 文字列が truthy 誤解釈(`vat.ts:91/200`) | 中 |
| 9 | T1#2 | normalizedAge 読み+lifetime/age 未導入が無診断で先頭値固定(NACHI_LIFETIME_WITHOUT_AGE の逆方向) | 中 |
| 10 | T1#3 | trails `maxRibbons` 既定 1 が ribbonId 範囲と不整合でも strand 無音破棄(整合性診断なし) | 中 |
| 11 | T4#6 | timeline spawn 時のみ timeScale 不変条件(有限・非負)を検証しない(`runtime.ts:375`) | 中 |
| 12 | T4#2 | timeline 初回 `update(0)` が attachment 同期前に time-zero play を処理し、古いポーズで初期化(`runtime.ts:1100/1131`) | 中 |

## 裁定(2026-07-14)

**全件バッチ採用**。H1-3 の共有バリデータ方式(ファクトリ早期 throw+compile 段共有=JSON 経路の
診断維持)への編入を基本とし、各パッケージの独自 validator も同一規約(有限性・enum 語彙・型)へ
揃える。#12 のみ検証でなく処理順の修正(初回 update(0) でも attachment sync を先行させる)。

## 受け入れ基準

1. 各項目に「不正入力 → ファクトリまたは load 段で診断」の unit を追加(H1-3 の棚卸し表を更新)。
2. #4/#8: format 往復テストへ負例を追加し、authoring / format / runtime の検証対称性を表で確認。
3. #9: helper 経由と直接構築の両方で validator が走る(公開 constructor での再検証)。
4. #12: attach → 初回 update(0) → at:0 play の順でも子エミッタが最新ポーズで初期化される回帰。
5. 意図的診断ページの opt-out 整合(H1-3 の全構築サイト走査を再実行)。
6. 全域回帰緑。新設診断コードは NACHI_* 命名規約+RFC 列挙へ追記。

## 互換性 / リスク

- 従来「通ってしまっていた」不正入力が診断化する=厳格化(各パッケージ minor)。
- format の strict 化は load の後方互換に注意(v1 封筒は不変、診断コード追加のみ)。

## H2-13 実装証跡(2026-07-16)

変更前に7 focused test fileへ12境界のprobeを追加した。最初の実測は618件中581 pass / 37 failで、
型付きAPIを迂回するruntime JS入力を含め、既存の無診断通過を再現した。attachment probeは登録時同期
だけでは不足を再現しないため、登録後にsource poseを変更して初回`update(0)`する形へ強化した。

| # | 変更前probe | 実装/責務 |
|---|---|---|
| 1 | lifetime NaN、drag文字列、gravity Infinity vec3、velocity speed誤形状がfactory/compileを通過 | coreのmodule-config collectorへnested fieldを含むscalar/vec3別の共有ValueInput検証を追加。User/built-in parameter型はuniform定義の単一ソースを参照。`NACHI_VALUE_INPUT_INVALID` |
| 2 | octaves NaN/非整数/0/5が通過 | 共有collectorでsafe integer `[1,4]`。`NACHI_TURBULENCE_OCTAVES_INVALID` |
| 3 | spawn/setTransform/attachmentの非有限値がuniformへ到達 | core/timeline各package内でvalidatorを共有し、spawn ID採番、source保持、pose/mesh/GPU書込み前に原子的にthrow |
| 4 | 負hit-stop/shakeと空markerがformat loadを通過 | asset validatorと公開JSON schemaをauthoringの値域へ同期。`NACHI_ASSET_TIMELINE_*` |
| 5 | 直接構築したsamples 0等がPost graphを生成 | pass factoryのvalidatorを`PostPipeline` constructorから再実行 |
| 6 | 未知collision modeがbounce分岐へ落下 | core共有collectorで厳密enum。scene-depth以外はmode必須。`NACHI_COLLISION_MODE_INVALID` |
| 7 | ribbonId負/小数/offset/未知tag、未知UVが通過 | trails package collectorをfactory/registryで共有し、countを含むu32表現可能性・tag・UV語彙を検証 |
| 8 | VAT numeric time NaN/Infinityとboolean文字列が通過 | `validateVat`でfinite time、strict `loop`/`disableFrustumCulling`をmutation前に検証 |
| 9 | normalizedAge readerだけのschemaが無診断 | compilerがactual write ownershipを確認。age+lifetime両writeまたは明示normalizedAge writeで抑止。`NACHI_NORMALIZED_AGE_WITHOUT_LIFETIME` warning |
| 10 | maxRibbons 2にribbonId 2が無音破棄 | render compile contextのdefinitionから静的ID上限を照合。`NACHI_RIBBON_ID_OUT_OF_RANGE` |
| 11 | timeline spawnのNaN/Infinity/負/文字列timeScaleが通過 | constructor/setter/spawn共有の非負有限validator |
| 12 | attach後pose変更→初回update(0)のat:0 playが旧pose | 初回`beginUpdate`内でattachment syncをtime-zero actionより先行 |

### 検証対称性と構築サイト棚卸し

| 境界 | authoring / helper | format / deserialize | runtime / direct construction |
|---|---|---|---|
| #4 timeline action | `validateAction`がhit-stop、camera shake、markerを値域検証 | asset validatorとJSON schemaが同じ非負/正/非空制約を適用し、負例loadを拒否 | runtimeは正規化済みdefinitionを使い、公開`applyHitStop`も非負有限制約を維持 |
| #5 post config | 各pass helperが共有validatorを実行 | 該当なし(公開format envelopeなし) | `PostPipeline` constructorが直接構築configを同じvalidatorで再検証 |
| #8 VAT config | `applyVat`がtime/booleanをmutation前に検証 | 該当なし(公開format envelopeなし) | cloneは`applyVat`へ再入し、timeline time setterも有限値を再検証 |

H1-3方式の構築サイト再走査は、公開ページ生成site 2 rootと今回変更する6 packageのproduct sourceを
対象とする。対象拡張子は`.ts`/`.tsx`。testsとdocsは回帰/証跡でありproduct構築siteではないため除外し、
`dist`/`node_modules`はscope外、generated directoryと`*.generated.ts(x)`は明示除外する。TypeScript ASTを
使うためcommentやfunction declarationを誤計数しない。最終worktreeでの再実行コマンドは次の1行である。

```sh
node tools/scan-input-validation-sites.mjs
```

| 区分 | 式数 | file数 | AST条件 |
|---|---:|---:|---|
| affected factory | 553 | 31 | core behavior 23種、post 3種、trails 2種、VAT `applyVat` のcall |
| compile | 8 | 4 | identifier `compileEmitter(...)` |
| load | 3 | 2 | identifier `loadEffect(...)` |
| direct constructor | 163 | 31 | `*VFXSystem` / `PostPipeline` / `TimelineEffectInstance` の`new` |
| runtime mutation | 224 | 32 | property call `.spawn()` / `.setTransform()` / `.attachTo()` |
| diagnostic opt-out | 16 | 8 | `onBuildDiagnostic: null` 6式/4 files + `onRuntimeDiagnostic: null` 10式/5 files |

対象rootはscript内に固定した`apps/playground/src`、`apps/showcase/src`、core/format/post/trails/mesh-fx/
timelineの各`packages/*/src`である。review修正によるopt-out追加は0件。canonical browser走査で新warningが
顕在化した`m10-sort`のdecal manifest/quality fixtureは診断opt-outを追加せず、`lifetime(1)`を所有させた。
意図的な既存診断契約以外のwarning/errorは全19ページで0件だった。

### 初回独立review指摘のclose

初回fresh reviewは **Blocker 0 / Should 5 / Nit 1**。修正前probeを4 filesへ追加した実測は
551 tests中534 pass / 17 fail(ValueInput 4、required collision factory/raw各4、normalizedAge 1、
trails 1、core transform 1、timeline transform 2)で、6指摘を独立に再現した。

1. `positionSphere.center`/`arc.thetaMax`を含む全通常ValueInput fieldを共有descriptorへ載せ、
   materialized built-in path/type/default/materializationを内部単一ソースへ集約した。User/built-inの型不一致と
   合法constant/range/curve/parameterを回帰化した。
2. collision modeはscene-depthだけ省略可とし、plane/sphere/box/SDFのfactory/raw compile各4種を固定した。
3. normalizedAgeはbuffer allocationでなくauthor accessのwrite ownershipを使い、read-only allocationはwarning、
   age+lifetime両writerまたは明示normalizedAge writerは抑止する契約にした。
4. alternating count上限をu32最大値へ修正し、`2^32-1`/`2^32`とoffset終端をfactory/registry双方で固定した。
5. core/timelineのspawn omissionとrequired live/attachment positionを分け、invalid input後もID/instance count、
   source、内部pose、mesh/GPU値を維持する。coreのgetter内reentrant releaseは従来どおりquiet returnする。
6. 上記AST scanを常設し、scope/extension/exclusion/category/opt-outの再現可能な数値を記録した。

fresh再reviewは **Blocker 0 / Should 1 / Nit 0**。通常ValueInputの必須fieldを `undefined` にした
factory/raw入力と、parameter generatorのpath欠落・非stringが診断なしで通る境界を独立probeで再現した。
共有descriptorへ必須/optional区分を追加し、kill-volumeのshape依存 `radius`/`size` も含めて必須値を
`NACHI_VALUE_INPUT_INVALID` にした。parameter generatorはfallback省略を維持しながらstring pathを必須とし、
optional field省略、合法なstring path parameter、factory/raw compileの正負回帰を追加して指摘をcloseした。

最終reviewではattachment getter内のreentrantなsource差替えと、AST scanのtest file除外に2件の
追加指摘があった。最初のsource identity guardではdirect `attachTo(A)` のgetter内で完了したnested
`attachTo(B)`/`detach()`をouter Aが上書きし、同じsourceへのreentryも識別できない残件が再現した。追加4 probeの
実測は2 files / 302 tests中298 pass / 4 failで、core/timelineのdirect差替えとsame-source reentryがいずれも
差替え先 `[7,8,9]` をouter sample `[40,50,60]` で上書きした。

core/timelineはいずれもdirect attach、scheduled sync、detach、releaseを通じてattachment operation revisionを
更新する。getter内のnested operationが同じsourceを使う場合や、nested invalid attachをgetterがcatchした場合も
outer revisionを失効させ、nested invalid単体は従来source/poseを変えない。差替え先のposeとtimeline初回
`update(0)`の時刻0 child/meshは同一update内で差替え先を維持し、detach/releaseもquiet returnする公開API回帰を
追加した。scannerは`*.test.ts(x)`と`*.spec.ts(x)`を拡張子判定前に除外し、上表をproduct sourceだけの件数へ
更新した。

final TOCTOU再reviewでは、array indexやobject component accessorが検証時に有限値、commit時に`NaN`を
返す境界と、attachment sourceが返したtransformの`position` getter内でnested `attachTo(B)`した場合に
outer AがBの即時poseを上書きする境界が再現した。core/timelineは公開transform operationごとに
position/rotation property、tuple length/index、object `x/y/z`を各1回だけ読み、owned frozen snapshotへ
正規化する。validation、matrix、stored pose、child spawn/update、mesh/GPU commitは元入力を再読しない。
attachmentはsource getter直後とsnapshot後のcommit直前にrevision/sourceを二段確認し、source getter内の
release/差替えはquiet discardしたまま、transform property/component getter内のdifferent/same-source attach、
detach、release、caught invalid attachもouter commitを失効させる。通常spawn/setTransform、direct attach、
scheduled sync、初回`update(0)`のchild/meshを公開API回帰で固定した。

final timeScale accessor再reviewでは、core/timelineのspawn options getterが最初に`1`、次に`NaN`を返すと、
事前検証後にconstructorが再読してRangeErrorとなりIDを消費する境界を再現した。coreの`priority`も同じ多重read
だった。分離した追加probeの実測は2 files / 315 tests中312 pass / 3 fail(core timeScale、core priority、
timeline timeScale)。coreは`timeScale`/`priority`をID前に各1回primitive snapshot化し、同じ値をclock/
significanceへ渡す。timelineはconstructorが消費する`timeScale`、position、rotation、seed、camera-shake target、
parametersをID前に各1回読み、plain frozen own-data options recordを渡す。公開constructor末尾の内部transform
snapshot引数は削除し、direct constructionの再検証を維持した。合法なfirst readはID `-1` とclock値を保持し、
不正なfirst readは1回のreadでthrowしてIDを消費しない。

### 最終回帰

- focused: 7 files / 683 tests PASS(初回変更前probeは618件中581 pass / 37 fail、review probeは上記17 fail、
  residual attachment probeは上記4 fail、final TOCTOU/timeScale probeは上記境界)
- workspace: 33 files / 980 tests、typecheck 12対象、build、ESM smoke 9 packages、lint、format check、
  `git diff --check`、changeset statusがすべてPASS
- canonical GPU: playground 13 + showcase 6 = 19/19 PASS、`failed=[]`
- golden: 7/7 PASS、既存baseline 23 filesは更新なし(`m10-sort`もchanged pixels 0)

README 6件、RFC日英、format schema、6 packageのminor changesetを同じ公開契約へ更新した。

### 最終独立受入(2026-07-16)

実装・各review修正のいずれにも関与していないfresh reviewerが、12項目、公開API/互換性、scannerの
test/spec除外と全件数、README 6件、RFC日英、changeset、変更scopeを再監査した。独自public probeでも
core/timelineのaccessor-backed spawn optionが各1回だけ読まれ、合法値はID `-1` とowned値を維持し、初回不正値は
IDを消費せず拒否されること、direct constructorの再検証、transform snapshotとattachment二段revision guardを
確認した。最終判定は **ACCEPT — Blocker 0 / Should 0 / Nit 0**。focused 683件、workspace 980件、
typecheck/lint/format/build/ESM、changeset/diff/scanner、canonical GPU 19/19、golden 7/7を独立再実行し、
baseline 23件不変、生成物なし、検証server停止を確認してH2-13をcloseした。
