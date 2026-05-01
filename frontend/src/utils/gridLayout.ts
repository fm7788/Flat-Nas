import type { WidgetConfig } from "@/types";

export interface GridLayoutItem extends WidgetConfig {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function generateLayout(widgets: WidgetConfig[], colNum: number): GridLayoutItem[] {
  const layout: GridLayoutItem[] = [];
  const matrix: boolean[][] = []; // true if occupied
  const step = 0.5;
  const scale = 2;
  const normalize = (value: number) => Math.round(value * scale) / scale;
  const toScaled = (value: number) => Math.round(value * scale);

  function isOccupied(x: number, y: number, w: number, h: number) {
    const sx = toScaled(x);
    const sy = toScaled(y);
    const sw = toScaled(w);
    const sh = toScaled(h);
    for (let i = sx; i < sx + sw; i++) {
      for (let j = sy; j < sy + sh; j++) {
        if (matrix[j]?.[i]) return true;
      }
    }
    return false;
  }

  function occupy(x: number, y: number, w: number, h: number) {
    const sx = toScaled(x);
    const sy = toScaled(y);
    const sw = toScaled(w);
    const sh = toScaled(h);
    for (let i = sx; i < sx + sw; i++) {
      for (let j = sy; j < sy + sh; j++) {
        if (!matrix[j]) matrix[j] = [];
        const row = matrix[j];
        if (row) row[i] = true;
      }
    }
  }

  // 分离已有位置和无位置的组件
  // 优先处理已有位置的组件，避免被新组件抢占位置导致重叠
  const positioned: WidgetConfig[] = [];
  const unpositioned: WidgetConfig[] = [];

  widgets.forEach((w) => {
    const width = normalize(w.w ?? w.colSpan ?? 1);
    const x = w.x !== undefined ? normalize(w.x) : undefined;
    const y = w.y !== undefined ? normalize(w.y) : undefined;
    // 只有当位置存在且在当前列数范围内时，才保留原位置
    // 否则视为无位置，重新排布（例如从宽屏切换到窄屏时）
    if (x !== undefined && y !== undefined && x + width <= colNum) {
      positioned.push(w);
    } else {
      unpositioned.push(w);
    }
  });

  // 1. 先放置已有位置的组件
  positioned.forEach((w) => {
    const width = normalize(w.w ?? w.colSpan ?? 1);
    const height = normalize(w.h ?? w.rowSpan ?? 1);
    const x = normalize(w.x ?? 0);
    const y = normalize(w.y ?? 0);

    // 如果位置已经被占用了（说明有组件重叠），
    // 或者虽然之前检查了宽度，但为了双重保险（例如 occupy 逻辑可能有变），
    // 这里再次检查占用情况。
    // 如果重叠，则降级为 unpositioned，由后续逻辑自动寻找空位。
    if (isOccupied(x, y, width, height)) {
      unpositioned.push(w);
      return;
    }

    occupy(x, y, width, height);
    layout.push({ ...w, i: w.id, w: width, h: height, x, y });
  });

  // 2. 再放置无位置（或位置失效、或因重叠被挤出）的组件
  unpositioned.forEach((w) => {
    let width = normalize(w.w ?? w.colSpan ?? 1);
    const height = normalize(w.h ?? w.rowSpan ?? 1);

    // Safety check: if width is greater than colNum, clamp it to colNum
    // This prevents infinite loop in the while(true) block below
    if (width > colNum) width = colNum;

    // Find first spot
    let x = 0;
    let y = 0;
    while (true) {
      if (x + width > colNum) {
        x = 0;
        y = normalize(y + step);
        continue;
      }
      if (!isOccupied(x, y, width, height)) {
        occupy(x, y, width, height);
        layout.push({ ...w, i: w.id, x, y, w: width, h: height });
        break;
      }
      x = normalize(x + step);
    }
  });

  return layout;
}
