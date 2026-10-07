# 本実験のデータ保全・Export・運用確認

更新日: 2026-10-05。研究条件・Guidance計算は`progressive-v1`のまま。参加者の画面進行は`participant-flow-v1`を維持し、運用・データ収集機能を追加した。

## 1. 保存先とTTL対策

**方法A（参加者実験をTTL削除対象外とする）を採用。** 正本は従来どおり`backend/uploads/<sessionId>/`。`experiment/retention.json`を試行準備前に作成し、`flow.json`またはparticipant flowのsessionメタデータがある既存セッションも保護する。完了・辞退・技術的中断・開始途中の失敗を問わず保持する。通常セッションの既定6時間のcleanupは維持する。

旧APIからの管理対象セッション削除・変更も拒否する。参照画像・固定ガイドは実験開始時にコピー済みなので、開始後に準備元が期限切れになっても研究セッションの参照は残る。**未開始の計画が参照する準備元セッションは通常TTLの対象**。開始前チェックで不足を検出するため、準備元も保存期間を調整する。

データ構造:

```text
uploads/<sessionId>/
├── references/                         # 固定参照画像
├── guides/                             # PNG・ReferenceGuide features
├── drafts/                             # 全撮影写真
├── photos/                             # 各trialの最終写真
├── analysis/history/<analysisId>.json
└── experiment/
    ├── retention.json
    ├── session.json
    ├── experiment-plan.json
    ├── flow.json                       # 質問・Ready設定・役割トークンを含む
    ├── data-quality-report.json
    └── trials/<trialId>/
        ├── trial.json
        ├── guidance-config.json
        ├── evaluations/capture_<sequence>.json
        ├── questionnaire.json
        └── events.jsonl
```

TTL除外はバックアップの代替ではない。ディスク故障、手作業の削除、空き容量不足は別途管理する。ファイル単位のatomic renameは利用するが、複数ファイルをまたぐ更新のトランザクション保証はない。プロセス強制終了などで残った不整合は品質検査で確認し、正本を保管したうえで扱う。

## 2. バックアップ

backendディレクトリで実行する。運用サーバーを停止し、書込みがない状態で実行する。

```sh
npm run backup:experiments
# 保存先を変える場合（uploadsの外を指定）
npm run backup:experiments -- --out /absolute/path/to/backup-volume
```

既定は`backend/research-backups/<日時-PID>/`。保護対象の全セッションをディレクトリごとコピーする。計画・flow・trial・評価・アンケート・events・解析履歴・全ドラフト・最終写真・参照画像・固定Guidance設定を含む。`manifest.json`にファイル名・バイト数・SHA-256を保存する。コピー後に元ファイルの増減・ハッシュ差を検査し、途中変更を検出したら失敗する。その場合の出力先は不完全なバックアップなので採用しない。正常終了したmanifestを持つバックアップを別媒体にも保管する。

フォルダは0700、ファイルは0600で作成する。バックアップには役割トークンと自由記述が含まれる。リポジトリの`.gitignore`に既定の出力先を追加済み。復旧する場合はサーバーを停止して対象セッションのディレクトリを正本の保存先へ戻し、summaryとExportで内容を検査する。

## 3. Exportとサマリー

```sh
npm run export:experiment-data
npm run export:experiment-data -- --out /absolute/path/to/exports
npm run summary:experiments
```

既定の出力先は`backend/research-exports/<日時-PID>/`。`RESEARCH_EXPORT_DIR`、`RESEARCH_BACKUP_DIR`でも変更できる。CLIの`--root /absolute/path/to/uploads`でバックアップ等の別の研究データを読み込める。正本配下への出力は拒否する。

次をまとめて生成する。

- `capture-level.csv`: 1行1撮影。アップロード未完了の予約は撮影として数えず、品質レポートに警告する。
- `trial-level.csv`: 1行1試行。練習も含み`isPractice`で区別する。
- `questionnaire-level.csv`: 1行1試行・1回答者。質問ごとの`answer:<questionId>`列を持つ。
- `questionnaire-responses.csv`: 追加の縦持ち形式。1行1質問回答。
- `data-quality-report.json`: セッション別の件数・状態・問題一覧。

CSVはUTF-8 BOM付き、カンマ・引用符・改行をエスケープする。表計算ソフトの式として解釈され得る文字列には先頭にアポストロフィを付ける。正本JSONは変更しない。欠損は空欄で、0や平均値で補わない。実験が進行中の場合は途中時点のExportとなる。確定分析用のExportは書込みを止めた状態で実行する。

