# 部署指南

从零部署一套 TuneX：面板（backend）、自建授权服务器（license）、Redis、反向代理，以及节点上的 agent。

镜像由 `.github/workflows/docker.yml` 构建并发布到 GHCR：

| 镜像                                   | 用途                         |
| -------------------------------------- | ---------------------------- |
| `ghcr.io/<owner>/tunex-backend`        | 面板与 HTTP/Socket.IO 控制面 |
| `ghcr.io/<owner>/tunex-license-server` | 自建授权服务器               |
| `ghcr.io/<owner>/tunex-node-agent`     | 节点 agent                   |

推 `master` 出 `dev` 标签，推 `v*` 出正式版本。本文命令里的 `${TUNEX_TAG}` 默认 `latest`，生产建议钉死版本号，例如 `TUNEX_TAG=0.0.1`。

---

## 1. 架构与前置条件

```
浏览器 / agent ── HTTPS ── Caddy ── backend:3000 ── Redis
                                        │
                                        └── license:8899（仅内网）
```

需要：

- 一台能跑 Docker 与 Compose v2 的主机；
- 一个指向该主机的域名（TLS 由 Caddy 自动申请）；
- 放行 80/443；**不要**把 3000 或 8899 暴露到公网。

首次部署前先确认 GHCR 上的镜像可见性：公共仓库的包默认是私有的，私有包需要在 GitHub Packages 里授权拉取。

## 2. 准备配置

```bash
git clone https://github.com/ANRCM0/TuneX.git
cd TuneX
cp .env.example .env
```

编辑 `.env`，至少改这四项：

| 变量               | 说明                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`         | 面板对外的 HTTPS 地址，例如 `https://panel.example.com`。**必须**与后面签发授权时的 `--site-url` 完全一致（协议、主机名、端口、结尾斜杠都不能差） |
| `CONFIG_SECRET`    | 必填。生成：`node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'`。生产缺少它时 backend 会拒绝启动                     |
| `SEED_ADMIN_EMAIL` | 管理员邮箱                                                                                                                                        |
| `TUNEX_DOMAIN`     | Caddy 使用的域名，通常与 `SITE_URL` 的主机名相同                                                                                                  |

`CONFIG_SECRET` 同时要传给每个 agent 的 `--config-secret`，否则 agent 解不开面板下发的配置。

## 3. 启动 backend、license、Redis

```bash
docker compose up -d license redis backend
docker compose ps          # backend 应为 healthy
```

backend 启动时会自动执行 `prisma db push`（`DB_PUSH_ON_START=0` 可关闭）。数据库是 `/data/relayx.db`，落在 `backend_data` 卷上。

## 4. 初始化管理员

```bash
docker compose run --rm backend pnpm --filter @relayx/backend seed
```

输出形如：

```
seeded super admin: admin@example.com
api_key: 0a1b2c3d-...
[seed] this key was generated now and will not be shown again; store it securely
```

这个 `api_key` 就是管理员 API 凭据（`Authorization: Bearer <key>`）。把它存进密码管理器，不要留在终端历史里。

- 再次运行 seed 不会覆盖已有管理员的 key；
- 需要轮换时：`SEED_ADMIN_ROTATE_KEY=1 docker compose run --rm backend pnpm --filter @relayx/backend seed`；
- 想固定 key：先设 `SEED_ADMIN_API_KEY` 再 seed。

## 5. 自建授权服务器

面板默认 `LICENSE_URL=http://license:8899`（见 `docker-compose.yml`），由同栈的 `license` 服务提供。它是仓库里的 `apps/license-server`，数据存在 `license_data` 卷的 `license.db`。

### 5.1 签发授权

`docker compose run` 会整条替换容器命令，所以要把入口写全：

```bash
docker compose run --rm license \
  node --import tsx src/index.ts issue \
  --site-url https://panel.example.com \
  --type business \
  --days 3650
```

- `--type business` 解锁商业功能；`personal` 只用于非商业场景。
- `--days` 默认 3650（约 10 年）。
- 输出是一段 JSON（`site_url`、`type`、`expired_at`、`content`），命令末尾还会提示刷新方式。

生成的 `content` 默认用上游 key2 做 Fernet 加密（`LICENSE_CONTENT_MODE=fernet`），agent 用同一把 key 解密。**不要**改成 `plain`，除非你在调试且清楚后果。

### 5.2 让面板立即生效

面板会把授权缓存在 Redis 的 `license` 键里。签发或吊销后清掉缓存：

```bash
docker compose exec redis redis-cli DEL license
curl -s https://panel.example.com/api/license
```

返回里 `type` 应为 `business`、`expired_at` 应为预期日期。也可以在面板后台的 License 页面点刷新。

### 5.3 查看、吊销、换绑

```bash
# 列出全部授权
docker compose run --rm license node --import tsx src/index.ts list

# 吊销（按站点）
docker compose run --rm license node --import tsx src/index.ts revoke \
  --site-url https://panel.example.com
docker compose exec redis redis-cli DEL license

# 换绑到新域名（用 5.1 输出里的 content）
docker compose run --rm license node --import tsx src/index.ts rebind \
  --content '<CONTENT>' --site-url https://new.example.com
```

换域名时同时改 `.env` 的 `SITE_URL` 并重启 backend，否则面板仍用旧地址校验。

### 5.4 不使用授权服务器会怎样

