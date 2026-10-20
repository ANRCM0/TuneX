"use client";
import { t } from "@/lib/i18n";
import * as React from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { client } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { MarkdownEditor, MarkdownView } from "@/components/markdown";
import { BadgeStatus } from "@/components/ui/badge-status";
import { setPageTitle } from "@/components/page-title";
import { formatDate } from "@/lib/utils";

type Ticket = {
  id: number;
  title: string;
  content: string;
  status: string;
  type?: string;
  created_at?: string;
  replies?: { id: number; content: string; is_admin?: boolean; created_at?: string }[];
};

/** UF-05 工单详情：Markdown 正文/回复 + POST /ticket/:id/reply + PATCH /ticket/:id 关单。 */
export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const key = ["/ticket", id];
  const { data, isLoading, mutate } = useSWR(key, async () => {
    const res = await client.ticket[":id"].$get({ param: { id } });
    return (await res.json()) as Ticket;
  });
  const [reply, setReply] = React.useState("");
  React.useEffect(() => setPageTitle(t("zh_90e24a")), []);

  const send = async () => {
    if (!reply.trim()) return toast.error(t("zh_9eb4b6"));
    const res = await client.ticket[":id"].reply.$post({ param: { id }, json: { content: reply } });
    if (res.ok) {
      toast.success(t("zh_31f44c"));
      setReply("");
      await mutate();
    }
  };

  const close = async () => {
    const res = await client.ticket[":id"].$patch({ param: { id }, json: { status: "closed" } });
    if (res.ok) {
      toast.success(t("zh_d3c60e"));
      await mutate();
    }
  };

  if (isLoading) return <div className="text-muted-foreground p-6 text-sm">{t("app.loading")}</div>;
  if (!data) return <div className="text-muted-foreground p-6 text-sm">{t("zh_b77fd7")}</div>;

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{data.title}</h2>
        <div className="flex items-center gap-2">
          <BadgeStatus status={data.status} />
          {data.status === "open" ? (
            <Button variant="outline" size="sm" onClick={() => void close()}>
              {t("zh_992e0f")}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">#{data.id} · {formatDate(data.created_at)}</p>

      <div className="rounded-lg border p-3">
        <MarkdownView source={data.content} />
      </div>

      <div className="flex flex-col gap-2">
        {(data.replies ?? []).map((r) => (
          <div key={r.id} className={r.is_admin ? "bg-muted rounded-lg p-3" : "rounded-lg border p-3"}>
            <p className="text-muted-foreground mb-1 text-xs">
              {r.is_admin ? t("zh_ef84e7") : t("zh_34f201")} · {formatDate(r.created_at)}
            </p>
            <MarkdownView source={r.content} />
          </div>
        ))}
      </div>

      <div className="grid gap-2">
        <MarkdownEditor value={reply} onChange={setReply} height={160} />
        <Button size="sm" className="w-fit" onClick={() => void send()}>
          {t("zh_6f64c6")}
        </Button>
      </div>
    </div>
  );
}
