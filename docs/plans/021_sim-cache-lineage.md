# 021: sim-cache の lineage 照合(スロット再利用誤認の排除)

- 重大度: 高(B-3)/中(B-4)
- 対象: `@nachi-vfx/core`(sim-cache)、RFC 001 §10.5、キャッシュフォーマット版数
- 状態: 受入済み(H2-8、2026-07-15)
- 出典: H1 後続 Codex 探査 T3 B-3/B-4(task-mrklabwk-qlz4jd、2026-07-14)

## 症状(静的監査、確度=確実)

1. **B-3**: 線形補間は「隣接 cache frame 両方で alive な物理 slot」だけで同一粒子と判定する
   (`sim-cache.ts:527/1025` — spawnOrder/generation 照合なし)。フレーム間に旧粒子が死に
   同 slot へ新粒子が spawn すると無関係な属性間を補間し、teleport・長い streak・色/形状 morph
   になる。「両フレーム生存スロットのみ補間」という RFC §10.5 の v1 規定内の盲点。
2. **B-4**: loop 検証が `aliveIndices` 配列の並び順比較(`sim-cache.ts:603`)のため、
   同一 alive 集合でも compaction 順が違うだけで正しい loop bake を誤拒否する。

## 裁定(2026-07-14、2026-07-15詳細確定)

**lineage 照合を追加**。`Particles.spawnOrder` をlossless u32 lineageとしてcache記録へ加え、補間・loop
判定ともlineage(論理粒子)で照合する。RFC §10.5改訂とcache format/metadata version 2への版数上げを
同時に行う。

### 確定契約

1. v2 payloadは全emitter・全frameについて、物理slotごとのlossless u32 lineage streamを必須とする。
   `lineageOffsetBytes` / `lineageFrameStrideBytes`をmetadataに持ち、binary増分はalignment前で正確に
   `4 * capacity * frameCount` byte/emitter。lineage自体は通常のframeごとのreplay uploadへ含めず、
   `uploadBytesPerFrame`は従来のreplay schema/lifecycleだけを数える。
2. v1または`metadata.version`欠落はfield解釈より先に
   `NACHI_SIM_CACHE_VERSION_UNSUPPORTED`で拒否し、v2 runtimeでの再bakeを明示する。自動移行しない。
3. 通常schemaに`spawnOrder`がないemitterは、静的schema解決後にcache専用variantだけをcompile/materialize
   してbakeし、`releaseUnpooled()`で完全退役させる。その後、元定義を1回spawn/releaseして通常poolを
   順次warmする。通常版とvariantのGPU resourceは同時保持せず、二重peakを避ける。通常live/replayの
   schema・birth ring・upload budgetは変えない。代償はbake時の追加compile/materializeとinstance sequence
   の進行である。
4. rendererが`Particles.spawnOrder`を読む場合に限り、既存birth-index ringと`nextSpawnOrders`もcacheへ
   保存し、renderer preparation前に復元する。cache専用lineageの注入だけではこの保存を有効にしない。
5. `linear`は同じ物理slotが隣接両frameでalive、かつ両frameのlineageが一致するfloat値だけを補間する。
   同じslotを異なるlineageが再利用した場合と、同じlineageが異なるslotへ移った場合はともにnearestを
   使用する。integer属性とalive membershipもnearestのまま。
6. loop端点はaliveIndicesの順序や物理slotでなく、各端点のlineage→physical mapを作ってalive lineage
   集合と対応属性を比較する。metadataは旧alive-index一致fieldの代わりに`loop.lineageMatch`を公開する。
   集合同一ならcompaction順・physical slot差だけでは拒否せず、lineage欠落/追加、integer差、または許容値を
   超えるfloat差は従来どおり`NACHI_SIM_CACHE_LOOP_DISCONTINUITY`にする。
7. 同一frame内のmissing/duplicate alive lineageは`NACHI_SIM_CACHE_LINEAGE_DUPLICATE`、warmupを含む
   `nextSpawnOrder >= 0x80000000`は`NACHI_SIM_CACHE_LINEAGE_WRAP_RISK`としてbakeを拒否する。後者はu32
   wrap前のemitter restartと短いwindowの再bakeを要求する。warmupのCPU birth request upper boundは
   GPU lifecycle readbackの保守的なtriggerだけに用い、allocator saturation/失敗birthを考慮して単独では
   拒否しない。実GPUの`nextSpawnOrder`だけをwrap-riskの判定値とする。この保守カウンタはinternal
   WeakMapで保持し、public runtime APIへ追加しない。

## 変更前の弁別証跡(2026-07-15)

- 旧`interpolateSimulationCacheAttribute()`へ、同一physical slotが両frameでalive、旧粒子lineage 11、
  新粒子lineage 12、position `-1`→`+1`、alpha `0.5`相当を与えると`0`を返した。slot再利用にもかかわらず
  無関係な端点を補間するB-3を直接再現した。
- 旧loop比較へ同一alive集合を異なる`aliveIndices`順で与えると不一致となった。属性と論理粒子が同一でも
  compaction順だけでloopを拒否するB-4を直接再現した。

## 受け入れ基準

1. 「寿命<cache フレーム間隔」の slot 再利用 fixture で、補間フレームに teleport 補間が
   発生しない(新旧実装の差を GPU/CPU 実測で弁別)。
