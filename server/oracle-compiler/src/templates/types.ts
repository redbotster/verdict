import type { Extraction, OracleRequestInput, TemplateKind } from "../types.ts";

export interface BuildContext {
  /** The chain whose blocks get pinned for the evidence window — separate from the escrow's own deploy chain. */
  evidenceChainId: number;
  /** ISO 8601 UTC; defaults to "now" if the deal text gave no explicit start. */
  startIso: string;
  validForSeconds: number;
}

export interface Template {
  kind: TemplateKind;
  /** Missing-field names if this extraction claims this kind but is incomplete; empty means ready to build. */
  missingFields(e: Extraction): string[];
  build(e: Extraction, ctx: BuildContext): OracleRequestInput;
}
