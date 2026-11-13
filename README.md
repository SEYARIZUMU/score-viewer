# 楽譜ビューア（ScorePDF風 PWA）

iPhoneのホーム画面に追加して使う楽譜PDFビューアです。Windowsだけで開発・公開できます。

## 機能
- PDFの取り込み（複数選択可）。Googleドライブは iPhone の「ファイル」画面から選択
- タップ（左右）・スワイプでページめくり、中央タップでメニュー表示
- Bluetoothページめくりペダル対応（→ ↓ PageDown Space / ← ↑ PageUp）
- 横向きで見開き表示（1ページ送り / 2ページ送りを切替可）
- ページの並べ替え・複製・非表示（PDF本体は変更しない）
- 書き込み（ペン3色・蛍光ペン・消しゴム・太さ切替・元に戻す）
- セットリスト（曲の最後から次の曲へ続けてめくれる）
- 前回のページから再開 / 表示中はスリープしない / オフライン動作

## ファイル構成
```
index.html            画面の骨組み
style.css             見た目
app.js                アプリ本体（保存・表示・書き込みなど）
sw.js                 オフライン用のキャッシュ（Service Worker）
manifest.webmanifest  ホーム画面に追加したときのアプリ情報
icons/                アプリアイコン
```

## 公開手順（GitHub Pages・無料、gitコマンド不要）
PWAとしてホーム画面に追加するには HTTPS で公開する必要があります。

1. https://github.com でアカウントを作り、右上の「＋」→「New repository」
   - 名前は例えば `score-viewer`、Public を選んで「Create repository」
2. 作ったリポジトリで「uploading an existing file」をクリックし、
   このフォルダの中身（index.html など全部と icons フォルダ）をドラッグ＆ドロップ →「Commit changes」
3. リポジトリの「Settings」→ 左メニュー「Pages」
   - Source: 「Deploy from a branch」、Branch: `main` / `/(root)` →「Save」
4. 1〜2分待つと `https://<ユーザー名>.github.io/score-viewer/` で開けるようになります

## iPhoneでの使い方
1. iPhoneの **Safari** で上のURLを開く
2. 共有ボタン →「ホーム画面に追加」
3. ホーム画面のアイコンから起動（全画面で動きます）
4. Googleドライブを使う場合：iPhoneに「Google ドライブ」アプリを入れてログイン →
   アプリの＋ →「ブラウズ」→「…」→「編集」で「ドライブ」をオン

## 修正して更新するとき
1. ファイルを編集して、GitHubに同じ名前でアップロードし直す
2. **sw.js の `VERSION`（例: `score-viewer-v1` → `v2`）を必ず変える**
   （変えないと、iPhone側に古いキャッシュが残ることがあります）
3. iPhoneでアプリを一度閉じて開き直す

## Windowsで動作確認するとき
フォルダでターミナルを開き、
```
python -m http.server 8000
```
を実行して、PCのブラウザ（Chrome / Edge）で http://localhost:8000 を開きます。
F12 → デバイスツールバーで iPhone サイズにすると見た目も確認できます。

## 注意
- 楽譜データは iPhone の Safari（ホーム画面アプリ）内に保存されます。
  別の端末やブラウザとは共有されません。元のPDFはGoogleドライブに残しておいてください。
- iOS は長期間使わないWebアプリのデータを消すことがあります。ホーム画面に追加して使うと消えにくくなります。
