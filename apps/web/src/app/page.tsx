"use client";
import { t as tr } from "@/lib/i18n";
/**
 * Marketing landing page. Upstream uses a private 25-key inline palete instead of the
 * CSS tokens (reports/08 §2.2, artifacts/landing-page.json); reproduced here with the
 * same values, plus a simplified version of the canvas topology animation.
 */
import * as React from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { ArrowRight, Zap } from "lucide-react";
import { useSiteConfig } from "@/lib/hooks";

const MOCK_TUNNELS = [
  { name: tr("zh_6548ac"), protocol: "tcp", active: true, traffic: "4.8 GB", percent: 68 },
  { name: tr("zh_f22979"), protocol: "relayx", active: true, traffic: "2.1 GB", percent: 42 },
  { name: tr("zh_a90ffb"), protocol: "TLS", active: true, traffic: "0.9 GB", percent: 18 },
  { name: tr("zh_29e92d"), protocol: "QUIC", active: false, traffic: "—", percent: 0 },
];

const STATS = [
  { value: "9", label: tr("zh_ab4807") },
  { value: "6", label: tr("zh_580cd1") },
  { value: tr("zh_4afad8"), label: tr("dns_e8ffba") },
  { value: tr("zh_bd1ab1"), label: tr("zh_029424") },
];

const PROTOCOLS = [
  ["tcp", tr("zh_3e535f")],
  ["mTCP", tr("tcp_306b0c")],
  ["udp", tr("zh_0d094c")],
  ["TLS", tr("zh_dc614b")],
  ["mTLS", tr("tls_5aa613")],
  ["WSS", tr("websocket_121e1f")],
  ["mWSS", tr("wss_61d655")],
  ["QUIC", tr("zh_79e4ca")],
];

const CORE_TAGS = [tr("zh_82492c"), tr("zh_87890f"), tr("zh_a313c0"), tr("zh_7b5cb8")];

const DNS_ROWS = [
  { label: tr("zh_3bd49a"), value: tr("cloudflare_dns_8ca084") },
  { label: tr("zh_89ef0b"), value: "IPv4 (A) · IPv6 (AAAA)" },
  { label: tr("zh_b62ed7"), value: tr("ttl_790e58") },
];

const COST_CHIPS = [tr("zh_a2a58f"), "+", tr("zh_59de81"), "+", tr("zh_0d62fb")];

const CHAIN_NODES = [tr("zh_a2a58f"), tr("1_f9e40a"), tr("n_9f3894"), tr("zh_59de81")];

const FEATURES = [
  { title: tr("zh_991fff"), desc: tr("zh_bed648") },
  { title: tr("zh_b58b4b"), desc: tr("zh_5637cf") },
  { title: tr("zh_a77a41"), desc: tr("9_relayx_388446") },
  { title: tr("zh_20b1e2"), desc: tr("zh_c76a05") },
];

const SECURITY = [
  { title: tr("ip_d28e3c"), desc: tr("ip_ip_8d3cbc") },
  { title: tr("zh_c944d5"), desc: tr("zh_d9ebdb") },
  { title: tr("telegram_096ea6"), desc: tr("telegram_8974e6") },
  { title: tr("zh_e9bd76"), desc: tr("zh_ca8b1f") },
];

const FOOTER_LINKS = {
  product: [
    { label: tr("demo_093cab"), href: "https://demo.relayx.cc" },
    { label: tr("zh_9ff669"), href: "https://docs.relayx.cc" },
    { label: tr("zh_185368"), href: "https://docs.relayx.cc/changelog" },
  ],
  community: [
    { label: tr("telegram_5a1e20"), href: "https://t.me/relayx_group" },
    { label: tr("telegram_63a165"), href: "https://t.me/relayx_channel" },
  ],
  account: [
    { label: tr("landing.signIn2"), href: "/handler/sign-in" },
    { label: tr("landing.signUpFree"), href: "/handler/sign-up" },
  ],
};

