# RFC 004: モジュールの座標空間

> Language: [English](./004-module-spaces.md) / 日本語 (このページ)

- **状態:** 2026-07-15、H2-6まで実装済み
- **対象:** `@nachi-vfx/core` のエミッター/グリッドモジュールと
  `@nachi-vfx/format` の互換正規化
- **規範的参照:** [RFC 001](./001-api.ja.md) §4.3、§6.1、§9、§10.7、
  [RFC 003](./003-versioning.ja.md) §2-4
- **裁定日:** H1-5は2026-07-13、H2-6拡張は2026-07-14

## 1. 一覧と全体規則

この一覧は `packages/core/src/api.ts`、`grid2d.ts`、`grid3d.ts` の全公開組み込みヘルパーと、
compiler、scheduler、Three materializerの各消費点を照合した。座標入力を持たないモジュールも
**N/A** 行として残す。したがって本表は重要な例だけの一覧ではなく、API追加時の網羅チェック表である。
コンパイラ所有モジュールは公開stage表の後に別記する。

パーティクルの `position` と `velocity` はworld-spaceに格納する。公開emitter transformは平行移動と
回転だけでscaleを持たない。このためlocalのradius、length、offsetの大きさはworld単位と同じである。
scale追加はdistance、normal、collision response、grid、補間規則を変えるため、新しいRFCを必要とする。

以下の「spawn transform」はRFC 001 §9の粒ごとの `Emitter.spawnInterpolatedTransform`、
「Update midpoint」は§3のH2-6単一サンプル、「current」は未補間の現simulation終点における
合成済み `Emitter.transform` を意味する。

## 2. 組み込みの完全な一覧

### 2.1 SpawnとInit

| Stage | API | 座標/単位の契約 | selectorと省略時既定 | transform sample |
| --- | --- | --- | --- | --- |
| Spawn | `burst` | N/A。`count`は粒数 | N/A | N/A |
| Spawn | `rate` | 空間はN/A。emitter-local秒あたりの粒数 | N/A | N/A |
| Spawn | `perDistance` | 合成済みemitter transformが移動した **world-space単位あたり** の粒数。simulation stepごとにpreviousからcurrentへの直線chordを1回消費 | N/A | 距離にはprevious/current終点、birthにはspawn transform |
| Init | `positionSphere` | `center`、`radius`、`arc.axis`はemitter-local。出力位置はworld-space | emitter-local固定 | spawn transform |
| Init | `positionMeshSurface` | 頂点/法線はemitter frame内のmesh-local。出力位置と保持法線はworld-space | mesh/emitter-local固定 | spawn transform |
| Init | `velocityCone` | `direction`を選択frameで解釈し、velocityをworld-spaceへ格納 | `world` / `emitter`。**既定は`world`** | emitter指定時、そのbirthと同じspawn transformをdirection形式(`w = 0`)で使用。world指定はtransformを読まない |
| Init | `velocityMeshNormal` | `positionMeshSurface`が生成したworld-space normalを読み、world-space velocityを書き込む | world-space固定 | N/A |
| Init | `lifetime` | N/A | N/A | N/A |
| Init | `lightIntensity` | N/A | N/A | N/A |

### 2.2 Update

