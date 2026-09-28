import type { Extraction } from "../types.ts";
import { baseInput, calendarWindow, MISSING_RULE } from "./common.ts";
import type { BuildContext, Template } from "./types.ts";

export const pageOrFileLiveTemplate: Template = {
  kind: "page_or_file_live",

  missingFields(e: Extraction): string[] {
    const missing: string[] = [];
    if (!e.urlToCheck) missing.push("urlToCheck");
    if (!e.urlContentCheck) missing.push("urlContentCheck");
    if (!e.deadlineIso) missing.push("deadlineIso");
    return missing;
  },

  build(e, ctx: BuildContext) {
    const url = new URL(e.urlToCheck!);
    const { calendar, hours } = calendarWindow(ctx.startIso, e.deadlineIso!);
    return baseInput(
      {
        question: `Does ${e.urlToCheck} serve content matching "${e.urlContentCheck}" as of ${e.deadlineIso}?`,
        window: { hours },
        evidence: "panel",
        panelSize: 5,
        quorum: 4,
        validForSeconds: ctx.validForSeconds,
        definitions: {
          project: `Fetch ${e.urlToCheck} and check: ${e.urlContentCheck}.`,
          calendar,
          missing: MISSING_RULE,
        },
        guards: { sources: [`${url.protocol}//${url.host}/`], minSources: 1 },
      },
      ctx.evidenceChainId,
    );
  },
};
