# 语音频道改造与验收 — 2026-10-26

状态：候选版已于2026-10-29 11:11（Asia/Shanghai）上线。原声单声道、Apple 真机听感及五人30分钟通话移至上线后验收，不标记为已通过。

## 候选发布记录 — 2026-10-29

- 应用提交：`535024fa2261a98bb1b75b5320e2a4b26f1205c4`，分支 `feat/voice-channel-20261026`。
- 发布目录：`/opt/simplewatch/releases/20261029-voice-f6f70839b872`；线上构建标识为 `f6f70839b872a062e40425da79c96a46a3ba9f8d2aa5955091745aec11d98c5c`。
- 线上标识散列完整发布清单，本地无清单构建标识 `f4a319ed…` 散列前端相关源码。打包前重新计算后者与已通过回归的本地构建完全一致；144个源码文件在云端逐项SHA-256校验通过，不能混淆两个摘要口径。
- 镜像：`sha256:3d1e86378caebe5bd0a7e2c77a107930c1b028b71e977abc6af99b2007e371ec`。构建限制1核CPU、1536MiB内存，没有重复整套测试。
- 切换前两次完整空闲检查通过：房间、上传、各类处理/转运/清退任务、直播与语音会话、SFTP进程、媒体可写描述符均0，Worker idle；检查错误0。
- 仅使用 `up -d --no-deps --no-build --pull never app worker` 切换App/Worker。两者healthy、重启计数0；Caddy、tusd、MediaMTX、LiveKit的容器ID、镜像和配置摘要前后完全一致。
- 6个账户、2条媒体及字幕、12个迁移的受保护清单摘要未变，没有数据库迁移。新一致性备份为发布目录内 `ops/predeploy.sqlite3`，权限0600、10,817,536字节，完整性与外键检查通过。
- 公网TLS校验正常，readiness为ready，8个前端静态文件与容器内SHA-256一致；HTML、Service Worker与版本入口均no-store；未登录的会话、媒体库和管理房间接口仍返回401/UNAUTHORIZED。
- 证据：本机 `artifacts/releases/20261029-voice-f6f70839b872-40vo63/ops/` 下的 `deployed.json`、`before.json`、`runtime-check.json`、`public-smoke.json`；远端同发布目录的 `ops/` 保留部署回执和备份。私有产物不提交Git。

回滚仅还原App/Worker旧镜像，不回滚数据库、不删媒体。旧镜像 `sha256:1225dd27251152b47cc368dc5c087c6974f016bd1fe6cb2b9463fde55d06e3b8` 和旧配对配置继续保留；需维护时先确认空闲再执行：

```bash
docker compose -p simplewatch-server \
  --env-file /opt/simplewatch/releases/20260801-120900-crossmount-86930ec/.env.server \
  -f /opt/simplewatch/releases/20260801-120900-crossmount-86930ec/infra/compose/compose.server-ip.yaml \
  -f /opt/simplewatch/releases/20261023-player-961e5f022858/ops/compose.player.json \
  up -d --no-deps --no-build --pull never app worker
```

继续维护本候选版时，应在旧Compose输入后追加本候选 `ops/compose.player.json`；不能只用完整栈基线命令而意外降级。准确命令也记录于 `deployed.json` 的 `maintenanceCommand`/`rollbackCommand`。

### 2026-10-29 最终收尾状态

用户已明确接受候选版先上线并推送GitHub，原声单声道、Apple真机和30分钟通话留到上线后验收。发布前重新检查服务器空闲，只更新App/Worker并保留旧镜像、配对配置和新一致性数据库备份；不再重复整套测试。本地回归构建为 `f4a319ed892e8d18451a0674dc98403b29ff9e2a0e4528e39e8d293e0daa6999`；部署结果见上方发布记录。

