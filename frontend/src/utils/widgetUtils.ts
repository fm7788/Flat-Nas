/**
 * Widget-related utility functions extracted from main.ts.
 * These functions handle widget normalization, deduplication, and defaults.
 */

import type { WidgetConfig } from "@/types";

/**
 * Create default widget list when no widgets are provided.
 */
export function createDefaultWidgetList(isLoggedIn: boolean): WidgetConfig[] {
  const base: WidgetConfig[] = [
    { id: "w1", type: "clock", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
    { id: "w2", type: "weather", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
    { id: "w3", type: "calendar", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
    { id: "w5", type: "search", enable: true, isPublic: true },
    { id: "w7", type: "quote", enable: true, isPublic: true },
    {
      id: "clockweather",
      type: "clockweather",
      enable: true,
      colSpan: 1,
      rowSpan: 1,
      isPublic: true,
    },
    { id: "sidebar", type: "sidebar", enable: false, isPublic: true },
    { id: "docker", type: "docker", enable: false, isPublic: true, colSpan: 1, rowSpan: 1 },
    {
      id: "file-transfer",
      type: "file-transfer",
      enable: true,
      colSpan: 2,
      rowSpan: 2,
      isPublic: true,
    },
    {
      id: "system-status",
      type: "system-status",
      enable: false,
      isPublic: true,
      colSpan: 1,
      rowSpan: 1,
      data: { useMock: false },
    },
    { id: "memo", type: "memo", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
    { id: "todo", type: "todo", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
    {
      id: "calculator",
      type: "calculator",
      enable: true,
      colSpan: 1,
      rowSpan: 1,
      isPublic: true,
    },
    { id: "ip", type: "ip", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
    { id: "hot", type: "hot", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
    { id: "player", type: "player", enable: true, colSpan: 2, rowSpan: 1, isPublic: true },
    {
      id: "status-monitor",
      type: "status-monitor",
      enable: false,
      colSpan: 1,
      rowSpan: 1,
      isPublic: true,
    },
  ];

  // Filter out login-only widgets for guests
  if (!isLoggedIn) {
    return base.filter((w) => {
      const loginOnly = ["docker", "file-transfer", "system-status", "sidebar", "status-monitor"];
      return !loginOnly.includes(w.id);
    });
  }

  return base;
}

/**
 * Normalize incoming widget list: fix duplicates, missing defaults, ID conflicts.
 */
export function normalizeIncomingWidgets(
  input?: WidgetConfig[],
  isLoggedIn?: boolean,
): WidgetConfig[] {
  const nextWidgets = Array.isArray(input) ? input.map((widget) => ({ ...widget })) : [];

  if (nextWidgets.length === 0) {
    return createDefaultWidgetList(!!isLoggedIn);
  }

  // Fix memo type
  const memoW = nextWidgets.find((widget) => widget.id === "memo");
  if (memoW && memoW.type !== "memo") {
    memoW.type = "memo";
  }

  // Normalize Docker widget
  let dockerCandidate = nextWidgets.find((widget) => widget.id === "docker");
  if (!dockerCandidate) {
    dockerCandidate = nextWidgets.find((widget) => widget.type === "docker");
  }
  const listWithoutDocker = nextWidgets.filter(
    (widget) => widget.id !== "docker" && widget.type !== "docker",
  );
  let finalDockerWidget: WidgetConfig | undefined;
  if (dockerCandidate) {
    finalDockerWidget = dockerCandidate;
    finalDockerWidget.id = "docker";
    finalDockerWidget.type = "docker";
    if (typeof finalDockerWidget.colSpan !== "number") finalDockerWidget.colSpan = 1;
    if (typeof finalDockerWidget.rowSpan !== "number") finalDockerWidget.rowSpan = 1;
    if (typeof finalDockerWidget.enable !== "boolean") finalDockerWidget.enable = false;
    if (typeof finalDockerWidget.isPublic !== "boolean") finalDockerWidget.isPublic = true;
  } else if (isLoggedIn) {
    finalDockerWidget = {
      id: "docker",
      type: "docker",
      enable: false,
      isPublic: true,
      colSpan: 1,
      rowSpan: 1,
    };
  }
  if (finalDockerWidget) {
    listWithoutDocker.push(finalDockerWidget);
  }

  // Normalize File Transfer widget (deduplicate)
  const fileTransferList = listWithoutDocker.filter((widget) => widget.type === "file-transfer");
  if (fileTransferList.length > 1) {
    const keep =
      fileTransferList.find((widget) => widget.id === "file-transfer") || fileTransferList[0]!;
    const filtered = listWithoutDocker.filter(
      (widget) => widget.type !== "file-transfer" || widget === keep,
    );
    if (
      keep.id !== "file-transfer" &&
      !filtered.some((widget) => widget.id === "file-transfer" && widget.type !== "file-transfer")
    ) {
      keep.id = "file-transfer";
    }
    nextWidgets.length = 0;
    nextWidgets.push(...filtered);
  } else if (
    fileTransferList.length === 1 &&
    fileTransferList[0]!.id !== "file-transfer" &&
    !listWithoutDocker.some(
      (widget) => widget.id === "file-transfer" && widget.type !== "file-transfer",
    )
  ) {
    fileTransferList[0]!.id = "file-transfer";
    nextWidgets.length = 0;
    nextWidgets.push(...listWithoutDocker);
  } else if (fileTransferList.length === 0 && isLoggedIn) {
    listWithoutDocker.push({
      id: "file-transfer",
      type: "file-transfer",
      enable: true,
      colSpan: 2,
      rowSpan: 2,
      isPublic: true,
    });
    nextWidgets.length = 0;
    nextWidgets.push(...listWithoutDocker);
  } else {
    nextWidgets.length = 0;
    nextWidgets.push(...listWithoutDocker);
  }

  // Keep normalization and "restore defaults" aligned to the same source of truth.
  for (const fallback of createDefaultWidgetList(!!isLoggedIn)) {
    if (!nextWidgets.some((widget) => widget.type === fallback.type)) {
      nextWidgets.push(fallback);
    }
  }

  return nextWidgets;
}
