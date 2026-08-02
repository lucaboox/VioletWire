import type { Platform } from "../shared/platform";

export interface HlsMediaResource {
  platform: Platform;
  url: string;
}

export type HlsMediaResourceResolver = (
  resourceId: string,
) => HlsMediaResource | null;

/**
 * Replaces the localhost media-byte hop while leaving the filtered playlist
 * endpoint intact. Implementations receive only opaque, relay-generated IDs;
 * the renderer never gets an API that can proxy an arbitrary URL.
 */
export interface HlsMediaTransport {
  readonly name: "chromium-protocol";
  readonly ready: boolean;
  registerSession(
    sessionToken: string,
    resolveResource: HlsMediaResourceResolver,
  ): () => void;
  resourceUrl(sessionToken: string, resourceId: string): string;
}
