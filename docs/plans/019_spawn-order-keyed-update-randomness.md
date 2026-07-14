# 019: update 段乱数の spawnOrder キー化(H1-10 続編)

- 重大度: 高
- 対象: `@nachi-vfx/core`(乱数導出)、RFC 001
- 状態: 起票(H2-3、実装未着手)
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
5. 見た目の具体値変化は意図変化として基準再記録+目視合格(H1-10 と同じ弁別規約:
   「見た目の変化」と「見た目の退行」を構造比較で区別してから再記録)。

## 互換性 / リスク

- 乱数列の変化=事実上の見た目変更(core minor、基準再記録)。H1-10 で 12 ページ再記録の前例。
- update 乱数は毎フレーム評価のためハッシュ入力追加の GPU コスト増を perf v2 median で比較する。
