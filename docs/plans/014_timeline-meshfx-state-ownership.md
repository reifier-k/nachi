# 014: timeline mesh-fx 状態所有権の完結(clone スナップショット / userVisible / geometry 共有)

- 重大度: 高(C-1)/中(A-3、C-2)
- 対象: `@nachi-vfx/timeline`、`@nachi-vfx/mesh-fx`、RFC 001
- 状態: 起票(H2-9、実装未着手)
- 出典: H1 後続 Codex 探査 T2 C-1 / A-3 / C-2(task-mrkla9gn-byrcd0、2026-07-14)

## 症状(静的監査)

1. **C-1(確実)**: timeline `fxMaterial()` の clone が source material を copy せず作成時 config
   から再生成する(`timeline/runtime.ts:258` → `authoring.ts:293` の `materialConfigs.get(material)`)。
   `setOpacity()` 済みの現在値、`side` / `depthTest` / `colorWrite` 等の Three material 設定、
   `name` / `userData` が spawn clone へ引き継がれない。plan 009 で導入した公式 setter の値が
   黙って巻き戻る。DoubleSide 等の欠落では視点によりメッシュが消え得る。
2. **A-3(確実)**: timeline mesh-fx clone の `visible` は play / stop / 自然終了が直接書き換える
   (`runtime.ts:687/812/849`)。plan 004 の `runtimeVisible∧userVisible` 合成に相当する状態が
   timeline mesh には存在しない。
3. **C-2(要検証)**: `resource.mesh.clone()` は Three r185 の `Mesh.copy()` により geometry を
   生参照共有する。clone / source 側の attribute・drawRange 変更が全インスタンスへ波及する。

## 裁定(2026-07-14)

**スナップショット+合成を採用(全部)**。clone は source material の現在状態
(uniform 値・render state)を引き継ぐ形へ変更し、timeline mesh にも userVisible 合成を導入。
geometry 共有は「不変借用リソース」として RFC 明文化(コピーはしない)。
plan 001 / 004 / 009 の完結編。

## 受け入れ基準

1. `fxMaterial({opacity:0.8})`+`setOpacity(0.2)` 後の spawn clone が 0.2 で始まる。
   side / depthTest 等の変更も引き継がれる(プローブ)。clone 独立性(A→B 非漏洩、
   H1-6 の 12 プローブ)は維持。
2. opacityOverLife との排他(NACHI_MESH_FX_OPACITY_BINDING_CONFLICT)等の既存規約が不変。
3. timeline mesh に `setUserVisible()` 相当を導入し、play / loop / 自然終了を跨いで user 設定が
   保存される(draw registry 側 plan 004 と同じ合成規約)。
4. geometry 共有の所有権規約(不変借用・dispose 責務)を RFC 001 と mesh-fx README に明記。
5. showcase 6 ページ+m9 系の回帰緑(スナップショット化の数値互換は H1-6 方式で実証)。

## 互換性 / リスク

- 「spawn 前に source を触ると反映される」への変化は事実上のバグ修正だが、作成時 config 固定に
  依存した使い方があると挙動変化(timeline minor、changeset 明記)。
