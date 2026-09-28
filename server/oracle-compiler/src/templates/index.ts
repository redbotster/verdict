import type { Template } from "./types.ts";
import { releasePublishedTemplate } from "./releasePublished.ts";
import { pageOrFileLiveTemplate } from "./pageOrFileLive.ts";
import { onchainEventTemplate } from "./onchainEvent.ts";

export const TEMPLATES: Template[] = [releasePublishedTemplate, pageOrFileLiveTemplate, onchainEventTemplate];

export { releasePublishedTemplate, pageOrFileLiveTemplate, onchainEventTemplate };
export type { Template, BuildContext } from "./types.ts";