## 4. capture-level.csvの列

```text
participantPairId
sessionId
trialId
trialIndex
isPractice
conditionId
guidanceProtocolVersion
flowProtocolVersion
referenceImageId
captureSequence
photoId
analysisId
captureTimestamp
analysisStatus
analysisFailureReason
compositionError
centerError
scaleError
poseError
totalError
framingReady
poseReady
captureReady
photographerSimilarity
subjectSimilarity
similarityGap
photographerSatisfaction
subjectSatisfaction
satisfactionGap
photographerWantsRetake
subjectWantsRetake
nextAction
completionReason
photographerGuidanceCount
subjectGuidanceCount
guidanceToNextCaptureMsPhotographer
guidanceToNextCaptureMsSubject
```

## 5. trial-level.csvの列

```text
participantPairId
sessionId
trialId
trialIndex
isPractice
conditionId
referenceImageId
trialStartTimestamp
captureEndTimestamp
trialEndTimestamp
captureCount
retakeCount
guidanceDisplayCount
completionReason
finalPhotoId
finalCaptureSequence
finalCompositionError
finalPoseError
finalTotalError
finalPhotographerSimilarity
finalSubjectSimilarity
finalSimilarityGap
finalPhotographerSatisfaction
finalSubjectSatisfaction
finalSatisfactionGap
analysisFailureCount
missingEvaluationCount
```

## 6. アンケート形式

両形式の共通列:

```text
participantPairId
sessionId
trialId
conditionId
role
questionId
response
submittedAt
```

`questionnaire-level.csv`の`questionId`は回答した質問IDのJSON配列、`response`はID→値のJSONオブジェクト。加えて各`answer:<questionId>`列へ値を展開するので、人手のpivotは不要。自由記述は`freeText`として出力する。`questionnaire-responses.csv`では`questionId`と`response`が1つの質問と回答を表す。B/Cのみの質問はAの行で空欄になる。

## 7. 結合・指標の定義

`trialId`→撮影評価の`captureSequence`→`analysisId`で履歴を結合する。解析側のtrialId・photoId・captureSequence・analysisId・conditionIdに保存済みの不一致があれば、その解析値を採用せず問題として報告する。最終値はtrialの`finalCaptureSequence`で特定する。

- `compositionError`: 保存済みの同名値がある場合のみ出す。現行`progressive-v1`は構図の単一合算値を定義していないため通常空欄。代わりに`centerError`・`scaleError`も出す。研究指標を新しく合成していない。
- `poseError`・`totalError`・Ready: 保存済み解析結果から取得する。Ready非表示設定でもExportされる。
- `similarityGap`・`satisfactionGap`: 保存済みagreement値。欠損時に再計算して埋めない。
- `photographerGuidanceCount`・`subjectGuidanceCount`: 保存済み解析で選ばれた候補数。実際の表示回数とは区別する。
- `guidanceToNextCaptureMs*`: **その行の撮影後の指示から次撮影まで**。次の評価記録の`previousCaptureSequence`で逆引きする。表示のサーバー受信→次撮影予約のミリ秒であり、端末間時計補正済みの実時間ではない。
- `captureCount`: 保存済み写真を持つ評価記録数。評価ファイルが丸ごと失われても、保存済みphoto_capturedイベントがある撮影は空欄を含む行として出力する。
- `retakeCount`: 保存済みdecisionがretakeとなった回数。
- `guidanceDisplayCount`: 役割ごとのguidanceDisplays記録数。Aの一般的な再撮影案内も含む。
- `missingEvaluationCount`: 撮影ごとの未保存の役割回答数。両者欠損なら2。
- 撮影時刻は既存のUnixミリ秒、trial時刻は既存のISO 8601を維持する。推定で統一しない。

## 8. Data Quality Reportと終了サマリー

全実験完了・途中辞退・研究者による終了時に`experiment/data-quality-report.json`を自動生成する。CLI Export / summary、および管理APIでも再検査できる。

レポートはpairId、sessionId、本番予定数・完了数、練習状態、A/B/Cの試行数、撮影数、Retake数、解析失敗数、未保存の評価・アンケート数、最終解析欠損数、重複送信試行数、問題一覧を持つ。撮影数等は練習を含み、本番予定数と完了数は練習を除く。

