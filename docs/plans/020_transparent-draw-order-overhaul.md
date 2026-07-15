# 020: 透明描画順の全面対応(sorted 既定見直し・renderOrder 合成・decal 拡張)

- 重大度: 高(破壊的成分あり=RFC 起票の上で断行)
- 対象: `@nachi-vfx/core`、`@nachi-vfx/three`、`@nachi-vfx/format`、RFC 006 / 001
- 状態: 受入済み(H2-7、2026-07-15、fresh最終独立レビューACCEPT、BLOCKER/SHOULD/NIT=0)
- 出典: H1 後続 Codex 探査 T3 C-1/C-2 + T2 A-2 + T5 F-03(2026-07-14)

## 症状(静的監査、確度=確実)

1. **T3 C-1**: `sorted` 未指定の billboard / lit / mesh alpha は atomic compaction 順が
   instance 描画順になり、normal/premultiplied alpha で結果が非決定
   (mesh は `depthWrite:true` により近接透明 mesh の depth reject も併発)。
2. **T3 C-2**: decal には sorted オプション自体がなく、常時 compaction 順 NormalBlending。
   重なった decal の最終色がラン間で変わる。
3. **T2 A-2**: 透明エミッタの自動ソートが `renderOrder = 1000 + rank` でユーザー設定を丸上書き
   (`system.ts:3261` → `three/index.ts:1079`)。合成・オフセット API なし。
4. **T5 F-03**: decal 投影姿勢が `Particles.rotation` 既定(identity)のままで spawn 回転を
   継承しない(中心は追従するが投影 box の向きが変わらない)。

## 裁定(2026-07-14)

**全面対応**(推奨の小改修+文書化を超えるユーザー裁定)。方針:

1. 透明(alpha/premultiplied)renderer の `sorted` 既定を true 方向へ見直す
   (破壊的=core major 成分。perf 影響と quality tier の sorted ゲートの扱いを含め
   RFC で確定してから実装する)。
2. 自動 renderOrder ソートをユーザー値と合成する(base+rank 方式、オフセット API)。
3. decal へ sorted 経路+spawn 回転継承を追加。
4. unsorted 選択時の意味論(compaction 順=非決定)を RFC に明記し、WBOIT との選択指針を統合。

## 受け入れ基準

1. RFC(既定・合成規約・decal 拡張・性能影響・quality tier 整合)がレビュー承認されている。
2. 異色半透明の重なり fixture でラン間・spawn 回数間の描画順が決定的(GPU 実測)。
3. ユーザー renderOrder(オフセット)が自動ソートと合成され、システム外オブジェクトとの
   相対順を制御できる(プローブ)。
4. decal: sorted 有効時の重なり順決定性+回転 spawn で投影姿勢が追従(新 GPU 回帰)。
5. sorted 既定変更の perf 比較(perf v2 median)と、`setQualityTier()` の sorted ゲート
   (再コンパイル境界)整合。
6. 全ゴールデン・ショーケースの差分を構造比較で裁定(順序変化由来の意図差分のみ再記録)。

## 互換性 / リスク

- 既定変更は core major 成分(0.x でも RFC 003 §2 方式で severity 確定、降格しない)。
- 予算直撃のため quality tier での sorted 降格経路を必ず残す。
- 実装順は H2 内で決定性系(019/018)の後が安全(順序差分の弁別のため)。

## PHASE 1: 変更前再現(2026-07-15)

共有HEAD `b03ac85`を変更せず、`/m10-sort/`と一時playground probeをSwiftShader WebGPUで実行した。一時
probeは証拠採取後に削除し、product/test surfaceには残していない。

### module既定・compaction順

alpha/premultipliedのbillboard、mesh、decal helperはいずれもmodule version 1を出し、compiled drawは全て
`physicalIndex:'alive-indices'`だった。3粒burstのGPU readbackではphysical alive順と、その順でvertexが読む
semantic birth keyが次のように変化した。

