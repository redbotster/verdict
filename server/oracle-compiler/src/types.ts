export type TemplateKind = "release_published" | "page_or_file_live" | "onchain_event";

export interface Extraction {
  claim: string;
  evidenceUrls: string[];
  deadlineIso: string | null;
  timezone: string | null;
  ambiguousTerms: string[];
  kind: TemplateKind | "unsupported";
  githubRepo: string | null;
  urlToCheck: string | null;
  urlContentCheck: string | null;
  chainId: number | null;
  recipientAddress: string | null;
  tokenAddress: string | null;
  minAmountBaseUnits: string | null;
}

// Matches the live IMD oracle.request input shape confirmed in docs/DAY-ONE-FINDINGS.md.
// `consumer` does NOT affect questionHash (confirmed empirically 2026-09-28: identical request bodies
// differing only in `consumer.verifyingContract` produced identical questionHash). A placeholder here
// at compile time is therefore already the real, binding questionHash — pinQuestion() exists to
// register the real deployed escrow address with IMD before the resolver's real paid oracle.request
// call, not because the hash would otherwise change.
export interface OracleRequestInput {
  v: 1;
  question: string;
  chainId: number;
  window: { hours: number };
  answerType: "bool";
  evidence: "panel" | "chain";
  panelSize: number;
  quorum: number;
  validForSeconds: number;
  definitions: {
    project: string;
    calendar: string;
    missing: string;
  };
  guards: { sources?: string[]; minSources?: number; toleranceBps?: number };
  consumer: { chainId: number; verifyingContract: string };
}

// IMD's schema requires lowercase hex addresses (^0x[0-9a-f]{40}$, confirmed 2026-09-28) — a
// checksummed mixed-case address, even a well-formed one, fails schema validation with a bare 400.
export const PLACEHOLDER_VERIFYING_CONTRACT = "0x000000000000000000000000000000000000dead";

export interface BuiltQuestion {
  kind: TemplateKind;
  input: OracleRequestInput;
}

export interface RefusalReason {
  code: "no_template_match" | "lint_failed" | "quote_rejected" | "extraction_failed";
  detail: string;
  problems?: unknown[];
}

export type CompileResult =
  | { ok: true; kind: TemplateKind; extraction: Extraction; input: OracleRequestInput; questionHash: string; attempts: number }
  | { ok: false; reason: RefusalReason; extraction?: Extraction; attempts: number };

export interface ApprovalSummary {
  questionPlainLanguage: string;
  sources: string[];
  panelSize: number;
  quorum: number;
  questionHash: string;
  pinned: { fromBlock?: number; toBlock?: number; toBlockHash?: string };
  expiresAt: number;
}
