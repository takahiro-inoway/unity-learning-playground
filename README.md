# Unity学習プレイグラウンド

ブラウザ上でシーンを組み立て、簡単な3Dゲームとして実行できるUnity入門用プレイグラウンドです。描画には Three.js を使用します。

## できること

- Cube、Sphere、Player、Platform、Coin、Goal、Hazard などの作成
- Transform とマテリアル色、コンポーネントの編集
- 位置・回転・サイズの編集、削除、Undo / Redo
- Player Controller、Rigidbody、Collider、Collectible、Goal、Hazard の動作
- WASD / 矢印キーでの移動、Space でのジャンプ、コイン収集とクリア判定
- シーンのブラウザ内保存、JSON の読み書き、シーンを含む共有リンクの作成

初回はコイン集めゲームのテンプレートを読み込んでいます。「ゲームテンプレート」でいつでもサンプルを作り直せます。

## 起動

`index.html` をブラウザで開くか、ローカルの静的HTTPサーバーでこのフォルダーを配信してください。Three.js は jsDelivr から読み込むため、実行時にインターネット接続が必要です。

## GitHub Pages への公開

リポジトリの **Settings → Pages → Build and deployment → Source** で **GitHub Actions** を選択します。`main` ブランチへの push で公開ワークフローが実行されます。

シーンの自動保存はブラウザの localStorage に保持されます。JSON ファイルと共有リンクを使って、別のブラウザや端末へシーンを移せます。
