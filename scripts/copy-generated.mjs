// `tsc` only emits from .ts sources, so the generated runtime modules
// (`_generated/api.js`, `_generated/server.js`) never reach dist/ on their own —
// the component would publish with unresolvable imports. Copy the whole
// generated tree, which `convex codegen` owns, verbatim.
import { cpSync, existsSync } from "node:fs";

const from = new URL("../src/component/_generated/", import.meta.url);
const to = new URL("../dist/component/_generated/", import.meta.url);

if (!existsSync(from)) {
  console.error(
    "src/component/_generated is missing — run `npm run codegen` first"
  );
  process.exit(1);
}

cpSync(from, to, { recursive: true });
console.log("copied _generated -> dist/component/_generated");
