# BiRefNet ONNX Optimization

このディレクトリは、ブラウザ内推論用に BiRefNet モデルの ONNX グラフを最適化する作業場所です。

## 目的

`onnxruntime-web` の WebGPU バックエンドが BiRefNet 系モデルの `Concat` ノードで shader buffer 上限超過エラーを起こす問題を、ONNX グラフの書き換えによって解消します。

成功すれば、ブラウザ内で BiRefNet 級品質の背景除去が動作する世界初級の Web ツールが実現できます。

## 構成

```
ml/
├── input_models/        # Hugging Face からダウンロードした元モデル
├── output_models/       # 最適化済みモデル
├── scripts/
│   ├── 01_download.py     # HF からモデル取得
│   ├── 02_simplify.py     # onnxsim で自動最適化
│   ├── 03_inspect.py      # Concat 入力数を分析
│   ├── 04_split_concat.py # 大きな Concat を多段ツリーに書き換え
│   └── 05_verify.py       # 元モデルと出力が同一か検証
└── README.md
```

## セットアップ（初回のみ）

```bash
cd ~/Documents/Projects/eraser-tool/ml
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

## 実行手順

仮想環境を有効化してから（毎回）：

```bash
source .venv/bin/activate

# Step 1: モデルを HF からダウンロード
python scripts/01_download.py

# Step 2: onnxsim で自動最適化
python scripts/02_simplify.py

# Step 3: 元と最適化後を比較（Concat ノードの入力数）
python scripts/03_inspect.py
```

## 期待する出力

`03_inspect.py` で以下のような出力が出れば最適化成功：

```
=== birefnet_lite_fp16.onnx ===
Concat nodes by input count:
  2 inputs: 30 nodes
  11 inputs: 1 nodes  <-- exceeds WebGPU shader limit (10)

=== birefnet_lite_fp16_simplified.onnx ===
Concat nodes by input count:
  2 inputs: 31 nodes  ← すべて 10 以下に収まっている
```

最適化で 11 入力 Concat が消えれば WebGPU で動く可能性が高まります。
消えなかった場合は手動でグラフ書き換えに進みます（Step 4 以降）。
