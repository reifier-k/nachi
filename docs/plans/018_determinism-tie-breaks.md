# 018: 決定性の残余バッチ(tie-break 数値化・論理順固定・既知制限明文化)

- 重大度: 高
- 対象: `@nachi/core`、`@nachi/three`、RFC 001
- 状態: 起票(H2-4、実装未着手)
- 出典: H1 後続 Codex 探査 T3 D-1/D-2/B-2/B-7(修正)+B-1/B-6(文書化)(task-mrklabwk-qlz4jd、2026-07-14)

## 症状(静的監査、確度=確実)

1. **D-1/D-2**: significance 予算と同深度 alpha emitter の coarse 描画順の tie-break が
   `nachi-effect-${++seq}` の **10 進文字列辞書順**(`system.ts:2808/253` —
   `nachi-effect-10 < nachi-effect-9`)。再生回数が桁境界をまたぐと同点時の採否
   (culled/spawn-suppressed)・source-over 順が反転する。
2. **B-7**: light top-N 選抜の同点決着が物理 slot 昇順(`compiler.ts:2441`、CPU 側も
   `physicalIndex` で tie-break)。slot 再割当で別の論理粒子が PointLight 化され照明が切り替わる。
3. **B-2**: 複数 source → 同一 target の event routing が `elements` 列挙順で逐次処理され、
   子 spawnOrder 帯と飽和時の drop 優先が定義オブジェクトの挿入順依存(`system.ts:3294/3433`)。
4. **B-1/B-6(文書化対象)**: event キューの atomic 追加順 → 子 spawnOrder 昇格、
   neighbor bucket 内の挿入順・overflow 勝者は GPU 並列 atomic の本質的制約。

## 裁定(2026-07-14)

**可能な箇所のみ決定化**。D-1/D-2 は数値シーケンス比較へ、B-7 は spawnOrder 等の論理キーへ、
B-2 は emitter key の辞書順等の論理順へ固定。B-1/B-6 は RFC へ既知制限として明文化
(修正対象ではなく GPU 原子操作の性質と規定)。

## 受け入れ基準

1. D-1/D-2: 同点 fixture で桁境界(9→10、99→100)を跨いでも採否・renderOrder が不変(unit+GPU)。
2. B-7: maxLights 超過+同点 priority リグでライト選抜がラン間・spawn 回数間で安定(m10-lit 拡張)。
3. B-2: 2 source → 1 target の fixture で routing 順が定義再構築(spread 等)に対して不変。
4. B-1/B-6: RFC 001 へ既知制限節を追加(発生条件と回避指針=シード分離・cellCapacity 余裕)。
5. 全ゴールデン・ショーケース回帰で非意図差分ゼロ(同点時のみの変化であることを構造比較で確認)。

## 互換性 / リスク

- 変化は全て同点時のみ(core patch〜minor)。B-2 の順序固定は「先勝ち」の意味を挿入順から
  論理順へ変えるため、event 飽和に依存した定義があれば見た目が変わり得る(changeset 明記)。
