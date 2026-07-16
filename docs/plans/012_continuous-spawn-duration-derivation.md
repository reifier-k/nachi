# 012: 連続スポーンの省略時 duration 導出(rate/perDistance の無限継続)

- 重大度: 高(無音の失敗。一粒も出ずに完了する)
- 対象: `@nachi-vfx/core`(spawn 包絡導出・エミッタライフサイクル)、RFC 001
- 状態: 受入済み(H2-2、2026-07-15。独立再レビュー ACCEPT、BLOCKER/SHOULD/NIT=0、初回 BLOCKER CLOSED)
- 出典: H1 後続 Codex 探査 T1#1(task-mrkl9puw-hbbgor、2026-07-14)

## 症状(静的監査、確度=確実)

`rate()` / `perDistance()` エミッタで `lifecycle.duration` を省略すると一粒も生成されず完了する。
H1-1(plan 007)の省略時 duration 導出は multi-cycle burst 包絡のみを考慮し
(`packages/core/src/system.ts:805` — `if (burstEnvelope === 0) return 0;`)、連続スポーンでは
導出値 0 になる。duration 0 では active update が発生せず、activation 時 spawn は burst 専用
(`system.ts:1599`)。plan 007 と同根(省略時 lifecycle の縮退既定)の別経路。

## 裁定(2026-07-14)

**無限 duration 導出を採用**。rate/perDistance を含むエミッタは省略時に無限継続
(`stop()` / timeline 終了で止まる)。Niagara の loop 既定に整合。burst 包絡導出(H1-1)と共存
(burst のみ=包絡導出、連続スポーンあり=無限)。明示 duration は常に優先
(H1-1 と同じ `lifecycle?.duration === undefined` 導出キー規約)。

## 受け入れ基準

1. `rate()` のみ+lifecycle 省略のエミッタが継続的にスポーンし、`stop()` と timeline 管理で
   正しく終了する。
2. burst 専用エミッタの H1-1 導出が不変(m3-sprites burstCycleDeathOverlap 回帰緑)。
3. 明示 duration 指定時の挙動が全経路(直接 / 部分 lifecycle オブジェクト / format)で不変。
4. RFC 001 両言語の導出規約へ「連続スポーン=無限」を追記。
5. GPU 回帰: rate+省略 lifecycle の実スポーン数チェックを m2/m3 系ページへ常設。

## 互換性 / リスク

- 従来「即完了」だった定義が継続動作になる=挙動変化(core minor)。ただし従来挙動はほぼ確実に
  バグ踏み(一粒も出ない)なので実質的な救済。
- 無限継続が scalability / significance の完了判定・カリング復帰と干渉しないことを確認する。

## 実装前再現(2026-07-15)

既存のruntimeテストから明示 `lifecycle.duration` だけを外し、修正前HEADで次を実行した。

```sh
pnpm vitest run packages/core/test/system.test.ts \
  -t 'accumulates fractional rate spawn|converts transform distance'
```

結果は2/2 FAIL。`rate` は期待したspawn submission 1件に対して0件、`perDistance` は期待した
`Emitter.spawnCount=10` に対して0だった。静的監査の `defaultSpawnEnvelopeDuration() -> 0`、
zero-duration controllerの即complete、active step不在という経路と実測が一致したため、確度を
**確実**と確定してから修正した。

## 実装設計(2026-07-15)

- `defaultSpawnDuration()` はcompiled spawn stackに `core/rate` または `core/per-distance` が1件でも
  あれば無限durationを返す。continuousを含まないburst-onlyはH1-1のmulti-cycle包絡+lifetime graceを
  そのまま使う。混在時はcontinuous側の無限が優先される。
- 公開 `EmitterLifecycle.duration`、`normalizeEmitterLifecycle()`、format validatorのfinite-only契約は
  不変。省略由来の無限だけをmodule-private symbolでruntime controllerへ渡すため、明示 `Infinity` は
  公開APIからもassetからも引き続き拒否され、JSONへ `Infinity` が流出しない。
- 導出キーは `definition.lifecycle?.duration === undefined` のまま。lifecycle全省略・空/部分objectを
  同一に扱い、明示finite durationは `startDelay` 等と合成されても常に直接優先する。
- duration省略continuousに有限 `loopCount` を指定しても、最初のactivation自体が無限なので後続loopへ
  到達しない。この規約をRFC両言語とunit回帰へ固定した。終了所有者は `stop()`、timeline stop/end、
  `release()`。
- authoringのloop-duration診断はduration省略continuousを正当な無限windowとして許可する一方、
  burst-onlyかつ正の包絡なしの既存診断を維持する。

## 回帰面と追従

- core unit: rate/perDistance省略の実spawn、partial lifecycle+有限loopCount、明示finite+startDelay優先、
  明示Infinity拒否、stop後の時刻/dispatch凍結を追加。既存multi-cycle burst回帰は不変。
- timeline unit: duration省略rate子を0秒でplayし、明示stop actionなしで0.05秒の最終track boundaryから
  stop+release、親complete、退役state保持へ至る専用回帰を追加した。runtimeも最終cycleで子をtruncateし、
  既存のduration 0 `at(0)` shorthandだけは即truncateせず子自然完了を維持する。独立レビュー後は
  5e-11秒の正のsub-epsilon trackも同じ終了契約へ固定した。
