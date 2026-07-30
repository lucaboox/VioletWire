export interface LinkPreview {
  kind: "twitch-clip" | "kick-clip" | "youtube" | "imgur-album" | "generic";
  title: string;
  author: string;
  thumbnailUrl?: string;
  /** Channel/user portraits should not be cropped like video thumbnails. */
  thumbnailPresentation?: "cover" | "avatar";
  url: string;
  description?: string;
  durationSeconds?: number;
  createdAt?: string;
  viewCount?: number;
}