| API | 座標/単位の契約 | selectorと省略時既定 | emitter transform sample |
| --- | --- | --- | --- |
| `gravity` | world-space加速度。scalar形式は固定world重力軸 | world-space固定。selectorなし | N/A |
| `drag` | 格納済みworld-space velocityへのscalar damping | N/A。回転不変 | N/A |
| `boids` | 近傍position/velocityと計測distanceはworld-space。traversal `radius`は整数の立方cell半径、`separationRadius`は`cellSize`倍してworld閾値にする。grid `origin`はemitter-local | NeighborGridの混合契約固定 | **current**。midpoint禁止 |
| `pbdDistanceConstraint` | bucket snapshotと`distance`はworld-space。任意traversal `radius`は整数の立方cell半径。lookup volume originはemitter-local | NeighborGridの混合契約固定 | **current**。midpoint禁止 |
| `neighborGridTslModule` | custom neighbor snapshotと計測distanceはworld-space。traversal `radius`は整数の立方cell半径。lookup volume originはemitter-local | NeighborGridの混合契約固定 | **current**。midpoint禁止 |
| `curlNoise` | world-space particle positionをsample。frequencyはworld長の逆数 | world-space固定 | N/A |
| `vortex` | `center`/`axis`は選択frame、加速度はworld-spaceへ戻す | `world` / `emitter`。既定`emitter` | `emitter`時だけUpdate midpoint |
| `pointAttractor` | `position`、radius、減衰distanceは選択frame、加速度はworld-spaceへ戻す | `world` / `emitter`。既定`emitter` | `emitter`時だけUpdate midpoint |
| `linearForce` | 加速度vectorは選択frame、velocityはworld-space | `world` / `emitter`。**既定は`world`** | `emitter`時だけUpdate midpointをdirection形式(`w = 0`)で使用 |
| `turbulence` | world-space particle positionをsample。frequencyはworld長の逆数 | world-space固定 | N/A |
| `vectorField` | field bounds、sample position、sampled vectorはfield/world座標 | field/world-space固定 | N/A |
| `collidePlane` | `normal`/`offset`は選択frame。local offsetの大きさはworld長 | `world` / `emitter`。既定`emitter` | `emitter`時だけUpdate midpoint |
| `collideSphere` | `center`/`radius`は選択frame。local radiusの大きさはworld長 | `world` / `emitter`。既定`emitter` | `emitter`時だけUpdate midpoint |
| `collideBox` | `center`/`size`は選択frame。local extentの大きさはworld長 | `world` / `emitter`。既定`emitter` | `emitter`時だけUpdate midpoint |
| `collideSceneDepth` | world positionからview/clip/screen depthへのpipeline。`surfaceOffset`はworld長、`thickness`はlinear view depth | world/camera-space固定 | N/A |
| `collideSdf` | SDF bounds/sample/gradient/thickness/responseはfield/world座標 | field/world-space固定 | N/A |
| `orientToVelocity` | world-space velocityを読みparticle orientationを書く | world-space velocity固定 | N/A |
| `sizeOverLife` | 空間はN/A。normalized lifetime curve | N/A | N/A |
| `intensityOverLife` | 空間はN/A。normalized lifetime curve | N/A | N/A |
| `rotationOverLife` | 空間はN/A。sprite-plane angle | N/A | N/A |
| `velocityOverLife` | 格納済みworld-space velocityのscalar倍率 | N/A。回転不変 | N/A |
| `killVolume` | `center`、`normal`、`offset`、radius、sizeはemitter-local。寸法の大きさはworld長 | emitter-local固定 | Update midpoint |
| `colorOverLife` | N/A | N/A | N/A |

解析的なemitter-space collision responseでは、粒をlocalへ評価するinverse transformと、補正後の
position・normal相対velocity・forceをworldへ戻すforward transformは、完全に同じsampled transform
式でなければならない。両方向を独立にsampleしてはならない。

### 2.3 EventとRender

| Stage | API | 座標/単位の契約 | selector / transform |
| --- | --- | --- | --- |
| Event | `emitTo` | 継承した`position`/`velocity`はworld-space particle snapshot。他属性はschemaがframeを定義しない限りN/A | world snapshot固定 / N/A |
| Render | `billboard` | particle position/velocityはworld-space、`custom-axis.axis`はworld方向、`sortCenter`はemitter-local、soft fade distanceはworld長でなくnormalized camera depth | 固定契約。coarse sortはcurrent emitter transform |
| Render | `faceCamera` | camera-facing `billboard`のalias。particle positionはworld-space | world/camera-space固定 |
| Render | `meshRenderer` | particle position/velocityはworld-space、`custom-axis.axis`はworld方向、`sortCenter`はemitter-local | 固定契約。coarse sortはcurrent emitter transform |
| Render | `lightRenderer` | particle positionはworld-space。`Particles.size * radiusScale`はworld-space light distance | world-space固定 |
| Render | `decalRenderer` | particle position/rotationがscene depthに対するworld-space projection boxを定義 | world/depth-space固定 |
| Render data | `flipbook` | 空間はN/A。atlas UV/frame data | N/A |

### 2.4 Grid2D、Grid3D、NeighborGrid

