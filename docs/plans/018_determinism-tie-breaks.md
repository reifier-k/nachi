# 018: 決定性の残余バッチ(tie-break 数値化・論理順固定・既知制限明文化)

- 重大度: 高
- 対象: `@nachi-vfx/core`、`@nachi-vfx/three`、RFC 001
- 状態: 受入済み(H2-4、2026-07-15、fresh独立再レビューACCEPT、0B/0S/0N)
- 出典: H1 後続 Codex 探査 T3 D-1/D-2/B-2/B-7(修正)+B-1/B-6(文書化)(task-mrklabwk-qlz4jd、2026-07-14)

## 症状と修正前再現(確度=確実)

1. **D-1/D-2**: significance 予算と同深度 alpha emitter の coarse 描画順は
   `nachi-effect-${seq}` の文字列辞書順だった。変更前HEADへ同じfixtureを移植すると、helperは
   9/10を`[10,9]`、99/100を`[100,99]`と並べた。実systemでもID 9が`culled`、10が`full`、
   ID 99が`spawn-suppressed`、100が`full`となり、早い生成が桁境界で負けた。
2. **B-7**: light top-N の同点決着は物理slot昇順だった。変更前m10-lit実GPUではcapacity 5の
   3 birth帯がphysical `[1,2]`、logical `[3,2] -> [7,6] -> [11,10]`、capacity 6はphysical
   `[2,3]`で、早いlogical birthではなくslot再利用結果を選んだ。独立runも同値だった。
3. **B-2**: 複数sourceから同じtargetへのevent routingはeffect要素の列挙順だった。変更前m3実GPUの
   capacity 1 fixtureでは `{zeta,target,alpha}` が`positionX=+0.75`、反転定義が`-0.75`となり、
   どちらもalive 1 / dropped 1だったため、飽和勝者だけが挿入順で反転した。
4. **B-1/B-6**: 1 producer queue内のatomic append順とNeighborGrid bucket予約順は、GPU並列
   atomicの性質上、adapter/run間で正規化されない。これは修正ではなく契約境界の明文化対象である。

## 裁定と実装

### A. effect instanceの数値生成順

- 公開IDは互換な`nachi-effect-N`のまま維持し、system所有の数値生成シーケンスを非公開WeakMapで
  instanceへ関連付けた。significanceの同点はscore降順後にこの数値昇順、coarse alphaは同深度後に
  数値昇順、続いてemitter keyで決着する。10進文字列は意味論に使わない。
- 新しいsystemは1から開始する。pool checkoutは新しいハンドル/シーケンスを作り、prepareは従来どおり
  IDを消費する。`Number.MAX_SAFE_INTEGER`到達後は不正確な順序を作らずspawn前に`RangeError`とする。
- `CoarseTransparencyEntry.stableSequence?`は外部helper利用を壊さない加算APIである。collection全件が
  safe integerを持つ場合だけ数値modeを使い、1件でも省略/NaN/Infinity/unsafeならcollection全体を
  従来の`stableKey`比較へfallbackする。pair単位でmodeを混ぜず、mixed callerでも推移的な全順序を保つ。
- MAX_SAFE枯渇判定と公開ID生成は、package indexからexportしないpure internal helperへ分離した。
  `MAX_SAFE-1`から最後の`MAX_SAFE`をexactに一度発行し、次の要求を同じ`RangeError`で拒否する。

### B. light top-Nの論理birth順

- `lightRenderer()`だけが`Particles.spawnOrder`をaccessへ追加し、非light schema/layout/budgetは不変。
  selectorは`(priority descending, unsigned spawnOrder ascending)`をGPU replacementとCPU readback
  sortの両方で使用する。`physicalIndex`は診断metadataだけに残す。
- 既存の3つ目のvec4の未使用z laneへ、`uintBitsToFloat`/`floatBitsToUint`でu32をbit-exactに格納する。
  bufferサイズとreadback回数は増やさない。`ThreeLightSelectionStats.selected`へ`spawnOrder`を加算した。
- u32 wrap後に同時生存粒子が同じkeyを持つ完全tieは保証外である。既存half-range警告へ達し得る用途は
  wrap前にemitterを再起動する。

### C. cross-source event routingの正規順

