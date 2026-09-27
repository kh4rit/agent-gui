# Changelog

## 0.1.0

First release.

- MCP server over stdio for GitHub Copilot CLI (Windows first), VS Code, Claude Code and other
  clients, speaking SAP's DIAG protocol directly: no SAP GUI, no GUI Scripting.
- The DIAG engine is a TypeScript port of Swooey's portable modules (NI framing, LZH/LZC, the DIAG
  codec, the session state machine with its automatic Control Framework answers, the screen
  model), checked by the ported Swift tests, Swooey's byte vectors and end-to-end runs against
  Swooey's fake server.
- Tools: `gui_list_systems`, `gui_connect`, `gui_disconnect`, `gui_screen`, `gui_start`, `gui_step`,
  `gui_table`, `gui_tree`, `gui_grid`, `gui_save`, `gui_wait`.
- The screen as compact text with references (`f…` fields, `k…` functions, `t…` tables,
  `t1:ROW:COLUMN` cells, `c…` controls), technical field names, table controls, lists, popups,
  tabs, trees and grids.
- Logon with the password from the Windows Credential Manager (macOS Keychain, Secret Service) or
  an environment variable; the agent never sees it. A rejected logon suspends automatic logons.
  The multiple-logon question is answered as configured.
- Safety: only `gui_save` commits; read-only systems; transaction allow and deny lists with a
  built-in deny list; OK-codes for the debugger and table editing refused; the transport request
  prompt answered only with the request the user named; an audit log of every step.
- CLI: `--check`, `--call`, `--set-password`, `--forget-password`, `--reset-logon`.
- The agent skill with recipes for transport contents, the IMG, and copying settings to another
  organizational unit; the GitHub Copilot CLI setup guide.
