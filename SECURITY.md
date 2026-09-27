# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab of
this repository), not in a public issue. Include what you found and how to reproduce it without
data from a real SAP system. We aim to answer within a week and to publish a fix and an advisory
within 90 days.

Vulnerabilities in SAP software itself go to SAP.

## What agent-gui protects

- **Passwords** come from the operating system's credential store or an environment variable,
  travel to the store on stdin (never on a command line), and are never part of a tool's
  arguments or results, the audit log or the trace. The logon step is wiped after it is written.
- **Logon attempts:** a rejected password suspends automatic logons until the password is stored
  again, so that an agent cannot lock the SAP user.
- **Committing:** only `gui_save` saves. The transaction policy, read-only systems and the audit log
  are guard rails; the SAP user's authorisations are the real limit.

## What it does not protect

- DIAG connections are not encrypted by agent-gui. Use it on networks where SAP GUI's own
  unencrypted connections are acceptable.
- Everything the agent reads on a screen is sent to the model provider of the agent host.
- The audit log holds the field values the agent typed (set `"audit": { "values": false }` to leave
  them out).
