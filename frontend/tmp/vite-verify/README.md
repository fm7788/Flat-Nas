# Static Assets

`frontend/public` 是前端静态素材源目录。

请把这些文件放在这里维护：
- 图标
- 默认壁纸
- 固定图片素材
- `favicon.ico`

注意：
- `server/public` 是构建输出目录，不是素材源目录。
- Windows 本地执行前端构建时，会清空并重写 `server/public`。
- 如果直接修改 `server/public`，下次构建时这些改动可能会被覆盖。
