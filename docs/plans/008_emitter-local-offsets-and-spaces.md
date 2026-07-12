# 008: エミッタローカルの配置オフセットと空間指定の一貫化

- 重大度: 高(体験。4/5 の制作エージェントが独立に痛点として報告)
- 対象: `@nachi/core`(init/update モジュールの空間意味論、EmitterConfig)
- 状態: 提案
- 出典: showcase-ice / showcase-machina / showcase-beam / showcase-barrier 制作エージェント

## 症状

「1 エフェクト内の複数地点で粒子を出す」「エフェクト原点以外に力場を置く」という
ごく普通の要求に対して、現状は以下の回避策しかない:

1. **位置オフセットがない**: `positionSphere` にセンター指定がなく、
   「N 本目の氷柱の根元でバースト」は tslModule 自作(ice)か、
   **地点ごとに別インスタンスを spawn する第 2 システム**(machina のレーザー着弾、
   beam のマズル/インパクト)を要求する。後者は sprite draw の手動 materialize /
   後始末まで含めて丸ごと 1 サブシステム分の работы になる。
2. **空間の既定が混在**: `pointAttractor.position` はシミュレーション空間解釈で、
   インスタンスを `[-2.3, 0.1, 0]` に spawn しても原点に引かれる(beam。
   `space?: 'emitter' | 'world'` は存在するが既定と挙動の対応が直感に反し、ドキュメントもない)。
3. 関連して形状パリティ: `positionSphere` に半球/球冠(arc)指定がなく、ドーム表面エミッタは
   下半球分の粒子を無駄にする(barrier)。

## 改善案

1. **init 形状モジュールに `center?: ValueInput<Vec3>`(エミッタローカル)を追加**
   (`positionSphere` から着手し、他の形状にも展開)。
2. **`EmitterConfig.offset?: Vec3`(エミッタローカル変換)を追加**し、要素キー単位で
   「同一エフェクト内の別地点」を宣言できるようにする。timeline の play はこのローカル
   オフセットを効果変換に合成する(001 の合成則と同一)。
3. **空間指定の総点検**: `position` / `center` を取る全モジュール
   (pointAttractor / vortex / killVolume / collide* )について、既定空間を表にして
   ドキュメント化し、`space` 未指定時の既定を「emitter」に統一するかを RFC で判断する
   (挙動変更のため)。
4. `positionSphere` に `arc?: { thetaMax }`(球冠)を追加(barrier の半球ドーム用)。

## 受け入れ基準

1. `positionSphere({ center: [1, 0, 0], radius: 0.1 })` がインスタンス変換に追従した
   オフセット位置で湧く。
2. machina 型「散在地点バースト」が第 2 システムなしで、単一 timeline エフェクトの
   複数 emitter 要素+ `offset` で書ける。
3. `pointAttractor` の空間既定が文書化され、`space:'emitter'` でインスタンス追従が保証される。
4. 既存ページの挙動が(明示 opt-in なしでは)変わらない。

## 互換性 / リスク

- 1,2,4 は追加のみで後方互換。3 の既定変更は破壊的なので RFC 必須。
