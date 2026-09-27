// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenModel.swift (MIT).

// ScreenModel: the portable model of one server screen (docs/architecture.md §2, §5).
//
// - `Screen` (screen.ts): built from a decoded server message — DiagSession's `ServerMessage`, or
//   the item sequence of one — with DiagCodec's decoders: the identity texts, the area size, the
//   screen elements in item and atom order (screenElement.ts), the menus (screenMenu.ts), the status
//   message and whether an OK-code item came. Atoms are placed by the container their area names
//   (server-screen.md Reading R-SS-14: `ScreenElement.placement`, `Screen.containers`), and non-input
//   texts lose their leading icon and tooltip markup (dynt-atoms.md Reading R-DA-10: `TextMarkup`,
//   `caption`, `icon`, `tooltip`; screenLayout.ts). Tolerant: a walk that stops keeps what came
//   before it, and `ScreenDiagnostics` counts what was left out. Texts are decoded in the code page in
//   force (CODEPAGE_DIAG_GUI, else the CONNECT one; session.md §6.3, §6.4), with an ISO 8859-1
//   stand-in for a code page Swooey does not know.
// - `FieldEdits` and the command form of `Screen.inputStep` (screenInput.ts): the user's edits become
//   a DiagCodec `ClientInputStep` that returns only the edited fields (client-input.md R-CI-3), their
//   dlg flags as received (R-CI-4) unless the caller switches to the codec's changed marking.
// - `Screen.functions` and `Screen.menuBar` (screenFunction.ts): what the screen offers — the
//   standard toolbar, the application toolbar, the menus and the function-key list of its GUI status
//   (server-screen.md §8.7) and its push buttons and tabs (dynt-atoms.md Reading R-DA-9).
// - `FunctionTrigger` and the trigger form of `Screen.inputStep` (functionTrigger.ts): Enter, a
//   virtual key, a function or a command becomes the step's VARINFO OKCODE or UI_EVENT_SOURCE
//   (client-input.md §7.5). `ScreenReadings` and `FunctionReadings` switch the Readings where the
//   spec is open.
//
// Portable: no Node imports. A password field's text (INVISIBLE, PV-0621) is never decoded, stored
// or printed (IMPL-DA-1): descriptions of the model and of the edits leave it out.
//
// Prototype scope: the screen is an array of element objects, decoded in full per message. The
// struct-of-arrays snapshot, the diff and the cell layout of architecture.md §2 come with the
// renderer (M2).

export {}