`businessLicenseRequired` 沿用上游语义：**取不到授权时放行**（fail-open），只有明确取到非 business 授权才返回 403。所以不部署 license 服务也能跑，但那是无授权状态；对外运营前应完成 5.1。

## 6. 反向代理与 TLS

```bash
docker compose --profile proxy up -d caddy
```

Caddy 读取仓库根目录的 `Caddyfile`，用 `TUNEX_DOMAIN` 申请证书并反代到 `backend:3000`，WebSocket 自动透传。

不用 Caddy 时，任何反代都可以，注意三点：

1. 透传 `Host` 与 `X-Forwarded-For`（面板用它记录登录 IP 和节点地址）；
2. 放行 WebSocket 升级（Socket.IO 走 `/socket.io/`）；
3. 面板对外的自指 URL 带 `/api` 前缀，backend 会自行剥掉一层，不需要在反代里重写。

## 7. 部署一个节点 agent

先在面板里创建节点组，拿到组 token。然后：

```bash
docker run -d --name tunex-agent --restart unless-stopped \
  --network host \
  ghcr.io/anrcm0/tunex-node-agent:${TUNEX_TAG} \
  -s https://panel.example.com \
  -t <节点组 token> \
  -n node-1 \
  --config-secret '<CONFIG_SECRET>'
```

- 只有转发 TCP/UDP 的节点不需要额外权限；WireGuard/OpenVPN 需要 `NET_ADMIN`、`/dev/net/tun` 和宿主机内核模块。
- 节点端口（例如 18080）要在主机和防火墙上放行。
- 升级：拉新镜像后重启容器；带 `--auto-update` 时 agent 会按面板指令自升级。

## 8. 验证

```bash
curl -s https://panel.example.com/health          # {"status":"ok",...}
curl -s https://panel.example.com/api/license     # type=business
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
     https://panel.example.com/api/admin/system/config | head -c 200
```

再建一条隧道，用 `nc -l` 或任意 echo 服务验证转发；面板的隧道列表会显示 `listen_port`，流量记在 `traffic` 上。

## 9. 备份与恢复

需要备份的两份数据：

| 数据        | 位置                                               |
| ----------- | -------------------------------------------------- |
| 面板 SQLite | 卷 `tunex_backend_data` 里的 `relayx.db`           |
| 授权 SQLite | 卷 `tunex_license_data` 里的 `license.db`          |
| Redis       | 可选。AOF 已开启，丢了只影响缓存与队列，不影响账目 |

SQLite 不能直接热拷贝。用它的在线备份命令：

```bash
# 用临时容器挂载卷，在写入的同时做一致性备份
docker run --rm -v tunex_backend_data:/data -v "$PWD":/backup alpine \
  sh -c 'apk add -q sqlite && sqlite3 /data/relayx.db ".backup /backup/relayx-$(date +%F).db"'
docker run --rm -v tunex_license_data:/data -v "$PWD":/backup alpine \
  sh -c 'apk add -q sqlite && sqlite3 /data/license.db ".backup /backup/license-$(date +%F).db"'
```

恢复：停 backend，把备份文件放回卷里的 `relayx.db`，再启动。跨大版本恢复前先确认 schema（backend 启动会 `db push`，不会删列，但也不会回滚结构）。

## 10. 升级与回滚

```bash
# 升级到新版本
sed -i 's/^TUNEX_TAG=.*/TUNEX_TAG=0.0.2/' .env
docker compose pull backend license
docker compose up -d backend license

# 回滚
sed -i 's/^TUNEX_TAG=.*/TUNEX_TAG=0.0.1/' .env
docker compose pull backend license && docker compose up -d backend license
```

跨越包含 schema 变更的版本时，先按第 9 节备份。agent 与面板的版本不必完全一致，但大版本升级后建议一起滚动。

## 11. 安全清单

- [ ] `CONFIG_SECRET` 已替换为随机值，且没有提交进仓库；
- [ ] 管理员 API key 已保存，默认 `admin@relayx.local` 没有对外使用；
- [ ] `SITE_URL` 与授权里的 `site_url` 一致，授权为 `business`；
- [ ] 3000/8899 只监听内网或回环，公网只有 80/443；
- [ ] Caddy（或你的反代）已启用 HSTS，并按需限制管理端来源；
- [ ] 面板没有内置限流，登录与支付回调需要在反代/WAF 上做速率限制；
- [ ] 定期备份两个 SQLite 文件，并演练一次恢复；
- [ ] `DIAG_TOKEN` 若不使用请留空，`/health/diag` 与 `/health/heap` 会返回 404。

## 12. 常见问题

| 现象                                                   | 处理                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| backend 启动即退出，日志含 `CONFIG_SECRET is required` | 在 `.env` 里设置 `CONFIG_SECRET`                              |
| agent 报 `License loaded` 但配置解不开                 | agent 的 `--config-secret` 与面板不一致                       |
| 面板显示无授权，节点注册被拒                           | 检查 `LICENSE_URL` 是否可达；签发后是否 `DEL license`         |
| `/api/license` 返回 404 且 `site_url` 不符             | 授权绑定的域名与 `SITE_URL` 不一致，用 `rebind`               |
| 隧道一直 `WAIT_LISTEN`                                 | 节点端口未放行、agent 未连上，或配置推送失败（看 agent 日志） |
| 公网拉镜像 403                                         | GHCR 包可见性仍是私有，改成 public 或 `docker login`          |
