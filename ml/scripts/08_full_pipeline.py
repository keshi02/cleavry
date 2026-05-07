"""
Run simplify + split_concat against the FULL (non-lite) BiRefNet 1024.

Reuses the same logic as 02_simplify.py and 04_split_concat.py but
points at the full model. Outputs land at:
    output_models/birefnet_full_1024_fp16_split_concat.onnx
"""
import onnx
from onnxsim import simplify
from onnx import helper
from pathlib import Path
import sys

ML_ROOT = Path(__file__).resolve().parent.parent
SRC      = ML_ROOT / 'input_models'  / 'birefnet_full_1024_fp16.onnx'
SIMP_DST = ML_ROOT / 'output_models' / 'birefnet_full_1024_fp16_simplified.onnx'
SPLIT_DST = ML_ROOT / 'output_models' / 'birefnet_full_1024_fp16_split_concat.onnx'

# Same buffer-budget rationale as 04_split_concat.py: empirically the
# WebGPU Concat shader uses N inputs + 3 extra buffers; cap at 6 inputs.
MAX_CONCAT_INPUTS = 6


# ─── simplify ─────────────────────────────────────────────────────────
def step_simplify():
    if not SRC.exists():
        print(f'!!! Source not found: {SRC}', file=sys.stderr)
        print('Run 07_download_full.py first.', file=sys.stderr)
        return None

    print(f'\n[1/2] Simplify  ({SRC.stat().st_size / 1024 / 1024:.1f} MB)')
    model = onnx.load(str(SRC))
    print(f'  Original nodes: {len(model.graph.node)}')

    print('  Running onnxsim…')
    model_simp, ok = simplify(model)
    if not ok:
        print('  !!! onnxsim verification FAILED — using simplified anyway',
              file=sys.stderr)
    else:
        print('  onnxsim verification OK')

    print(f'  Simplified nodes: {len(model_simp.graph.node)}')
    SIMP_DST.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model_simp, str(SIMP_DST))
    print(f'  Saved: {SIMP_DST}')
    return model_simp


# ─── split concat ─────────────────────────────────────────────────────
def build_concat_tree(input_names, axis, name_prefix, max_inputs):
    nodes = []
    level = 0
    current = list(input_names)
    while len(current) > max_inputs:
        next_outputs = []
        for chunk_idx, start in enumerate(range(0, len(current), max_inputs)):
            chunk = current[start : start + max_inputs]
            if len(chunk) == 1:
                next_outputs.append(chunk[0])
                continue
            concat_out = f'{name_prefix}_lvl{level}_chunk{chunk_idx}'
            identity_out = f'{concat_out}_id'
            nodes.append(helper.make_node(
                'Concat',
                inputs=chunk,
                outputs=[concat_out],
                axis=axis,
                name=concat_out,
            ))
            nodes.append(helper.make_node(
                'Identity',
                inputs=[concat_out],
                outputs=[identity_out],
                name=identity_out,
            ))
            next_outputs.append(identity_out)
        current = next_outputs
        level += 1
    return nodes, current


def replace_node(node, max_inputs):
    axis = next(a.i for a in node.attribute if a.name == 'axis')
    final_output = node.output[0]
    base = node.name or f'concat_{id(node)}'
    name_prefix = f'{base}_split'
    inner_nodes, top_outputs = build_concat_tree(
        list(node.input), axis, name_prefix, max_inputs,
    )
    if len(top_outputs) == 1:
        return inner_nodes + [helper.make_node(
            'Identity', inputs=top_outputs, outputs=[final_output], name=base,
        )]
    final = helper.make_node(
        'Concat',
        inputs=top_outputs,
        outputs=[final_output],
        axis=axis,
        name=base,
    )
    return inner_nodes + [final]


def step_split(model):
    print(f'\n[2/2] Split oversized Concats (cap = {MAX_CONCAT_INPUTS} inputs)')
    nodes = list(model.graph.node)
    new_nodes = []
    rewrites = 0
    for n in nodes:
        if n.op_type == 'Concat' and len(n.input) > MAX_CONCAT_INPUTS:
            replacement = replace_node(n, MAX_CONCAT_INPUTS)
            print(f'  {n.name}: {len(n.input)} inputs -> tree of {len(replacement)} nodes')
            new_nodes.extend(replacement)
            rewrites += 1
        else:
            new_nodes.append(n)

    print(f'  Rewrote {rewrites} Concat nodes (total nodes now {len(new_nodes)})')
    del model.graph.node[:]
    model.graph.node.extend(new_nodes)

    try:
        onnx.checker.check_model(model)
        print('  ONNX checker: PASSED')
    except Exception as e:
        print(f'  ONNX checker: FAILED — {e}', file=sys.stderr)

    onnx.save(model, str(SPLIT_DST))
    size_mb = SPLIT_DST.stat().st_size / 1024 / 1024
    print(f'  Saved: {SPLIT_DST}  ({size_mb:.1f} MB)')


def main() -> int:
    model = step_simplify()
    if model is None:
        return 1
    step_split(model)
    print('\nNext:')
    print('  python scripts/03_inspect.py output_models/birefnet_full_1024_fp16_split_concat.onnx')
    print('  python scripts/05_verify.py  # update SRC/OPT paths if needed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