| 時点 | physical alive index | draw順の`spawnOrder` |
| --- | --- | --- |
| 初回burst後 | `[0,1,2]` | `[2,1,0]` |
| `spawnOrder=1` death/compact後 | `[0,2]` | `[2,0]` |
| recycle slotへ再spawn後 | `[0,1,2]` | `[2,3,0]` |

すなわちexplicit unsortedはsemantic birth順でなく、free-list allocation/death/reuseに依存する。現行
`/m10-sort/`の明示sorted readbackはcamera Aでvalid indices=`[2,1,0]`、中心pixel=`[53,12,188,241]`、
camera Bで`[0,1,2]`、`[188,12,53,241]`となり、sort経路自体の反転は成立している。

### mesh depth、renderOrder overwrite、decal姿勢

- 同一透明mesh内でnear redを先、far blueを後に描くfixtureは、現行`depthWrite:true`の中心pixelが
  `[166,0,0,166]`となりblueをdepth rejectした。同じmaterialをfixture側で`depthWrite:false`へ切り替えると
  `[58,0,166,224]`となり両layerがblendした。
- materialize後にuserがspriteの`renderOrder=37`を設定しても、次の`VFXSystem.update(0)`で`1000`へ丸上書き
  された。既存coarse fixtureはcamera Aでfar/near=`1000/1001`、camera Bで`1001/1000`、中心pixelはそれぞれ
  `[59,22,174,229]`、`[174,12,59,229]`。
- emitterをtranslation `[2,3,0]`、Z rotation `π/2`でspawnし、positionSphere center `[1,0,0]`を使うdecalは
  GPU position=`[2,4,0]`となった一方、Emitter quaternion=`[0,0,0.70710678,0.70710678]`に対して
  Particles.rotation=`[0,0,0,1]`のまま。centerだけがtranslation/rotationに追従し、projection姿勢は継承
  しない症状を弁別した。

### asset readerの安全性

変更前formatはmodule versionを任意の正整数として受理し、変更前coreのbillboard/mesh/decal direct compiler
branchはversion registryを解決せずversionを無視する。従ってdecal module@2へ`sorted:true`を足すだけでは、
old readerがfieldを黙って無視してunsorted実行する。これはRFC 003 §4を満たさない。

変更前readerへ仮のenvelope version 2 documentを渡すprobeは、compile前に
`NACHI_ASSET_VERSION_UNSUPPORTED: Asset version 2 cannot be migrated to supported version 1.`を返した。この安全
拒否を利用し、RFC 006はnew helper/module v2に加えてasset envelope v2を必須とする。

### 変更前perf v2 (5 runs)

`/m10-sort/`、同一SwiftShader adapter、warmup 4、complete GPU samples 16/runの変更前値。単位ms。

| build | run medians | run p95 | median of medians | median of p95 |
| --- | --- | --- | --- | --- |
| old `b03ac85` | `0.341, 0.327, 0.361, 0.372, 0.319` | `0.447, 0.472, 0.538, 0.538, 0.447` | `0.341` | `0.472` |

PHASE 2は同じ負荷を5 runs再採取し、全値と代表値を比較する。さらにlow/medium sorted-offのbudget escapeも
別行で固定する。

## PHASE 1: 確定候補設計

規範全文は新規[RFC 006](../rfc/006-transparent-draw-order.ja.md)。checkpointで次を一括承認してから
product codeへ進む。

1. **module意味境界**: 現行helperはbillboard/mesh/decal module v2を出し、alpha/premultiplied omittedを
   明示`sorted:true`、additive/multiply omittedを`false`。raw v2 omissionも同義。module v1 omitted=false、
   explicit true、mesh depthWrite=true、decal unsorted/無rotation継承を保存し、direct compilerをversion-aware化。
