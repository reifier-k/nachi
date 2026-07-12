# 007: burst 多サイクルのスポーン/描画バグ群

- 重大度: 高(実バグ。最小再現あり)
- 対象: `@nachi/core`(spawn サイクル制御、lifecycle、compaction)
- 状態: 提案(要調査 → 修正)
- 出典: showcase-heal / showcase-beam 制作エージェントの独立報告

## 症状

### (a) `lifecycle.duration` 未指定だと多サイクル burst が 1 サイクルに縮退する

`burst({ count, cycles: 4, interval: 0.1 })` を lifecycle 無しの emitter に置くと、
既定 lifecycle(duration 0)の `EmitterLifecycleController` が即座にループ完了扱いとなり、
**cycle 0 しか発火しない**。診断なし。スポーン包絡を覆う `lifecycle: { duration }` を
明示すると全サイクル発火する。

- 再現: showcase-heal の「泉」エミッタ。単発の噴出にしかならず、原因特定に時間を要した。
- 注: wuwa-slash の `embers`(burst cycles:4、lifecycle 無し)も同じ潜在問題を抱えている。

### (b) 後続サイクルのスポーン中に先行粒子が死ぬと、全く描画されなくなる

最小再現(showcase-beam エージェントによる):

```ts
// 何も描画されない
burst({ count: 40, cycles: 5, interval: 0.12 }) + lifetime(range(0.3, 0.45)) + 素の billboard

// どちらかにすると描画される
lifetime(0.7)                       // 死亡とスポーンが重ならない
rate(...) + lifecycle.duration      // burst をやめる
```

死亡(compaction)と後続サイクルのスポーンが重なる場合にのみ発生する。
free-list / compaction とサイクル再発火の相互作用のバグと推定される。

## 改善案

1. まず (b) の最小再現を `packages/core` の GPU テスト(m5/m2 系スパイクまたは新規スパイク)に
   固定化し、free-list 消費とサイクル発火カーソルの整合を調査・修正する。
2. (a) は仕様の明確化を先に行う:
   - 案 A(推奨): lifecycle 未指定時の既定 duration を「スポーンモジュールの包絡
     (cycles×interval + 猶予)」から導出する。
   - 案 B: 現仕様を維持し、`cycles > 1` かつ duration がスポーン包絡未満のとき
     `NACHI_SPAWN_ENVELOPE_TRUNCATED` 警告診断を出す(002 の可視化経路に載せる)。
3. 修正後、wuwa-slash の `embers` を lifecycle 明示なしに戻して回帰確認に使う。

## 受け入れ基準

1. (b) の最小再現が修正後に描画され、alive カウントがサイクル論理値と一致する。
2. (a) について、案 A なら全サイクルが既定で発火、案 B なら警告診断が出る。
3. 既存 golden / mN スパイク全緑。単発 burst・rate の決定性不変。

## 関連する小さな一貫性問題

timeline の `getElementState()` は、emitter 要素は完了後に `localTime` が 0 にリセットされ、
mesh 要素は最終値を保持する(showcase-heal 報告)。デバッグ時の混乱要因なので、
本件修正時にどちらかへ統一する。
