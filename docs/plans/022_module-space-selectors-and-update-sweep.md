# 022: 空間 selector 拡張・RFC 004 表完備・update 段 transform 補間(sweep)

- 重大度: 高(大型。H1-7 相当の重さ)
- 対象: `@nachi-vfx/core`、`@nachi-vfx/format`、RFC 004 / 001
- 状態: 受入済み(H2-6、2026-07-15)
- 出典: H1 後続 Codex 探査 T5 F-04/F-05/F-07 + T4#1(2026-07-14)

## 症状(静的監査)

1. **F-04(確実)**: `velocityCone.direction` が world 固定で emitter 回転に追従せず
   (`compiler.ts:5007` — `Emitter.transform` 非読み)、H1-5 で emitter 追従になった位置分布と
   初速方向が回転 spawn で分離する(RFC 004 既載の意図的制約だが、位置と速度の非対称が残る)。
2. **F-05(要検証)**: `gravity(Vec3)` / `linearForce` は RFC 004 表に行が無く暗黙 world 固定
   (`compiler.ts:5074/5286`)。linearForce のローカル推進用途が成立しない。
3. **F-07(確実)**: RFC 004 表は perDistance の world 距離、Grid Runtime の normalized 座標、
   Grid velocity の cell/sec 単位などを未収録で、新 API 追加時の網羅監査表として不完全。
4. **T4#1(要検証)**: emitter 追従の collidePlane/Sphere/Box・killVolume・vortex/pointAttractor 等の
   update 段モジュールは現在 transform の終点サンプリング(`compiler.ts:4779` ほか)。高速移動・
   低 fps でフレーム間の移動経路を走査せず、衝突/kill の取りこぼし・終点テレポート・fps 依存の
   力場加速が起こる。plan 003 は「init 以外は current transform」と明示的にスコープ外化していた。

## 裁定(2026-07-14)

**sweep まで実装**(推奨の selector+表完備を含む全面対応のユーザー裁定):

1. velocityCone / linearForce へ space selector 追加(省略時既定は現状 'world' 維持=非破壊。
   'emitter' 指定で回転追従)。gravity は world 固定を明記。
2. RFC 004 表を全モジュール+単位系(perDistance / Grid 座標 / scale 非対応)へ完備し、
   新 API 追加時のチェックリストと位置づける。
3. **update 段の emitter 追従モジュールへフレーム内 transform 補間(sweep)を導入**:
   H1-7 の `previousTransform` 基盤を流用し、update 段の `Emitter.transform` 読みを
   サブフレーム位相での補間読みへ拡張する。静止時はビット一致を構成的に保証(H1-7 方式)。
   連続衝突判定(CCD)までは行わず「補間 transform での評価」に留める範囲を RFC で確定する。

## 受け入れ基準

1. selector: 明示 'world' は変更前 WGSL と SHA-256 一致(H1-5 方式)。'emitter' 指定の回転追従を
   GPU 回帰で固定。format strict 対応+往復テスト。
2. sweep: 高速移動エミッタ+emitter 追従 collider/killVolume の fixture で、ステップ分割
   (1 step vs 4 substep)による結果差が縮小することを実測(H1-7 の wuwa ビード検証方式)。
   静止時は全対象モジュールでビット一致。
3. previousTransform リセット経路(H1-7 の点検リスト: 構築 / プール checkout / 初期化前 sync /
   error / fixedTimeStep / quality restart / カリング再開)の網羅を再点検し、以後に追加された
   経路も含める。
4. RFC 004 改訂(表完備+update 段補間の契約+CCD 非対応の明記)。
5. perf 比較(update 段の transform 補間コスト、perf v2 median)。

## 互換性 / リスク

- selector 追加自体は非破壊。update 段補間は移動中の実挙動が変わる(core minor、
  基準再記録の可能性)。
- H1-7・H1-8 で確立した「停止中距離破棄」「ソケットラッチ」規約との相互作用を回帰ピンで監視
  (受入済みチェックの緩和は原則却下=H1-8 知見)。

## 実装・受入証跡(2026-07-15)

### Selector / compiler / format

- `velocityCone` と `linearForce` は `space?: 'world' | 'emitter'` を公開し、helper configへ省略時
  `world`を明示具現化する。`gravity`はworld固定のまま。
- `Emitter.spawnInterpolatedTransform`を使うemitter-space coneと、phase `0.5`固定のcompiler virtual
  `Emitter.updateInterpolatedTransform`を使うemitter-space Update consumerを実装した。translationはlerp、
  rotationは最短経路quaternion slerp。collisionのlocal評価とworld responseは同一nodeを共有する。
- H2-6対象8種(`velocityCone`、`linearForce`、`vortex`、`pointAttractor`、解析collider 3種、
  `killVolume`)の現行helper/registryはmodule version 2。version 1 registryも残し、cone/linearは旧world固定、
  既存emitter consumerは旧current endpointを実行する。`withUpdateInterpolatedTransformRead`もv2だけを補完する。
