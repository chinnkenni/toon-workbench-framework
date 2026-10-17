# 配置学习实例

先完成 README 的构建与空白启动。默认配置只用于本机学习：工作台 18990、可选监控 18987、进阶宿主 18991。数据保存在本副本的 `data/`；日志、运行时和私密配置不应提交 Git。

## 环境变量

`.env.example` 是空白模板。需要接入自己的 GPU 设备时，将它复制为 `.env` 并填写自己的信息。模板中的 `TOON_GPU_*` 字段用于适配器绑定；仅填写这些字段不会安装媒体引擎、容器、模型或远端服务。

`npm start`、`npm run start:monitor`、`npm run start:advanced` 与 `npm run cli` 已通过 Node 的 `--env-file-if-exists=.env` 加载文件。直接运行 Node 时必须自行带上该参数，例如：

```sh
node --env-file-if-exists=.env cli/toon.mjs help --local --json
```

环境变量不是加密存储。SSH 私钥只保存到自己控制的独立文件，配置中填写引用；不要把私钥正文、账号 token 或 OAuth secret 写进源码、命令行参数或文档。不要复制其他实例的 `.env`、凭据或证书。

## 文件模板

`config/` 下的 `.example.json` 只供阅读，不会自动启用。需要时手动建立对应目录、复制模板并修改自己的值：

| 模板 | 生效位置 | 默认行为 |
| --- | --- | --- |
| `config/servers.example.json` | `data/servers.json` | 空设备列表；启动监控也不会预置远程服务器 |
| `config/archives.example.json` | `data/work-archives/config.json` | `enabled:false`，无 NAS 根目录 |
| `config/lan.example.json` | `data/lan/config.json` | `enabled:false`，无绑定地址、证书或私钥 |

只需要作品管理时，无需复制这些模板。LAN 网关与 NAS 档案属于可选集成：使用自己的地址、权限、证书和目录，启用前阅读相应模块的校验规则。LAN 模板使用学习工作台的上游端口；不要指向其他现有实例。不要关闭 TLS 校验来绕过证书配置。

## 外部能力

| 能力 | 需要自行准备 |
| --- | --- |
| 视频、配音、配乐、超分 | 兼容的媒体引擎或工作流、用户自己的设备、模型与可验证的模型清单 |
| CPU 转写 | 兼容运行器、模型、文件哈希与清单 |
| CPU 合成导出 | 兼容的 FFmpeg/FFprobe；核对 `timeline-renderer.mjs` 的运行器路径 |
| 平台发布 | 自己的平台应用、账号授权和合适的凭据保护；学习启动入口未挂接真实发布适配器 |
| 创作技能与全局图库 | 技能可另行取得许可并登记。分享版的 `style-references.mjs` 中 `gallery()` 固定返回空图库；扩展全局图库需要自行实现加载器，不能只复制生产清单 |

模型与部署实测清单没有附带。不要把文件名存在、schema 存在或界面按钮存在当成能力就绪。先读 capability，再验证自己的独立部署，最后提交明确的任务。

进阶宿主为可选媒体引擎预留本机端口 19300，并使用学习副本下的 `runtime/`、`vendor/` 与 `data/`。这些目录初始缺失，宿主不会代为下载依赖。不要将正在使用的引擎或数据目录链接进来。

## CLI 与实例隔离

CLI 默认工作台地址为 18990，监控为 18987。为便于核对，可显式指定：

```sh
npm run cli -- work list --local --studio-url http://127.0.0.1:18990 --json
npm run cli -- servers list --local --monitor-url http://127.0.0.1:18987 --json
```

`--local` 避免使用已配对的远程配置。本副本配对配置位于独立的 `.toon-workbench-framework/remote` 目录，不应复制其他客户端配置。包的命令名为 `toon-framework`；学习时继续使用 `npm run cli -- ... --local`，不要运行 `npm link` 或覆盖已有 `toon`。

`PORT` 等变量只应在了解对应启动入口后修改；学习启动脚本固定使用 18990，不从通用 `PORT` 覆写。
