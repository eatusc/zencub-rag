// Resolve the app's "@/*" tsconfig alias for a plain Node process.
//
// The retrieval libraries import nothing from next/*, so this alias is the only
// thing between them and this server. Node has no tsconfig path mapping and,
// under bundler module resolution, the app's imports carry no file extension.
// Both are supplied here rather than adding a bundler or reimplementing
// retrieval. Mirrors tsconfig.json "paths": { "@/*": ["./src/*"] }.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../../src");
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js"];

function resolveExtensionless(base) {
  if (path.extname(base) && existsSync(base)) return base;
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of EXTENSIONS) {
    const indexFile = path.join(base, "index" + ext);
    if (existsSync(indexFile)) return indexFile;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const target = resolveExtensionless(path.join(SRC, specifier.slice(2)));
    if (!target) {
      throw new Error(`Alias "${specifier}" did not resolve under ${SRC}`);
    }
    return { url: pathToFileURL(target).href, shortCircuit: true };
  },
});