- Update midpoint対象は`linearForce`、`vortex`、`pointAttractor`、emitter-space解析collider 3種、
  emitter-local `killVolume`。NeighborGridのbucket/boids/PBD/custom visitorはcurrent transformのまま。
- compiler内のaccess補完はv2 definitionに不足する`Emitter.updateInterpolatedTransform` virtual readのみを
  対象とし、v1の旧access manifestはそのまま保持する。source definitionはどちらも変更しない。
- formatはmodule-v1 cone/linearを`space:'emitter'`入力を含め旧意味どおり明示`world`、H1 selector v1の明示
  emitter/current endpointはそのまま、現行v2 authoringはmodule別の明示既定へ正規化する。入力非破壊、
  version非upgrade、closed-field strict validation、load→compile→reload→serialize安定性をテストした。

旧HEAD `62aab5e`で新selectorをversion 1 configへ含めたassetをold format serialize→load→old compilerへ
渡す再現では、diagnosticなしで受理され、`velocityCone` accessは
`['Emitter.seed','Particles.spawnOrder']`だけだった。すなわち旧readerは`space:'emitter'`をworldとして黙って
誤実行する。このためRFC 003 §4に従いmodule v2境界を導入した。同じ旧HEADへ新
`core/velocity-cone@2` (`space:'emitter'`)を渡した別再現では、old formatはenvelopeをserialize→load
で保持したが、old compilerは`init[0]`に
`NACHI_MODULE_UNKNOWN: No kernel implementation is registered for core/velocity-cone@2.`を返した。
つまりH2-6前readerは`type@2` registryを持たず安全に拒否する。asset envelope versionは1のままだが、
module versionが意味境界を所有する。

変更前の省略時/明示world graphを固定したThree WGSL SHA-256は次のとおりで、両経路が一致する。

| Kernel | H2-6前 / 省略 / 明示world SHA-256 |
| --- | --- |
| initialize (`velocityCone`) | `995776cef488f7ef5a096c8d536c5d1615ad8ef879d083e19c7cd85339da3872` |
| update (`linearForce`) | `2b4577d2bc2ee750d5bd9882c4f115a56aa5905b301facbb6ec3aebca3a15e43` |

Three WebGL2 materializationは両selector値のcone/linear forceをbuildするunit testで固定する。Grid/atomicを
含む`/m12-space/`総合GPU fixture自体はWebGPU契約であり、WebGL2全page対応の証拠とはしない。

### Moving CPU reference と旧/新実GPU

旧値は変更前HEAD `62aab5e`の独立worktreeをSwiftShader WebGPUで採取し、さらに現行dual registryのraw
module-v1/旧accessを同じ`/m12-space/`で実行して一致を固定した。particleをworld `x=2`へ固定し、emitterを
`x=0→4`へ移動する。解析CPU reference、旧HEAD GPU、現行v1 GPUは一致した。

| Case | CPU / 旧HEAD / 現行v1 GPU 1 step | CPU / 旧HEAD / 現行v1 GPU 4 substeps | CPU / 現行v2 GPU 1 step | CPU / 現行v2 GPU 4 substeps |
| --- | --- | --- | --- | --- |
| emitter sphere collider (`alive`) | `1` | `0` | `0` | `0` |
| emitter sphere kill volume (`alive`) | `1` | `0` | `0` | `0` |
| emitter point attractor (`velocity`) | `[1,0,0]` | `[0.25,0,0]` | `[0,0,0]` | `[0,0,0]` |

これは1 sampleと4 substepの差が旧版では残り、新midpointではこのfixtureについて0へ縮小することを示す。
ただしmidpointは1点の時間積分近似であり、CCD、swept-volume交差、multi-point sampleではない。sample点間の
薄いvolume crossingは依然見逃し得る。

非killのemitter-space sphere bounceは、emitterをtranslation `0→4`、Z rotation `0→π`へ動かし、
midpoint localでsphere表面へ補正した後のGPU readbackをposition `[2,0.99999994,0]`、velocity
`[0.000000089,0.49999997,0]`として期待値`[2,1,0]`、`[0,0.5,0]`へ照合する。fixture専用custom
registryでinverse local評価はmidpointのまま、forward position/velocityだけをcurrent endpointへ変える
`collider-forward-current` faultは`[3,0,0]`、`[-0.5,0,0]`を返し、`movingColliderResponse`だけを
failする。production compilerにfault分岐は追加しない。

### Stationary bit pin とNeighborGrid fault discrimination

変更前HEAD `62aab5e`から採取したstationary GPU FNV/rowsを固定値とし、新版を全件照合した。

| Module | 旧固定hash / rows | 新hash / rows |
| --- | --- | --- |
| vortex | `698930cd` / 1 | `698930cd` / 1 |
| pointAttractor | `3fdd6f3f` / 1 | `3fdd6f3f` / 1 |
| collidePlane | `a95cc10c` / 1 | `a95cc10c` / 1 |
| collideSphere | `409a2c30` / 1 | `409a2c30` / 1 |
| collideBox | `409a2c30` / 1 | `409a2c30` / 1 |
| killVolume | `050c5d1f` / 0 | `050c5d1f` / 0 |

