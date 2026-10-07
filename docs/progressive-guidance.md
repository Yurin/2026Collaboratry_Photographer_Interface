# Progressive Role-Aware Guidance 実装・評価ガイド

更新日: 2026-10-05。新規実験の `guidanceProtocolVersion` は `progressive-v1`。

参加者主導の実験運用は [参加者実験フロー](participant-experiment-flow.md) を参照。以下の即時解析・指示配信の説明は研究者向け／通常モードの基盤仕様である。参加者モードでは評価が揃い、Retakeと決まってから役割別指示を提示する。

## Phase 1: 既存構成と接続点

| 対象 | 既存の処理 | 今回の接続 |
|---|---|---|
| 撮影後解析 | Web撮影 → `draft-photos` → `photos/:photoId/analyze` → Python特徴抽出 → 指示生成 → HTTP/WS | 写真保存・送信経路を維持し、候補生成と選択を追加 |
| 指示・Ready | `role_guidance.py` と `readiness.py` | 新方式は `progressive_guidance.py` に集約。旧方式は `legacy_analyze` と既存Readyを維持 |
| ReferencePose | `uploads/<session>/experiment/references/<reference>/current.json` と `versions/` | 試行作成時点の版を解析用に変換し固定 |
| ReferenceGuide | 通常ガイド生成時の `guides/features/`、共通保存先 `data/reference_guides/` | 実験専用 `guides/features/trial_<trialId>.json` を生成 |
| 条件 | serverのsession/trial、Web `applyExperimentState`、Swift `ExperimentCondition` | 条件の意味をプロトコル版で区別し、A/B/Cの選択方式を変更 |
| ログ | `experiment/trials/<trialId>/events.jsonl` | 既存イベントに候補・選択・改善・設定を追加 |

既存の未コミット変更 `ExperimentSetupView.swift`（フッター余白調整）は保持し、本機能では編集していない。

## Phase 2: データ構造とアルゴリズム

各候補は次を持つ。

- `candidateId`: `targetRole:category:target`。方向が反転しても同じ問題として比較する。
- `targetRole`, `category`, `target`, `direction`, `message`
- `errorMagnitude`, `normalizedError`, `priority`, `priorityScore`
- `threshold`, `categoryWeight`, `isResolved`, `status`（resolved/unresolved/unknown）
- 既存UI互換の `type`, `value`, `severity`

`priorityScore = (errorMagnitude / threshold) × categoryWeight`。
既定値は `backend/guide_processor/guidance_config.json`。`GUIDANCE_CONFIG` で差し替え可能。新規試行では設定全体を `trial.json` に固定し、解析時にその設定を使う。

| カテゴリ | 担当 | 誤差 | 閾値 | 重み |
|---|---|---|---|---|
| composition_position | photographer | 3:4画像の正規化人物中心間距離 | 0.06 | 3.0 |
| composition_scale | photographer | 人物枠面積の平方根の差の絶対値 | 0.10 | 2.5 |
| pose | subject | 身体基準で正規化した各関節の距離 | 0.25 | 1.0 |

構図位置は上下左右を別問題にせず、中心のずれを1候補にし、誤差が大きい軸の方向を案内する。カメラの移動方向と画像上の人物移動方向は逆。被写体には画像内の絶対位置の移動を指示しない。

ポーズは、腰中央を原点、肩中央から腰中央までの長さを単位にする。横座標に3/4を掛けて画素の縦横比を揃える。平行移動・一様な拡縮を除去するが、回転は除去しない。対象関節は設定の `poseTargets`。自動推定の信頼度0.3未満・無効化された参照点は対象外。手動保存された有効点は人手確認済みの正解点としてconfidence=1にする。

身体方向・奥行き・肘を曲げる角度は推測しない。「左手首を画面の上へ」等、人物の左右関節名と画面の移動方向を明示する。左右のミラー変換は未対応なので実機で対応を確認する。

候補は未観測を先、次にスコア降順、同点時はcandidateId順に並ぶ。未観測はscore=nullで再撮影／参照確認を案内し、解決済みとは扱わない。条件Cは役割ごとに先頭1件。前回の未解決候補を固定する方式ではなく、毎回測定・再順位付けする。ヒステリシスは未導入。

### 実験条件

| 項目 | A: Guide Only | B: All Role-Aware | C: Progressive Role-Aware |
|---|---|---|---|
| 参照写真・固定骨格ガイド・ライブ映像 | 両端末で利用 | 同左 | 同左 |
| 写真解析・誤差保存 | 実行 | 同じ処理 | 同じ処理 |
| 撮影者への自動指示 | なし | 撮影者の全未解決候補 | 撮影者の最優先1件 |
| 被写体への自動指示 | なし | 被写体の全未解決候補 | 被写体の最優先1件 |
| Readyの画面表示 | なし（サーバーログには保存） | 通常モードはあり。参加者モードは設定で制御・既定false | 同左 |

