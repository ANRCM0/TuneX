# @relayx/license-server — 自建授权服务器（TypeScript 版）

面板（`apps/backend`）调用商业授权服务时的**服务端替代品**：签发 / 校验 / 换绑 / 吊销
License，记录订单历史，并实现面板用到的全部 6 个接口。

行为以 `relayx-analysis/relayx_license_server.py`（Python 参考实现）为准，
接口契约见 `relayx-analysis/LICENSE_SERVER_GUIDE.md`，逆向分析见
`relayx-analysis/LICENSE_ANALYSIS.md`。本包是**逐行为移植**，不是重新设计。

- 框架：Hono + `@hono/node-server`（与 `apps/backend` 同一套约定）
- 存储：Node 内置 `node:sqlite`（`DatabaseSync`），没有 Prisma schema
- 内容加密：`plain` / `base64` / `fernet` 三种模式，Fernet 与 Python 参考实现**字节级兼容**
- 端口默认 **3100**：仓库根 `.env` 里 `LICENSE_URL=http://127.0.0.1:3100`

## 快速开始

```bash
# 仓库根目录
pnpm install
pnpm --filter @relayx/license-server dev        # tsx watch，默认监听 http://127.0.0.1:3100

# 面板侧 .env 指向它（仓库根 .env 已经如此）
# LICENSE_URL=http://127.0.0.1:3100

# 签发一张业务授权（面板 SITE_URL 必须完全一致，否则面板会判定不匹配）
pnpm --filter @relayx/license-server exec tsx src/index.ts issue --site-url http://127.0.0.1:3000
```

面板会在 `/api/license` 处触发 `getLicenseFromServer()` → `GET /license?site_url=…`。
**客户端不做任何签名/加密校验**（`getLicenseFromServer()` 就是 `return response.data`），
因此服务端返回的 `content` 只需满足面板的“同站点 + 未过期”判断即可。

## 接口

所有响应都是 `application/json`（`Content-Type: application/json`）；错误统一为
`{"error": "<中文或英文消息>"}`。路径容忍尾斜杠（`/license/` 等价 `/license`）。

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `200 {"ok":true,"ts":"<UTC ISO>"}` |
| `GET` | `/license` | 查询 `site_url` | `200 LicenseContent` |
| `POST` | `/license` | JSON `{site_url,type?,cycle?,redirect_url?,pay_type?,payment_id?,client_ip?,coupon?}` | `200 {"url","trade_id","order_id","license","status":"success"}` |
| `PUT` | `/license` | JSON `{site_url,content}` | `200 {"ok":true,"site_url"}` |
| `GET` | `/license/history` | 查询 `site_url,page,limit`（`sort/status/order_id` 忽略） | `200 {"data":[Order…],"total":N}` |
| `GET` | `/pay` | — | `200 []` |
| `GET` | `/coupon` | 查询 `code,type,site_url,cycle` | **`404 {"error":"coupon not supported by self-hosted license server"}`** |

`LicenseContent`（面板 `apps/backend/src/services/license.ts` 的类型）：

```json
{
  "site_url": "http://127.0.0.1:3000",
  "type": "business",
  "expired_at": "2027-10-17T07:07:53.000Z",
  "created_at": "2026-10-17T07:07:53.000Z",
  "content": "<Fernet token, key2; plaintext is {v,type,site_url,expired_at,edition,iat}>"
}
```

错误分支与边界：

- `GET /license` 缺 `site_url` → `400 {"error":"site_url is required"}`；
  无授权 → `404 {"error":"license not found"}`。
- `GET /license/history` 缺 `site_url` 不报错，返回 `{"data":[],"total":0}`；
  `page` 下限 1，`limit` 夹在 `[1,200]`，默认 `1 / 10`。
- `POST /license`：`type` 默认 `business`，`cycle` 默认 `year`，
  `redirect_url` 默认 `/`；`cycle → days` 映射为
  `month:30, quarter:91, half_year:182, year:365, lifetime:36500`（未知 cycle 按 365）。
  同一站点重复 POST 是**续期**：更新 `type/expired_at`，不改变 `content`。
  换密钥或换 content 模式后要先 `revoke` 再 `issue`，否则旧的明文 `content` 会留下来。
- `PUT /license` 缺任一字段 → `400 {"error":"site_url and content are required"}`；
  `content` 不存在 → `404 {"error":"license content not found"}`。换绑按 `content` 定位，
  成功后旧域名查不到授权。
- 未匹配的路由 → `404 {"error":"not found"}`。

## 环境变量与优先级

