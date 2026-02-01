<script setup lang="ts">
import type { WidgetConfig } from "@/types";
import ClockWidget from "./ClockWidget.vue";
import SimpleWeatherWidget from "./SimpleWeatherWidget.vue";
import CalendarWidget from "./CalendarWidget.vue";
import MemoWidget from "./MemoWidget.vue";
import TodoWidget from "./TodoWidget.vue";
import CalculatorWidget from "./CalculatorWidget.vue";
import CountdownWidget from "./CountdownWidget.vue";
import CountUpWidget from "./CountUpWidget.vue";
import IframeWidget from "./IframeWidget.vue";
import BookmarkWidget from "./BookmarkWidget.vue";
import HotWidget from "./HotWidget.vue";
import ClockWeatherWidget from "./ClockWeatherWidget.vue";
import RssWidget from "./RssWidget.vue";
import DockerWidget from "./DockerWidget.vue";
import SystemStatusWidget from "./SystemStatusWidget.vue";
import CustomCssWidget from "./CustomCssWidget.vue";
import FileTransferWidget from "./FileTransferWidget.vue";
import MusicWidget from "./MusicWidget.vue";
import AmapWeatherWidget from "./AmapWeatherWidget.vue";

defineProps<{
  widget: WidgetConfig;
}>();
</script>

<template>
  <ClockWidget v-if="widget.type === 'clock'" :widget="widget" />
  <SimpleWeatherWidget v-else-if="widget.type === 'weather'" :widget="widget" />
  <CalendarWidget v-else-if="widget.type === 'calendar'" :widget="widget" />
  <MemoWidget v-else-if="widget.type === 'memo'" :widget="widget" />
  <TodoWidget v-else-if="widget.type === 'todo'" :widget="widget" />
  <CalculatorWidget v-else-if="widget.type === 'calculator'" :widget="widget" />
  <div
    v-else-if="widget.type === 'ip'"
    class="w-full h-full flex items-center justify-center bg-white rounded-2xl shadow-sm text-gray-500 text-xs"
  >
    IP Widget
  </div>
  <CountdownWidget v-else-if="widget.type === 'countdown'" :widget="widget" />
  <CountUpWidget v-else-if="widget.type === 'countup'" :widget="widget" />
  <IframeWidget
    v-else-if="widget.type === 'iframe'"
    :widget="widget"
    :is-lan-mode="false"
    :is-edit-mode="false"
  />
  <BookmarkWidget v-else-if="widget.type === 'bookmarks'" :widget="widget" />
  <HotWidget v-else-if="widget.type === 'hot'" :widget="widget" />
  <ClockWeatherWidget v-else-if="widget.type === 'clockweather'" :widget="widget" />
  <RssWidget v-else-if="widget.type === 'rss'" :widget="widget" />
  <DockerWidget v-else-if="widget.type === 'docker'" :widget="widget" />
  <SystemStatusWidget v-else-if="widget.type === 'system-status'" :widget="widget" />
  <CustomCssWidget v-else-if="widget.type === 'custom-css'" :widget="widget" />
  <FileTransferWidget v-else-if="widget.type === 'file-transfer'" :widget="widget" />
  <MusicWidget v-else-if="widget.type === 'music'" :widget="widget" />
  <AmapWeatherWidget v-else-if="widget.type === 'amap-weather'" :widget="widget" />
</template>
