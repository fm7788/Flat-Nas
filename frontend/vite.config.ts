import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueDevTools from "vite-plugin-vue-devtools";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isWindows = process.platform === "win32";
  // Docker 构建时只有 server/public 被复制到 /app/server/public，用此路径
  const isDockerBuild = process.env.VITE_DOCKER_BUILD === "1";
  const serverPublicDirAbs = fileURLToPath(new URL("../server/public", import.meta.url));
  const publicDir = isDockerBuild
    ? "../server/public"
    : isWindows
      ? "../server/public"
      : "../debian/server/public";
  const outDir = isDockerBuild
    ? "dist"
    : isWindows
      ? serverPublicDirAbs
      : "dist";
  return ({
    base: "/",
    publicDir,
    build: {
      sourcemap: false,
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        // 避免 UNRESOLVED_IMPORT 被 Vite 转为 throw（依赖中若存在 commonjs external 等会触发）
        onwarn(warning, warn) {
          if (warning.code === "UNRESOLVED_IMPORT") return;
          if (typeof warning.message === "string" && warning.message.includes("external")) return;
          warn(warning);
        },
      },
    },
    plugins: [vue(), mode === "development" && vueDevTools()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    // ✨✨✨ 关键修改：增加了 /music 的代理 ✨✨✨
    server: {
      port: 23000,
      host: "0.0.0.0",
      watch: {
        ignored: ["**/data/**", "**/server/**"],
        usePolling: isWindows,
        interval: isWindows ? 180 : undefined,
      },
      proxy: {
        // 告诉 Vite：遇到 /api 开头的请求，转给 3000 端口
        "/api": {
          target: process.env.VITE_BACKEND || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        // ✨ 新增：告诉 Vite：遇到 /music 开头的请求，也转给 3000 端口！
        "/music": {
          target: process.env.VITE_BACKEND || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        // ✨ Backgrounds 代理
        "/backgrounds": {
          target: process.env.VITE_BACKEND || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        "/mobile_backgrounds": {
          target: process.env.VITE_BACKEND || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        "/icon-cache": {
          target: process.env.VITE_BACKEND || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        // ✨ CGI 代理
        "^.*\\.cgi.*": {
          target: process.env.VITE_BACKEND || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        // ✨ Socket.IO 代理
        "/socket.io": {
          target: process.env.VITE_BACKEND || "http://127.0.0.1:3000",
          ws: true,
          changeOrigin: true,
        },
      },
    },
  })
});
