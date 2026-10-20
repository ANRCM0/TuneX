import View from "./view";

// List pages are client-rendered only (URL state via nuqs); upstream does the same
// with `dynamic(..., { ssr: false })` — see reports/13 §DEVIATIONS D6.
export const dynamic = "force-dynamic";

export default function Page() {
  return <View />;
}