| API | 座標/単位の契約 | emitter transform |
| --- | --- | --- |
| `defineGrid2D`、`defineGrid3D`、`defineSimStage` | grid index/cell spaceはemitter transformから独立 | なし |
| `gridInject`、`grid3DInject` | `center`/`radius`はresolution/emitter frameから独立したnormalized `[0, 1]` Grid2D/volume座標。値は秒あたりの加算 | なし |
| `gridAdvect`、`grid3DAdvect` | backtrace/sampleはcell space。velocity channelは **grid cell/秒**。dissipationは1/秒 | なし |
| `gridBuoyancy`、`grid3DBuoyancy` | velocity channelへgrid cell/秒で書く。浮力軸はgrid +Y | なし |
| `gridPressureJacobi`、`grid3DPressureJacobi` | neighbor sampleとpressure差はcell space | なし |
| `gridProjectVelocity`、`grid3DProjectVelocity` | velocity channelとpressure gradientはcell space。velocityはgrid cell/秒 | なし |
| `gridTslModule`、`grid3DTslModule` | `context.cell`と`sample(..., cell)`はcell座標。custom channelの単位は作者定義 | なし |
| `defineNeighborGrid` | `origin`はemitter-local最小corner。`cellSize`はworld長。`resolution * cellSize`がlocal volumeを定義 | **current** 合成済みemitter transform |
| `boids`、`pbdDistanceConstraint`、`neighborGridTslModule` | bucket時/live positionと計測distanceはworld-space。traversal `radius`は整数の立方cell半径。boids `separationRadius`は`cellSize`単位で、乗算後にworld閾値となる。PBD `distance`だけが直接world単位で作成される。cell lookupだけcurrent emitter frameへ写す | bucket挿入と全visitor lookupで **current** |

NeighborGridは意図的にUpdate midpointを使わない。rebuildと全consumerは1つのcurrent終点data interfaceを
構成する。bucket挿入だけmidpoint、lookupだけcurrent、またはその逆にするとcellが不整合になる。

### 2.5 コンパイラ所有モジュールとcustom module

| Module | 契約 |
| --- | --- |
| `$defaults` (Init) | N/A。宣言済みparticle attributeを初期化 |
| `$age` (Update) | N/A。lifetime bookkeeping |
| `$integrate` (Update) | 格納済みworld-space velocityをworld-space positionへ積分 |
| `tslModule` / 登録module | access manifestとmodule文書が全座標入力/出力のframeを宣言しなければならない |

## 3. H2-6のselectorとUpdate midpoint裁定

H1-5は `vortex`、`pointAttractor`、`collidePlane`、`collideSphere`、`collideBox` の省略時既定を
`emitter`へ変更した。H2-6は `velocityCone` と `linearForce` にselectorを追加するが、v1挙動と生成shaderを
維持するため省略時既定を意図的に **`world`** とする。`gravity`はworld固定のままである。したがって
「全selector省略=emitter」という全体規則は成立せず、§2のmodule別既定が規範である。

H2-6挙動は`velocityCone`、`linearForce`、`vortex`、`pointAttractor`、解析collider 3種、`killVolume`の
module **version 2**に属する。module-v1実装はH2-6前の意味で登録を維持する。cone/linear selectorは無視して
world-space、既存emitter-space Update consumerはcurrent終点をsampleする。このversion境界はRFC 003 §4上
必須である。H2-6前readerは未知config fieldを受理したため、境界なしでは新emitter selectorをworldとして
黙って実行し得る。

emitter-spaceのforce、解析collider、kill volumeに追従する全Update組み込みは、コンパイラ提供の
`Emitter.updateInterpolatedTransform` を正確なphase `0.5`で1回sampleする。

- 平行移動は `lerp(previousTranslation, currentTranslation, 0.5)`。
- 回転はphase `0.5`の最短経路quaternion slerp。
- scaleは存在せず、補間しない。
- previous/currentが厳密に静止している場合はcurrent transform直読み分岐を通り、従来の出力bitを保つ。
- 式はupdate kernel graphごとに1回cacheし、全consumerが共有する。

これは **時間積分の1サンプル近似** である。continuous collision detection (CCD)、swept-volume交差、
multi-point quadrature、substep合成ではない。薄いvolumeはprevious/midpoint/currentの間を通過しても
観測されない場合がある。より強い保証が必要ならfixed substepまたは将来の明示CCD機能を使う。

## 4. History lifecycle

`previousTransform`、`transform`、`interpolationActive`は任意のpresentation callではなく、連続する
simulation終点を表す。構築、最初の初期化前attachment sync、初期化前`setTransform`、pool checkout、
restart/reset、direct prewarm entryはprevious=currentかつinterpolation inactiveにする。fixed-time substep、
culled instance、particle時間を進めず移動だけ消費するhit-stop stepを含め、各consumed system stepはschedule後に
currentをpreviousへcommitする。したがってresume時に古い終点を再利用しない。error/release経路は汚染された
live historyをpoolへ返さない。

