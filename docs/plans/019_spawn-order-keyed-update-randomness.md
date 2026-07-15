# 019: update 段乱数の spawnOrder キー化(H1-10 続編)

- 重大度: 高
- 対象: `@nachi-vfx/core`(乱数導出)、RFC 001
- 状態: 受入済み(H2-3、2026-07-15。独立再レビューACCEPT、0B/0S/0N)
- 出典: H1 後続 Codex 探査 T3 A-1(task-mrklabwk-qlz4jd、2026-07-14)。
  plan 011 / H1-10 の意図的据え置き範囲

## 症状(静的監査、確度=確実)

update 段の `context.random()` / `range()` は物理 particleIndex+spawnGeneration キーのまま
(`compiler.ts:1218/3192` — H1-10 で init のみ spawnOrder キー化済み)。gravity / pointAttractor /
curlNoise / vortex / turbulence / vectorField、および collision の `bounce` / `friction` 等へ
`range()` を指定すると、slot 再利用の順(コンパクション由来で非決定)がラン間の見た目差になる。
collision では反発方向・`onCollision` 発火列まで変わり得る。plan 011 の「凍結パターン」と
対をなす「slot 系列引き継ぎ」の分布歪みも残る。

## 裁定(2026-07-14)

**spawnOrder キーへ拡張**。H1-10 の PCG 構造維持・最小変更方針を踏襲しつつ、update 段の安定キーを
spawnOrder(+エミッタシード+module/sample slot+時間変化成分)へ変更し乱数を完全決定化する。

## 受け入れ基準

1. H1-10 と同水準の統計プローブ(χ²/KS/シフトコピー/直列相関)合格。
2. update 段に range() を持つ再現エミッタ(寿命<スポーン窓)でラン間スクショ差分が
   決定性ゲート内(≤0.02% 目標、3 連続)。
3. init 段・event 段の導出は不変(H1-10 の m3 リグ緑)。M1 all-slots 経路のビット保持を再実証。
4. 時間発展すべき乱数(フレーム毎に変わる turbulence 等)の意味論を壊さないこと —
   世代 / 時間成分の混合設計をレビューで検証。
5. 影響するtracked baselineが存在する場合だけ、見た目の具体値変化を意図変化として基準再記録+目視合格
   (H1-10 と同じ弁別規約:「見た目の変化」と「見た目の退行」を構造比較で区別してから再記録)。

## 互換性 / リスク

- 乱数列の変化=事実上の見た目変更(core minor)。影響するtracked baselineが存在する場合だけ基準を再記録する。
  H1-10では12ページが実際に影響を受けて再記録した前例がある。
- update 乱数は毎フレーム評価のためハッシュ入力追加の GPU コスト増を perf v2 median で比較する。

## 実装前の再現確定(2026-07-15)

- JS mirror単体プローブでは同じlogical spawnOrder 40..47/seed 73/module-sample slot
  `3600510046`に対し、旧キーの物理配置A(slot 0..7, generation 2)から配置B(slot 7..0,
  generation 5)へ変えるだけで8/8サンプルが変化し、最大差は`0.7643715986050665`だった。
- さらに`be240d0`の別worktreeへ修正後と同じm3実GPUリグだけを先行適用して確度を確定した。
  `rate(80)`、lifetime 0.12–0.18秒、spawn window 0.8秒、`gravity(range(-3,-0.5))`、
  40固定step後のsuccessful births 53/alive 11というslot再利用条件で、capacity 32はlogical hash
  `89e999fc`、同scheduleのcapacity 33は`da4c9cf6`となり不一致。additive spriteのcapacity撹乱
  screenshot差も`0.046875%`(MAD `0.11828125`)で目標`0.02%`を超え、pageは`ok:false`だった。
  同capacityの3実行はSwiftShader上で偶然同じ物理配置となりhash/画面とも一致したため、capacity撹乱が
  物理slot依存を弁別する必須対照である。

## 実装

- H1-10のPCG RXS-M-XS演算列と定数を維持し、Updateだけを次の4軸へ変更した。
  `pcgHash(spawnOrder*0x9e3779b1 XOR seed*0x85ebca77 XOR
  moduleSlotSalt(resolveRandomSampleSlot(moduleSlot,sampleOffset)) XOR
  updateRandomStep*0x27d4eb2f) * 2^-32`。物理particle indexと
  `Particles.spawnGeneration`はUpdateキーから完全に除いた。Initは従来どおりspawnOrder+進行キー0、
  pre-allocation Spawn CPU mirrorは従来のemission generationであり、どちらもbit不変である。
