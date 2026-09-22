import {z} from "zod";

export const browserCaptureSchema = z.object({
  version: z.literal(1),
  source: z.object({kind: z.literal("web"), title: z.string().min(1), locator: z.string().url(), language: z.string().min(2)}),
  selectedText: z.string().min(1),
  sentence: z.string().min(1),
  capturedAt: z.string().datetime()
});

export type BrowserCapture = z.infer<typeof browserCaptureSchema>;
export const parseBrowserCapture = (raw: unknown): BrowserCapture => browserCaptureSchema.parse(raw);
