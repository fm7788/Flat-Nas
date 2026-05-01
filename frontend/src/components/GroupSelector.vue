<script setup lang="ts">
import { ref, computed } from "vue";
import { useMainStore } from "../stores/main";
import { onClickOutside } from "@vueuse/core";

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits(["update:modelValue"]);

const store = useMainStore();
const isOpen = ref(false);
const containerRef = ref(null);

onClickOutside(containerRef, () => {
  isOpen.value = false;
});

const currentGroup = computed(() =>
  store.groups.find((g) => g.id === props.modelValue)
);

const selectGroup = (groupId: string) => {
  emit("update:modelValue", groupId);
  isOpen.value = false;
};

const toggle = () => {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
};
</script>

<template>
  <div class="relative" ref="containerRef">
    <button
      type="button"
      @click="toggle"
      class="flex items-center gap-1 text-xs font-bold text-gray-600 hover:bg-gray-100 px-2 py-1.5 rounded-lg transition-colors border border-transparent hover:border-gray-200"
      :class="{ 'opacity-50 cursor-not-allowed': disabled, 'bg-gray-50 border-gray-200': isOpen }"
      :disabled="disabled"
      title="切换分组"
    >
      <span class="max-w-[100px] truncate">{{ currentGroup?.title || "选择分组" }}</span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="w-3 h-3 transition-transform duration-200 text-gray-400"
        :class="{ 'rotate-180': isOpen }"
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
    </button>

    <transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="transform scale-95 opacity-0 -translate-y-2"
      enter-to-class="transform scale-100 opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="transform scale-100 opacity-100 translate-y-0"
      leave-to-class="transform scale-95 opacity-0 -translate-y-2"
    >
      <div
        v-if="isOpen"
        class="absolute right-0 top-full mt-2 w-48 bg-white rounded-xl shadow-xl border border-gray-100 z-50 overflow-hidden origin-top-right"
      >
        <div class="max-h-[320px] overflow-y-auto custom-scrollbar py-1.5">
          <button
            v-for="group in store.groups"
            :key="group.id"
            @click="selectGroup(group.id)"
            class="w-full text-left px-4 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center justify-between group"
            :class="
              modelValue === group.id
                ? 'text-blue-600 font-bold bg-blue-50/50'
                : 'text-gray-600'
            "
          >
            <span class="truncate">{{ group.title }}</span>
            <svg
              v-if="modelValue === group.id"
              xmlns="http://www.w3.org/2000/svg"
              class="w-3.5 h-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background-color: rgba(156, 163, 175, 0.5);
}
</style>
