import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { warpLaunchConfigDir, warpTabConfigDir } from "../util/platform.js";

/** Colors Warp accepts for a tab. */
export type WarpColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";

export interface WarpSessionSpec {
  /** Unique, lowercase name; the deeplink resolves against this. */
  name: string;
  title: string;
  color: WarpColor;
  cwd: string;
  /** Command run when the tab opens. */
  command: string;
}

/**
 * Write a Launch Configuration YAML.
 *
 * `warp://launch/<x>` matches the `name` field case-insensitively rather than
 * the file path (warpdotdev/warp#15003), so name and filename are kept equal.
 */
export async function writeLaunchConfig(spec: WarpSessionSpec, preview: boolean): Promise<string> {
  const dir = warpLaunchConfigDir(preview);
  await mkdir(dir, { recursive: true });

  const doc = {
    name: spec.name,
    windows: [
      {
        tabs: [
          {
            title: spec.title,
            // Launch configs take capitalised color names.
            color: capitalize(spec.color),
            layout: {
              cwd: spec.cwd,
              is_focused: true,
              commands: [{ exec: spec.command }],
            },
          },
        ],
      },
    ],
  };

  await writeFile(join(dir, `${spec.name}.yaml`), stringifyYaml(doc), "utf8");
  return spec.name;
}

/**
 * Write a Tab Config TOML. `warp://tab_config/<x>` matches the filename stem,
 * case-insensitively.
 */
export async function writeTabConfig(spec: WarpSessionSpec, preview: boolean): Promise<string> {
  const dir = warpTabConfigDir(preview);
  await mkdir(dir, { recursive: true });

  const toml = [
    `name = ${tomlString(spec.name)}`,
    `title = ${tomlString(spec.title)}`,
    `color = ${tomlString(spec.color)}`,
    "",
    "[[panes]]",
    `id = "main"`,
    `type = "terminal"`,
    `directory = ${tomlString(spec.cwd)}`,
    `commands = [${tomlString(spec.command)}]`,
    `is_focused = true`,
    "",
  ].join("\n");

  await writeFile(join(dir, `${spec.name}.toml`), toml, "utf8");
  return spec.name;
}

/** TOML basic string: escape backslashes, quotes and control characters. */
export function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(
      /[\u0000-\u001f\u007f]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return `"${escaped}"`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
