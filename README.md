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

准备隔离的播放器与语音测试工具后，运行自动化部署前门禁：

```bash
tools/environment/run-dev pnpm test:player:prepare
tools/environment/run-dev pnpm test:voice:prepare
tools/environment/run-dev pnpm verify
```

`verify` 包含本地真实 LiveKit 语音门禁，但不替代 Apple 真机、持续容量与发布授权。30 分钟本地假音频耐久测试需单独执行 `VOICE_SOAK_SECONDS=1800 tools/environment/run-dev pnpm test:voice`；它也不能替代真实设备观影交谈和生产五席资源验收。验收状态见[语音改造记录](docs/gates/VOICE-CHANNEL-20261026.md)。

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
- [语音频道改造与验收](docs/gates/VOICE-CHANNEL-20261026.md)（2026-10-29候选版已上线；原声单声道、Apple真机与30分钟通话待验收）

## 安全说明

生产 Secret、管理员口令、Agent 机器令牌、SFTP 私钥和证书私钥不得提交到仓库。家庭 `SimpleWatchLibrary` 只存放完整影片；qBittorrent 下载目录与它物理隔离，Edge Agent 不访问下载器且只读挂载 Library。服务器发布前应根据运行手册生成独立 Secret、执行 SQLite 一致备份并保留可验证的回滚目标。

## 当前状态

2026-10-24 达成点播同步阶段里程碑：用户分别在 Mac + iPad、Mac + iPhone 上测试，确认画面同步迅速、延时及卡顿明显改善，正常播放基本稳定。对应应用提交为 `010dfc2`，已通过 [PR #9](https://github.com/SSSimpleC/SimpleWatch/pull/9) 合并；线上播放器构建标识为 `961e5f022858`。实施、上线及验收边界见[点播同步重构记录](docs/gates/VOD-FIXED-RATE-20261023.md)。

这是点播正常播放链路的阶段验收，不代表全部功能或可用性已完成：退出/关房后的旧媒体请求、API 等待超时及跨标签页鉴权一致性仍待处理，Mac 间歇访问困难尚未完整定因；真实 OBS 直播也未验收。本轮里程碑归档只更新文档与本地诊断目录忽略规则，不改应用运行逻辑或线上服务。

语音候选版已获用户授权并于2026-10-29仅配对更新App/Worker；候选上线不代表Apple真机和持续容量已验收。当前版本的自动化、真机与发布状态分别以[语音验收记录](docs/gates/VOICE-CHANNEL-20261026.md)和[P0–P9 门禁矩阵](docs/gates/P0-P9-GATE-MATRIX.md)为准；正式域名、可信证书与 TURN 等历史规划不属于本轮新增实施范围。
