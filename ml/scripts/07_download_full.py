"""
Download the FULL (non-lite) BiRefNet at 1024x1024 input resolution.

Apache-2.0 / MIT licensed. fp16 weights are ~490MB. We'll then run this
through 02_simplify.py and 04_split_concat.py to make it WebGPU-friendly.
"""
from huggingface_hub import hf_hub_download
from pathlib import Path
import shutil
import sys

MODEL_REPO = 'onnx-community/BiRefNet-ONNX'
MODEL_FILE = 'onnx/model_fp16.onnx'

DOWNLOAD_DIR = Path(__file__).resolve().parent.parent / 'input_models'
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def main() -> int:
    print(f'Downloading {MODEL_REPO}/{MODEL_FILE} (~490MB)…')
    try:
        cached = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE)
    except Exception as e:
        print(f'!!! Failed to download: {e}', file=sys.stderr)
        return 1

    dst = DOWNLOAD_DIR / 'birefnet_full_1024_fp16.onnx'
    shutil.copy2(cached, dst)
    size_mb = dst.stat().st_size / 1024 / 1024
    print(f'Saved: {dst}  ({size_mb:.1f} MB)')

    for filename in ('config.json', 'preprocessor_config.json'):
        try:
            cached = hf_hub_download(repo_id=MODEL_REPO, filename=filename)
            shutil.copy2(cached, DOWNLOAD_DIR / f'full_{filename}')
            print(f'Saved: full_{filename}')
        except Exception as e:
            print(f'(skipped {filename}: {e})')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