| status | 意味 |
|---|---|
| complete | 全本番完了・重大な欠損や警告なし |
| complete_with_warnings | 完了しているが解析失敗等の警告あり |
| incomplete | 進行中、必要記録の欠損、重複レコード、不一致等 |
| technical_failure | 研究者が技術的理由で終了したもの |
| withdrawn | 参加者が辞退したもの |

researcher_terminatedは`experimentStatus`に保持し、完全性のstatusはincomplete。辞退・技術的終了は完全性より優先するためcompleted扱いにならない。

検査対象はfinalCaptureSequence、対応する評価・最終写真、analysis/history、双方評価、条件別必須アンケート、JSON/JSONLの可読性、重複trial・capture・event、plan/trial/analysisの条件整合。壊れたJSONや欠損があっても他の記録のExportを継続する。重複した実データは勝手に選別せず、該当行を残して問題を示す。`duplicateSubmissions`は拒否・無害化された再送の試行数であり、研究データの重複行数とは異なる。

## 9. 途中辞退

Web / iOSの「実験を中断する」→確認操作で、双方を終了画面へ進める。再開不可であることを確認画面に表示する。写真・回答等は削除しない。

`experimentStatus=withdrawn`、`completionReason=participant_withdrawal`を保存する。未完了trialは`state/trialStatus=incomplete`。その後の撮影・回答は拒否する。研究者は管理APIから`technical_failure`または`researcher_terminated`を指定できる。参加同意取得や同意撤回に伴う研究データ削除の方針そのものは別途研究計画で定める。

## 10. 別ペアへの切替

完了・中断後の「別のペアの実験を開始」で確認操作を行うと、サーバーに退出済みフラグを保存する。両端末は次回状態取得時にローカル情報を消す。オフライン端末でも復帰時に退出状態を受け取り、旧実験へ復帰しない。

Webは参加トークン、評価下書き、撮影系列・イベントのキャッシュ、メモリ上のphase/revisionを破棄し、トークンを含まないURLへ移動する。次のQRが必要。iOSはsession/token、開始再送用キー、下書き、現在phase、表示済み管理を消し、ペア番号入力へ戻る。接続先など無関係な設定、サーバー上の研究データは保持する。

開始時にはペア番号・本番回数・練習回数を表示し、「P03として実験を開始します」という確認を求める。条件名は表示しない。

## 11. Ready表示設定

`backend/experiment_flow_config.json`の`showReadyToParticipants`は既定false。開始時にflowへ固定する。falseの場合は状態APIのreadyをnullにし、両UIも明示的に設定を確認してReady文言を出さない。保存済み内部ReadyやGuidance選択は変更しない。旧flowで設定が未定義の場合も非表示。

## 12. 解析状態

参加者の撮影評価記録に`analysisStatus`を保存する。

- success: 解析が正常終了した。
- failed: 解析処理に失敗した。`analysisFailureReason`を保存する。
- not_available: 有効な観測誤差が得られない、または保存前の撮影予約を破棄した。
- pending: 処理途中の一時状態。Export時に残っていれば未完了として報告する。

解析が失敗しても写真評価へ進む。元の解析履歴の`completed`等は既存Guidanceの互換性のため維持し、古い評価レコードのcompletedもExport時にsuccessへ正規化する。画像モデル内部の部分的な推定失敗は既存のwarnings・null誤差にも残るので、successだけで全関節の観測成功を意味しない。

## 13. Plan Validationと管理API

開始前に全計画を検査する。planId/pairId、重複planId、練習、本番、上限1〜50、A/B/C、プロトコル、参照元、画像ファイル、ReferencePose/current.json、人物承認、左右の肩・腰の有効点、対象点、身体基準の長さ、ReferenceGuide変換を確認する。サーバーではPythonによるPNG生成も事前確認し、同じ参照・設定の成功結果をキャッシュする。

本番でreferenceImageIdが重複した場合はwarning。意図した再利用ならplanに`allowDuplicateReferences=true`を指定する。available=falseの詳細は参加者に出さず、研究者にはtrialIndex（0＝練習）と原因コードを返す。

以下は`RESEARCH_ADMIN_TOKEN`を設定した場合のみ有効。リクエストに`X-Research-Token`を付ける。未設定・不一致は403。トークンを参加者アプリや計画ファイルへ入れない。

| 方法 | パス | 内容 |
|---|---|---|
| GET | `/api/research/plans/validation` | trial別の不足・warningとavailable |
| GET | `/api/research/sessions/:sessionId/summary` | 品質レポートと終了サマリーを再生成 |
| POST | `/api/research/sessions/:sessionId/terminate` | `{"status":"technical_failure"}`等で終了 |

