# 播放器专项：云端只读基线（2026-10-13）

检查窗口为北京时间 11:13–11:17。仅查询现有服务、配置白名单字段、容器计数与只读数据库；没有部署、重启、迁移、建房、推流或数据库写入，没有访问家庭服务器。

## 访问与发布

- 项目既有维护记录确认目标为 `8.134.239.34`；本机已存在该目标的专用 SSH 密钥。
- 使用 `BatchMode=yes`、`IdentitiesOnly=yes`、`StrictHostKeyChecking=yes` 成功连接。没有新增信任记录，没有读取或输出私钥、环境变量或访问令牌。
- 实际 `current`：`/opt/simplewatch/releases/20260801-120900-crossmount-86930ec`。这不是本轮本地修复的部署证据。
- App/Worker 镜像 ID：`sha256:ddb3037e925aee95ef3132033ba2954fe8d5fd2cde238e69793c703634b71791`。
- 容器内实际版本：MediaMTX `v1.18.2`；LiveKit `1.13.1`。Caddy 镜像标签为 `2.11.4-alpine`，tusd 为 `v2.9.2`。
- 公网正常 TLS 校验下，`GET /health/ready` 返回 `ready`、数据库 `ok`、Worker `healthy/idle`。未使用跳过证书校验。

## 容器与资源

六个 SimpleWatch 容器均运行，重启计数均为 0；App、Worker、Caddy 的配置健康检查均为 healthy。Caddy 当前运行约 29 小时，其余约两个月；本次未调查或改变其既往启动原因。

| 容器     | CPU 上限（核） | 内存上限 |
| -------- | -------------: | -------: |
| App      |           0.35 |  384 MiB |
| Worker   |           0.35 |  320 MiB |
| MediaMTX |           0.50 |  320 MiB |
| LiveKit  |           0.50 |  448 MiB |
| Caddy    |           0.20 |  160 MiB |
| tusd     |           0.12 |  160 MiB |

主机负载快照为 `0.26 / 0.20 / 0.18`。根盘可用 `34,764,517,376` 字节（约 32.38 GiB），内存 available 约 2341 MiB，Swap 使用约 18 MiB。

约五秒的 cgroup v2 窗口（03:16:48Z 至 03:16:53Z）只反映空闲现场：

| 容器     | usage_usec 增量 | nr_throttled 增量 | throttled_usec 增量 |
| -------- | --------------: | ----------------: | ------------------: |
| App      |           93557 |                 3 |              267973 |
| Worker   |            9726 |                 0 |                   0 |
| MediaMTX |               0 |                 0 |                   0 |
| LiveKit  |            4909 |                 0 |                   0 |

App 存在短时配额节流，后续应在真实推流和控制操作同时发生时复测。不能把历史累计节流、这次空闲窗口或一次 `docker stats` 百分比当成直播低帧率根因。

## 会话、上传与后台状态

通过 `sqlite3 -readonly` 并启用连接级 `query_only` 查询，未输出账号、片名、文件路径或令牌：

- 活动房间 0；最近 60 秒活动房间成员 0。
- Worker 状态 idle、当前任务为空；数据库采样时心跳约 5 秒，稍后健康接口采样约 14 秒。
- 媒体处理任务 2 条，均 completed，最大尝试次数 1。
- Outbox 123 条，均 completed。
- 上传记录仅有 published 6、incompatible 2、failed 1、cancelled 2；预留空间合计 0，没有非终态上传记录。
- 当前 queued/leased 的家庭 Agent 任务 0；云端传输记录为 ready 2、evicted 1。此结论只来自云端记录，不证明家庭实机当前可维护。
- MediaMTX 内部只读 API：paths 0、WebRTC sessions 0，没有 publisher 或 reader。

主机 SQLite CLI 不支持 `unixepoch()`；时间查询已改为兼容的 `CAST(strftime('%s','now') AS INTEGER)`，失败查询本身没有写操作。

## 既有直播配置白名单

- MediaMTX API 为内部 `:9997`，metrics 为内部 `:9998`。
- WebRTC 信令 `:8889`；现有本地 UDP/TCP 监听均为 `:8189`。
- `webrtcTrackGatherTimeout: 10s`。
- 允许来源和附加候选主机仍指向现有公网 IP。
- 未读取认证密钥或完整配置，未增加端口、中继或域名。

## 维护与验收边界

当前快照符合“没有活动房间、没有应用上传、Worker 空闲”的候选维护条件，但不是未来任何时刻的停机许可。发布前必须重新核对活动房间、写入任务和 SFTP 写入者，并按专项计划排空；不能凭本记录直接重启或停止服务。

现场没有 OBS 推流，因此无法测量源端实际输出、直播负载下节流、观众呈现帧率或端到端延迟。本记录不能用于关闭“所有观众卡顿”和“直播延迟积累”的问题。
