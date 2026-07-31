# 阿里云服务器维护与清理记录（2026-07-30）

> 目标实例：`8.134.239.34`（Ubuntu 22.04，2 vCPU、约 3.4 GiB 内存、约 49 GiB 根盘）。
>
> 维护原则：先备份和建立资产映射，再按业务归属清理；仅保留仍有明确依赖的服务与文件。本文不记录密码、令牌、私钥或完整敏感环境变量。

## 结论

本轮清理、升级、加固与回归已经完成。维护期间按需下线了项目服务，最终所有应保留的服务均已恢复；没有遗留处于维护下线状态的项目。

- SimpleWatch：保留，已发布修复版并通过公网完整业务回归。
- FRPS：保留，`wh07`、`wh09` 客户端及代理恢复正常。
- DERP：保留，TLS 中继与 HTTP 探针正常；STUN 的云安全组限制单独列为外部待办。
- `circular-loom-mes`、旧 `mes-modbus`：业务已废弃，服务、容器、网络、镜像、项目文件和凭据缓存已移除。
- 远程 IDE、在线构建工具链：服务器不再承担编译工作，相关工具、包、缓存已移除。
- 正式媒体：仅保留数据库绑定的 3 部影片及 2 份仍有效的 tus 元数据；文件大小和完整 SHA-256 均与数据库一致。
- 清理后根盘使用约 12 GiB、剩余约 36 GiB（25% 使用率）；相较维护前约 33 GiB 已用、15 GiB 可用，释放约 21 GiB。

## 维护前基线与恢复点

- 维护前 SimpleWatch 发布：`20260716-153756-e4b80d87`。
- 维护前根盘约使用 33 GiB、剩余 15 GiB；无 Swap。
- Worker 累计重启 2312 次；废弃 MES Gateway 累计重启 22036 次。
- Docker 日志约 4.1 GiB、systemd journal 约 4.0 GiB，均无合理上限。
- Docker 构建缓存约 12–13 GiB；同时存在多代大体积开发镜像。
- 运行内核为 `5.15.0-142-generic`，且缺少跟踪受支持内核的元包。
- 维护前一致性备份：
  - `/srv/simplewatch/state/backups/maintenance-precleanup-20260730T1635+0800.sqlite3`
  - SHA-256：`72b53c823795d38ea83bafa2c56018e54196c09b4720549b1a0636cdaac86e17`
  - `quick_check=ok`、外键违规 0，并完成本地只读恢复检查。
- 部署前恢复点：
  - `/srv/simplewatch/state/backups/maintenance-predeploy-20260730T1705+0800.sqlite3`
- 回滚发布保留：
  - `/opt/simplewatch/releases/20260716-153756-e4b80d87`
  - 对应 App、LiveKit、MediaMTX 镜像仍保留。

## SimpleWatch 修复与发布

当前发布：

```text
/opt/simplewatch/releases/20260730-1705-maintenance-e4b80d87
```

主要修复：

- Worker 持久心跳、任务续租、单任务失败隔离、指数退避和有限重试。
- 对历史高重试任务提供一次有界恢复，不再形成无限重启或无限领取循环。
- 媒体任务支持从经过边界与真实路径校验的最终目录幂等恢复。
- Outbox 会话 ID 去重、分块、精确闭合、有限重试和历史错误兼容。
- RTC 只对账活动房间；关闭房间、踢人和设备接管均精确撤销媒体能力。
- `/health/live` 检查 API 进程；`/health/ready` 同时检查数据库和新鲜 Worker 心跳，不再由代理固定返回成功。
- API、Worker 与运维 CLI 使用生产 bundle；最终镜像不包含 `tsx`、pnpm、完整源码和开发依赖。
- Node 基础镜像固定到验证过的 digest，避免浮动标签引入未审计层。
- LiveKit API 凭据已轮换，并核对应用、Worker、LiveKit 配置一致；明文未写入维护记录。

数据恢复和收口：

- 原有 2 个卡在 `scanning` 的真实媒体任务已幂等恢复为 `completed`。
- 两个过期断点上传已通过应用生命周期释放预留后清理。
- 2 条包含 36/44 个会话、累计失败约 4959 次的历史 Outbox 已兼容完成。
- 119 条历史未闭合传输会话已按房间和精确会话 ID 收口。
- 先清除了历史 E2E 产生且能够以命名、数据库引用和物理路径三重确认的 8 条测试媒体记录及 20 个测试文件；最终公网回归后又清除了 2 条软删除测试媒体、3 个任务、1 条字幕、46 条 H.264/H.265 测试上传、13 条取消测试上传及 5 个物理文件。
- 最终测试资产计数为 0；严格保留了 7 条真实上传历史、3 个正式媒体文件和 2 份对应的 tus 元数据，没有按宽泛路径或时间范围删除业务数据。
- 第二轮精确清理时，一次性 SQLite 连接未启用外键级联，事后检查立即发现 1 条测试字幕孤儿；该精确行已删除并再次验证 `quick_check=ok`、外键违规 0。该问题没有涉及正式媒体或其他业务记录。
- 清除了 6 个旧的 pre-\* 数据库/WAL/SHM 文件、重复早期日备份和已失去用途的维护回滚目录。

