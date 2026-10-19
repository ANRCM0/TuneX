# Node agent image (build context: apps/agent).
#
#   docker build -t tunex-agent apps/agent
#   docker run --network host tunex-agent -s https://panel.example -t <group-token>
#
# The binary is static (CGO off). WireGuard and OpenVPN shells are installed
# because the agent drives `wg show transfer` and, when configured, an external
# OpenVPN. A node that only forwards TCP/UDP does not need them.

FROM golang:1.27-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/relayx-agent ./cmd/relayx-agent

FROM alpine:3.21

RUN apk add --no-cache ca-certificates wireguard-tools openvpn

COPY --from=build /out/relayx-agent /usr/local/bin/relayx-agent

ENTRYPOINT ["/usr/local/bin/relayx-agent"]
