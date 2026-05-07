# eraser-tool / Cleavry

ブラウザ完結の透過処理エディタ。AI 背景除去・連結成分分離・手動仕上げを単一の Web アプリで提供する。

## ディレクトリ構成

```
eraser-tool/
├── web/   # Vite + TypeScript で動く本体（Cleavry）
└── ml/    # ONNX モデル最適化用の Python スクリプト群
```

各サブディレクトリは独自の `README.md` と依存定義を持つ。

## 開発

### Web 本体

```bash
cd web
npm install
npm run dev          # 開発サーバー (http://localhost:5173)
npm run build        # 本番ビルド -> dist/
npm run typecheck    # TypeScript 型チェック
```

### ML スクリプト

```bash
cd ml
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

詳細は `ml/README.md` 参照。

## ライセンス

未定（公開前に決定）。
