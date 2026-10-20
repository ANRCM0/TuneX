import View from "./view";

// Upstream disables SSR for list pages (`dynamic(..., { ssr: false })`): the shell is
// client-rendered and URL state comes from nuqs, which cannot run during prerender.
export const dynamic = "force-dynamic";

export default function Page() {
  return <View />;
}
