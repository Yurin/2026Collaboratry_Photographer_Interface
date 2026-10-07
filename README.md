# 協調的写真撮影インタフェース

参照写真を再現する人物撮影で、撮影者の構図調整と被写体のポーズ調整を支援するiOS＋Webシステムです。

研究課題は「役割別支援の有無と、一括提示／優先順位に基づく段階的提示が、参照再現精度と調整過程に与える影響」。B/Cはともに写真評価後の撮り直し決定時に指示を提示し、撮影前・中・後のTiming比較ではありません。撮影→解析→調整→再撮影のサイクルで、ガイドのみ／全役割別指示／段階的役割別指示を比較します。

- [計画登録・短縮アンケート・分析用出力の運用手順](docs/study-design-implementation.md)
- [本実験のデータ保全・Export・開始前チェック](docs/research-operations.md)
- [参加者主導の実験フロー・準備・検証結果](docs/participant-experiment-flow.md)
- [実行方法](RUNNING.md)
- [現在の機能と制約](REQUIREMENTS.md)
- [実験要件・条件](EXPERIMENT_REQUIREMENTS.md)
- [Progressive Guidanceの設計・ログ・変更一覧・検証](docs/progressive-guidance.md)

新しい実験は新規セッションで実施してください。旧条件の記録とは`guidanceProtocolVersion`で区別します。

iOSホームの「ユーザ実験を開始・再開」から、事前定義した計画に沿って練習・撮影・双方の独立評価・再撮影・アンケート・全試行終了まで進められます。研究者は事前に参照画像・補正姿勢・ペア別JSON計画を準備します。リポジトリの計画は雛形のみです。実機2台の無介助パイロットは未実施です。

参加者実験はTTL削除対象外です。`npm --prefix backend run export:experiment-data` / `backup:experiments` / `check:experiment-ready`で出力・保全・準備確認ができます。途中辞退と両端末の参加情報リセットを実装済み。Ready表示は既定falseです。現環境は有効な実験計画が未準備のため、pilot / main studyとも開始判定はNOです。
