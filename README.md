# Cleavry

**ブラウザで完結する透過処理エディタ** — AI 背景除去 + 手動仕上げ。
画像は端末から外に出ません。広告もトラッカーもありません。

🔗 **[cleavry.com](https://cleavry.com)** で今すぐ試せます

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/chikubo)

---

## なぜ Cleavry?

| | 多くの背景除去サービス | **Cleavry** |
|---|---|---|
| 画像のアップロード先 | サーバーに送信 | **送信なし**（端末内で処理） |
| 広告 / トラッカー | あり | **なし** |
| 利用回数制限 | あり（無料は低解像度等） | **無制限** |
| アカウント登録 | 必要 | **不要** |
| 起動 | サインイン → 待機 | **URL を開いた瞬間に使える** |

ブラウザの WebGPU と最新の ML モデル（BiRefNet）で、**サーバーなしで AI 背景除去** が動きます。AI が誤って削った部分は手動の復元ブラシで元に戻せます。

## 主な機能

- **AI 背景除去** — ローカル GPU で実行、API 不要、画像は外部送信されません
- **消しゴム / 復元ブラシ** — サイズと硬度を自由に
- **マジックワンド / 復元ワンド** — 連続同色を一括処理
- **範囲指定** — ワンドの適用範囲を矩形で限定
- **ノイズ削除 / 自動ノイズ除去** — 連結成分単位で消し残しを一掃
- **縁ぼかし** — 保存時に毛先のジャギーを緩和
- **元画像比較** — 削った部分を半透明で確認
- **自動保存** — IndexedDB に編集状態を記録、再読み込みで復元
- **テーマ切替** — システム / ライト / ダーク
- **PWA** — オフラインでも動作

## 動作環境

- **推奨**: Chrome / Edge / Firefox の最新版（WebGPU 対応）
- **Safari**: 一部機能制限あり（AI 背景除去のみ非対応、その他は動作）

## スクリーンショット

> _準備中。ローンチ時に追加予定。_

## 技術スタック

| | |
|---|---|
| **フロントエンド** | Vite, TypeScript（一部 `@ts-nocheck` で段階移行中） |
| **AI 推論** | [@huggingface/transformers](https://github.com/huggingface/transformers.js) v4 + [BiRefNet 512](https://huggingface.co/onnx-community/BiRefNet_512x512-ONNX) (fp16, WebGPU) |
| **ファイル処理** | Canvas API, IndexedDB, [JSZip](https://stuk.github.io/jszip/) |
| **ホスティング** | Cloudflare Pages |
| **ドメイン** | お名前.com / Cloudflare DNS |

## リポジトリ構成

```
eraser-tool/
├── web/   # Cleavry 本体（Vite + TypeScript）
└── ml/    # ONNX モデル最適化スクリプト（Python、開発用途）
```

## 開発

### Web 本体

```bash
cd web
npm install
npm run dev          # 開発サーバー http://localhost:5173
npm run build        # 本番ビルド -> dist/
npm run typecheck    # TypeScript 型チェック
```

### ML スクリプト（オプション、開発用）

```bash
cd ml
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

詳細は `web/README.md` / `ml/README.md` を参照。

## サポート

Cleavry は完全無料で広告を載せていません。気に入ったら開発者にコーヒーを送ってサポートできます。

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/chikubo)

## ライセンス

[MIT License](./LICENSE) — Copyright © 2026 Sui Yamamoto

## Credits

- [Lucide](https://lucide.dev/) — アイコンセット (ISC)
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) by ZhengPeng7 — 背景除去モデル (MIT)
- [transformers.js](https://github.com/huggingface/transformers.js) by Hugging Face — ブラウザ内 ML 推論 (Apache 2.0)
- [JSZip](https://stuk.github.io/jszip/) by Stuart Knightley — ZIP 生成 (MIT or GPLv3)

---

## English

**Cleavry** is a browser-based transparency editor — AI background
removal plus hand-touchups, all running locally on your device. Your
images never leave your computer. No ads, no trackers, no signup.

Try it at **[cleavry.com](https://cleavry.com)**.

### Why?

Most background-removal services upload your image to a server, show
ads, limit your usage, and require an account. Cleavry does none of
those things — it runs a state-of-the-art ML model (BiRefNet) directly
in your browser via WebGPU, and the parts the AI gets wrong can be
fixed by hand with a restore brush.

### Built with

Vite, TypeScript, [@huggingface/transformers](https://github.com/huggingface/transformers.js),
[BiRefNet](https://huggingface.co/onnx-community/BiRefNet_512x512-ONNX).
Hosted on Cloudflare Pages.

### Support

If Cleavry has saved you time on a cutout, an avatar, or a product
photo, [a coffee](https://buymeacoffee.com/chikubo) keeps it ad-free
and tracker-free.
