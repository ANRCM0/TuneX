"use client";
import { t } from "@/lib/i18n";
/**
 * Markdown renderer, mirroring the shipped behaviour: `@uiw/react-md-editor`'s Markdown
 * component (reports/10 U5) — react-markdown pipeline, NO rehype-raw, so raw HTML is
 * escaped and `javascript:` URLs are stripped.
 */
import * as React from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { Skeleton } from "./ui/skeleton";

// @uiw/react-md-editor exposes MDEditor.Markdown; next/dynamic loses the static member,
// so both entrypoints are loaded explicitly.
const MDEditor = dynamic(() => import("@uiw/react-md-editor"), { ssr: false });
const Markdown = dynamic(() => import("@uiw/react-md-editor").then((m) => m.default.Markdown), {
  ssr: false,
});

export function MarkdownView({ source }: { source: string }) {
  const { resolvedTheme } = useTheme();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);
  if (!ready) return <Skeleton className="h-20" />;
  return (
    <div data-color-mode={resolvedTheme === "dark" ? "dark" : "light"}>
      <Markdown source={source || t("zh_8c4d50")} style={{ background: "transparent" }} />
    </div>
  );
}

export function MarkdownEditor({
  value,
  onChange,
  height = 200,
}: {
  value: string;
  onChange: (v: string) => void;
  height?: number;
}) {
  const { resolvedTheme } = useTheme();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);
  if (!ready) return <Skeleton style={{ height }} />;
  return (
    <div data-color-mode={resolvedTheme === "dark" ? "dark" : "light"}>
      <MDEditor value={value} onChange={(v) => onChange(v ?? "")} height={height} preview="edit" />
    </div>
  );
}
