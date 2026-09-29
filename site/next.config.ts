import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // app/new/actions.ts reads two local sibling packages (symlinked via `file:` deps in package.json,
  // not published) at runtime. By default Turbopack only resolves files at or below the Next project
  // directory — `root` widens that to the actual monorepo root so the symlinks resolve.
  turbopack: {
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  },
  // serverExternalPackages alone isn't enough — Turbopack's resolver enforces the root boundary
  // before externalization is even considered — but it's still correct to keep: these packages use
  // Node-specific APIs (node:crypto, node:fs) and don't need to be bundled at all, only resolved at
  // runtime via native `require`/`import`.
  serverExternalPackages: ["@verdict/imd-client", "@verdict/oracle-compiler"],
};

export default nextConfig;
