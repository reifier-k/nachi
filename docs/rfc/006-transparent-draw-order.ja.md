# RFC 006: 透明描画順とdecalのspawn姿勢

> Language: [English](./006-transparent-draw-order.md) / 日本語 (このページ)

- **ステータス:** H2-7で承認・実装済み
- **適用範囲:** `@nachi-vfx/core`、`@nachi-vfx/three`、`@nachi-vfx/format`、versioned
  `nachi-effect` asset
- **規範的参照:** [RFC 001](./001-api.ja.md) §9.4、§9.5、§13、
  [RFC 003](./003-versioning.ja.md) §2–§4

## 1. 問題と規範的ゴール

alphaとpremultiplied-alphaの合成は順序依存である。未sortのNachi drawはM2のatomic compact-alive配列を
直接読むため、物理free-list割当、death、reuseによって、authoring上の粒子identityを変えずに可視順が
変わり得る。M10は粒子内sortをopt-inとし、projection decalにはsorted経路がなく、透明mesh粒子がdepthを
書き、自動coarse sortは全ての登録済みThree objectの`renderOrder`を`1000 + rank`で置換していた。

本RFCはこの契約を置き換える。新しいalpha/premultiplied billboard、mesh、decal helperは粒子内sortを
既定とする。明示opt-outは残すが非決定的である。透明meshはdepthを書かない。host orderと自動coarse
orderは置換せず合成する。新decalはspawn時のemitter姿勢をcaptureする。旧module-v1 documentは旧意味を
全て保持する。

## 2. Renderer module versionとsorted既定

本RFC後の`core/billboard`、`core/mesh-renderer`、`core/decal-renderer`は次の2 semantic versionを
supportする。

| Module | v1契約 | v2契約 |
| --- | --- | --- |
| billboard | `sorted`省略は`false`、明示`true`はalpha/premultiplied粒子をsort | alpha/premultiplied省略は`true`、additive/multiply省略は`false` |
| mesh | v1のsorted規則は同じ、Threeは粒子depthを書く | v2のsorted規則は同じ、Threeは粒子depthを書かない |
| decal | 粒子sortなし、自動coarse rankなし、粒子rotation既定はidentity | alpha/premultiplied省略は`true`、自動coarse rankへ参加、compiler-owned Init既定がspawn姿勢をcapture |

現行public helperはmodule version 2を出力し、configへ`sorted`を必ず具現化しなければならない。alphaと
premultipliedは`true`、additiveとmultiplyは`false`である。明示`sorted:false`はfalseを保持する。
additive/multiplyでの明示`sorted:true`は`NACHI_PARTICLE_SORT_BLEND_UNSUPPORTED`で引き続き無効である。
`sorted`を省略したraw v2 moduleもblending依存の同じ既定でcompileする。helper normalizationだけを
correctness境界にしてはならない。
v2 billboard/mesh/decal configはいずれも`renderOrderOffset?:number`と`sortCenter?:Vec3`を公開する。後者は
emitter-local pointのままで、既定はemitter originである。

version 1を暗黙upgradeしない。省略値、明示値、access manifest、draw indirection、mesh depth挙動、
decal姿勢、decal materializer orderは旧契約を保持する。特に、old readerが受理して無視した未知の
`sorted`をv1 decal configが含んでもunsortedのまま実行し、新readerがv2として再解釈してはならない。

compilerはこれらdirect built-inを`(type, version)`でdispatchし、上表のversionだけを受理し、未support
versionへ`NACHI_MODULE_UNKNOWN`を出す。direct renderer compiler branchはmodule versionを無視しては
ならない。

## 3. unsorted modeの意味と代替

alpha/premultipliedで`sorted:false`を指定すると、vertex instance indexはcompact alive-index配列を読む。
この配列にsemantic ordering保証はない。death/recycle後、burstの分割/結合、GPU scheduling、adapter間で
結果が変わり得る。seed、spawn order、stable random streamは物理順をrendering契約に変えない。これは
意図的なperformance/appearance trade-offであり、弱い決定的sortではない。

additive/multiplyは`sorted:false`が既定で、supportするblend式はback-to-front順を要求しない。密なoverlap
には近似的order-independent代替であるWBOITを使える。WBOIT integrationはsortを省略または
`sorted:false`にすべきであり、accumulationが使わないbitonic orderへcostを払うべきではない。WBOITを
既定にはせず、`@nachi-vfx/post`記載のdepth occlusion制約も残る。

