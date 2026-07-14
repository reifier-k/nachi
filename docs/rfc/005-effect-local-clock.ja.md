# RFC 005: 共有可能なエフェクトローカル・クロックソース

> Language: [English](./005-effect-local-clock.md) / 日本語 (このページ)

- **状態:** Proposed
- **対象:** `@nachi/core` のinstance clockと従属spawn、および `@nachi/timeline`、simulation
  cache、scalabilityとの相互作用
- **規範的参照:** [RFC 001](./001-api.ja.md) §10.2-10.5
- **提案日:** 2026-07-14
- **実装:** 本RFCによる実装はない。H1-8では小さい
  `TimelineEffectInstance.bindCompanion()` 転送契約のみを実装する

## 1. 問題

現在、エフェクトローカルclockはinstanceのprivate状態としてのみ存在する。`timeScale`、hit stop、
scalabilityによる停止はそのinstanceへ作用するが、独立してspawnされたcompanion effectは同じ権威ある
時刻を消費できない。`bindCompanion()` は現在の制御を転送して短期の一般例を解決するが、2つのsystemへ
同じworld step列を与える必要があり、loop phase、seek/replay所有権、一般的な親子clock graphは表現しない。

より大きいAPIを転送hookから推測してはならない。clock従属はsimulation意味論を変え、prewarm、loop、
cache replay、cullingと重なるため、実装前に明示的な裁定が必要である。

## 2. 提案するAPI形状

各live effect instanceは、同一性が安定したread-only clock objectを1つ公開する。

```ts
interface EffectClockSource {
  /** 直前に完了したupdate segmentで確定したeffect-local秒。 */
  readonly localTime: number;
  /** 同じ確定点におけるlocal秒/world秒の実効rate。 */
  readonly rate: number;
}

interface EffectInstance {
  readonly clock: EffectClockSource;
}

interface EffectSpawnOptions<Definition> {
  readonly clock?: EffectClockSource;
}

const parent = system.spawn(parentEffect);
const child = companionSystem.spawn(trailEffect, { clock: parent.clock });
```

`instance.clock` はinstanceの生存期間中、object identityを維持する。各fieldは文書化されたscheduler
commit pointでのみ更新され、公開readの途中では変化しない。`rate` はinstance time scale、hit stop、
scheduler所有の停止を反映した瞬間実効rateであり、0になり得る。これはcommand surfaceではなく、利用者は
代入、pause、seekできない。

`spawn(..., { clock })` を与えるとchildはsourceへ従属し、host deltaを独自に乗算せずsource-localな進行を
使う。child自身の作者指定 `timeScale` は未決である。external clockとの併用を禁止するか、source deltaへの
明示的な乗数とする必要があり、黙った優先順位は認めない。

clock sourceの寿命にもterminal ruleが必要である。候補は最終 `localTime` を保持し、`rate` を0として、
明示的なrebindまたはreleaseまでchildを停止させることだ。world timeへ自動復帰すると不連続になるため、
本提案には含めない。

## 3. updateとframe意味論

sourceは、local deltaが0のhit-stop segmentを含む各world segment後に値を公開しなければならない。従属childは
同じ確定source deltaを正確に1回消費する。1つのhost update内に複数source segmentがある場合、最終的な
`{ localTime, rate }` を読むだけでは不十分である。そのため公開v1形状が要求された2 fieldのままでも、実装には
internalな単調revisionとprevious local timeが必要になる可能性が高い。

実装前に次を裁定しなければならない。

1. sourceとchildが異なる `VFXSystem` に属してよいか。よい場合、どのsystemが従属順序を所有するか。
2. sourceより先にchildをupdateした場合、前revisionを使うか、処理をqueueするか、決定的な順序診断を投げるか。
3. sourceの複数fixed substepを、childが最後の集約だけ消費してstep単位のspawn/collisionを失うことなく伝える方法。
4. 従属cycleをどのように拒否し診断するか。

最終公開rateのみをsampleする実装は、厳密な同一フレーム動作を名乗ってはならない。

### 3.1 `bindCompanion()`の位相限界とsocket駆動

H1-8の `bindCompanion()` はclock controlを転送するが、sub-frame phaseを共有したり、別所有のcompanion
systemをtimeline action境界で分割したりはしない。したがってlocal timeの厳密な一致には、hit-stop actionが
companion update境界と一致するという条件がある。非整列actionでもcompanionを先に進めれば停止が丸1フレーム
遅れることは防げるが、timelineがactionで分割される一方、companionはhost stepの残りをすでに消費している
場合がある。ずれはcompanion update interval 1つ未満に制限される。この一般的な順序問題の解決は、本RFCが
提案するclock sourceの領域であり、H1-8の転送hookには含まれない。

ページ駆動のsocket trailには、さらに消費済みposeのlatchが必要である。H1-7は実効local deltaが0の間に
観測したper-distance transform移動を意図的に破棄する。timelineが新たに到達したhit-stop時刻からsocketを
再計算し、すでに停止したcompanionへそのtransformを与えると、その変位が破棄されtrailに間隙ができる。
統合は次の手順を使うべきである。

