// Cross-platform test entry point.
//
// `node --test dist/**/*.test.js` relies on the shell expanding the glob, which
// cmd.exe / PowerShell on Windows do not do, and Node 20 does not expand globs
// itself. So the test files are listed explicitly, recursively under dist/test.
//
// Arguments filter the files: `node scripts/test.mjs wire codec` runs only the
// test files whose path contains "wire" or "codec".
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const root = join("dist", "test")

function collect(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...collect(path))
    else if (name.endsWith(".test.js")) out.push(path)
  }
  return out
}

const filters = process.argv.slice(2)
const files = collect(root).filter(f => !filters.length || filters.some(x => f.includes(x)))

if (files.length === 0) {
  console.error(`No test files found in ${root}${filters.length ? ` matching ${filters.join(", ")}` : ""}`)
  process.exit(1)
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
process.exit(result.status ?? 1)