最终数据库状态：

| 指标               |                结果 |
| ------------------ | ------------------: |
| 固定账户           |         6，全部启用 |
| 正式媒体           |   3，全部 published |
| 媒体任务           |   3，全部 completed |
| Outbox             | 116，全部 completed |
| 上传历史           |   7，预留空间均为 0 |
| 活动房间           |                   0 |
| 未闭合传输会话     |                   0 |
| SQLite quick check |                  ok |
| 外键违规           |                   0 |

## 容器与运行时规范

最终运行 6 个 SimpleWatch 容器：App、Worker、Caddy、tusd、MediaMTX、LiveKit。

- 6 个容器均 `running=true`、重启计数 0。
- App、Worker、Caddy 的健康状态为 `healthy`；其余服务通过真实协议回归验证。
- 全部容器：
  - 非特权模式；
  - 只读根文件系统；
  - `cap_drop: ALL`；
  - `no-new-privileges:true`；
  - 明确的 CPU、内存、PID 上限；
  - `restart: unless-stopped`；
  - Docker `local` 日志驱动，单文件 20 MiB、最多 3 个。
- Docker 本地卷为 0；只保留 3 个 Compose 必需网络。
- 构建缓存已清空；镜像仅保留当前发布、一个回滚发布及 Caddy、tusd、Certbot 运行依赖。
- 当前 App 镜像约 731 MiB，旧回滚 App 镜像约 1.48 GiB，仅作为已验证回滚点保留。

## 已彻底移除的资产

- `circular-loom-mes-web`、MES Gateway、旧 `mes-modbus` 的 systemd/Compose 运行项。
- MES 容器、网络、镜像、项目目录、旧构建产物和私有仓库凭据缓存。
- 公网 8080、8091 入口；复核均已关闭。
- code-server/远程 IDE 及其服务、配置、扩展和缓存。
- 服务器端 Node/npm/pnpm、Go 编译工具链和无业务归属的开发包。
- Tailscale 客户端及 `tailscaled`；DERP 服务本身保留。
- 废弃的 Snap/LXD、`python3-pip`、相关缓存和孤立包。
- `watchadmin` 维护账户；保留的 UID 1000 文件属主账户 `admin` 已改为不可登录、无 sudo、home 为 `/nonexistent`。
- root 主目录中的旧安装包、临时脚本、无归属归档、历史凭据缓存和重复产物。

系统中已确认不存在 `circular-loom-mes-web.service`、`code-server.service`、`tailscaled.service`；`code-server`、Node、npm、pnpm、Snap 命令均不存在。

## 保留服务与加固

### FRPS

- 仍有 `wh07`、`wh09` 长期客户端依赖，保留。
- 迁移到专用 `frps` 系统账户，shell 为 `/usr/sbin/nologin`，home 为 `/nonexistent`。
- systemd 沙箱安全评分 3.7（OK）。
- 重启后控制端口 7000 与代理端口 6007、6009 均恢复，客户端自动重连。

### DERP

- 仍有长期设备依赖，保留。
- 迁移到专用 `derper` 系统账户，shell 为 `/usr/sbin/nologin`，home 为 `/nonexistent`。
- systemd 沙箱安全评分 3.7（OK）。
- DERP TLS 33331 返回 200；HTTP 探针 33332 可达；服务监听 STUN UDP 3478。

### SSH 与防火墙

- SSH 改为密钥认证；root 仅允许密钥认证，不开放 root 密码登录。
- UFW 已启用，只保留业务合同中的端口。
- 实例监听与 UFW 规则一致，没有 MES、IDE、数据库或内部 tusd 端口直接暴露。

公网端口合同：

|       端口 | 协议    | 用途                  |
| ---------: | ------- | --------------------- |
|         22 | TCP     | SSH                   |
|         80 | TCP     | SimpleWatch HTTP/ACME |
|        443 | TCP     | SimpleWatch HTTPS     |
|       7881 | TCP     | LiveKit 信令/回退     |
|  7882–7883 | UDP     | LiveKit 媒体          |
|       8189 | TCP/UDP | MediaMTX WebRTC       |
| 6007、6009 | TCP     | FRPS 代理             |
|       7000 | TCP     | FRPS 控制             |
|      33331 | TCP     | DERP TLS              |
|      33332 | TCP     | DERP HTTP 探针        |
|       3478 | UDP     | DERP STUN             |

## 系统维护、日志与备份

- 安装受支持内核元包并完成系统升级、重启；当前内核 `5.15.0-186-generic`。
- `systemctl --failed` 为空。
- 新增 2 GiB `/swapfile`，权限 `0600`，写入 `/etc/fstab`，`vm.swappiness=10`；重启后已自动启用。
- journald 已设置容量上限，当前约 496 MiB。
- Docker 构建缓存为 0；容器日志具有 20 MiB × 3 上限。
- 根盘最终：49 GiB 总量、约 12 GiB 已用、36 GiB 可用、25% 使用率。
- 最终内存：约 590 MiB 在用、约 2.6 GiB 可用；Swap 基本未使用。
- `dpkg --audit` 无输出。
- 唯一显示可升级的包是阿里云镜像按供应商策略保留的 `cloud-init`；本轮未越过供应商 pin 强制替换。

