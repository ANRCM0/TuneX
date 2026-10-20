# 复刻完成度：副本 vs 上游

生成于 2026-10-20（MySQL 目标与测试基础设施落地之后）。这是一份"还差什么"的总账，
不是营销页：每条缺口都带上游证据、副本现状和验证状态。逐条偏差的细节仍在
[DEVIATIONS.md](DEVIATIONS.md)，逐层测试映射在 [COVERAGE.md](COVERAGE.md)，路由/字段的
自动比对在 [PARITY.md](PARITY.md)。

图例：**已验证** = 有自动化断言或 CI 观测；**部分** = 代码完成但只在桩/替身上验证；
**未验证** = 需要本仓库没有的环境；**决定不做** = 明确取舍，见下。

## 1. 对比基准

| 上游证据 | 规模 |
| --- | --- |
| `relayx-analysis/work/modules/` 反编译模块 | 123 个（43 services、37 routes、9 socket-io、7 middlewares、7 utils、7 bullmq） |
| `relayx-analysis/work/api_map.json` | 160 次注册 / 157 个唯一 `METHOD path` |
| `relayx-analysis/work/prisma_schema.prisma` | 23 模型 / 18 枚举 / 297 字段 |
| `relayx-analysis/reports/` | 22 份行为报告（后端、资金、网络、身份、Socket 协议、部署面） |
| `relayx-analysis/agent`、`relayx-web` | 上游 agent 二进制的协议面；web 镜像的 43 个路由 |

副本规模：后端 107 文件 / 20.4k 行；web 147 文件 / 16.7k 行 / 43 路由；agent 152 个 Go
文件 / 29.7k 行 / 33 个包；license server 8 文件。

## 2. 契约层：0 缺口（自动比对，不是目测）

| 维度 | 结果 | 依据 |
| --- | --- | --- |
| 路由 | 157/157 上游 `METHOD path` 全部存在；多出 6 个已解释的挂载 | `tests/unit/route-table.test.ts` |
| 守卫链 | `app.use(...)` 与上游逐条一致；160 条推导链 153 条完全一致，7 条仅 `api_map` 标注错误 | `route-guards.test.ts` |
| 校验器 | `json` 62 / `query` 61 / `param` 47，逐路由相同 | `route-validators.test.ts` |
| OpenAPI | `describeRoute` 158/160（两个 `router.on` 回调路由与上游一样没有）；摘要、状态码、响应描述全部一致 | `route-docs.test.ts` |
| 数据模型 | 23 模型 / 18 枚举 / 297 字段，0 差异 | `schema-parity.test.ts` |
| 迁移 | SQLite baseline 无 drift；MySQL 变体由生成器派生并在真实 `mysql:8.0` 上应用 | `migrations.test.ts`、`mysql.yml` |

每个 suite 都做过变异验证（改一处 wiring/状态码/`.nullable()` 必挂），所以这些"0 差异"
是可维护的，不是一次性快照。

## 3. 按层记分卡

| 层 | 状态 | 依据 | 残余 |
| --- | --- | --- | --- |
| 后端 HTTP 契约 | 已验证 | 上表 | 无 |
| 数据模型 | 已验证 | 297 字段 0 差异 | 无 |
| 资金/计费 | 已验证（外部网关为桩） | 价格规则、回调幂等、返佣、续订、提现、优惠券；一次实跑账目核对 | 真实支付网关 |
| 控制面（socket/cron/queue） | 部分 | 注册/封禁/`listen_error`/本地 cron/锁都有测试 | 真 Redis/BullMQ 未在 CI 跑（下一项） |
| Agent 协议 | 已验证（面板可达部分） | 上游注册的 10 个 handler / 15 个 listener 全部实现；不认识的名称报 `not implemented`，上游 gost 同样拒绝 | REALITY 证书校验、mieru UDP、伪装层 |
| Web 控制台 | 部分 | 43 路由；RBAC/分享链接/部署命令/i18n/路由清单有测试；E2E 走通登录链路 | 无 DOM 测试；交互页靠手工 smoke |
| License server | 已验证（本地替代） | 6 文件 / 44 测试；与 Python `cryptography.Fernet` 字节级兼容 | 不是上游托管服务的行为 |
| 部署/运维 | 部分 | MySQL 目标已端到端（含 560 测试在 MySQL 上并行跑）；CI/MySQL 绿 | 无真 Redis；web 镜像刚修；无内核 TUN |

## 4. 未完成清单

### 4.1 验证环境缺口（代码已写，缺环境）

| # | 缺口 | 上游证据 | 现状 / 影响 |
| --- | --- | --- | --- |
| V1 | CI 没有真实 Redis/BullMQ | `middlewares/rate_limit.ts` 用 Redis 计数；`services/redis.ts` 支持 ioredis | 限流窗口、`RedisLock`、`/queuedash` 的 scheduler 列表、BullMQ Worker 只在进程内替身上验证。**下一步就做这个** |
| V2 | 没有浏览器/DOM 测试 | web 43 路由，交互密集 | 日历筛选、移动端 bottom sheet、链路编辑器、landing canvas 只有 `docs/VERIFY.md` 的手工 smoke |
| V3 | 真实第三方账号 | Cloudflare/Huawei DNS、Telegram、SMTP/Resend | 客户端与消息渲染有 mock/loopback 测试；真实账号一次也没打过 |
| V4 | 内核 WireGuard / OpenVPN TUN | `listener.type=wireguard`、`openvpn` | 用户态路径有测试；容器无 `CAP_NET_ADMIN`，官方 OpenVPN 2.6 客户端停在 `TUNSETIFF` |
| V5 | web 镜像构建 | 上游 `relayx/web:latest` | `apps/web/Dockerfile` 里的 `COPY apps/web/public` 指向不存在的目录，`Docker images` 的 `web` job 一直红。**本次提交补了 `apps/web/public`，需 master 上的一次 `Docker images` 运行确认** |
| V6 | StackAuth 托管会话 | 上游用 StackAuth | 副本默认 `AUTH_MODE=local`（自签 HS256 + 本地口令），`/handler/[...stack]` 是本地实现；`AUTH_MODE=stack` 保留但无项目可测 |
| V7 | MySQL 池的残留 | 无（副本设施） | 本地 intentionally 保留 `relayx_t_*` 供复用；`sweep` 才清。`SIGKILL` 后锁靠 pid 检测/宽限期回收 |

