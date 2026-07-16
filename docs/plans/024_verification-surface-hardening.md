# 024: 検証基盤ハードニング(T6 全 10 件)

- 重大度: 高 4 / 中 6(一括)
- 対象: `tools/`、`.github/workflows`、`apps/playground`、`apps/showcase`(公開 API 影響なし)
- 状態: 受入済み(H2-1、2026-07-15。独立最終レビュー ACCEPT、BLOCKER/SHOULD/NIT=0。**以降の全 H2 タスクの検収面を強化するため先行**)
- 出典: H1 後続 Codex 探査 T6#1〜#10(task-mrklbn1b-b71g92、2026-07-14)

## 対象一覧

| # | 内容 | 重大度 |
|---|---|---|
| 1 | 常設 CI GPU 回帰が golden 7 のみ(36 ページ中)。Grid2D/WBOIT/VAT/texture 付き trail/NeighborGrid/showcase 6 作が常設外(`tools/golden-runner.mjs:5`) | 高 |
| 2 | 基準 PNG 欠落が `--update-screenshots` なしでも「新規作成・合格」になる=PNG 削除が CI 通過(`tools/spike-runner.mjs:244`) | 高 |
| 3 | 公開 `gridTslModule()` / `grid3DTslModule()` の正常カスタム stage に実 codegen 面がない(FakeAdapter+負例のみ、実行ページも組み込み stage のみ) | 高 |
| 4 | VAT 公開 variant(bottom-to-top / xz-y / absolute / signed / vertex-index / 外部 time node)が実 codegen 未実行 | 中 |
| 5 | showcase の `getElementState()` 全計測が evidence 止まりで合否非集約。`allPanelsHaveForeground()` の既定下限 0(=1 画素でも通る) | 高 |
| 6 | スクショ比較が変化画素数のみ・全画面一律 0.5% で、小領域要素(spark/ring/葉)の大幅縮退が合格域(golden-ambient leaves 約 323px vs 閾値 384px 等) | 中 |
| 7 | runner が console/pageerror を収集するだけで合否に入れない(import 時 warning 検出不能を含む) | 中 |
| 8 | m12-neighbors の `onBuildDiagnostic:null` が WebGPU 正常系まで抑制(WebGL2 拒否分岐に限定すべき) | 中 |
| 9 | perf snapshot / WebGPU profiler 値が JSON 存在確認のみで合否非集約(`status:'pending'` でも緑) | 中 |
| 10 | spike-compute の indirect draw 実行が headless で恒常スキップ(`drawExecuted:false` のまま ok) | 中 |

## 裁定(2026-07-14)

**全 10 件一括**。CI 時間増は段階収容(代表 mN ページ+showcase の選抜 → 拡大)で吸収し、
閾値再設計(#6)は「ページ毎の主要素画素占有に基づく下限」方式で行う。

## 受け入れ基準

1. #2 を最優先: 基準 PNG 欠落は `--update-screenshots` なしでは必ず fail。CI 後の dirty tree /
   新規生成 PNG 検査を追加。
2. #1: CI へ代表ページ群を追加(SwiftShader での実行時間を計測し選抜理由を記録)。
   showcase サーバー起動を含む。
3. #3/#4: custom grid stage・VAT variant の Three 実 codegen(WGSLNodeBuilder.build)回帰を
   H1-3 方式で常設。
4. #5: showcase 6 ページの要素状態チェックを合否へ集約(全滅・恒常 0 を赤にする最低限から)。
   `allPanelsHaveForeground` の既定下限を非 0 へ。
5. #6: 小領域要素を持つページ(golden-ambient leaves / golden-slash sparks /
   golden-character ring 等)へ領域別チェックまたは下限強化。偽実装での弁別性を確認
   (恒真化しないこと)。
6. #7: console/pageerror の合否化(意図的診断ページの opt-out 契約は維持)。
   #8: opt-out を WebGL2 拒否分岐に限定。
7. #9: perf snapshot の `status` / `complete` の最低限合否化(性能値そのものの合否化はしない=
   SwiftShader 値を性能主張にしない既存規約の維持)。
8. #10: headless での indirect draw 実行方策(1×1 readback ドレイン下の最小 draw)を検討し、
   不可能なら visual 限定であることを ok 出力に明示する。

## 互換性 / リスク

- 公開 API 影響なし(changeset 不要見込み)。CI 時間増は計測して上限を決める。
- 合否集約の追加で既存ページが赤くなる場合は「真の欠陥」か「チェック較正」かを H1-4 知見
  (公差は WGSL 仕様の演算誤差許容から導出)で切り分ける。

