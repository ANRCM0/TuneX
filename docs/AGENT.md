# RelayX agent

Clean-room Go agent (`github.com/relayx/agent`) that speaks the same Socket.IO control plane as the upstream `relayx-agent` binary. It is not a disassembly of that binary. Upstream is a stripped ~38 MB ELF built with go1.26.1 and ~49k recovered symbols; this tree is a small stdlib-plus-websocket implementation (go 1.27).

## Build

From the repo root:

```bash
pnpm agent:build
# equivalent:
#   cd apps/agent && go build -o ../../dist/relayx-agent ./cmd/relayx-agent
```

`GOCACHE` / `GOPATH` must be writable. On this machine `/root/.cache/go-build` is not, so:

```bash
export GOCACHE=/workspace/111/.gocache GOPATH=/workspace/111/.gopath
pnpm agent:build
go -C apps/agent vet ./...
./dist/relayx-agent --version   # relayx-agent version 0.13.23
```

Verified 2026-10-17: `pnpm agent:build` exit 0 (12 MB `dist/relayx-agent`), `go vet ./...` exit 0.

Module deps (gost, mieru, and gopsutil are not imported):

- `github.com/gorilla/websocket v1.5.3`
- `github.com/quic-go/quic-go v0.60.0`
- `github.com/refraction-networking/utls v1.8.2`
- `github.com/xtaci/smux v1.5.35`
- `github.com/enfein/mieru/v3 v3.36.0`
- `github.com/xtls/reality v0.0.0-20261014101318-83f621788ca8`
- `golang.org/x/crypto v0.58.0`

## Configure and run

Flags (`relayx-agent --help`):

| Flag | Meaning |
| --- | --- |
| `-t, --token` | Node-group token (required) |
| `-s, --server` | Panel origin, e.g. `http://127.0.0.1:3000` (required) |
| `-n, --node-id` | Node id (default hostname) |
| `-i, --connect-ip` | Public IP(s) to advertise (repeatable; default auto-detect) |
| `-c, --config` | Config file. Default search includes `$HOME/.relayx-agent/config.*`. Keys are kebab-case flag names |
| `--config-secret` | Panel Fernet key (default upstream key1) |
| `--license-secret` | License Fernet key (default upstream key2) |
| `--port-range` | Candidate ports for `WAIT_LISTEN`, e.g. `80,443,30000-30010` |
| `--tcp-port` … `--quic-port` | Advertised out-listen ports |
| `--pprof-port` | pprof on `127.0.0.1` only (`0` disables) |
| `-d, --debug` | Debug logs |
| `-v, --version` | Print `0.13.23` |

Example:

```bash
./dist/relayx-agent \
  --server http://127.0.0.1:3000 \
  --token <node-group-token> \
  --connect-ip 127.0.0.1 \
  --config-secret "$CONFIG_SECRET"
```

A single-instance lock file `relayx-agent.lock` is taken in the working directory.

## Protocol

One Socket.IO (engine.io v4) websocket to the panel. Handshake `auth.token` is the node-group token (`apps/backend/src/socket-io/index.ts` rejects a missing token with `Unauthorized`).

Events the agent handles (`internal/panel/panel.go`):

- emit `register` (ack, 30s) then wait for the license payload
- `config` — Fernet-decrypt the pushed gost document and apply services
- `sysinfo` every 10s (CPU, memory, load, net, uptime from `/proc`, not gopsutil)
- `listen` / `listen_error`
- `ping`, `test` (ICMP, TCP fallback), `upgrade` (download + ELF check)

## Implemented vs stubbed