2. **format境界**: serializer/current schemaはenvelope v2。default v1→v2 migrationはtop-level versionだけを
   変更するenvelope-only migrationで、input非mutation、payload deep/byte保持、module version非upgrade。
   old readerはenvelopeで安全拒否。v2 renderer configはversion-aware strict validation、v1はhistorical generic
   acceptanceを保持する。formatを対象packageへ追加する。
3. **depth**: v2 meshは全blendingで`depthTest:true/depthWrite:false`。v1は旧trueを保存。
4. **order API所有**: core v2 render configにsigned-int32 `renderOrderOffset`、Threeの
   `ThreeSpriteMaterializationOptions` / `ThreeMeshMaterializationOptions` /
   `ThreeDecalMaterializationOptions`全てに`renderOrder?:number`を置いてregistration baseとし、persistent
   `setRenderOrderBase()`を公開する。sprite/mesh base既定1000、既存decal field/既定10を保存する。decal v2にも
   emitter-local `sortCenter?:Vec3`を追加し、既定をemitter originとする。
5. **厳密式**: `bucket=base+offset`、alpha/premultipliedは
   `final=bucket+(rank+1)/2^20`、非参加drawは`final=bucket`。bucketもsigned int32、auto entry上限
   `2^20-1`。far→near rank、tieはnumeric instance sequence→emitter key→draw path/index。この範囲ではdouble
   で全値が厳密かつ非衝突。外部objectの整数bucket/bucket+1で前後を制御できる。
6. **runtime/Three state**: assignmentはkernels全体scalarでなくdrawIndex別。materialization前assignmentを
   保存しlate registrationへ反映。direct Object3D mutationは非永続、setterのみpersistent。pool返却/完全release
   はassignmentをclearし、retained activationも最新値を再適用する。
7. **decal rotation**: v2 decalだけcompiler-owned Init defaultをgeneric defaults後/authored Init前へ挿入する。
   compiler virtual `Emitter.spawnInterpolatedRotation`はposition transformと同じspawnIndex phase/active branchを
   共有し、shortest slerp、inactive時exact-currentを返す。これをnormalizeしてParticles.rotationへwrite。
   positionは既存world-spaceのままでtranslationを二重加算しない。authored Init/update rotation writeは後勝ちの
   absolute world override。birth captureであって後追従ではない。
8. **quality/camera**: sorted gateはlow/medium=false、high/epic=true。live tier変更は既存compiled instanceを
   in-place recompileせずrestart-required、新spawn/pool keyが境界。v2 decalをparticle/coarse camera診断に含める。
9. **release severity**: core/three/formatはいずれもsemantic major成分。pre-1.0なのでchangeset severityは
   RFC 003どおり`minor`だが本文にbreaking/migrationを明記し、patchへ降格しない。

現行compilerの1 render module/emitter制限は維持する。ただしorder protocolは将来の複数drawでkernel-wide
overwriteを再発させないようdraw index/pathを含める。独立`VFXSystem`間のglobal rankは対象外で、相互順が
必要なら異なるbase/offset bucketをhostが割り当てる。

## PHASE 2: 実装・恒常受入計画(checkpoint後)

### 実装順

1. core types/helper/module v1-v2 direct dispatch、decal compiler-owned spawn rotation、compiled draw order metadata。
2. format envelope/schema/types v2とdefault envelope-only migration、v1 historical/v2 strict
   roundtrip/old-reader fixture。
3. core runtime draw-entry rank/limit/camera/qualityとrenderer protocol。
4. Three mesh depthWrite、draw registration base/offset/rank/setter、late/prepared/pool lifecycle。
5. RFC 001 EN/JA、core/three/format README、changesetを同期。

### 恒常GPU・fault面

既存`/m10-sort/`を拡張し、verification suite page数を増やさない。canvasの既存3 panelは可能な限り保持し、
numeric resultに次を追加する。

- alpha/premultiplied billboard/mesh/decal v2 omittedと明示trueのsorted indices、v1 omitted/explicit falseの
  alive indices、compact→death→recycle spawn撹乱。
