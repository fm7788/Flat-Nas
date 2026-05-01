<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from "vue";
import type { WidgetConfig } from "../types";
import { useMainStore } from "@/stores/main";

const props = defineProps<{
  widget: WidgetConfig;
}>();

const store = useMainStore();
const isEditing = ref(false);
const canEdit = computed(() => store.isLogged);
const activeTab = ref<"html" | "css" | "js">("html");

const titleContent = ref(props.widget.data?.title || "自定义组件");
const htmlContent = ref(
  props.widget.data?.html || '<div class="my-component">Hello Custom Widget</div>',
);
const cssContent = ref(
  props.widget.data?.css || ".my-component { color: blue; font-weight: bold; }",
);
const jsContent = ref<string>(props.widget.data?.js || "");

// ─── CSS Scoping ──────────────────────────────────────────────────────────────
// Uses a simple block parser instead of a single fragile regex so that
// @keyframes / @font-face / @media / :root / * are all handled correctly.

const NESTED_AT = /^@(media|supports|layer|container)\b/i;

function scopeCss(css: string, scope: string): string {
  const out: string[] = [];
  let i = 0;
  const n = css.length;

  while (i < n) {
    // skip whitespace / empty lines
    while (i < n && css.charCodeAt(i) <= 32) i++;
    if (i >= n) break;

    // collect selector / at-rule up to the opening brace
    let selector = "";
    while (i < n && css[i] !== "{") selector += css[i++];
    if (i >= n) { out.push(selector); break; }
    i++; // consume '{'

    // collect block content (balanced braces)
    let block = "";
    let depth = 1;
    while (i < n && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      if (depth > 0) block += css[i];
      i++;
    }

    const sel = selector.trim();
    if (!sel) continue;

    if (sel.startsWith("@")) {
      if (NESTED_AT.test(sel)) {
        // Recurse into conditional at-rules
        out.push(`${sel} {\n${scopeCss(block, scope)}\n}`);
      } else {
        // @keyframes, @font-face, @charset, @import, etc. – keep verbatim
        out.push(`${sel} {\n${block}\n}`);
      }
    } else {
      // Scope each comma-separated selector
      const scoped = sel
        .split(",")
        .map((s) => {
          s = s.trim();
          if (!s) return "";
          if (s === ":root") return scope;
          if (/^:root[\s>+~([]/.test(s)) return scope + s.slice(5);
          return `${scope} ${s}`;
        })
        .filter(Boolean)
        .join(",\n");
      out.push(`${scoped} {\n${block}\n}`);
    }
  }
  return out.join("\n\n");
}

const styleId = computed(() => `style-${props.widget.id}`);
const widgetScope = computed(() => `#widget-${props.widget.id}`);

const applyStyles = () => {
  let el = document.getElementById(styleId.value) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = styleId.value;
    document.head.appendChild(el);
  }
  el.textContent = scopeCss(cssContent.value, widgetScope.value);
};

// Live CSS preview while editing (debounced)
let cssDebounce: number | null = null;
watch(cssContent, () => {
  if (!isEditing.value) return;
  if (cssDebounce) clearTimeout(cssDebounce);
  cssDebounce = window.setTimeout(applyStyles, 300);
});

// ─── Widget-level JS ──────────────────────────────────────────────────────────
// Widget JS runs in the widget's own container scope.
// Non-module scripts receive `ctx` as a parameter:
//   ctx.el        — widget container DOM element
//   ctx.query     — querySelector scoped to widget
//   ctx.queryAll  — querySelectorAll scoped to widget
//   ctx.onCleanup — register a cleanup callback
//   ctx.on / ctx.emit — flatnas:* event bus

const jsScriptClass = computed(() => `widget-js-${props.widget.id}`);
const jsCleanupFns: Array<() => void> = [];

const removeWidgetScripts = () => {
  document.querySelectorAll(`.${jsScriptClass.value}`).forEach((s) => s.remove());
};

const destroyWidgetJs = () => {
  while (jsCleanupFns.length) {
    try { jsCleanupFns.pop()?.(); } catch { /* ignore */ }
  }
  removeWidgetScripts();
};

const applyWidgetJs = () => {
  destroyWidgetJs();
  const src = jsContent.value?.trim();
  if (!src) return;

  const widgetEl = document.getElementById(`widget-${props.widget.id}`);
  if (!widgetEl) return;

  // Build a widget-scoped ctx object and expose it globally before script runs
  const widgetCtx = {
    el: widgetEl,
    query: (sel: string) => widgetEl.querySelector(sel),
    queryAll: (sel: string) => Array.from(widgetEl.querySelectorAll(sel)),
    onCleanup: (fn: () => void) => { if (typeof fn === "function") jsCleanupFns.push(fn); },
    emit: (type: string, detail?: unknown) => {
      window.dispatchEvent(new CustomEvent(`flatnas:${type}`, { detail }));
    },
    on: (type: string, handler: (ev: CustomEvent) => void) => {
      const t = `flatnas:${type}`;
      const wrapped = (e: Event) => handler(e as CustomEvent);
      window.addEventListener(t, wrapped as EventListener);
      jsCleanupFns.push(() => window.removeEventListener(t, wrapped as EventListener));
    },
  };

  (window as unknown as Record<string, unknown>).FlatNasWidgetCtx = widgetCtx;

  const looksModule =
    /^\s*\/\/\s*@module\b/m.test(src) ||
    /(^|\n)\s*import\s.+from\s+["'][^"']+["']/m.test(src) ||
    /(^|\n)\s*export\s+/m.test(src);

  const script = document.createElement("script");
  script.className = jsScriptClass.value;

  if (looksModule) {
    script.type = "module";
    script.textContent = src;
  } else {
    const id = props.widget.id;
    script.textContent =
      `;(async (ctx) => {\ntry {\n${src}\n} catch (e) {\nconsole.error('[FlatNas Widget JS ${id}]', e);\n}\n})(window.FlatNasWidgetCtx);`;
  }

  script.onerror = (e) => console.error(`[FlatNas Widget JS ${props.widget.id}] load error:`, e);
  document.body.appendChild(script);
};

// ─── Save / Export / Import ───────────────────────────────────────────────────

const save = () => {
  if (!canEdit.value) return;
  const widget = store.widgets.find((w) => w.id === props.widget.id);
  if (widget) {
    widget.data = {
      title: titleContent.value,
      html: htmlContent.value,
      css: cssContent.value,
      js: jsContent.value,
    };
    store.markDirty();
  }
  isEditing.value = false;
  applyStyles();
  applyWidgetJs();
};

const exportJson = () => {
  const data: Record<string, string> = {
    title: titleContent.value,
    html: htmlContent.value,
    css: cssContent.value,
  };
  if (jsContent.value.trim()) data.js = jsContent.value;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(titleContent.value || "custom-widget").replace(/[^\w\u4e00-\u9fa5-]/g, "_")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const copyPrompt = () => {
  const text = `请帮我写一个简洁的 HTML/CSS 卡片组件。
功能：[在此输入你的需求，如：显示当前日期和一句名言]
要求：
1. 容器宽高自适应，内容居中。
2. 风格现代简约，圆角设计。
3. 请分别提供 HTML 和 CSS 代码（可选 JS）。`;
  navigator.clipboard.writeText(text).then(() => {
    alert("提示词已复制到剪贴板，快去发送给 AI 吧！");
  });
};

const toggleEdit = () => {
  if (!canEdit.value) return;
  isEditing.value = !isEditing.value;
  if (isEditing.value) {
    titleContent.value = props.widget.data?.title || "自定义组件";
    htmlContent.value = props.widget.data?.html || "";
    cssContent.value = props.widget.data?.css || "";
    jsContent.value = props.widget.data?.js || "";
    activeTab.value = "html";
  }
};

const handleFileUpload = (event: Event) => {
  if (!canEdit.value) return;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target?.result as string;
      try {
        const json = JSON.parse(content);
        if (json.html !== undefined) htmlContent.value = json.html;
        if (json.css !== undefined) cssContent.value = json.css;
        if (json.js !== undefined) jsContent.value = json.js;
        if (json.title !== undefined) titleContent.value = json.title;
      } catch {
        htmlContent.value = content;
      }
    } catch (err) {
      console.error("Failed to read file", err);
    }
  };
  reader.readAsText(file);
};

