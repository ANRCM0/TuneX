"use client";
/**
 * The four chart surfaces in the shipped build (reports/05 §5):
 *   /home                  Bar  traffic
 *   /admin                 Bar  ×4 (traffic / total / revenue / orders)
 *   /tunnels/monitoring    Bar  traffic + traffic_cost
 *   /referral              Bar  earnings + referral_count
 * All wrapped in ChartContainer with --chart-* CSS variables, as upstream does.
 */
import * as React from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";

export type Point = Record<string, string | number>;

export function ChartCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border p-4", className)}>
      <div className="mb-3">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      </div>
      <div className="h-56 w-full">{children}</div>
    </div>
  );
}

export function BarSeries({
  data,
  keys,
  xKey = "date",
  stacked = false,
  height = "100%",
}: {
  data: Point[];
  keys: { key: string; label: string; color?: string }[];
  xKey?: string;
  stacked?: boolean;
  height?: number | string;
}) {
  const palette = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
        <Tooltip
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {keys.map((k, i) => (
          <Bar
            key={k.key}
            dataKey={k.key}
            name={k.label}
            stackId={stacked ? "a" : undefined}
            fill={k.color ?? palette[i % palette.length]}
            radius={[3, 3, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
