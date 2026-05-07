"""
Diagnose the ONNX graph — specifically the Concat nodes that trigger
the WebGPU shader-buffer limit.

WebGPU's `maxStorageBuffersPerShaderStage` defaults to 10 in modern
Chrome. onnxruntime-web emits one storage buffer per Concat input
plus one for the output, so a Concat with >9 inputs ALMOST always
fails to compile its WebGPU shader.

This script reports the distribution of Concat input counts before
and after simplification so we can see whether onnxsim solved it.
"""
import onnx
from collections import Counter
from pathlib import Path
import sys

ML_ROOT = Path(__file__).resolve().parent.parent
WEBGPU_BUFFER_LIMIT = 10  # default maxStorageBuffersPerShaderStage
# Concat shader cost is N inputs + 3 extra buffers (output + 2 metadata).
# Empirically an 8-input Concat reports "Current: 11" — confirming the +3.
# Safe ceiling: 10 - 3 = 7. We use 6 with a margin for safety.
SAFE_CONCAT_INPUTS = WEBGPU_BUFFER_LIMIT - 4  # = 6


def inspect(path: Path) -> None:
    print('\n' + '=' * 60)
    print(f'  {path.name}')
    print('=' * 60)
    print(f'File size: {path.stat().st_size / 1024 / 1024:.1f} MB')

    model = onnx.load(str(path))
    nodes = list(model.graph.node)
    print(f'Total ONNX nodes: {len(nodes)}')

    op_types = Counter(n.op_type for n in nodes)
    print('\nTop op types:')
    for op, count in op_types.most_common(8):
        print(f'  {op:20s} {count:5d}')

    print('\nConcat node distribution by input count:')
    concat_inputs = [len(n.input) for n in nodes if n.op_type == 'Concat']
    if not concat_inputs:
        print('  (no Concat nodes — unusual for a U-Net)')
        return

    over_limit = 0
    for n_inputs, count in sorted(Counter(concat_inputs).items()):
        marker = ''
        if n_inputs > SAFE_CONCAT_INPUTS:
            marker = '  <-- exceeds WebGPU buffer limit'
            over_limit += count
        print(f'  {n_inputs:2d} inputs : {count:4d} nodes{marker}')

    print(f'\nConcat nodes likely to break WebGPU: {over_limit}')
    if over_limit == 0:
        print('Looks good! All Concats fit within the WebGPU buffer budget.')
    else:
        # Show the actual offenders (first 10) for manual surgery
        offenders = [n for n in nodes
                     if n.op_type == 'Concat'
                     and len(n.input) > SAFE_CONCAT_INPUTS]
        print('\nOffending nodes:')
        for n in offenders[:10]:
            name = n.name or '(unnamed)'
            print(f'  {name:60s}  inputs={len(n.input)}')


def main() -> int:
    targets = [
        ML_ROOT / 'input_models' / 'birefnet_lite_fp16.onnx',
        ML_ROOT / 'output_models' / 'birefnet_lite_fp16_simplified.onnx',
        ML_ROOT / 'output_models' / 'birefnet_lite_fp16_split_concat.onnx',
    ]
    if len(sys.argv) > 1:
        targets = [Path(p) for p in sys.argv[1:]]

    any_found = False
    for path in targets:
        if path.exists():
            inspect(path)
            any_found = True
        else:
            print(f'(skipping, not found): {path}')

    return 0 if any_found else 1


if __name__ == '__main__':
    raise SystemExit(main())
