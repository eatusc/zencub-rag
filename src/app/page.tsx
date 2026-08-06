import { InstructorsApp } from "@/components/InstructorsApp";
import { PublicSearch } from "@/components/PublicSearch";
import { SearchClient } from "@/components/SearchClient";
import { getAppMode } from "@/lib/appMode";

export default function Home() {
  const mode = getAppMode();
  if (mode === "public") return <PublicSearch />;
  if (mode === "instructors") return <InstructorsApp />;
  return <SearchClient />;
}
