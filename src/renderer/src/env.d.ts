import type { DesktopApi } from "../../shared/player";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};
