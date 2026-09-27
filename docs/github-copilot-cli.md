# Setting up `agent-gui` for GitHub Copilot CLI

How to get SAP GUI access into the Copilot CLI on a Windows machine. It takes about 10 minutes. The commands use
PowerShell; on macOS and Linux adapt the paths and the environment-variable syntax.

## 1. Prerequisites

- **Node.js 20 or newer** (`node -v`).
- **GitHub Copilot CLI** (`copilot --version`).
- An SAP user on a system where agents may work, and network access to its application server's
  dispatcher port (32NN for instance NN, the port SAP GUI uses).

## 2. Install

```powershell
git clone https://github.com/kh4rit/agent-gui.git $env:USERPROFILE\tools\agent-gui
cd $env:USERPROFILE\tools\agent-gui
npm install          # also builds, via the prepare script
```

## 3. Describe your systems

Save the following as `%USERPROFILE%\.agent-gui\systems.json`:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agent-gui" | Out-Null
```

```json
{
  "defaultSystem": "DEV",
  "systems": {
    "DEV": {
      "host": "sap-dev.example.com",
      "instance": "00",
      "client": "100",
      "user": "YOURUSER",
      "language": "EN",
      "password": "${credential}",
      "transactions": { "allow": ["SPRO", "SM30", "SM34", "SE16", "SE09", "SE10", "SE11"] }
    },
    "QAS": {
      "host": "sap-qas.example.com",
      "instance": "00",
      "client": "100",
      "user": "YOURUSER",
      "password": "${credential}",
      "readOnly": true
    }
  }
}
```

| Field | Meaning |
|---|---|
| `host` | The application server, as in SAP Logon's connection entry (application server). |
| `instance` or `port` | Instance number 00–99 (port 32NN), or the port itself. |
| `client`, `user`, `language` | Logon client, SAP user, logon language. |
| `password` | `"${credential}"` reads it from the Windows Credential Manager (step 4). `"${env:NAME}"` reads an environment variable. |
| `readOnly` | `true` refuses every save. **Set it on QA and production.** |
| `transactions.allow` | Only these transactions may be used. Without it, everything except a built-in deny list (user administration, RFC destinations, OS commands, transport administration, program execution …) is allowed. |
| `transactions.deny` | Extra transactions to refuse. |
| `commitFunctions` | Function codes that save or post besides Save (Ctrl+S), e.g. `["BU"]`; `gui_step` refuses them. |
| `whenAlreadyLoggedOn` | `fail` (default), `continue` (keep other logons) or `endOthers`. |
| `identity` | What the client declares when it connects; `reference` (default) is the one known to work. |
| `idleLogoffMinutes`, `maxSessions`, `stepTimeoutSeconds` | Session housekeeping (defaults 15, 2, 60). |

## 4. Store the password and check the logon

```powershell
$env:AGENT_GUI_CONFIG="$env:USERPROFILE\.agent-gui\systems.json"
node $env:USERPROFILE\tools\agent-gui\dist\index.js --set-password --system DEV
node $env:USERPROFILE\tools\agent-gui\dist\index.js --check
```

- `--set-password` asks for the password without echo and stores it in the Windows Credential Manager
  as `agent-gui:DEV`.
- `--check` logs on to every system, prints the first screen after the logon, and logs off.

**Do not continue until `--check` prints `OK`.**

A rejected password is never retried automatically: the account is marked suspended so that an
agent cannot lock your SAP user. Run `--set-password` again (or `--reset-logon --system DEV`
after fixing an `${env:…}` password) to try again.

## 5. Register the MCP server with Copilot CLI

```powershell
copilot mcp add agent-gui `
  --env "AGENT_GUI_CONFIG=$env:USERPROFILE\.agent-gui\systems.json" `
  --timeout 180000 `
  -- node "$env:USERPROFILE\tools\agent-gui\dist\index.js"
```

Check with `copilot mcp list`, or `/mcp` inside a session.

### Approvals

Only `gui_save` commits data. A good setup lets the agent read and navigate freely and asks you
before every save:

```powershell
copilot --allow-tool 'agent-gui(gui_list_systems)' --allow-tool 'agent-gui(gui_connect)' `
  --allow-tool 'agent-gui(gui_screen)' --allow-tool 'agent-gui(gui_start)' --allow-tool 'agent-gui(gui_step)' `
  --allow-tool 'agent-gui(gui_table)' --allow-tool 'agent-gui(gui_tree)' --allow-tool 'agent-gui(gui_grid)' `
  --allow-tool 'agent-gui(gui_wait)' --allow-tool 'agent-gui(gui_disconnect)'
```

## 6. Register the skill

The skill tells the agent how to work with SAP screens, transports and the IMG:

```powershell
copilot skill add $env:USERPROFILE\tools\agent-gui\skills
```

## 7. Smoke test

Start `copilot` and ask:

> Log on to DEV, open SE16 for table T000 and tell me which clients exist.

The agent should call `gui_connect`, `gui_step` and `gui_table`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `copilot mcp list` shows the server but no tools | The server crashed at startup: run `node …\dist\index.js --check` manually; config errors go to stderr. |
| `Could not connect` / timeout | Host or port wrong, or a firewall. Use the application server and instance from SAP Logon. Message-server logons (logon groups) and SAProuter strings are not supported yet. |
| `logon suspended` | A logon was rejected: `--set-password` (or `--reset-logon`) after checking the password. |
| `already logged on` | Set `whenAlreadyLoggedOn` to `continue`, or log off the other session. |
| A transaction is refused | It is on the deny list or not on the allow list of that system. |

## Files this setup creates

| Path | Purpose | Contains secrets? |
|---|---|---|
| `~/.agent-gui/systems.json` | System definitions | No, with `${credential}` or `${env:…}` |
| Windows Credential Manager `agent-gui:<system>` | The password | **Yes**, protected by Windows |
| `~/.agent-gui/state.json` | Suspended logons after a rejected password | No |
| `~/.agent-gui/audit/<date>.jsonl` | What the agent did, step by step | Field values, no passwords |
| `~/.copilot/mcp-config.json` | MCP server registration | No |
