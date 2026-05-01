import { ref, computed, watch } from "vue";
import { defineStore } from "pinia";
import {
  stripWidgetUiState as stripWidgetUiStateUtil,
  applyWidgetUiState as applyWidgetUiStateUtil,
  buildServerLayoutMap,
  buildServerLayoutSignature,
} from "@/utils/storeHelpers";
import { normalizeIncomingWidgets as normalizeIncomingWidgetsUtil } from "@/utils/widgetUtils";
import type { WidgetConfig, MarketplaceItem } from "@/types";

export const useWidgetsStore = defineStore("widgets", () => {
  const widgets = ref<WidgetConfig[]>([]);

  type WidgetUiState = {
    collapsed?: boolean;
    editing?: boolean;
    dragging?: boolean;
  };
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

  const WIDGET_UI_KEYS = ["collapsed", "editing", "dragging"] as const;
  const serverLayoutMap = ref<Record<string, WidgetLayoutSnapshot>>({});
  const uiStateMap = ref<Record<string, WidgetUiState>>({});
  const serverLayoutSignature = ref("");

  // Layout tracking for dirty state
  const layoutDirty = ref(false);
  const layoutEditInProgress = ref(false);
  const lastSavedLayoutSignature = ref("");
  const lastSavedLayoutSnapshot = ref<Record<string, WidgetLayoutSnapshot> | null>(null);

  const readWidgetUiState = (widget: WidgetConfig): WidgetUiState => {
    const source = widget as unknown as Record<string, unknown>;
    const state: WidgetUiState = {};
    for (const key of WIDGET_UI_KEYS) {
      const value = source[key];
      if (typeof value === "boolean") {
        state[key] = value;
      }
    }
    return state;
  };

  const stripWidgetUiState = (widget: WidgetConfig): WidgetConfig => {
    return stripWidgetUiStateUtil(widget);
  };

  const syncUiStateMapFromWidgets = (list: WidgetConfig[]) => {
    const nextMap: Record<string, WidgetUiState> = { ...uiStateMap.value };
    for (const widget of list) {
      const ui = readWidgetUiState(widget);
      if (Object.keys(ui).length > 0) {
        nextMap[widget.id] = { ...(nextMap[widget.id] || {}), ...ui };
      }
    }
    uiStateMap.value = nextMap;
  };

  const applyWidgetUiState = (widget: WidgetConfig): WidgetConfig => {
    return applyWidgetUiStateUtil(widget, uiStateMap.value);
  };

  const mergedWidgets = computed(() => widgets.value.map((widget) => applyWidgetUiState(widget)));

  const normalizeIncomingWidgets = (input?: WidgetConfig[], isLoggedIn?: boolean) => {
    return normalizeIncomingWidgetsUtil(input, isLoggedIn);
  };

  const applyServerWidgets = (
    incomingWidgets: WidgetConfig[],
    isLogged: boolean,
    layoutEditFlag: boolean,
  ) => {
    syncUiStateMapFromWidgets(widgets.value);
    const nextServerLayoutMap = buildServerLayoutMap(incomingWidgets);
    const nextLayoutSignature = buildServerLayoutSignature(nextServerLayoutMap);
    const previousById = new Map(widgets.value.map((widget) => [widget.id, widget] as const));
    const preserveLayout = layoutEditFlag;

    const nextWidgets = incomingWidgets.map((incomingWidget) => {
      const previous = previousById.get(incomingWidget.id);
      const mergedBase = previous
        ? ({ ...previous, ...incomingWidget } as WidgetConfig)
        : incomingWidget;
      if (preserveLayout && previous) {
        mergedBase.x = previous.x;
        mergedBase.y = previous.y;
        mergedBase.w = previous.w;
        mergedBase.h = previous.h;
        mergedBase.colSpan = previous.colSpan;
        mergedBase.rowSpan = previous.rowSpan;
        mergedBase.layouts = previous.layouts
          ? (JSON.parse(JSON.stringify(previous.layouts)) as typeof previous.layouts)
          : undefined;
      }
      return applyWidgetUiState(mergedBase);
    });

    let changed = nextWidgets.length !== widgets.value.length;
    if (!changed) {
      for (let i = 0; i < nextWidgets.length; i++) {
        const current = widgets.value[i];
        const next = nextWidgets[i];
        if (
          !current ||
          !next ||
          current.id !== next.id ||
          JSON.stringify(current) !== JSON.stringify(next)
        ) {
          changed = true;
          break;
        }
      }
    }

    if (nextLayoutSignature === serverLayoutSignature.value && !changed) {
      return;
    }

    serverLayoutMap.value = nextServerLayoutMap;
    serverLayoutSignature.value = nextLayoutSignature;
    if (changed) {
      widgets.value = nextWidgets;
    }
  };

  const setWidgetUiState = (widgetId: string, patch: WidgetUiState) => {
    uiStateMap.value = {
      ...uiStateMap.value,
      [widgetId]: { ...(uiStateMap.value[widgetId] || {}), ...patch },
    };
    const index = widgets.value.findIndex((widget) => widget.id === widgetId);
    if (index >= 0) {
      const nextWidgets = [...widgets.value];
      nextWidgets[index] = applyWidgetUiState(nextWidgets[index]);
      widgets.value = nextWidgets;
    }
  };

  const saveWidget = async (id?: string, data?: unknown) => {
    if (typeof id === "string") {
      const w = widgets.value.find((x) => x.id === id);
      if (w) w.data = data as WidgetConfig["data"];
    }
  };

  // Phase 3: Fine-grained widget save via PUT /api/widgets/:id
  // Supports widget-level optimistic locking (widgetVersion)
  const saveSingleWidget = async (
    widgetId: string,
    payload: Record<string, unknown>,
    getHeaders: () => Record<string, string>,
    dataVersion: { value: number },
  ): Promise<boolean> => {
    try {
      const w = widgets.value.find((x) => x.id === widgetId);
      const widgetVersion = w ? (w as unknown as Record<string, unknown>)["widgetVersion"] ?? 0 : 0;
      const body = { ...payload, version: dataVersion.value, widgetVersion };
      const res = await fetch(`/api/widgets/${encodeURIComponent(widgetId)}`, {
        method: "PUT",
        headers: { ...getHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const result = await res.json().catch(() => null);
        if (result && typeof (result as { version?: number }).version !== "undefined") {
          dataVersion.value = Math.max(0, Math.floor((result as { version?: number }).version));
        }
        // Update widget-level version if returned
        if (w && result && typeof (result as { widgetVersion?: number }).widgetVersion !== "undefined") {
          (w as unknown as Record<string, unknown>)["widgetVersion"] = (result as { widgetVersion?: number }).widgetVersion;
        }
        return true;
      }
      return false;
    } catch (e) {
      console.error(`[saveSingleWidget] Failed for ${widgetId}:`, e);
      return false;
    }
  };

  const checkLayoutDirty = () => {
    const currentLayoutMap = buildServerLayoutMap(widgets.value);
    const currentSig = buildServerLayoutSignature(currentLayoutMap);
    layoutDirty.value = currentSig !== lastSavedLayoutSignature.value;
  };

  watch(
    widgets,
    () => {
      checkLayoutDirty();
    },
    { deep: true },
  );

  const updateLastSavedLayout = () => {
    const currentLayoutMap = buildServerLayoutMap(widgets.value);
    lastSavedLayoutSignature.value = buildServerLayoutSignature(currentLayoutMap);
    lastSavedLayoutSnapshot.value = JSON.parse(JSON.stringify(currentLayoutMap));
    layoutDirty.value = false;
  };

  const undoLayout = async (saveData: (immediate: boolean, force: boolean) => Promise<string>) => {
    if (!lastSavedLayoutSnapshot.value) return;
    const layoutMap = lastSavedLayoutSnapshot.value;
    widgets.value.forEach((widget) => {
      const snapshot = layoutMap[widget.id];
      if (snapshot) {
        widget.x = snapshot.x;
        widget.y = snapshot.y;
        widget.w = snapshot.w;
        widget.h = snapshot.h;
        widget.colSpan = snapshot.colSpan;
        widget.rowSpan = snapshot.rowSpan;
        widget.layouts = snapshot.layouts;
      }
    });
    await saveData(true, true);
  };

  const applyMarketplaceItem = (item: MarketplaceItem, appConfig: Record<string, unknown>) => {
    let changed = false;

    if (item.css) {
      if (!appConfig.customCssList) appConfig.customCssList = [];
      const newId = item.id ? `css-${item.id}` : `css-${Date.now()}`;
      (appConfig.customCssList as unknown[]).push({
        id: newId,
        name: item.name || "Unknown CSS",
        content: item.css,
        enable: true,
        useProxy: item.useProxy ?? false,
      });
      changed = true;
    }

    if (item.js) {
      if (!appConfig.customJsList) appConfig.customJsList = [];
      const newId = item.id ? `js-${item.id}` : `js-${Date.now()}`;
      (appConfig.customJsList as unknown[]).push({
        id: newId,
        name: item.name || "Unknown JS",
        content: item.js,
        enable: true,
        useProxy: item.useProxy ?? false,
      });
      changed = true;
    }

    if (item.component) {
      const newId = "custom-css-" + Date.now();
      widgets.value.push({
        id: newId,
        type: "custom-css",
        enable: true,
        data: item.component,
        colSpan: 1,
        rowSpan: 1,
        isPublic: true,
      });
      changed = true;
    }

    return changed;
  };

  return {
    widgets,
    mergedWidgets,
    uiStateMap,
    serverLayoutMap,
    serverLayoutSignature,
    layoutDirty,
    layoutEditInProgress,
    lastSavedLayoutSignature,
    lastSavedLayoutSnapshot,
    normalizeIncomingWidgets,
    applyServerWidgets,
    setWidgetUiState,
    saveWidget,
    saveSingleWidget,
    checkLayoutDirty,
    updateLastSavedLayout,
    undoLayout,
    stripWidgetUiState,
    applyWidgetUiState,
    applyMarketplaceItem,
  };
});
