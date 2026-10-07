# 役割別提示方式実験の登録・実施・Export

本実験はparticipant-flow-v1 / progressive-v1を使用する。撮影前・中・後のTiming比較ではなく、A（視覚ガイドのみ）、B（未解決の役割別指示を一括表示）、C（役割ごとに優先度が高い未解決指示を最大1件表示）を比較する。B/Cの表示時点は双方の写真評価後、再撮影が決定した時点で共通。

## 実装済みと実機準備

練習C×1、本番A/B/C×2、役割固定、独立した写真評価、片方でもRetakeなら再撮影、双方Finishまたは最大5枚で終了する。新しいBlock質問やPractice条件は追加していない。実際の写真・補正Poseの登録、モデル準備、実機パイロットは別途必要。自動で架空の写真や本番データは作らない。

## 計画登録（サーバーのbackendディレクトリ）

1. 研究者画面で練習1枚・本番6枚の写真を登録し、Poseを確認・補正する。sourceSessionIdとreferenceImageIdを控える。肩・腰と解析対象関節が観測可能な写真を使う。
2. 以下で設定雛形をコピーし、REPLACE値を実在するIDに置換する。pairIdsは参加ペア一覧、studyIdは研究／パイロットを区別するID。練習写真は本番と別。referencesの先頭2枚／中間2枚／最後2枚がS1/S2/S3で、難易度の構成をそろえる。

```sh
cp experiment_design/study.example.json experiment_design/pilot01.json
# pilot01.jsonを編集
npm run register:experiment-plans -- --spec experiment_design/pilot01.json
```

既定の登録先はEXPERIMENT_PLAN_DIR、未指定時はbackend/experiment_plans。`--root /path/to/uploads`、`--out /path/to/plan-directory`で変更可能。写真・参照Poseの検証に失敗したら、計画は一件も書き出さない。既存のペア番号、planId、同一研究の割当枠、既存ファイルは上書きしない。画像のデコードや骨格PNG生成の可否は下記readinessで追加確認する。

3. 計画JSONと割当CSVを確認する。計画は毎回APIが読み込むため、計画追加だけなら再起動不要。質問設定を変更した場合はバックエンド再起動が必要。

```sh
npm run check:experiment-ready
curl -s https://photo-interface.com/api/participant-experiments/plans
```

`available: true`を確認してiOSでペア番号を入力する。撮影者は参加QRから参加する。参照元の通常セッションはTTL削除され得るため、本番前の準備データ保持・バックアップを運用する。開始済みの参加者実験では参照画像・計画・Guidance設定を固定する。

## 割当方式

O1〜O6はABC/ACB/BAC/BCA/CAB/CBA。各文字は同じ条件の連続2trial。M1〜M3は写真組S1/S2/S3を条件間で循環させる。18枠で6条件順×3写真割当を網羅し、各写真は各条件に6回割り当たる。組内写真順も反転する。18は割当単位で、必要サンプル数の根拠ではない。

pairIdsの順にstartSlot（0始まり）から割当。追加募集時は未使用のstartSlotとペア番号を使う。18未満・端数は警告が出るため割当CSVの偏りを確認する。ペア番号と参加枠の対応は事前に決め、結果を見て割り当て直さない。パイロットと本番は別のstudyIdとpairIdを使用する。

## 質問と説明

role-aware-trial-v2: Aは4問（難易度、修正の明確さ、協力しやすさ、精神的負担）、B/Cはさらに指示の有用性・量・邪魔さ・提示方法の明確さの4問。自由記述は任意。撮影ごとのSimilarity/Satisfaction/Retakeは維持。最終評価の重複質問とTiming質問を省いた。設定は開始時に保存され、既存セッションは旧質問のまま進む。ExportのquestionnaireVersionで識別する。

研究者はA/B/Cすべての画面形式を説明し、練習では撮影→独立回答→Retake→指示確認→再撮影を経験させる。練習は分析から除外。Cだけを練習する学習効果はパイロットで確認する。役割は交代しない。通常の会話は許可するが、回答数値やRetakeを送信前に相談しないよう説明する。条件ブロック間の休憩は次のtrial開始前に行う。

## 分析出力

```sh
npm run export:experiment-data
```

- capture-level.csv: 位置・サイズ・ポーズの誤差、役割別評価、評価差、mutualFinish、limitReached、questionnaireVersion。
- trial-level.csv: 最終center/scale/pose誤差、初回−最終の改善量、撮影枚数、合意終了・上限到達・合意未観測、質問版、研究ID、条件順、写真割当。
- guidance-progress.csv: 指示候補別の前後誤差・改善・解決・悪化・前回選択の有無。提示された指示として分析するときはwasSelectedだけでなく表示ログも確認する。
- questionnaire-responses.csv / questionnaire-level.csv: 質問版を含む両者の回答。
- data-quality-report.json: 欠測・解析失敗・不完全セッション等。

completionReasonは既存仕様を維持し、上限と合意が同時でもmaximum_capture_count。mutualFinishは実回答から独立に計算し、limitReachedとは分離。capturesToMutualFinishは合意時のtrial内枚数（セッション通算captureSequenceではない）。上限で未合意はmutualFinishCensored=true。欠測はnull、CSVでは空欄。失敗した解析値を成功値として集計しない。初回1枚で終了した場合の改善量は、有効な解析があれば0。

compositionErrorは未定義のままで、架空の総合値を追加しない。主要評価は最終centerError/scaleError/poseErrorを個別に用いる。totalErrorは支援用閾値で正規化した補助値。練習と中断、欠測の扱いを事前に固定し、同じペア内の試行・両者の回答を独立標本とみなさない。

## 時間の定義

すべてサーバー状態遷移時刻の区間であり、通信・離席を完全に除いた身体動作時間ではない。

| 列 | 区間 |
|---|---|
| captureAdjustmentMs | capture状態の合計 |
| guidanceReviewMs | guidance状態の合計（Aは一般案内） |
| analysisCommunicationMs | analyzing状態の合計（送信待ちも含む） |
| evaluationMs | photoEvaluation状態の合計（相手待ちも含む） |
| questionnaireMs | trialQuestionnaire状態の合計 |
| humanOperationMs | captureAdjustmentMs + guidanceReviewMs |
| trialDurationMs | trial開始から最終評価で終了決定まで。アンケートを除く |

完全な連続ログがない場合、区間合計は空欄、timingComplete=false。撮影要求失敗・再送によるcapture/analyzingの往復も含む。端末時刻のcaptureTimestamp差を操作時間の代わりに使わない。

## 本番前の確認

2〜3ペアのパイロットで、6trialの疲労、5枚到達率、刺激難易度、指示理解、練習Cの偏り、回答負担、HTTPS/WSS、通信切断と再開、保存・Exportを確認する。本番では参照写真、補正Pose、モデル・コード版、閾値、割当、質問版、撮影上限、Ready非表示を固定する。コード変更はローカル実装であり、サーバーへの配置と再起動は別作業。
