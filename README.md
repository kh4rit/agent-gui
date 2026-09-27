# agent-gui

SAP GUI transactions for AI agents. An [MCP](https://modelcontextprotocol.io) server that gives
GitHub Copilot, Claude Code, Cursor and any other MCP client the SAP GUI screens of a real SAP
system, over the DIAG protocol that SAP GUI itself speaks:

- **log on** with the user's stored credential (the agent never sees a password)
- **start transactions** and **read screens**: title, status message, fields with their technical
  names, table controls, lists, popups, tabs and function keys
- **fill in and submit** screens: fields, checkboxes, radio buttons, dropdowns, table-control
  cells and row marks, function keys, toolbar buttons, menu functions, F2 and F4
- **work with trees and grids** built by the Control Framework, such as the SPRO/IMG tree and the SAP
  Easy Access menu
- **save** into the transport request the user names, with a separate tool that the agent host asks
  about every time

No SAP GUI installation, no GUI Scripting, no screen scraping: agent-gui talks to the
application server's dispatcher port directly. It is the sibling of
[agent-adt](https://github.com/kh4rit/agent-adt) (ABAP code over ADT) and runs the same way:
Node.js, one `npm install`, stdio MCP.

The DIAG engine is a TypeScript port of the portable modules of the Swooey project, an open-source
clean-room DIAG client ([docs/porting.md](docs/porting.md)).

## Requirements

- Node.js 20 or newer (Windows, macOS or Linux)
- An SAP user on a system where agents may work, and network access to the application server's
  dispatcher port (32NN for instance NN; the port SAP GUI uses)

## Installation

```bash
git clone https://github.com/kh4rit/agent-gui.git
cd agent-gui
npm install          # also builds, via the prepare script
```

## Configuration

`~/.agent-gui/systems.json` (`%USERPROFILE%\.agent-gui\systems.json` on Windows), or a file named by
`AGENT_GUI_CONFIG` / `--config`:

```json
{
  "defaultSystem": "DEV",
  "systems": {
    "DEV": {
      "host": "sap-dev.example.com", "instance": "00",
      "client": "100", "user": "YOURUSER", "language": "EN",
      "password": "${credential}",
      "transactions": { "allow": ["SPRO", "SM30", "SM34", "SE16", "SE09", "SE10", "SE11"] }
    },
    "QAS": {
      "host": "sap-qas.example.com", "instance": "00", "client": "100", "user": "YOURUSER",
      "password": "${env:SAP_QAS_PASSWORD}", "readOnly": true
    }
  }
}
```

`"${credential}"` reads the password from the Windows Credential Manager (the macOS Keychain, or
the Secret Service on Linux). Store it once:

```bash
agent-gui --set-password --system DEV
agent-gui --check
```

Every setting is described in the [GitHub Copilot CLI guide](docs/github-copilot-cli.md). For a
single system, the environment variables `SAP_HOST`, `SAP_INSTANCE` (or `SAP_PORT`), `SAP_CLIENT`,
`SAP_USER`, `SAP_PASSWORD`, `SAP_LANGUAGE` and `SAP_READ_ONLY` work too.

## Using it

- **GitHub Copilot CLI (Windows):** follow [docs/github-copilot-cli.md](docs/github-copilot-cli.md).
  It covers configuration, the password, MCP registration, tool approvals and the skill.
- **VS Code / Copilot Chat:** [examples/vscode-mcp.json](examples/vscode-mcp.json).
- **Claude Code:** `claude mcp add sapgui --env AGENT_GUI_CONFIG=/path/systems.json -- node /path/agent-gui/dist/index.js`

The [agent skill](skills/agent-gui/SKILL.md) tells the agent how to work with SAP screens, transport
requests, the IMG, and copying settings from one organizational unit to another.

## Tools

| Tool | What it does |
|---|---|
| `gui_list_systems` | Configured systems and open sessions |
| `gui_connect` | Log on (or open another session) and return the first screen; optionally start a transaction |
| `gui_disconnect` | Log off a session or a whole system |
| `gui_screen` | The current screen: identity, message, functions `k…`, fields `f…`, tables `t…`, lists, tabs, controls `c…` |
| `gui_start` | Start a transaction (`/n`), or in a new session (`/o`) |
| `gui_step` | One dialog step: set fields, table cells and row marks, then Enter, a key, a function, an OK-code, F2 or F4 |
| `gui_table` | Read table-control rows or list lines beyond the visible page |
| `gui_tree` | Tree controls: read, select, open, expand, find |
| `gui_grid` | ALV grids: read, open a cell |
| `gui_save` | Save, answering the transport-request prompt with the request the user named |
| `gui_wait` | Wait for a long-running step |

`--call <tool> --args <json|@file|->` runs one tool from the command line, for scripts and checks.

## Safety

A GUI agent can do whatever its SAP user can: **the user's authorisations are the real limit.** Use
a display-only user where the agent should only look. agent-gui adds guard rails:

- **Only `gui_save` commits.** `gui_step` refuses Save (Ctrl+S, whatever function the screen binds
  to it) and the function codes in `commitFunctions`. Let your agent host ask before every
  `gui_save`.
- **`readOnly: true`** turns a system into a display-only connection.
- **Transaction policy.** An allow list per system, and a built-in deny list:
  - user and role administration;
  - RFC destinations and OS commands;
  - transport administration and client settings;
  - program execution and database utilities.
  
  It is checked against the transaction the server reports on every screen.
- **Transport requests** are never created or chosen by the agent: `gui_save` uses the one the user
  named, and cancels the request prompt otherwise.
- **The password never passes through the agent.** A rejected logon is not retried automatically,
  so a looping agent cannot lock the SAP user.
- **Audit log.** Every step is written to `~/.agent-gui/audit/<date>.jsonl` (field values, never
  passwords).

These are guard rails, not guarantees: some transactions write on Enter or F8, and no deny list is
complete. Everything the agent reads on a screen goes to the model provider.

## Status

Early development (0.0.x). The DIAG engine is a file-by-file port of Swooey's Swift modules,
checked by their ported unit tests, Swooey's language-independent byte vectors and end-to-end runs
against Swooey's loopback fake server. What is confirmed on live systems follows Swooey's own
validation. Table controls, function keys other than Execute, and the IMG tree are still to be
confirmed there ([docs/PLAN.md](docs/PLAN.md) §3).

Not supported yet: message-server logons (logon groups), SAProuter strings, password changes at
logon, editable ALV grids.

## Development

```bash
npm run build     # compile TypeScript to dist/
npm test          # build and run the offline test suite
```

End-to-end tests run against Swooey's fake DIAG server when `AGENT_GUI_FAKE_SERVER` names its
binary; they are skipped otherwise. Development agents connect only to that loopback server
([AGENTS.md](AGENTS.md)).

Source layout:
- `src/diag/wire`, `compression`, `codec`, `session`, `screen`: the DIAG engine (port of Swooey)
- `src/engine`: the Node transport and the session loop (modes, logon, steps, paging, controls)
- `src/config.ts`, `credentials.ts`, `policy.ts`, `audit.ts`, `snapshot.ts`, `sessions.ts`: the host
- `src/tools.ts`, `server.ts`, `index.ts`: MCP tools, server, CLI

## Notice

agent-gui is an independent open-source project. It is not affiliated with, sponsored by, endorsed
by, or certified by SAP SE or any SAP affiliate company. SAP, SAP NetWeaver, ABAP, SAP S/4HANA and
other SAP products and services mentioned are the trademarks or registered trademarks of SAP SE or
its affiliates in Germany and in other countries. Use of this software requires appropriate SAP
licences for any system you connect to; it does not grant or change any SAP licence rights.

## License

[MIT](LICENSE)
