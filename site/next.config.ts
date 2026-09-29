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
  serverExternalPackages: ["@verdict/imd-client", "@verdict/oracle-compiler", "@verdict/oneclaw-client", "@verdict/resolver"],
  // Deployed on Vercel with Root Directory set to site/ (see .vercelignore's comment for why), so
  // Next's serverless file tracer defaults to treating site/ as the tracing root and won't see
  // contracts/out/ at all. outputFileTracingRoot widens that to the monorepo root (matching
  // turbopack.root above); outputFileTracingIncludes then force-includes the one file
  // lib/artifact.ts reads by a dynamically-built path (../../contracts/out/...), which the tracer's
  // static analysis can't follow on its own.
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  // The glob key is matched against the route with `contains: true` (picomatch), so it doesn't need
  // to match the whole route — but `[`/`]` are glob character-class syntax, not literal brackets, so
  // the dynamic segment has to be escaped or this silently never matches (confirmed the hard way:
  // the unescaped version deployed clean but 500'd at runtime — read the actual error, don't assume
  // a config value "worked" just because the build didn't complain about it).
  outputFileTracingIncludes: {
    "**/deals/\\[address\\]/**": ["../contracts/out/MilestoneEscrow.sol/*.json"],
  },
};

export default nextConfig;
