<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from "vue";
import { useMainStore } from "../stores/main";

const props = defineProps<{ show: boolean }>();
// #region agent log
onMounted(() => {
  fetch('http://127.0.0.1:7872/ingest/26a085c1-eea6-41df-83f2-c178aa092a66',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8409c0'},body:JSON.stringify({sessionId:'8409c0',location:'LoginModal.vue:onMounted',message:'LoginModal mounted',data:{show:props.show},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
});
// #endregion
const emit = defineEmits(["update:show"]);
const store = useMainStore();

const username = ref("");
const password = ref("");
const isRegister = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

// 监听打开：一旦打开，自动聚焦输入框，并清空旧密码
watch(
  () => props.show,
  (newVal) => {
    // #region agent log
    if (typeof fetch !== 'undefined') fetch('http://127.0.0.1:7872/ingest/26a085c1-eea6-41df-83f2-c178aa092a66',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8409c0'},body:JSON.stringify({sessionId:'8409c0',location:'LoginModal.vue:watch(show)',message:'props.show changed',data:{newVal},timestamp:Date.now(),hypothesisId:'H5'})}).catch(()=>{});
    // #endregion
    if (newVal) {
      username.value = "";
      password.value = "";
      isRegister.value = false;
      nextTick(() => {
        // Focus username input if visible, else password
        if (store.systemConfig?.authMode === "multi") {
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
  if (store.systemConfig?.authMode === "multi" && !username.value.trim()) {
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
  <div
    v-if="show"
    class="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
  >
    <div
      class="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden transform transition-all scale-100"
    >
      <div
        class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50"
      >
        <h3 class="text-lg font-bold text-gray-800 flex items-center gap-2">
          <span v-if="isRegister">👤 新用户注册</span>
          <template v-else>
            <img src="/ICON.PNG" class="w-6 h-6 object-contain" alt="lock" />
            <span>
              {{
                store.systemConfig?.authMode === "single"
                  ? "管理员登录"
                  : "用户登录"
              }}
            </span>
          </template>
        </h3>
        <button @click="close" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">
          &times;
        </button>
      </div>

      <div class="p-6">
        <div class="mb-5 space-y-4">
          <div v-if="store.systemConfig?.authMode === 'multi'">
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

        <div class="mt-4 text-center" v-if="store.systemConfig?.authMode === 'multi'">
          <button
            @click="isRegister = !isRegister"
            class="text-sm text-gray-500 hover:text-gray-800 hover:underline transition-colors"
          >
            {{ isRegister ? "已有账号？去登录" : "没有账号？去注册" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