## 実装・受入結果(2026-07-15)

### 監査候補の確度確定

- #2 は再現: 旧基準は `.gitignore` 対象の `artifacts/` にしかなく、Git tree に PNG が 0 件だった。
  空の一時 baseline directory を指定した実 runner プローブは exit 1、`Screenshot baseline is missing`
  を返し、ディレクトリ内にファイルを生成しなかった。基準 21 枚を `tools/baselines/` へ移して
  Git 管理対象にした。ring-only 対照の追加後は 22 枚である。
- #5/#8/#9/#10 は一次コードと実測で再現した。showcase の state は全て evidence のみ、
  `m12-neighbors` は両 backend で `onBuildDiagnostic:null`、単発 timestamp resolve ページは
  sample window が未完了、旧 `spike-compute` headless は `drawExecuted:false` のまま合格していた。
- 既存 showcase slash の companion clock 検証に別の較正欠陥を発見した。fixed-step と hit-stop
  ラッチで 15 ms の観測窓を 1 tick しか踏まず `maximumError=0` でも samples=2/4 となる恒常 false
  negative だった。観測を隣接 2 tick に限定した 35 ms へ変更し、samples=4 / maximumError=0 を
  再実測した(時計一致の閾値自体は変更なし)。

### 10 件の解消根拠

1. `tools/verification-runner.mjs` と CI `verification-surface` job を追加。代表 5 面は
   Grid2D=`m12-grid`、WBOIT=`m10-sort`、全 VAT runtime=`m8-vat`、texture 付き trail=
   `m7-ribbons`、NeighborGrid=`m12-neighbors`。showcase は 6/6 を収容した。通常 run 合計
   56.351 s (各 1.0–11.1 s) のため 40 分 job 上限内に十分収まる。両 dev server の起動、trap、
   suite、baseline dirty/untracked 検査は同じ CI step 内に置いた。
2. `spike-runner` は `tools/baselines/` を読み、欠落時は明示 `--update-screenshots` 以外で必ず
   fail。更新は全 screenshot を staging した後、result / screenshot ROI / perf / diagnostic の全契約が
   通った場合だけ一括 commit する transaction とした。2 baseline を持つ `golden-character` の実 runner
   query で result-only / perf-only / diagnostic-only の各単独失敗を作り、いずれも2件とも
   `committed:false`、既存 SHA-256 不変、`.tmp` / `.bak` 残骸なしを確認した。成功時は2件とも
   `committed:true`、artifact 出力=`artifacts/`、baseline=`tools/baselines/` を確認した。CI は実行前後に
   tracked/dirty/untracked を検査する。
3. Grid2D/3D それぞれ inline/registered custom stage の read+sample+write を
   `Grid2DRuntime/Grid3DRuntime.preparePipelines()` から全 kernel へ実体化し、Three r185
   `WGSLNodeBuilder.build()` を通す回帰を常設。2D は `0.375/6.125`、3D は `0.625/-2.75` の
   factory 固有演算、state read、scratch write、delta-time uniform 乗算を stage WGSL で検査し、
   inline/registered の shader 配列が完全一致することも確認する。stage 丸ごとの no-op では通らない。
4. bottom-to-top / xz-y / absolute / signed normal / vertex-index / external time node の 6 VAT
   variant を実 Mesh の vertex WGSL へ build。normal branch は color varying にも接続して dead-code
   elimination を防止した。default+6 の全 7 shader が distinct、各 variant が default と非一致、
   かつ row 反転、0.25 外部時計、signed decode、vertexIndex、負 Y swizzle、absolute 代入の
   branch 固有 WGSL を個別検査する。
5. `allTimelineElementsHaveActivity()` を showcase 6 ページへ接続。全 capture の全 key 存在に加え、
   数値 `aliveCount` を公開する emitter は生存数 >0 だけを活性根拠とし、全 capture で 0 なら
   `playing/visible/localTime` で救済しない。`aliveCount` を持たない mesh/post だけ代替語彙を使う。
   flags/time が活動中でも aliveCount 恒常 0 の unit 負例、all-zero fake、missing-key を常設し、
   definition 由来の全114 key (slash/heal/ice/beam/machina/barrier=`9/11/33/8/40/13`)を漏れなく
   追跡して showcase 6/6 を再実測した。panel 既定下限は 0 から 0.0005 へ変更した。
