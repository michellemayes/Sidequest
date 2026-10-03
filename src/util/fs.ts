import { readFile, stat } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

export async function readFileOrEmpty(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}
