// Shared application state. Single mutable object that the various
// modules (drawing, undo, autosave, etc.) read and write directly.
// Not an event store, not Redux — just a plain object whose fields
// are widely accessed.
//
// Field types are loose for now (TypedArrays default to nullable;
// many fields are still untyped) so the migration from a single-file
// JS app stays incremental. Tighten as modules get their own types.

export type Tool = 'erase' | 'restore' | 'wand' | 'restoreWand' | 'rectSelect' | 'move';
export type WandTool = 'wand' | 'restoreWand';
export type SaveFormat = 'png' | 'webp' | 'jpeg';

// A "material" image overlaid on top of the base image. Position is in
// base-canvas coordinates. Each layer keeps its own pixel buffer and
// its own undo/redo so the user can erase/restore on the material
// without affecting the base (and vice versa).
export interface MaterialLayer {
  id: string;
  name: string;
  data: Uint8ClampedArray;       // RGBA at intrinsic size
  origData: Uint8ClampedArray;   // RGBA, unmodified — used by restore brush/wand
  w: number;
  h: number;
  x: number;                     // top-left in base-canvas coords
  y: number;
  undo: Uint8ClampedArray[];
  redo: Uint8ClampedArray[];
}

export interface RectSelection {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ConnectedComponent {
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  selected: boolean;
}

export interface AppState {
  origData: Uint8ClampedArray | null;       // RGBA, unmodified source
  workData: Uint8ClampedArray | null;       // RGBA, being edited
  imgW: number;
  imgH: number;
  filename: string;

  tool: Tool;
  lastWandTool: WandTool;                   // last picked wand variant —
                                            //   keeps its button lit during rect-select
  rectSelection: RectSelection | null;
  rectInverse: boolean;                     // false: wand inside rect; true: outside
  rectDragStart: { x: number; y: number } | null;
  pendingWandClick: { x: number; y: number } | null;

  brushSize: number;                        // currently active tool's size (mirror)
  eraseSize: number;                        // remembered size for the eraser
  restoreSize: number;                      // remembered size for the restore brush
  brushHardness: number;                    // 0..100
  tolerance: number;                        // 0..100 (percent), wand only

  undo: Uint8ClampedArray[];
  redo: Uint8ClampedArray[];
  maxUndo: number;

  zoom: number;
  panX: number;
  panY: number;
  isDrawing: boolean;
  isPanning: boolean;
  spaceHeld: boolean;
  lastImgX: number | null;
  lastImgY: number | null;
  panStartScreen: { x: number; y: number } | null;
  panStartPos: { x: number; y: number } | null;
  strokeSnapshotTaken: boolean;
  smoothPoints: { x: number; y: number }[];
  strokeSampleColor?: { r: number; g: number; b: number } | null;

  separateMode: boolean;
  cleanupMode: boolean;
  components: ConnectedComponent[];
  componentMask: Uint32Array | null;        // W*H, 0=背景, 1+ = 成分ID

  preserveCanvas: boolean;                  // keep canvas size & positions on save
  featherActive: boolean;                   // export-time feather toggle
  featherStrength: number;                  // 1..3 iterations
  autoCleanupThreshold: number;             // px² for one-shot auto-cleanup
  saveFormat: SaveFormat;
  autoSaveEnabled: boolean;

  // Multi-layer support. base レイヤーは workData / origData / imgW / imgH
  // にそのまま乗っており、materials がその上に上書きされる。activeMaterialId
  // が null のとき編集対象は base、それ以外は materials のいずれか。
  materials: MaterialLayer[];
  activeMaterialId: string | null;
  isMovingMaterial: boolean;
  moveStartScreen: { x: number; y: number } | null;
  moveStartLayer: { x: number; y: number } | null;
  // Resize-in-progress state. resizeHandle names which corner / edge the
  // user grabbed, resizeStart captures the material's original geometry +
  // the pointer's image-space anchor, resizePreview is the live target
  // bbox used by the renderer (the actual pixel rebuild only happens on
  // pointerup so we don't degrade quality re-sampling every frame).
  resizeHandle: ResizeHandle | null;
  resizeStart: {
    x: number; y: number; w: number; h: number;
    pointerX: number; pointerY: number;
  } | null;
  resizePreview: { x: number; y: number; w: number; h: number } | null;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const state: AppState = {
  origData: null,
  workData: null,
  imgW: 0,
  imgH: 0,
  filename: '',
  tool: 'erase',
  lastWandTool: 'wand',
  rectSelection: null,
  rectInverse: false,
  rectDragStart: null,
  pendingWandClick: null,
  brushSize: 40,
  eraseSize: 40,
  restoreSize: 40,
  brushHardness: 70,
  tolerance: 20,
  undo: [],
  redo: [],
  maxUndo: 50,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDrawing: false,
  isPanning: false,
  spaceHeld: false,
  lastImgX: null,
  lastImgY: null,
  panStartScreen: null,
  panStartPos: null,
  strokeSnapshotTaken: false,
  smoothPoints: [],
  separateMode: false,
  cleanupMode: false,
  components: [],
  componentMask: null,
  preserveCanvas: true,
  featherActive: false,
  featherStrength: 1,
  autoCleanupThreshold: 16,
  saveFormat: 'png',
  autoSaveEnabled: true,
  materials: [],
  activeMaterialId: null,
  isMovingMaterial: false,
  moveStartScreen: null,
  moveStartLayer: null,
  resizeHandle: null,
  resizeStart: null,
  resizePreview: null,
};

// Reflect the persisted autosave preference into the runtime state.
// Done once at module load — localStorage is sync, no async dance needed.
try {
  const v = localStorage.getItem('autosave-enabled');
  if (v === 'false') state.autoSaveEnabled = false;
} catch (_) { /* private mode */ }
