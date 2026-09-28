# Changelog

## 0.1.1

From the first Windows install (Copilot CLI 1.0.88, Windows PowerShell 5.1).

- The skill loads: its frontmatter was invalid YAML (an unquoted `: ` in the description), so
  Copilot CLI refused it. A test checks every skill's frontmatter.
- Logon while the same user is logged on in SAP GUI: the multiple-logon question is confirmed the
  way SAP GUI confirms it (the Enter event and focus on the chosen option, SW-148), so
  `"whenAlreadyLoggedOn": "continue"` or `"endOthers"` gets past it. Before, the server asked again
  and the logon stopped at SAPMSYST 0500 with a misleading hint at a password change. A question
  asked again now has its own message.
- The DIAG engine is synced with Swooey `d89e12f`, with fixes validated on live systems:
  - lists: the cursor on list screens, for F2 and for other functions (SW-184, SW-186); blank lines
    kept (SW-183, SW-185); box codes after leading markup (SW-152);
  - controls: later calls find their controls by the handle they returned (SW-190); object results
    typed as SAP GUI types them (SW-189); one-way calls in parts (SW-179);
  - the header-only ending that keeps the screen (R-CT-43).
- `gui_step` takes `cursor: "line:N"` for functions that act on the list line under the cursor.
- Guide: quoted paths, the offline test run with the Credential Manager round trip, `${env:…}` in
  every text setting, troubleshooting rows for the logon program's screens.

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
