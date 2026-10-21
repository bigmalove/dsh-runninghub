# dsh-runninghub

[DSH Tavern](https://github.com/flizzywine/dsh-tavern) 插件：把本机的 [RunningHub](https://www.runninghub.ai/) 网关接进酒馆——在侧栏工作室里挑工作流、填提示词和参考素材，异步提交图片 / 视频任务，出片后自动下载并插进当前这局的正文。

## 安装

打开 DSH Tavern → 设置 → DSH Tavern → 插件，粘贴本仓库地址，点「安装」，刷新页面就能看到侧栏的 RunningHub 页；宿主侧代码更新后需要重启 DSH。连不上 GitHub 时，下载仓库 ZIP 在同一处点「上传 ZIP」。

装完在面板里填网关地址和 Key（默认 `http://127.0.0.1:6888`）。Key 存进 DSH 的凭据服务（`credentials`），不写进插件文件夹，也不会下发给浏览器。

不需要 `npm install`：插件没有运行时 npm 依赖，`client.js` 用到的 React 由 Tavern 的模块加载器提供。

## 要准备什么

- 本机跑着 RunningHub 网关，默认监听 `http://127.0.0.1:6888`。
- 网关 Key。明文 HTTP 只允许本机回环地址；带 Key 时不会向私网地址发送。

## 用法

**侧栏工作室**：选工作流 → 看 `runninghub_describe` 拿到的参数（分辨率字段、参考素材槽、LoRA 库）→ 填提示词 → 提交。任务在后台轮询，不阻塞聊天；面板里能看到排队 / 运行 / 下载 / 失败的状态，下载失败可以只重下、不重新生成。

**参考素材**：工作流声明的图片 / 音频槽可以直接预览，素材由宿主从网关拉取后经同源路由转给浏览器，网关地址和 Key 不出服务端。

**自动插入**：打开发言框上方的自动插入后，写正文时模型会先构思分镜、用 `runninghub_generate` 把每段视频提交出去（可带 `anchor` 指定插在哪句之后），成片完成后自动补到这一轮正文里。模型只提交、不等出片。

**模型工具**：

| 工具 | 作用 |
|---|---|
| `runninghub_describe` | 读工作流的参数与参考素材槽，不提交任务 |
| `runninghub_generate` | 提交一个图片 / 视频任务，立即返回；不确定时用同一个 `request_id` 重试 |
| `runninghub_status` | 查本地任务历史，只查不提交 |

任务与绑定关系保存在 DSH 数据目录的 `profile-data/tavern/data/runninghub/`（`tasks/` 存任务，`bindings/` 存插入位置）。重启后会继续对账：已知远端任务只查询、不重提，`submit_unknown` 也不会被自动重新提交。

## 开发

`client.js` 是浏览器侧的产物，直接维护，没有构建步骤。

```sh
npm test              # 零依赖单测
npm run test:ui       # 可选界面测试，需 DSH_UI_DEPS=<dsh-tavern>/package.json
npm run test:runtime  # 需要 DSH_BOOT_MODULE=<DSH 运行时>/lib/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js
```

## 许可

[AGPL-3.0](LICENSE)。
