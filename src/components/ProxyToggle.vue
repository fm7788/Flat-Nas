<template>
  <div v-if="isProxyAvailable" class="flex items-center gap-2">
    <span class="text-[10px] text-gray-400 font-medium">代理</span>
    <label class="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        :checked="modelValue"
        @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
        class="sr-only peer"
      />
      <div
        class="w-7 h-4 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-500"
      ></div>
    </label>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";

defineProps<{
  modelValue: boolean;
}>();

defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const isProxyAvailable = ref(false);

onMounted(async () => {
  try {
    const res = await fetch("/api/config/proxy-status");
    const data = await res.json();
    isProxyAvailable.value = data.available;
  } catch (e) {
    console.warn("Failed to check proxy status", e);
    isProxyAvailable.value = false;
  }
});
</script>
