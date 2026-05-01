<script setup lang="ts">
import { computed } from "vue";
import { useMainStore } from "../stores/main";
import type { NavGroup } from "../types";
import IconShape from "./IconShape.vue";
import IconUploader from "./IconUploader.vue";
import OverlayMotion from "@/components/base/OverlayMotion.vue";

const props = defineProps<{
  show: boolean;
  groupId: string | null;
}>();

const emit = defineEmits(["update:show"]);
const store = useMainStore();

const group = computed(() => {
  return store.groups.find((g) => g.id === props.groupId);
});

const close = () => emit("update:show", false);

const updateGroup = (updates: Partial<NavGroup>) => {
  if (props.groupId) {
    store.updateGroup(props.groupId, updates);
  }
};

const handleDeleteGroup = () => {
  if (!group.value) return;
  if (confirm(`确定要删除分组 "${group.value.title}" 及其所有内容吗？`)) {
    store.deleteGroup(group.value.id, true);
    close();
  }
};

const handleReset = () => {
  if (!group.value) return;
  if (confirm("确定要重置此分组的所有设置，恢复为全局默认吗？")) {
    // Keep title and id, reset others
    const { id } = group.value;
    // We need to remove the optional properties from the group object in the store
    // Since we can't easily "delete" properties via partial update, we might need to manually handle this in store
    // Or just set them to undefined if the store handles it.
    // Let's try setting them to undefined.
    store.updateGroup(id, {
      titleColor: undefined,
      cardLayout: undefined,
      cardSize: undefined,
      gridGap: undefined,
      cardBgColor: undefined,
      showCardBackground: undefined,
      iconShape: undefined,
      backgroundImage: undefined,
      backgroundBlur: undefined,
      backgroundMask: undefined,
      autoHideTitle: undefined,
    });
  }
};

const handleBatchPublish = () => {
  if (!group.value) return;

  const updates: Partial<NavGroup> = { isPublic: true };
  if (group.value.items) {
    const newItems = group.value.items.map((item) => ({
      ...item,
      isPublic: true,
    }));
    updates.items = newItems;
  }
  updateGroup(updates);
};

const handleBatchUnpublish = () => {
  if (!group.value || !group.value.items) return;

  const newItems = group.value.items.map((item) => ({
    ...item,
    isPublic: false,
  }));
  updateGroup({ isPublic: false, items: newItems });
};

// --- Color Helper ---
const currentBgColor = computed(
  () => group.value?.cardBgColor || store.appConfig.cardBgColor || "#ffffff",
);

const bgHex = computed({
  get: () => {
    const c = currentBgColor.value;
    if (c.startsWith("#")) return c.substring(0, 7);
    if (c.startsWith("rgba") || c.startsWith("rgb")) {
      const rgb = c.match(/\d+/g);
      if (rgb && rgb.length >= 3) {
        const r = parseInt(rgb[0]).toString(16).padStart(2, "0");
        const g = parseInt(rgb[1]!).toString(16).padStart(2, "0");
        const b = parseInt(rgb[2]!).toString(16).padStart(2, "0");
        return `#${r}${g}${b}`;
      }
    }
    return "#ffffff";
  },
  set: (val) => {
    const alpha = bgAlpha.value;
    const r = parseInt(val.slice(1, 3), 16);
    const g = parseInt(val.slice(3, 5), 16);
    const b = parseInt(val.slice(5, 7), 16);
    updateGroup({ cardBgColor: `rgba(${r}, ${g}, ${b}, ${alpha})` });
  },
});

const bgAlpha = computed({
  get: () => {
    const c = currentBgColor.value;
    if (c.startsWith("rgba")) {
      const parts = c.match(/[\d\.]+/g);
      if (parts && parts.length >= 4) {
        return parseFloat(parts[3]!);
      }
    }
    return 1;
  },
  set: (val) => {
    const hex = bgHex.value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    updateGroup({ cardBgColor: `rgba(${r}, ${g}, ${b}, ${val})` });
  },
});
</script>