## 4. 粒子sort、coarse sort、mesh depth

粒子sortとcoarse draw sortは異なる階層を解く。

1. sorted drawはdraw内部粒子のback-to-front indirectionを作る。同depthは既存physical-index tie-break。
2. `VFXSystem`はalpha/premultiplied draw entryをtransform済み`sortCenter`でrankする。rendererはobject単位
   で描くため、これはemitter間のcoarse orderに過ぎず、重なる2 emitterの粒子listをglobal mergeしない。

両階層はv2 billboard/mesh/decalに適用する。v1 billboard/meshはM10 coarse参加を保持し、v1 decalは
materializer-only orderを保持する。§5の異なる整数bucketは意図的にcoarse depthを上書きする。厳密な密集
cross-emitter overlapが必要なら1 emitterへ統合するかWBOITを使うべきである。

module v2のThree mesh particle materialは4 blending mode全てで`depthTest:true`、`depthWrite:false`を使う。
alpha/premultiplied粒子では、先に描いたnear instanceが後のfar instanceをrejectせずblendする。v1 meshは
旧`depthWrite:true`を保持する。

現行の1 render module/emitter制限は残り、H2-7でindirect argument slotは増やさない。ただし将来の複数draw
対応でkernel-wide overwriteを再導入しないよう、order protocolはdraw index/pathを運ぶ。

## 5. host order合成の厳密式

orderには3 componentがある。

- `base`: Three materialization registrationが所有するadapter/host値
- `renderOrderOffset`: v2 core render-module configに格納するsigned integer
- `automatic(rank)`: alpha/premultiplied coarse order用core runtime値

Threeの厳密な値は次である。

```text
bucket = base + renderOrderOffset
automatic(rank) = (rank + 1) / 1_048_576
finalRenderOrder = bucket + automatic(rank)  // alpha/premultiplied自動rank draw
finalRenderOrder = bucket                    // additive、multiply、非参加v1 decal
```

`base`、`renderOrderOffset`、`bucket`はsigned 32-bit integerでなければならない。module factory/compilerは無効な
offsetを`NACHI_RENDER_ORDER_OFFSET_INVALID`で拒否する。Three materializationとpersistent setterは無効な
baseまたはoverflowする和を`NACHI_THREE_RENDER_ORDER_COMPOSITION_INVALID`で拒否する。1 systemが所有できる
automatic transparent draw entryは最大`1_048_575`。超過するspawnは新instanceを保持する前に
`NACHI_TRANSPARENT_DRAW_ORDER_CAPACITY_EXCEEDED`で失敗する。

分母は`2^20`である。signed-32-bit bucket範囲ではrank fractionと合成和がIEEE-754 doubleで厳密表現でき、
rankは衝突しない。rankはfarからnearへ増加する。同depthはsystemごとの数値instance creation sequence昇順、
emitter element key、compiled draw path/indexの順で比較する。unreleased drawはculled/late materializedでもrankを
消費し、materialization timingがpeerを並べ替えない。別`VFXSystem`は独立rankなので、相互順が重要なら異なる
base/offset bucketを使わなければならない。

`ThreeSpriteMaterializationOptions`、`ThreeMeshMaterializationOptions`、
`ThreeDecalMaterializationOptions`はいずれも`renderOrder?:number`を公開し、この正確なfieldがregistration
`base`を供給する。sprite/mesh既定は`1000`。既存decal fieldはsource compatibleのまま既定`10`を保持する。
従ってv1 decalのfinal orderは正確に`10`または明示旧値のまま。v2 decalは整数bucketと次整数の間のfractionを
得る。外部Three objectを`bucket`に置けば同bucketの全Nachi automatic drawより先、`bucket+1`なら後にsubmit
される。その間の値で意図的interleaveもできる。

## 6. registration ownership、mutation、pool、late materialization

coreはrankとmodule offsetを所有し、Threeはhost baseと`Object3D.renderOrder`への変換を所有する。runtime
renderer protocolは全登録object向けscalarではなく`(BuiltEmitterKernels, drawIndex)`ごとのassignmentを保存
する。各Three draw registrationはbase、offset、draw index、persistent user componentを保存し、どちらかが
変わるたび§5の式を再計算する。