- mesh old/new depth readback、decal 2色overlap sort、translation+rotation storage readbackと非対称projection。
- base+offset+fraction rank、外部Three objectをbucket/bucket+1へ置く前後、同depth numeric tie、camera反転。
- materialize-before/after rank、setter後のruntime update、retained prepare、実release→pool checkout→update前
  materializeで前generation orderが漏れないこと。
- low/medium対high/epicのcompiled physical index、`setQualityTier()`のrestart boundary/compilationCount、
  camera未設定warning。

fixture-only `forceFailure`は`default-unsorted`、`mesh-depth-write`、`rank-overwrite`、
`decal-no-spawn-rotation`、`pool-stale-order`を独立実行し、各対応validationだけをfailさせる。production compiler/
runtimeへfault branchを入れない。

### regression構造比較

golden 7件、showcase 6件、playground verification全件について、screenshot更新前にcompiled draw manifest
(`type@version`、blending、physical index、depthWrite、base/offset/auto参加、decal rotation capture)をold/new比較
する。v2 alpha/premultipliedの意図差分と明示false/legacy-v1不変を分類し、その後region screenshot差分を裁定。
本RFC以外の差分は再記録しない。

### plan 026 residualの先行解消

`docs/plans/026` T2 B-1の静的指摘は現行`prepareKernelsForPooling()`がdraw registryをdisposeしてもkernel上の
`THREE_RENDER_ORDER`をclearせず、完全`releaseKernels()`だけがdeleteすることで確実と確認した。H2-7はorder
state ownershipを全面変更するため、この残余を先行してscopeへ取り込む。PHASE 2受入時に上記actual-pool回帰
と実装証跡をplan 020/026双方へ記録し、H2-15から重複実装を除く。

## PHASE 2: 実装・恒常受入結果(2026-07-15)

RFC 006を承認済みへ更新し、core/three/format、RFC 001 EN/JA、各README、changesetを同期した。実装は
renderer module v1/v2 direct dispatch、v2 default sort、draw-index coarse rank、signed-int32
base+offset+fraction合成、v2 mesh depthWrite=false、decal sort/spawn rotation、quality/restart/camera、pool state
clear、asset envelope/schema v2を一括で完了した。`maxTransparentDrawOrderEntries`のspawn preflightはpool/resource
保持前に実行し、上限超過instanceをsystemへ残さない。formatのv1 reserved guardはactual emitter `render`と
emitter-extension `overrides.render.modules`だけをboundedに調べ、opaque config内のlookalike payloadは保持する。
renderer@2 nested alignment/asset-ref/flipbook/lit/soft/cutoutもunknown fieldと型をstrictに検証する。

### compiled manifestとscreenshot前分類

M10の実compiled/GPU manifestで次を固定した。

| 分類 | 実結果 |
| --- | --- |
| v2 alpha/premultiplied omitted/explicit true | billboard/mesh/decalの12 probeすべて`sorted-indices`、readback=`[2,1,0]` |
| legacy/opt-out | billboard/mesh/decalのv1 omittedとv2 explicit falseの6 probeすべて`alive-indices`、readback=`[0,1,2]` |
| mesh depth | additive/alpha/multiply/premultipliedの全てでv1=`true`、v2=`false` |
| order | base/offsetのinteger bucketにrank `1/2^20`単位を厳密合成。camera反転、setter、direct mutation再適用、external bucket境界を実pixelで確認 |
| decal | v2 synthetic Init capture、stored position=`[2,4,0]`、quaternion=`[0,0,0.7071068287,0.7071068287]` |