- 前端286项、API/集成120项、Worker23项、共享包35项、家庭代理19项、安全功能12项通过；生产依赖审计176包无已知漏洞。后台覆盖率208项通过，语句/行85.92%、分支77.43%、函数88.96%。类型、lint、格式、OpenAPI一致性检查通过。
- 同一构建的三浏览器播放器正式回归13项通过、2项平台跳过；历史WebKit无音轨小seek风险仍保留。稳定报告：`output/playwright/player-history/f4a319ed-20261029/report.json`。
- 语音核心6项真实浏览器用例通过，含真实双声道、稳定模拟设备增益记忆、同时VOD的20次开关、五席63秒短耐久；52项核心单测通过。短耐久五端实际帧943–974、最长帧间隔300ms，每端4路有效电平、应用context维持1。报告：`output/playwright/voice-history/voice-core-full-20261029/report.json`（该组合历史报告的1项cleanup失败已由后述独立授权组修复，不能将原报告改成全过）。
- 新版授权3项与20房间/60采集组合通过；原始采集、应用/fixture context、PeerConnection及解码桥在每次关房后归零。对话与原声双声道均实际48kHz/2ch、96k cap、Opus回退、DTX关闭；语音实测约94.56/96.31kbps，静音仍50包/秒。稳定报告：`output/playwright/voice-history/voice-lifecycle-negotiation-final-20261029/report.json`。
- 最后一次只补单声道：对话模式实际1ch/48kHz通过，协商usedtx=true、SFU disableDtx=false；processed发送轨仍enabled、publication未mute时，零输入使约42.12包/秒降到4.64包/秒。原声模式请求exact1但本机原生假设备实际返回2ch/44100Hz，能力前置不成立，未进入原声mono实际协商；不是已证明的产品错误，也绝不能写成该项通过。该次结果1过1失败，已停止继续换API/重复尝试。报告：`output/playwright/voice-history/voice-mono-focused-final-20261029/report.json`。
- 原生Chromium fake采集并行VOD的零信号原因尚未完全确定；已知幅度后置合成源验证的是处理器、传输及接收链路，不替代真实设备APM。Apple真机与30分钟五席交谈仍待验收。
- 10:26–10:27生产只读快照：App/Worker仍为旧里程碑`20261023-player-961e5f022858`，两者healthy/重启0；活动房间、观众、上传、各类任务、直播与语音会话均0，Worker idle。当前旧镜像与配对override可回滚，12个迁移摘要一致。尚未做本次新备份或SFTP/可写描述符检查，此快照不是切换时的完整空闲门禁。

本次候选授权只调整上述三项验收时序，不等于全部测试通过，不包含基础设施扩容或额外服务改造。

## 已确定的产品边界

- 入房自动连接并订阅语音，不申请麦克风；每次新入房麦克风关闭。
- 首次语音总音量 50%，之后恢复当前账户、当前浏览器的上次设置，不跨设备云同步。
- 每位远端成员的本地收听音量 0–500%，自己的数字发送增益 0–200%；两者初始 100%。逐人偏好按稳定账户保存，发送增益按实际输入设备保存。新设备或设备标识变化从 100% 开始；不把 `default`、`communications` 等别名的旧增益套给新设备。房间尚未确认实际设备时发送增益控件禁用、显示 100%；显式开麦确认设备后可调，关麦后保留该设备的设置。
- 普通退出登录保留经过校验的声音偏好，仍撤销会话、清 Cookie、停止采集和媒体输出、清诊断与认证缓存。
- Opus 每条音轨目标 96 kbps。真实双声道能力贯穿采集、处理、发布和接收；未知声道保守回退，不把复制单声道称为立体声。
- 默认对话模式请求 AEC/NS/AGC，原声模式请求关闭它们但仍保留软峰值保护；网页不强制实验性 voiceIsolation，不代选系统专有模式。
- 纯网页、前台观影优先。允许浏览器要求声音启用/恢复手势，不承诺锁屏和后台持续通话。
- 不转码、不新增服务或端口、不升级 LiveKit 服务端、不改影片同步算法、不触碰家庭磁盘。

