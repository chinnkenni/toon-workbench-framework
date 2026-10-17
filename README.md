# 漫剧工作台 · 学习框架

这是一个独立的本地学习副本，用于理解作品管理、剧本与分镜、素材库、时间轴、任务记录和外部能力适配。它使用空白数据与独立端口，可以单独阅读、构建和启动。

副本没有个人作品、运行配置、账号凭据、证书、NAS 档案、模型权重、媒体引擎、第三方技能包或参考图库。源码保留视频、配音、配乐、转写、超分和发布的核心适配器；这些入口需要自行部署相应依赖，不能据此认为 GPU 生成已可用。

## 快速开始

需要 Node.js 22.12 或更新版本及 npm。在本框架副本目录运行：

```sh
npm ci
npm run build:studio
npm test
npm start
```

打开 [本地工作台](http://127.0.0.1:18990/)。首次启动创建本副本自己的 `data/`，页面没有已有作品。按 `Ctrl+C` 停止本终端启动的学习实例。

`npm ci` 安装前端依赖；构建输出位于本副本的 `public/studio-ui/`。测试使用离线防护，阻止网络与进程启动。请勿用生产目录的数据替换学习实例的空白数据。

## 可选入口

| 入口 | 命令 | 本机端口 |
| --- | --- | --- |
| 学习工作台 | `npm start` | 18990 |
| 空白服务器监控 | `npm run start:monitor` | 18987 |
| 进阶服务宿主 | `npm run start:advanced` | 18991 |

常规学习使用 `npm start` 即可。监控可在另一个终端单独启动。进阶宿主会监督并按需启动工作台和监控；使用它时先停止本副本已经启动的相同服务。未安装的媒体引擎会显示不可用。

这些默认端口与原服务隔离。不要改成其他现有实例的端口，也不要把 CLI 指向其他实例。

## CLI 入门

无需全局安装命令。请使用本副本的 npm 入口，不要执行 `npm link` 覆盖其他实例已经安装的 `toon`：

```sh
npm run cli -- help --local --json
npm run cli -- schema work create --local --json
npm run cli -- work list --local --studio-url http://127.0.0.1:18990 --json
```

`help` 与 `schema` 可用于先读命令和输入结构。操作作品前先列出本实例的作品，使用返回的编号；写入后读回。生成、导出、发布等命令有实际副作用，学习接口结构时使用 `schema` 或命令支持的 `--dry-run`。包的命令名为 `toon-framework`，与原 `toon` 分开；配对配置也使用独立的 `.toon-workbench-framework/remote` 目录。

## 建议学习顺序

1. 阅读 [架构说明](docs/ARCHITECTURE.md)，找到前端、HTTP 路由与数据模块的关系。
2. 启动空白工作台，创建自己的练习作品，再观察 `works.mjs`、`studio.mjs` 和 CLI 的请求结构。
3. 阅读 `public/timeline-transport.js`、`public/timeline-preview.js` 与对应测试，理解片段选择、播放头和预览有效性。
4. 阅读 [配置说明](docs/CONFIGURATION.md)，按需接入自己的媒体工具或设备。
5. 分享前阅读 [GitHub 分享步骤](docs/GITHUB-SHARING.md) 与 [第三方说明](THIRD_PARTY_NOTICES.md)。

本框架以 Public 仓库分享脱敏源码，任何人都可查看和克隆。框架尚未指定开源许可证；如需再分发或将代码用于其他项目，请先与维护者明确许可范围。运行数据、账号和真实设备配置不属于仓库内容。