| Area | Status |
| --- | --- |
| CLI flags, config file, version, pprof, flock | Implemented |
| Engine.io / Socket.IO client, register, config, sysinfo, listen, ping, test | Implemented |
| Fernet (config + license keys) | Implemented |
| TCP forward (`tcp`/`ws` with a target, and `tls`/`wss`/`mwss`/`mtls` when the handler is not `relay`) | Implemented as plain TCP forward (no TLS/WS termination). `handler.metadata.proxyProtocol` `1` requires a HAProxy PROXY v1 header and strips it before the bytes are copied. The same header is required on an `http`, `socks5`, or Shadowsocks TCP entrance. `block.protocol` closes http, tls, ssh, socks4, socks5, or bittorrent (`bt` / `https` are aliases) before the target is dialed. Without `sniffing.fallback` an unrecognized prefix is closed too; VLESS sets that flag, so only a named blocked protocol is dropped there. A service `admission` (IP or CIDR, whitelist or blacklist) is enforced on this listener, on plain UDP forward, and on Shadowsocks TCP/UDP, SOCKS5 TCP/UDP, the UDP ssu hop, VLESS, mieru, and OpenVPN. A service `bypass` (IP, CIDR, domain, `.suffix`, or `*`) refuses the destination before dial on those same entrances, including an OpenVPN data packet's inner IPv4 destination: a blacklist skips listed targets, a whitelist skips everything else. A climiter `$ N` and metadata `maxClients` cap concurrent connections on plain TCP, SOCKS5, Shadowsocks TCP, and VLESS. A limiter `$ 1MB 1MB` delays those bytes to the first size per second (1024-based). A UDP session counts as one connection until it is idle or closed, and its payload waits on the same rate. A forwarder with more than one node is chosen per connection by `selector.strategy`: `round` (metadata `weight` repeats the address, capped at 64), `rand`, `hash` (the request host when a hop has one, otherwise the client IP), `lc` (fewest open connections), `fifo` (the first). `ll` tries an address that has not been dialled yet, then the one with the lowest observed dial time (a failed dial counts as 30s; weight is ignored). A node marked `backup` is used only when every node is a backup. `filter.host` narrows a hop first (exact or `*.suffix`); the strategy then runs on the matches, and `fifo` stays on the first match. A plain TCP forward reaches its forwarder through a `socks5`, `http`, or `ss` hop, not only `relay`. Several hops are dialed in order, so a relay exit can sit in front of a SOCKS5 forwarder. A listen protocol of type `http` is an HTTP proxy: CONNECT opens a tunnel, and an absolute-form request such as `GET http://host/path` is forwarded to the origin (optional Basic `Proxy-Authorization`). Its byte counts are posted to the panel observer. A TCP or UDP entrance that reaches the target through a relay, SOCKS5, HTTP, or Shadowsocks hop posts the same counts. A plain UDP forward with a `socks5` hop uses UDP ASSOCIATE. A `ss` hop on UDP is packed like `ssu`, using the connector's cipher and password. A relay chain does the same per accepted connection: each hop's `selector.strategy` picks the node, and the forwarder address is chosen the same way. SOCKS CONNECT, VLESS and mieru use that picker too; the request address is the target, so the forwarder list is not used. A hop node with `filter.host` (exact or `*.suffix`) is used only when the target host matches; if none match, nodes without a filter are used. A plain TCP or UDP forward has no request host, so a forwarder node with `filter.host` is skipped while any node without one remains. A forwarder hop whose connector is `socks5`, `ss` (cipher in the username, secret in the password), or `http` (HTTP CONNECT, optional basic auth) is dialed as that protocol; the target is the next hop or the request address. QUIC, TLS, WSS and `relayx` are dialed by that same relay path when they are the hop. A UDP `ssu` hop is chosen per client session the same way. TCP and UDP forwards report gost observer stats |
| HTTP observer (`observers[].plugin.type=http`) | Implemented. On `observer.period` (default 30s) the agent POSTs `{events:[{kind:service,type:stats,stats}]}` to the plugin address. `observer.resetTraffic` zeroes the counters after each post, because the panel increments traffic by those bytes. Counted listeners: plain TCP/UDP forward, VLESS, mieru, Shadowsocks TCP and UDP, SOCKS5 CONNECT and UDP, gost relay CONNECT, remote TCP (`rtcp`), and WireGuard (`wg show transfer`, reported as a delta). OpenVPN counts decrypted `P_DATA_V2` payloads |
| UDP forward | Implemented. The same `admission` list as TCP drops a datagram before a session is opened |
| Shadowsocks TCP (`ss` + `tcp`/`tls`/`mtls`): chacha20-ietf-poly1305, aes-128-gcm, aes-256-gcm | Implemented. `block.protocol` drops a connection whose first plaintext after the SOCKS address is a blocked protocol, before the target is dialled |
| Shadowsocks UDP (`ssu`) | Implemented. A cipher in `auth.username` is SIP004 (salt + AEAD of SOCKS address and payload). No cipher is method `none` (16-byte salt, then the plaintext), which is the panel's UDP out-node hop. `block.protocol` drops a datagram whose payload matches; without `sniffing.fallback` an unrecognized payload is dropped too. The out-node service does not set that flag. A plain `udp` listener whose first connector is `ssu` packs each datagram toward the forwarder and sends it to that hop. A listener with `keepalive: true` expires an idle UDP session after 5s, which is gost's default TTL (`ttl` or `keepalive.ttl` overrides it). Plain UDP, SOCKS5 UDP, and Shadowsocks UDP all use that lifetime |
| SOCKS5 (`handler.type=socks5`) | Implemented: RFC 1928 CONNECT and UDP ASSOCIATE (when `metadata.udp` is absent or true), RFC 1929 when `auth` is set. BIND is rejected. The destination is the address in the request, not the forwarder. `block.protocol` drops a CONNECT whose first payload is a blocked protocol. A UDP listener with handler `socks5` accepts RFC 1928 UDP datagrams directly |
| gost relay CONNECT (`handler.type=relay`, and a tcp forward whose first hop connector is `relay`) | Implemented: go-gost/relay v0.5 framing. The entrance dials the hop and the CONNECT address feature carries the next hop or the forwarder target. `handler.chain` is honoured (the panel does not put `chain` on the service). Auth is the connector's username/password. UDP is rejected. A hop marked `backup` is skipped when a primary exists. On an exit `relay` listener, `block.protocol` closes a CONNECT whose first payload is a blocked protocol |
| gost relay BIND / remote TCP (`handler.metadata.bind=true` on the entrance, `listener.type=rtcp` with `listener.chain` on the exit) | Implemented: CmdBind plus smux v1. The entrance binds the requested address and is the smux client; the exit is the smux server and dials a forwarder node for each accepted public connection, using `selector.strategy` when there is more than one. A climiter and limiter on the exit cap those streams and the UDP peers, and pace both directions |
| gost relay UDP BIND / remote UDP (`listener.type=rudp`) | Implemented: `CmdBind\|FUDP` (0x82) plus network feature UDP. After the bound-address reply, datagrams are SOCKS5 UDP frames (reserved = payload length, fragment = 0xff). Each public peer gets its own socket to a forwarder node chosen by `selector.strategy`. The panel emits this service for every remote port-forward, including TCP tunnels, and dials the entrance's relay handler |
| `relayx` listener / dialer | Implemented for replica-to-replica: HKDF-SHA256(`relayx-auth-v1`) bearer token, websocket upgrade, one mux-signal message, then smux v1 carrying gost-relay CONNECT. An empty listener path accepts any path (the panel only sends `key`). The dialer sends a uTLS HelloChrome_Auto ClientHello and skips certificate verification; the listener uses a self-signed cert. Later connections to the same address, key, host and path open another smux stream on the cached session |
| QUIC (`listener.type=quic`, `dialer.type=quic`, handler `relay`) | Implemented: QUIC v1/v2, ALPN `h3` and `quic/v1`, one stream per relay connection, session reused per address. The listener mints a self-signed cert from `tls.commonName`. The dialer sets SNI to that name and skips verification, because the panel does not ship the key |
| TLS / mTLS (`listener.type=tls` or `mtls`, dialer the same, handler `relay`) | Implemented. `tls` is one relay CONNECT per TLS session. `mtls` is smux v1 over that session, reused per address. Same self-signed cert and skipped verification as QUIC |
| WSS / MWSS (`listener.type=wss` or `mwss`, dialer the same, handler `relay`) | Implemented. TLS then a websocket upgrade on gost's default path `/ws` (overridden by metadata `path`). `wss` is one relay CONNECT per websocket. `mwss` is smux v1 over that websocket, reused per address |
| MTCP (`listener.type=mtcp`, `dialer.type=mtcp`, handler `relay`) | Implemented. smux v1 over plain TCP, session reused per address. This is `mtls` without TLS |
| VLESS + REALITY (`handler.type=vless`, `listener.type=reality`) | Implemented. uTLS HelloChrome_Auto seals the session id (X25519MLKEM768, HKDF-SHA256 info `REALITY`). Short id is 8 hex chars, padded to 8 bytes. Users come from `handler.metadata.users`. The request address is dialled directly. `xtls-rprx-vision` padding is stripped on the way in and applied on the first reply; there is no splice. Command 2 is UDP: uint16-BE datagrams to the header address. `block.protocol` drops a TCP request whose first payload is a blocked protocol. The server sets `SessionTicketsDisabled` so it does not emit a real ticket larger than dest's; dest's ticket is still mimicked as an empty application-data record. Cert check is `InsecureSkipVerify` (the HMAC-SHA512 reality certificate check is not done) |
| mieru (`handler.type=mieru`, `listener.type=mieru`) | Implemented with `github.com/enfein/mieru/v3 v3.36.0` (the module the upstream agent links). Users are `listener.metadata.users`. Protocol defaults to TCP. The library binds the port on all interfaces. CONNECT is proxied; UDP associate is rejected. Private and loopback targets are allowed. `block.protocol` drops a CONNECT whose first payload is blocked; the panel sets `sniffing.fallback`, so an unrecognized prefix is still proxied. A climiter and limiter on the service cap the connection and pace both directions |
| WireGuard | Kernel path uses `wg` / `ip` when the module is loaded. Otherwise `golang.zx2c4.com/wireguard` runs in userspace with no TUN: decrypted IPv4 is forwarded like OpenVPN (UDP dial, ICMP echo to the interface address, small TCP NAT). That path also applies `bypass`, `block.protocol`, and the panel connection cap (one inner IPv4 source counts as one connection; the bandwidth limit waits on each decrypted packet). `TestUserspaceUDP` exchanged `pong:via-wg` between two in-process devices |
| OpenVPN (`listener=openvpn`, handler `tungo`) | TCP control channel through key method 2. `PUSH_REPLY` assigns a peer id, ifconfig, the listener cipher (`AES-256-GCM` by default, also `AES-128-GCM`), and `tun-mtu` when the listener sets one. The official OpenVPN 2.6 client accepts that reply; this host has no `CAP_NET_ADMIN`, so it stops at `TUNSETIFF`. UDP is the same control channel with one datagram per packet (`metadata.udp`). The official 2.6 client was checked on UDP and stops at the same `TUNSETIFF`. An inner IPv4 UDP datagram is dialed, an ICMP echo to the tunnel gateway (`10.8.0.1` by default) is answered, and an inner IPv4 TCP SYN is dialed. Later payloads are written to that connection, and bytes the peer sends later are sealed back without waiting for the next client packet. `block.protocol` drops an inner TCP or UDP payload that matches; an empty SYN is never dropped, and `sniffing.fallback` keeps an unrecognized payload. A climiter and limiter cap the session and pace the decrypted packets. No TUN device is created here |
| Unknown handler/listener names (h2/h3/http3, obfs4, vmess, tun, tun2socks, reality without vless) | Reported as `listen_error` with `not implemented in replica` (`internal/service/manager.go` `isStub`). **These are not reachable from the panel**: the upstream binary registers exactly 10 gost handlers (`tcp`, `rtcp`, `http`, `relay`, `socks5`, `ss`, `ssu`, `tungo`, `mieru`, `vless`) and 15 listeners (`mieru`, `mtcp`, `mtls`, `mws`, `openvpn`, `quic`, `reality`, `relayx`, `rtcp`, `rudp`, `tcp`, `tls`, `udp`, `wireguard`, `ws`) — see `relayx-analysis/reports/AGENT_SERVICE.md` §3.1/§3.2. A config naming any other handler fails in upstream gost's registry lookup too; the replica keeps that guard but reports a clear stub error instead of an unknown-registry crash. |
| Self-update download | Partial: downloads and checks ELF; does not replace the running binary the way `minio/selfupdate` does |
| Full gost chain, mieru, gopsutil | Not vendored |

