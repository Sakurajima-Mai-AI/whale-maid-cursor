# DSH 自定义鼠标光标 + 气泡伙伴 · Custom Cursor & Buddy for DeepSeek Harness

让 DeepSeek Harness Web GUI 更有趣的插件：

- **多形象光标与右上角角色同步切换**：鼠标移动/Agent 工作中 → 工作中形象（可换图）；
  在输入框打字 → 键盘形象；静止休息 → 休闲形象；三个主开关在设置页可随时关闭。
- **气泡伙伴**：右上角可拖动的小女仆，随形象换表情（休闲/打字/工作中/**生气/害羞**）；
  点击页面任意位置它都会搭话；拖拽时它生气吐槽、放下后害羞；2.5 秒内连点 4 次也会惹它生气。
- **✨ AI 即兴台词**（可选）：用你当前默认模型现编一句话（节流约 20 秒/条、单条约 90 token）。
- 设置 →「鼠标光标」：形象开关、气泡显示/透明度/位置、大小(32–96px)、热点预设与拖放、AI 台词开关。

> 页面级效果，仅 DSH 浏览器页内生效；需要 Chromium 内核浏览器。
> 背景为黑色的图请用 `--bg 0,0,0` 构建（见下）。

## 文件结构

```
├── README.md · package.json · .gitignore
├── assets/
│   ├── states/
│   │   ├── idle/source.png   ← 休闲形象（必需）
│   │   ├── typing/source.png ← 打字/键盘形象（可缺省，缺省复用 idle）
│   │   ├── busy/source.png   ← 工作中形象（可缺省，默认复用 idle）
│   │   ├── angry/source.png  ← 生气表情（气泡用）
│   │   ├── shy/source.png    ← 害羞表情（气泡用）
│   │   └── (各目录构建产物 cursor-32/48/64/96.png)
│   ├── buddy/{idle,typing,busy,angry,shy}.png   ← 各形象的气泡大图（构建产物）
│   ├── states-manifest.json  ← 构建清单（Host 启动读取）
│   └── preview.png
├── plugin/
│   ├── host.js   ← 粘贴进 code.host
│   └── client.js ← 粘贴进 code.client
└── scripts/build-cursor.js   ← 零依赖 Node 构建
```

## 使用

1. 克隆仓库，改 `plugin/host.js` 顶部 `IMAGE_DIR` 指向你的 `assets` 目录。
2. define 插件：`code.host` ← `plugin/host.js`；`code.client` ← `plugin/client.js`。
3. run 并允许授权；F5 刷新；打开 设置 → 鼠标光标 调节。

换形象图：把 PNG（任意尺寸，白/黑/纯色背景均可自动抠除）放到对应
`assets/states/<name>/source.png`，然后：

```sh
node scripts/build-cursor.js --bg 0,0,0     # 黑背景；白背景去掉参数或用 --bg 255,255,255
node scripts/build-cursor.js --bg 255,255,255
node scripts/build-cursor.js --no-bg        # 已是透明 PNG
```

其它参数：`--size N`（参考/预览档）、`--hotspot x,y`、`--tol N`（抠图容差）。

> 提示：这些示例图多为“满画布贴纸”，角色几乎铺满整图、没有可抠的大片背景；
> 若你看到明显色块/边框残留，多半是背景非纯色，请用透明 PNG 或加容差 `--tol 60`。

## 行为说明

- 光标/角色状态优先级：表情覆盖（拖拽=生气、放下=害羞、连点=生气）> 工作中(移动或 Agent
  运行) > 打字(输入框) > 休闲。
- 打字判定 = 鼠标位于 `input, textarea, [contenteditable], [role=textbox]`；全局点击/移动/
  焦点监听可用时气泡更活泼（设置页会显示是否启用）。
- 配置存在插件 Host 内存，刷新不丢；插件停止后复原。

## 许可与版权

代码 MIT；素材版权归原作者，发布前请确认授权。

## 环境要求

Node ≥ 16（仅构建）；DSH Web GUI（Chromium 内核）。
