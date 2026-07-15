# 025: showcase 追従修正(post 中心の再投影・ice jitter 正規化)

- 重大度: 中(F-02)/低(F-06)
- 対象: `apps/showcase`(6 ページ)
- 状態: 受入済み(H2-14、fresh 独立最終レビュー ACCEPT、BLOCKER/SHOULD/NIT=0)
- 出典: H1 後続 Codex 探査 T5 F-02/F-06(task-mrklav03-g4d8is、2026-07-14)

## 症状(静的監査、確度=確実)

1. **F-02**: 6 ページ全てで shockwave 等の post 中心を初期カメラで一度だけ world→screen UV 化
   している(`beam.ts:1019` ほか、slash/barrier/machina/heal/ice に同型)。ライブ閲覧で
   orbit/pan/zoom/FOV 操作や camera shake 中に、画面エフェクトが world 上の着弾点から分離する。
2. **F-06**: ice の custom Init が `positionSphere` の生成した **world position** を `jitter` と
   称して再解釈し、別の world position で上書きしている(`ice.ts:496/667`)。現行は原点 spawn の
   ため潜在だが、ページを雛形として流用・offset/rotation 追加すると移動量が軸ごとに混入する。

## 裁定(2026-07-14)

**採用**。post 中心の毎フレーム再投影化(6 ページ)と ice jitter の正規化(ローカル乱数由来へ)。

## 修正前の再現証跡(2026-07-16)

- 6 ページの初期 camera から position を `[1.1, 0.45, -0.75]` 移し、注視点を
  `[0.3, -0.15, 0.2]` 移動、FOV を `+12°`、aspect を `1.32` にした静的 Three probe で、凍結された
  post center と同じ world target の現 camera 投影との UV 距離は beam=`0.06580/0.02536`、
  slash=`0.05520`、barrier=`0.03493`、machina=`0.07173/0.04801`、heal=`0.10266`、
  ice=`0.05716` だった。各 page の `step()` はこの後に shake/orbit/pan camera を確定する一方で
  `setShockwave()` を一度も呼ばず、初期 tuple だけが残る因果も確認した。
- さらに beam 以外の5ページは `lookAt()` 後、最初の `project()` 前に matrix world を更新していなかった。
  旧 stale tuple と初回 frame の正しい current tuple の距離は slash=`0.21008`、barrier=`0.53402`、
  machina=`0.22090/0.21500`、heal=`0.12075`、ice=`0.35868`。beam は明示更新済みで、差は timeline
  shake 中の再投影だけだった。このため「固定 camera なら既存 baseline と実質 0」という起票時の想定は、
  5ページの初期 matrix stale という一次コード/数値で反証された。
- ice の `seed=0x1ce0`、144 spawn を offset=`[2.4,-0.35,1.7]`、Y rotation=`0.73rad` で
  CPU mirror した。compiler-generated defaults が normalized Init stage index 0 を占めるため、旧
  `positionSphere` と新 authored jitter はいずれも authored slot 0 / normalized stage index 1 である。
  この実 slot で再計算すると、旧実装の world jitter 再解釈結果を local へ戻した mean は
  `[0.00064,-0.04822,0.01084]` から `[-0.52315,0.01960,-2.28299]`、Z bounds は
  `[-1.12151,1.16771]` から `[-3.51182,-1.16373]`、量子化 hash は `7fbb5a40` から
  `14816497` へ変化した。emitter offset/rotation が jitter と最終位置の双方へ混入する弁別結果である。

## 実装設計

- `apps/showcase/src/post-target.ts` を showcase-local 共通化点とし、全 shockwave の authoritative
  world target と immutable author source を保持する。各 page は camera shake を含む最終 camera matrix と
  system camera state を確定した直後、render より前に全 slot を再投影して `setShockwave()` する。resize/FOV
  は current projection matrix をそのまま使う。clip depth は NDC z convention に依存させず、PerspectiveCamera
  の camera-space depth と near/far で幾何判定する。behind-camera、clip 外、offscreen はその frame だけ
  `enabled=0`、再入画時は author の `enabled` へ戻す。author disabled と start/duration/time lifecycle は
  上書きしない。hot update は binding ごとの mutable center tuple / payload / cache を事前確保し、index loopで
  同一 object を再利用するため、camera 移動 frame に tuple・payload・entries pairを生成しない。
- ice はinverseを完全撤去した。compiler defaults=normalized index 0 の後、authored slot 0 / normalized index 1
  の custom Init がpositionSphereと同じPCG sample offset `1/2/4`からlocal sphere jitterをowned custom vec3へ
  書く。authored slot 1 / normalized index 2のplacementがpillar local位置を作りspawn transformを一度だけ
  合成し、authored lifetime slot 2 / normalized index 3を維持する。従ってsingular/zero scaleでもinverse由来の
  NaNを作らず、seed/spawnOrder/random streamと見た目を保つ。