onMounted(() => {
  applyStyles();
  applyWidgetJs();
});

onUnmounted(() => {
  destroyWidgetJs();
  const styleEl = document.getElementById(styleId.value);
  if (styleEl) styleEl.remove();
});

watch(
  () => store.isLogged,
  (val) => { if (!val) isEditing.value = false; },
  { immediate: true },
);
</script>

<template>
  <div
    :id="`widget-${widget.id}`"
    class="w-full h-full relative group overflow-hidden bg-transparent rounded-xl"
  >
    <!-- View Mode -->
    <div
      v-if="!isEditing"
      class="w-full h-full overflow-auto custom-content"
      v-html="htmlContent"
    ></div>

    <!-- Edit Overlay Button -->
    <button
      v-if="canEdit"
      @click="toggleEdit"
      class="absolute top-2 right-2 z-50 p-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity text-gray-600"
      title="编辑组件"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
      </svg>
    </button>

    <!-- Edit Mode -->
    <div
      v-if="isEditing && canEdit"
      class="absolute inset-0 z-40 bg-white flex flex-col overflow-hidden"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50 flex-shrink-0">
        <h3 class="font-bold text-gray-700 text-sm">编辑自定义组件</h3>
        <div class="flex gap-1.5 items-center">
          <!-- Import -->
          <label class="cursor-pointer px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-xs flex items-center gap-1 text-gray-700">
            <span>📂</span><span>导入</span>
            <input type="file" accept=".json,.txt,.html,.css" class="hidden" @change="handleFileUpload" />
          </label>
          <!-- Export -->
          <button
            @click="exportJson"
            class="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-xs text-gray-700 flex items-center gap-1"
            title="导出为 JSON 文件"
          >
            <span>💾</span><span>导出</span>
          </button>
          <!-- Save -->
          <button
            @click="save"
            class="px-3 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600"
          >
            保存
          </button>
          <!-- Cancel -->
          <button
            @click="toggleEdit"
            class="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs hover:bg-gray-300"
          >
            取消
          </button>
        </div>
      </div>

      <!-- Title Field -->
      <div class="px-3 pt-2 pb-1 flex-shrink-0">
        <label class="text-xs font-semibold text-gray-500 block mb-1">标题</label>
        <input
          v-model="titleContent"
          class="w-full p-1.5 border rounded text-xs focus:border-blue-500 outline-none text-gray-900"
          placeholder="自定义组件"
        />
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-200 px-3 flex-shrink-0">
        <button
          v-for="tab in (['html', 'css', 'js'] as const)"
          :key="tab"
          @click="activeTab = tab"
          :class="[
            'px-3 py-1.5 text-xs font-medium border-b-2 transition-colors',
            activeTab === tab
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          ]"
        >
          {{ tab.toUpperCase() }}
          <span v-if="tab === 'js' && jsContent.trim()" class="ml-1 w-1.5 h-1.5 rounded-full bg-green-400 inline-block"></span>
        </button>
      </div>

      <!-- Tab Content -->
      <div class="flex-1 flex flex-col min-h-0 p-3 gap-1">
        <!-- HTML Tab -->
        <template v-if="activeTab === 'html'">
          <label class="text-xs text-gray-400">HTML 结构</label>
          <textarea
            v-model="htmlContent"
            class="flex-1 p-2 border rounded font-mono text-xs resize-none focus:border-blue-500 outline-none text-gray-900 min-h-0"
            placeholder='<div class="my-widget">Hello World</div>'
            spellcheck="false"
          ></textarea>
        </template>

        <!-- CSS Tab -->
        <template v-if="activeTab === 'css'">
          <label class="text-xs text-gray-400">CSS 样式（自动作用域隔离，实时预览）</label>
          <textarea
            v-model="cssContent"
            class="flex-1 p-2 border rounded font-mono text-xs resize-none focus:border-blue-500 outline-none text-gray-900 min-h-0"
            placeholder=".my-widget { color: red; }"
            spellcheck="false"
          ></textarea>
          <p class="text-[10px] text-gray-400">
            提示：选择器自动加 <code>#widget-{{ widget.id }}</code> 前缀隔离。支持 <code>@media</code>、<code>@keyframes</code>。使用 <code>:root</code> 映射为当前 widget 容器。CSS 变化后 300ms 自动预览。
          </p>
        </template>

        <!-- JS Tab -->
        <template v-if="activeTab === 'js'">
          <label class="text-xs text-gray-400">JavaScript（保存后生效）</label>
          <textarea
            v-model="jsContent"
            class="flex-1 p-2 border rounded font-mono text-xs resize-none focus:border-blue-500 outline-none text-gray-900 min-h-0"
            placeholder="// ctx.el     — widget 容器 DOM
