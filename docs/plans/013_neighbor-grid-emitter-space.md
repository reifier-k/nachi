# 013: NeighborGrid の emitter 空間追従と範囲外診断

- 重大度: 高(移動エフェクトで近傍系が無音全滅)
- 対象: `@nachi-vfx/core`(defineNeighborGrid / 近傍走査カーネル)、RFC 001 §10.7 / 004
- 状態: 受入済み(H2-5、2026-07-15、fresh独立再レビューACCEPT、BLOCKER/SHOULD/NIT=0)
- 出典: H1 後続 Codex 探査 T5 F-01(task-mrklav03-g4d8is、2026-07-14)

## 症状(静的監査、確度=確実)

NeighborGrid の原点が絶対 world 固定(`api.ts:105` — `origin: config.origin ?? [0,0,0]`、
`compiler.ts:3454` が `Particles.position` から直接セル座標化し `Emitter.transform` を読まない)。
エフェクトを原点以外へ spawn / attach / `setTransform()` すると全粒子が grid 範囲外になり、
挿入が全件失敗=boids/PBD が無音で無効化する。範囲外件数はカウンタ(`outOfBounds`)にあるが
診断は cell overflow にしか生成されない。H1-4 の `offset` 一元合成
(instanceTransform×translate(offset))から NeighborGrid だけが漏れている。

## 裁定(2026-07-14)

**emitter 追従化+診断を採用**。原点を instanceTransform×offset 合成へ追従させ
(H1-4 / RFC 004 の自動整合へ合流)、全滅級の範囲外発生に診断を追加。原点 spawn の
既存挙動は不変=実質非破壊。

## 受け入れ基準

1. 同一定義を原点と非原点(平行移動+回転)で spawn し、近傍集合が CPU レプリカと両方一致
   (m12-neighbors の既存 CPU レプリカ検証を非原点ケースへ拡張)。
2. `EmitterConfig.offset` 使用時も同様に一致。
3. 原点 spawn の既存全検証がビット等価または数値等価で不変。
4. 範囲外挿入が支配的(例: >50%)のフレームで新設診断が 1 回発火し、既定 console に乗る
   (readback 系カウンタの合否集約も m12-neighbors へ追加)。
5. RFC §10.7 へ空間規約を明記。format の grid 構造は封筒不変(origin は emitter ローカル解釈へ、
   互換の扱いは RFC 004 の v1 互換方式に倣う)。

## 互換性 / リスク

- origin 指定済み+非原点 spawn を意図的に併用しているユーザーには挙動変化
  (core minor、changeset 明記)。
- 回転を含む合成でセル軸が emitter ローカルへ回る。radius(セル単位)・cellSize の意味が
  変わらないことをレビューで確認する。

## 変更前HEADの実GPU再現(2026-07-15)

HEAD `1762675` の `/m12-neighbors/` を一時worktree、SwiftShader WebGPU、同一seed、32粒子、
`origin=[-2,-2,-2]`、`cellSize=1`、`resolution=4^3`、`cellCapacity=32` で実測した。

- identity: in-bounds count 32、`outOfBounds=0`、logical slot集合 `0..31`
- spawn `position=[8,5,0]` + Z 90°: in-bounds count 0、`outOfBounds=32`、logical slot集合 空
- `EmitterConfig.offset=[8,5,0]` + Z 90°: in-bounds count 0、`outOfBounds=32`、logical slot集合 空

変更前WGSLの原因は、bucketとcurrent-cell lookupがどちらもTSL graph上で
`floor((Particles.position - literal origin) / cellSize)` を生成し、`Emitter.transform` uniform / inverseを
読まないことだった。position/velocity snapshot自体はworld-spaceで正しかった。

## 実装

### emitter-local cell座標

- `neighborGridCellCoordinates()` へbucket、boids、custom `forEachNeighbor()`、PBDの全cell lookupを集約。
- world-space `Particles.position` だけを `inverse(Emitter.transform)` へ通し、その後emitter-local `origin` と
  `cellSize` でhash化。position/velocity snapshotとboids/PBDの差分・距離数学はworld-spaceのまま。
- `Emitter.transform = instance transform * translate(EmitterConfig.offset)` の既存一元合成を再利用するため、
  translation、rotation、offset、attach、`setTransform()` uniform更新へ自動追従する。scaleは現行transformに
  存在せず、`cellSize`/radius/distanceはworld長のまま。
- m12のlive fixtureは初回spawnより前に `setTransform()` する。既存粒子はworld-spaceに残るため、spawn後の
  transform変更が既存粒子を移動させるとは規定しない。
- boids/PBD/custom access manifestへ `Emitter.transform` を追加。変更前v1 JSONの旧manifestはcompile時だけ
  防御補完し、load済みdefinitionと再serialize JSONは変更しない。

### dominant out-of-bounds診断

