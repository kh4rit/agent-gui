// SPDX-License-Identifier: MIT
import { createRequire } from "node:module"

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string }

export const SERVER_NAME: string = pkg.name
export const SERVER_VERSION: string = pkg.version