// ctx.query  — querySelector(限本 widget)
// ctx.on / ctx.emit — 事件总线

const el = ctx.query('.my-widget');
if (el) el.textContent = '运行中 ' + new Date().toLocaleTimeString();

ctx.onCleanup(() => {
  // 卸载时清理（定时器、监听器等）
});"
            spellcheck="false"
          ></textarea>
          <p class="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1 mt-0.5">
            ⚠️ JS 保存后才会重新执行。非模块脚本可直接使用 <code>ctx</code> 变量访问 widget 上下文。
          </p>
        </template>
      </div>

      <!-- AI Helper -->
      <div class="mx-3 mb-3 p-2 bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg border border-purple-100 flex-shrink-0">
        <div class="flex items-center gap-1 mb-1">
          <span class="text-sm">🤖</span>
          <span class="text-xs font-bold text-purple-700">AI 辅助生成</span>
        </div>
        <div
          class="bg-white p-1.5 rounded border border-purple-100 text-[10px] text-gray-500 font-mono cursor-pointer hover:border-purple-300 transition-colors relative group/ai"
          @click="copyPrompt"
          title="点击复制提示词"
        >
          <div class="hidden group-hover/ai:block absolute right-1 top-1 bg-purple-100 text-purple-600 px-1 py-0.5 rounded text-[10px]">
            点击复制
          </div>
          <span class="text-purple-600 select-none">Prompt: </span>请帮我写一个简洁的 HTML/CSS 卡片组件...
        </div>
      </div>
    </div>
  </div>
</template>