## 实现与兼容性

客户端 LiveKit 固定为 2.23.0；语音处理独立于影片 `<video>`。应用每房一个共享 AudioContext，远端音轨只有自有混音图这一条可听输出。为兼容 Chromium 的远端 WebRTC 解码启动行为，每条远端音轨另有生命周期绑定的原生解码桥，始终 `muted=true`、`volume=0`，退订或离房清除；它不是第二条可听播放路径，也不使用 SDK attach 再建混音图。

接收路径为逐人 Gain → 总音量 → 软压缩 → 总静音门 → 输出；发送路径为实际采集 → Gain → 软压缩 → 发送门 → LiveKit。普通增益变化使用 20 ms 平滑；零音量即时关闭数字门，但不能消除既有硬件/网络缓冲。软压缩参数为 threshold -6 dB、knee 6 dB、ratio 20、attack 3 ms、release 150 ms；不声称绝对防削波或修复上游失真。

对话 mono：DTX=true/RED=true；对话 stereo：DTX=false/RED=true；原声 mono/stereo：DTX=false/RED=false。请求参数不等于协商结果；实际码率受静音、内容、网络和冗余编码影响，不为凑满 96 kbps 制造流量。

上述布尔值是客户端请求策略。现有仓库服务端模板与隔离测试SFU的 `enabled_codecs` 仅含 `audio/opus` 和 `video/vp8`，未列 `audio/red`；本地对话模式实际回退为Opus，没有证据表明RED冗余已启用。协商测试必须明确验证这一回退，不得把通过测试写成RED已生效。本轮不修改LiveKit服务端配置或其他容器；线上实时配置尚未核对。DTX实际启用与否另按稳定后的协商、服务端轨道标志和未mute的静音包率记录，不只读请求参数。

按键说话分 OFF、ARMED、TRANSMITTING。ARMED 必须由用户主动开启并明确显示仍在采集；松键仅停发送，总关闭/失焦/后台/离房停止采集，返回前台不自动开麦。

声音记录为 `simplewatch.audio-preferences.v2:<accountId>`。旧全局 v1 无法确认归属，不自动转给新账户。未登录不读取账户记录；存储拒绝、损坏或超界时使用安全默认或会话内存。清除本机声音设置同时关闭正在采集的麦克风。

### 必要的协议调整

- 房间成员增加 `accountId: string | null`；历史 null 仅保留本房音量。
- 房间 bootstrap 增加已认证 `account`，刷新房间能恢复偏好和自动语音，不额外刷新 CSRF。
- RTC identity 使用 `v2:<memberId>:<deviceId>:<leaseEpoch>`，复用租约 acquired_at；普通查询、同会话进入与 24 小时令牌轮换不改变代际，真正接管时单调递增。
- outbox 携带旧完整 rtcIdentity；迟到任务不查询并删除“当前设备”。旧任务只删除旧 UUID identity。
- webhook 校验当前账户、会话和租约。Worker 先枚举 LiveKit 实际 voice 房间/参与者，再调用内部批量校验接口，只删除已确认失效的完整 identity。
- CSRF 错误单独编码为 `CSRF_INVALID`。自动语音仅对它刷新一次 bootstrap 并重试一次；其他权限失败不自动抢席。
- 同浏览器 Web Locks 提供互斥，BroadcastChannel 仅用于交接通知。冻结标签页不强行偷锁，用户可关闭原标签页后重试。

自托管 LiveKit 移除参与者不等于即时作废全部旧 JWT；当前为入场后核验及精确移除，不承诺零窗口入场前阻断。原 Worker 对账目标周期 15 秒，也不是服务异常或长任务期间的严格上限。

## 证据与验收清单

自动化结果以实际命令退出码、浏览器报告和对应源码为准；测试名字或 mock 通过不能替代真机听感。

