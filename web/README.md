# Cleavry — 透過処理エディタ

ブラウザ完結の透過処理ツール。AI 背景除去、連結成分分離、手動仕上げ。

このディレクトリは Vite + TypeScript ベースの開発環境です。
元は `Geppo/tools/eraser.html` 単一ファイルだった実装を、ビルドツール越しに動かせる形へ移植したものです。本格的な分割・型強化は次フェーズで行います。

## Dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Typecheck

```bash
npm run typecheck
```

## 構成

- `index.html` — エントリ HTML（DOM・SVG sprite）
- `src/main.ts` — アプリ本体（旧 `<script>` の中身）
- `src/styles.css` — スタイル（旧 `<style>` の中身）
- `public/manifest.webmanifest` — PWA マニフェスト
- `public/sw.js` — Service Worker