- capture時に `inBounds=sum(counts)`、`total=inBounds+outOfBounds` を算出し、`total>0` かつ
  `outOfBounds/total>0.5` で `NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT` warningを生成。
- `context` はin/out/total/ratio、grid key/definition、`emitterPath`、kernel kindを保持し、正規authoring pathは
  `elements.<gridKey>.origin`。cell overflow診断と同一snapshotで共存する。
- snapshotは各capture時点の条件を返す一方、instance蓄積と配送はNeighborGrid runtime lifetimeにつき1回。
  複数capture・後続dominant rebuildは再配送せず、pool checkout/new runtimeで再armする。厳密50%と0件は無発火。

### runtime配送seamとplan 017境界

criterion 4を完結する最小の将来互換seamとして
`VfxSystemOptions.onRuntimeDiagnostic?: ((diagnostic) => void) | null` を導入した。省略時はbuildと同じ1行
console formatter、`null` opt-out、関数は置換。handler throwはcapture/updateをrejectせず、instanceへ
`NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED` をonce蓄積し再帰配送しない。H2-5で接続するsourceは新OOB診断だけ。
既存markError/device loss/light/overflow等の横断配線と全ページ棚卸しはplan 017/H2-12に残した。
`onBuildDiagnostic` のruntime誤用とdirect `console.warn` は行っていない。

## 恒常回帰と互換性

- m12 WebGPU: identity、translation+rotation、offset、初回spawn前live `setTransform()` のcounts、logical cell set、
  bucket snapshot由来logical neighbor setをCPU replicaと照合し全一致。さらにcustom neighbor moduleが
  `forEachNeighbor()` で実際に訪問したphysical slotをu32 bitmaskへ書き、captureしたmaskをrun固有の
  logical→physical対応から作るCPU期待maskと直接照合する。atomic physical slot順そのものは恒常期待値にしない。
- identityの恒常合否は2 runのposition bit一致とlogical集合で判定。受入時だけ同一SwiftShader条件で変更前/後の
  counts + raw physical slots + logical順physicalSlot + position float bitsをFNV-1a化し、両方 `c518acb2` と一致。
- m12診断: 8 attempt中in 2 / OOB 6 (75%)、`dropped=1` のoverflow共存、snapshot再現、runtime lifetime once、
  既定console warning exactly 1 / unexpected 0、exact 50%、0件、`null`、throw封じ込め、pool再armを実GPU確認。
- 一時fixtureは `maxPoolSize:0` +明示release。再arm専用fixtureだけpoolを維持し、checkout後の新runtimeを確認。
  perf専用instanceとWebGL early-return instanceを含む全主要instanceもrenderer dispose前にreleaseする。
- format: `nachi-effect` version 1 envelope/closed fieldsは不変。手書き旧v1 boids/PBD access JSONを
  load→compile(ACCESS_MISMATCHなし)→serializeしbyte-structure恒等。origin field値も無変換round-trip。
- changeset: `@nachi-vfx/core` minor。formatはschema/serialization実装変更なしのためbumpなし。

## 性能(同一SwiftShader、fresh browser 5+5)

`/m12-neighbors/` の実count-grid workloadを、各run warmup 4 + complete compute/total scope 16 samplesで比較。
top-level compute/total msの個票は旧 `0.512, 0.514, 0.770, 0.427, 0.700`、新
`0.528, 0.477, 0.701, 0.515, 0.742`。中央値(range)は旧 `0.514 (0.427–0.770)`、新
`0.528 (0.477–0.742)`、+2.7%でrange重複。sample-window medianのrun個票は旧
`0.522, 0.496, 0.491, 0.472, 0.564`、新 `0.516, 0.482, 0.522, 0.532, 0.557`、全run 16/16かつ
warmup 4/4。中央値は `0.496→0.522ms`、range重複でSwiftShaderノイズ内、回帰判定なし。

## 統括検収

- build / workspace typecheck / lint / format / ESM: PASS
- tests: 32 files / 733 tests PASS。focused core/compiler/system/neighbor-grid + format assetもPASS
- golden: 7/7 PASS
- GPU: playground 8 + showcase 6 = 14/14 PASS。m12 WebGPU/WebGL2個別もPASS
- m12 PNG: 196,608 pixels中変更0、baseline更新なし
- baseline: 23枚、canonical manifest
  `a90da406a61016f8a751b4cc359b1e7d6c210ba2a6ccb4e7db9271b2a51d8c19`、baseline treeの
  `*-actual`/tmp/bak 0
- `pnpm changeset status`: core minorを認識

## 初回独立レビューと修正(2026-07-15)

初回fresh独立レビューは **REJECT (BLOCKER 1 / SHOULD 0 / NIT 0)**。実装本体の空間変換、診断、API、
互換性、文書には指摘がなく、回帰fixtureの弁別性だけが不足していた。

