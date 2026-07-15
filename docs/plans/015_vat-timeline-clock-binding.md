# 015: VAT の timeline 時計自動バインドと clone 保持

- 重大度: 高
- 対象: `@nachi-vfx/mesh-fx`(vat.ts)、`@nachi-vfx/timeline`、RFC 001(M9 責務)
- 状態: 受入済み(H2-10、2026-07-16)
- 出典: H1 後続 Codex 探査 T4#3(task-mrklb7a0-200ucr、2026-07-14)

## 症状(静的監査、確度=確実)

`applyVat()` の package-owned clock(`vat.ts:91` — `uniform(0)`)は timeline の
timeScale / hitStop / pause / mesh life と一切バインドされない(timeline が時刻を配る対象は
`'fx' in mesh.material` の fxMaterial のみ=`runtime.ts:318/678`)。`meshFxElement()` へ
VAT 適用 mesh を渡すと、通常 NodeMaterial では VAT が時刻 0 で静止し得る。さらに timeline
`fxMaterial()` への VAT 後付けは、clone が `cloneTimelineFxMaterial()` で config 再生成するため
VAT の `positionNode` 変更ごと失われる。plan 005(時計共有)と同型の VAT 版であり、
RFC 001 は M9 の automatic element-lifecycle binding 責務を予定している。

## 裁定(2026-07-14)

**自動バインド+clone 対応を採用**。meshFxElement が VAT controls を検出して
localTime / timeScale / hitStop を自動同期し、clone で VAT 適用を保持する。

## 受け入れ基準

1. VAT 適用 mesh 要素が timeline の timeScale 変更・hitStop・pause へ追従する
   (GPU 実測: hitStop 中の頂点静止を m8-vat 系または m9 系リグで固定)。
2. timeline fxMaterial+VAT 併用の clone で VAT positionNode / uniform が保持され、
   clone 間で時刻が独立する。
3. 明示 `config.time`(外部ノード)指定時は自動バインドしない(現行契約の保存)。
4. 非 timeline 利用(単体 VAT)の既存挙動・m8-vat 両バックエンド回帰が不変。
5. RFC 001 の M9 責務節へバインド規約を明記。plan 014 の clone スナップショット化と整合させる。

## 互換性 / リスク

- timeline に載せた VAT の進行が変わる(意図に合う方向だが、自前で時刻駆動していたページには
  変化。mesh-fx / timeline minor)。plan 014 と同一バッチでの実装が安全。

## 修正前プローブ(2026-07-16)

修正前HEADに、同じfloat VATをpackage-owned clockで適用した2種類のmeshを置くfocused probeを追加し、
実装前に1 file / 1 test成功として次の故障を弁別した。

- timeline `fxMaterial()` + VAT: sourceの`positionNode`はVAT graphだったが、spawn cloneは`null`。
  H2-9のconfig再生成がsource node graphをcopyしないため、後付けVAT branch全体を失っていた。
- 通常`MeshBasicNodeMaterial` + VAT: cloneの`positionNode === source.positionNode`。Three r185のgeneric
  NodeMaterial cloneがVAT graphとそのpackage-owned uniformをaliasしていた。
- 両source controlを`0.25`へ設定後、timelineを`0.5 s`更新しても値はともに`0.25`のままだった。
  runtimeが駆動していたのは`'fx' in material`の`fx.time`だけであり、VAT controlsは検出されなかった。

このprobeは修正後、source/A/Bのgraph・uniform非共有、play resetとelapsed駆動を期待する恒久回帰へ
反転した。静的監査の「消失」「alias」「時刻固定」を同じfixtureで別々に否定できる。

## 実装結果

- `applyVat()`はmesh-fx内部のWeakMapへ、immutableなconfig snapshot、最初のVAT直前のposition/normal
  base node、順序付き各layer controls、適用後graph identityを保持する。連続する複数`applyVat()`は現在の
  position加算/absolute置換/normal last-writeの順序を保ってすべて再適用する。適用間に作者がposition rootを
  差し替えた場合はそのgraphから新chainを開始し、normal rootだけの差し替えではnormal所有権だけを外して
  累積position layer/controlを維持する。最終graphの到達controlは「最後のabsolute position以降」と「最新normal
  layer」のordered unique unionで選別し、どちらからも切断されたmetadataは各apply後にcompactする。
- timelineはmaterial clone後にinternal `cloneVatBindings()`を呼ぶ。`fxMaterial()`ではH2-9どおりconfigから
  package graph/controlを再生成したbaseへ、通常NodeMaterialではVAT前baseへ戻し、到達unionだけを再適用する。
  明示的なVAT前node、texture、external TSL time nodeは共有し、owned VAT uniformだけはsource/A/Bで独立。
  source owned timeの現在値はspawn/prepare cloneへsnapshotし、play時に0へresetする。
