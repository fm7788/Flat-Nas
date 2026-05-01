// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, computed } from "vue";
import SimpleWeatherWidget from "./SimpleWeatherWidget.vue";

const { mockSaveSingleWidget, mockFetchWeather } = vi.hoisted(() => ({
  mockSaveSingleWidget: vi.fn(),
  mockFetchWeather: vi.fn(),
}));

vi.mock("../stores/main", () => ({
  useMainStore: vi.fn(() => ({
    isLogged: true,
    saveSingleWidget: mockSaveSingleWidget,
    weatherNetworkStatus: computed(() => "online"),
  })),
}));

vi.mock("@/composables/useWeather", () => ({
  useWeather: vi.fn(() => ({
    weather: ref({
      temp: "20.0",
      city: "宁波市",
      text: "多云",
      humidity: "82%",
      today: { min: "15.8", max: "30.0" },
      forecast: [],
    }),
    locationSource: ref("manual"),
    networkStatus: computed(() => "online"),
    fetchWeather: mockFetchWeather,
  })),
}));

describe("SimpleWeatherWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveSingleWidget.mockResolvedValue(true);
  });

  it("persists custom city to backend before refreshing weather", async () => {
    const wrapper = mount(SimpleWeatherWidget, {
      props: {
        widget: {
          id: "weather-1",
          type: "weather",
          enable: true,
          isPublic: true,
          data: { city: "宁波市" },
        },
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    });

    await wrapper.find('button[title="设置城市"]').trigger("click");
    const input = wrapper.find('input[placeholder="输入城市 (为空自动)"]');
    await input.setValue("上海市");
    await wrapper.findAll("button").find((b) => b.text() === "确定")?.trigger("click");

    expect(mockSaveSingleWidget).toHaveBeenCalledWith("weather-1", {
      data: { city: "上海市" },
      enable: true,
    });
    expect(mockFetchWeather).toHaveBeenCalledWith(true);
  });
});
