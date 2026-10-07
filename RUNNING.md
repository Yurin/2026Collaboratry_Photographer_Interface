# 実行方法

## 前提

- Node.js と npm が利用できること
- Python 3 が利用できること
- iOS アプリを起動する場合は Xcode が利用できること
- スマートフォン実機から使う場合、iOS アプリと撮影者 Web が backend サーバーへ到達できること

## 1. backend の依存関係を入れる

```sh
cd 2026Collaboratry_Photographer_Interface/backend
npm install
```

## 2. ガイド生成用 Python 依存関係を入れる

```sh
cd 2026Collaboratry_Photographer_Interface/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r guide_processor/requirements.txt
```

backend は `PYTHON` 環境変数が指定されていればそれを使い、指定がなければ `python3` で `guide_processor/generate_guide.py` を実行します。

シルエット生成は既定で `yolo11s-seg.pt` を使用します。初回実行時にUltralyticsからモデル（約20 MB）を自動取得するため、サーバーに外部通信がない場合は事前に重みを配置し、`YOLO_SEG_WEIGHTS`でパスを指定してください。

仮想環境の Python を使う場合:

```sh
cd 2026Collaboratry_Photographer_Interface/backend
PYTHON=.venv/bin/python YOLO_SEG_WEIGHTS=yolo11s-seg.pt npm start
```

## 3. backend サーバーを起動する

```sh
cd 2026Collaboratry_Photographer_Interface/backend
npm start
```

デフォルトでは `HOST=127.0.0.1`、`http://localhost:3000` で起動します。LAN端末から直接アクセスする場合は `HOST=0.0.0.0 npm start` で起動してください。スマートフォンブラウザのカメラ利用にはHTTPSが必要なため、実機撮影ではHTTPSのリバースプロキシ等を使用します。`PORT` を指定するとポートを変更できます。

```sh
PORT=3001 npm start
```

起動後、確認用 URL は以下です。

```text
http://localhost:3000/health
http://localhost:3000/?sessionId=test
```

> 本番環境では Node.js バックエンドを `127.0.0.1:3000` などの内部のみで待ち受けさせ、外部公開は Nginx のリバースプロキシ経由で `https://photo.example.com` を使います。公開側で必要なポートは `22`, `80`, `443` のみで、`3000` は外部に公開しない構成としてください。

## 4. iOS アプリを起動する

Xcode で以下のプロジェクトを開きます。

```text
2026Collaboratry_Photographer_Interface/photo2026/photo2026.xcodeproj
```

Xcode 上で `photo2026` scheme を選び、シミュレータまたは実機で実行します。

現在の iOS アプリは [Info.plist](photo2026/photo2026/Info.plist) の以下の値を参照します。

- `ServerBaseURL`
- `WebSocketBaseURL`

接続先は iPhone / iPad の「設定」アプリから `photo2026` を開いて変更できます。

- サーバーURL: `http://MacのローカルIP:3000`
- WebSocket URL: 通常は空欄でよい。サーバーURLから自動生成される

設定変更後は `photo2026` アプリを終了して再起動してください。未設定の場合は `Info.plist` の値、さらに未設定なら `http://localhost:3000` を使います。シミュレータでは localhost を利用できますが、実機ではMacのローカルIPを指定する必要があります。

## 5. 撮影者 Web を開く

iOS アプリの撮影画面で表示される QR コードを撮影者側スマートフォンで読み取ります。

手動で開く場合は、backend 起動後に以下の形式でアクセスします。

```text
http://localhost:3000/?sessionId=任意のセッションID
```

撮影者 Web は `sessionId` を使って、ガイド画像の受信、ライブ映像共有、写真送信、保存データ削除を行います。

## 6. 基本的な利用手順

1. backend サーバーを起動する。
2. iOS アプリを起動する。
3. iOS アプリの「ガイド作成」で参照写真を選び、ガイドを生成・保存する。
4. 「ガイド表示」で使うガイドを選択し、「このガイドで撮影」を押す。
5. iOS アプリの撮影画面に表示された QR コードを撮影者側スマートフォンで開く。
6. 撮影者 Web でカメラを許可し、「ライブ共有」を押す。
7. iOS アプリ側で撮影者 Web から送られるライブ映像を確認する。
8. 必要に応じて iOS アプリ側で撮影者へ送るガイド種類、透明度、左右位置、大きさを調整する。
9. 撮影者 Web で写真を撮る。保存済みガイドが選択されている場合は、撮影直後に解析結果が表示される。
10. 必要な写真を選び終えたら「送信」を押す。
11. iOS アプリの「受信写真」で送信された写真を確認・保存する。