- mesh runtimeは順序付きVAT controlsを保持し、owned controlsだけへlatest playからの`runtime.elapsed`を
  書く。これはtrack-wide `localTime`/`fx.time`ではない。scaled `localDelta`だけで進むためtimeScale、
  timeline speed、scale 0 pause、hit stopへ追従し、stop/自然終了/complete後は最終値を保持、loop replayと
  fresh instanceは0へ戻る。`fx.time`と`fx.normalizedLife`の既存書込は変更していない。
- external number/TSL `VatConfig.time`はcontrols.time=nullのまま同じbindingをcloneへ再適用し、自動書込も
  診断もしない。standalone `setTime()`のnon-loop range診断は不変。timeline専用internal writerだけが
  finite/nonnegativeを検証しつつclip終端後のelapsedを許し、shader clampで最終frameを保持する。
- clone途中の失敗は、そのclone materialだけをdisposeする。通常release、prepare non-retained/error/abort、
  retained transfer、borrowed geometry/source materialのH2-9境界を維持し、VAT textureは一切disposeしない。
- package rootのESM/d.tsへ追加するcross-package seamは`@internal cloneVatBindings()`と
  `@internal setVatTimelineTime()`の2関数だけで、新規公開typeはない。test用control lookupはpackage rootから
  exportしない。利用者向けの新規必須APIはなく、timelineへ載せたowned VATが自動進行する挙動変更を
  mesh-fx/timeline minor changesetに記録した。

## 初回独立レビュー所見のclose(2026-07-16)

- 初回所見はBLOCKER 0 / SHOULD 1 / NIT 0。SHOULDは最終`applyVat()`後に作者がsourceの
  `material.positionNode`または`normalNode`を差し替えても、material identityだけでWeakMap metadataを採用し、
  clone時に切り離された旧VAT graph/controlを復活させ得る点だった。
- material identityと記録済みposition/normal root identityを同時に見る共通activity predicateを追加し、
  `cloneVatBindings()`と内部control lookupの双方で使用した。最終position/normalはchannel別に失効し、現在の
  作者graphをexternal/shared bindingとして保持する。生存する他channelだけを再構築・駆動し、両channelまたは
  materialの差し替え後はstale controlを返さない。position-only VAT後の最終position差し替えについても、旧VAT
  texture/controlがcloneへ復活しないことを直接固定した。
- fxMaterial/通常NodeMaterialの両方で、最終position、position-only最終position、最終normal、両root、material、
  normal差し替え後の再適用、position差し替え後の再適用を回帰化した。追加後のfocusedは3 files / 96 tests成功。
  初回SHOULDは実装と回帰証跡によりcloseし、独立再レビュー待ちとする。

## 第二独立レビュー所見のclose(2026-07-16)

- fresh再レビュー所見はBLOCKER 0 / SHOULD 1 / NIT 0。初回stale metadata所見はCLOSED確認済み。新SHOULDは
  `activeVatControls()`がposition channelをactiveと判定すると全binding controlを返し、後続absolute positionや
  normal last-writeで最終graphから切断された旧clockまでtimelineが更新する点だった。
- positionは最後の`positionMode: 'absolute'` layer以降、normalはactiveな最新`normalBindingIndex`を独立に選び、
  両者のindexを元のlayer順で重複排除する共通reachability selectorへ置換した。`getVatControls()`はこのselectorを
  直接使用し、`cloneVatBindings()`は同じunionだけを再適用してclone側lookup結果を返す。timelineが受け取るのは
  reachable unionだけで、そのうちownedなcontrolだけを駆動する。external controlはgraph bindingを保つが
  書き込まない。
- source WeakMapはmesh寿命に追従するためglobalな無制限leakではなく、返却済みcontrolとtextureもcaller所有で
  dispose対象ではない。一方、切断bindingを各spawnで再構築するとclone寿命中のnode/uniform保持を比例増幅する
  ためSHOULD相当と評価し、各apply後のmetadataもreachable unionへcompact、cloneも同unionだけを再構築する。
  視覚graphはabsolute/offset/normal last-writeの従来意味と一致し、borrowed resource ownershipは変えない。
- fxMaterial/通常NodeMaterialの双方で、A(offset+normal)→B(absolute+normal)=Bのみ、A(offset+normal)→
  B(absolute、normalなし)=A(normal)+B(position)、A(offset)→B(absolute)→C(offset)=B/C、external/owned混在と
  post-final片channel差し替えの交差を追加した。source/clone A/clone Bのuniform独立、切断source clock不変、
  texture graph非包含、normal last-write、実WGSL textureLoadも固定し、focusedは3 files / 104 tests成功した。
  第二SHOULDは実装と回帰証跡によりcloseし、再度の独立レビュー待ちとする。