- `post-target-integration.test.ts` はTypeScript ASTで6ページの`step`を個別に解析し、refreshがstep内に唯一、
  全camera mutation/`setCamera`より後、render/returnより前であることを保証する。before-shake、step外、
  render後へのfault移動は対象page caseだけ失敗する。projectionはWebGL/WebGPU座標系、normal/reversed depth、
  near/far境界、behind/offscreen/re-entryを常設し、hot payload identityも検査する。iceはproduction registryを
  Three WGSLNodeBuilderでcodegenしてmodule access/slot/hash/no-inverseをpinし、実GPU storage readbackも行う。

## 検証記録

- focused は4 files/20 tests PASS。post projection、6 page AST integration、ice local placement、既存
  companion を再実行し、camera perturbation後のcenterは current Three projectionと完全一致、fixed
  matrixはsetter 0回だった。
- F-06 corrected CPU probeはlocal hash=`7fbb5a40`、旧world再解釈hash=`14816497`で、上記mean/boundsを
  5桁で常設pinした。新実装はspawn transformを一度だけ合成し、zero scaleでも全positionがfiniteでoffsetへ
  collapseする。同じpost trackingで旧/newを直接pixel比較すると25 px/520,676=`0.0000480`
  (0.0048%)だけが変化し、bbox=`[560,228]-[761,430]`、6 panel counts=`[0,0,0,0,25,0]` と
  sparkle可視ROIだけ、panelStatsは全一致だった。
- production登録から生成したThree Init WGSLはhash=
  `5c6dd287cddcc41513ece6899b5b8ea1768068180bc24b5055259541fa40f554`でinverseを含まない。専用8粒子を
  offset=`[2.4,-0.35,1.7]`、Y rotation=`0.73rad`、spawn seed=`0x1ce0`で実GPU実行したreadbackは
  alive=`8/8`、finite、effective emitter seed=`3740247748`、max CPU error=`0.00017848`、centimeter量子化
  actual/expected hash=`299470c7`でPASSした。旧path faultはactual=`507bea87`対expected=`299470c7`、
  max error=`2.63402720`で`localJitterNormalized`だけを実測FAILにし、flag由来の判定ではない。
- post追従を止める `?freezePostProjection=1` faultは各ページを単独実行して screenshotだけを失敗させ、
  changed ratioは slash=`0.35533`、heal=`0.14440`、ice=`0.06012`、beam=`0.15437`、
  machina=`0.24924`、barrier=`0.21748`。各runのactivity/console/perfは全PASSで、6ページそれぞれの
  frame refreshに弁別的である。ice旧world jitterは `?forceFailure=ice-world-jitter` でdefault実装と分離した。
- 起票時baseline 23枚をhash棚卸し後、上記stale center補正とshake追従を意図変更としてshowcase 6枚だけ
  transaction更新した。枚数は23のまま、変更はbeam/slash/barrier/machina/heal/iceのexactly 6。
  直後runは6/6 PASS、changed ratioは各`0.00002`〜`0.00020`、console/perfも全PASS。baseline配下に
  tmp/bak/actual/diffなし。独立golden 7/7もPASSした。
- full testsは36 files/998 tests、typecheck 12 projects、lint 277 files、format 236 files、build、ESM 9
  packages、changeset status、diff checkが全PASS。canonical GPUはplayground 13 + showcase 6 = 19/19
  PASS、合計`71.675s`。serverを停止し、`artifacts/`、tmp/bak/actual/diffを削除、port 5173/5174の
  listenerなしを確認した。

## 受け入れ基準

1. 固定カメラの headless 基準に差分が出ない(≤0.5%、実質 0 想定=基準再記録不要)。実測では旧初期
   matrix staleにより想定を満たせなかったため、上記因果/ROIを確認して6枚を意図的に再記録した。
2. カメラを動かす手動確認で shockwave 中心が着弾点へ追従(ユーザー補助検証リストへ記載)。
3. ice は offset/rotation を与えた再 spawn でも分布形状が保存される(プローブまたは目視)。
4. 6 ページ spike ok:true+console 清浄維持。

## 互換性 / リスク

- ページローカル修正のみ。ライブラリ API 影響なし(changeset 不要)。
- 変更は private app と test/docs のみで、公開 package の changeset は追加しない。

## 独立最終レビュー(2026-07-16)

- fresh reviewer は全差分を再監査し、**ACCEPT / BLOCKER=0 / SHOULD=0 / NIT=0** と判定した。
  初回レビューの4 SHOULD(NDC depth規約、step順序検証、production kernel/GPU接続、singular inverse)と
  1 NIT(hot path allocation)は全て CLOSED。focused 4 files/20 tests、full 36 files/998 tests、
  typecheck/lint/format/build/ESM/changeset/diff checkを再実行して全PASSした。
- reviewer sandboxではdev server bindが`EPERM`だったため、GPU/goldenは直前に同一ワークツリーで得た
  canonical GPU 19/19・golden 7/7を採用した。baseline 23枚・変更exactly 6・一時生成物/残留listenerなしは
  reviewerも独立確認した。