## 7. 実験モードの利用手順

現在の実験モードでは、条件A/B/Cの切り替え、試行単位の操作ログ、撮影直後解析、Web/iOS表示時刻、Ready遷移を保存できます。

1. iOS アプリの「実験」タブを開く。
2. 実験者PINを入力する。開発時の既定値は `2026`。
3. `participantId`、`pairId`、`referenceImageId`、条件を入力する。
4. 「実験セッションを作成」を押す。
5. 「関節点を抽出・補正する」で参照写真を確認・保存する。
6. 「試行を作成」を押す。
7. 「試行を開始して撮影画面へ」を押す。
8. 表示されたQRコードを撮影者側で開く。
9. 撮影・調整・再撮影・送信を行う。
10. 実験タブへ戻り、「試行を完了」または理由を入力して「試行を中断」を押す。

新規実験は `progressive-v1` です。試行作成の前に「関節点を抽出・補正する」で参照姿勢を確認・保存してください。試行作成時の姿勢版と設定が固定され、同じ参照写真・補正骨格ガイドを両端末で使用します。

- 条件A: 視覚ガイドのみ。自動解析の候補・誤差・Readyはサーバーログだけに保存。
- 条件B: 各端末へ、その役割の全未解決候補を提示。
- 条件C: 各端末へ、その役割の最優先1件を提示。再撮影すると解決済みを除外して更新。

ライブ映像・ガイド・参照写真は全条件共通です。実験中のガイド位置・拡大率は固定します。補正をやり直した場合は、新規試行を作って採用してください。古いセッションは旧条件のままです。新研究には新規セッションを使います。

通常モードは全候補表示です。テンプレートや旧形式等でReferenceGuideがない場合は解析をスキップし、写真の保持・送信を継続します。写真は「送信」までドラフトで、iOSの受信写真一覧には表示されません。ライブ解析の定期送信は未接続です。

優先度・閾値・ログ・実機チェックは [実装・評価ガイド](docs/progressive-guidance.md) を参照してください。設定ファイルの既定値は `backend/guide_processor/guidance_config.json`、上書きは `GUIDANCE_CONFIG=/absolute/path/to/config.json`。新規試行へ設定全体を保存するので、変更後は新規試行を作ってください。

撮影ごとに`clientId`、`captureSequence`、`captureTimestamp`を付与し、解析ごとにバックエンドが`analysisId`を発行します。Web/iOSは`captureSequence`が古い解析結果、現在のtrialまたはguideと一致しない結果を表示しません。

実験データは以下へ保存されます。

```text
backend/uploads/<sessionId>/experiment/
├── session.json
└── trials/<trialId>/
    ├── trial.json
    └── events.jsonl
```

撮影後解析の中間結果は以下へ保存されます。

```text
backend/uploads/<sessionId>/analysis/
├── observations/<photoId>.json
└── role_guidance/<photoId>.json
```

### 7.1 実験ログの確認

試行イベントは`backend/uploads/<sessionId>/experiment/trials/<trialId>/events.jsonl`へ1行1JSONで追記されます。主なイベントは次のとおりです。

- `photo_captured`
- `photo_draft_save_started` / `photo_draft_save_completed`
- `role_guidance_analysis_started`
- `analysis_started_received`
- `role_guidance_analyzed` / `role_guidance_analysis_failed`
- `analysis_completed_received` / `analysis_failed_received`
- `photographer_guidance_displayed`
- `subject_guidance_displayed`
- `ready_state_changed`

計測用時刻はepoch millisecondsです。イベント共通の`clientTimestamp`と`serverTimestamp`はISO 8601です。通常モードでtrialがない場合、Webログはブラウザの`localStorage`に`photoGuideLocalLogs:<sessionId>`として最大1,000件保存され、iOSの被写体向け表示ログはXcodeコンソールへ`ExperimentLog`として出力されます。

ログから次の遅延を計算できます。

```text
analysisStartTimestamp - captureTimestamp
analysisEndTimestamp - analysisStartTimestamp
webGuidanceDisplayTimestamp - captureTimestamp
subjectGuidanceDisplayTimestamp - captureTimestamp
subjectGuidanceDisplayTimestamp - analysisEndTimestamp
```

