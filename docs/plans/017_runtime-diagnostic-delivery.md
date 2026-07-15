# 017: runtime 診断の既定 console 昇格(H1-3 の runtime 拡張)

- 重大度: 高(#12)/中(#13、#14)
- 対象: `@nachi-vfx/core`、`@nachi-vfx/three`(light pool)、`@nachi-vfx/timeline`、RFC 001
- 状態: 受入済み(H2-12、2026-07-16)
- 出典: H1 後続 Codex 探査 T1#12/#13/#14(task-mrkl9puw-hbbgor、2026-07-14)

## 症状(静的監査、確度=確実)

1. **#12**: GPU submission 失敗・device loss・attachment 例外・timeline action/callback 失敗は
   `markError()` で instance state に積まれるだけ(`system.ts:3648/3700`、`timeline/runtime.ts:1167`)。
   H1-3 の既定 console 昇格は build 診断限定で、作者が `state` / `diagnostics` を poll しない限り
   エフェクトは無音停止する。react の `update().catch()` にも instance 内で吸収されたエラーは
   到達しない。(RFC 上 onBuildDiagnostic が runtime を扱わないこと自体は明記済み=規範の拡張が必要)
2. **#13**: `NACHI_LIGHT_LIMIT_EXCEEDED` は `ThreeLightPoolOptions.onDiagnostic` 任意指定のみで、
   `createThreeEffectPreparer()` の既定経路から配送されない(`three/index.ts:2067`)。
3. **#14**: 実 free-list 不足・event queue overflow の診断は readback opt-in 時のみ
   (`system.ts:1726` 以降。RFC 明記済みの意図的性能設計)。

## 裁定(2026-07-14)

**console 昇格を runtime へ拡張**。H1-3 と同じ方式(既定 console 1 行、ハンドラ設定可、
null opt-out、ハンドラ例外封じ込め)を runtime 診断へ延長。light 上限は preparer から自動接続。
容量飽和は readback 有効時のみ(既存性能設計は変えない)。

## 修正前プローブと H2-5 先行seam(2026-07-15〜16)

plan 013のdominant NeighborGrid out-of-boundsを既定consoleへ配送するため、H2-5で
`VfxSystemOptions.onRuntimeDiagnostic?: ((diagnostic) => void) | null` と共通1行formatter、`null` opt-out、
handler例外封じ込め(`NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED`)だけを先行導入した。接続済みsourceは
`NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT` のみだった。

H2-12着手前のfocused 9 testsはすべてPASSしたが、GPU submission、attachment、device loss、timeline
action/attachment失敗では `update()` がresolveし、instanceのerror/diagnosticsだけが更新され、既定consoleと
`onRuntimeDiagnostic` は0件だった。明示handlerなしのlight上限も0件だった。spawn/event overflowは
`aliveCountReadbackInterval` 有効時だけinstanceへ記録され、省略時のreadback countは0で診断もなかった。
この修正前probeにより「既存のerror封じ込め」「runtime配送の欠落」「readback境界」を別々に固定した。

静的棚卸しのscopeは全page生成siteを持つ `apps/playground/src` と `apps/showcase/src` の非generated
TS/TSXに限定した。rootをこの2箇所に固定するため、packages内部、tests、dist、node_modulesは対象外である。
特にtimeline package内部のcore構築はpage生成siteではないため数えない。最終worktreeの再現コマンドは次のとおり
(systemはregex、preparerはfixed string、`-o` は式数、`-l` はfile数を数える)。

```sh
scope=(apps/playground/src apps/showcase/src)
globs=(-g '*.ts' -g '*.tsx' -g '!**/generated/**' -g '!**/*.generated.ts' -g '!**/*.generated.tsx')
rg -o "${globs[@]}" 'new [A-Za-z0-9_]*VFXSystem' "${scope[@]}" | wc -l # 162
rg -l "${globs[@]}" 'new [A-Za-z0-9_]*VFXSystem' "${scope[@]}" | wc -l # 30
rg -o "${globs[@]}" 'new CoreVFXSystem' "${scope[@]}" | wc -l # 2
rg -F -o "${globs[@]}" 'createThreeEffectPreparer(' "${scope[@]}" | wc -l # 9
rg -F -l "${globs[@]}" 'createThreeEffectPreparer(' "${scope[@]}" | wc -l # 8
base_paths=('apps/playground/src/*.ts' 'apps/playground/src/*.tsx' 'apps/showcase/src/*.ts' 'apps/showcase/src/*.tsx' ':(exclude)**/generated/**' ':(exclude)**/*.generated.ts' ':(exclude)**/*.generated.tsx')
git grep -E -o 'new [A-Za-z0-9_]*VFXSystem' HEAD -- "${base_paths[@]}" | wc -l # 161
git grep -F -o 'createThreeEffectPreparer(' HEAD -- "${base_paths[@]}" | wc -l # 8
```

修正前base HEADはsystem 161式 + preparer 8式 = 169式、最終worktreeはsystem 162式 / 30ファイル
(`CoreVFXSystem` alias 2式を含む) + preparer 9式 / 8ファイル = 171式である。preparer 9式の内訳は
showcase 7式、playground既存m10-sort 1式、本planで追加したm10-lit 1式で、修正前との差分はm10-litの
system/preparer各1式である。

## 受け入れ基準

1. [x] markError 経路の全診断コードが既定 console に 1 行で乗る(意図的発火ページは opt-out)。
   ハンドラ throw は H1-3 同様に封じ込め。
2. [x] light 上限診断が preparer 既定経路で配送される(m10-lit 系で実測)。
3. [x] readback 有効時の overflow 診断が既定 console へ乗る。readback 無効時は現状維持(RFC 再明記)。
4. [x] react binding が error 遷移を握り潰さない(M12 バッチ 5 の error 状態ゲート規約と整合)。
5. [x] RFC 001 の診断配送契約(build / runtime の二層)を改訂。全 playground/showcase ページの
   opt-out 棚卸し(H1-3 の 108 サイト走査方式)を再実行。

## 互換性 / リスク

- 既定で console 出力が増える(挙動変化はログのみ、core/three/timeline minor + react patch)。
- plan 024 の console 合否集約と相互作用するため、H2-1(検証基盤)完了後に実装する。

## 実装裁定

- coreはinstanceの `markError` / `recordDiagnostic` / once / release-time warningをruntime配送へ接続し、
  build専用record経路を分離した。省略はseverity別の共通1行console formatter、関数は置換、`null` は配送だけを
  無効化する。handler throwは呼出元へ伝播させず、owner instanceには
  `NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED` を1回だけ記録・既定formatterへfallbackし、後続sourceではhandlerを
  再試行する。ownerless system sourceには保存先instanceがないため、synthetic failureは記録せずsystemごとに最大1回の
  console fallbackだけを行う。両者のonce状態は独立し、fallbackを失敗handlerへ再帰配送しない。
- post-spawn GPU submission、attachment、prepare/cleanup、camera/scalability/quality/capacity、NeighborGrid、readbackで
  観測したspawn/event overflowをruntime経路へ接続した。spawn-time compile、kernel build、materializationは
  `onBuildDiagnostic`だけが所有する。歴史的な名前とruntime phaseを持つ
  `NACHI_RUNTIME_MATERIALIZATION_FAILED` もspawn構築中のbuild配送であり、runtimeへ重複配送しない。release後に確定する
  pool warningは元instanceへ記録・runtime配送する。
- device lossはsource occurrenceを1回だけ配送し、全live instanceへ同じ診断を記録する。live instanceが0なら
  latchだけを行い、最初のlate spawnが1回配送し、後続spawnは記録だけを行う。同じcodeでも独立source occurrenceは
  独立である。共有sourceは全affectedへprimary/stateを先に保存してから代表ownerへ配送するため、同期handlerも
  完成済みstateを観測する。その後reported latchをcallback前に確定するため、live ownerまたは最初のlate spawnの
  handlerが同期spawnしてもinner instanceはlatched primary/stateを保存するだけで再配送しない。handler throw時の
  順序はprimary→`NACHI_RUNTIME_DIAGNOSTIC_HANDLER_FAILED`になる。
- timelineは自身のvalidation、action/callback、attachment/update、boundary、companion、cleanup、mesh prepareを
  同じoptionで配送する。内部core childが配送済みの診断をtimelineへcopyする場合は再配送しない。boundaryの共有
  warningもactive instanceすべてへ先に記録し、代表ownerから1回だけ配送する。
- Three preparerはlight上限を完全なruntime `VfxDiagnostic`へ変換し、prepared temporary ownerから
  `takePreparedDraw()` 後のlive emitterへcallbackをrebindする。明示 `light.onDiagnostic` はsystem経路より優先し、
  同一light poolの反復updateではonceを維持する。
- exact overflowのためのreadbackは追加しない。`aliveCountReadbackInterval` 省略時は従来のmaximum-lifetime推定と
  performance特性を維持する。Reactはprovider updateをrejectへ変換せず、同一mutable instanceの
  `state/diagnostics` でerrorを観測でき、error後のprop転送を既存gateで止める。

## ページ棚卸しとGPU証拠

- 新規 `null` は意図的runtime warningを検証するfixtureへ限定した。M2のfree-list capacity 2系統、M3のevent
  overflow、M9 composeのpool cap、M10 sortのcamera未設定/quality restartを明示opt-outした。M12-neighborsの
  emitter-space/exact-half/empty/pool probeにある既存4件の `null` とthrowing-handler probeは維持した。
  それ以外の不足cameraはfixtureへ実camera stateを設定し、renderer teardown前にinstanceをreleaseした。
- M10-litは実 `VFXSystem` + `createThreeEffectPreparer()` + bounded light drawをprepare/transfer/updateし、candidate
  4 / max 2 / selected 2、live ownerのcode列が `NACHI_LIGHT_LIMIT_EXCEEDED` 1件、temporary owner 0件を固定した。
  `forceFailure=runtime-light-diagnostic` は実測証拠を維持して `preparedLightDiagnostic` だけfalse、runner exit 1にする。
- runtime配送で顕在化した7ページを局所修正後、個別runnerはM2 runtime、M3 sprites、M9 compose/timeline、
  M10 sort、M12 neighbors/spaceの7/7 PASS。canonical GPUはplayground 13 + showcase 6 = 19/19 PASS、
  `failed=[]`、fresh再review総計 `71.701 s`。M10-litとM12-neighborsの期待診断以外にconsole/page errorはなく、全performance
  sampleと既存screenshot comparisonがPASSした。

## 恒常回帰と文書

- focused unitはcore/three/timeline/reactの4 files / 350 tests PASS。default/custom/null、handler retry/fallback、
  GPU/attachment/device lossの全broadcast分岐、prepare/cleanup/release warning、readback有無のspawn/event overflow、
  timeline own/child-copy/boundary、prepared light owner rebind/explicit priority、React mutable error観測を固定した。
  device/boundary共有sourceの全owner primary先行保存、throw時primary→FAILED順、instance ownerとownerless systemの
  fallback once状態分離、device lossのlive/zero-live両reentrant spawnも直接固定した。
- full unitは33 files / 876 tests PASS。全workspace typecheck、lint、format、build、package/global ESM、changeset
  status、`git diff --check` はPASS。golden初回は新規配送が不足camera/renderer teardown前device destroyを可視化したため、
  camera state設定とrenderer dispose前releaseへ修正し、最終7/7 PASS。tracked baselineに差分はない。
- RFC 001 EN/JA、core/three/timeline/react README、tools READMEを更新した。core/three/timeline minor、react patchの
  単一changesetを追加する。

## 独立review修正と最終受入(2026-07-16)

- 初回fresh reviewは **REJECT (Blocker 0 / Should 1 / Nit 1)**。device-loss callback中の同期reentrant
  spawnが同じoccurrenceを再配送する1Sと、page生成site scanのscope/除外/数値を記載patternだけでは
  再現できない1Nを検出した。
- 1Sはreported latchをcallback前に確定する順へ変更した。live-ownerと0-live→最初のlate-spawnの両方で、
  handler内の同期spawnを直接回帰化し、outer/innerのprimary/error保存とdelivery 1回を固定してCLOSED。
- 1Nは棚卸し対象をplayground/showcase sourceへ限定し、packages/tests/generated等の除外理由と実行可能な
  `rg` / `git grep` を記録した。別担当がfinal 162 systems / 30 files / Core alias 2 + 9 preparers /
  8 files = 171、base 161 + 8 = 169を完全再現してCLOSED。
- 初回とは別担当のfresh rereviewは **ACCEPT (Blocker 0 / Should 0 / Nit 0)**。build/runtime二層、全runtime
  source、handler fallback、device/boundary共有source、Three light live-owner、React error gate、readback非増加、
  局所opt-outと文書/semverを再監査し、追加所見なし。
- 独立focused 4 files / 350 tests、full 33 files / 876 tests、typecheck/lint/format/build、package/global ESM、
  changeset status、diff check、direct M10 normal/fault、canonical GPU 19/19、golden 7/7は全てPASS。
  tracked baseline 23枚は差分なし。review server/runner/browserとignored artifactをcleanupした。
