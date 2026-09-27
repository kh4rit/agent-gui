// SPDX-License-Identifier: MIT
// From Swooey Tests/DiagCodecTests/AllVectorsTests.swift (MIT): the table of vectors whose last
// input byte the spec declares insignificant (#43), which TruncationExceptionsTests checks. The
// rest of AllVectorsTests is src/test/vectors.test.ts. Paths are this repository's (test/vectors).

/**
 * Positive vectors whose last input byte the spec itself declares insignificant, with the spec's
 * reason. For these, dropping it must leave the result unchanged. Every other positive vector must
 * fail without its last byte.
 */
export const INSIGNIFICANT_LAST_BYTE: ReadonlyMap<string, string> = new Map([
  // decompress: the stream ends with the final block's end-of-block symbol.
  ["test/vectors/compression/lzh-trailing-bytes-ignored.vec", "bytes after the final block are ignored (PV-0374, IMPL-LZH-5)"],
  ["test/vectors/compression/lzh-fixed-literal-reference-prefix.vec", "the reference trailing 0x00 follows the final block (PV-0374, PV-0375)"],
  // ni-payload, rule 4: only the 12-byte literal decides.
  ["test/vectors/ni/payload-dptmmsg-14.vec", "a dispatcher payload is classified by its 12-byte prefix whatever its length (R-NI-9)"],
  ["test/vectors/ni/payload-dptmopc-17.vec", "a dispatcher payload is classified by its 12-byte prefix whatever its length (R-NI-9)"],
  // ni-payload, rule 5: a shorter payload that still matches none of rules 1–4 is still diag.
  // (Not every diag payload: payload-ping-extra-byte.vec becomes NI_PING\0, a keep-alive.)
  ["test/vectors/ni/payload-diag.vec", "7 zero bytes match none of rules 1-4 either, so they are still diag (rule 5, R-NI-8)"],
  ["test/vectors/ni/payload-ping-without-nul.vec", "NI_PIN matches none of rules 1-4 either, so it is still diag (rule 5, R-NI-8)"],
  // screen-identity: the last item is a trailing EOM, which changes nothing.
  ["test/vectors/server-screen/minimal-screen-step-and-eom.vec", "a trailing EOM changes nothing a screen carries (R-SE-2, R-SS-7)"]
])
