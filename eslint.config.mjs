import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `.next-*` covers the per-deployment build directories from
    // scripts/deploy/build.sh (.next-public, .next-demo).
    ignores: [".next/**", ".next-*/**", "node_modules/**", "next-env.d.ts"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // tsc --noEmit (npm run typecheck) is the strictness gate; keep lint
      // focused on real problems without duplicating the compiler.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Standalone eval/integration scripts parse loose live-API JSON; the
    // strict no-any bar applies to src/ application code.
    files: ["scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
