// Deterministic lint, run after extraction and before any paid or dry-run call. Per the spec: reject
// subjective words, private sources, and evidence that needs a login — an LLM never writes the oracle
// request freehand, so these checks catch what slips through extraction rather than trusting a prompt.

const SUBJECTIVE_WORDS = [
  "good",
  "great",
  "satisfactory",
  "acceptable",
  "reasonable",
  "appropriate",
  "sufficient",
  "adequate",
  "properly",
  "correctly",
  "high quality",
  "professional",
  "best effort",
  "as needed",
  "asap",
];

// "on time" and similar are only ambiguous without a concrete timestamp to anchor them to.
const TIME_WORDS_NEEDING_TIMESTAMP = ["on time", "in time", "promptly", "timely", "quickly", "soon"];

const LOGIN_HINT_WORDS = ["login", "log in", "sign in", "password", "credentials", "members only", "behind a paywall", "authenticated"];

export interface LintFinding {
  code: "subjective_word" | "time_word_without_timestamp" | "login_required_hint" | "private_source";
  detail: string;
}

export function lintDealText(text: string, hasConcreteDeadline: boolean): LintFinding[] {
  const findings: LintFinding[] = [];
  const lower = text.toLowerCase();

  for (const word of SUBJECTIVE_WORDS) {
    if (lower.includes(word)) findings.push({ code: "subjective_word", detail: word });
  }
  if (!hasConcreteDeadline) {
    for (const phrase of TIME_WORDS_NEEDING_TIMESTAMP) {
      if (lower.includes(phrase)) findings.push({ code: "time_word_without_timestamp", detail: phrase });
    }
  }
  for (const hint of LOGIN_HINT_WORDS) {
    if (lower.includes(hint)) findings.push({ code: "login_required_hint", detail: hint });
  }
  return findings;
}

const PRIVATE_HOST_PATTERNS = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\.0\.0\.0$/, /\.local$/i, /\.internal$/i];

export function lintSourceUrl(rawUrl: string): LintFinding[] {
  const findings: LintFinding[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [{ code: "private_source", detail: `not a valid URL: ${rawUrl}` }];
  }
  if (url.protocol !== "https:") {
    findings.push({ code: "private_source", detail: `not https: ${rawUrl}` });
  }
  if (url.username || url.password) {
    findings.push({ code: "private_source", detail: `URL embeds credentials: ${rawUrl}` });
  }
  if (PRIVATE_HOST_PATTERNS.some((p) => p.test(url.hostname))) {
    findings.push({ code: "private_source", detail: `private/internal host: ${url.hostname}` });
  }
  return findings;
}

export function lintSourceUrls(urls: string[]): LintFinding[] {
  return urls.flatMap(lintSourceUrl);
}
