# 生产发布与回滚运行手册

## 发布前 No-Go

以下任一项未满足即停止发布：P0 服务器接管证据、P4 公网 IP HTTPS/防火墙、P8 ICP/DNS/四 SNI/证书、第三方镜像 RepoDigest、干净且已提交的 Git SHA、数据库一致备份、外部 smoke、回滚目标仍可用。

本地发布候选先执行：

```bash
tools/environment/run-dev pnpm verify
tools/environment/run-dev pnpm release:manifest
```

生产 manifest 必须使用 `-Production`；工作树未提交或不干净时脚本会拒绝生成。当前本地 manifest 只证明源码、锁文件、迁移和原生 RTC 二进制校验和，不替代 Linux 容器 RepoDigest/Image ID。

## 服务器发布顺序

1. 保存当前 release 指针、防火墙、Compose 渲染结果和健康基线。
2. 开启维护页，停止 app、worker、tusd 写入者。
3. 执行 SQLite 一致备份和恢复 smoke。
4. 校验 Secret 权限、第三方 RepoDigest、首方 Image ID、端口和 `docker compose config`。
5. `docker compose up -d --wait --wait-timeout 120`。
6. 内部执行 health、登录、join、VOD Range、WS、LiveKit、WHEP smoke。
7. 关闭维护页，执行外部四 SNI、TURN、UDP/TCP、未知 SNI 拒绝测试。
8. 观察 30 分钟后才完成发布；24 小时告警观察完成后关闭 P9。

## 家庭 Edge Agent 发布

Edge Agent 必须在云端 App/Worker 与010–012加法迁移通过上述回归后发布：

1. 在云端通过 `edge-agent-manage.mjs` 登记机器身份；令牌只允许经标准输入直接
   管道到家庭服务器的 `install-edge-agent-token.sh`，不得显示、落盘到项目或
   出现在命令行参数中。
2. 本地构建 `dist/edge-agent/main.mjs`，生成 SHA-256，并与不可变发布标签一并
   交付家庭服务器。
3. `deploy-edge-agent.sh` 必须验证工件摘要、固定 Library 只读挂载、状态目录、
   令牌权限、零入站端口、非 root 身份和只读根文件系统。
4. 容器 `running` 只代表进程存活，不足以放行。部署脚本还必须在有界时间内看见
   云端心跳成功和首次目录正式提交；任一条件失败时恢复上一个发布、状态备份、
   环境文件和 systemd 状态。
5. 首次真实扫描只允许读取 `SimpleWatchLibrary`。该目录只存完整影片，与
   qBittorrent 下载中目录物理隔离；Agent 不接触下载器或10TB备份盘。
6. 云端目录计数、Agent状态和服务重启数通过后，才允许 Host 把一个小型完整影片
   加入节目单做上传、源SHA、Worker发布和Range播放灰度。

## 分层回滚

单服务失败先切回 manifest 记录的上一不可变镜像。若迁移声明旧应用不兼容，则保持维护页、停止所有写入者，按备份手册恢复数据库；不得仅切旧应用。整机快照仅用于宿主、Docker 或既有服务无法恢复的场景，执行前必须再次确认，因为它会同时回退其他共存服务。
