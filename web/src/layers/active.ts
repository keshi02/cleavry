// Active-layer accessor. Tools (brush, wand) and history live below the
// "what layer am I targeting?" question — they just ask getActiveLayer()
// for the pixel buffer, its size, and how to translate base-canvas
// coordinates into layer-local ones. activeMaterialId=null means the
// base image is the editing target.

import { state, MaterialLayer } from '../state';

export interface ActiveLayerView {
  data: Uint8ClampedArray;
  origData: Uint8ClampedArray;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
  isMaterial: boolean;
  materialId: string | null;
}

export function getActiveMaterial(): MaterialLayer | null {
  if (state.activeMaterialId === null) return null;
  return state.materials.find(m => m.id === state.activeMaterialId) ?? null;
}

export function getActiveLayer(): ActiveLayerView | null {
  const m = getActiveMaterial();
  if (m) {
    return {
      data: m.data,
      origData: m.origData,
      w: m.w,
      h: m.h,
      offsetX: m.x,
      offsetY: m.y,
      isMaterial: true,
      materialId: m.id,
    };
  }
  if (!state.workData || !state.origData) return null;
  return {
    data: state.workData,
    origData: state.origData,
    w: state.imgW,
    h: state.imgH,
    offsetX: 0,
    offsetY: 0,
    isMaterial: false,
    materialId: null,
  };
}

let nextMaterialIdCounter = 1;

export function nextMaterialId(): string {
  return `m${Date.now().toString(36)}-${nextMaterialIdCounter++}`;
}
