// @vitest-environment jsdom
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AliIcon } from "@/types";
import {
  extractKeywordFromUrl,
  normalizeUserUrl,
  pickAliIconsWithFuse,
  resetSmartIconMatchCacheForTests,
  useSmartIconMatch,
  validateDataUriIcon,
} from "./useSmartIconMatch";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;

  set src(value: string) {
    queueMicrotask(() => {
      if (value.includes("favicon.vip") || value.includes("icon.bqb.cool") || value.includes("afmax.cn") || value.includes("quickso.cn") || value.includes("INVALID")) {
        this.onerror?.();
        return;
      }

      if (value.includes("TINY")) {
        this.naturalWidth = 1;
        this.naturalHeight = 1;
        this.width = 1;
        this.height = 1;
      } else {
        this.naturalWidth = 16;
        this.naturalHeight = 16;
        this.width = 16;
        this.height = 16;
      }
      this.onload?.();
    });
  }
}

const createAliIcons = (count: number): AliIcon[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `demo-${index}`,
    cnName: `演示-${index}`,
    domain: `demo${index}.example.com`,
    filename: `demo-${index}.png`,
    url: `https://cdn.example.com/demo-${index}.png`,
    downloadUrl: `https://cdn.example.com/demo-${index}.png`,
  }));

describe("useSmartIconMatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSmartIconMatchCacheForTests();
    vi.stubGlobal("Image", FakeImage);
  });

  it("normalizes external and local URLs", () => {
    expect(normalizeUserUrl("example.com/app")).toBe("https://example.com/app");
    expect(normalizeUserUrl("192.168.1.15/admin")).toBe("http://192.168.1.15/admin");
  });

  it("extracts keyword from URL without scheme", () => {
    expect(extractKeywordFromUrl("news.163.com")).toBe("163");
    expect(extractKeywordFromUrl("https://www.github.com")).toBe("github");
  });

  it("limits ali fuse results", () => {
    const urls = pickAliIconsWithFuse(createAliIcons(20), "demo", 5);
    expect(urls).toHaveLength(5);
  });

  it("rejects non-image data URIs", async () => {
    await expect(validateDataUriIcon("data:text/html;base64,VALID")).resolves.toBe(false);
    await expect(validateDataUriIcon("data:image/png;base64,TINY")).resolves.toBe(false);
    await expect(validateDataUriIcon("data:image/png;base64,VALID")).resolves.toBe(true);
  });

  it("keeps a single valid candidate for manual confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/ali-icons") {
          return {
            ok: true,
            json: async () => [
              {
                name: "demo",
                cnName: "演示",
                domain: "demo.example.com",
                filename: "demo.png",
                url: "https://cdn.example.com/only-one.png",
                downloadUrl: "https://cdn.example.com/only-one.png",
              },
            ],
          };
        }

        return {
          ok: true,
          json: async () => ({
            success: true,
            icon: "data:image/png;base64,TINY",
          }),
        };
      }),
    );

    const notify = vi.fn();
    const onSelect = vi.fn();
    const form = ref({
      title: "demo",
      url: "",
      lanUrl: "",
      icon: "",
    });

    const smartIconMatch = useSmartIconMatch({
      form,
      onSelect,
      notify,
    });

    await smartIconMatch.smartMatchIcons();

    expect(smartIconMatch.isSmartMatching.value).toBe(false);
    expect(smartIconMatch.smartMatchCandidates.value).toEqual([
      expect.objectContaining({
        url: "https://cdn.example.com/only-one.png",
        source: "ali",
        label: "演示",
      }),
    ]);
    expect(smartIconMatch.showSmartMatchModal.value).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("includes site favicon alongside ali matches when both succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/ali-icons") {
          return {
            ok: true,
            json: async () => [
              {
                name: "portal-service",
                cnName: "门户",
                domain: "portal-service.example.com",
                filename: "portal.png",
                url: "https://cdn.example.com/portal.png",
                downloadUrl: "https://cdn.example.com/portal.png",
              },
            ],
          };
        }

        return {
          ok: false,
          json: async () => ({}),
        };
      }),
    );

    const form = ref({
      title: "portal",
      url: "example.com",
      lanUrl: "",
      icon: "",
    });

    const smartIconMatch = useSmartIconMatch({
      form,
      onSelect: vi.fn(),
      notify: vi.fn(),
    });

    await smartIconMatch.smartMatchIcons();

    expect(smartIconMatch.smartMatchCandidates.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/favicon.ico",
          source: "favicon",
        }),
        expect.objectContaining({
          url: "https://cdn.example.com/portal.png",
          source: "ali",
        }),
      ]),
    );
  });

  it("falls back to domain keyword and manual icon term when title misses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/ali-icons") {
          return {
            ok: true,
            json: async () => [
              {
                name: "github",
                cnName: "代码托管",
                domain: "github.com",
                filename: "github.png",
                url: "https://cdn.example.com/github.png",
                downloadUrl: "https://cdn.example.com/github.png",
              },
              {
                name: "octocat",
                cnName: "章鱼猫",
                domain: "octocat.example.com",
                filename: "octocat.png",
                url: "https://cdn.example.com/octocat.png",
                downloadUrl: "https://cdn.example.com/octocat.png",
              },
            ],
          };
        }

        return {
          ok: true,
          json: async () => ({
            success: true,
            icon: "data:image/png;base64,TINY",
          }),
        };
      }),
    );

    const form = ref({
      title: "控制台",
      url: "github.com",
      lanUrl: "",
      icon: "octocat",
    });

    const smartIconMatch = useSmartIconMatch({
      form,
      onSelect: vi.fn(),
      notify: vi.fn(),
    });

    await smartIconMatch.smartMatchIcons();

    expect(smartIconMatch.smartMatchCandidates.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://cdn.example.com/github.png",
          source: "ali",
          label: "代码托管",
        }),
        expect.objectContaining({
          url: "https://cdn.example.com/octocat.png",
          source: "ali",
          label: "章鱼猫",
        }),
      ]),
    );
  });

  it("proxies ali icons into previewable data URIs when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/ali-icons") {
          return {
            ok: true,
            json: async () => [
              {
                name: "demo",
                cnName: "演示",
                domain: "demo.example.com",
                filename: "demo.png",
                url: "https://cdn.example.com/demo.png",
                downloadUrl: "https://cdn.example.com/demo.png",
              },
            ],
          };
        }

        if (url.startsWith("/api/get-icon-base64?url=")) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              icon: "data:image/png;base64,VALID",
            }),
          };
        }

        return {
          ok: false,
          json: async () => ({}),
        };
      }),
    );

    const smartIconMatch = useSmartIconMatch({
      form: ref({
        title: "demo",
        url: "",
        lanUrl: "",
        icon: "",
      }),
      onSelect: vi.fn(),
      notify: vi.fn(),
    });

    await smartIconMatch.smartMatchIcons();

    expect(smartIconMatch.smartMatchCandidates.value).toEqual([
      expect.objectContaining({
        url: "data:image/png;base64,VALID",
        source: "ali",
        label: "演示",
      }),
    ]);
  });

  it("cancels in-flight smart match requests after selecting a candidate", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ali-icons") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              name: "demo",
              cnName: "演示",
              domain: "demo.example.com",
              filename: "demo.png",
              url: "https://cdn.example.com/demo.png",
              downloadUrl: "https://cdn.example.com/demo.png",
            },
          ],
        });
      }

      if (url.startsWith("/api/get-icon-base64?url=https%3A%2F%2Fcdn.example.com%2Fdemo.png")) {
        return Promise.resolve({
          ok: false,
          json: async () => ({}),
        });
      }

      if (url.startsWith("/api/get-icon-base64?url=")) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }

      return Promise.resolve({
        ok: false,
        json: async () => ({}),
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const onSelect = vi.fn();
    const smartIconMatch = useSmartIconMatch({
      form: ref({
        title: "demo",
        url: "example.com",
        lanUrl: "",
        icon: "",
      }),
      onSelect,
      notify: vi.fn(),
    });

    const pendingMatch = smartIconMatch.smartMatchIcons();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const candidate = smartIconMatch.smartMatchCandidates.value[0];
    expect(candidate).toEqual(
      expect.objectContaining({
        source: "ali",
      }),
    );
    expect(smartIconMatch.isSmartMatching.value).toBe(true);

    smartIconMatch.selectSmartMatchCandidate(candidate);
    await pendingMatch;

    expect(onSelect).toHaveBeenCalledWith(candidate.url);
    expect(smartIconMatch.isSmartMatching.value).toBe(false);
    expect(smartIconMatch.showSmartMatchModal.value).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/get-icon-base64?url="),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
