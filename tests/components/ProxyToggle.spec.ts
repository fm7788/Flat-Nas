// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import ProxyToggle from "../../src/components/ProxyToggle.vue";

describe("ProxyToggle", () => {
  beforeEach(() => {
    // Reset fetch mock
    global.fetch = vi.fn();
  });

  it("renders disabled state by default (switch off)", async () => {
    // Mock proxy available but switch off
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ available: true }),
    });

    const wrapper = mount(ProxyToggle, {
      props: {
        modelValue: false,
      },
    });

    // Wait for onMounted
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    const input = wrapper.find('input[type="checkbox"]');
    expect((input.element as HTMLInputElement).checked).toBe(false);
  });

  it("renders enabled state when modelValue is true", async () => {
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ available: true }),
    });

    const wrapper = mount(ProxyToggle, {
      props: {
        modelValue: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    const input = wrapper.find('input[type="checkbox"]');
    expect((input.element as HTMLInputElement).checked).toBe(true);
  });

  it("emits update:modelValue when clicked", async () => {
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ available: true }),
    });

    const wrapper = mount(ProxyToggle, {
      props: {
        modelValue: false,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    const input = wrapper.find('input[type="checkbox"]');
    await input.setValue(true);

    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([true]);
  });

  it("does not render if proxy is unavailable", async () => {
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ available: false }),
    });

    const wrapper = mount(ProxyToggle, {
      props: {
        modelValue: false,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toBe("");
  });
});
