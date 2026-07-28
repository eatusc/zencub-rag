import { PublicSearch } from "@/components/PublicSearch";
import { SearchClient } from "@/components/SearchClient";
import { getAppMode } from "@/lib/appMode";

export default function Home() {
  return getAppMode() === "public" ? <PublicSearch /> : <SearchClient />;
}
