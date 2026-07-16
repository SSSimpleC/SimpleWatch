# 固定账户与会话运维

SimpleWatch 不开放注册、邀请码、房间口令或临时昵称。公网根页面只接受固定账户登录。

## 固定身份

| 账户       | 角色               |
| ---------- | ------------------ |
| `Host`     | 放映管理员与主持席 |
| `Simple`   | 观众席             |
| `FJ233`    | 观众席             |
| `Conflict` | 观众席             |
| `Fpliy`    | 观众席             |
| `Lorrence` | 观众席             |

房间最多五个活跃账户。Host 占一席，因此同场最多再进入四个观众账户；其余账户在认证后的门厅等待空位。一个账户可在多个浏览器中保持登录，但只有最新接管的设备可以连接房间媒体与语音。

## 会话

- Cookie：`__Host-sw_session`，`Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/`。
- 闲置七日失效；持续使用的绝对期限为三十日。
- 会话令牌满二十四小时后在恢复会话时轮换。
- 登录失败按账户与客户端IP持久化限速，服务器重启不会清空。
- 登录、退出、踢人、关闭房间和设备接管均会撤销相应媒体权限。

## 生成和部署密码

```bash
tools/environment/run-dev pnpm accounts:generate
```

输出位于已被Git忽略的 `artifacts/private/`，权限为 `0600`。该JSON是唯一的明文交付件；Git、容器环境、日志和服务器持久目录都不得保存其内容。

发布时将文件以 `0600 root:root` 临时复制到服务器，再作为 `deploy-ip-test.sh` 第五个参数传入。初始化CLI从标准输入读取并写入 Argon2id 哈希；发布脚本随后删除服务器临时副本。服务器 `PASSWORD_PEPPER` 只保存在当前release继承的 `0600 .env.server` 中。

单独轮换或禁用账户时，在维护窗口通过标准输入调用：

```bash
printf '%s' '{"username":"Simple","password":"<新随机强密码>"}' |
  ALLOW_ACCOUNT_MANAGE=fixed-account-maintenance pnpm --filter @simplewatch/api accounts:manage
```

也可传入 `"enabled":false` 禁用账户。密码或启用状态变化会立即撤销该账户全部设备会话。

## 安全边界

本次收口覆盖SimpleWatch Web、API、媒体鉴权和容器资源限制。SSH、MES、FRP与DERP属于同一公网IP上的独立服务，本轮不修改；不能用SimpleWatch的安全验收替代这些服务各自的安全审计。
