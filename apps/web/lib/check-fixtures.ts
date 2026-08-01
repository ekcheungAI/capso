import type { Screenshot } from "@/lib/store";

/**
 * Shared fixture for the `*.check.ts` files. Deliberately not named `*.check.ts`
 * itself: the test glob would pick it up, and any check file importing from
 * another check file re-registers that file's tests under the importer.
 *
 * One builder, so adding a field to `Screenshot` breaks exactly one place.
 */
export const shot = (over: Partial<Screenshot> & { id: string }): Screenshot =>
  ({
    title: "",
    summary: "",
    whySaved: "",
    ocrText: "",
    intent: "other",
    type: "other",
    confidence: 0,
    status: "done",
    simulated: false,
    threadId: null,
    suggestedThreadId: null,
    assignmentSource: null,
    archived: false,
    source: "web_upload",
    capturedAt: new Date().toISOString(),
    imageDataUrl: null,
    thumbDataUrl: null,
    width: null,
    height: null,
    hue: 0,
    aspect: "wide",
    pageUrl: null,
    pageTitle: null,
    sourceApp: null,
    tags: [],
    userTags: [],
    ocrSource: null,
    ocrLangs: [],
    contentHash: null,
    originalPath: null,
    thumbPath: null,
    ...over,
  }) as Screenshot;
