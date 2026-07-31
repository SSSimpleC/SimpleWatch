# SimpleWatch

SimpleWatch 是面向小范围熟人房间的自托管同步观影系统，支持受保护的 MP4 点播、家庭完整片库按需传输、Host 节目单、WebVTT 字幕、OBS WHIP 直播、多人麦克风语音、主持控制和独立音量调节。

## 技术栈

- Node.js 24、pnpm 10、TypeScript
- Fastify、React、SQLite
- Caddy、tusd、MediaMTX、LiveKit
- Playwright、Vitest、FFmpeg

## 本地环境

项目使用仓库内隔离的 Conda 环境，避免依赖全局 Node.js 或 pnpm：

```bash
conda env create --prefix .conda/envs/dev --file environment.yml
tools/environment/run-dev pnpm install --frozen-lockfile
tools/environment/run-dev pnpm env:check
```

运行完整正式部署前门禁：

```bash
tools/environment/run-dev pnpm verify
```

## 项目结构

- `apps/api`：REST、WebSocket、鉴权、房间和媒体控制
- `apps/web`：管理端与观影端 PWA
- `apps/worker`：媒体探测、发布、SFTP 扫描和可靠任务
- `apps/edge-agent`：家庭完整片库只读扫描、任务领取和 tus 断点续传
- `packages`：配置、协议、媒体与同步共享包
- `infra`：本地和服务器 Compose、Caddy、LiveKit、MediaMTX 与 SSH 配置
- `tools`：环境、测试、发布和服务器运维脚本
- `tests`：安全、集成、RTC、浏览器和部署前测试

## 文档

- [实施计划](IMPLEMENTATION_PLAN.md)
- [OpenAPI](docs/openapi.yaml)
- [部署运行手册](docs/operations/DEPLOYMENT-RUNBOOK.md)
- [备份恢复手册](docs/operations/BACKUP-RESTORE.md)
- [家庭片库按需传输运行手册](docs/operations/EDGE-MEDIA-PIPELINE.md)
- [P0–P9 门禁矩阵](docs/gates/P0-P9-GATE-MATRIX.md)
- [正式部署前测试用例](tests/docs/PREDEPLOY-TEST-CASES.md)

## 安全说明

生产 Secret、管理员口令、Agent 机器令牌、SFTP 私钥和证书私钥不得提交到仓库。家庭 `SimpleWatchLibrary` 只存放完整影片；qBittorrent 下载目录与它物理隔离，Edge Agent 不访问下载器且只读挂载 Library。服务器发布前应根据运行手册生成独立 Secret、执行 SQLite 一致备份并保留可验证的回滚目标。

## 当前状态

本地综合门禁和服务器 IP 阶段核心链路已经通过；正式域名、可信证书、TURN、多网络真机和持续容量门禁状态以门禁矩阵为准。