- validation後のlinkを`(targetKey, sourceKey, eventName, handler target, sorted inherit names)`の
  辞書順tupleで正規化してからtarget runtimeへ渡す。targetごとの逐次queue消費、子spawnOrder帯、
  capacity飽和時の先勝ちはこの順序に従う。
- 同じsource/event/targetでもinherit集合が異なるhandlerは順序が固定される。tupleまで完全一致する
  重複handlerは同じqueue record・target・継承属性を実行するため意味論上区別不能であり、JS stable sortの
  元順を残しても結果差を生まない。

### D. 原子順の既知制限

- cross-source queue間はCで正規化するが、単一producer queue内で同一dispatchの複数invocationが予約する
  append順はhardware raceのままである。この順序はtarget子spawnOrderと飽和winnerへ伝播する。seedは
  RNGだけを固定し、atomic順は固定しない。source/eventを分離し、queue/target capacityへ余裕を持たせる。
- NeighborGridはcapacity未満でもbucket slot順がatomic予約順なので、浮動小数点累積の下位bitが異なり
  得る。overflow時は保持集合とwinnerも変わり得る。`cellCapacity`余裕はlossy winnerを避けるが、正規の
  bucket順は保証しない。bitwise replayには将来のdeterministic neighbor modeが必要である。

## 弁別回帰と実測

- core unit: 9/10・99/100 helper、実significance instance/particle予算、公開ID、eventの逆挿入、
  同source/event/targetで異なるinherit handlerを固定した。
- three unit: controlled readbackでpriority同点、physical 7/spawn 9とphysical 1/spawn 100を与え、
  選択順がspawn `[9,100]` / physical `[7,1]`であることを固定した。
- m10-sort実GPU: renderOrderはID 9/10=`1000/1001`、99/100=`1002/1003`。significanceは早い側が
  `full`、遅い側がそれぞれ`culled`/`spawn-suppressed`。既存画像差0。
- m10-lit実GPU: capacity 5の独立2 runでphysical `[4,3]`のままlogical
  `[0,1] -> [4,5] -> [8,9]`、capacity 6ではphysical `[5,4]`でも同じlogical列を選択した。
  candidate 4 / maxLights 2で3回のdeath/reuseを通す。変更前後PNG SHA-256はともに
  `624182aa5f9ca134f36498f69274a4a4a140b2ebe9668fb4be987a798b4084`で、視覚差は0。
  この実selector面を恒常化するためm10-litをGPU suiteへ追加し、suiteはplayground 8 + showcase 6
  の14ページとなった。
- m3実GPU: forward/reversedとも`alive=1, dropped=1, positionX=-0.75, spawnOrder=0`で、alpha sourceが
  正規順の飽和winnerとなった。既存H2-3決定性fixtureと画像は不変。

## 初回独立レビュー指摘の解消(0B/2S/1N)

- **S1 CLOSED**: optional `stableSequence`をpairごとに判定するとmixed 3要素で非推移になり得た。
  collection単位のall-valid modeへ変更し、全省略、全指定、mixedの全6入力順、NaN、Infinity、unsafeを
  unit回帰化した。
- **S2 CLOSED**: m10-litのprobe systemとm3のevent routing systemに`maxPoolSize: 0`を明示した。
  既存`try/finally` release/disposeと合わせ、一時kernelをpoolに保持しない。
- **N1 CLOSED**: MAX_SAFE guardを非公開pure helperへ分離し、最後の2 IDがexactかつuniqueであること、
  MAX_SAFE到達後に同じmessageの`RangeError`となることを直接テストした。公開package surfaceは増やさない。

## 性能(perf baseline v2、SwiftShader相対比較のみ)

m10-litの各sampleで実際に`lightDraw.update()`を呼び、追加したu32比較を通した。各runはfresh browser、
4 warmup + 16 samples、compute/render/total全scope complete。個票は次のとおり(ms、順に
compute/render/total)。

- 変更前HEAD: `0.051/0.185/0.241`、`0.054/0.204/0.261`、`0.056/0.198/0.247`、
  `0.054/0.203/0.256`、`0.054/0.197/0.253`