- B1: 旧 `neighborSetsMatch` はGPU bucket snapshotをCPUで再列挙しており、custom/boids/PBDの
  current-cell visitorが実際に返した集合を観測していなかった。boids係数も全て0なので、current-cell lookupだけを
  変更前world式へ戻しても合格できた。
- 修正: `neighborMask: u32` custom属性とcustom neighbor moduleを追加し、`forEachNeighbor()` の各訪問先を
  `1u << physicalSlot` としてGPU上でORする。captureしたmaskを、同じrunのsnapshotから得た
  logical→physical対応とCPU replicaのlogical neighbor集合から導く期待maskへ直接照合する
  `visitorMasksMatch` を4ケース全てへ追加した。既存bucket snapshot検証は
  `bucketNeighborSetsMatch` と改名し、異なる観測対象であることを明示した。
- 故障注入: bucket insertはemitter-localのまま、`forEachNeighbor()` のcurrent-cell計算だけを変更前world式へ
  一時差し戻した。identityは `visitorMasksMatch=true`、translation+rotation / offset / 初回spawn前live
  `setTransform()` は全て `visitorMasksMatch=false` となり、同時にcounts / cell sets /
  `bucketNeighborSetsMatch` / world positionsはtrueのままだった。従って指摘された単独退行を新チェックだけが
  直接検出する。故障パッチは即時復元し、復元後4ケース全てtrueを再確認した。

B1は実装・弁別性確認ともに **CLOSED**。fresh独立再レビューのACCEPTまではROADMAP checkboxを更新しない。

### B1修正後の再検証

- build / workspace typecheck / lint / format / ESM: PASS
- tests: 32 files / 733 tests PASS。focused compiler / neighbor-grid / system / format assetは
  4 files / 409 tests PASS
- golden: 7/7 PASS。GPU: playground 8 + showcase 6 = 14/14 PASS
- m12 WebGPU: 4ケース全てで`visitorMasksMatch=true`、identity hash `c518acb2`、期待OOB warning exactly 1、
  unexpected console 0、PNGは196,608 pixels中変更0。WebGL2明示拒否もPASS
- 性能fixtureはB1修正のcustom visitor fixtureと別の既存count-grid workloadなので変更なし。同一SwiftShaderで
  spot runを再取得し、top-level compute/total `0.481ms`、warmup 4/4 + sample 16/16 median `0.552ms`
  (p95 `0.714ms`)。いずれも上記5-runの修正後range内で追加回帰なし
- baseline 23枚、canonical manifest
  `a90da406a61016f8a751b4cc359b1e7d6c210ba2a6ccb4e7db9271b2a51d8c19`、baseline treeの
  `*-actual`/tmp/bak 0、`git diff --check` PASS

## fresh独立再レビュー(2026-07-15)

**ACCEPT (BLOCKER 0 / SHOULD 0 / NIT 0)、初回B1 CLOSED**。実装担当と別のreviewerが
`neighborMask: u32`のphysical slot 31、self除外、capacity 32、run固有logical→physical変換、
順序非依存性をコードと実GPUで再検証した。current-cell lookupだけを旧world式へ戻す
独立故障注入でも、identityのvisitor maskはtrueのまま、translation+rotation / offset /
初回spawn前 `setTransform()` の3ケースだけがfalseとなり、counts、cell set、bucket snapshot、
OOB、world positionはtrueを維持した。復元後は4ケース全てtrueで、初回B1の単独退行を
新チェックだけが弁別することを確定した。

独立再検証はfocused 409/409、full 733/733、build/typecheck/lint/format/ESM/diff-check、
golden 7/7、GPU 14/14、m12 WebGPU/WebGL2を全てPASS。identity hash `c518acb2`、期待OOB warning
exactly 1 / unexpected 0、PNG変更0/196,608 pixel、baseline 23枚とcanonical manifest
`a90da406a61016f8a751b4cc359b1e7d6c210ba2a6ccb4e7db9271b2a51d8c19`を再現した。現実装の
独立5-runはtop-level `0.534–0.738ms`、16-sample median `0.536–0.552ms`で、全run warmup 4/4、
samples 16/16。追加findingはなく、server/tempはcleanup済み。

## 受入チェック

- [x] 変更前実GPUでtranslation+rotation/offsetの全OOBを再現し、WGSL因果を確定
- [x] 全lookupをemitter-local cell helperへ集約しworld snapshot/distanceを維持
- [x] CPU/GPU logical集合、GPU visitor直接mask、identity旧新hash、diagnostic境界、pool/handlerを回帰化
- [x] 初回レビューB1を故障注入で再現し、visitor直接maskがcurrent-cell単独退行を検出することを確認
- [x] types/API、RFC 001 EN/JA、RFC 004 EN/JA、format v1互換、changesetを同期
- [x] full/golden/GPU/baseline/perf/cleanupの統括検収を完了
- [x] fresh独立再レビューでACCEPTし、ROADMAP checkboxを更新