| 项目                                      | 当前证据/状态                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| API/Worker 接管、撤销、安全回归           | 10月29日升级后重跑：API/集成120项、Worker23项、安全功能12项通过，生产依赖审计通过                              |
| 偏好与界面单元测试                        | 25项通过；包含新设备/别名不继承、未知设备滑块禁用                                                              |
| 音频核心生命周期、图、参数、锁、统计      | 52项通过；属于mock覆盖，真实音频证据另列                                                                       |
| 凭据超时/一次恢复、登出失败不假成功       | 已包含于最终前端286项通过；包含凭据刷新、会话代际与owner释放边界                                               |
| 全项目 TypeScript、ESLint、格式与差异检查 | 10月29日最终通过；候选发布不重复整套回归                                                                       |
| 生产前后端构建                            | 10月29日前后端分别构建通过；仍有既有chunk体积提醒，不作听感证据                                                |
| 共享包、家庭代理、接口与工具检查          | 共享包35、家庭代理19通过；OpenAPI一致、SQLite备份恢复、Compose静态检查通过（未实测Docker部署）                 |
| 真实浏览器 DSP 与双声道处理               | 真实DSP、端到端左右FFT/串音验证通过，详见下方数值                                                              |
| 真实本地 LiveKit 五席、只听、采集、离场   | 核心6项、独立授权3项、20房间/60次采集组合通过；历史报告不改写，详见本页最终收尾状态                            |
| 真实浏览器响应式界面与交互                | 9项UI/会话E2E通过                                                                                              |
| Chromium/WebKit/Firefox 点播回归          | 同构建正式回归13项通过、2项平台跳过；裸HTML与旧版可复现的WebKit无音轨小seek风险继续保留                        |
| 五席本地短耐久                            | 60秒通过：每端4路真实收音电平、RTP增量、实际帧推进、96k cap、单context、桥与退出清理；不是30分钟或真机容量证明 |
| Mac/iPhone Edge/iPad Edge 真机            | 待用户实测，不允许用桌面 WebKit 模拟替代                                                                       |
| Android 厂商音效                          | 无真机；本期仅标准兼容与降级，明确未验收                                                                       |
| 五人至少 30 分钟观影+通话、生产资源       | 待执行                                                                                                         |
| 线上配对 App/Worker 发布及回滚证据        | 已于10月29日11:11完成，仅更新App/Worker，空闲检查、备份和公网smoke通过；旧配对镜像及回滚命令保留               |

