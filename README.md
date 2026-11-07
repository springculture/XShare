# XShare

贴一个 X 链接，把推文正文与全部配图合成一张按 X 桌面端版式还原的 PNG。

在线使用：https://springculture.github.io/XShare/

纯静态页面，没有构建步骤、没有框架、没有服务端依赖；取数和渲染都在浏览器里完成，内容不上传。

## 能做什么

- 还原 X 桌面端卡片：598px 正文栏、40px 圆头像、名称 / 认证标识 / @handle / 时间同一行、16px 圆角配图
- 1–4 张配图、视频封面、引用推（含引用推自己的配图）、串推「显示上一条」
- **长图完整显示**：三种多图布局可切换。注意「自动」是下面两种固定版式的**条件切换**，不是第三种独立效果
  - `自动 · 遇长图展开`（默认）— 检测到高宽比 ≥ 2 的长图时效果等同「强制纵向」，否则等同「强制网格」；单张图片始终按原比例完整显示
  - `强制网格 · 一律裁切` — 无论图片比例如何都保持 X 原生网格，长图按原生方式裁切
  - `强制纵向 · 一律完整` — 所有图片都按原始比例完整展开
  - 图片按 `contain` 等比绘制，超长图不会被截掉底部；引用推内的长图会等比缩小到 900px 高以保持嵌套卡片紧凑，仍完整不裁切
- 三档主题：亮色 `#FFFFFF`、暗蓝 Dim `#15202B`、纯黑 `#000000`
- 导出透明背景 PNG，1× / 2× / 3× / 4×（2× = 1196px 宽）；可复制到剪贴板，⌘/Ctrl + S 也能下载
- 3:4 / 9:16 竖版、直角模式、完整时间戳、Grok / ⋯ 菜单、互动数据、水印等开关
- 中英界面自动切换；网络不可用时可点「离线示例」

导出背景固定为透明，卡片四角在 PNG 里也是透明的。

## 本地运行

```bash
node serve.js 8080
# 打开 http://localhost:8080/?demo=1
```

`serve.js` 只是一个零依赖的静态文件服务器（仅用 Node 内置模块），任何静态服务器都能替代。不建议直接用 `file://` 打开，浏览器会限制跨域请求。

## URL 参数

| 参数 | 作用 |
| --- | --- |
| `?url=<推文链接>` | 打开即生成 |
| `?demo=1` | 载入离线示例 |
| `?theme=light` / `?theme=dim` / `?theme=black` | 指定主题 |
| `?layout=auto` / `?layout=grid` / `?layout=stack` | 多图布局（旧值 `waterfall` 等同 `stack`） |
| `?ratio=3:4` / `?ratio=9:16` | 竖版比例 |
| `?corners=square` | 直角卡片 |
| `?proxy=<编码后的前缀>` | 更换图片代理前缀（仅本次生效）；`?proxy=none` 关闭代理回退 |

脚本接口：`window.XShare.generate(url)`、`render()`、`download()`、`copyImage()`、`loadDemo()`、`setTheme()`、`setLayout()`、`setRatio()`、`setCorners()`、`setProxy()` / `getProxy()`。

长图会让卡片变得很高。导出时会按画布上限（边长 14000px / 面积 6000 万像素）自动下调倍率，避免浏览器拒绝创建 canvas；此时页面会给出提示。若需要固定倍率，可换用 `堆叠` 之外的布局或降低导出尺寸。

## 部署

GitHub Pages：把本目录推到仓库的 `main` 分支，在 Settings → Pages 选择 `Deploy from a branch` → `main` / `/ (root)`，之后每次 push 自动重建。`.nojekyll` 用于跳过 Jekyll 构建。同样的文件也可以直接拖到 Cloudflare Pages / Netlify / Vercel，无需改动。

## 鸣谢

- **[maxlen727/XSnap](https://github.com/maxlen727/XSnap)** — 本项目基于其数据管线改造：推文取数、多图裁切与网格、引用推与串推处理、以及 PNG 导出流程均来自该项目；视觉层按 X 桌面端版式重新绘制。
- **[FxEmbed/FxEmbed](https://github.com/FxEmbed/FxEmbed)** — 推文数据由其公开接口 `api.fxtwitter.com` 提供，无需 X API key。

## 说明与限制

- 生成图是重绘的卡片，不是真实截图。
- 数据来自非官方公开接口：保护账号、已删除推文无法获取；接口变动会影响可用性。
- 跨域图片进入 canvas 需要 CORS；直连失败时页面会自动尝试公共代理，也可用 `?proxy=` 指向自己的代理。代理必须返回 `Access-Control-Allow-Origin: *`，否则导出会丢图。
