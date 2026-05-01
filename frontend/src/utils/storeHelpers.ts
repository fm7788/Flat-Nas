/**
 * Pure utility functions extracted from main.ts store.
 * These are stateless and can be tested in isolation.
 */

import type { WidgetConfig, AppConfig } from "@/types";

const WIDGET_UI_KEYS = ["collapsed", "editing", "dragging"] as const;

type WidgetUiState = {
  collapsed?: boolean;
  editing?: boolean;
  dragging?: boolean;
};

/**
 * Read UI-only state from a widget (collapsed/editing/dragging).
 * These fields should NOT be synced to the backend.
 */
export function readWidgetUiState(widget: WidgetConfig): WidgetUiState {
  const source = widget as unknown as Record<string, unknown>;
  const state: WidgetUiState = {};
  for (const key of WIDGET_UI_KEYS) {
    const value = source[key];
    if (typeof value === "boolean") {
      state[key] = value;
    }
  }
  return state;
}

/**
 * Strip UI-only state from a widget before sending to backend.
 */
export function stripWidgetUiState(widget: WidgetConfig): WidgetConfig {
  const clone = { ...widget } as WidgetConfig & Record<string, unknown>;
  for (const key of WIDGET_UI_KEYS) {
    delete clone[key];
  }
  return clone;
}

/**
 * Apply UI state from uiStateMap onto a widget config.
 */
export function applyWidgetUiState(
  widget: WidgetConfig,
  uiStateMap: Record<string, WidgetUiState>,
): WidgetConfig {
  const ui = uiStateMap[widget.id];
  if (!ui) return widget;
  const raw = widget as unknown as Record<string, unknown>;
  let changed = false;
  const next = { ...widget } as WidgetConfig & Record<string, unknown>;
  for (const key of WIDGET_UI_KEYS) {
    const value = ui[key];
    if (typeof value === "boolean" && raw[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? (next as WidgetConfig) : widget;
}

type WidgetLayoutSnapshot = {
  id: string;
  order: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  colSpan?: number;
  rowSpan?: number;
  layouts?: WidgetConfig["layouts"];
};

/**
 * Build a layout map from widget list for dirty-state comparison.
 */
export function buildServerLayoutMap(
  list: WidgetConfig[],
): Record<string, WidgetLayoutSnapshot> {
  const next: Record<string, WidgetLayoutSnapshot> = {};
  list.forEach((widget, index) => {
    next[widget.id] = {
      id: widget.id,
      order: index,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      colSpan: widget.colSpan,
      rowSpan: widget.rowSpan,
      layouts: widget.layouts,
    };
  });
  return next;
}

/**
 * Build a stable JSON signature from layout map for comparison.
 */
export function buildServerLayoutSignature(
  layoutMap: Record<string, WidgetLayoutSnapshot>,
): string {
  return JSON.stringify(
    Object.values(layoutMap)
      .sort((a, b) => a.order - b.order)
      .map((item) => ({
        id: item.id,
        order: item.order,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        colSpan: item.colSpan,
        rowSpan: item.rowSpan,
        layouts: item.layouts,
      })),
  );
}

/**
 * Normalize version from unknown input.
 */
export function normalizeVersion(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

/**
 * Strip forceNetworkMode from appConfig before serializing to backend.
 * forceNetworkMode is a pure client-only setting.
 */
export function stripForceNetworkMode<T extends Record<string, unknown> | undefined>(
  config: T,
): T {
  if (!config) return config;
  const next = { ...config };
  delete (next as { forceNetworkMode?: unknown }).forceNetworkMode;
  return next;
}

/**
 * Migrate legacy wallpaper config.
 */
export function migrateLegacyWallpaperLock(config: AppConfig & { fixedWallpaper?: boolean }): void {
  if (config.fixedWallpaper === true) {
    config.pcRotation = false;
    config.mobileRotation = false;
  }
  delete config.fixedWallpaper;
}
