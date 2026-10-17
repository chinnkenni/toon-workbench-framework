# 分享到 GitHub

本框架按维护者的选择以 **Public** 仓库分享，仓库名为 `toon-workbench-framework`。朋友可以直接查看或克隆，无需邀请协作者；协作者权限只在确实需要共同写入代码时另行授予。以下步骤适用于从脱敏源码建立独立仓库。框架尚未指定开源许可证。

## 上传前

仅使用经过审核的框架副本建立新仓库。不要在原服务目录执行 `git add`，不要复制原目录的 `.git/` 或推送原提交历史。

在框架副本检查：

```sh
npm run check:share
npm test
git status --short
```

检查应覆盖文件清单、个人路径、私网地址、作品记录、密钥、token、证书和不明确许可的第三方内容。构建产物、依赖目录和运行数据无需上传。扫描通过是辅助证据，提交前仍需人工检查暂存内容。

`.gitignore` 只约束通常的未跟踪文件；已经被 Git 跟踪的敏感文件不会因此消失，历史提交中的内容也不会被删除。如果真实凭据已经上传，应先撤销或轮换，再处理历史，不能只删当前文件后继续使用。

## 使用 Git 与 GitHub CLI

以下命令仅在**本框架副本根目录**手动执行。先确认当前目录，再初始化全新历史：

```sh
git init
git branch -M main
git add --all
git diff --cached --stat
git diff --cached
```

确认暂存区没有个人配置、数据或第三方媒体后，创建首次提交：

```sh
git commit -m "Add standalone learning framework"
```

安装并登录 GitHub CLI 后，用自己确定的仓库名创建公开仓库并推送：

```sh
gh auth login
gh repo create toon-workbench-framework --public --source=. --remote=origin --push
```

朋友可直接 clone 并按 README 启动自己的空白实例。仅在需要共同写入代码时，在仓库 Settings → Collaborators 邀请明确的账号。不要通过仓库分享真实服务的登录信息。

## 使用网页

1. 在 GitHub 创建新仓库，将 Visibility 设为 Public。
2. 上传审核后的框架副本文件；保留目录结构，不上传压缩包、依赖、运行数据或原 Git 历史。
3. 在提交预览中检查文件清单与内容，再提交。
4. 将仓库链接发给朋友；阅读和克隆公开仓库不需要协作者邀请。

日常继续使用 Git 更容易审查变更。`package.json` 的 `private:true` 只用于避免误发 npm 包，与 GitHub 仓库可见性是独立设置。

## 持续维护

后续补充代码时继续核对第三方依赖通知并扫描即将发布的历史。许可证尚未确定时不要替上游内容声明许可。需要示例数据时，创建完全虚构的练习作品；不要从个人生产记录中抽样。不要将生产目录与学习仓库互相同步。