优先级：**CLI 参数 > 环境变量 > 默认值**。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LICENSE_HOST` | `127.0.0.1` | 监听地址（容器内用 `0.0.0.0`） |
| `LICENSE_PORT` | `3100` | 监听端口（Python 参考默认 8899；本仓库 `.env` 用 3100） |
| `LICENSE_DB` | `license.db` | SQLite 文件路径 |
| `LICENSE_CONTENT_MODE` | `fernet` | `plain` \| `base64` \| `fernet`。默认 `fernet`，这样 agent 能解开 register ack 里的 `license` |
| `LICENSE_FERNET_SECRET` | agent key2（`ejNi…`） | 加密 `content` 的 Fernet key。不是面板的 `CONFIG_SECRET`（key1） |

## CLI

```bash
tsx src/index.ts [全局选项] <serve|issue|list|revoke|rebind> [子命令选项]
```

全局选项：`--db`、`--host`、`--port`、`--content-mode`、`--quiet`（放在子命令前后均可，
与 Python argparse 行为一致）。

| 子命令 | 说明 |
| --- | --- |
| `serve` | 启动 HTTP 服务（打印 `LICENSE_URL=…` 提示；SIGINT/SIGTERM 优雅退出） |
| `issue --site-url <URL> [--type business\|personal] [--days N]` | 签发/续期（默认 business、3650 天） |
| `list` | 列出全部授权（含已吊销，显示 status） |
| `revoke --site-url <URL>` | 吊销该站点所有 active 授权 |
| `rebind --content <content> --site-url <URL>` | 按 content 换绑到新域名 |

参数错误统一 `exit 2`（stderr `错误: …`）；`rebind` 未命中 `exit 1`。

## 测试

```bash
pnpm --filter @relayx/license-server typecheck
pnpm --filter @relayx/license-server test
```

`test/` 下的文件（`relayx/tests/**` 属于 verify 队友，本包测试放在包内）：

| 文件 | 覆盖内容 |
| --- | --- |
| `wire.test.ts` | 逐条移植 `relayx-analysis/verify_license_server.py` 的 **18 条 wire 断言**（自起临时服务） |
| `fernet.test.ts` | 与 Python 参考实现字节级一致的 token 向量、往返加解密、篡改/版本/密钥校验 |
| `app.test.ts` | 错误信封、默认值、5 种 cycle→days、history 夹取、PUT 400/404 |
| `store.test.ts` | 续期保留 content、单 active 行、rebind/revoke、订单分页、三种 content 模式 |
| `config.test.ts` | 默认值、环境变量覆盖、显式参数优先、非法模式/端口 |
| `cli.test.ts` | 真实子进程跑 `issue/list/rebind/revoke`、退出码、`serve` 定端口启动 + SIGINT |

## Docker

```bash
docker build -t relayx/license-server:selfhosted apps/license-server
docker run -d --name relayx-license-server -p 127.0.0.1:8899:8899 \
  -v license_data:/data relayx/license-server:selfhosted

# 或者
cd apps/license-server && docker compose up -d --build
```

容器内 `LICENSE_HOST=0.0.0.0`、`LICENSE_PORT=8899`、`LICENSE_DB=/data/license.db`；
数据卷 `/data` 持久化授权数据库。面板侧 `LICENSE_URL=http://<主机>:8899`。

## 与 Python 参考实现的差异

1. **默认端口 3100**（Python 为 8899）：对齐仓库根 `.env` 的 `LICENSE_URL`，避免面板默认配置连不上。
   需要 8899 时用 `--port 8899` 或 `LICENSE_PORT=8899`。
2. **存储用 `node:sqlite`**，DDL 与参考实现完全一致（可直接打开旧的 `license.db`）；没有引入 Prisma。
3. **配置走环境变量**（`LICENSE_*`），CLI 参数名与 Python 版一一对应（`--db/--host/--port/
   --content-mode/--quiet/--site-url/--type/--days/--content`）。
4. **Fernet 由 `node:crypto` 实现**：0x80 版本字节 + 8 字节时间戳 + 16 字节 IV +
   AES-128-CBC(PKCS#7) + HMAC-SHA256，输出 urlsafe-base64（带 padding）。
   注意 Node 的 `createCipheriv` 默认自带 PKCS#7，本实现显式关闭后手动填充，
   否则 token 会多出一个填充块、与 Python 不兼容（已用 Python `cryptography.Fernet` 生成的定值向量锁定）。
5. **订单号**：`crypto.randomBytes(8).toString("hex")`，等价于 Python `secrets.token_hex(8)`（16 位十六进制）。
6. **错误处理**：Python 在 `int(page)` 解析失败时抛 500；TS 版对非法 `page/limit` 回退到默认值，
   对非法 JSON / 非对象 body 当空对象处理（与“空 body”分支一致），其余错误消息逐字保持。
7. **请求日志**默认输出到 stderr（`--quiet` 关闭），与 Python 参考的 verbose 行为对应。
8. `GET /coupon` 恒为 404：自建版不接入支付渠道，与参考实现一致（面板会回退到“获取优惠码失败”）。