- `Emitter.updateRandomStep:u32`を予約uniformとして追加。RuntimeEmitter新規生成/pooled kernel checkoutで
  current/next値を0へ戻す。fixed-step/prewarmとevent-input fallbackを含むsimulation Updateのsubmit直前だけ
  current値をuniformへuploadし、そのdispatchが消費する。renderer submitのawait成功後に限りpure helperで
  private counterをnextへ進め、reject時は進めない。進行は2^32を法とし、`0xffffffff`のnextは0。timeScale 0、
  完全hit-stop、culling、0-delta、pipeline準備だけでは消費/進行しない。lifecycle loopではリセットせず自然wrap
  まで同じ列を継続する。uniform.valueは初期値0で、simulation Update後は最後にdispatchしたcurrent値を保持し、
  private counterはnext値を保持する。同じseed/spawn schedule/step-dispatch列なら同じ値を再現し、range値は
  実Updateごとに変化する。
- Update configの任意深さの`range()`は`Emitter.seed`、`Particles.spawnOrder`、
  `Emitter.updateRandomStep` readを導出する。したがってspawnOrder storage/schema/budgetは利用時だけ追加され、
  WebGL2 reduced single-burst Updateも同じlogicalキーでmaterializeできる。custom attributeのInit default rangeは
  従来のInit経路のまま。外部registered Update implementationの`context.random()`はdefinition/implementation
  双方で3 readを宣言しなければ`NACHI_UPDATE_RANDOM_STABLE_KEY_ACCESS_REQUIRED`でfail closedする。
  inline `tslModule()`はこのKernelModuleBuildContext APIを公開しないため変更不要。
- RFC 001日英へキー軸、dispatch進行規則、loop/pause/culling/prewarm、外部access互換性を明記した。
  core minor changesetは`.changeset/stable-update-random.md`。

## 初回独立レビュー修正(2026-07-15)

- 初回結果はREJECT(0 BLOCKER / 3 SHOULD / 1 NIT)。全4件を修正し、再レビュー待ちとした。
- SHOULD 1: 非公開`nextUpdateRandomStep()`へu32進行を一元化し、`0→1`、`0xfffffffe→0xffffffff`、
  `0xffffffff→0`をunit testで固定。current消費、成功await後のnext進行、uniform/private counter、loop/wrap規約を
  RFC日英と本planへ明記した。
- SHOULD 2: Fake rendererが各emitterの`NachiEmitterUpdate` submit時点でuniform current値を捕捉するようにし、
  fixed partition、prewarm、pause、hit-stop、culling、loop、pool checkout、preparePipelines、event-input fallback、
  submit rejectionをlast-uniformではなくdispatch列で弁別した。この強化でloop activate時にdispatchなしでnext値を
  uniformへ先行uploadしていた曖昧さを実検出し、simulation Update専用submitへupload/await/next進行を集約して解消した。
- SHOULD 3: 外部registered Updateのdefinitionだけstable/implementation legacyはUpdate固有診断、implementationだけ
  stable/definition legacyは事前の`NACHI_MODULE_ACCESS_MISMATCH`となる境界を個別回帰化し、両側fail closedを固定した。
- NIT 1: baseline再記録は影響するtracked baselineが存在する場合だけ、と受け入れ基準/リスクを条件化した。
- レビュー修正はCPU側ordinal所有権とテスト/文書だけで、Update WGSL、PCG hash、simulation dispatch数、各dispatchの
  uniform upload回数/値を変えない。したがって既存のold/new perf比較は同じGPU経路の証拠として再利用し、m3 smokeを
  最終GPU suiteで再実行する。

## 統計・bit保持・GPU検証

- 32,768標本/32 bin: χ²=`22.697265625`(<60)、KS D=`0.0022769251372665167`
  (<0.01)、lag-1直列相関=`-0.00009435739940746171`(|r|<0.02)。
- 16,384標本で±8 shiftを走査した最大相関は、隣接spawnOrder=`0.016850045204860623`、
  time=`0.015423316683194814`、module=`0.016926724851051966`、sample slot=
  `0.01619540790209561`(すべて<0.04)。spawnOrder 256×time 16×sample 4の16,384格子は
  16,384 uniqueで衝突/シフトコピーなし。
- Three実WGSLの新Update shader hashは
  `05c9a7baec6516f8714e2cc63e65f27b50f57d9e060b4b5cdb639d6da65e70f0`。
  H1-10のM1 all-slots Init hash `1caf028fc8005f58531b31f85f8c4847b1330b4d50c4776cf878e505e2bdb343`
  とfree-list Spawn hash `138c12265a60f2db722ec488ef11822c40f6d0f1763ddbc47c8f6ec5f93ade3d`
  は旧値のまま。all-slots/free-list/event-spawn Initの同一lifetime range saltも3経路すべて
  `2941967914`でbit一致した。
- 修正後m3実GPUリグはcapacity 32/33ともsuccessful births 53/alive 11/logical hash
  `ea4b7ad0`で完全一致。各page内3独立captureの全組合せscreenshot差0%、capacity撹乱差0%。
  外部からpage全体を3連続起動しても3回とも同じ値、`ok:true`、console/diagnostic/perf v2緑だった。
  旧HEADの同リグとの差から、変化は物理slot系列の除去とUpdate dispatch時間軸の追加による意図変更と判定した。
