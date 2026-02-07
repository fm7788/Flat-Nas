# FlatNas

[![GitHub](https://img.shields.io/badge/GitHub-FlatNas-181717?style=flat&logo=github&logoColor=white)](https://github.com/Garry-QD/FlatNas)
[![Gitee](https://img.shields.io/badge/Gitee-FlatNas-C71D23?style=flat&logo=gitee&logoColor=white)](https://gitee.com/gjx0808/FlatNas)
[![Docker Image](https://img.shields.io/badge/Docker-qdnas%2Fflatnas-2496ED?style=flat&logo=docker&logoColor=white)](https://hub.docker.com/r/qdnas/flatnas)

FlatNas 是一个轻量级、高度可定制的个人导航页与仪表盘系统。它基于 Vue 3 和 Express 构建，旨在为 NAS 用户、极客和开发者提供一个优雅的浏览器起始页。
交流QQ群:613835409

## ✨ 主要功能

![alt text](1.png) ![alt text](2.png) ![alt text](3.png) ![alt text](4.png)

### 🖥️ 仪表盘与布局

- **网格布局**: 自由拖拽布局，支持不同尺寸的组件。
- **分组管理**: 支持创建多个分组，分类管理应用和书签。
- **响应式设计**: 完美适配桌面端和移动端访问。
- **编辑模式**: 直观的所见即所得编辑体验，轻松添加、删除和重新排列组件。

### 🧩 丰富的小组件

FlatNas 内置了多种实用的小组件，满足日常需求：

- **文件传输助手**: 强大的跨设备传输工具。支持发送文本、文件与图片；支持断点续传、大文件上传；提供专属**图片**视图，自动归类并预览所有图片文件。
- **书签组件**: 快速访问常用网站，支持自定义图标。首次启动时会自动填充常用的 10 个网站（如 GitHub, Bilibili 等）。
- **时钟与天气**: 实时显示当前时间、日期及当地天气情况。
- **待办事项 (Todo)**: 简单的任务管理，随时记录灵感和待办。
- **RSS 订阅**: 内置 RSS 阅读器，实时获取订阅源的最新内容。
- **热搜榜单**: 集成微博热搜、新闻热榜等，不错过即时热点。
- **计算器**: 随时可用的简易计算器。
- **音乐播放器**: 内置 MiniPlayer，支持播放服务器端的本地音乐文件。

### 🎨 个性化定制

- **图标管理**: 内置图标库，支持上传自定义图片，并全面支持 **Hex 颜色代码** (如 `#ffffff`) 自定义图标背景色。
- **背景设置**: 支持自定义壁纸。
- **分组卡片背景**: 支持在分组设置中统一配置该组所有卡片的背景（图片、模糊、遮罩），实现风格统一的视觉效果。
- **访客统计**: 底部页脚显示网站总访问量、今日访问量及当前在线时长（需在设置中开启）。
- **数据安全**:
  - 本地存储配置 (`server/data/data.json`)，数据完全掌握在自己手中。
  - 简单的密码访问保护（默认密码：`admin`），保护隐私配置。
- **CGI 扩展**: 支持通过 Node.js 编写 CGI 脚本扩展后端功能（位于 `server/cgi-bin`）。
- **更新提醒**: 内置版本检测功能，自动检查 GitHub 最新 Release 版本，并在设置面板提示 Docker 更新。

## 🌐 代理配置

FlatNas 支持通过后端代理转发请求，以解决内网服务无法直接访问外网资源的问题，或实现简单的隐私保护。

### 启用方法

1. **设置环境变量**
   在 `docker-compose.yml` 或启动命令中添加 `PROXY_URL` 环境变量。

   ```yaml
   environment:
     - PROXY_URL=http://127.0.0.1:7890
     # 支持协议：http, https, socks5, socks5h
     # 格式：protocol://[user:pass@]host:port
   ```

2. **前端开启**
   当环境变量配置正确后，在卡片编辑或万能窗口配置中，会显示“代理”开关。开启后，该组件的所有请求将通过 FlatNas 后端服务器代为转发。

### 调试与排查

- **开关不显示**：请检查后端日志，确认 `PROXY_URL` 格式正确且已生效。访问 `/api/config/proxy-status` 可查看当前代理可用状态。
- **请求失败**：
  - 检查 `PROXY_URL` 指向的代理服务器是否可达。
  - 检查目标 URL 是否触发了 SSRF 防护规则（如禁止访问 localhost）。
  - 查看后端日志 `[Proxy Error]` 获取详细错误信息。

## 🌐 智能网络环境检测

FlatNas 后端集成了智能网络环境识别功能，能够根据用户的访问来源自动切换内外网访问策略，完美解决混合网络环境下的访问难题。

- **多维度识别**: 结合 **客户端 IP**、**访问域名** 和 **网络延迟** 三个维度，精准判断用户当前所处的网络环境（局域网/互联网）。
- **自动路由**: 当检测到用户处于局域网（LAN）时，系统会自动优先使用配置的 **内网地址 (LanUrl)**，实现高速直连；在公网环境则自动切换至 **外网地址**。
- **无感切换**: 用户无需手动干预，无论是在家（内网）还是外出（外网），点击同一个图标即可自动跳转至最佳地址。

## 🚀 快速开始

### 本地开发

1. **克隆项目**

   ```bash
   git clone <your-repo-url>
   cd FlatNas
   ```

2. **安装依赖**

   ```bash
   npm install
   ```

3. **启动项目**
   该命令会同时启动前端开发服务器和后端 API 服务：

   ```bash
   npm start
   ```

   > **⚠️ Windows 用户注意**: 如果在 PowerShell 中运行 `npm start` 遇到执行策略错误（如 `UnauthorizedAccess`），请尝试以下解决方案：
   >
   > - 使用 `Command Prompt (cmd)` 运行命令。
   > - 或者手动分别运行服务：
   >
   >   ```bash
   >   # 终端 1 (后端)
   >   node server/server.js
   >
   >   # 终端 2 (前端)
   >   node node_modules/vite/bin/vite.js
   >   ```
   - 前端地址: `http://localhost:5173`
   - 后端地址: `http://localhost:3000`

### 部署构建

1. **构建前端**

   ```bash
   npm run build
   ```

   构建产物将生成在 `dist` 目录下。

2. **运行生产服务**
   ```bash
   npm run server
   ```
   此时可以通过 `http://localhost:3000` 访问完整应用（后端会托管 `dist` 目录下的静态文件）。

## 🐳 Docker 部署

项目包含 `Dockerfile`，支持容器化部署。

1. **构建镜像**

   ```bash
   docker build -t flatnas .
   ```

2. **运行容器**

   ```bash
   docker run -d \
     -p 3000:3000 \
     -v $(pwd)/server/data:/app/server/data \
     -v $(pwd)/server/doc:/app/server/doc \
     -v $(pwd)/server/music:/app/server/music \
     -v $(pwd)/server/PC:/app/server/PC \
     -v $(pwd)/server/APP:/app/server/APP \
     -v /var/run/docker.sock:/var/run/docker.sock \
     --name flatnas \
     qdnas/flatnas
   ```

   > **注意**: 建议挂载 `data`、`doc`、`music`、`PC` 和 `APP` 目录，以确保配置数据、文件传输记录、媒体文件和自定义壁纸在容器重启后不会丢失。若需要使用 Docker 管理功能，必须挂载 `/var/run/docker.sock`。

3. **docker-compose**

   ```bash
   version: '3.8'

   services:
     flatnas:
       image: qdnas/flatnas:latest
       container_name: flatnas
       restart: unless-stopped
       ports:
         - '23000:3000'
       volumes:
         - ./data:/app/server/data #指定路径下新建data
         - ./doc:/app/server/doc #文件传输数据
         - ./music:/app/server/music #映射播放器路径
         - ./PC:/app/server/PC #映射PC端壁纸路径
         - ./APP:/app/server/APP #映射移动端壁纸路径
         - /var/run/docker.sock:/var/run/docker.sock #映射Docker Socket
   ```

## 🚀 一键部署 (Debian)

如果您使用 Debian 系统，可以使用我们提供的自动化脚本进行无 Docker 部署。
详细指南请参考：[一键部署文档](README_DEPLOY.md)

### 快速安装（推荐）

无需手动下载代码，直接运行以下命令即可：

```bash
wget -O deploy.sh https://raw.githubusercontent.com/Garry-QD/FlatNas/main/deploy.sh && sudo bash deploy.sh install
```

### 手动安装

```bash
git clone https://github.com/Garry-QD/FlatNas.git
cd FlatNas
chmod +x deploy.sh
sudo ./deploy.sh install
```

## ⚙️ 配置说明

- **默认密码**: 系统初始密码为 `admin`，请登录后在设置中及时修改。
- **数据文件**: 所有配置（布局、组件、书签等）均存储在 `server/data/data.json` 中。
- **音乐文件**: 将 MP3 文件放入 `server/music` 目录，刷新页面后即可在播放器中看到。
- CGI 脚本: 将自定义脚本放入 `server/cgi-bin` 目录，可通过 `/cgi-bin/script.cgi` 访问。
- **Docker 自动升级镜像**:
  - 入口：设置 → Docker 管理 → 自动升级镜像(每2小时)。
  - 关闭时：后台不会进行任何镜像拉取或版本对比。
  - 开启时：每 2 小时对运行中的容器执行“拉取并对比镜像 ID”，发现新版本则自动重建容器。
  - 镜像清理：升级完成后自动清理旧镜像，默认每个镜像名保留 2 个版本（可配置 1–20）。
  - 磁盘保护：当 Docker 所在磁盘可用空间低于阈值时跳过本轮升级，默认阈值 5GB（可配置）。
  - 监控指标：镜像数量、磁盘使用率、自动升级日志中的 pulls/updates/pruned/error 计数。
  - 升级后验证：开启开关等待一个周期（或手动触发一次更新检测），确认日志中 pulls/updates 变化且镜像数量不持续增长。
  - 灰度验证（建议）：准备 2 个环境分别开启/关闭该开关，各运行 24 小时，对比以下数据以确认“开关状态=后台行为”且无镜像堆积：
    - 服务器日志：筛选 `[AutoUpdate]` 与 `[UpdateChecker]` 关键字，统计 pulls/updates/pruned/error 次数与频率。
    - Docker 镜像数量：对比 24 小时前后 `docker images -q | wc -l`（Linux）或 `docker images -q | Measure-Object -Line`（PowerShell）。
    - Docker 根目录磁盘：对比 24 小时前后磁盘可用空间（或使用 `docker info` + 系统磁盘监控）。

## 🛠️ 高级定制 (Advanced Customization)

FlatNas 提供了强大的自定义能力，允许开发者或高级用户通过代码深度定制界面与交互。以下文档旨在帮助您（或您的 AI 助手）理解如何编写自定义内容。

### 🧩 自定义组件 (Custom Widget)

在编辑模式下，您可以添加 "自定义 CSS" 组件（实为 HTML/CSS 组件）。这是一个完全空白的画布，支持编写 HTML 结构和 CSS 样式。

**特性：**

- **HTML**: 支持标准的 HTML 标签。
- **CSS**: 支持标准的 CSS 语法。系统会自动将样式限定在当前组件内（自动添加 `#widget-{id}` 前缀），防止污染全局样式。
- **导入/导出**: 支持导入 `.json` 或 `.txt` 格式的配置代码。

**AI 提示词参考 (Prompt):**
如果您希望 AI 帮您生成组件，可以提供以下上下文：

> 请生成一个 FlatNas 自定义组件配置。
> 格式：JSON
> 包含字段：`html` (字符串), `css` (字符串)
> 要求：
>
> 1. HTML 结构简洁，使用 Tailwind CSS 类名（系统内置 Tailwind）或自定义类名。
> 2. CSS 样式应包含必要的布局和美化，注意无需写外层容器的大小，组件会自动填充。

**示例数据结构 (JSON):**

```json
{
  "html": "<div class=\"my-card\">\n  <h3>Hello World</h3>\n  <p>This is a custom widget.</p>\n</div>",
  "css": ".my-card { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); border-radius: 12px; } .my-card h3 { color: #333; margin-bottom: 8px; }"
}
```

### 🎨 全局自定义 CSS

在 **设置** -> **自定义 CSS** 中，您可以编写全局生效的 CSS 样式。

**增强语法：**
FlatNas 支持以下自定义标签，自动转换为媒体查询，方便响应式适配：

- `<mobile>...</mobile>`: 仅在移动端生效 (`max-width: 768px`)
- `<desktop>...</desktop>`: 仅在桌面端生效 (`min-width: 769px`)
- `<dark>...</dark>`: 仅在深色模式下生效
- `<light>...</light>`: 仅在浅色模式下生效

**示例:**

```css
/* 全局修改滚动条样式 */
::-webkit-scrollbar {
  width: 6px;
}

/* 仅在移动端隐藏侧边栏 */
<mobile>
.sidebar { display: none; }
</mobile>
```

### ⚡ 全局自定义 JS

在 **设置** -> **自定义 JS** 中，您可以注入 JavaScript 代码以实现高级交互或逻辑增强。
_注意：启用此功能需要同意安全免责声明。_

**运行环境 (Runtime Context):**

代码将在沙箱环境中运行，并提供 `ctx` 对象用于与系统交互。支持直接编写代码或导出生命周期钩子。

**生命周期钩子 (推荐):**

```javascript
// @module
// 必须使用 export default 导出钩子对象
export default {
  /**
   * 初始化时调用
   * @param {object} ctx - 上下文对象
   */
  init(ctx) {
    console.log("Custom JS Initialized");
    // 示例：监听事件
    ctx.on("widget-click", (e) => {
      console.log("Widget clicked:", e.detail);
    });
  },

  /**
   * 更新时调用 (如配置变更)
   */
  update(ctx) {
    console.log("Custom JS Updated");
  },

  /**
   * 销毁时调用 (清理资源)
   */
  destroy(ctx) {
    console.log("Custom JS Destroyed");
    // 清理定时器、事件监听等
  },
};
```

**Context API (`ctx`):**

- `ctx.root`: 应用根元素 (HTMLElement)。
- `ctx.store`: Pinia Store 实例，可访问 `ctx.store.widgets` 等数据。
- `ctx.query(selector)`: 相当于 `root.querySelector`。
- `ctx.queryAll(selector)`: 相当于 `root.querySelectorAll`。
- `ctx.on(event, handler)`: 监听系统事件，返回取消监听函数。
- `ctx.emit(event, data)`: 发送自定义事件。
- `ctx.onCleanup(fn)`: 注册清理函数，脚本更新或卸载时自动执行。

## � 多项目并行开发与集成 (Parallel Development)

如果您正在开发多个复杂的子项目（如独立的 React/Vue 组件或工具应用），并希望将其集成到 FlatNas 中，以下是推荐的最佳实践。

### 1. 运行时集成 (Runtime Integration)

#### 方案 A: Iframe 集成（最简单、隔离性最好）

这是将独立 Web 应用集成到 FlatNas 的最推荐方式。

1. 将您的子项目独立构建并部署（或作为静态文件放入 FlatNas）。
2. 在 FlatNas 中添加 **"Iframe 网页"** 组件。
3. 填入子项目的 URL。
   - 优势：完全的样式和 JS 隔离，互不干扰，天然支持并行运行。
   - 劣势：与主应用通信较为麻烦（需通过 `postMessage`）。

#### 方案 B: 静态资源托管 + 自定义 JS（深度集成）

如果您希望子应用能与 FlatNas 深度交互（如读取 Store 数据），可以将子应用构建为库 (Library)。

1. **放置资源**: FlatNas 内置了一个公共静态目录 `server/public`。
   - 在 `server` 目录下新建 `public` 文件夹（如果没有）。
   - 将您的子项目构建产物（如 `my-widget.js`, `style.css`）放入其中。
   - 访问路径为: `/public/my-widget.js`。

2. **加载资源**: 在 **设置 -> 自定义 JS** 中编写加载脚本：

   ```javascript
   // 动态加载 CSS
   const link = document.createElement("link");
   link.rel = "stylesheet";
   link.href = "/public/style.css";
   document.head.appendChild(link);

   // 动态加载 JS (ES Module 方式)
   import("/public/my-widget.js").then((module) => {
     // 初始化您的组件，传入 ctx
     module.default.init(FlatNasCustomCtx);
   });
   ```

### 2. 开发环境并行 (Development)

如果您在一个大仓库 (Monorepo) 中管理多个子项目，推荐使用 `npm-run-all` 来并行启动开发服务。

**示例 `package.json` 配置:**

```json
{
  "scripts": {
    "dev:main": "vite",
    "dev:widget-a": "cd packages/widget-a && npm run dev",
    "dev:widget-b": "cd packages/widget-b && npm run dev",
    "dev:all": "run-p dev:main dev:widget-a dev:widget-b"
  }
}
```

- `run-p` (来自 `npm-run-all` 包) 会并行运行指定的脚本。
- 这样您可以同时启动 FlatNas 主程序和多个子组件的开发服务器。

## �📝 待办事项 / 计划

- [ ] 增加更多第三方服务集成
- [ ] 优化移动端交互体验
- [ ] 支持多用户系统
- [ ] 在线更换壁纸库

## 📜 开源协议

本项目采用 [GNU AGPLv3](LICENSE) 协议开源。

---

Enjoy your FlatNas! 🚀