自动备份：

- `simplewatch-backup.timer` 已启用，每日 03:20 后带随机延迟执行，保留 14 天。
- 服务仅取得数据库目录读取权与备份目录写入权，并采用严格 systemd 沙箱；安全评分 2.5（OK）。
- 最终备份：`/srv/simplewatch/state/backups/daily/simplewatch-20260730T101033Z.sqlite3`
- 最终备份及 `.sha256` 权限均为 `0600 root:root`，SHA-256、SQLite integrity check 和外键检查通过。
- 服务器仅保留两个维护恢复点和一个最终日备份，不保留重复副本。

证书：

- IP 证书 SAN 为 `8.134.239.34`。
- 当前有效期：2026-07-29 11:24:18 UTC 至 2026-08-05 03:24:17 UTC。
- `simplewatch-ip-cert.timer` 已启用并完成成功演练；本次不在续期窗口，因此证书内容未被无意义替换。

## 回归证据

### 本地完整门禁

`tools/environment/run-dev pnpm verify` 全部通过，包括：

- 环境、计划占位符、测试 ID、ESLint、Prettier；
- 全工作区 TypeScript 类型检查与 Web 生产构建；
- 单元、集成、安全、覆盖率、媒体、Worker、Range、RTC、备份和 Compose 安全合同；
- 生产依赖 175 个包，无已知漏洞；
- 覆盖率：语句/行 86.88%，分支 75.60%，函数 93.65%；
- OpenAPI 与路由契约一致；
- 本地 Playwright 3/3 通过。

### 公网完整业务回归

在真实发布环境执行的 Playwright 公网回归 2/2 通过，并在凭据轮换、最终配置与数据清理后再次执行，仍为 2/2 通过：

- Host/观众固定账户登录与会话恢复；
- H.264、H.265 上传和 Worker 处理；
- 字幕上传；
- 房间创建、VOD 播放；
- WHIP H.264 + Opus 发布；
- WHEP 拉流；
- Host 与观众 LiveKit 语音；
- 管理监控、关闭房间、撤销和测试数据清理；
- 上传速度显示与取消。

Mac 上 Clash TUN 保持开启，只为 `8.134.239.34/32` 增加精确 `DIRECT` 规则。该规则避免 WebRTC 候选经代理出口失真，不影响其余代理流量；生产回归在此真实直连条件下通过。

### 独立公网检查

- 家庭服务器确认 TCP 22、80、443、6007、6009、7000、7881、8189、33331、33332 全部可达。
- HTTPS `/health/ready` 返回 200，数据库与 Worker 均为 ready。
- TLS 证书 SAN 与公网 IP 匹配。
- DERP TLS 返回 200，HTTP 探针可达。
- 最终 6 个容器重启计数均为 0。

## 外部边界与后续事项

本轮只有一项无法在实例内部闭环：

- DERP 进程已监听 UDP 3478，UFW IPv4/IPv6 规则也已放行，但来自家庭服务器的测试流量没有到达主机计数器。证据指向阿里云安全组尚未放行 UDP 3478。
- 这不影响 DERP TLS 中继本身，33331 已回归成功；但会使 STUN 打洞优化不可用。
- 如需 STUN，应在阿里云控制台安全组中增加入方向 UDP 3478，再从外网复测。不要在实例内继续扩大端口范围来规避云安全组。

除上述云控制台事项外，本轮服务器内的清理、恢复与回归均已闭环。

## 验收清单

- [x] 生产镜像固定干净基础镜像，不含远程构建工具和开发运行时。
- [x] Worker 心跳、续租、有限重试、幂等恢复与失败隔离通过测试。
- [x] RTC 仅对账活动房间，Outbox 分块、精确闭合与有限重试通过测试。
- [x] `/health/ready` 真实反映数据库与 Worker 状态。
- [x] 六个容器具有资源、安全和日志边界，运行稳定、重启计数 0。
- [x] 真实媒体恢复完成，正式媒体文件与数据库哈希一致。
- [x] 过期上传和测试资产按精确映射清理，不影响正式媒体。
- [x] MES、远程 IDE、在线构建环境及其无归属资产彻底移除。
- [x] 当前发布与一个回滚发布有序保留。
- [x] FRPS、DERP 迁移到专用账户并完成 systemd 沙箱。
- [x] SSH、防火墙、证书、日志、Swap、内核和备份完成收口。
- [x] 数据库、媒体、上传、播放、RTC、撤销、备份恢复与公网端口回归通过。
- [x] 所有应保留服务均已恢复，没有维护下线遗留。
- [ ] 阿里云控制台放行并复测 DERP STUN UDP 3478（外部控制面待办，不阻塞 DERP 中继）。
