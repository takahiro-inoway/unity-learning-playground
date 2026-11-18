# Unity学習プレイグラウンド

Unity初心者が、ブラウザで3Dシーンの基本操作を体験できる静的な学習用アプリです。Three.js を使い、シーンの表示、プリミティブの追加、Transform の編集、再生・停止を行えます。

## 起動

`index.html` をブラウザで開くか、ローカルの静的HTTPサーバーでこのフォルダーを配信してください。Three.js は jsDelivr から読み込むため、実行時にインターネット接続が必要です。

## GitHub Pages への公開

リポジトリの **Settings → Pages → Build and deployment → Source** で **GitHub Actions** を選択してください。`main` ブランチへの push で公開ワークフローが実行されます。

シーン内の作成したメッシュはブラウザの localStorage に保存されます。別のブラウザや端末には共有されません。
