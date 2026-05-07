"""
Replace oversized Concat nodes with a tree of small Concats.

Why: WebGPU has a default `maxStorageBuffersPerShaderStage` of 10, and
onnxruntime-web emits one storage buffer per Concat input + 1 for the
output, so a single Concat that takes more than ~9 inputs fails to
compile its shader. BiRefNet's decoder has Concats with 1024 / 256 /
64 / 16 inputs, all of which exceed this limit.

A Concat is associative on the same axis: concat(a,b,c) == concat(a, concat(b,c)).
So we can replace one big Concat with a tree of smaller ones, each
fitting under the WebGPU limit, with identical numerical output.
"""
import onnx
from onnx import helper
from pathlib import Path
import sys

ML_ROOT = Path(__file__).resolve().parent.parent
SRC = ML_ROOT / 'output_models' / 'birefnet_lite_fp16_simplified.onnx'
DST = ML_ROOT / 'output_models' / 'birefnet_lite_fp16_split_concat.onnx'

# Empirically (8-input Concat → "Current: 11, Max: 10"), onnxruntime-web's
# Concat WebGPU shader uses N inputs + 3 extra storage buffers (output +
# two metadata buffers, presumably one for input shapes and one for cumulative
# offsets along the concat axis). So the safe ceiling is 10 - 3 = 7. We
# cap at 6 to leave a buffer slot in reserve.
MAX_CONCAT_INPUTS = 6


def build_concat_tree(input_names, axis, name_prefix, max_inputs):
    """
    Build a tree of Concat nodes that ultimately concatenates `input_names`
    along `axis`. Each intermediate Concat's output is wrapped in an
    Identity node so onnxruntime-web's WebGPU compiler can't quietly fuse
    consecutive Concats back into one big Concat (which would re-trigger
    the storage-buffer limit).
    """
    nodes = []
    level = 0
    current = list(input_names)
    while len(current) > max_inputs:
        next_outputs = []
        for chunk_idx, start in enumerate(range(0, len(current), max_inputs)):
            chunk = current[start : start + max_inputs]
            if len(chunk) == 1:
                # Pass-through: no new Concat needed.
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
            # Identity barrier: prevents the WebGPU graph optimizer from
            # fusing this Concat with the next one in the tree.
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
    """Return a list of nodes that replace `node` with an equivalent tree."""
    axis = next(a.i for a in node.attribute if a.name == 'axis')
    final_output = node.output[0]
    base = node.name or f'concat_{id(node)}'
    name_prefix = f'{base}_split'

    # Build the tree below the final Concat
    inner_nodes, top_outputs = build_concat_tree(
        list(node.input), axis, name_prefix, max_inputs,
    )

    if len(top_outputs) == 1:
        # Edge case: tree collapsed to a single tensor; we still need a
        # node that produces `final_output`. Use Identity to keep the
        # graph wiring intact.
        return inner_nodes + [helper.make_node(
            'Identity',
            inputs=top_outputs,
            outputs=[final_output],
            name=base,
        )]

    final = helper.make_node(
        'Concat',
        inputs=top_outputs,
        outputs=[final_output],
        axis=axis,
        name=base,  # keep the original node's name on the final Concat
    )
    return inner_nodes + [final]


def main() -> int:
    if not SRC.exists():
        print(f'!!! Source model not found: {SRC}', file=sys.stderr)
        print('Run 02_simplify.py first.', file=sys.stderr)
        return 1

    print(f'Loading {SRC.name} ({SRC.stat().st_size / 1024 / 1024:.1f} MB)...')
    model = onnx.load(str(SRC))
    nodes = list(model.graph.node)
    print(f'Input node count: {len(nodes)}')

    new_nodes = []
    rewrites = 0
    extra_nodes = 0
    for n in nodes:
        if n.op_type == 'Concat' and len(n.input) > MAX_CONCAT_INPUTS:
            replacement = replace_node(n, MAX_CONCAT_INPUTS)
            print(f'  {n.name}: {len(n.input)} inputs '
                  f'-> tree of {len(replacement)} nodes')
            new_nodes.extend(replacement)
            rewrites += 1
            extra_nodes += len(replacement) - 1
        else:
            new_nodes.append(n)

    print(f'\nRewrote {rewrites} Concat nodes (+{extra_nodes} new nodes).')
    print(f'Output node count: {len(new_nodes)}')

    del model.graph.node[:]
    model.graph.node.extend(new_nodes)

    # IR validation. If this raises, our rewrite produced a malformed
    # graph and we need to fix the script before running inference.
    try:
        onnx.checker.check_model(model)
        print('ONNX checker: PASSED')
    except Exception as e:
        print(f'ONNX checker: FAILED — {e}', file=sys.stderr)
        # Save anyway so we can inspect the broken graph.

    DST.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(DST))
    size_mb = DST.stat().st_size / 1024 / 1024
    print(f'\nSaved: {DST}  ({size_mb:.1f} MB)')
    print('\nNext: python scripts/03_inspect.py output_models/birefnet_lite_fp16_split_concat.onnx')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