実験ではガイドの位置・拡大率を固定し、手動補正した参照を同じ基準で使う。参照画像を確認する折り畳みUIと、視覚ガイドはA/B/C共通。通常モードは全候補方式（B相当）で、既存のガイド共有・遠隔変形を継続できる。

既存セッションのプロトコル未指定は `legacy-v1` として扱う。旧A=支援なし、旧B=撮影者のみ、旧C=双方支援のデータは新しい条件と混ぜない。新研究には新規セッションを作成する。旧セッションでは既存の解析・表示規則を維持するが、iOSの条件選択ラベルは新方式の名称になっている。

### Ready

- `framingReady`: 中心・サイズの両方が閾値以下。
- `poseReady`: 対象関節すべてが観測され、その誤差が閾値以下。
- `captureReady`: 両方がtrue。Readyにならなくても撮影・送信はできる。
- ポーズ全体の誤差は対象点の最大値。少数の大きなずれが平均で隠れないようにする。
- 人物未検出、複数人、肩・腰の基準不足、対象関節の未観測はReadyにしない。小さな残差は閾値で許容する。
- `totalError` は中心・サイズ・最大関節誤差を各閾値で割った値の平均。美的評価ではない。判定不能ならnull。
- `readyThresholds` と `guidanceConfig` を解析結果・イベントに残す。

## Phase 3: 参照姿勢と状態管理

1. 実験画面で参照写真を抽出し、関節位置・有効点を確認して保存する。
2. 試行作成時に `ReferencePose` → `ReferenceGuide` へ変換する。`referenceImageId` と `referencePoseVersion` を記録する。
3. 同じ特徴から透過骨格PNGを生成し、`trial.guideId / guideUrl / referenceImageUrl` を両端末へ渡す。
4. 撮影後解析は試行のguideIdのみ受理する。後から参照姿勢を再保存しても、その試行の特徴・PNGは更新しない。新しい補正を採用するときは新規試行を作る。
5. 撮影系列が古い結果は最新状態と進行比較を更新せず、WebSocketの完了通知も送らない。HTTP応答に対しても既存Webのtrial/guide/sequence検査を維持する。iOSは解析開始時にも系列の上限を更新する。

通常保存ガイドを後から編集する機能や、試行の補正骨格を通常ガイドライブラリへ登録する機能は追加していない。

### 保存されるログ

- 共通識別子: sessionId、trialId、conditionId、guidanceProtocolVersion、captureSequence、clientId、photoId、analysisId、guideId、referencePoseVersion。
- 時刻: captureTimestamp、analysisStartTimestamp、analysisEndTimestamp、webGuidanceDisplayTimestamp、subjectGuidanceDisplayTimestamp。計測時刻はepoch ms。
- 解析結果: guidanceCandidates（解決済みも含む）、selectedGuidance、役割別表示配列、alignmentError、ready、readyThresholds、guidanceConfig、guideTransform。
- `guidanceProgress`: 同一trial/guide/条件/設定/変形かつ新しい撮影系列の候補をcandidateIdで比較。beforeError、afterError、improvement、improved、wasSelected、resolved、newlyResolved、regressed、前後のanalysisId/sequence、captureIntervalMs。
- `photo_captured`: 直前にWebで表示したanalysisIdと `guidanceToNextCaptureMs`。同一Web時計で計測し、他trial/guideの表示は結合しない。
- Web/iOSの表示イベントには、実際に表示した役割別候補のID・誤差・優先度を保存する。全候補はanalysisIdで解析イベントへ結合する。

```text
uploads/<session>/
├── guides/features/trial_<trialId>.json
├── guides/trial_<trialId>.png
├── analysis/observations/<photoId>.json
├── analysis/role_guidance/<photoId>.json
├── analysis/history/<analysisId>.json
├── analysis/progress_<trialId>_<guideId>.json
└── experiment/trials/<trialId>/
    ├── trial.json
    ├── guidance-config.json
    └── events.jsonl
```

写真IDの最新結果に加え、解析IDごとの履歴を保存するので再解析を区別できる。進行比較は直前の成功解析が基準であり、解析失敗の撮影は飛ばす。未観測への変化は改善・再悪化として数値計上しない。保存の失敗や通信断は欠測として扱う。

### 評価指標への結合

| 指標 | 使用する記録 |
|---|---|
| 最終構図・ポーズ・総合誤差 | 最終写真のanalysisIdに対応するalignmentError |
| Readyまでの時間・枚数 | trial開始時刻、最初にcaptureReadyになった解析、撮影イベント／系列 |
| 指示提示回数 | photographer/subject_guidance_displayed（役割・analysisIdで重複除外） |
| 修正サイクル数 | 指示表示後の撮影。実際の身体動作数とは区別する |
| 指示後の誤差減少・役割別改善率 | guidanceProgressのwasSelected、targetRole、improvement |
| 改善後の再悪化 | 同一candidateIdのregressed |

