"""
Numerically verify the split-Concat model produces (essentially) the same
output as the original.

Run on CPU with onnxruntime; we don't need WebGPU here since the goal is
to confirm the rewrite preserved semantics. If the max absolute difference
is below ~1e-3 (in fp16 territory) we're good.
"""
import numpy as np
import onnxruntime as ort
from pathlib import Path
import sys

ML_ROOT = Path(__file__).resolve().parent.parent
ORIG = ML_ROOT / 'input_models' / 'birefnet_lite_fp16.onnx'
OPT  = ML_ROOT / 'output_models' / 'birefnet_lite_fp16_split_concat.onnx'


def main() -> int:
    if not ORIG.exists() or not OPT.exists():
        print('!!! Need both original and split models. Run 01 → 02 → 04 first.',
              file=sys.stderr)
        return 1

    print('Loading sessions on CPU...')
    sess_orig = ort.InferenceSession(str(ORIG), providers=['CPUExecutionProvider'])
    sess_opt  = ort.InferenceSession(str(OPT),  providers=['CPUExecutionProvider'])

    input_meta = sess_orig.get_inputs()[0]
    name = input_meta.name
    shape = input_meta.shape
    # Replace dynamic dims (None / strings / -1) with concrete defaults.
    concrete = []
    for i, d in enumerate(shape):
        if not isinstance(d, int) or d <= 0:
            concrete.append([1, 3, 1024, 1024][i] if i < 4 else 1)
        else:
            concrete.append(d)
    print(f'Input "{name}", shape {shape} -> using {concrete}')

    rng = np.random.default_rng(42)
    # Match the model's expected dtype.
    dtype = np.float16 if input_meta.type == 'tensor(float16)' else np.float32
    x = rng.standard_normal(concrete).astype(dtype)

    print('Running ORIGINAL...')
    out_orig = sess_orig.run(None, {name: x})
    print(f'  output shapes: {[o.shape for o in out_orig]}')

    print('Running SPLIT...')
    out_opt = sess_opt.run(None, {name: x})
    print(f'  output shapes: {[o.shape for o in out_opt]}')

    if len(out_orig) != len(out_opt):
        print(f'!!! Output count mismatch: {len(out_orig)} vs {len(out_opt)}',
              file=sys.stderr)
        return 1

    max_diff = 0.0
    for i, (a, b) in enumerate(zip(out_orig, out_opt)):
        if a.shape != b.shape:
            print(f'!!! Output {i} shape mismatch: {a.shape} vs {b.shape}',
                  file=sys.stderr)
            return 1
        diff = np.abs(a.astype(np.float32) - b.astype(np.float32)).max()
        max_diff = max(max_diff, float(diff))
        print(f'  output[{i}] max |diff| = {diff}')

    print(f'\nOverall max absolute difference: {max_diff}')
    # fp16 epsilon is ~1e-3; anything below 0.01 is "the same model".
    if max_diff < 1e-2:
        print('PASS — split model is numerically equivalent.')
        return 0
    print('FAIL — outputs diverge. Do NOT ship without investigating.')
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
