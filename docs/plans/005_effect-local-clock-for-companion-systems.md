# 005: エフェクトローカル時計の共有(hitStop と随伴システムの同期)

- 重大度: 中(演出品質 / 合成体験)
- 対象: `@nachi/timeline`(クロック公開)、`@nachi/core`(インスタンスの timeScale 駆動)
- 状態: (a) H1-8で実装済み(2026-07-14)、(b) RFC 005起票済み(Proposed、実装なし)

## 症状

タイムラインの `hitStop()` / `timeScale` は**そのタイムラインインスタンスのローカル時間にしか
効かない**。ソケット追従トレイルのように「タイムラインの外」で回している随伴システム
(別 `VFXSystem` の emitter)はワールド時間で進み続けるため:

- ヒットストップ中もトレイルがスポーン・老化し続ける(演出が「止まって」いない)。
- ソケット軌道をローカル時間で駆動すると、随伴 emitter の `lifecycle.startDelay/duration`
  (ワールド時間)と最大 hitStop 分だけ窓がずれる。wuwa-slash では gold トレイルの
  スイープ開始が 70ms ずれ、静止ソケット上へのスポーン集中(ビード)を悪化させた。

## 根本原因

エフェクトローカル時計(hitStop / timeScale / ループ位相を含む)がタイムラインインスタンス
内部に閉じており、外部システム・外部インスタンスへ供給する公式手段がない。
`VfxEffectInstance.applyHitStop()` は存在するが、タイムラインの hitStop 発火と
手動で同期させる必要があり、発火タイミング(アクションコールバック)から呼んでも
発火フレーム内のずれが残る。

## 改善案

段階的に 2 案:

### (a) 小: hitStop の伝播フック(短期)

`TimelineEffectInstance` に `bindCompanion(instance: VfxEffectInstance)` を追加。
タイムラインが hitStop / timeScale を適用する際、バインドされた companion インスタンスへ
同一フレームで `applyHitStop` / `setTimeScale` を転送する。実装が小さく、
wuwa-slash 型の「トレイルは別システム」構成をそのまま救える。

### (b) 大: エフェクトローカル・クロックソース(中期・要 RFC)

`instance.clock`(`{ localTime, rate }` を毎 update 後に確定)を公開し、
`system.spawn(effect, { clock: parentInstance.clock })` で子インスタンスの時間前進を
親クロック従属にできるようにする。ループ・prewarm との相互作用が非自明なので RFC を書く。
M9 の合成(`defineEffect` ネスト)との役割分担も整理が必要。

まず (a) を実装し、(b) は RFC 起票のみ行う。

## 受け入れ基準 (a)

1. タイムラインの `hitStop(70)` 発火と同一フレームで companion インスタンスの
   ローカル時間が同率で停止し、再開も同一フレームで揃う。
2. companion の release 後にバインドが自動解除され、リークしない。
3. golden-ultimate の既存 hitStop 検証(local/world 時刻の厳密比較)が不変。

## 互換性 / リスク

- (a) は追加 API のみで後方互換。
- (b) は時間モデルの拡張であり、キャッシュ再生(M11 bake/replay)や scalability の
  時間停止と重なるため、単独実装せず RFC を必須とする。

## H1-8 実装

- `bindCompanion()` / `unbindCompanion()` を追加し、bind時に実効timeScaleとhitStop残余を同期する。
  以降のhitStop置換と `setTimeScale()` も同期転送する。
- bindingは `WeakRef` で保持する。release済み参照は次の更新/転送で自動除去され、timelineがcompanionを
  強参照し続けない。`error` 状態は初期同期・残余・hitStop・timeScaleの全経路で転送対象外とし、利用不能な
  bindは `NACHI_TIMELINE_COMPANION_UNAVAILABLE` warningを記録する。bind時は既存controlを上書きし、
  以後のtimeline転送とcompanion直接操作はlast-writer-winsである。
- wuwa-slashと同型のshowcase-beamへbindingを適用した。別systemをtimelineより先に同じdeltaで更新するが、
  clockの厳密一致はactionとcompanion updateの境界が整列する場合に限る。wuwa-slashではhitStop発火時に
  companionが最後に消費したsocket poseをlatchし、再開後の非停止stepへcatch-up変位を渡すことで、H1-7の
  停止中距離破棄とtrail間隔の両契約を維持する。
- (b) のみを [RFC 005](../rfc/005-effect-local-clock.ja.md) として起票し、実装は行わない。