- format: 省略rateと明示finite+startDelay rateをserialize/loadし、省略と明示を混同せずJSONに
  Infinityを含めないことをunit化。さらにm2 GPU面はこのloaded assetを実際にspawnし、
  省略rate=無限active、明示finite=2 fixed step後completedを検証する。
- scalability/significance: 既存distance culling復帰回帰のrate定義から明示duration workaroundを撤去し、
  culled中local time凍結→復帰後spawn/lifecycle activeを固定。別途、significance 1-slotを解放した後に
  待機中の省略rateがadmitされspawnする回帰を追加した。
- GPU恒常ゲート: `tools/verification-runner.mjs` のplayground面へ `m2-runtime` と `m3-sprites` を追加し、
  H2-1 runner/CIから毎回実行する。m2はformat-loaded rate 30、perDistance 10、明示finite 20、stop凍結を
  実readbackする。m3はH1-1 `burstCycleDeathOverlap` を200 births/140 aliveで維持する。
- m3をH2-1 perf契約へ載せる際、従来の長いcorrectness rendererが意図的に
  `trackTimestamp:false` だったため初回はstructured configuration failureとなった。correctness側は
  query-pool枯渇防止のtimestamp-freeを維持し、別の短いrendererで同じcompute+sprite renderを20回
  (warmup 4+sample 16)測る構成へ分離した。
- showcase 6面を監査。beamの「multi-cycle burstが描画不能なのでrateへ回避」というH1以前の陳腐化comment
  だけを、現在の連続inflowの意図へ簡素化した。beam 4件/slash 1件の明示durationはtimeline上の有限発生窓
  というauthor intentであり撤去対象ではない。他5面にH2-2回避策はなかった。見た目変更はない。
- changeset: `.changeset/continuous-spawn-duration.md` (`@nachi-vfx/core` minor、
  `@nachi-vfx/timeline` patch)。

## 実装担当検証(2026-07-15、レビュー前)

- 修正後重点: core/timeline/format 229 tests PASS。scalability重点2 tests PASS。
- m2実GPU(dist): rate alive 30、perDistance alive 10、format明示finite alive 20+completed、
  `rateOmittedLifecycleActive` / `perDistanceOmittedLifecycleActive` / `rateStopFreezesTimeline` / format 2契約を
  含む全validation true。compute warmup 4/4、sample 16/16。
- m3実GPU(dist): `successfulBirths=200`、physical/indirect alive=140、全visual validation true。
  分離perfはcompute/render/totalすべてwarmup 4/4、sample 16/16。
- `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm format:check`: PASS。
- `pnpm test`: 最終31 files / 697 tests PASS。
- `pnpm golden:regress`: server未起動の初回は7件とも `ERR_CONNECTION_REFUSED`(環境要因)。5173起動後の
  再実行は7/7 PASS。
- `pnpm verify:gpu`: 最終状態の拡張suite 13/13 PASS、60.702 s。showcase 6/6 `ok:true`、H2-1のdefinition由来
  全114 key activity契約を維持。
- baseline 22 PNGは実行前後のSHA-256が全件一致し、`git status -- tools/baselines`はclean、tmp/bakなし。
  baseline更新なし。

## 独立レビュー差し戻し対応(2026-07-15)

- 初回判定: REJECT (BLOCKER 1、SHOULD/NIT 0)。最終boundaryのtruncate条件が
  `duration > EPSILON` だったため、正だがEPSILON以下のdurationでは `ended=true` 後もcontinuous子を
  stop/releaseせず、親が永久activeになる指摘。
- レビュー再現値 `duration=5e-11` の省略rate子を専用unitへ追加。修正前の重点実行は
  `expected released, received active` で1/1 FAILし、指摘経路を確定した。
- zero-duration `at(0)` shorthandの自然完了例外を厳密な0だけに限定し、最終boundaryでは
  `duration > 0` の全trackを `#stopAllElements()` するよう修正。正のsub-epsilon回帰は子released、
  親complete、退役state (`localTime: 0`, `playing/visible: false`) を明示する。
- 修正直後のtimeline重点は46/46 PASS。通常0.05秒truncate、duration 0 shorthand、loop境界を含む
  既存回帰も同一suiteで維持。changesetのcore minor+timeline patchという範囲は引き続き妥当。
- 差し戻し後の全ゲート: `pnpm build` / `pnpm typecheck` / `pnpm lint` /
  `pnpm format:check` PASS、`pnpm test` 31 files / 698 tests PASS、`git diff --check` /
  `pnpm exec changeset status` PASS。
- 修正はtimelineの正duration終了条件とunit/docだけでGPU・描画へ影響しないため、golden 7/7・GPU 13/13の
  初回独立レビュー証跡を維持した。baseline statusはclean、tmp/bakなし、検証用dev serverの残存なしを確認。
- fresh独立再レビューは初回BLOCKERをCLOSEDと判定しACCEPT。`0` / `-0` / `5e-11` /
  `Number.MIN_VALUE` の境界を独立プローブし、timeline 46、重点core/timeline/format 231、全698テスト、
  build/typecheck/lint/format/changeset/diff-checkを再実行して全PASS。新規指摘0件。

## 既知残差

`rate(0)`かつ`lifecycle.duration`省略は連続spawn moduleとして分類されるため、一粒もspawnしないまま
無限activeになる。これは省略duration規約と整合するが、作者が停止境界も書かなければ終了しないauthoring
trapである。暗黙に完了へ変えると`rate`の動的ValueInput契約を破るため、本planでは診断・自動補正を行わない。