const STEPS = [
  { num: "01", title: tr("landing.createAnAccount"), desc: tr("zh_f3d77f") },
  { num: "02", title: tr("admin.userPlans.pickAPlan"), desc: tr("zh_8e8685") },
  { num: "03", title: tr("misc.label.createATunnel"), desc: tr("zh_237796") },
];

function TopologyCanvas({ dark }: { dark: boolean }) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const rgba = (a: number) =>
      dark ? `rgba(255,255,255,${a})` : `rgba(34,42,53,${a})`;

    // 17 nodes normalised, 3 labelled in / chain / 3 labelled out
    type NodeSeed = { x: number; y: number; r: number; label?: string };
    const seeds: NodeSeed[] = [
      { x: 0.05, y: 0.2, r: 6, label: tr("zh_38e9cd") },
      { x: 0.04, y: 0.5, r: 7, label: tr("zh_38e9cd") },
      { x: 0.06, y: 0.8, r: 6, label: tr("zh_38e9cd") },
      { x: 0.25, y: 0.15, r: 4 },
      { x: 0.26, y: 0.42, r: 5 },
      { x: 0.24, y: 0.65, r: 4 },
      { x: 0.26, y: 0.87, r: 3 },
      { x: 0.5, y: 0.25, r: 5 },
      { x: 0.52, y: 0.5, r: 8, label: tr("zh_260658") },
      { x: 0.49, y: 0.75, r: 5 },
      { x: 0.74, y: 0.18, r: 4 },
      { x: 0.76, y: 0.44, r: 5 },
      { x: 0.73, y: 0.68, r: 4 },
      { x: 0.75, y: 0.87, r: 3 },
      { x: 0.95, y: 0.25, r: 6, label: tr("zh_dd877e") },
      { x: 0.96, y: 0.54, r: 7, label: tr("zh_dd877e") },
      { x: 0.94, y: 0.8, r: 6, label: tr("zh_dd877e") },
    ];
    type Pt = { x: number; y: number; r: number; label?: string; glow: number };
    const pts: Pt[] = seeds.map((s) => ({ x: s.x * w, y: s.y * h, r: s.r, label: s.label, glow: 0 }));

    const pairs: [number, number][] = [
      [0, 3], [0, 4], [1, 3], [1, 4], [1, 5], [2, 5], [2, 6], [3, 7], [4, 7], [4, 8], [5, 8],
      [5, 9], [6, 9], [7, 10], [8, 10], [8, 11], [9, 11], [9, 12], [9, 13], [10, 14], [11, 14],
      [11, 15], [12, 15], [13, 15], [13, 16],
    ];
    type Edge = { from: number; to: number; c1x: number; c1y: number; c2x: number; c2y: number };
    const edges: Edge[] = pairs.map(([a, b]) => {
      const from = pts[a];
      const to = pts[b];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = (Math.random() - 0.5) * 48;
      const nx = (-dy / len) * off;
      const ny = (dx / len) * off;
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      return { from: a, to: b, c1x: mx + nx, c1y: my + ny, c2x: mx + 0.5 * nx, c2y: my + 0.5 * ny };
    });

    const particles = edges.flatMap((_e, i) =>
      Array.from({ length: 1 + Math.floor(2 * Math.random()) }, () => ({
        edge: i,
        t: Math.random(),
        speed: 0.0022 + 0.003 * Math.random(),
      })),
    );

    const bez = (t: number, p0: number, p1: number, p2: number, p3: number) => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };

    let dash = 0;
    let raf = 0;
    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      dash -= 0.35;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 10]);
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = rgba(0.07);
      for (const e of edges) {
        const a = pts[e.from];
        const b = pts[e.to];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.bezierCurveTo(e.c1x, e.c1y, e.c2x, e.c2y, b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const p of particles) {
        p.t += p.speed;
        if (p.t > 1) p.t = 0;
        const e = edges[p.edge];
        const a = pts[e.from];
        const b = pts[e.to];
        const x = bez(p.t, a.x, e.c1x, e.c2x, b.x);
        const y = bez(p.t, a.y, e.c1y, e.c2y, b.y);
        if (p.t < 0.06) a.glow = Math.max(a.glow, (0.06 - p.t) / 0.06);
        if (p.t > 0.94) b.glow = Math.max(b.glow, (p.t - 0.94) / 0.06);
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
        ctx.fillStyle = rgba(0.5);
        ctx.fill();
      }
      for (const n of pts) {
        if (n.glow > 0.01) {
          const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 5 * n.r);
          g.addColorStop(0, rgba(0.22 * n.glow));
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.beginPath();
          ctx.arc(n.x, n.y, 5 * n.r, 0, 2 * Math.PI);
          ctx.fillStyle = g;
          ctx.fill();
          n.glow *= 0.92;
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
        ctx.fillStyle = rgba(0.09);
        ctx.fill();
        ctx.strokeStyle = rgba(0.2);
        ctx.lineWidth = 1;
        ctx.stroke();
        if (n.label) {
          ctx.font = "10px system-ui,sans-serif";
          ctx.fillStyle = rgba(0.25);
          ctx.textAlign = "center";
          ctx.fillText(n.label, n.x, n.y - n.r - 5);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [dark]);
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

export default function LandingPage() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const { data: site } = useSiteConfig();
  React.useEffect(() => setMounted(true), []);

  const dark = mounted && resolvedTheme === "dark";
  const z = {
    bg: dark ? "#0f0f0f" : "#ffffff",
    bgMuted: dark ? "#161616" : "#fafafa",
    bgCard: dark ? "#1c1c1c" : "#ffffff",
    bgSubtle: dark ? "#242424" : "#f5f5f5",
    text: dark ? "#f0f0f0" : "#242424",
    textSec: dark ? "rgba(255,255,255,0.45)" : "#898989",
    textMuted: dark ? "rgba(255,255,255,0.22)" : "#c0c0c0",
    border: dark ? "rgba(255,255,255,0.08)" : "rgba(34,42,53,0.08)",
    btnBg: dark ? "#f0f0f0" : "#242424",
    btnText: dark ? "#111111" : "#ffffff",
    heroShadow: dark
      ? "rgba(0,0,0,0.6) 0px 8px 40px -8px, rgba(255,255,255,0.07) 0px 0px 0px 1px"
      : "rgba(19,19,22,0.12) 0px 8px 40px -8px, rgba(34,42,53,0.08) 0px 0px 0px 1px",
    shadow: dark
      ? "rgba(0,0,0,0.5) 0px 1px 5px -4px, rgba(255,255,255,0.07) 0px 0px 0px 1px, rgba(0,0,0,0.25) 0px 4px 8px 0px"
      : "rgba(19,19,22,0.7) 0px 1px 5px -4px, rgba(34,42,53,0.08) 0px 0px 0px 1px, rgba(34,42,53,0.05) 0px 4px 8px 0px",
    featBg: dark ? "#efefef" : "#242424",
    featText: dark ? "#111111" : "#ffffff",
    featSub: dark ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.55)",
    featTagBg: dark ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)",
    featTagText: dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.7)",
    featTagBorder: dark ? "rgba(0,0,0,0.06)" : "transparent",
    ctaBg: dark ? "#1c1c1c" : "#111111",
    ctaText: "rgba(255,255,255,0.45)",
    ctaBtnBg: dark ? "#f0f0f0" : "#ffffff",
    ctaBtnText: dark ? "#111111" : "#242424",
    numText: dark ? "rgba(255,255,255,0.08)" : "rgba(34,42,53,0.10)",
  };

  const siteName = (site?.SITE_NAME ?? "").trim() || "relayx";
  const siteDesc =
    (site?.SITE_DESCRIPTION ?? "").trim() || tr("zh_5a9bf3");

  return (
    <div
      className="min-h-screen transition-colors duration-200"
      style={{ backgroundColor: z.bg, color: z.text, fontFamily: "Inter, system-ui, -apple-system, sans-serif" }}
    >
      <nav className="sticky top-0 z-50" style={{ backgroundColor: z.bg, borderBottom: `1px solid ${z.border}` }}>
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Zap className="size-4" /> {siteName}
          </span>
          <div className="flex items-center gap-2 text-sm">
            <a href="https://docs.relayx.cc" target="_blank" rel="noopener noreferrer" className="px-3 py-2">
              {tr("zh_106912")}
            </a>
            <a href="https://demo.relayx.cc" target="_blank" rel="noopener noreferrer" className="px-3 py-2">
              Demo
            </a>
            <Link
              href="/handler/sign-in"
              className="px-4 py-2 font-semibold"
              style={{ backgroundColor: z.btnBg, color: z.btnText, borderRadius: 8 }}
            >
              {tr("landing.signIn2")}
            </Link>
          </div>
        </div>
      </nav>

      <section className="relative overflow-hidden px-6 py-20 text-center">
        <TopologyCanvas dark={dark} />
        {/* Upstream masks the canvas with a radial vignette so the grid fades toward the copy. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 70% 60% at 50% 45%, transparent 30%, ${z.bg} 85%)`,
          }}
        />
        <div className="relative z-10 mx-auto max-w-4xl">
          <span
            className="mb-6 inline-flex items-center px-4 py-1.5 text-[13px] font-medium"
            style={{ backgroundColor: z.bgSubtle, color: z.textSec, borderRadius: 9999 }}
          >
            {tr("landing.tunnelProxyPlatform")}
          </span>
          <h1
            className="mb-5 font-bold tracking-tight"
            style={{ fontSize: "clamp(40px, 7vw, 68px)", lineHeight: 1.08, letterSpacing: "-0.5px" }}
          >
            {siteName}
          </h1>
          <p className="mx-auto mb-8 max-w-lg text-[17px]" style={{ color: z.textSec, lineHeight: 1.55, fontWeight: 300 }}>
            {siteDesc}
          </p>
          <div className="mb-14 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/handler/sign-up"
              className="inline-flex items-center gap-2 px-6 py-3 text-[14px] font-semibold"
              style={{ backgroundColor: z.btnBg, color: z.btnText, borderRadius: 8 }}
            >
              {tr("landing.getStarted")} <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/handler/sign-in"
              className="inline-flex items-center gap-2 px-6 py-3 text-[14px] font-semibold"
              style={{ backgroundColor: z.bgCard, borderRadius: 8, border: `1px solid ${z.border}` }}
            >
              {tr("landing.signIn")}
            </Link>
          </div>

          <div className="mx-auto max-w-2xl overflow-hidden rounded-2xl text-left" style={{ boxShadow: z.heroShadow }}>
            <div className="px-5 py-3.5" style={{ backgroundColor: z.bgMuted, borderBottom: `1px solid ${z.border}` }}>
              <span className="text-[13px] font-semibold">{tr("nav.tunnelManagement")}</span>
            </div>
            <ul>
              {MOCK_TUNNELS.map((t) => (
                <li key={t.name} className="flex items-center gap-3 px-5 py-3" style={{ borderBottom: `1px solid ${z.border}` }}>
                  <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: t.active ? "#22c55e" : "#6b7280" }} />
                  <span className="flex-1 text-[13px] font-medium">{t.name}</span>
                  <span className="rounded px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: z.bgSubtle, color: z.textSec }}>
                    {t.protocol}
                  </span>
                  <span className="w-12 text-right text-[12px] tabular-nums" style={{ color: z.textSec }}>
                    {t.traffic}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section style={{ backgroundColor: z.bgMuted, borderTop: `1px solid ${z.border}`, borderBottom: `1px solid ${z.border}` }}>
        <div className="mx-auto grid max-w-4xl grid-cols-2 gap-8 px-6 py-10 md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-2xl font-bold tracking-tight">{s.value}</div>
              <div className="mt-1 text-[12px]" style={{ color: z.textSec }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center font-bold tracking-tight" style={{ fontSize: "clamp(28px, 4vw, 44px)" }}>
            {tr("landing.tunnelProtocols9")}
          </h2>
          <p className="mb-10 text-center text-sm" style={{ color: z.textSec }}>
            {tr("zh_44aa10")}
          </p>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {PROTOCOLS.map(([name, desc]) => (
              <div key={name} className="rounded-lg p-4" style={{ backgroundColor: z.bgCard, border: `1px solid ${z.border}` }}>
                <div className="text-sm font-semibold">{name}</div>
                <div className="mt-1 text-[12px]" style={{ color: z.textSec }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 核心技术能力（bento 2+3）──────────────────────────────── */}
      <section className="px-6" style={{ paddingTop: 96, paddingBottom: 96 }}>
        <div className="mx-auto max-w-6xl">
          <div className="mb-14 text-center">
            <h2 className="mb-4 font-bold tracking-tight" style={{ color: z.text, fontSize: "clamp(28px, 4vw, 44px)", lineHeight: 1.1 }}>
              {tr("zh_bdcbc4")}
            </h2>
            <p className="text-[15px]" style={{ color: z.textSec, lineHeight: 1.55, fontWeight: 300 }}>
              {tr("zh_bd761c")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
            <div className="flex flex-col justify-between rounded-xl p-8 lg:col-span-2" style={{ backgroundColor: z.featBg, minHeight: 320 }}>
              <div>
                <span className="mb-6 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold"
                  style={{ backgroundColor: z.featTagBg, color: z.featTagText, letterSpacing: "0.08em", border: `1px solid ${z.featTagBorder}` }}>
                  {tr("zh_549d2a")}
                </span>
                <h3 className="mb-4 font-bold tracking-tight" style={{ color: z.featText, fontSize: 28, lineHeight: 1.1 }}>
                  RelayX Protocol
                </h3>
                <p className="text-[14px] leading-relaxed" style={{ color: z.featSub }}>
                  {tr("uuid_v5_22fe17")}
                </p>
              </div>
              <div className="mt-8 flex flex-wrap gap-2">
                {CORE_TAGS.map((tag) => (
                  <span key={tag} className="rounded-full px-3 py-1 text-[11px] font-medium"
                    style={{ backgroundColor: z.featTagBg, color: z.featTagText, border: `1px solid ${z.featTagBorder}` }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-5 lg:col-span-3">
              <div className="rounded-xl p-7" style={{ backgroundColor: z.bgCard, boxShadow: z.shadow }}>
                <h3 className="mb-3 text-[17px] font-bold" style={{ color: z.text }}>{tr("zh_b42a4d")}</h3>
                <p className="text-[14px] leading-relaxed" style={{ color: z.textSec }}>
                  {tr("6_6e97d0")}
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {[tr("zh_65a48f"), tr("zh_834fd6"), tr("zh_8368f3"), tr("zh_f2b0b1"), tr("zh_658ee8"), tr("zh_b6eacd")].map((lb) => (
                    <span key={lb} className="rounded px-2 py-1 text-[11px]" style={{ backgroundColor: z.bgSubtle, color: z.textSec }}>{lb}</span>
                  ))}
                </div>
              </div>
              <div className="rounded-xl p-7" style={{ backgroundColor: z.bgCard, boxShadow: z.shadow }}>
                <h3 className="mb-3 text-[17px] font-bold" style={{ color: z.text }}>{tr("zh_9860af")}</h3>
                <p className="text-[14px] leading-relaxed" style={{ color: z.textSec }}>
                  {tr("zh_a40f18")}
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  {CHAIN_NODES.map((n, i) => (
                    <React.Fragment key={n}>
                      {i > 0 ? <span style={{ color: z.textMuted }}>→</span> : null}
                      <span className="rounded-md px-2.5 py-1 text-[11px] font-medium" style={{ backgroundColor: z.bgSubtle, color: z.text }}>{n}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 运营级基础能力 + 4 项安全能力 ─────────────────────────── */}
      <section className="px-6" style={{ paddingTop: 96, paddingBottom: 96, backgroundColor: z.bgMuted, borderTop: `1px solid ${z.border}` }}>
        <div className="mx-auto max-w-6xl">
          <div className="mb-14 text-center">
            <h2 className="mb-4 font-bold tracking-tight" style={{ color: z.text, fontSize: "clamp(28px, 4vw, 44px)", lineHeight: 1.1 }}>{tr("zh_83c3fd")}</h2>
            <p className="text-[15px]" style={{ color: z.textSec, lineHeight: 1.55, fontWeight: 300 }}>
              {tr("dns_0b6c8a")}
            </p>
          </div>
          <div className="mb-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="rounded-xl p-8" style={{ backgroundColor: z.bgCard, boxShadow: z.shadow }}>
              <h3 className="mb-3 text-[17px] font-bold" style={{ color: z.text }}>{tr("dns_9181bd")}</h3>
              <p className="mb-5 text-[14px] leading-relaxed" style={{ color: z.textSec }}>
                {tr("dns_a_aaaa_3c1384")}
              </p>
              <div className="flex flex-col gap-2">
                {DNS_ROWS.map((r) => (
                  <div key={r.label} className="flex items-center justify-between text-[13px]">
                    <span style={{ color: z.textSec }}>{r.label}</span>
                    <span style={{ color: z.text }}>{r.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl p-8" style={{ backgroundColor: z.bgCard, boxShadow: z.shadow }}>
              <h3 className="mb-3 text-[17px] font-bold" style={{ color: z.text }}>{tr("zh_3f631c")}</h3>
              <p className="mb-5 text-[14px] leading-relaxed" style={{ color: z.textSec }}>
                {tr("observer_3977cc")}
              </p>
              <div className="rounded-lg p-4" style={{ backgroundColor: z.bgSubtle }}>
                <p className="mb-3 text-[11px] font-semibold" style={{ color: z.textSec, letterSpacing: "0.06em" }}>{tr("zh_b480b4")}</p>
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  {COST_CHIPS.map((chip, i) =>
                    chip === "+" ? (
                      <span key={i} style={{ color: z.textMuted }}>+</span>
                    ) : (
                      <span key={i} className="rounded px-2 py-1" style={{ backgroundColor: z.bgCard, color: z.text }}>{chip}</span>
                    ),
                  )}
                  <span style={{ color: z.textMuted }}>=</span>
                  <span className="rounded px-2 py-1 font-semibold" style={{ backgroundColor: z.btnBg, color: z.btnText }}>{tr("zh_d29aee")}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {SECURITY.map((sec) => (
              <div key={sec.title} className="rounded-xl p-6" style={{ backgroundColor: z.bgCard, boxShadow: z.shadow }}>
                <h4 className="mb-2 text-[14px] font-bold" style={{ color: z.text }}>{sec.title}</h4>
                <p className="text-[12px] leading-relaxed" style={{ color: z.textSec }}>{sec.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 为何选择（4 特性卡）──────────────────────────────────── */}
      <section className="px-6" style={{ paddingTop: 96, paddingBottom: 96 }}>
        <div className="mx-auto max-w-6xl">
          <div className="mb-14 text-center">
            <h2 className="mb-4 font-bold tracking-tight" style={{ color: z.text, fontSize: "clamp(28px, 4vw, 44px)", lineHeight: 1.1 }}>
              {tr("zh_b1de07")} <span>{siteName}</span>
            </h2>
            <p className="text-[15px]" style={{ color: z.textSec, lineHeight: 1.55, fontWeight: 300 }}>
              {tr("zh_c7611a")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-xl p-8" style={{ backgroundColor: z.bgCard, boxShadow: z.shadow }}>
                <h3 className="mb-3 text-[17px] font-bold" style={{ color: z.text }}>{f.title}</h3>
                <p className="text-[14px] leading-relaxed" style={{ color: z.textSec }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-20" style={{ backgroundColor: z.bgMuted, borderTop: `1px solid ${z.border}` }}>
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-10 text-center font-bold tracking-tight" style={{ fontSize: "clamp(28px, 4vw, 44px)" }}>
            {tr("landing.upAndRunningInThreeSteps")}
          </h2>
          <div className="grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.num}>
                <div className="text-3xl font-bold" style={{ color: z.textMuted }}>{s.num}</div>
                <div className="mt-2 font-semibold">{s.title}</div>
                <p className="mt-1 text-[13px]" style={{ color: z.textSec }}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 底部 CTA（深色带）────────────────────────────────────── */}
      <section className="px-6 text-center" style={{ paddingTop: 96, paddingBottom: 96, backgroundColor: z.ctaBg }}>
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-6 font-bold tracking-tight text-white" style={{ fontSize: "clamp(28px, 5vw, 52px)", lineHeight: 1.1 }}>
            {tr("landing.startBuildingNow")}
          </h2>
          <p className="mb-10 text-[15px]" style={{ color: z.ctaText, lineHeight: 1.55, fontWeight: 300 }}>
            {tr("zh_fed4df")}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/handler/sign-up" className="inline-flex items-center gap-2 px-8 py-4 text-[14px] font-semibold transition-opacity hover:opacity-80"
              style={{ backgroundColor: z.ctaBtnBg, color: z.ctaBtnText, borderRadius: 8 }}>
              {tr("landing.signUpFree")} <ArrowRight className="size-[15px]" />
            </Link>
            <Link href="/handler/sign-in" className="inline-flex items-center gap-2 px-6 py-4 text-[14px] font-semibold transition-opacity hover:opacity-70"
              style={{ color: "rgba(255,255,255,0.7)", borderRadius: 8, boxShadow: "rgba(255,255,255,0.1) 0px 0px 0px 1px" }}>
              {tr("zh_e4fbae")}
            </Link>
          </div>
        </div>
      </section>

      {/* ── 页脚 ─────────────────────────────────────────────────── */}
      <footer className="px-6 pt-12 pb-8 text-[13px]" style={{ borderTop: `1px solid ${z.border}` }}>
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 grid grid-cols-2 gap-8 md:grid-cols-4">
            <div className="col-span-2 md:col-span-1">
              <div className="mb-3 flex items-center gap-2">
                <Zap className="size-[22px]" />
                <span className="text-[14px] font-bold" style={{ color: z.text }}>{siteName}</span>
              </div>
              <p className="text-[12px] leading-relaxed" style={{ color: z.textSec }}>
                {tr("zh_072779")}
              </p>
            </div>
            {(
              [
                [tr("zh_6cc985"), FOOTER_LINKS.product],
                [tr("zh_367c1e"), FOOTER_LINKS.community],
                [tr("landing.account"), FOOTER_LINKS.account],
              ] as const
            ).map(([title, links]) => (
              <div key={title}>
                <div className="mb-3 text-[12px] font-semibold" style={{ color: z.text, letterSpacing: "0.06em" }}>
                  {title}
                </div>
                <ul className="flex flex-col gap-2.5">
                  {links.map((l) => (
                    <li key={l.href}>
                      <a href={l.href} target={l.href.startsWith("http") ? "_blank" : undefined}
                        rel={l.href.startsWith("http") ? "noopener noreferrer" : undefined}
                        style={{ color: z.textSec }}>
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-6" style={{ color: z.textMuted, borderTop: `1px solid ${z.border}` }}>
            <span>© {new Date().getFullYear()} RelayX. All rights reserved.</span>
            <span>
              Powered by{" "}
              <a className="underline" href="https://docs.relayx.cc" target="_blank" rel="noreferrer">
                {"relayx"}
              </a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