- 変更後: `0.058/0.193/0.247`、`0.059/0.203/0.257`、`0.058/0.208/0.264`、
  `0.049/0.185/0.238`、`0.054/0.201/0.255`

5-run中央値(range)は、変更前がcompute `0.054 (0.051–0.056)`、render
`0.198 (0.185–0.204)`、total `0.253 (0.241–0.261)`、変更後がcompute
`0.058 (0.049–0.059)`、render `0.201 (0.185–0.208)`、total
`0.255 (0.238–0.264)`。全rangeが重なり、total差+0.8%はSwiftShaderノイズ帯で回帰なしと判定する。
A/Cはsystem scheduling時の小規模CPU sort/compile時のlink sortであり、フレームGPU workを増やさない。

## 互換性 / changeset

- 変化はexact tieまたはcapacity飽和winnerだけ。event飽和の先勝ちは挿入順から論理順へ変わるため、
  それへ依存した定義は見た目が変わり得る。
- core minor: 加算helper field、数値tie-break、event正規順、light schema opt-in。
- three minor: light selection statsの`spawnOrder`加算とwinner規約変更。
- changeset: `.changeset/deterministic-tie-breaks.md`。

## 最終ゲートとbaseline hygiene

- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm esm-all`、
  `pnpm changeset status`が成功し、レビュー修正後は全32 test files / 729 testsが成功した。focused
  compiler/system/three 419 testsとplayground typecheckも再成功した。
- ゴールデンはruntime/check/perf/consoleが全7ページで成功した。equal-priority lightを持つ既存
  `golden-slash.png`と`golden-charge.png`だけは、physical slot winnerからspawnOrder winnerへの
  意図した照明変化を目視・selected tupleで照合してtransaction gate経由で更新した。slashは
  `cc1cc58dd96ae469286ed703f3c8dee34987cad374a2ef66e9bc64c679561f0e`から
  `df7d5f55f3fc5a8c1764f1f965a2b43d01bd02497c9bc0a4814c0ee44b2e9a6f`、chargeは
  `1596f027ec23b3f26361a133623fa11200d3b063e14474385c58e39d22090aad`から
  `1850f4d38494f8a31cdd87fcc87860a78e2576764b6918714df200c4483be602`へ変わった。
  transactionは両方`committed:true`でtmp/bakを残さず、再実行はgolden 7/7だった。
- m10-litは既存ページに欠けていた恒常baselineを新規追加しただけで、変更前/後の同じPNG hashを使う。
  他の20既存baselineはbyte不変。最終baselineは23枚(既存22枚のうち意図更新2枚+新規1枚)。
- baseline manifestのcanonical算出はrepository rootで次のcommandに統一する。内側の`sha256sum`行には
  path文字列も含まれるため、以前の報告値`179a27f...`は`tools/baselines`へ`cd`してbasenameをhashした
  別表現であり、ファイル内容の相違ではなかった。

  ```sh
  find tools/baselines -maxdepth 1 -type f -name '*.png' -print0 \
    | sort -z | xargs -0 sha256sum | sha256sum
  # a90da406a61016f8a751b4cc359b1e7d6c210ba2a6ccb4e7db9271b2a51d8c19  -
  ```

- レビュー修正後の`pnpm verify:gpu`はplayground 8 + showcase 6の14/14成功、62.071秒。
  showcaseはslashを含め
  6ページとも既存baselineの再記録不要だった。

## 受け入れ基準

1. [x] D-1/D-2: 9→10、99→100で採否・renderOrderが数値生成順(unit+GPU)。
2. [x] B-7: maxLights超過+同priorityでrun/spawn/capacity差を跨いでlogical birth選抜が安定。
3. [x] B-2: 2 source → 1 targetの定義挿入反転でrouting飽和winnerが不変。
4. [x] B-1/B-6: RFC 001日英へ発生条件、seed境界、capacity/headroom回避指針を同等に記載。
5. [x] 全静的ゲート、729 tests、ゴールデン7/7、14ページGPU suite、baseline transaction hygiene。
6. [x] 初回独立レビュー0B/2S/1Nの指摘を全て回帰付きで解消。
7. [x] fresh独立再レビューACCEPT(BLOCKER/SHOULD/NIT=0)を確認し、受入を裁定した。
