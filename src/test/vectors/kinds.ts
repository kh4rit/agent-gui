// SPDX-License-Identifier: MIT
// Which vector kinds run, and why the others wait.
//
// Each `*Runners.ts` module registers its kinds when imported. A port adds its import here and
// removes its kinds from PENDING_KINDS in the same change.

import "./wireRunners.js"

/** Kinds without a runner yet, each with the reason the harness gives when it skips them. */
export const PENDING_KINDS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // DiagCompression and DiagCodec
    decompress: "DiagCompression not ported yet",
    "compression-header": "DiagCodec not ported yet",
    "diag-header": "DiagCodec not ported yet",
    "diag-error-body": "DiagCodec not ported yet",
    items: "DiagCodec not ported yet",
    "simple-item-fields": "DiagCodec not ported yet",
    connect: "DiagCodec not ported yet",
    "support-bits": "DiagCodec not ported yet",
    "dialog-step": "DiagCodec not ported yet",
    "dynt-atoms": "DiagCodec not ported yet",
    "appl-fields": "DiagCodec not ported yet",
    "imode-uuids": "DiagCodec not ported yet",
    "dynt-focus": "DiagCodec not ported yet",
    "stringz-fields": "DiagCodec not ported yet",
    "menu-entries": "DiagCodec not ported yet",
    "screen-identity": "DiagCodec not ported yet",
    "rfc-items": "DiagCodec not ported yet",
    // The Control Framework kinds Swooey itself does not run yet (VectorRunner.pendingKinds).
    "control-properties": "no implementation in Swooey until M5",
    "rfc-table-content": "no implementation in Swooey until M5",
    "rfc-compressed-table": "no implementation in Swooey until M5",
    "cfw-verbs": "no implementation in Swooey until M5",
    "cfw-descriptors": "no implementation in Swooey until M5",
    "cfw-values": "no implementation in Swooey until M5",
    datamanager: "no implementation in Swooey until M5",
    "alv-catalog": "no implementation in Swooey until M5",
    "alv-rows": "no implementation in Swooey until M5",
    "alv-colour-cells": "no implementation in Swooey until M5"
  })
)
