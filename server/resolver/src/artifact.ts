import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Reads the real Foundry build artifact rather than hand-maintaining a duplicate ABI here, so the
// resolver can never drift from what's actually deployed. Requires `forge build` to have run in
// contracts/ — this is a dev-time dependency, same as node_modules.
const ARTIFACT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../contracts/out/MilestoneEscrow.sol/MilestoneEscrow.json",
);

export interface FoundryArtifact {
  abi: readonly unknown[];
  bytecode: { object: `0x${string}` };
}

let cached: FoundryArtifact | undefined;

export function loadMilestoneEscrowArtifact(): FoundryArtifact {
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
