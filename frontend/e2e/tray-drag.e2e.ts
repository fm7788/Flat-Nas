import { test, expect } from "@playwright/test";

const seedCache = {
  username: "admin",
  appConfig: {},
  groups: [
    {
      id: "group-1",
      title: "分组一",
      items: [
        {
          id: "group-item-1",
          title: "Group Item",
          url: "https://example.com/group",
          icon: "",
          isPublic: true,
        },
      ],
    },
  ],
  widgets: [
    {
      id: "tray-1",
      type: "card-tray",
      enable: true,
      data: {
        cards: [
          {
            id: "tray-card-1",
            title: "Tray A",
            url: "https://example.com/a",
            icon: "",
            isPublic: true,
          },
          {
            id: "tray-card-2",
            title: "Tray B",
            url: "https://example.com/b",
            icon: "",
            isPublic: true,
          },
        ],
      },
      colSpan: 1,
      rowSpan: 1,
      isPublic: true,
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/data", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...seedCache,
        rssFeeds: [],
        rssCategories: [],
        systemConfig: { authMode: "single" },
      }),
    });
  });
  await page.route("**/api/save", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/system-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authMode: "single" }),
    });
  });
  await page.addInitScript((cache) => {
    localStorage.setItem("flat-nas-data-cache", JSON.stringify(cache));
    localStorage.setItem("flat-nas-token", "e2e-token");
    localStorage.setItem("flat-nas-username", "admin");
  }, seedCache);
});

test("托盘拖拽不影响分组数据且位置更新", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="toggle-edit-mode"]:visible').click();
  await page.getByTestId("card-tray").waitFor();
  await expect(page.getByTestId("tray-card-tray-card-1")).toHaveAttribute("draggable", "true");

  const beforeGroups = await page.evaluate(() => {
    const json = localStorage.getItem("flat-nas-data-cache") || "{}";
    const parsed = JSON.parse(json);
    return parsed.groups;
  });

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.dispatchEvent('[data-testid="tray-card-tray-card-1"]', "dragstart", { dataTransfer });
  await page.dispatchEvent('[data-testid="tray-tile-1"]', "dragover", { dataTransfer });
  await page.dispatchEvent('[data-testid="tray-tile-1"]', "drop", { dataTransfer });
  await page.dispatchEvent('[data-testid="tray-card-tray-card-1"]', "dragend", { dataTransfer });

  await page.waitForTimeout(700);

  await expect(
    page.getByTestId("tray-tile-0").getByTestId("tray-card-tray-card-2"),
  ).toBeVisible();

  const afterGroups = await page.evaluate(() => {
    const json = localStorage.getItem("flat-nas-data-cache") || "{}";
    const parsed = JSON.parse(json);
    return parsed.groups;
  });

  expect(afterGroups).toEqual(beforeGroups);
  await expect(
    page.getByTestId("tray-tile-1").getByTestId("tray-card-tray-card-1"),
  ).toBeVisible();
});