sprite/mesh/decal materialization結果はvisibility controlに加えて`setRenderOrderBase(base)`を公開する。
それぞれの`renderOrder` optionが初期値を供給する。`Object3D.renderOrder`への直接代入はpersistent overrideではなく、次の
runtime order update、pool activation、registration replayで置換され得る。persistent mutationにはsetterを
使わなければならない。

materialization前のassignmentはkernelsへ保持し、draw登録時に適用する。retained/prepared drawのactivationは
objectのstale fieldでなく最新assignmentを適用する。`prepareKernelsForPooling()`と完全releaseはregistrationを
dispose後、全order assignmentをclearする。従ってcheckoutしたpooled kernelには前generationのbase/rankがなく、
新generationのregistration baseと次runtime rankを受ける。これはplan 026にあった`THREE_RENDER_ORDER`残余を
閉じるため、実際のrelease→pool checkout→update前materialize回帰を必須とする。

## 7. decal spawn姿勢

v2 decalではcompiler-owned Init既定をgeneric attribute defaultの後、authored Init moduleの前へ挿入する。
compiler virtual `Emitter.spawnInterpolatedRotation`は`Emitter.spawnInterpolatedTransform`と正確に同じspawn-index
phaseとinterpolation-active branchを共有する。active historyはshortest-path quaternion slerp、inactive/stationary
historyはexact current `Emitter.rotation` nodeを返す。各successful spawnでsynthetic Initはこのvirtual
quaternion `q_spawn`をnormalizeし、次を書く。

```text
Particles.rotation = normalize(q_spawn)
```

decal projection boxとinverse projectionは同じstored quaternionを使う。後で実行されるauthored Init moduleの
`Particles.rotation` writeはabsolute world-space overrideのまま。`orientToVelocity()`等のUpdate moduleも後で
置換できる。v1 decalはgeneric identity既定を保持する。

これはbirth-pose captureで、emitter followではない。後のemitter移動は既存decalを回転させない。decal renderer
はtranslationを加算せず、`Particles.position`はworld-space centerのままである。built-in position moduleは同じ
per-particle phaseでlocal centerを変換し続けるため、translation+rotation spawnでcenterとorientationの
interpolation phaseが揃う。custom position writerはworld positionを自ら供給し、独立したorientation既定を無効に
しない。spawn phaseがないevent/all-slot Init pathはtransform virtualと同様にexact current rotationを使う。

## 8. camera診断とquality tier

activeなparticle-sorted drawは`VFXSystem.setCamera()`を必要とする。複数automatic transparent drawも意味のある
coarse depthにcameraを要する。どちらかをcamera未設定で満たす場合、systemは影響instanceごとに一度
`NACHI_ALPHA_SORT_CAMERA_UNSET`を記録し、そのupdateでは既存identity-camera fallbackを使う。v2 decalも両判定
へ含める。

effective sortは`authoredSorted && quality.features.sorted`。presetは次とする。

| Tier | sorted gate |
| --- | --- |
| low | false |
| medium | false |
| high | true |
| epic | true |

high/epicを通常correctness pathとし、low/mediumは明示budget escapeを残す。authored `sorted:false`は全tierで
false。live `setQualityTier()`はruntime capacity/spawn controlを即時更新するがcompile済みdrawを置換しない。
structural sorted gateが変われば既存instanceはcompile variantを保持し、`NACHI_QUALITY_RESTART_REQUIRED`を記録、
後続spawn/checkoutだけが新pool keyをcompile/selectする。hidden in-place recompileは保証しない。

## 9. asset-format境界とmigration

これらbuilt-inではmodule version 2だけでは安全なserialized境界にならない。H2-7前formatは任意の正module
versionを受理し、old core compilerのdirect billboard/mesh/decal pathはversion registryを解決しない。特にold
readerはmodule version 2でも`decal.config.sorted`を黙って無視しalive-index順で実行する。これはRFC 003 §4違反。

従ってH2-7は`nachi-effect` envelopeをversion 2へ上げる。新serializerはenvelope v2だけを出力する。default
migration registryへ明示的な1-step envelope-only v1→v2 migrationを入れる。top-level versionだけを変更し、inputを
mutationせず、canonical JSON上のeffect/module payloadをdeepかつbyte-for-byte保持する。module versionをupgrade
しない。新loaderはmigrate済みv1とnative v2を受理する。`EffectAssetDocumentV1`とv1 schemaは
inspection/migration向けにexportを保持し、serializer output/current schemaはv2 typeを使う。