CSVとバックアップはローカルCLIのみ提供する。参加者用の認証で研究者データをダウンロードするAPIは設けていない。

## 14. 開始前チェック

```sh
cd backend
PYTHON=.venv/bin/python npm run check:experiment-ready
```

計画、参照画像、姿勢、有効点、ガイド描画、flow/guidance設定、正本・Export・backupへの書込み、Python依存関係、検出・姿勢・セグメンテーションのローカル重み読込、必要な実行設定を検査する。モデルを自動ダウンロードしない。結果をPASS/WARNING/FAILで表示し、FAILがあれば終了コード1。本実験を開始しない。

本作業環境の結果は **FAIL: 有効な実験計画なし**。設定、Python依存関係、3種類のモデル読込、各保存先への書込みはPASS。管理APIトークン未設定と実機パイロット未実施はWARNING。モデル読込PASSは実画像での認識精度・速度を保証しない。

## 15. パイロット診断ログ

trialのevents.jsonlへstate_transition、analysis_attempt/analysis_retry/analysis_result、重複送信、操作失敗、参加者退出、中断を追加した。Web / iOSのresume・WebSocket接続復旧・評価／アンケート送信失敗は許可したoperationとoutcomeのみ送る。既存の評価成功・アンケート成功・未保存再撮影・完了イベントも維持する。

診断イベントへ画像内容、回答本文、自由記述、任意のエラー文字列を送らない。自由記述は回答の正本とExportにのみ含める。通信が完全に切れている最中の診断失敗を必ず記録する永続送信キューは未実装。サーバーに到達した操作・復帰後の再接続記録から追跡する。

## 16. 変更ファイルと自動テスト

追加: `backend/research_data.js`、`experiment_tools.js`、`experiment_validation.js`、`test/research-data.test.js`、本書。

変更: `backend/experiment_flow.js`、`server.js`、`experiment_flow_config.json`、`.env.example`、`package.json`、参加者フロー3テスト、`photographer/participant-flow.js`と`script.js`、`ParticipantExperimentView.swift`、Swift単体テスト、`.gitignore`、READMEと要件・実行・既存設計文書。以前からの`ExperimentSetupView.swift`変更は保持した。

実行結果:

- Node既存session-flow / guidance: 合格。
- participant-flow: 練習＋6試行完走、独立回答、重複送信、Ready非表示、回答待ち再起動、途中辞退後のデータ保持、両端末リセット、管理API、完了時品質レポートに合格。
- research-operations: 3種CSV＋縦持ち質問回答、欠損継続、analysisId結合、不一致、未保存評価・アンケート、失敗分類、重複、バックアップSHA-256、研究TTL除外と通常TTL判定、計画検証に合格。
- Python24件: 合格。研究アルゴリズムを変更していない。
- iOS: Simulatorビルド、単体6件（状態消去を含む）、既存UIテスト6実行に合格。既存UIテストは起動・起動性能が中心で、全参加者操作のE2Eではない。

HTTP/WS試験は画像モデル推論をfixtureに置換する。実写真によるモデル精度と実機カメラの確認は別途必要。

## 17–18. 実機確認、残課題、投入判定

- 実参照写真と補正姿勢、ペア別の有効な計画を用意し、checkのFAILを解消する。
- 実機2台で、開始確認→QR→撮影→両者評価→再撮影→アンケート→完了→Exportを無介助で完走する。
- 回線断、再起動、アプリ再表示、解析失敗、アップロード再試行、辞退、別ペアへの切替を実機で試す。旧QR・旧端末が旧実験へ復帰しないことも確認する。
- CSVの研究指標定義、欠損の扱い、重複参照の意図、バックアップ媒体と復旧手順を研究者が確認する。
- Python同期解析中の通信遅延、実モデルの精度と処理時間、HTTPS/WSS・カメラ権限を測定する。
- 参加同意、途中辞退、保存期間と研究データ削除の運用を決定する。TTL除外後の研究データ削除は研究者の明示的な運用に委ねる。

```text
Ready for pilot: NO
Ready for main study: NO
```

現在の作業環境には有効な実写真割当計画がなく、開始前チェックがFAILのため、パイロット開始可能とは判定しない。計画準備とチェック合格後、実機パイロットへ進める実装・自動検証は揃っている。本実験はさらに無介助パイロット、データ確認、バックアップ復旧の確認を通過してから判断する。
