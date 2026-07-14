# 013: NeighborGrid の emitter 空間追従と範囲外診断

- 重大度: 高(移動エフェクトで近傍系が無音全滅)
- 対象: `@nachi/core`(defineNeighborGrid / 近傍走査カーネル)、RFC 001 §10.7 / 004
- 状態: 起票(H2-5、実装未着手)
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