screenshot比較前にgolden 7件、showcase 6件、verification 15件のsource/compiled分類を行った。golden explosion
debrisとambient leavesのomitted-alpha meshはv2 sorted/depthWrite=falseの意図差分、explicit-sorted smoke/ultimateは
indirection意味を保持、additive billboard群はv2でもalive-indexのまま。ただしThree sprite/mesh registration
base既定はaccepted contractどおり0から1000へ移り、ribbon/decal等とのsubmission orderは変わり得る。golden
slashはadditive sparks/ribbonのparticle pathを保持しつつこのbase境界が変わり、decalもv2 sorted/order/spawn-
orientation contractへ移行した。showcase 6件のparticle billboardは明示additiveでalive-index不変だが同じbase
移行対象。M10は上表のnew/legacy両経路とbase/offsetを実測し、他verification pageもhelper由来module-v2と
明示false/backend boundaryを分類してからPNG比較した。

`pnpm verify:gpu`はpage数を増やさずplayground 9 + showcase 6 = 15件全pass。`pnpm golden:regress`は7件全pass。
showcase 6件とplayground baseline（`m10-sort.png` hash
`d9e3eeb6784af91505f4f155661dd24511ea017ebeec4b944c26eab307fb8735`を含む）は更新不要だった。
golden slashだけは上記decal契約に一致するimpact region 107 pixel（全体ratio
`0.0004158893`、region `0.0041796875`）を意図差分として再記録し、hashを
`df7d5f55f3fc5a8c1764f1f965a2b43d01bd02497c9bc0a4814c0ee44b2e9a6f`から
`41048dd89494f7bdf7d3bc8c8ef1a7df6bef45eaab6a10665b2324928c73aea5`へ更新した。再実行は7件全pass。

### M10 GPU/fault/quality証拠

- 通常WebGPU: 全20 validation pass、console/page errorなし、`m10-sort.png changedPixels=0`。
- mesh old/new center pixel: v1=`[166,0,0,166]`、v2=`[50,1,178,228]`。
- decal overlap camera A/B: `[58,11,166,224]` / `[166,11,58,224]`。非対称textureのv1/v2 sampleも
  3点全て非zeroかつ色が反転した。
- external Three object: bucket pixel=`[175,33,60,250]`、bucket+1=`[38,206,19,250]`。
- actual recycle: death後spawnOrder=`[2,0]`、slot再利用後=`[2,3,0]`。pool checkoutは同kernelを再利用し、
  update前base=`50`、update後=`50 + 1/2^20`、retained prepare/late materializationもrankを保持した。
- quality manifestは3 rendererすべてlow/medium=`alive-indices`、high/epic=`sorted-indices`。live low→highは
  compilation count `1→1→2`と`NACHI_QUALITY_RESTART_REQUIRED`を確認。
- WebGL2 negative runは`NACHI_PARTICLE_SORT_WEBGL2_UNSUPPORTED`と
  `NACHI_WBOIT_WEBGL2_UNSUPPORTED`の両validationをpass。

fault isolationは各runで対応validationだけがfalse、その他とdiagnostic validationはpassした。

| `forceFailure` | 唯一falseのvalidation |
| --- | --- |
| `default-unsorted` | `defaultSorted` |
| `mesh-depth-write` | `meshDepthWrite` |
| `rank-overwrite` | `rankComposition` |
| `decal-no-spawn-rotation` | `decalSpawnRotation` |
| `pool-stale-order` | `poolStaleOrder` |

### 変更後perf v2

初回5-runでcapacity 1 sorted drawにも毎frame depth準備submitが残ることを検出し、physical indexが必ず0の
caseはzero-initialized sorted indirectionを使ってsubmissionを省略する回帰付き最適化を入れた。最適化後の
正式5-runは変更前と同じSwiftShader、warmup 4、complete 16 samples/run。単位ms。

| build/tier | run medians | run p95 | median of medians | median of p95 |
| --- | --- | --- | --- | --- |
| old `b03ac85` epic | `0.341, 0.327, 0.361, 0.372, 0.319` | `0.447, 0.472, 0.538, 0.538, 0.447` | `0.341` | `0.472` |
| H2-7 epic | `0.344, 0.316, 0.375, 0.299, 0.361` | `0.493, 0.409, 0.521, 0.371, 0.556` | `0.344` | `0.493` |
| H2-7 low sorted-off | `0.307` | `0.477` | `0.307` | `0.477` |
| H2-7 medium sorted-off | `0.344` | `0.487` | `0.344` | `0.487` |

