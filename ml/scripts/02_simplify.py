"""
Run onnxsim on the downloaded model.

onnxsim folds constant subgraphs and merges adjacent ops, which often
collapses chains of small Concats into something that no longer trips
the WebGPU 10-buffer limit. It's the simplest possible first attempt
before we resort to manual graph surgery.
"""
import onnx
from onnxsim import simplify
from pathlib import Path
import sys

ML_ROOT = Path(__file__).resolve().parent.parent
SRC = ML_ROOT / 'input_models' / 'birefnet_lite_fp16.onnx'
DST = ML_ROOT / 'output_models' / 'birefnet_lite_fp16_simplified.onnx'


def main() -> int:
    if not SRC.exists():
        print(f'!!! Source model not found: {SRC}', file=sys.stderr)
        print('Run 01_download.py first.', file=sys.stderr)
        return 1

    DST.parent.mkdir(parents=True, exist_ok=True)

    print(f'Loading {SRC.name} ({SRC.stat().st_size / 1024 / 1024:.1f} MB) ...')
    model = onnx.load(str(SRC))
    print(f'Original node count: {len(model.graph.node)}')

    print('Running onnxsim... (may take a minute)')
    model_simp, ok = simplify(model)
    if not ok:
        print('!!! onnxsim verification FAILED — output may differ from original.', file=sys.stderr)
        print('   We will save it anyway for inspection, but do NOT ship.', file=sys.stderr)
    else:
        print('onnxsim verification: OK (numerically equivalent to original)')

    print(f'Simplified node count: {len(model_simp.graph.node)}')
    onnx.save(model_simp, str(DST))
    size_mb = DST.stat().st_size / 1024 / 1024
    print(f'Saved: {DST}  ({size_mb:.1f} MB)')
    return 0 if ok else 2


if __name__ == '__main__':
    raise SystemExit(main())
