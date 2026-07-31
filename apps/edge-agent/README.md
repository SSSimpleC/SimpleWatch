# SimpleWatch Edge Agent

家庭端只读媒体代理。它从专用 Library 建立目录索引，主动通过 HTTPS
长轮询领取任务，并使用 tus 断点续传把被请求的影片上传到 SimpleWatch。

## 数据边界

- `LIBRARY_ROOT` 必须指向专用完整媒体目录，生产值为
  `/srv/dev-disk-by-uuid-7E82064F82060C79/PLAYS/SimpleWatchLibrary`。
- qBittorrent 的下载目录与 Library 物理隔离；Agent 不访问 qBittorrent API、
  配置或下载目录，也不判断任何 qB 临时后缀。
- Agent 对 Library 只有只读权限，协议中没有删除、移动或改名家庭源文件的
  动作。
- 普通文件必须在连续两次扫描中保持 `size + mtime` 不变，才会发布到云端
  catalog。这项通用保护用于防止人工复制尚未结束时被误收录。
- 符号链接、特殊文件、路径越界和非视频白名单扩展名均被忽略或拒绝。

## 必需配置

```text
EDGE_API_ORIGIN=https://example.com
EDGE_AGENT_TOKEN_FILE=/run/secrets/edge_agent_token
LIBRARY_ROOT=/library
EDGE_STATE_PATH=/state/edge-agent.sqlite3
```

默认每5分钟完整对账一次，启动后2分钟进行第二次稳定性观察；任务使用25秒
HTTPS长轮询、15秒租约心跳、16MiB tus分块和单上传并发。

本地SQLite只保存目录映射、扫描代次与断点续传状态。机器令牌通过只读
secret文件注入，不进入命令行、日志或环境变量。

部署前应由root一次性创建宿主机目录，并把容器所需文件限制给专用UID：

```bash
install -d -o 10001 -g 10001 -m 0700 /srv/simplewatch-edge-agent/state
install -d -o root -g root -m 0750 /etc/simplewatch-edge-agent
install -o 10001 -g 10001 -m 0400 /dev/null /etc/simplewatch-edge-agent/agent-token
```

最后一条命令只创建空占位文件；机器注册CLI生成的令牌应通过标准输入写入该
文件，不能把令牌直接放在shell命令行。`edge-agent.env` 只保存
`RELEASE_TAG` 与 `EDGE_API_ORIGIN`，不得保存令牌。
