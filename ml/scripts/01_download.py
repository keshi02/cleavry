"""
Download BiRefNet ONNX model from Hugging Face for local optimization.

We work with the lite/fp16 variant first (115MB) to keep iteration cheap.
Once the optimization recipe is proven to work, we'll re-run it on the
full BiRefNet (490MB fp16) to maximise quality.
"""
from huggingface_hub import hf_hub_download
from pathlib import Path
import shutil
import sys

MODEL_REPO = 'onnx-community/BiRefNet_lite-ONNX'
MODEL_FILE = 'onnx/model_fp16.onnx'

DOWNLOAD_DIR = Path(__file__).resolve().parent.parent / 'input_models'
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def main() -> int:
    print(f'Downloading {MODEL_REPO}/{MODEL_FILE} ...')
    try:
        cached = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE)
    except Exception as e:
        print(f'!!! Failed to download model file: {e}', file=sys.stderr)
        return 1

    dst = DOWNLOAD_DIR / 'birefnet_lite_fp16.onnx'
    shutil.copy2(cached, dst)
    size_mb = dst.stat().st_size / 1024 / 1024
    print(f'Saved: {dst}  ({size_mb:.1f} MB)')

    # Optional metadata files. They aren't needed for graph optimization
    # but make local debugging more convenient.
    for filename in ('config.json', 'preprocessor_config.json'):
        try:
            cached = hf_hub_download(repo_id=MODEL_REPO, filename=filename)
            shutil.copy2(cached, DOWNLOAD_DIR / filename)
            print(f'Saved: {filename}')
        except Exception as e:
            print(f'(skipped {filename}: {e})')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
