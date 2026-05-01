<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';

defineProps<{
  editable?: boolean;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'focus'): void;
  (e: 'blur'): void;
  (e: 'input'): void;
}>();

const content = defineModel<string>('content');
const editorRef = ref<HTMLDivElement | null>(null);
const isFocused = ref(false);

// Update innerHTML when content changes externally, but ONLY if not focused to avoid cursor jumping
watch(content, (newVal) => {
  if (!isFocused.value && editorRef.value && newVal !== editorRef.value.innerHTML) {
    editorRef.value.innerHTML = newVal || '';
  }
});

const handleInput = () => {
  if (editorRef.value) {
    content.value = editorRef.value.innerHTML;
  }
  emit('input');
};

const handleFocus = () => {
  isFocused.value = true;
  emit('focus');
};

const handleBlur = () => {
  isFocused.value = false;
  handleInput(); // Ensure sync on blur
  emit('blur');
};

const execCommand = (cmd: string, val?: string) => {
  document.execCommand(cmd, false, val);
  handleInput();
  if (editorRef.value) {
    editorRef.value.focus();
  }
};

onMounted(() => {
  if (editorRef.value) {
    editorRef.value.innerHTML = content.value || '';
  }
});

defineExpose({
  execCommand,
  editorRef
});
</script>

<template>
  <div
    ref="editorRef"
    :contenteditable="editable"
    class="w-full h-full bg-transparent outline-none text-sm text-gray-800 break-words font-sans leading-relaxed overflow-y-auto p-2 empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400"
    :data-placeholder="placeholder"
    @input="handleInput"
    @focus="handleFocus"
    @blur="handleBlur"
  ></div>
</template>

<style scoped>
:deep(h1) {
  font-size: 1.5em;
  font-weight: 700;
  margin: 0.5em 0;
  line-height: 1.3;
}
:deep(h2) {
  font-size: 1.25em;
  font-weight: 700;
  margin: 0.5em 0;
  border-bottom: 1px dashed rgba(0, 0, 0, 0.2);
}
:deep(ul) {
  list-style-type: disc;
  padding-left: 1.5em;
  margin: 0.5em 0;
}
:deep(pre) {
  background-color: #1e293b;
  color: #e2e8f0;
  padding: 0.5em;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    "Courier New", monospace;
  font-size: 0.9em;
  margin: 0.5em 0;
  white-space: pre-wrap;
}
:deep(blockquote) {
  border-left: 4px solid #cbd5e1;
  padding-left: 1em;
  margin: 0.5em 0;
  color: #64748b;
  font-style: italic;
}
</style>