`/m12-space/`の実NeighborGrid fixtureはcurrent endpointで`cellCount=2`、`outOfBounds=0`、
visitor counts=`[1,1]`となる。midpoint故障注入は`0`、`2`、`[0,0]`となり、bucket挿入と実visitor lookupの
双方を弁別する。selector-world、sweep-current、stationary-bitの各contract専用故障注入も対応validationを
失敗させる。runtime diagnosticは無効化せずcollector handlerで観測し、通常系は0件、
`grid-midpoint` faultは`NACHI_NEIGHBOR_GRID_OUT_OF_BOUNDS_DOMINANT` warning 1件を返す。どちらも
strict consoleはcleanである。

### Transform history監査

| 経路 | H2-6規則 / 証跡 |
| --- | --- |
| 構築・spawn position/rotation | previous=current、inactive。stationary system test |
| 初期化前`setTransform`・最初のattachment sync | historyを同じcurrentへreset。attachment即時同期test |
| pool checkout | transform/history/random ordinalを新spawnへreset。実kernel再利用test |
| fixed timestep | 各substep終点を順にcommitし、最後にprevious=current/inactive。2-substep test |
| prewarm | entryをdirect-currentで開始。prewarm test |
| hit-stop / pause | simulationを抑止したstepで移動を消費し、resumeで古いendpointを再利用しない。hit-stop test |
| culling再開 | culled中もhost transform historyを追跡し、再開時は最後に消費したendpointから評価。既存culling resume testとscheduler監査 |
| event-only fallback | 同じUpdate virtual transform branchを使い、scheduler ordinal/transform更新順を共有。既存fallback testとcompiler access test |
| quality変更/restart | live uniform tier変更はruntime emitterを再構築しない。structural variantは新spawn/pool key。既存quality test |
| error/release | error kernelはpoolへ再投入せず、release後methodを拒否。既存error/pool/release tests |

### Perf v2 (同一負荷、SwiftShader WebGPU)

変更前/変更後とも、emitter-space `pointAttractor` 1粒を各sampleで移動させる同一workload、warmup 4、
compute target 16 samplesを1 runとし、5 runsずつ採取した。単位はms。

| Build | run medians | run p95 | median of medians | median of p95 |
| --- | --- | --- | --- | --- |
| old `62aab5e` | `0.110, 0.083, 0.118, 0.101, 0.109` | `0.154, 0.173, 0.193, 0.190, 0.195` | `0.109` | `0.190` |
| H2-6 | `0.099, 0.118, 0.108, 0.109, 0.097` | `0.224, 0.197, 0.250, 0.170, 0.212` | `0.108` | `0.212` |

medianの代表値は約`-0.9%`。p95は新版が約`+11.6%`だが、旧range `0.154–0.195`と新range
`0.170–0.250`が重なるSwiftShaderのsub-msノイズ帯であり、median regressionは観測しない。各runは
perf schema v2 validation、16/16 samples、4/4 warmupを通過した。

### 文書・release metadata

- RFC 004 EN/JAをSpawn/Init/Update/Event/RenderおよびGrid全built-inのN/A行を含む完全表へ改訂し、
  perDistance world unit、Grid normalized座標、Grid velocity cell/s、NeighborGridのlocal origin/current
  transformとcell/world単位区別、scale非対応、API追加checklistを規範化した。
- RFC 001 EN/JAとcore READMEをmodule別selector既定、gravity world固定、Update midpoint、CCD非対応へ同期した。
- `@nachi-vfx/core`と`@nachi-vfx/format`のminor changesetを追加した。

### 最終gate

- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm esm:check`: pass。
- `pnpm test`: 32 files / 748 tests pass。
- `pnpm golden:regress`: 7/7 pages pass。
- `pnpm verify:gpu`: playground 9 pagesとshowcase 6 pages、計15/15 pass。
- `/m12-space/`の5故障注入は全てrunner exit 1となり、各対応validationのfailを弁別した。

### 独立レビューと統括受入

- 初回独立レビューは`BLOCKER 0 / SHOULD 2 / NIT 0`で差し戻した。非kill colliderのforward responseを
  弁別するposition/velocity実GPU readbackとfixture専用faultを追加し、NeighborGrid runtime diagnosticを
  collectorで通常0件/fault時warning 1件として合否へ集約した。併せてtools READMEのsuite数を15へ更新した。
- 別担当のfresh再レビューは`ACCEPT (BLOCKER 0 / SHOULD 0 / NIT 0)`。focused 465/full 748 tests、
  format/lint/typecheck/build/ESM、golden 7/7、GPU 15/15、5 faultの期待exit 1を独立再実行し、初回2件の
  閉鎖、module-v1/v2互換境界、WGSL固定値、history、RFC 004表、changeset、スコープを再監査した。
- 統括は上記証跡と最終差分を照合し、H2-6を2026-07-15に受け入れた。
