import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Abi } from "viem";

// Reads the real Foundry build artifact (same pattern as server/resolver/src/artifact.ts) rather than
// hand-maintaining a duplicate ABI, so this page can never drift from what's actually deployed.
// Requires `forge build` to have run in contracts/. Resolved from this file's own location rather
// than process.cwd(), so it doesn't depend on which directory Next.js happens to be invoked from.
const ARTIFACT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/out/MilestoneEscrow.sol/MilestoneEscrow.json");

interface FoundryArtifact {
  abi: Abi;
  bytecode: { object: `0x${string}` };
}

let cached: FoundryArtifact | undefined;

function load(): FoundryArtifact {
  if (!cached) {
    let raw: string;
    try {
      raw = readFileSync(ARTIFACT_PATH, "utf-8");
    } catch (err) {
      throw new Error(`Could not read MilestoneEscrow build artifact at ${ARTIFACT_PATH}. Run \`forge build\` in contracts/ first.`, { cause: err });
    }
    cached = JSON.parse(raw);
  }
  return cached!;
}

export function loadMilestoneEscrowAbi(): Abi {
  return load().abi;
}

// Only ever needed server-side, to hand to a client that will deploy with its own connected wallet
// (app/new/actions.ts's getDeploymentArtifact) — this file itself uses node:fs and can't run in the
// browser.
export function loadMilestoneEscrowBytecode(): `0x${string}` {
  return load().bytecode.object;
}
