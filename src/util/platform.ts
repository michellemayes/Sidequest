import { homedir } from "node:os";
import { join } from "node:path";

export type Platform = "darwin" | "linux" | "win32" | "other";

export function platform(): Platform {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "win32";
    default:
      return "other";
  }
}

/**
 * The command used to hand a URI to the OS so Warp can pick it up.
 * Returns null on platforms we have no opener for.
 */
export function uriOpener(): { command: string; args: string[] } | null {
  switch (platform()) {
    case "darwin":
      return { command: "open", args: [] };
    case "linux":
      return { command: "xdg-open", args: [] };
    case "win32":
      // `start` is a cmd.exe builtin; the empty string is the window title slot,
      // without which cmd treats a quoted URI as the title and opens nothing.
      return { command: "cmd", args: ["/c", "start", ""] };
    default:
      return null;
  }
}

/**
 * Warp's per-platform data directory, where launch configs and tab configs live.
 *
 * macOS/Linux paths are documented; Windows keeps Warp data under APPDATA.
 * See https://docs.warp.dev/terminal/sessions/tab-configs
 */
function warpDataDir(preview: boolean): string {
  switch (platform()) {
    case "linux": {
      const xdg = process.env.XDG_DATA_HOME?.trim();
      const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
      return join(base, preview ? "warp-preview" : "warp-terminal");
    }
    case "win32": {
      const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
      return join(appData, "warp", preview ? "Warp-Preview" : "Warp", "data");
    }
    default:
      return join(homedir(), preview ? ".warp-preview" : ".warp");
  }
}

/** Where Warp keeps launch configuration YAML files. */
export function warpLaunchConfigDir(preview = false): string {
  return join(warpDataDir(preview), "launch_configurations");
}

/** Where Warp keeps the newer Tab Config TOML files. */
export function warpTabConfigDir(preview = false): string {
  return join(warpDataDir(preview), "tab_configs");
}

/** URI scheme prefix; the Preview build listens on warppreview://. */
export function warpScheme(preview = false): string {
  return preview ? "warppreview" : "warp";
}