新条件B/Cは両端末の表示ログを記録します。Aは表示ログを生成しません。Ready遷移は初回値を基準として保持し、`false → true`または`true → false`に変化した場合だけ`ready_state_changed`を記録します。

## 8. 保存データ

backend に送られたファイルは以下に保存されます。

```text
2026Collaboratry_Photographer_Interface/backend/uploads/<sessionId>/
├── drafts/
├── photos/
├── references/
├── guides/
├── analysis/
└── experiment/
```

過去バージョンでセッション直下へ保存されたファイルも引き続き読み込めます。受信写真APIは `photos/` と旧形式の撮影写真だけを返し、参照画像・ガイド画像を除外します。

撮影者Webは撮影直後に `POST /api/sessions/:sessionId/draft-photos` で写真を `drafts/` へ保存します。個別削除と一括クリアは `DELETE /api/sessions/:sessionId/draft-photos/:photoId` を使います。「送信」時に `POST /api/sessions/:sessionId/photos/share` で画面に残っているドラフトだけを `photos/` へ移動し、その時点でiOSへ更新通知を送ります。

サーバーは以下の削除機能を持ちます。

- 撮影者 Web の「削除」ボタンによるセッションデータ削除
- `DELETE /api/session/:sessionId` によるセッションデータ削除
- 通常セッションは`SESSION_TTL_MS`経過後の自動削除（参加者実験は除外）

iOSの「撮影を終了」は `POST /api/session/:sessionId/end` によりWebへ終了を通知し、撮影・ライブ共有を停止します。終了状態はサーバーに保存され、Web再接続時にも再通知されます。写真・実験ログは削除しません。試行の完了／中断は実験タブで別途記録します。

通常セッションの自動削除の既定値は 6 時間、確認間隔の既定値は 10 分です。

```sh
SESSION_TTL_MS=21600000 CLEANUP_INTERVAL_MS=600000 npm start
```

## 8.1 参加者主導の実験

iOSホームの「ユーザ実験を開始・再開」を使用します。研究者向け実験タブで参照姿勢を準備した後、`backend/experiment_plans/example.example.json`を別名のJSONへコピーし、実在するsourceSessionId/referenceImageId、ペア番号と条件順を設定します。雛形のままでは開始一覧に出ません。

撮影者は参加QRから入り、双方が画面に従って練習→本番→独立写真評価→再撮影／試行アンケート→全試行完了と進みます。このモードでは最終写真が自動共有されます。質問と上限は`backend/experiment_flow_config.json`。詳細な準備、API、復旧、保存データ、未確認項目は [参加者実験フロー](docs/participant-experiment-flow.md) を参照してください。参加者実験の写真・ログはTTL対象外です。未開始計画の参照準備元は通常TTL対象なので準備期間に合わせて設定してください。研究データはバックアップCLIで別媒体へ保管します。

## 9. 自動テストと確認範囲（2026年10月5日）

プロジェクト直下で次を実行できます。Pythonは依存関係を入れた仮想環境を使います。

```sh
npm --prefix backend run test:session-flow
npm --prefix backend run test:guidance
npm --prefix backend run test:participant-flow
npm --prefix backend run test:research-operations
backend/.venv/bin/python -m unittest discover -s backend/guide_processor -p 'test_*.py'
```

今回、既存セッション連携、追加のProgressive Guidance連携・Web表示・ポリシーテスト、Python24件、Node/Web構文チェック、iOS Simulator向けビルドに合格しました。Swift単体テスト6件と既存UIテスト6実行も合格しました。参加者フローの練習＋本番6試行完走・回答非公開・重複送信・回答待ち中のサーバー再起動も検証済みです。実機E2E・実モデル精度評価は未実施です。`test:guidance` は既定で `backend/.venv/bin/python` を使い、`TEST_PYTHON` で変更できます。

## 10. 本実験の準備・Export・バックアップ

backendディレクトリで以下を実行します。

```sh
PYTHON=.venv/bin/python npm run check:experiment-ready
npm run summary:experiments
npm run export:experiment-data
# バックアップ前にサーバーを停止する
npm run backup:experiments
```

出力列、データ品質の判定、保存先変更、管理API、辞退・ペア切替、検証結果は [研究運用仕様](docs/research-operations.md) を参照してください。Readyの参加者表示は`showReadyToParticipants=false`が既定です。現在は実写真を割り当てた計画がないため開始前チェックはFAILです。
