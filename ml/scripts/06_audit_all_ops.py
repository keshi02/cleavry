"""
Find ANY operator (not just Concat) that takes too many inputs and
might trip the WebGPU storage-buffer limit.

Most ops use 1-3 input buffers + 1 output, so they're fine. But Concat,
Sum, Min, Max, Mean and a handful of others can take variadic inputs
and become offenders. We list every op with input count > 6 (a generous
threshold leaving room for output + metadata buffers).
"""
import onnx
from collections import Counter, defaultdict
from pathlib import Path
import sys

ML_ROOT = Path(__file__).resolve().parent.parent
# Lowered from 6 → 3 so we catch any op that might balloon when WebGPU adds
# its 3-buffer overhead. Pass a different number as the last CLI arg to
# override.
DEFAULT_THRESHOLD = 3
HIGH_INPUT_THRESHOLD = DEFAULT_THRESHOLD


def audit(path: Path) -> None:
    print('\n' + '=' * 60)
    print(f'  {path.name}')
    print('=' * 60)
    model = onnx.load(str(path))
    nodes = list(model.graph.node)
    print(f'Total nodes: {len(nodes)}')

    # Group by op type the nodes that take many inputs
    by_op = defaultdict(list)
    for n in nodes:
        ni = len(n.input)
        if ni > HIGH_INPUT_THRESHOLD:
            by_op[n.op_type].append((ni, n.name or '(unnamed)'))

    if not by_op:
        print(f'No node has more than {HIGH_INPUT_THRESHOLD} inputs.')
        return

    print(f'\nOps with > {HIGH_INPUT_THRESHOLD} inputs:')
    for op_type, entries in sorted(by_op.items()):
        ni_dist = Counter(ni for ni, _ in entries)
        print(f'\n  [{op_type}]  {len(entries)} nodes')
        for ni, count in sorted(ni_dist.items()):
            print(f'    {ni:3d} inputs : {count} nodes')
        # Show up to 5 example node names
        for ni, name in entries[:5]:
            print(f'      e.g. {name}  (inputs={ni})')


def main() -> int:
    targets = [
        ML_ROOT / 'output_models' / 'birefnet_lite_fp16_split_concat.onnx',
    ]
    if len(sys.argv) > 1:
        targets = [Path(p) for p in sys.argv[1:]]

    for path in targets:
        if path.exists():
            audit(path)
        else:
            print(f'(skipping, not found): {path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
