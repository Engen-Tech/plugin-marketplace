import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function resolvePackagePath(relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new Error(`Hatch package path must be non-empty and relative: ${relativePath}`);
  }
  const target = resolve(PACKAGE_ROOT, relativePath);
  const fromRoot = relative(PACKAGE_ROOT, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Hatch package path escapes its package root: ${relativePath}`);
  }
  return target;
}

export function requirePackagePath(relativePath: string): string {
  const target = resolvePackagePath(relativePath);
  if (!existsSync(target)) {
    throw new Error(`Hatch package asset is missing: ${relativePath}`);
  }
  return target;
}
