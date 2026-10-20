"use client";
/**
 * 用户隧道（管理端）— 与用户侧共用同一个 TunnelsView，只是 API 前缀换成 adminClient。
 * 上游的 admin 隧道页比用户侧多一列 email、且不支持拖拽（reports/11 反常 #5）。
 */
import { TunnelsView } from "@/components/tunnels-view";

export default function View() {
  return <TunnelsView mode="admin" />;
}
