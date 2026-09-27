// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/RepositoryPaths.swift (MIT).

import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { VectorFile } from "./vectorFile.js"

/** The repository root: the nearest ancestor of this file holding package.json and test/vectors. */
export function repositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(directory, "package.json")) && existsSync(join(directory, "test", "vectors"))) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error("repository root not found")
    directory = parent
  }
}

/** `<root>/test/vectors`. */
export const vectorsDirectory = (): string => join(repositoryRoot(), "test", "vectors")

/** Every `*.vec` file under test/vectors, as paths relative to the repository root, sorted. */
export function vectorFiles(): string[] {
  const root = repositoryRoot()
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith(".vec")) out.push(relative(root, path).split("\\").join("/"))
    }
  }
  walk(vectorsDirectory())
  return out.sort()
}

/** Loads a vector by its path relative to the repository root. */
export function loadVector(relativePath: string): VectorFile {
  return VectorFile.load(join(repositoryRoot(), relativePath), relativePath)
}
