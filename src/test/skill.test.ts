// SPDX-License-Identifier: MIT
// The skills' frontmatter must be valid YAML: Copilot CLI refuses a skill whose frontmatter does
// not parse (an unquoted value with ": " in it did, on the first Windows install).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { repositoryRoot } from "./vectors/paths.js"

const skills = join(repositoryRoot(), "skills")

/** Why `value` is no safe one-line YAML scalar, or undefined when it is one. */
function scalarProblem(value: string): string | undefined {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return "a double-quoted value must end with a quote"
    if (/(^|[^\\])"/.test(value.slice(1, -1))) return "an unescaped quote inside a double-quoted value"
    return undefined
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return "a single-quoted value must end with a quote"
    if (/'(?!')/.test(value.slice(1, -1).replace(/''/g, ""))) return "an unescaped quote inside a single-quoted value"
    return undefined
  }
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return "a plain value must not start with a YAML indicator"
  if (value.includes(": ") || value.endsWith(":")) return 'a plain value must not contain ": " (quote it)'
  if (value.includes(" #")) return 'a plain value must not contain " #" (quote it)'
  return undefined
}

for (const name of readdirSync(skills)) {
  test(`skills/${name}/SKILL.md has valid frontmatter`, () => {
    const text = readFileSync(join(skills, name, "SKILL.md"), "utf8")
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
    assert.ok(match, "the file starts with a --- frontmatter block")
    const keys = new Map<string, string>()
    for (const line of match[1].split("\n")) {
      const entry = /^([a-z][a-z0-9-]*): (.+)$/.exec(line)
      assert.ok(entry, `one "key: value" per line: ${line}`)
      assert.equal(scalarProblem(entry[2]), undefined, `${entry[1]}: ${scalarProblem(entry[2])}`)
      keys.set(entry[1], entry[2])
    }
    assert.equal(keys.get("name"), name, "name is the folder's name")
    assert.ok((keys.get("description") ?? "").length > 20, "a description")
  })
}

test("the frontmatter check refuses what YAML refuses", () => {
  assert.match(scalarProblem("Tools (DIAG protocol): log on") ?? "", /quote it/)
  assert.match(scalarProblem("a value # with a comment") ?? "", /quote it/)
  assert.match(scalarProblem("[not a list") ?? "", /indicator/)
  assert.match(scalarProblem('"an "inner" quote"') ?? "", /unescaped/)
  assert.equal(scalarProblem('"Tools (DIAG protocol): log on"'), undefined)
  assert.equal(scalarProblem("'it''s fine: quoted'"), undefined)
  assert.equal(scalarProblem("Read, search and write ABAP objects."), undefined)
})