Live register (2026-10-17, after the license reissue): the same command logged `License loaded successfully`, `panel: license accepted (125 bytes, site_url="http://127.0.0.1:3000")`, then `panel: config received (fernet)` and `panel: config applied`. The license server now issues `content` as a Fernet token under the agent key2 (`ejNi…`), and the plaintext is `{v, type, site_url, expired_at, edition, iat}` with `expired_at` in unix seconds. The panel still forwards `content` unchanged. A site mismatch logs `License site_url %s does not match server %s` and an expiry logs `License is expired at %s, please renew your license`; neither aborts the process, matching the upstream ack callback. Config decrypt uses the panel `CONFIG_SECRET` (`--config-secret`), which is key1's role and is not the license key. With no tunnels the document has 0 services. After `POST /tunnel` created `local-tcp` (user 14, in-group `handshake-in` id 2, out-group `handshake-out` id 3, listen `127.0.0.1:18080`, forward `127.0.0.1:19081`) the same agent logged `config received (fernet): 2 service(s), 1 chain(s)` and `config applied: 2/2`. The panel emits both a `tcp-` and a `udp-` service for a non-UDP port forward (same as upstream `getInNodeConfig`). A client writing `hello-relayx` to `127.0.0.1:18080` received `pong:hello-relayx` from a process bound on `19081`, so the decrypted config was actually applied, not only parsed. The out group had no live node, so the chain had no hop address and the agent used the forwarder target.