6. screenshot spec に normalized ROI、絶対 foreground pixel 下限、ROI 内変化率上限を追加。
   leaves=323 px(下限 200)、slash impact ROI=13,101 px(下限30、加えてページ内 isolated sparks
   >20)を実測。character は body/aura/orbit を除いた専用 320x320 ring canvas へ分離し、同一 draw の
   visible/hidden readback 差分=271 px、専用 PNG ROI=271 px(下限120)を記録した。`?ring=hidden` の
   baseline update 負例は ROI=0 で更新を拒否し、既存 baseline hash も不変だった。baseline/current
   が共に空で差分 0 の一般 fake も絶対下限で fail する負例を常設した。
7. browser warning/error/pageerror を runner 合否へ追加。opt-out はページ dataset の
   `{type,text}` を 1 診断につき 1 回だけ substring 照合し、型違い・余剰・未出現 expectation を
   全て fail する限定契約とした。debug/info は対象外。`spike-compute` の WebGL2 indirect-dispatch
   fallback が発する既知 warning だけを、WebGL2 分岐で同契約へ明示登録した。
8. `m12-neighbors` から `onBuildDiagnostic:null` を撤去し、WebGPU correctness/perf は default
   diagnostic delivery を維持した。WebGL2 は billboard/lifecycle の packed-storage 制限を踏まない
   zero-count・compute-only の専用最小 fixture を correctness/perf に各1回使い、既知
   `NACHI_NEIGHBOR_GRID_WEBGL2_UNSUPPORTED` 2件だけを runner の one-shot expectation で消費する。
   実測では WebGPU の余剰診断0、WebGL2の expected error 2 / unexpected 0 で、packed-storage 等の
   別診断が混ざらないことを確認した。
9. perf schema v2 に `requestedScopes` と構造化 `unavailableCause` を明示。runner は top-level
   pending/error、requested scope の unavailable/incomplete、warmup/total incomplete を fail。
   unavailable は active backend と一致する `adapter-capability` の timestamp-query 欠如だけを許可し、
   `trackTimestamp:false` 等の `renderer-configuration`、cause 欠落/不一致を fail する。top-level
   unavailable で sample 検査を省略する場合も cause は必須。warmup は object の存在、有限な非負整数、
   safe integer、completed===target を検査し、sample/target も文字列・NaN・Infinity・負数を拒否する。
   代表 5+showcase 6+golden 7 は全て requested window 16/16 complete、WebGL2 probe は
   `EXT_disjoint_timer_query_webgl2` adapter cause で PASS を再実測した。
10. `spike-compute` headless は GPU 生成 `drawIndexedIndirect` 引数を実 offscreen draw に消費し、
    同一 geometry/mesh/1x1 target で GPU 書込 args `[6,0,0,0,0]`→black `[0,0,0,0]` と、GPU
    atomic count 由来 `[6,7437,0,0,0]`→foreground `[255,255,255,255]` の因果対照を実行する。
    zero でも描く `geometry.setIndirect` 欠落/CPU direct path と malformed args の unit 負例も常設。
    WebGPU は `indirectCausal:true`、WebGL2 は CPU count fallback の zero/nonzero 対照を通しつつ
    `indirectCausal:false` / capability unsupported と明示する。

### 最終ゲート

CIの常設GPU jobにはrepository variable `NACHI_SKIP_GPU_VERIFICATION=1`の管理用escapeがあり、その場合
`verification-surface` job自体がskipされる。これは環境上の一時退避であってPASS証拠ではなく、変数未設定の
既定経路で19面を完走することが通常の受入条件である。

- `pnpm build`: PASS。
- `pnpm typecheck`: PASS。
- `pnpm lint`: PASS。
- `pnpm format:check`: PASS。
- `pnpm test`: 31 files / 692 tests PASS。
- `pnpm golden:regress`: 7/7 PASS、ROI を含む baseline 一致。
- `pnpm verify:gpu`: 11/11 PASS、合計 56.351 s。showcase 6/6 `ok:true`、definition 由来全114 keyを追跡。
- `spike-compute/?count=10000&frames=8`: WebGPU indirect 因果対照、WebGL2 fallback、readback、
  perf cause、diagnostic 全 PASS。
- 空 baseline directory の実 runner probe: exit 1、`Screenshot baseline is missing`、新規生成0件。
- screenshot update transaction の result/perf/diagnostic 各単独失敗と正常成功を実 runner で確認。
- 独立最終レビューは静的全ゲート、重点66テスト、golden 7/7、GPU suite 11/11(56.112 s)、
  欠落 baseline/transaction/診断/perf/indirect の各負例を再実行し ACCEPT。指摘0件。
- 公開 package API/挙動への変更なし。`apps/` と `tools/` の検証契約だけのため changeset 不要。
