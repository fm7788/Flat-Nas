# Enhanced Memo Widget (改造后的便签组件)

## 概述
本组件是对原 `MemoWidget` 的功能完善与规范化改造，满足以下核心需求：
- **业务逻辑自洽**：明确的状态流转（Simple/Rich 模式切换），数据回退机制。
- **UI/UX 升级**：遵循 WCAG 2.1 AA 标准，使用品牌主色 `#0052D9`，统一 16x16px 图标。
- **持久化增强**：IndexedDB 本地存储 + Checksum 校验 + 自动重试 + Sentry 上报。
- **交互反馈**：持久化操作提供“按钮动画 + Toast + 顶部进度条”三重反馈。

## 目录结构
```
src/components/Memo/
├── MemoEditor.vue       # 富文本编辑器组件 (Core)
├── MemoToolbar.vue      # 格式化工具栏 (UI)
├── useMemoPersistence.ts # 持久化逻辑 Hook (Logic)
└── README.md            # 说明文档
```

## 功能演示 (GIF Placeholder)
![Interaction Demo](./demo.gif)
*(在此处插入交互演示 GIF，展示保存时的三重反馈效果及离线重试机制)*

## 接入方式
组件已替换原 `src/components/MemoWidget.vue`，直接在 Dashboard 中使用即可。

```vue
<MemoWidget :widget="widgetConfig" />
```

## 技术细节

### 1. 持久化 (Persistence)
采用 `IndexedDB` (通过 `idb` 库) 存储用户数据，解决 LocalStorage 容量限制问题。
- **Checksum**: 写入前计算哈希，读取后校验，防止数据静默损坏。
- **Retry**: 写入失败自动重试 3 次 (指数退避)。
- **Sentry**: 最终失败时上报异常堆栈。

### 2. 无障碍 (Accessibility)
- 按钮满足 WCAG 2.1 AA 对比度要求。
- 支持键盘导航 (`tabindex`, `focus` 状态)。
- 语义化 HTML (`button`, `textarea`, `h1` 等)。

### 3. 性能 (Performance)
- **按需加载**: 组件拆分，逻辑解耦。
- **Lighthouse**: 针对 Accessibility 和 Best Practices 进行了优化 (目标 >= 90)。

## 测试
运行单元测试：
```bash
npm run test src/components/MemoWidget.spec.ts
```
覆盖率包含：
- 渲染与交互
- 持久化流程
- 异常重试机制
- 离线场景模拟
