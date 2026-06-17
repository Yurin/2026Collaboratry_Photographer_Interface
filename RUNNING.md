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

仮想環境の Python を使う場合:

```sh
cd 2026Collaboratry_Photographer_Interface/backend
PYTHON=.venv/bin/python npm start
```

## 3. backend サーバーを起動する

```sh
cd 2026Collaboratry_Photographer_Interface/backend
npm start
```

デフォルトでは `http://localhost:3000` で起動します。`PORT` を指定するとポートを変更できます。

```sh
PORT=3001 npm start
```

起動後、確認用 URL は以下です。

```text
http://localhost:3000/health
http://localhost:3000/?sessionId=test
```

## 4. iOS アプリを起動する

Xcode で以下のプロジェクトを開きます。

```text
2026Collaboratry_Photographer_Interface/photo2026/photo2026.xcodeproj
```

Xcode 上で `photo2026` scheme を選び、シミュレータまたは実機で実行します。

現在の iOS アプリは [Info.plist](photo2026/photo2026/Info.plist) の以下の値を参照します。

- `ServerBaseURL`
- `WebSocketBaseURL`

この URL が backend サーバーへ到達できる必要があります。未設定の場合、Swift 側のコードは `http://localhost:3000` とそこから導出した WebSocket URL を使います。

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
9. 撮影者 Web で写真を撮り、「送信」を押す。
10. iOS アプリの「受信写真」で送信された写真を確認・保存する。

## 7. 保存データ

backend に送られたファイルは以下に保存されます。

```text
2026Collaboratry_Photographer_Interface/backend/uploads/
```

サーバーは以下の削除機能を持ちます。

- 撮影者 Web の「削除」ボタンによるセッションデータ削除
- `DELETE /api/session/:sessionId` によるセッションデータ削除
- `SESSION_TTL_MS` 経過後の自動削除

自動削除の既定値は 6 時間、確認間隔の既定値は 10 分です。

```sh
SESSION_TTL_MS=21600000 CLEANUP_INTERVAL_MS=600000 npm start
```