1. 完了した各companion updateで使用したsocket-local時刻/poseを記録する。
2. hit-stop action発火時は、action時刻のposeではなく最後に消費済みのposeをlatchする。
3. parent local timeが停止境界に留まる間、socketをlatch済みposeへ保持する。
4. parent local timeが境界を越えて前進した後にのみlatchを解除する。

次の非停止companion updateはcatch-up transform全体を消費するため、H1-7のper-distance補間は凍結中に
変位を破棄せず、その経路上へemitできる。

```ts
let consumedSocketLocal = parent.localTime;
let freeze: { boundary: number; socketLocal: number } | undefined;

parent.onAction(({ action, localTime }) => {
  if (action.kind === 'hit-stop') {
    freeze = { boundary: localTime, socketLocal: consumedSocketLocal };
  }
});

async function update(delta: number) {
  const socketLocal = freeze?.socketLocal ?? parent.localTime;
  driveSocket(socketLocal);
  await companionSystem.update(delta);
  consumedSocketLocal = socketLocal;

  await timelineSystem.update(delta);
  if (freeze && parent.localTime > freeze.boundary) freeze = undefined;
}
```

このpatternは外部transformと小さい転送APIを整合させるものであり、本RFCが提案する従属順序、revision
stream、sub-frame clock伝播を提供するものではない。

## 4. loopとの相互作用

Emitter `loopCount` とM9 timeline loopは異なるlifecycle scopeをresetする。clock sourceは、公開契約が
cycle/epochも示さない限り単調なlocal timeを公開すべきである。親loopで `localTime` が後退すると、従属
emitterはrate windowを重複し、per-distance historyを無効化し、負deltaを生成し得る。

望ましい方向はinternalな単調clockとcomposition用の別parent phase/epochである。そのepochを公開するかは
未決である。child lifecycleのloopはchild definitionが所有し続け、clock従属だけで親timeline cycleごとに
黙ってrestartしてはならない。

## 5. prewarmとの相互作用

prewarmは新規instanceを最初の外部正delta update前に決定的な固定local stepで進める。従属spawnでは、互換
しない2つの期待が生じる。

- prewarmが過去のparent timeを消費するが、liveな2-field sourceに履歴はない。
- prewarmがchildのbirth相対で進み、一時的にparentから離れる。

初期提案は、履歴契約ができるまでexternal clock付きspawnの非0 prewarmを拒否することだ。代案は明示的な
`prewarm: 'relative'` modeである。共有sourceを黙って進めたりsiblingを変更したりしてはならない。

## 6. bake/replayとの相互作用

`bakeSimulation()` は固定frame stepと決定的metadataを所有する。完全なrevision/delta streamを記録せず、
任意のlive clock objectへbakeを依存させることはできない。候補規則は次の通りである。

- bake中のexternal clockを拒否する。
- step metadataが一致するserializableなbaked clock trackだけを受ける。
- 親と全従属instanceを1つのcomposition graphとしてbakeする。

`replaySimulation()` は記録frameを復元し、live simulation kernelをscheduleしない。したがってsourceからの進行と
cache frame適用を同時に行ってはならない。replay instanceはvisual dependent向けにcache記録clockを公開するか、
v1ではclock sourceになることを拒否すべきである。cache seek、interpolation、loop endpointには明示的なclock
revisionが必要であり、childがseekをlive経過時間として解釈してはならない。

## 7. scalability停止

RFC 001では完全culled effectのlocal timeを停止する。sourceがculledでvisibleなdependentがculledでない場合、
source rate 0の継承はdependentも停止させる。真のcompanionには整合するが、systemが独立してsignificanceを
決める場合は意外になり得る。逆にchildが0 rateをoverrideできると従属の意味が壊れる。

提案ではsource-clock停止を優先し、各childはさらに自身のscalability停止を加えられるものとする。可能なら
budgetは従属graphを1 significance unitとして評価すべきである。独立budget systemのfallbackと
`rate === 0` の理由を説明するdiagnosticは未決要件である。

## 8. M9合成との役割分担

M9 `defineEffect()`/timeline合成は、element key、`play`/`stop`、loop restart、mesh-fx life、parameter、
transform、決定的action順序というsemantic lifecycleを所有する。共有clockは、すでに分離されたinstanceの
時間進行だけを所有する。第二のelement graphになったり、parameter/transformを転送したり、release所有権を
暗示したりしてはならない。

elementが1つの作者effectを構成してlifecycleを共有する場合はM9合成を使う。socket-follow trailのように
engine所有で別system/instanceに残す必要があるcompanionにはexternal clockを使う。`bindCompanion()` は低コストな
制御転送手段として残る。将来のclock sourceは手動step順序の仮定を置き換えるが、M9合成を置き換えない。

## 9. 採択前に必要な検証

実装を認めるRFC改訂には次を含めなければならない。

- variable/fixed step分割をまたぐ厳密なboundary test
- loop/epochとlate spawn test
- prewarmの明示的な拒否または意味論
- bake/replayの決定性とseek挙動
- source/child scalabilityの組み合わせ
- source release、error、従属cycleの処理
- cross-system順序診断とリークのない従属解除

これらの裁定が採択されるまで、`clock` と `spawn(..., { clock })` は予約済みdesign shapeであり、公開APIではない。
