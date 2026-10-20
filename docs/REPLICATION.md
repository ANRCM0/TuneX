# RelayX 复刻剩余工作

> 当前“已复刻 / 未复刻”的总账见 [GAP_REPORT.md](GAP_REPORT.md)；本文件只记录复刻阶段的推进顺序。

目标：副本在本仓库能跑起来的面上，和 `relayx-analysis/reports/` 里已经写明的上游行为一致。不恢复上游已经失效的比较，也不补部署层没有的账号和内核能力。

证据基线是 `.audit/*.md`（2026-10-19）加上其后已经落地的 Fernet 默认密钥对齐（`apps/backend/src/config.ts` 与 agent `key1` 同为 `KV/JjKrj8g6nNnvpQoViRs4QLLap5d9cRSwmMBOEdP4=`）。

## 阶段

| 阶段 | 内容                                                                                     | 完成标准                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 已经实现、但和上游或副本内部不一致的行为                                                 | 有对应单测，行为只改这一处                                                                                                                                                             |
| 2    | 控制面跑不起来：不设 Redis 时 cron 不执行；socket 注册/封禁/`listen_error` 没有后端测试  | 已落地。`local-scheduler.ts` 在 `REDIS_URL` 为空时按上海时区调用带 `cron` 的处理函数；`runJob` 可直接调用 12 个名字。测试覆盖注册拒绝、60 秒封禁、过期授权、`listen_error`。心跳仍未测 |
| 3    | Agent 传输缺口：`ws` 被当成裸 TCP，`mws` 监听/拨号不存在；`upgrade` 只落盘不替换、不重启 | 已落地。`ws`/`mws` 是不带 TLS 的 websocket，`mws` 复用 smux。升级比较运行版本和磁盘 `--version`，替换 ELF 后 `re-exec`。`parallel` 仍不做                                              |
| 4    | 资金与计费缺测：支付回调短路、充值赠送、`renewUsersPlan`、`traffic × Σ rate`             | 已落地。`tests/unit/money-gaps.test.ts` 覆盖成功回调只入账一次、非 pending 为 409、EPay 查单失败为 502、活动赠送相加、续订扫描、流量乘入/出/链路倍率                                   |
| 5    | 明确不做                                                                                 | 见下                                                                                                                                                                                   |

阶段 1 本轮执行：

1. 负载策略别名。上游 agent 把 `rr`/`ha` 当作 `round`，`random` 当作 `rand`，`leastconn` 当作 `lc`，`leastlatency` 当作 `ll`；空值和未知值回落到 round-robin，而不是 fifo（`AGENT_SERVICE.md` §1）。`fifo` 这个名字本身保持「取第一个」。
2. `POST /admin/system/config/test-email` 缺省收件人是当前用户的 `email`（`084__src__routes__admin__system_config.ts:49-50`），不是空字符串。
3. 授权过期。`register` 用 `expired_at < Date`，ISO 字符串不会按时间比较；`tunnel.ts` 已经用 `new Date(expired_at)`。两处统一成按时间比较。不把 `tunnel.ts` 改回失效的字符串比较。

## 阶段 5：不做

- `@socket.io/admin-ui`，以及 `/queuedash` 上未鉴权的 `job.retry` / `queue.clean` / `scheduler.add`。队列只保留现在的只读状态。
- `relayx` 监听端的探测伪装（随机 UA、nginx 假页面、`Server` 头轮换）。重放拒绝与 fail-closed 上限已实现（`internal/relayx/replay.go`，map 结构，非上游 `window+1` 环）。
- MySQL `FLOAT` 的 4 字节舍入。副本数据源是 SQLite。
- Caddy 与上游发布的镜像仓库；本仓库用自己的 `docker.yml` 构建 backend/web/agent/license 四个镜像。真实 Cloudflare/华为云账号、内核 WireGuard/TUN 见 `docs/COVERAGE.md`。
- 上游 minisign 公钥。报告写明编译进 agent 但从未引用。
- `parallel` 负载策略。

## 阶段 6：本轮补的对齐与测试

| 项                                          | 结论                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 有 Redis 时的 cron                          | `initBullMQ()` 现在会起一个 `Worker`，按 job 名分派到 `jobs`；`shutdownBullMQ()` 关闭。没有 Redis 时走本地调度 |
| 分布式锁                                    | `REDIS_URL` 非空时用 `RedisLock`（SET NX PX + 只删自己的 token），否则仍是 `MemoryLock`                        |
| `/health/diag`、`/health/heap`              | 事件名枚举对没有 EventEmitter 的 in-memory Redis 容错，探针返回 200/500 而不是 500                             |
| 观察者 `node_id`                            | 按上游保持地址不带 `node_id`，因此默认不写按节点统计；带 query 时写入。两条都有测试                            |
| 心跳、充值创建、健康探针、锁、schema 块属性 | 见 `tests/unit/ops-gaps.test.ts`、`redis-lock.test.ts`、`schema-parity.test.ts`                                |

仍缺测试或仍为 stub：`vmess`/`h2`/`h3`/`obfs4`/`tun` 等未实现项；OpenVPN 无 TUN；“超管引导 / 封禁 / `x-impersonation`”没有断言；在线判定依赖的 10 秒 tick 本身未在测试中推进时钟。
