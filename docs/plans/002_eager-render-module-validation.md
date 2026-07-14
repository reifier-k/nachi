# 002: レンダーモジュールの早期検証と「無音の error state」の可視化

- 重大度: 高(silent failure / 作者体験)
- 対象: `@nachi-vfx/trails`(および各モジュールファクトリ全般)、`@nachi-vfx/core` の spawn 経路
- 状態: 実装済み・受入済み(2026-07-14、受入コミット `85f4948`)

## 症状

`ribbon({ taper: { start: 0.3, end: 0.85 } })`(start+end > 1)のような不正なオプションを渡すと、
**エフェクトは spawn に成功したように見えるが、エミッタは黙って error state になり、リボンが
一切描画されない**。コンソール出力なし。診断 `NACHI_RIBBON_TAPER_INVALID` は
`instance.diagnostics` に積まれるだけで、作者が明示的に読まない限り見えない。

wuwa-slash 制作時の実測: トレイルが消えた原因を、リボン計測タイミング・可視性・スポーン方式など
複数の仮説を潰した後にようやく taper 検証に辿り着いた(`packages/trails/src/index.ts` の
`taper.start + taper.end > 1` 検証)。

## 根本原因

2 段階の問題が重なっている:

1. **検証がコンパイル時のみ**: `ribbon()` ファクトリはオプションをそのまま保持し、検証は
   `describe`/compile 段(spawn 時)まで遅延される。作者の呼び出しスタックと検証失敗の
   タイミングが乖離する。
2. **spawn 時のビルド診断がデフォルト無音**: `system.spawn()` は error state のインスタンスを
   返すだけで、severity=error の診断を console 等へ昇格させる既定経路がない。

## 改善案

二本立てで対応する:

### (a) ファクトリでの早期検証

各モジュールファクトリ(`ribbon` / `billboard` / `velocityCone` / …)のうち、
**エンジン状態に依存せず判定できる静的制約**(taper 合計、負値、範囲外 blending 等)は
ファクトリ呼び出し時に検証し、`VfxDiagnosticError` を throw する。コンパイル時検証は
そのまま残す(JSON ロード経路はファクトリを通らないため)。

### (追記 2026-07-14) tslModule アクセス宣言の整合診断

H1-1 検収中に発見: カスタム tslModule が `Particles.lifetime` を書き `Particles.age` を
書かない場合、コンパイラは加齢/死亡パスを組み込まず(compiler.ts の includeAgeModule 条件)、
**粒子が無診断で不死になる**(showcase-beam で実測: 全出生が蓄積し画面が飽和)。
`lifetime` 書き込みに `age` が伴わないアクセス宣言を compile 診断で警告する
(または age を暗黙補完する)ケースを本プランの検証対象に追加する。

### (b) spawn 失敗の既定可視化

`VfxSystemOptions` に `onBuildDiagnostic?: (diagnostic) => void` を追加し、
既定実装を「severity=error を `console.error` に 1 行で出す」にする(オプトアウト可能)。
golden ページ群の consoleClean チェックが「不正定義の混入」を自動検出できるようになる副次効果もある。

## 受け入れ基準

1. `ribbon({ width: 0.2, taper: { start: 0.6, end: 0.6 } })` の呼び出しが即座に
   `NACHI_RIBBON_TAPER_INVALID` を throw する。
2. JSON ロード由来の同等不正が、従来どおりコンパイル診断として報告される(経路の回帰なし)。
3. 検証をすり抜けた実行時ビルド失敗が、既定で console.error に 1 件 1 行で出る。
4. 既存の正当な定義(全 golden / mN ページ)で新規の throw・警告が発生しない。

## 互換性 / リスク

- これまで「spawn まで生きられた」不正定義が作成時に落ちるようになる。挙動としては
  fail-fast 化であり、正当な定義には影響しない。
- (b) は既定でログを増やす。テストハーネスが consoleClean を検査するページでは
  「不正が無ければ増えない」ため実害はない。