代表medianは`+0.003ms`（`+0.9%`）、代表p95は`+0.021ms`（`+4.4%`）で15%閾値内。low/medium runは
capacity/spawn scaleをfixture overrideで1へ固定し、sorted gateだけを落とした同一particle負荷で全validationと
changedPixels=0を維持した。

### 最終gate証拠

実装・baseline裁定後にrelease相当の全gateを再実行した。`pnpm format`と`pnpm format:check`、`pnpm lint`、
`pnpm typecheck`、`pnpm build`は全pass。`pnpm test`は32 file / 780 test、`pnpm esm:check`は公開9 package、
`pnpm verify:gpu`はplayground 9 + showcase 6 = 15 page、`pnpm golden:regress`は7件が全passした。
`pnpm release:dry`はchangeset release planの公開6 package、VERSION export、全公開packageのtarballに
workspace参照が残らないことを確認してpassした。Changesets statusにprivate appが`type: none`で含まれる現行出力も
release対象として誤判定しないようdry-run verifierを補正した。最後に`git diff --check`をpassし、一時file、backup、
status JSON、tarballの残留がないことを確認した。

### 初回独立レビュー修正(2026-07-15)

初回独立レビューのREJECT 1B / 1S / 1Nを次のとおり閉じた。

- B1: renderer@2 strict validationの境界をmigration前のsource envelope versionから、migration後document内の
  actual module versionへ変更した。default v1 envelope-only migrationが残すrenderer@1はgenericのまま、custom
  v1→v2 migrationがrendererを@2へupgradeした場合は必ずstrict validationを通る。custom migrationがbillboard@2へ
  未知fieldとnested `lit.roughness=2`を挿入する回帰で、`validateEffectAsset()`と`loadEffect()`の双方が正しいpathの
  `NACHI_ASSET_UNKNOWN_FIELD` / `NACHI_ASSET_VALUE_INVALID`を返すことを確認した。既存のv1 reserved guard、opaque
  lookalike保持、default migration互換、old-reader拒否回帰も全pass。
- S1: `registerDrawObject()`はbase/offset/bucket/current rankをregistry作成・登録前に合成検証する。materializerが
  既に生成したObject3Dをvalidation failureでcallerへ返せないため、失敗時はgeometry/materialをtransactionalに
  disposeして元のdeterministic RangeErrorを再throwする。base非整数、offset非整数、bucket overflow、rank上限の
  4 caseすべてでregistry symbol未作成かつgeometry/material各1回disposeを固定した。setterもcurrent rankを含む
  全合成をstate更新前に検証する。
- N1: plan 026の受入基準を、H2-7へ移管済みのT2 B-1を除いた残りの要検証1件（T4#5）へ整合した。

focused regressionはformat/threeの2 file / 94 testがpass。修正後にformat/check、lint、全workspace typecheck、
32 file / 780 test、全build、公開9 package ESM gateを再実行して全passした。成功経路に触れるThree変更は
`/m10-sort/`のSwiftShader WebGPU実行でも全validation、diagnostic validation、performance validationがpassし、
`m10-sort.png changedPixels=0`。baselineは更新していない。

### fresh再レビュー修正(2026-07-15)

fresh再レビューのREJECT 0B / 1S / 0Nを閉じた。`gateRender()`は従来、raw renderer-v2のadditive/multiplyに
明示された`sorted:true`までlow/mediumのquality gateで`false`へ書き換え、high/epicだけが
`NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED`へ到達していた。RFC 006 §2どおり、このunsupported明示値はtierで
正常化せず`true`を保持し、compilerがlow/medium/high/epicの全tierで同じdiagnosticを返すよう変更した。

