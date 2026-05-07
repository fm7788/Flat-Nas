<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    show: boolean;
    zIndex?: number | string;
    closeOnOverlay?: boolean;
    teleportTo?: string;
    teleportDisabled?: boolean;
    overlayClass?: string;
    panelClass?: string;
    panelStyle?: string | Record<string, string | number>;
    variant?: "dialog" | "sheet" | "popover" | "context-menu";
    appear?: boolean;
    panelTag?: string;
  }>(),
  {
    zIndex: 50,
    closeOnOverlay: false,
    teleportTo: "body",
    teleportDisabled: false,
    overlayClass: "",
    panelClass: "",
    panelStyle: undefined,
    variant: "dialog",
    appear: true,
    panelTag: "div",
  },
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "overlay-click", event: MouseEvent): void;
  (e: "overlay-mousedown", event: MouseEvent): void;
  (e: "overlay-mouseup", event: MouseEvent): void;
}>();

const startedOnPanel = ref(false);

const handleOverlayClick = (event: MouseEvent) => {
  if (event.target !== event.currentTarget) return;
  if (startedOnPanel.value) return;
  emit("overlay-click", event);
  if (props.closeOnOverlay) {
    emit("close");
  }
};

const handleOverlayMouseDown = (event: MouseEvent) => {
  if (event.target !== event.currentTarget) return;
  startedOnPanel.value = false;
  emit("overlay-mousedown", event);
};

const handleOverlayMouseUp = (event: MouseEvent) => {
  if (event.target !== event.currentTarget) return;
  emit("overlay-mouseup", event);
};

const handlePanelMouseDown = () => {
  startedOnPanel.value = true;
};

const handlePanelMouseUp = () => {
  startedOnPanel.value = false;
};

const variantRootClass = computed(() => {
  if (props.variant === "popover" || props.variant === "context-menu") {
    return "pointer-events-none items-start justify-start";
  }
  return "items-center justify-center";
});

const variantPanelClass = computed(() => {
  if (props.variant === "popover" || props.variant === "context-menu") {
    return "pointer-events-auto";
  }
  return "";
});
</script>

<template>
  <Teleport :to="teleportTo" :disabled="teleportDisabled">
    <Transition name="overlay-motion-root" :appear="appear">
      <div
        v-if="show"
        :style="{ zIndex }"
        :data-motion-variant="variant"
        :class="[
          'overlay-motion-root fixed inset-0 flex',
          variantRootClass,
          overlayClass,
        ]"
        @click="handleOverlayClick"
        @mousedown="handleOverlayMouseDown"
        @mouseup="handleOverlayMouseUp"
      >
        <component
          :is="panelTag"
          :class="['overlay-motion-panel', variantPanelClass, panelClass]"
          :style="panelStyle"
          @click.stop
          @mousedown="handlePanelMouseDown"
          @mouseup="handlePanelMouseUp"
        >
          <slot />
        </component>
      </div>
    </Transition>
  </Teleport>
</template>
