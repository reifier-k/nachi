# 012: 連続スポーンの省略時 duration 導出(rate/perDistance の無限継続)

- 重大度: 高(無音の失敗。一粒も出ずに完了する)
- 対象: `@nachi-vfx/core`(spawn 包絡導出・エミッタライフサイクル)、RFC 001
- 状態: 起票(H2-2、実装未着手)
- 出典: H1 後続 Codex 探査 T1#1(task-mrkl9puw-hbbgor、2026-07-14)

## 症状(静的監査、確度=確実)

`rate()` / `perDistance()` エミッタで `lifecycle.duration` を省略すると一粒も生成されず完了する。
H1-1(plan 007)の省略時 duration 導出は multi-cycle burst 包絡のみを考慮し
(`packages/core/src/system.ts:805` — `if (burstEnvelope === 0) return 0;`)、連続スポーンでは
導出値 0 になる。duration 0 では active update が発生せず、activation 時 spawn は burst 専用
(`system.ts:1599`)。plan 007 と同根(省略時 lifecycle の縮退既定)の別経路。

## 裁定(2026-07-14)

**無限 duration 導出を採用**。rate/perDistance を含むエミッタは省略時に無限継続
(`stop()` / timeline 終了で止まる)。Niagara の loop 既定に整合。burst 包絡導出(H1-1)と共存
(burst のみ=包絡導出、連続スポーンあり=無限)。明示 duration は常に優先
(H1-1 と同じ `lifecycle?.duration === undefined` 導出キー規約)。

## 受け入れ基準

1. `rate()` のみ+lifecycle 省略のエミッタが継続的にスポーンし、`stop()` と timeline 管理で
   正しく終了する。
2. burst 専用エミッタの H1-1 導出が不変(m3-sprites burstCycleDeathOverlap 回帰緑)。
3. 明示 duration 指定時の挙動が全経路(直接 / 部分 lifecycle オブジェクト / format)で不変。
4. RFC 001 両言語の導出規約へ「連続スポーン=無限」を追記。
5. GPU 回帰: rate+省略 lifecycle の実スポーン数チェックを m2/m3 系ページへ常設。

## 互換性 / リスク

- 従来「即完了」だった定義が継続動作になる=挙動変化(core minor)。ただし従来挙動はほぼ確実に
  バグ踏み(一粒も出ない)なので実質的な救済。
- 無限継続が scalability / significance の完了判定・カリング復帰と干渉しないことを確認する。