format v1はmodule semanticsを所有せず任意の正整数module versionを許容したため、実際のemitter `render`
slot、またはemitter-extensionの`overrides.render.modules` slotにある`core/billboard`、
`core/mesh-renderer`、`core/decal-renderer`がversion 1以外ならmigration前に
`NACHI_ASSET_V1_RENDERER_VERSION_UNSUPPORTED`で拒否する。このbounded guardはformat所有のrender位置だけを
調べ、opaque module config内にネストしたrenderer-shaped objectはpayloadとして無変更で保持する。これは
payload rewriteではなく、旧generic render configをH2-7 renderer-v2 configとして再解釈しないための境界で
ある。H2-6 kernel moduleを含むその他のversioned moduleは通常のmigration pathを維持する。

envelope-v2 validationはversion-awareである。billboard/mesh/decal module-v2 configはknown fieldをstrictに検証
する。blending/sorted literal、finite signed-32-bit `renderOrderOffset`、finite 3-component `sortCenter`、既存の
module固有fieldを検証し、unknown fieldを拒否する。module-v1 configはhistorical generic acceptanceとv1 compiler
意味を保持し、strict v2 validationがold payloadを遡及的に無効化・再解釈してはならない。input非mutation、
payload保持、module-version保持、load→serialize安定、実old readerのenvelope-v2拒否をtestする。

old readerはcompile前にenvelope v2を`NACHI_ASSET_VERSION_UNSUPPORTED`で拒否し、新decal configを黙って実行
できない。新v2 helperはmodule-v2明示既定をserializeする。readerはenvelope migrationからrenderer module
upgradeを推測しない。

## 10. 必須verificationとperformance証拠

受入には次を全て要求する。

- old module-v1省略/明示semanticsと固定GPU/WGSL pin、old readerによるenvelope v2安全拒否
- alpha/premultiplied billboard、mesh、decal既定のGPU overlap/readback、explicit-falseの
  compact/recycle/spawn撹乱で非決定的物理意味が見えること
- `depthWrite:false`と旧rejectを弁別する透明mesh color/depth readback
- base+offset+rank、外部object境界、数値tie、persistent setter、late materialization、retained preparation、
  実pool reuse
- translation+rotation decalのposition/quaternion storage readbackと非対称projection結果、fixture-only identity
  rotation fault
- camera warningとlow/medium対high/epicのstructural compilation境界
- `default-unsorted`、`mesh-depth-write`、`rank-overwrite`、`decal-no-spawn-rotation`、
  `pool-stale-order`のfixture-only fault。
  production codeへtest-only fault branchを入れてはならない。

恒常GPU面は`/m10-sort/`。既存visible canvasは裁定済み挙動変更が影響しない限り保持し、新numeric assertionを
page resultへ公開する。golden/showcase差分はまずcompiled draw構造(module version、blending、indirection、
material depth-write、order component)、次にscreenshot regionで比較する。本RFC起因だけを再記録できる。

performanceは同じ`/m10-sort/` workload/adapter、warmup 4、runごとに完備したperf-v2 GPU sample 16を使う。
old/new各5 runsで全median/p95、median of medians、median of p95をplanへ記録する。materialなmedian regressionは
修正または明示裁定してから受入し、budget escape証明としてlow/medium sorted-off値も記録する。

## 11. release分類

renderer既定、mesh depth挙動、runtime renderer ordering、decal姿勢の変更は`@nachi-vfx/core`と
`@nachi-vfx/three`のsemantic major変更。current asset envelopeとserializer return type変更は
`@nachi-vfx/format`のsemantic major変更。3 packageともpre-1.0なのでRFC 003 §2により`minor` changesetを使い、
breakingであることとmigration案内を本文で明示する。v1 assetをloadできてもcore major成分をpatchへ降格しては
ならない。

## 12. non-goal

global merged cross-emitter particle sort、WBOITのexact化/depth制約除去、複数render module/emitter、独立VFX
system間の協調、direct `Object3D.renderOrder` mutationの永続化、birth後のold decal emitter followは対象外。
