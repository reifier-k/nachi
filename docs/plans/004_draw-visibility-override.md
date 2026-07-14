# 004: ドロー可視性のユーザーオーバーライド API

- 重大度: 中(デバッグ体験 / 演出制御)
- 対象: `@nachi/three` / `@nachi/trails/three`(draw registry)、`@nachi/core`(可視性管理)
- 状態: H1-8で実装済み(2026-07-14)

## 症状

`materializeThreeSpriteDraw()` 等が返す Three オブジェクトの `visible` を
ページ側で `false` にしても、**ランタイムのドローレジストリが毎フレーム可視性を管理しており
上書きが効かない**(`THREE_VISIBILITY` 経由。M11 の significance culling と連動)。

wuwa-slash 実測: 要素の視覚的切り分け(「この光はリボンか火花か」)のために
`draw.visible = false` を設定したが描画結果が 1 ピクセルも変わらず、切り分け診断が
誤った結論(リボン無罪)を導き、その後の調査を大きく迂回させた。

## 根本原因

可視性がランタイム所有(effect state / culling 由来)で、ユーザー意図と合成されない。
「ランタイム可視 AND ユーザー可視」という合成則が存在しない。

## 改善案

1. draw 登録情報に `userVisible: boolean`(既定 true)を追加し、最終可視性を
   `runtimeVisible && userVisible` で決定する。
2. 公開 API: 各 materialize 結果に `setUserVisible(visible: boolean)` を生やす
   (sprite/mesh/ribbon/decal は返り値オブジェクト、light draw は `group` 直接操作で十分なため
   対象外でよいか実装時に確認)。
3. `instance.debug` 系(M11)に「要素キー単位の一時非表示」ヘルパーを追加するかは任意
   (attribute capture と並ぶ切り分け手段として有用)。

## 受け入れ基準

1. `draw.setUserVisible(false)` 後、system.update / culling 状態に関わらず該当ドローが
   描画されない。`true` に戻すとランタイム可視性に従う。
2. significance culling・エフェクト complete 時の自動非表示など既存の可視性遷移が不変。
3. 既存ページに変更不要(既定 true)。

## 互換性 / リスク

- 追加 API のみで後方互換。リスクは低い。
- 「Three の `visible` を直接触っても効かない」非直感性自体は残るため、materialize 系 API の
  ドキュメントに合成則を明記する。

## H1-8 実装

- draw登録は `userVisible` を既定 `true` で保持し、Threeオブジェクトへ常に
  `runtimeVisible && userVisible` を反映する。
- sprite、mesh、decal、ribbonに加え、light poolも `setUserVisible()` を公開する。lightの `group.visible`
  直接操作もruntime遷移で上書きされるため、対象外にはしなかった。個々のPointLightはshader variantを
  安定させる既存契約どおりvisibleを維持し、合成可視性はpool groupへ適用する。
- `m11-scale` がuser非表示、runtime fade/cull、user復帰、runtime復帰の全遷移を弁別する。
