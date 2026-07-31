# 家庭片库按需中继生产部署证据（2026-07-31）

> 部署窗口跨越北京时间 2026-08-01 00:00。本文不记录账户密码、机器令牌、
> 影片名称、相对路径或源文件摘要。

## 结论

家庭 `SimpleServer` 已通过仅出站 HTTPS 的 Edge Agent 接入阿里云 SimpleWatch。
Host 可以在公网管理界面读取家庭完整影片目录、编排节目单、观察传输和云端缓存；
云端只按节目单需要拉取影片，不把家庭磁盘远程挂载到公网服务器，也不要求家庭
路由器开放 IPv4/IPv6 入站端口。

qBittorrent 边界已经锁定：

- `/srv/dev-disk-by-uuid-7E82064F82060C79/PLAYS/SimpleWatchLibrary` 只存完整下载的影片；
- 下载中、校验中或临时文件绝不进入该目录；
- Edge Agent 不读取 qBittorrent API、配置、任务状态或临时后缀；
- 连续两次 `size + mtime` 一致只防止人工复制尚未结束，不是下载完成判断。

## 发布版本

| 层级                    | 版本或证据                                                                |
| ----------------------- | ------------------------------------------------------------------------- |
| 功能提交                | `bdde6dd0fb0bfa3269e724ef0ad8e8e0bb3015ef`                                |
| 云端 release            | `/opt/simplewatch/releases/20260731-2350-edge-bdde6dd`                    |
| 云端 App 镜像           | `simplewatch-app:20260731-2350-edge-bdde6dd`                              |
| 家庭兼容修订            | `8835346`，tag `edge-media-home-20260731-8835346`                         |
| Edge Agent release      | `/opt/simplewatch-edge-agent/releases/edge-media-home-20260731-8835346`   |
| Edge Agent 工件 SHA-256 | `9b31c28358acc862dba774abb1a6a4efd1dd870cf566f89e667c668383d7369d`        |
| Edge Agent 镜像 ID      | `sha256:46f39fca370b85c4f2725498390731787dc8e1200850cfa17b4c2c472e0bd8d3` |

Edge Agent 的 Node 24 基础镜像继续固定同一 digest。DaoCloud 代理在家庭 Docker
29.6.2 上错误返回 `application/octet-stream`，Docker Hub 直连超时；经真实拉取与
checksum 验证后，仅 Edge 专用镜像源改为 `docker.1ms.run`，digest 未改变。首次
失败发布已由 `deploy-edge-agent.sh` 自动回滚，未留下运行容器、current 链接或
半成品镜像。

## 云端发布门禁

- 发布前一致性备份：
  `/srv/simplewatch/state/backups/daily/simplewatch-20260731T154945Z.sqlite3`。
- 在备份副本上完成 009 → 012 迁移，并用旧生产镜像重新打开 012 数据库；
  `quick_check=ok`、外键违规 0、旧二进制健康。
- 生产数据库现为 schema 012，`quick_check=ok`、外键违规 0。
- 原有 6 个固定账户和发布前 3 个已发布媒体均在升级后保留。
- App、Worker、Caddy、tusd、MediaMTX、LiveKit 全部运行；带健康检查的容器均
  healthy，6 个容器重启次数都是 0。
- FRPS 与 DERP 保持 active，失败 systemd 单元为 0；UFW 与监听端口没有因
  Edge 功能扩大。
- `/health/ready` 返回 ready；未认证访问 Edge 管理目录返回 401。
- 生产备份服务最后结果为 success。

生产 App 容器丢弃全部 Linux capabilities，`/state` 是 `0750 node:node`；要求
UID 0 的 `edge-agent-manage.mjs` 因而使用一次性
`docker exec --privileged --user 0:0` 运行。没有修改数据库目录权限，也没有给
长期 Compose 服务增加特权。机器令牌从云端 stdout 直接管道到家庭安装脚本，
未显示或落入项目文件。

## 家庭 Agent 隔离与运行证据

- systemd 单元 enabled、active，执行结果 success；容器 running、重启次数 0。
- 运行身份 `10001:10001`，只读根文件系统，`cap_drop: ALL`，
  `no-new-privileges:true`，PID/内存/CPU 上限生效。
- Library 只读绑定到 `/library`；仅 `/state` 可写；机器令牌只读绑定；没有
  Docker socket，也没有发布任何端口。
- 令牌文件权限为 `0400`、所有者 `10001:10001`；环境文件为 `0600 root:root`。
- Agent 结构化日志中没有 warn/error；控制面连接与目录提交事件均已出现。
- qBittorrent 服务部署前后始终 active；10TB 备份盘没有挂载给 Agent；家庭系统
  失败单元为 0。

## 目录、前端与真实传输灰度

- 首次正式目录提交得到 16 个 present 条目和 16 个 present 版本；未输出片名。
- 扫描提交后，云端自动传输、Edge 上传、缓存副本、节目单均为 0，证明目录同步
  不会自行上传影片。
- 真实公网 Host UI 在 320×760 下验证：Agent 在线、16 项目录、刷新按钮、节目单、
  云端片库、传输、系统页面均可用，无横向溢出，登录后 console error 为 0。
- 从完整目录中选择最小候选作真实灰度，源文件 57,380,869 字节；加入节目单后为
  `upcoming`，没有切换现有房间或当前影片。
- Agent 单次尝试完成源证明与上传；传输字节等于声明字节，任务和节目项均 ready。
- 家庭源版本、传输期望和缓存源证明三份 SHA-256 相同；Worker 转码后的 MP4
  数据库 SHA-256 与云端落盘实算 SHA-256 相同。
- 发布 MP4 为 39,468,034 字节，probe 与时长已生成，媒体和 Upload 均为
  published；缓存副本为 protected。
- 公网 Host 会话请求 `Range: bytes=0-1023`，得到 HTTP 206、1024 字节、
  `Content-Range: bytes 0-1023/39468034`、`Accept-Ranges: bytes`、
  `Content-Type: video/mp4`。
- 灰度后 UI 显示 1 个 ready/upcoming 节目项、1 个受保护缓存和 1 条 ready 传输；
  “安全回收”在节目单保护期内禁用。

## 当前生产状态与后续观察

灰度影片仍作为节目单第 1 项保留，但不是 `current`，不会自动开始播放。Host 可在
放映控制中决定何时激活。云端现在应有原 3 个常驻媒体加 1 个家庭缓存媒体；家庭
目录仍有 16 项。

发布后继续观察：

1. 24 小时内关注 App/Worker/Agent 重启数、Agent 心跳、失败任务和磁盘安全余量；
2. 机器令牌有效期 90 天，在到期前 14 天按运行手册轮换；
3. 新影片只在完整下载后移动进 `SimpleWatchLibrary`，不改变 qBittorrent 下载目录；
4. 删除或回收云端缓存必须经过来源核验，不能把家庭原片纳入删除范围。