scalability回帰はraw v2 billboard/mesh × additive/multiplyを全4 tierで検証し、gate後も`sorted:true`で
`NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED`になることを固定した。compiler回帰も同じ4 renderer/blend組合せを
helperが早期拒否し、raw v2 direct compileが同diagnosticを返すことを確認した。正常系はbillboard/mesh/decal ×
alpha/premultiplied × omitted/explicit trueの12組合せすべてでlow/medium=`alive-indices`、
high/epic=`sorted-indices`を維持する。invalid nonboolean raw値とv1 billboard/decal semanticsも全4 tierで不変。

focused regressionはcore scalability/compilerの2 file / 226 testがpass。format/check、lint、全workspace
typecheck、32 file / 780 test、全build、公開9 package ESM gateも再実行して全passした。product変更は既に
compile errorとなるraw invalid分岐だけで、正常gateの結果とruntime/GPU入力は変化しないためM10再実行は不要と
裁定した。baselineは更新していない。

### final fresh review修正(2026-07-15)

final fresh reviewのREJECT 0B / 1S / 0Nはdocs-only serialization契約の不整合だった。RFC 001 EN/JAを
RFC 006 §9、`@nachi-vfx/format` README、公開type/schema export、実loader/migrationと突合せ、現行canonical
documentを`nachi-effect` envelope v2へ統一した。`effectAssetSchemaV2` / `EffectAssetDocumentV2` / current
`EffectAssetDocument` aliasを主契約、v1 schema/typeをinspection・明示migration tooling向けcompatibility exportと
明記した。serializerはv2だけを出力し、loaderはnative v2とdefault migration後のhistorical v1を受理する。

default v1→v2はtop-level versionだけを変更するnon-mutating envelope-only migrationで、effect payloadとmodule
versionを変更しない。custom migrationは明示境界で、migrated documentのactual module versionに対するvalidationを
迂回できない。renderer@2 reserved guardとv1-only old readerのenvelope-v2 safe rejectionはRFC 006へ接続した。
H2-6、Grid2D、Grid3D、NeighborGridは「導入当時のenvelopeはv1だった」という履歴へ書き換え、現行serializerは
同じpayload/module versionをcanonical v2へ格納すると明記した。emitter inheritance、exact registry reference、
simulation-cache future-format記述もv2現行契約へ揃えた。

変更はRFC 001 EN/JAと本planだけで実装・schema・baselineへ影響しないためfull testは不要と裁定した。関連v1/v2
表現を`rg`で再棚卸しし、残るenvelope-v1記述がhistorical/compatibility/default-migration文脈だけであることを確認。
format-check、lint、`git diff --check`を再実行して全passした。baselineは更新していない。

### acceptance review修正(2026-07-15)

acceptance reviewのREJECT 0B / 1S / 0Nをdocs-onlyで閉じた。RFC 003 §4 EN/JAのcurrent envelopeをv1から
canonical v2へ更新し、historical v1 inputはdefault non-mutating envelope-only v1→v2 migrationで受理すること、
effect payload/module versionは不変であること、v1-only old readerはv2をcompile前にsafe rejectすることを
規範化した。既公開envelope versionをreader間で曖昧にしない原則、module upgradeをenvelope migrationから
推論しない原則、package-major期間のv1 compatibility pathも維持した。

RFC 004 §5 EN/JAの「asset envelope stays version 1」はH2-6実装当時のhistorical statementへ変更した。H2-7で
renderer境界のcanonical envelopeがv2となり、default envelope-only migrationはH2-6のmodule-v1/v2 space recordの
payload/versionを変更しないため、module semanticsはそのまま維持される。RFC 001 §11.1、RFC 003 §4、RFC 004
§5、RFC 006 §9を相互参照して、canonical output、compatibility input、module-version ownership、old-reader
rejectionが同じnormative contractを示すことを確認した。

