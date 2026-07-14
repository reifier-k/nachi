# 021: sim-cache の lineage 照合(スロット再利用誤認の排除)

- 重大度: 高(B-3)/中(B-4)
- 対象: `@nachi-vfx/core`(sim-cache)、RFC 001 §10.5、キャッシュフォーマット版数
- 状態: 起票(H2-8、実装未着手)
- 出典: H1 後続 Codex 探査 T3 B-3/B-4(task-mrklabwk-qlz4jd、2026-07-14)

## 症状(静的監査、確度=確実)

1. **B-3**: 線形補間は「隣接 cache frame 両方で alive な物理 slot」だけで同一粒子と判定する
   (`sim-cache.ts:527/1025` — spawnOrder/generation 照合なし)。フレーム間に旧粒子が死に
   同 slot へ新粒子が spawn すると無関係な属性間を補間し、teleport・長い streak・色/形状 morph
   になる。「両フレーム生存スロットのみ補間」という RFC §10.5 の v1 規定内の盲点。
2. **B-4**: loop 検証が `aliveIndices` 配列の並び順比較(`sim-cache.ts:603`)のため、
   同一 alive 集合でも compaction 順が違うだけで正しい loop bake を誤拒否する。

## 裁定(2026-07-14)

**lineage 照合を追加**。spawnOrder を cache 記録へ加え、補間・loop 判定とも lineage(論理粒子)で
照合する。RFC §10.5 改訂+キャッシュフォーマット版数上げ。

## 受け入れ基準

1. 「寿命<cache フレーム間隔」の slot 再利用 fixture で、補間フレームに teleport 補間が
   発生しない(新旧実装の差を GPU/CPU 実測で弁別)。
2. loop bake: alive 集合同一・並び順のみ異なる endpoint が受理され、実差分のある endpoint は
   引き続き拒否される。
3. 旧フォーマット cache の load は版数不一致を診断(NACHI_SIM_CACHE_*)で拒否し、
   無音の誤解釈をしない。
4. bake/replay の既存契約(記録属性=render reads+lossless alive indirection、v1 per-frame
   upload、WebGL2 診断)の非変更部分が回帰緑(m11-cache 両バックエンド)。
5. RFC §10.5 両言語改訂。

## 互換性 / リスク

- キャッシュフォーマット非互換(版数上げで明示)。spawnOrder 1ch 追加の記録サイズ増
  (u32×slot×frame)。
- 既存ベイク済みキャッシュは再 bake が必要(changeset・README 明記)。