<template>
  <OverlayMotion
    :show="show && !!group"
    :z-index="50"
    close-on-overlay
    overlay-class="bg-black/40 backdrop-blur-sm p-4"
    panel-class="max-w-md"
    @close="close"
  >
    <div class="bg-white rounded-2xl shadow-2xl w-full overflow-hidden">
      <!-- Header -->
      <div
        class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50"
      >
        <h3 class="text-lg font-bold text-gray-800">分组设置</h3>
        <button @click="close" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">
          &times;
        </button>
      </div>

      <!-- Body -->
      <div class="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
        <!-- Group Title -->
        <div>
          <label class="block text-sm font-bold text-gray-600 mb-2">分组标题</label>
          <div class="flex gap-3 mb-3">
            <input
              :value="group.title"
              @input="(e) => updateGroup({ title: (e.target as HTMLInputElement).value })"
              type="text"
              class="flex-1 px-4 py-2 rounded-lg border border-gray-200 focus:border-blue-500 outline-none transition-colors"
            />
            <input
              type="color"
              :value="group.titleColor || store.appConfig.titleColor || '#374151'"
              @input="(e) => updateGroup({ titleColor: (e.target as HTMLInputElement).value })"
              class="w-10 h-10 rounded cursor-pointer border-0 p-0"
              title="标题颜色"
            />
          </div>

          <!-- Is Public Toggle -->
          <div
            class="flex items-center justify-between bg-gray-50 p-3 rounded-lg border border-gray-100"
          >
            <div class="flex flex-col">
              <span class="text-xs font-bold text-gray-700">公开此分组（一次性执行）</span>
              <span class="text-[10px] text-gray-400">允许未登录访客查看此分组内容</span>
            </div>
            <div class="flex gap-2">
              <button
                @click="handleBatchUnpublish"
                class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 text-xs font-bold rounded-lg shadow-sm hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
              >
                不公开
              </button>
              <button
                @click="handleBatchPublish"
                class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 text-xs font-bold rounded-lg shadow-sm hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-colors"
              >
                公开
              </button>
            </div>
          </div>

          <!-- Auto Hide Title Toggle -->
          <div
            class="flex items-center justify-between bg-gray-50 p-3 rounded-lg border border-gray-100"
          >
            <div class="flex flex-col">
              <span class="text-xs font-bold text-gray-700">自动隐藏标题</span>
              <span class="text-[10px] text-gray-400">鼠标悬停时才显示组名和操作按钮</span>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="!!group.autoHideTitle"
                @change="
                  (e) => updateGroup({ autoHideTitle: (e.target as HTMLInputElement).checked })
                "
                class="sr-only peer"
              />
              <div
                class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"
              ></div>
            </label>
          </div>
        </div>

        <div class="border-t border-gray-100"></div>

        <!-- Layout & Spacing -->
        <div>
          <h4 class="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span>📐 布局与间距</span>
            <span
              v-if="group.cardLayout || group.gridGap"
              class="text-[10px] px-2 py-0.5 bg-blue-100 text-blue-600 rounded-full"
              >已自定义</span
            >
          </h4>

          <div class="space-y-4">
            <!-- Card Layout -->
            <div>
              <label class="text-xs font-bold text-gray-500 mb-2 block">卡片布局</label>
              <div class="flex gap-2 bg-gray-100 p-1 rounded-lg">
                <button
                  @click="updateGroup({ cardLayout: 'vertical' })"
                  class="flex-1 py-1.5 text-xs rounded-md transition-all flex items-center justify-center gap-1"
                  :class="
                    (group.cardLayout || store.appConfig.cardLayout) === 'vertical'
                      ? 'bg-white shadow-sm text-blue-600 font-bold'
                      : 'text-gray-500 hover:text-gray-700'
                  "
                >
                  <span class="text-base">📱</span> 垂直
                </button>
                <button
                  @click="updateGroup({ cardLayout: 'horizontal' })"
                  class="flex-1 py-1.5 text-xs rounded-md transition-all flex items-center justify-center gap-1"
                  :class="
                    (group.cardLayout || store.appConfig.cardLayout) === 'horizontal'
                      ? 'bg-white shadow-sm text-blue-600 font-bold'
                      : 'text-gray-500 hover:text-gray-700'
                  "
                >
                  <span class="text-base">💳</span> 水平
                </button>
              </div>
            </div>

            <!-- Grid Gap -->
            <div>
              <div class="flex justify-between mb-2">
                <label class="text-xs font-bold text-gray-500">卡片间距</label>
                <span class="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 rounded"
                  >{{ group.gridGap ?? store.appConfig.gridGap }}px</span
                >
              </div>
              <input
                type="range"
                :value="group.gridGap ?? store.appConfig.gridGap"
                @input="
                  (e) => updateGroup({ gridGap: parseInt((e.target as HTMLInputElement).value) })
                "
                min="4"
                max="32"
                step="2"
                class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
              />
            </div>

            <!-- Card Size -->
            <div>
              <div class="flex justify-between mb-2">
                <label class="text-xs font-bold text-gray-500">卡片大小</label>
                <span class="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 rounded"
                  >{{ group.cardSize ?? store.appConfig.cardSize ?? 120 }}px</span
                >
              </div>
              <input
                type="range"
                :value="group.cardSize ?? store.appConfig.cardSize ?? 120"
                @input="
                  (e) => updateGroup({ cardSize: parseInt((e.target as HTMLInputElement).value) })
                "
                min="60"
                max="216"
                step="4"
                class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
              />
            </div>

            <!-- Icon Size -->
            <div>
              <div class="flex justify-between mb-2">
                <label class="text-xs font-bold text-gray-500">图标大小</label>
                <span class="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 rounded"
                  >{{ group.iconSize ?? store.appConfig.iconSize ?? 48 }}px</span
                >
              </div>
              <input
                type="range"
                :value="group.iconSize ?? store.appConfig.iconSize ?? 48"
                @input="
                  (e) => updateGroup({ iconSize: parseInt((e.target as HTMLInputElement).value) })
                "
                min="20"
                max="100"
                step="2"
                class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
              />
            </div>
          </div>
        </div>

        <div class="border-t border-gray-100"></div>

        <!-- Card Style -->
        <div>
          <h4 class="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span>🎨 卡片样式</span>
            <span
              v-if="group.cardBgColor || group.showCardBackground !== undefined || group.iconShape"
              class="text-[10px] px-2 py-0.5 bg-purple-100 text-purple-600 rounded-full"
              >已自定义</span
            >
          </h4>

          <div class="space-y-4">
            <!-- Background Toggle & Color & Title Color -->
            <div class="flex items-center justify-between">
              <div>
                <div class="text-xs font-bold text-gray-600">卡片外观</div>
                <div class="text-[10px] text-gray-400">背景色 / 字体颜色</div>
              </div>
              <div class="flex items-center gap-3">
                <!-- Card Title Color -->
                <div class="flex flex-col items-center gap-1" title="卡片标题颜色">
                  <span class="text-[10px] text-gray-400">文字</span>
                  <input
                    type="color"
                    :value="group.cardTitleColor || store.appConfig.cardTitleColor || '#111827'"
                    @input="
                      (e) => updateGroup({ cardTitleColor: (e.target as HTMLInputElement).value })
                    "
                    class="w-6 h-6 rounded-full cursor-pointer border-0 p-0 overflow-hidden shadow-sm"
                  />
                </div>

                <div class="w-px h-8 bg-gray-200 mx-1"></div>

                <!-- Card Background Color -->
                <div class="flex flex-col items-center gap-1" title="卡片背景颜色">
                  <span class="text-[10px] text-gray-400">背景</span>
                  <input
                    v-if="group.showCardBackground ?? store.appConfig.showCardBackground"
                    type="color"
                    v-model="bgHex"
                    class="w-6 h-6 rounded-full cursor-pointer border-0 p-0 overflow-hidden shadow-sm"
                  />
                </div>

                <!-- Opacity Slider -->
                <div
                  class="flex flex-col items-center gap-1 w-16"
                  v-if="group.showCardBackground ?? store.appConfig.showCardBackground"
                >
                  <span class="text-[10px] text-gray-400"
                    >透明度 {{ Math.round(bgAlpha * 100) }}%</span
                  >
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    v-model.number="bgAlpha"
                    class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
                  />
                </div>

                <!-- Show Background Toggle -->
                <div class="flex flex-col items-center gap-1">
                  <span class="text-[10px] text-gray-400">显示</span>
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      :checked="group.showCardBackground ?? store.appConfig.showCardBackground"
                      @change="
                        (e) =>
                          updateGroup({
                            showCardBackground: (e.target as HTMLInputElement).checked,
                          })
                      "
                      class="sr-only peer"
                    />
                    <div
                      class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"
                    ></div>
                  </label>
                </div>
              </div>
            </div>

            <!-- Group Card Background Image -->
            <div class="border-t border-gray-100 pt-4">
              <label class="text-xs font-bold text-gray-500 mb-2 block">
                卡片背景图
                <span class="text-[10px] font-normal text-gray-400">(应用到组内所有卡片)</span>
              </label>
              <div class="space-y-3">
                <div class="flex items-center gap-2">
                  <input
                    :value="group.backgroundImage"
                    @input="
                      (e) => updateGroup({ backgroundImage: (e.target as HTMLInputElement).value })
                    "
                    type="text"
                    placeholder="背景图 URL..."
                    class="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:border-blue-500"
                  />
                  <button
                    v-if="group.backgroundImage"
                    @click="updateGroup({ backgroundImage: '' })"
                    class="text-gray-400 hover:text-red-500 px-2"
                    title="清除背景"
                  >
                    ✕
                  </button>
                </div>

                <IconUploader
                  :modelValue="group.backgroundImage"
                  @update:modelValue="(val) => updateGroup({ backgroundImage: val })"
                  :crop="false"
                  :uploadOnly="true"
                  :previewStyle="{
                    filter: `blur(${group.backgroundBlur ?? 6}px)`,
                    transform: 'scale(1.1)',
                  }"
                  :overlayStyle="{
                    backgroundColor: `rgba(0,0,0,${group.backgroundMask ?? 0.3})`,
                  }"
                />

                <div
                  v-if="group.backgroundImage"
                  class="grid grid-cols-2 gap-4 mt-2 p-3 bg-gray-50 rounded-lg"
                >
                  <div>
                    <label class="block text-[10px] text-gray-400 mb-1 flex justify-between">
                      <span>模糊半径</span>
                      <span>{{ group.backgroundBlur ?? 6 }}px</span>
                    </label>
                    <input
                      type="range"
                      :value="group.backgroundBlur ?? 6"
                      @input="
                        (e) =>
                          updateGroup({
                            backgroundBlur: parseInt((e.target as HTMLInputElement).value),
                          })
                      "
                      min="0"
                      max="20"
                      step="1"
                      class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
                    />
                  </div>
                  <div>
                    <label class="block text-[10px] text-gray-400 mb-1 flex justify-between">
                      <span>遮罩浓度</span>
                      <span>{{ Math.round((group.backgroundMask ?? 0.3) * 100) }}%</span>
                    </label>
                    <input
                      type="range"
                      :value="group.backgroundMask ?? 0.3"
                      @input="
                        (e) =>
                          updateGroup({
                            backgroundMask: parseFloat((e.target as HTMLInputElement).value),
                          })
                      "
                      min="0"
                      max="1"
                      step="0.1"
                      class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
                    />
                  </div>
                </div>
              </div>
            </div>

            <!-- Icon Shape -->
            <div>
              <label class="text-xs font-bold text-gray-500 mb-2 block">图标形状</label>
              <div class="flex gap-3 items-center">
                <select
                  :value="group.iconShape || store.appConfig.iconShape"
                  @change="(e) => updateGroup({ iconShape: (e.target as HTMLInputElement).value })"
                  class="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:border-blue-500"
                >
                  <option value="none">无形状</option>
                  <option value="hidden">不使用图标</option>
                  <option value="rounded">圆角矩形</option>
                  <option value="square">方形</option>
                  <option value="circle">圆形</option>
                  <option value="leaf">叶形</option>
                  <option value="diamond">菱形</option>
                  <option value="pentagon">五角形</option>
                  <option value="hexagon">六边形</option>
                  <option value="octagon">八边形</option>
                </select>
                <div class="w-10 h-10 flex items-center justify-center bg-gray-100 rounded-lg">
                  <IconShape
                    :shape="group.iconShape || store.appConfig.iconShape"
                    :size="24"
                    bgClass="fill-blue-500"
                    icon=""
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-gray-100"></div>

        <!-- Actions -->
        <div class="space-y-3">
          <button
            @click="handleReset"
            class="w-full py-2.5 rounded-xl text-sm font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
          >
            <span>🔄</span> 恢复默认设置
          </button>

          <button
            @click="handleDeleteGroup"
            class="w-full py-2.5 rounded-xl text-sm font-bold text-red-600 bg-red-50 hover:bg-red-100 transition-colors flex items-center justify-center gap-2"
          >
            <span>🗑️</span> 删除此分组
          </button>
        </div>
      </div>
    </div>
  </OverlayMotion>
</template>

<style scoped>
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  height: 16px;
  width: 16px;
  border-radius: 50%;
  background: #3b82f6;
  cursor: pointer;
  margin-top: -6px;
}
input[type="range"]::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  cursor: pointer;
  background: #e5e7eb;
  border-radius: 2px;
}
</style>
