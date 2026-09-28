import type { Extraction } from "../types.ts";
import { baseInput, calendarWindow, MISSING_RULE } from "./common.ts";
import type { BuildContext, Template } from "./types.ts";

export const releasePublishedTemplate: Template = {
  kind: "release_published",

  missingFields(e: Extraction): string[] {
    const missing: string[] = [];
    if (!e.githubRepo) missing.push("githubRepo");
    if (!e.deadlineIso) missing.push("deadlineIso");
    return missing;
  },

  build(e, ctx: BuildContext) {
    const repo = e.githubRepo!.replace(/\/+$/, "");
    const { calendar, hours } = calendarWindow(ctx.startIso, e.deadlineIso!);
    return baseInput(
      {
        question: `Did ${repo} publish a non-prerelease GitHub release between ${ctx.startIso} and ${e.deadlineIso}?`,
        window: { hours },
        evidence: "panel",
        panelSize: 5,
        quorum: 4,
        validForSeconds: ctx.validForSeconds,
        definitions: {
          project: `Use https://github.com/${repo}/releases and published_at. Exclude drafts and prereleases.`,
          calendar,
          missing: MISSING_RULE,
        },
        guards: { sources: [`https://github.com/${repo}/`], minSources: 1 },
      },
      ctx.evidenceChainId,
    );
  },
};