安全审计：2026-10-29 升级前发现9条安装命中、5个不同公告（Zod1项high，fast-uri4项中低风险各影响两个版本）。用户在本轮明确批准最小升级后，仅将5个workspace的Zod固定到4.6.7、fast-uri override固定到3.1.9/4.2.3；没有同时升级Fastify、pnpm或服务端LiveKit。使用项目Conda与pnpm store安装，锁文件同步；`audit:prod`复查176个生产包，无已知漏洞，类型与前后端构建通过。本地修补不等于已上线。[Zod 4.6.7](https://github.com/colinhacks/zod/releases/tag/v4.6.7)、[fast-uri 3.1.9](https://github.com/fastify/fast-uri/releases/tag/v3.1.9)、[fast-uri 4.2.3](https://github.com/fastify/fast-uri/releases/tag/v4.2.3)。

Apple 真机分别记录：首次从未开麦只听、拒绝权限仍能听、增益有效、对话和原声、系统模式可见性、开关麦、蓝牙/输入路由切换、前后台恢复，以及同时观看影片和 Host 拖动同步。不得只以页面无报错作为通过。

### 后续真机验收方式（尚未执行）

使用同一候选构建，分别记录 Mac、iPhone Edge、iPad Edge 的系统/浏览器版本和构建标识；不能混用旧页面缓存。测试开始前明确安排候选版本与测试房间，不能据本地构建直接重启线上。

1. 从未开过麦的观众进入房间，确认自动加入语音、麦克风仍关闭、不弹采集权限；首次总音量50%。若浏览器要求手势，仅点“启用语音声音”即可听到，不应为收听要求开麦。
2. 拒绝麦克风权限后仍能听到其他人和影片。稍后在浏览器允许权限，再显式开麦；退出、后台、设备切换和返回前台不得自动重新采集。
3. 逐人从100%调到0%、50%、适度增益，再验证500%上限；先降低设备音量，避免突然高增益。只影响当前收听者，不改变其他人的设置。本人发送增益测试0/100/200%，0%与“关闭麦克风”是不同状态。
4. 同一设备重新入房、刷新及正常登出后再登录，检查总音量、逐人音量及实际麦克风增益恢复；换账户不串用。新设备或浏览器重置后的新标识应100%，不是强行沿用旧标识。
5. 开启按键说话后检查待命采集标志、按下发送/松开停止；失焦、锁屏/后台会关闭采集，恢复后需重新显式开启。切换蓝牙或默认输入时检查旧设备停止，而非继续套用旧增益。
6. 影片始终留在原生播放器，播放/暂停/Host拖动同步保持已有行为。自动压低开启时，再点“启用节目声音”不能取消压低；讲话结束恢复保存音量。
7. 对话/原声、设备实际声道与系统控制中心可用选项分别记录。系统没给网页某项音效或双声道时如实记为不可用/未确认，不以网页文案代替验证。
8. 五席至少30分钟真实观影交谈，记录听感、卡顿、收发码率、丢包/抖动、CPU/内存及最终关房清理。只使用经授权的现有服务观测，不改公网端口、不录制或上传真人声音。

## 可复现本地检查

所有工具运行于项目 Conda 环境，产物在仓库忽略目录，不修改全局环境。RTC 测试仅使用假麦克风，不采集实际设备。

```bash
tools/environment/run-dev pnpm install --store-dir .cache/pnpm-store --frozen-lockfile
tools/environment/run-dev pnpm typecheck
tools/environment/run-dev pnpm lint
tools/environment/run-dev pnpm test:web
tools/environment/run-dev pnpm test:integration
tools/environment/run-dev pnpm test:worker
tools/environment/run-dev pnpm test:security
tools/environment/run-dev pnpm build:production
tools/environment/run-dev node tools/testing/player-run.mjs
tools/environment/run-dev node tools/testing/voice-prepare.mjs
VOICE_LIVEKIT_BIN="$PWD/.cache/voice-runtime/bin/livekit-server" \
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/playwright" \
tools/environment/run-dev pnpm exec playwright test --config playwright.voice.config.ts
VOICE_SOAK_SECONDS=1800 tools/environment/run-dev pnpm test:voice
```

播放器与语音 E2E 共用 localhost 18443/13943，必须顺序执行。语音 SFU HTTP 17880、UDP 17882 仅绑定 loopback，禁用 RTC TCP；不开放局域网或公网测试端口。Go 运行时、源码、sumdb 校验和构建均留在项目内。

## 2026-10-29 恢复核验记录

- `room-hub` 广播前逐连接复核授权。登出、会话撤销后，即使旧 socket 尚未触发心跳，也不能收到新成员广播；单个失效或发送异常的 socket 不阻塞其余成员。47 项后端针对性回归通过，其中新成员广播在已选片、37 秒定位、1×播放状态下保持 revision 与 transport 不变。
- 产品静音解码桥独立通过五席真实 RTC 与真实双声道测试，不再通过测试专用注入修复收音。双声道信号为左右 330/550 Hz；接收实测主频 331.05/551.81 Hz，RMS 0.02767/0.02760，左右隔离 85.0/61.8 dB。该证据证明真实不同声道经过处理器、Opus/SFU 与接收端，不是把单声道复制两次。
- Chromium 的 `totalAudioEnergy` 在此环境仍可能报告 0；验收使用实际接收频谱、RMS、收听电平及 RTP 增量，不以字节流量独自冒充有声。
- WebKit 的小幅定位冻结已在不加载 SimpleWatch、React、语音或同步器的原生视频页复现：两种 play/seek 顺序均在画面时间 1.133 秒停止，而 currentTime 仍增加；不定位对照正常。旧版 `7fecd73` 再重复3次，2次无seek正常，1次在首次0.2475秒alignment seek后同样冻结；正式同步控制器源码与旧版hash一致。证据位于 `output/playwright/vod-native-seek/` 和 `output/diagnostics/vod-webkit-baseline-repeat3-20261029/`。可以排除“语音改造必需导致”，但仍需浏览器/fixture定因，不能据此宣布所有点播门禁通过，也不据此修改既有同步算法。
- 后续独立fixture对照：保留原视频码流只增加合成静音AAC，3项/6实例均通过；仅重新封装、仍无音轨的样本与独立重生成的无音轨样本均在小seek后冻结。当前边界限定为Playwright1.61.1、WebKit revision2311/browserVersion26.5/framework625.1.21+、macOS15.8.1 arm64的无音轨H.264定位路径，不外推为所有Safari真机。原样本是640×360、30fps、High、2 B帧、1秒GOP、60秒纯视频，SHA-256 `3622301d26f44c6ad79fad7ec5f39ee699ad6b6553c646b4c27dc956d50560fa`。三份对照报告位于 `output/playwright/vod-fixture-{original-with-aac,original-remux,regenerated-video}/`；没有替换正式fixture，也没有处理用户影片。
- 旧音轨撤销与再次开麦之间增加串行清理边界；关麦仍同步关闭发送门和实际采集，下一次采集须等待上一条音轨撤销完成，排队中的开启还可被关麦取消。首次授权触发devicechange时，使用采集对象已确认的设备身份，避免发布尚未完成、UI状态尚未更新时误判设备丢失。两项均有先失败后通过的延迟/事件回归，真实浏览器复测继续进行。
- 自动压低影片音量的计算由被动更新与“启用节目声音”手势复用，避免持续有人说话时重复点按按钮恢复到未压低音量；不改时间轴或同步算法。离房在等待网络清理前先同步关闭收听输出门，后续音量更新不能在清理期间重新开启。
- Zod升级后的OpenAPI生成差异仅涉及46处时间正则和62处数值minimum，不增加/删除路由或字段；已重新生成并通过一致性检查，API与共享契约测试另行完整重跑通过。
- 本段是阶段证据，不是完整验收。安全升级授权以2026-10-29用户明确回复为准，不采用历史摘要中的授权推断；本轮仍未获发布授权。

## 发布与回滚

本版本涉及 App/Worker 内部 RTC 协议，不能新 App 带观众与旧 Worker 长时间混跑。后续获授权、本轮全部必要门禁通过（本地真实RTC/DSP、跨浏览器影片、Apple真机、五席持续观影通话与资源）并确认空房/无写入任务后，才配对更新两容器；不更新其他四个容器或服务器端口。回滚前必须排空新版语音连接，避免旧 Worker 无法识别 v2 identity。旧镜像及原播放器里程碑保留。

已有全站可用性及 OBS 未验收项不因本次语音改造被宣布完成。本次登出的媒体释放不等于已全面解决所有离房/媒体切换路径的历史问题。

## 实现参考

- [LiveKit 2.23.0 生命周期修复](https://github.com/livekit/client-sdk-js/releases/tag/v2.23.0)
- [LiveKit 公开 GainAudioProcessor](https://github.com/livekit/track-processors-js/blob/main/src/audio/GainAudioProcessor.ts)
- [LiveKit Hi-fi 与 RED](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit 令牌与自托管撤销限制](https://docs.livekit.io/frontends/reference/tokens-grants/)
- [Apple 网站麦克风说明](https://support.apple.com/en-mt/guide/iphone/iph8dc8a5c3c/27/ios/27)

本实现未复制 Element Call 的 AGPL 代码，也未引入付费或云端降噪服务。
