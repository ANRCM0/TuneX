import View from "./view";

// Client-only page (URL state / SWR / theme): opt out of prerender, like upstream's
// `dynamic(..., { ssr: false })` — see reports/13 §DEVIATIONS D6.
export const dynamic = "force-dynamic";

export default function Page() {
  return <View />;
}
