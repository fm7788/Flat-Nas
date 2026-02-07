<script setup lang="ts">
import { ref, watch } from "vue";
import type { CustomScript } from "@/types";
import { VueDraggable as Draggable } from "vue-draggable-plus";

const props = defineProps<{
  modelValue: CustomScript[];
  type: "css" | "js";
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: CustomScript[]): void;
  (e: "change"): void;
}>();

const list = ref<CustomScript[]>(props.modelValue || []);
const activeId = ref<string | null>(null);
const deleteConfirmId = ref<string | null>(null);
const isDragging = ref(false);
let deleteTimeout: number | null = null;

watch(
  () => props.modelValue,
  (val) => {
    // Only update if reference changed or length different to avoid breaking local editing state
    if (val !== list.value) {
      list.value = val || [];
    }
  },
  { deep: true },
);

const updateList = () => {
  emit("update:modelValue", list.value);
  emit("change");
};

const readFileContent = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = (e) => reject(e);
    reader.readAsText(file);
  });
};

const handleFileDrop = async (e: DragEvent) => {
  isDragging.value = false;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    try {
      const content = await readFileContent(file);
      const id = Date.now().toString() + Math.random().toString(36).substring(2, 5);

      list.value.push({
        id,
        name: file.name,
        content: content,
        enable: true,
      });

      // If only one file, expand it
      if (files.length === 1) {
        activeId.value = id;
      }
    } catch (error) {
      console.error("Error reading file:", file.name, error);
    }
  }
  updateList();
};

const onDragLeave = (e: DragEvent) => {
  const target = e.relatedTarget as Node;
  const currentTarget = e.currentTarget as Node;
  if (target && currentTarget.contains(target)) {
    return;
  }
  isDragging.value = false;
};

const addItem = () => {
  const id = Date.now().toString();
  list.value.push({
    id,
    name: `新脚本 ${list.value.length + 1}`,
    content: "",
    enable: true,
  });
  activeId.value = id;
  updateList();
};

const deleteItem = (id: string) => {
  if (deleteConfirmId.value === id) {
    // Confirmed
    list.value = list.value.filter((item) => item.id !== id);
    if (activeId.value === id) activeId.value = null;
    deleteConfirmId.value = null;
    if (deleteTimeout) clearTimeout(deleteTimeout);
    updateList();
  } else {
    // First click
    deleteConfirmId.value = id;
    if (deleteTimeout) clearTimeout(deleteTimeout);
    deleteTimeout = setTimeout(() => {
      deleteConfirmId.value = null;
    }, 3000) as unknown as number;
  }
};

const toggleEnable = (item: CustomScript) => {
  item.enable = !item.enable;
  updateList();
};

const toggleProxy = (item: CustomScript) => {
  item.useProxy = !item.useProxy;
  updateList();
};
</script>

<template>
  <div
    class="space-y-4 relative"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="handleFileDrop"
  >
    <div
      v-if="isDragging"
      class="absolute inset-0 z-50 bg-blue-50 bg-opacity-90 border-2 border-dashed border-blue-500 rounded-xl flex flex-col items-center justify-center text-blue-500 pointer-events-none transition-all"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-12 w-12 mb-2"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
        />
      </svg>
      <span class="font-bold text-lg">释放文件以添加</span>
    </div>
    <div class="space-y-2">
      <Draggable
        v-model="list"
        @end="updateList"
        handle=".drag-handle"
        item-key="id"
        class="space-y-2"
        :animation="150"
      >
        <div
          v-for="element in list"
          :key="element.id"
          class="border border-gray-200 rounded-xl bg-white overflow-hidden transition-all"
          :class="{ 'ring-2 ring-blue-500 ring-opacity-50': activeId === element.id }"
        >
          <!-- Header -->
          <div
            class="flex items-center p-3 gap-3 bg-gray-50 hover:bg-gray-100 cursor-pointer select-none"
            @click="activeId = activeId === element.id ? null : element.id"
          >
            <div class="drag-handle cursor-move text-gray-400 hover:text-gray-600">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </div>

            <div class="flex-1 font-bold text-gray-700 text-sm truncate">
              {{ element.name }}
            </div>

            <div class="flex items-center gap-2" @click.stop>
              <!-- Proxy Switch -->
              <label
                class="relative inline-flex items-center cursor-pointer mr-1"
                title="通过本地网络"
              >
                <input
                  type="checkbox"
                  :checked="!!element.useProxy"
                  @change="toggleProxy(element)"
                  class="sr-only peer"
                />
                <div
                  class="w-7 h-4 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-purple-500"
                ></div>
                <span class="ml-1 text-xs text-gray-500 font-medium">通过本地网络</span>
              </label>

              <!-- Enable Switch -->
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  :checked="element.enable"
                  @change="toggleEnable(element)"
                  class="sr-only peer"
                />
                <div
                  class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-500"
                ></div>
              </label>

              <!-- Delete Button -->
              <button
                @click="deleteItem(element.id)"
                class="p-1.5 rounded-lg transition-all flex items-center gap-1 overflow-hidden"
                :class="
                  deleteConfirmId === element.id
                    ? 'bg-red-500 text-white w-20 justify-center'
                    : 'text-gray-400 hover:text-red-500 hover:bg-red-50 w-8 justify-center'
                "
                :title="deleteConfirmId === element.id ? '点击确认删除' : '删除'"
              >
                <span
                  v-if="deleteConfirmId === element.id"
                  class="text-xs font-bold whitespace-nowrap"
                  >确认?</span
                >
                <svg
                  v-else
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-4 w-4 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>

            <div class="text-gray-400">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4 transition-transform duration-200"
                :class="{ 'rotate-180': activeId === element.id }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </div>
          </div>

          <!-- Editor Body -->
          <div v-if="activeId === element.id" class="p-4 border-t border-gray-100 space-y-3">
            <div>
              <label class="text-xs font-bold text-gray-500 mb-1 block">名称</label>
              <input
                v-model="element.name"
                @change="updateList"
                class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:border-blue-500 outline-none text-sm"
                placeholder="脚本名称"
              />
            </div>
            <div>
              <label class="text-xs font-bold text-gray-500 mb-1 block">代码内容</label>
              <textarea
                v-model="element.content"
                @change="updateList"
                rows="6"
                :placeholder="placeholder"
                class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:border-blue-500 outline-none text-sm font-mono bg-gray-50"
              ></textarea>
            </div>
          </div>
        </div>
      </Draggable>

      <button
        @click="addItem"
        class="w-full py-2 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 hover:border-blue-500 hover:text-blue-500 hover:bg-blue-50 transition-all flex items-center justify-center gap-2 font-bold text-sm"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 4v16m8-8H4"
          />
        </svg>
        添加新脚本
      </button>
    </div>
  </div>
</template>