## テスト・GPU証跡(2026-07-16)

- focused: mesh-fx、timeline既存、新規VAT timelineの3 files / 104 tests成功。新規33 testsはfx/non-fx、
  position+normal、source/A/B graph/uniform identity、texture/external node共有、current time snapshot、play
  reset、clone独立、timeScale 2/0/0.5、hit stop、resume、stop、自然終了、loop replay、fresh instance、
  numeric/TSL external time、`fx.time`/normalizedLifeとのclock domain分離、複数apply順序、mutable config
  snapshot、pre-VAT base node、prepare non-retained/retained ownership、clone error cleanup、短いnon-loop
  clip、NaN/negative拒否、実Three WGSLのVAT textureLoad branchを含む。
- package typecheck: mesh-fx / timeline / playground成功。
- `/m9-timeline/?headless=1` direct WebGPU normalは18 checksすべてtrue。VAT probeは
  `snapshotIndependent/lifecycleDriven/cloneIndependent/loopReset/externalPreserved=true`。実頂点readbackの
  centroid xはstart=`13.8455`、通常進行=`35.5`、pause=`35.5`、hit stop=`35.5`、resume=`59.5`、
  loop reset=`13.8455`。owned A/B clockは`0.375/0.0625`、externalはtimeline非書込後に作者が`0.25`へ
  更新した時だけpixelが`13.8455→35.5`へ動いた。warmed 4+16 GPU samplesもcompleteで、最終directの
  compute median/p95=`0.185/0.284 ms`、render=`0.195/0.423 ms`、total=`0.371/0.647 ms`。
- isolated `?forceFailure=timeline-vat-clock`はrunner失敗となり、18 checks中
  `vatTimelineClockGpu=false`だけがfalse。計測された詳細evidenceと他17 checksは正常のまま。
- full: 33 files / 827 tests成功。全workspace `typecheck`、`lint`、`format:check`、`build`、全package
  ESM gate、`changeset status`、`git diff --check`成功。mesh-fx/timeline minor changesetを検出した。
- standalone `/m8-vat/`はWebGPU/WebGL2とも全9 validation成功。frame0/linear/nearest/range-wrapの最大
  position errorは両backendで`0.33249/0.35145/0.13972/0.16601 px`、VAT displacement=`130 px`、
  normal energy ratio=`41.1667`。WebGPU warmed 4+16 render sample完了、WebGL2のtimestamp-query非対応は
  adapter-capabilityとして構造化され、performance validation成功。既存m8 baseline差分は0。
- final full GPU suiteはplayground 13 + showcase 6 = 19/19成功、総計`72.719 s`。M9 timelineの追加VAT probeを
  含め、showcase 6のconsole/perf/activity/readback契約もすべて成功した。Golden runnerは7/7成功。
  tracked baselineは23 PNGのままでdiffなし。M9はheadless readbackのみでbaseline追加・意図した見た目変更なし。
- Vite、runner、browser processと5173/5174 listenerは停止済み。新規tmp/bakなし。runnerのignored artifact
  出力以外に作業生成物はなく、tracked baseline 23枚は不変。

## 最終独立レビュー・受入(2026-07-16)

- 3人目のfresh読み取り専用最終レビュー: **ACCEPT**。BLOCKER / SHOULD / NIT = `0 / 0 / 0`。
- reviewerは初回のstale graph復活と第二の到達不能clock駆動をいずれもCLOSEDとし、channel別identity、
  reachable ordered union、metadata compact、fx/generic clone、複数layer/新chain、clock/ownership/docsを
  独立再監査した。actionable findingは残らなかった。
- 独立再実行: focused 3 files / 104 tests、full 33 files / 827 tests、全workspace typecheck、lint、format、
  build、全package ESM、changeset status、diff checkがPASS。M9 normalは18/18、VAT faultと既存state faultは
  それぞれ対象1件だけfalse。M8 WebGPU/WebGL2は各9/9、full GPUは19/19 (`72.193 s`)、goldenは7/7。
  baseline 23枚はdiffなしで、console/page error・process/listener・tmp/bak残留もない。
- 修正前の比較可能な性能値はないが改善率を主張せず、非VAT経路はbounded lookup/空union、warmed samplesと
  全GPU suiteが完走しているため受入阻害ではないと裁定した。

以上によりH2-10を受入済みとする。
