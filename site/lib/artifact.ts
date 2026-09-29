import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Abi } from "viem";

// Reads the real Foundry build artifact (same pattern as server/resolver/src/artifact.ts) rather than
// hand-maintaining a duplicate ABI, so this page can never drift from what's actually deployed.
// Requires `forge build` to have run in contracts/. Resolved from this file's own location rather
// than process.cwd(), so it doesn't depend on which directory Next.js happens to be invoked from.
const ARTIFACT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/out/MilestoneEscrow.sol/MilestoneEscrow.json");

let cachedAbi: Abi | undefined;

export function loadMilestoneEscrowAbi(): Abi {
  if (!cachedAbi) {
    let raw: string;
    try {
      raw = readFileSync(ARTIFACT_PATH, "utf-8");
    } catch (err) {
      throw new Error(`Could not read MilestoneEscrow build artifact at ${ARTIFACT_PATH}. Run \`forge build\` in contracts/ first.`, { cause: err });
    }
    cachedAbi = JSON.parse(raw).abi as Abi;
  }
  return cachedAbi;
}
