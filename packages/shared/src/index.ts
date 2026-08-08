import { z } from "zod";

/**
 * Capture geometry, encoding and transport — one definition for every surface
 * that can make a capture (extension, web, Mac app). See ./capture.ts.
 */
export * from "./capture";
export * from "./native";
export * from "./classification";

/** Locked taxonomy — see 10_DATA_MODEL.md. Only `screenshot` is implemented in v1. */
export const captureKind = z.enum(["screenshot", "link", "file"]);
export type CaptureKind = z.infer<typeof captureKind>;