2. loop bake: alive 集合同一・並び順のみ異なる endpoint が受理され、実差分のある endpoint は
   引き続き拒否される。
3. 旧フォーマット cache のloadは`NACHI_SIM_CACHE_VERSION_UNSUPPORTED`で拒否し、
   無音の誤解釈をしない。
4. bake/replay の既存契約(記録属性=render reads+lossless alive indirection、v2 per-frame
   upload、WebGL2 診断)の非変更部分が回帰緑(m11-cache 両バックエンド)。
5. RFC §10.5 両言語改訂。

## 互換性 / リスク

- cache format v2は非互換。全emitterでu32×slot×frameのbinary sizeが増えるが、通常live/replay schema、
  birth ring、frame uploadには増分を持ち込まない。
- 既存ベイク済みv1 cacheは再bakeが必要(changeset・README明記)。
- bake専用variantは通常poolと共有せず完全退役させ、通常poolは元定義でwarmし直す。これにより恒常的な
  resource/pool汚染を避ける一方、bake時のcompile/materialize回数とinstance sequenceは増える。

## 恒常検証面

- `/m11-cache/`の既存WebGPU pageを拡張し、capacity 1、lifetime 0.015秒、emitter period 0.02秒、
  cache 10fps/2frameの実bakeで、両frameともphysical slot 0がaliveだがlineageが異なる再利用を作る。
  binary cacheのlineageとposition端点差を確認し、fraction 0.25のlinear sampleがnearest(left)のGPU attribute/pixelへ
  一致し、旧morph値を採用しないことを`slotReuseLineageNearest`で検証する。
- `forceFailure=lineage-alias`は2frameのlineageを故意に同一化し、この保護だけを反転させるisolated fault。
  falseになるvalidation keyは`slotReuseLineageNearest`の厳密1件とする。実bakeのidentityはfault適用前の
  `slotReuseBakedIdentity`で独立に保持し、GPU attribute/pixelの詳細は`result.slotReuse`配下のevidence
  metricsとして公開してvalidation keyを増やさない。
- `/m11-cache/?backend=webgl`は数値等価性を主張せず、既存のstructured bake/replay unsupported診断を維持。
  WebGPU/WebGLの2 entryを常設するためGPU suiteは15から17 entryとなり、H2-8で追加するfaultは1件。

## 実装・検証・受入証跡(2026-07-15)

- coreのsim-cache/system focused 197 tests: PASS。
- render `optionalReads`回帰: 通常schemaに存在するoptional `Particles.spawnOrder`はcache attributeへ選択され、
  birth-index ring / `nextSpawnOrders`も保存する。通常schemaに存在しないoptional custom attributeは非選択で、
  cache attributesは空、birth ring / next-orderも未保存。bake-only lineage注入だけではfallbackを変えない。
- `@nachi-vfx/core` typecheck: PASS。
- `@nachi-vfx/playground` typecheck: PASS。
- M11 WebGPU normal: PASS。loopは`maximumAttributeError=0` / `lineageMatch=true`。slot-reuse実bakeは
  physical slots=`[[0],[0]]`、lineage=`[0,5]`、position endpoint distance=`0.4250948952`、fraction 0.25
  replayのnearest error=`0` / changed pixels=`0`。replay simulation/indirect submissionはともに0。
- 同cache memoryはtotal=`33384`、binary=`32208`、metadata=`1176`、upload/frame=`748` byte。
- M11 WebGPU perf v2 root runはcompute warmup=`4/4`、samples=`16/16`、median=`0.114 ms`、
  p95=`0.202 ms`。pre-change M11比較値は取得していないため、overhead率は主張しない。
- `forceFailure=lineage-alias`: `slotReuseBakedIdentity=true`を維持し、falseは
  `slotReuseLineageNearest`の厳密1件。nearest error=`0.0693477`、changed pixels=`510`で弁別。
- M11 WebGL2: 5 validations PASS、simulation/indirect submissionはともに0。bake/replayのstructured
  unsupported diagnosticsを確認。GPU timer queryはadapter capability unavailableとしてperf validation PASS。
- headless M11はartifact screenshotを公開しない。tracked golden baseline 23枚はH2-8前後で不変。
- full repository tests: 32 files / 790 tests PASS。
- 17-entry GPU suite: 全PASS、total duration=`70,508 ms`。最終M11再runもWebGPU/WebGLともPASS。
  `lineage-alias` faultはexpected exit 1で、false validationは`slotReuseLineageNearest`の厳密1件。
- full repository typecheck / lint / format check / build / ESM check / diff check: すべてPASS。

- root最終再検収: 17-entry GPU suite全PASS、total duration=`68,394 ms`。golden regressionは7/7 PASS。
  tracked baseline 23枚は不変で、dev server/browserの残存なし。
- fresh読み取り専用独立レビュー: **ACCEPT**。BLOCKER / SHOULD / NIT = `0 / 0 / 0`。focused
  197/197、full 32 files / 790 tests、全workspace typecheck、lint、format、diff checkを独立再実行してPASS。
  cache v2/version-first拒否、hostile layout、lineage補間/loop map、duplicate/wrap、cache-only variantとpool、
  birth ring復元、M11 fault/WebGL診断、RFC日英、changesetを契約どおりと確認した。pre-change M11比較値の欠如は
  相対性能閾値が受入契約になく、overhead率を主張していないため受入阻害ではないと裁定した。

以上によりH2-8を受入済みとする。
