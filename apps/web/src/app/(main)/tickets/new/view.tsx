"use client";
import { t } from "@/lib/i18n";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { client } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MarkdownEditor } from "@/components/markdown";
import { setPageTitle } from "@/components/page-title";

/** UF-05 新建工单：分类 + 标题 + Markdown 正文，POST /ticket. */
export default function NewTicketPage() {
  const router = useRouter();
  const [type, setType] = React.useState("technical");
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => setPageTitle(t("zh_ceec83")), []);

  const submit = async () => {
    if (!title.trim()) return toast.error(t("zh_901722"));
    if (!content.trim()) return toast.error(t("zh_ac962c"));
    setSaving(true);
    try {
      const res = await client.ticket.$post({ json: { title: title.trim(), content, type } });
      if (res.ok) {
        toast.success(t("zh_4bd5c7"));
        router.push("/tickets");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{t("zh_ceec83")}</h2>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("zh_435c52")}</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="technical">{t("zh_f98826")}</SelectItem>
              <SelectItem value="billing">{t("zh_4715ac")}</SelectItem>
              <SelectItem value="other">{t("zh_1a26ed")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("zh_748d7d")}</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("zh_7b5565")} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("zh_163aec")}</Label>
          <MarkdownEditor value={content} onChange={setContent} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            {saving ? t("app.submitting") : t("zh_47fb50")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push("/tickets")}>
            {t("misc.label.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
