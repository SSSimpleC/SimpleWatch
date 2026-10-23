# SimpleWatch WebSocket v1

房间实时连接地址为 `/api/v1/rooms/:roomId/ws`。客户端必须携带有效的
`__Host-sw_session` Cookie、受信任的 `Origin`，并协商子协议
`simplewatch.v1`。

所有消息使用统一 envelope：

```ts
type Envelope<T> = {
  v: 1;
  type: string;
  id: string;
  roomId: string;
  sentAtMs: number;
  payload: T;
  replyTo?: string; // 仅 room.hello 响应关联到合法请求 UUID
};
```

当前已实现：

- 客户端：`room.hello`、`clock.ping`、`room.command`、
  `playback.progress`、`playback.status`。
- 服务端：`room.snapshot`、`clock.pong`、`host.changed`、
  `room.command.applied`、`room.command.rejected`、
  `playback.status.summary`、`playback.status.rejected`。
- `room.command` 使用 `commandId` 实现 10 分钟持久化幂等；
  `expectedRevision` 冲突时返回最新 snapshot。
- `room.command.rejected` 会回传可选 `commandId`、错误 `code`、`message` 和
  `details`，使 Host 可以把低于90%的观看决策精确关联到原切换请求。
- `playback.progress` 只允许 Host 上报，不广播、不增加房间 revision；服务端按
  递增 sequence 合并真实播放区间，seek 跳跃不计入观看覆盖率。
- 服务端每 20 秒发送 WebSocket ping，60 秒未收到 pong 时以可恢复的 4000 关闭。
- 每连接每秒最多接收 20 条消息，超限以 4008 关闭。

## 命令确认与恢复

`room.hello` 仅向发起连接回传 `room.snapshot`，不广播全房。HTTP bootstrap
及正常快照均带可选的 `capabilities: {commandAck: true, playbackStatus: true}`。
旧快照缺少该字段时客户端不得假定支持确认能力；旧客户端可忽略新增字段。
hello 的合法 UUID `id` 会在响应外层 `replyTo` 回显；无效 ID 不回显。
恢复操作应记录当前连接代次和请求 ID，只有匹配的回复才能解除“结果未知”后的冻结。
hello 不轮换 CSRF，因此正常重连／恢复不需要重新调用 HTTP bootstrap。

命令成功后仅发起连接收到：

```ts
type CommandApplied = {
  commandId: string;
  revision: number; // 此命令原执行时的版本
  snapshot: RoomSnapshot; // 保存的原执行结果
  currentSnapshot: RoomSnapshot; // 当前房间权威状态，可能已具有更高版本
};
```

新执行的命令结果快照带可选 `cause: {commandId, kind}`，并向房间广播。
重复 ID 回放原确认，但不向全房广播旧结果，也不改变现有节目预取重试语义。
客户端必须先采纳不低于已知版本的 `currentSnapshot`，再解除对应命令等待；
不能使用原执行版本回退当前权威版本。3 秒未确认最多以相同 ID 重试一次；
10 秒仍无法确定时应显示结果未知、清除尚未发送操作并获取当前快照。
迟到确认不得恢复已经废弃的操作队列。

## 临时播放观测

`playback.status` 是有界、非权威的客户端观测，不参与权限、队列推进或观看覆盖率。
通常每 2 秒发送一次；同一席位（包括多个连接）每秒最多接收一次，整包最大 4KiB。
只接受以下字段，未知字段以及客户端自报身份、路径、URL、任意文本均拒绝：

```ts
type PlaybackStatus = {
  mode: "vod" | "live";
  mediaId?: string | null;
  state:
    | "waiting-metadata"
    | "user-action-required"
    | "seeking"
    | "buffering"
    | "playing"
    | "paused"
    | "reconnecting"
    | "error";
  positionSec: number | null;
  targetSec?: number | null;
  revision: number;
  readyState?: number | null;
  videoFrames?: number | null;
  fps?: number | null;
};
```

服务端从当前授权会话推导成员身份。报告仅内存保留 30 秒，每 2 秒清扫；
真实零帧率保留为零，缺测保留 null。服务端只向当前仍有权限的 Host 发送
`playback.status.summary`，包括 `reports: [{memberId, nickname, receivedAtMs, report}]`
及 `serverNowMs`。Host 可以在 `room.hello` 的 payload 添加 `playbackStatus: true`
立即读取现存汇总；普通成员相同请求不会得到汇总。

每次收到消息、发送汇总以及清理报告时都核对相关席位权限，过期或撤销的报告不再可见。
观测拒绝使用独立 `playback.status.rejected`，不会误拒绝 Host 的在途播放命令。

关闭码：

| 代码 | 含义                       |
| ---- | -------------------------- |
| 4000 | 心跳超时，可退避重连       |
| 4001 | 会话失效或已退出           |
| 4003 | 被移出或权限不足           |
| 4008 | 消息速率超限               |
| 4010 | 房间关闭                   |
| 1012 | 服务重启，客户端应退避重连 |