### 4.2 行为差异（已记录在 DEVIATIONS，仍算"未完全复刻"）

| # | 缺口 | 上游证据 | 现状 / 影响 |
| --- | --- | --- | --- |
| B1 | REALITY 证书未做 HMAC-SHA512 校验 | 上游 REALITY 认证 | 副本 `InsecureSkipVerify`，会接受任意 REALITY 证书；`xtls-rprx-vision` 去掉 padding 但无 splice |
| B2 | mieru 只做 TCP CONNECT | `internal/mierux` | UDP associate 被拒绝 |
| B3 | `relayx` 监听端没有伪装层 | 上游随机 UA / nginx 假页面 / `Server` 头轮换 | dialer 有 uTLS HelloChrome；listener 只做自签 TLS + websocket。重放缓存已实现（map + fail-closed 上限，非上游 `window+1` 环） |
| B4 | `parallel` 负载策略 | `gostcfg/balance.go` | 映射为 round-robin；`docs/AGENT.md` 已注明 |
| B5 | OpenVPN 没有 TUN | `internal/openvpn` | 控制通道、`PUSH_REPLY`、`P_DATA_V2` 都能走；内层 IP 用 UDP/TCP socket 转发，不做内核接口 |
| B6 | 上游镜像/Caddy 部署层 | compose + Caddyfile | 副本只构建自己的四个镜像（`docker.yml`），不复刻发布仓库与反向代理配置 |

### 4.3 测试缺口（行为已实现，断言缺）

| # | 缺口 | 现状 |
| --- | --- | --- |
| T1 | 心跳 10 秒 tick 没有推进时钟 | `REPLICATION.md` 已记；在线判定依赖这个 tick |
| T2 | 超管引导、封禁、`x-impersonation` 没有断言 | 代码存在，只有手工 curl |
| T3 | MySQL 池的并发争用只在单进程内测过 | `mysql-pool.test.ts` 用同 pid 模拟；真并发由 CI 的 vitest 并行间接覆盖 |

### 4.4 决定不做（不是缺口）

- `vmess`、`h2`、`h3`/`http3`、`obfs4`、`tun`、`tun2socks`、`vless-xtls`、`reality` 非 vless
  handler：**面板不可达**。上游 agent 只注册 10 个 handler、15 个 listener，副本对其它名字
  报 `not implemented`，上游 gost 的注册表同样会拒绝。
- `@socket.io/admin-ui`、`/queuedash` 的写操作（retry/clean/scheduler.add）。
- 上游 minisign 公钥与签名校验：上游编译进去且用了全零选项，等于没校验；副本自更新直接
  替换 + `re-exec`（`internal/panel/upgrade.go`）。
- MySQL `FLOAT` 的 4 字节舍入：副本默认数据源是 SQLite；MySQL 变体保留 `DOUBLE`。

## 5. 结论

- **以"契约 + 面板可达路径"为分母：功能复刻已完成**，路由、字段、守卫、校验器、文档五类
  自动比对都是 0 差异；560 个 vitest、44 个 license 测试、33 个 Go 包测试和一条真实 E2E
  在 CI 上绿。
- **以"任何环境下都能端到端证明"为分母：还差 5 项**——真 Redis（V1）、浏览器测试（V2）、
  第三方账号（V3）、内核 TUN（V4，受环境限制）、web 镜像的 master 验证（V5，已修）。
- **行为上有 6 处已知差异**（B1–B6），其中 B1 是安全相关的（REALITY 证书不校验），建议在
  Redis 之后优先处理。

## 6. 建议顺序

1. **V1 真 Redis in CI**（已约定）：限流、`RedisLock`、BullMQ、`/queuedash`。
2. **B1 REALITY 证书 HMAC 校验**：行为差异里唯一有安全含义的一项。
3. **V5 观察 `Docker images`**：master 上确认 web 镜像转绿；再考虑 compose 端到端。
4. **V2 Playwright**：先覆盖 4 个交互密集页面。
5. **T1/T2 断言**：心跳 tick 与超管/封禁/impersonation。
6. **V3/V4**：有账号/特权容器时再补，不阻塞主线。

## 7. 复现方式

```bash
pnpm -r typecheck && pnpm lint
npx vitest run                     # 62 files / 560 tests
bash scripts/verify.sh             # typecheck + unit + license + go vet/test + agent build
bash scripts/e2e-local.sh          # license → config → TCP → observer → traffic → OpenAPI → web
DATABASE_URL=mysql://… pnpm test:mysql   # 同一套测试跑在 MySQL 上
```

CI：`.github/workflows/ci.yml`（绿）、`mysql.yml`（绿）、`docker.yml`（`web` job 红，见 V5）。
