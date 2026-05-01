<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";
import { useMainStore } from "../stores/main";
import OverlayMotion from "@/components/base/OverlayMotion.vue";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits(["update:show"]);

const store = useMainStore();
const authMode = computed(() => store?.systemConfig?.authMode ?? "single");

const username = ref("");
const password = ref("");
const isRegister = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

// 监听打开：一旦打开，自动聚焦输入框，并清空旧密码
watch(
  () => props.show,
  (newVal) => {
    if (newVal) {
      username.value = "";
      password.value = "";
      isRegister.value = false;
      nextTick(() => {
        // Focus username input if visible, else password
        if (authMode.value === "multi") {
          const input = document.querySelector('input[placeholder="用户名"]') as HTMLInputElement;
          if (input) input.focus();
          else inputRef.value?.focus();
        } else {
          inputRef.value?.focus();
        }
      });
    }
  },
);

const close = () => emit("update:show", false);

const handleSubmit = async () => {
  // If single user mode, username can be empty (defaults to admin on server)
  if (authMode.value === "multi" && !username.value.trim()) {
    alert("请输入用户名");
    return;
  }
  if (!password.value) {
    alert("请输入密码");
    return;
  }

  try {
    if (isRegister.value) {
      await store.register(username.value, password.value);
      alert("注册成功，请登录");
      isRegister.value = false;
      password.value = "";
    } else {
      const success = await store.login(username.value, password.value);
      if (success) {
        close();
      }
    }
  } catch (e: unknown) {
    const err = e as Error;
    alert(err.message || "操作失败！");
    password.value = "";
    // inputRef.value?.focus() // Focus password again
  }
};
</script>

<template>
  <OverlayMotion
    :show="show"
    :z-index="50"
    overlay-class="bg-black/40 backdrop-blur-sm p-4"
    panel-class="max-w-sm"
  >
    <div class="bg-white rounded-2xl shadow-2xl w-full overflow-hidden">
      <div
        class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50"
      >
        <h3 class="text-lg font-bold text-gray-800 flex items-center gap-2">
          <span v-if="isRegister">👤 新用户注册</span>
          <template v-else>
            <svg class="w-6 h-6 text-gray-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span>
              {{ authMode === "single" ? "管理员登录" : "用户登录" }}
            </span>
          </template>
        </h3>
        <button @click="close" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">
          &times;
        </button>
      </div>

      <div class="p-6">
        <div class="mb-5 space-y-4">
          <div v-if="authMode === 'multi'">
            <input
              v-model="username"
              type="text"
              placeholder="用户名"
              class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all text-center text-lg tracking-widest"
              @keyup.enter="handleSubmit"
            />
          </div>
          <div>
            <input
              ref="inputRef"
              v-model="password"
              type="password"
              placeholder="密码"
              class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all text-center text-lg tracking-widest"
              @keyup.enter="handleSubmit"
            />
          </div>
        </div>

        <button
          @click="handleSubmit"
          class="w-full bg-gray-800 text-white py-3 rounded-xl font-bold hover:bg-black active:scale-95 transition-all shadow-lg"
        >
          {{ isRegister ? "注 册" : "登 录" }}
        </button>

        <div class="mt-4 text-center" v-if="authMode === 'multi'">
          <button
            @click="isRegister = !isRegister"
            class="text-sm text-gray-500 hover:text-gray-800 hover:underline transition-colors"
          >
            {{ isRegister ? "已有账号？去登录" : "没有账号？去注册" }}
          </button>
        </div>
      </div>
    </div>
  </OverlayMotion>
</template>