- perf v2は決定性検証と同じ`updateRandomRangeEffect(32)`を専用64x64 compute+sprite render経路でも使用した。
  この定義は`rate(80)`、lifetime 0.12–0.18秒、`gravity(range(-3,-0.5))`を含むため、採用sampleで
  Update `range()`/PCG hashを毎dispatch実行する。runtimeのcompiled programもgravity readを検査し、修正後は
  `Emitter.seed`、`Particles.spawnOrder`、`Emitter.updateRandomStep`の3入力を含むことをpage gateにした
  (旧HEADの同一定義は`Emitter.seed`、`Particles.spawnGeneration`)。compiler/Three単体テストでも同じ3 read、
  spawnOrder schema、実WGSL hashを固定している。
- この同一fixtureを同一SwiftShader adapterでfresh browserから旧HEAD/修正後それぞれ5回実行し、各回
  warmup 4+採用16 sampleのmedianを比較した。5 run medianの中央値は次のとおり。

  | scope | 旧HEAD | 修正後 | 差分 |
  | --- | ---: | ---: | ---: |
  | compute | 0.192 ms | 0.186 ms | -0.006 ms (-3.13%) |
  | render | 0.449 ms | 0.418 ms | -0.031 ms (-6.90%) |
  | total | 0.633 ms | 0.597 ms | -0.036 ms (-5.69%) |

  run別(compute/render/total ms)は旧HEADが
  `0.184/0.449/0.626`, `0.192/0.449/0.641`, `0.200/0.415/0.633`,
  `0.179/0.336/0.520`, `0.192/0.453/0.649`、修正後が
  `0.164/0.420/0.589`, `0.186/0.409/0.597`, `0.226/0.418/0.657`,
  `0.177/0.400/0.586`, `0.259/0.431/0.683`。
  旧HEADのpage自体は上記capacity撹乱の決定性ゲートを意図どおり失敗したが、全runのperf v2 sample windowは
  完走した。run-level total medianの範囲は旧0.520–0.649 ms、新0.586–0.683 msと重なり、各scope中央値は
  いずれも増加していないためGPUコスト回帰なしと判断する。これらは同adapter・同host内の相対比較であり、
  SwiftShaderのrun間ノイズを含むので、実GPU性能値や高速化として一般化しない。

## baseline構造比較

- 比較前のtracked baseline 22枚manifest SHA256は
  `e7600de5989fec2f94da4d4aaf153f069fba19eda62f5bcb218b0062838440f9`。既存golden/showcaseには
  Update range利用が0件だったため、golden 11枚+verification playground 5枚はchanged pixels 0
  (leaves/slash sparks/character ring ROIも0)。
- showcase 6枚は全114 activity key、foreground bounds/brightness、diagnostic/console/perfが合格。
  baseline比はslash `0.03227%`、heal `0.00403%`、ice `0.00211%`、beam `0.00442%`、
  machina `0.00346%`、barrier `0.03342%`の通常のrun-to-run raster微差で、構造退行なし。
  本変更の利用面でないためbaselineへ焼き込まず、22枚のhashは比較後も同一、tmp/bakなし。
- 具体的なUpdate乱数列の意図変更はtracked基準を不必要に変えず、上記m3の専用GPU面で旧/新構造と
  capacity不変性を直接比較して固定した。

## 初回レビュー修正後の最終ゲート(2026-07-15)

- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm esm:check`、
  `pnpm changeset status`が成功。changesetはcore minor(依存packageのpatch連鎖)を認識した。
- focused: wrap/compiler/runtime 3 files / 356 tests成功。`pnpm test`: 32 files / 712 tests成功。
  `pnpm golden:regress`: 7/7成功。
  `pnpm verify:gpu`: playground 7 + showcase 6 = 13/13成功(m3 update-range専用gateを含む)。
- 最終baselineは22枚、manifest SHA256
  `e7600de5989fec2f94da4d4aaf153f069fba19eda62f5bcb218b0062838440f9`で開始時から不変。
  baseline配下のtmp/bak/actualは0、tracked差分なし。

## 独立再レビュー・受入(2026-07-15)

- fresh独立再レビューは`ACCEPT`、BLOCKER/SHOULD/NIT=`0/0/0`、新規問題なし。
- 初回指摘4件はすべて`CLOSED`。wrap helperは非公開のまま、runtime submit列はkernel object identityで
  弁別され、registered Updateの両片側access境界とbaseline条件文もRFC日英・tests・本planで一致した。
- 再レビュー独立実行はfocused 5 files / 420 tests、full 32 files / 712 tests、build/typecheck/lint/
  format/ESM/changeset/diff、golden 7/7、GPU 13/13が成功。m3外部3 runもcapacity 32/33で
  births 53/alive 11/hash `ea4b7ad0`、page内3 capture/capacity撹乱の画面差0、perf sample 16/16だった。
- tracked baseline 22枚とmanifestは不変、tmp/bak/actualおよび残存server processなし。以上によりH2-3を受入とした。