live parameterだけを変えるquality/significance変更はemitterを再構築せずhistoryもresetしない。将来runtime
emitter stateを再構築する経路を追加する場合は、history reset規則を明示しテストしなければならない。

## 5. 移行とシリアライズ済みasset

既存 `nachi-effect` envelope version 1文書とmodule-version-1 recordは歴史的な意味を維持する。

1. module-v1 `velocityCone`/`linearForce`は、旧generic writerが`space:'emitter'`を含めても無条件に`world`へ
   正規化・実行する。旧readerはそのfieldを無視したためである。
2. H1の5 moduleにおけるmodule-v1明示emitter selectorは有効なままcurrent終点をsampleする。pre-H1 legacy
   inputの省略selectorは明示`world`へ正規化する。
3. module-v1 `killVolume`はcurrent終点のemitter-localのまま。
4. 現行authoring helperはmodule version 2を出力し、H1-5の5種は`emitter`、
   `velocityCone`/`linearForce`は`world`というmodule別既定を明示具現化する。
5. 再serializationはmodule versionを保持し、正規かつ明示的で入力objectを変更しない。v1 loadを黙ってv2へ
   upgradeしない。すなわちenvelope-v1 assetをloadしてもmodule-v1 recordをmodule v2へ暗黙upgradeしない。

H2-6時点のasset envelopeは、module record自身がversionを持つためversion 1のままだった。H2-6前readerは
`type@1` registry entryしか持たず、新規作成された`type@2`を`NACHI_MODULE_UNKNOWN`で安全に拒否したため、
selectorを黙って再解釈できなかった。H2-7はその後renderer境界のためcanonical envelopeをversion 2へ上げた。
default envelope-only v1→v2 migrationはmodule payload/versionを変更しないため、module-v1とmodule-v2のspace recordは
上記H2-6 semanticsを維持する。local cone/thruster方向を望むcode-first定義はv2 helperで`space: 'emitter'`を明示する。

## 6. 公開API追加・変更チェックリスト

組み込み、座標field、transform consumer、grid channelを追加する提案は本RFCの英日両方を更新し、次をすべて
回答しなければならない。

1. 全position、direction、normal、distance、velocity、frequencyのframeと単位は何か。
2. frameは固定か選択可能か。選択可能なら明示的な省略時既定とlegacy asset正規化は何か。
3. 境界のparticle storageはworld、emitter-local、camera/view、field、normalized grid、cellのどれか。
4. consumerは粒ごとのspawn補間、Update midpoint、current transform、transformなしのどれか。その理由は何か。
5. inverse/forward変換は1つの共有transform式から派生するか。
6. emitter回転は入力へ影響するか。平行移動は必要箇所でdirection形式(`w = 0`)か。将来scale追加時はどうなるか。
7. 契約を弁別するCPU reference、compiler graph、実GPU readback、stationary bit、serialization、WebGL2
   materialization/rejection、fault injection testは何か。
8. 構築、reset、pool、attachment、fixed-step、prewarm、pause/hit-stop、culling、quality/restart、error、releaseの
   どのhistory経路が影響を受けるか。

## 7. SemVerと検証記録

H2-6は **`@nachi-vfx/core` のminor変更** である。2つのselectorは追加的だが、移動中のemitter-space
Update consumerは意図的にsample frameが変わる。`@nachi-vfx/format`もstrict validation、互換正規化、
canonical outputに対する **minor変更** を受ける。experimental 0.x系ではRFC 003に従いminor changesetで表す。

必要な回帰coverageは次である。

- `velocityCone`/`linearForce`の省略時と明示`world`がH2-6前のWGSL hashと完全一致する。
- 明示emitter selectorが実GPU実行で回転追従する。
- moving collider、kill volume、force fixtureをCPU referenceに対して1 step/4 substep比較し、全影響moduleの
  stationary結果を固定済みH2-6前GPU hashと比較する。
- 実NeighborGrid GPU bucket+visitor fixtureがcurrentとmidpointを弁別する。
- format load/compile/reload/serializeが入力を維持し、明示既定をcanonical化する。
- raw module-v1 moving GPU fixtureが旧endpoint結果を再現し、version-1-only registryがmodule v2を安全に拒否する。
- transform history lifecycle経路とperformance v2 median/p95をplan 022へ記録する。
