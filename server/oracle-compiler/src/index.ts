export { compileDeal, pinQuestion, approvalSummaryFromOrder } from "./compile.ts";
export type { CompileOptions } from "./compile.ts";
export { extractDealFields } from "./extract.ts";
export type { ExtractFn, ExtractOptions } from "./extract.ts";
export { lintDealText, lintSourceUrl, lintSourceUrls } from "./lint.ts";
export type { LintFinding } from "./lint.ts";
export { TEMPLATES, releasePublishedTemplate, pageOrFileLiveTemplate, onchainEventTemplate } from "./templates/index.ts";
export type { Template, BuildContext } from "./templates/index.ts";
export * from "./types.ts";