これらは集計可能なログ構造であり、参加者実験のCSV Exportと品質サマリーは実装済み（[研究運用仕様](research-operations.md)）。自動分析ダッシュボードは未実装。両者が同時に調整するので誤差改善をその指示の因果効果と断定しない。端末間時計差は未補正。iOS表示→次回Web撮影は、両イベントのクライアント時刻とサーバー受信時刻を保存しているが、時計差を測定してから評価する。

## Phase 4: 検証

```sh
cd backend
npm run test:session-flow
npm run test:guidance
cd ..
MPLCONFIGDIR=/tmp/photo-mpl backend/.venv/bin/python -m unittest discover -s backend/guide_processor -p 'test_*.py'
```

- Python既存15件＋追加9件の24件に合格。
- Nodeポリシー、Web表示ロジック、実験HTTP/WebSocket連携テストに合格。
- 既存セッション連携（映像、ガイド、終了、再接続）に合格。
- iOS Simulator向けDebugビルドとSwift単体テスト4件（既存トリミング2件＋指示形式互換2件）に合格。
- 連携テストは画像特徴抽出だけを固定値へ置換し、実際のPython候補生成・PNG描画・HTTP・WS・ファイル保存を通す。モデル精度や実機カメラの検証ではない。

### 実機で確認する項目

1. 新規実験で参照写真を補正・保存し、試行の両画面に同じ参照画像・骨格が出る。
2. Aはガイドだけ、Bは各役割の複数指示、Cは各役割最大1件。Aで指示・Readyが一瞬でも出ない。
3. カメラを動かすだけで身体指示が増えないこと、画像左右と左右関節名の対応、腕・脚・座位の指示方向。
4. Cで最優先の差を直して再撮影すると、完了表示・次の候補・Readyに更新される。
5. 閾値前後、見切れ・遮蔽・低信頼・複数人でも誤Readyにならない。上半身写真では見えない足等を参照側で無効化する。
6. 素早い連写、遅い応答、trial切替、再接続で前の結果が新しい表示を上書きしない。
7. ドラフト削除、一括送信、iOS保存、撮影終了、ライブ再接続が従来どおり動く。
8. events.jsonlと両端末の表示時刻・候補数・順番を照合する。時計差を記録する。

## Phase 5: 変更ファイルと残課題

| ファイル | 目的 |
|---|---|
| `backend/guide_processor/progressive_guidance.py` | 候補、身体正規化、順位・選択、Ready |
| `backend/guide_processor/guidance_config.json` | 閾値・重み・対象点設定 |
| `backend/guide_processor/role_guidance.py` | 新方式の呼出しと旧方式互換 |
| `backend/guide_processor/render_reference_guide.py` | 固定した補正姿勢からPNG生成 |
| `backend/research_guidance.js` | ReferencePose変換と再撮影比較 |
| `backend/server.js` | 条件版、試行固定参照、解析・履歴・進行ログ |
| `backend/.env.example`, `backend/package.json` | 設定例とテストコマンド |
| `photographer/script.js`, `photographer/index.html` | 条件表示、固定ガイド、参照画像、表示・次撮影ログ |
| `photo2026/photo2026/ExperimentAPI.swift` | 条件名と試行ガイド・プロトコル状態 |
| `photo2026/photo2026/SessionAPI.swift` | 候補情報・進行情報の受信 |
| `photo2026/photo2026/ContentView.swift` | 条件・試行・ガイド・撮影系列による表示抑止 |
| `photo2026/photo2026/TakePhoto.swift` | 固定ガイド・参照画像・被写体指示・表示ログ |
| `backend/guide_processor/test_progressive_guidance.py` | アルゴリズム単体テスト |
| `photo2026/photo2026Tests/photo2026Tests.swift` | 新旧指示データのデコード互換性テスト |
| `backend/test/research-guidance.test.js`, `guidance-ui.test.js`, `progressive-flow.test.js` | 変換・進行・Web条件・API回帰テスト |
| `README.md`, `REQUIREMENTS.md`, `EXPERIMENT_REQUIREMENTS.md`, `RUNNING.md`, 本書、親ディレクトリの`TODO.md` | 新研究条件と実装状況の整合 |

未実装・要検討: 実写真での閾値校正、人物・関節推定精度、左右反転補正、3D身体方向・関節角の推定、ちらつき抑制、モデル常駐化、解析失敗時の再解析UI、時計同期、iOS表示ログの永続送信キュー、高度な統計解析（独立評価・試行アンケート・JSON条件順・CSV Export・品質レポートは実装済み）。静止画ごとの同期Python起動は引き続きNodeのイベントループを占有するため、解析中のライブ遅延は実機測定する。

新規学習・LLM・美的評価・音声・リアルタイム動画解析・複数人支援・大規模UI変更は行っていない。
