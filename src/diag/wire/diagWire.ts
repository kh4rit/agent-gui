// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/DiagWire.swift (MIT).

// DiagWire: NI framing, payload classification and keep-alive (docs/protocol/ni-framing.md) and
// the 200-byte DP header of the client's first message (docs/protocol/dp-header.md).

/**
 * Numbers of spec-gap issues (Swooey `issues/NNNN-*.md`) at which a code path stops.
 *
 * These are issue-tracker numbers, not protocol values. A path that needs a fact the spec does
 * not state throws an error (or returns a case) that names its issue instead of guessing.
 */
export const SpecGapIssue = {
  /** Dispatcher frames: the bytes after the literal, their meaning and the client's reaction. */
  niDispatcherFrames: 3, // not-protocol: issue number, issues/0003
  /** UTF-16 error text: byte order, termination, error text with compression. */
  diagErrorText: 8 // not-protocol: issue number, issues/0008
} as const
