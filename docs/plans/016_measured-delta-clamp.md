# 016: 測定 dt の既定クランプ

- 重大度: 高
- 対象: `@nachi-vfx/core`(update 時間源)、RFC 001
- 状態: 起票(H2-11、実装未着手)
- 出典: H1 後続 Codex 探査 T4#4(task-mrklb7a0-200ucr、2026-07-14)

## 症状(静的監査、確度=確実)

delta 省略の `update()` は `#measuredDelta()` の経過 wall time を無上限で 1 回の variable step へ
供給する(`system.ts:3103/3637`、上限・timestamp 再初期化経路なし)。タブ非表示・RAF 停止・
アプリ側 pause からの復帰時に巨大 dt が積分へ直行し、粒子位置の大ジャンプ・寿命/timeline/mesh-fx の
即時完了・rate 蓄積の急増・grid simulation の不安定化が起こり得る。

## 裁定(2026-07-14)

**既定クランプを導入**。測定 dt に既定上限(例 0.25s)を設け、設定で変更 / 無効化可能にする。
明示 delta は不変(catch-up 用途は明示経路で維持)。

## 受け入れ基準

1. 測定 dt が上限を超えるフレームでクランプされ、破棄秒数が観測値として計上される
   (fixedTimeStep の `droppedSeconds` 既存規約と整合する報告面)。
2. 明示 delta 渡し・fixedTimeStep 併用時の挙動が不変。
3. 上限の設定変更・無効化(Infinity)が機能する。
4. RFC 001 へ時間源の規約(既定値含む)を明記。
5. ゴールデン・ショーケース(全て明示 delta 駆動)に影響しないことを回帰で確認。

## 互換性 / リスク

- 既定挙動の変更(core minor)。復帰時 catch-up に依存していたアプリは設定で戻せる。
- plan 026 の T4#5(fixed-step の空間 backlog)と関連するが、本プランは測定 dt の入口のみを扱う。
