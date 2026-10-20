import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function EmptyState({
  title = t("misc.empty.noData"),
  description,
  action,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 py-12 text-center", className)}>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      {action}
    </div>
  );
}