全`docs/rfc/**/*.md`を、`canonical|current|unchanged|remains|stays`と`envelope version 1/v1`の近接、
`effectAssetSchemaV1` / `EffectAssetDocumentV1`、literal `nachi-effect` version 1のqueryで横断した。修正後に残る
envelope-v1表現はRFC 001/004の明示historical文脈とRFC 001/003/006のcompatibility/migration文脈だけで、
v1をcurrent/canonical主契約とする記述は0件。変更はRFC 003/004 EN/JAと本planだけで実装・baselineへ影響しない
ためfull testは不要と裁定し、format-check、lint、`git diff --check`をpassした。baselineは更新していない。

### signoff review修正(2026-07-15)

signoff reviewのREJECT 0B / 1S / 0Nを閉じた。`effectAssetSchemaV2.$defs.module.allOf`がrenderer-v2条件だけで
v1 schemaのconditional群を置換し、`core/position-sphere`のclosed config conditionalを失っていた。v2 `allOf`の
先頭へ`effectAssetSchemaV1.$defs.module.allOf`全体をspreadし、その後へrenderer 3条件を追加する継承構造へ
修正した。これにより将来v1 conditionalが増えてもv2へ自動継承される。

公開schema parity回帰は、v1 conditional object全体がv2のexact prefixであること、v2 conditional数がv1 + 3、
v1のtype const集合を全包含すること、差分がbillboard/mesh/decalの3種だけであること、type const重複がないことを
動的に比較する。従ってposition-sphereだけをhardcodeして通す回帰ではなく、将来v1 conditional追加時の全体継承を
検出する。workspaceにAjv依存はないため追加せず、public schema構造検証とruntime validatorの
position-sphere valid/unknown-field invalidを組み合わせて一致を固定した。

focused formatは1 file / 39 test、fullは32 file / 780 testがpass。format/check、lint、全workspace typecheck、
全build、公開9 package ESM gate、`git diff --check`も全passした。変更は公開JSON schema compositionだけで
compiler/runtime/GPU入力を変えないためGPU再実行は不要と裁定した。baselineは更新していない。

schema signoffのREJECT 0B / 0S / 1Nはtest display nameだけの残余だった。format suiteをcurrent v2 + v1
compatibility、NeighborGrid testをcanonical v2 envelope内のv1 payload保持と正確に改名した。format test内の
類似名を横断し、その他のv1表現は実際のcompatibility/module semanticsを示すことを確認した。

### fresh最終独立受入(2026-07-15)

最後の修正後は実装・初回レビュー・各fresh再レビューのいずれとも異なる担当が全差分をread-onlyで再監査し、
**ACCEPT (BLOCKER 0 / SHOULD 0 / NIT 0)** と判定した。初回以降に検出された合計1B / 5S / 2Nは、custom
migration後のstrict validation、Three order失敗時cleanup、H2-15残数、quality tierを跨ぐinvalid sort診断、
RFC 001/003/004/006のcanonical envelope v2整合、v2 JSON Schemaのv1 conditional継承、stale test名まで全て
閉鎖済みである。

最終状態ではfocused 5 file / 505 testとformat-check / lint / typecheck / `git diff --check`をfresh担当が再実行し、
統括もformat test 39件、core focused 226件、全32 file / 780 test、build、公開9 package ESMを確認した。実装差分の
最終GPU証拠はverification 15/15、golden 7/7、M10通常20 validationと5 faultの弁別、console/page errorなし。
正式perfはmedian +0.9%、p95 +4.4%で15%閾値内。tracked baseline変更は`golden-slash.png`の107 pixelだけで、
SHA-256=`41048dd89494f7bdf7d3bc8c8ef1a7df6bef45eaab6a10665b2324928c73aea5`、他baselineは不変である。
実機Vulkan/WindowsとH2-7前old-reader binaryの再実行は非ブロッキング未検証だが、SwiftShader実GPU、旧reader
envelope拒否境界、schema/migration回帰で受入条件を満たす。関連server/browser/test processと一時成果物の残留はない。
