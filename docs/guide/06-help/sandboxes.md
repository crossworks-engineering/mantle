---
title: Sandboxes
toolGroups: [sandboxes]
---

## Sandboxes

Persistent containers the assistant can run commands in, and the history of
every command it ran.

A sandbox exists so the assistant can do work that needs a real machine,
converting a file, running a script, trying a command, without that work
touching your brain's host. It's a container: things installed inside it stay
inside it, and destroying it destroys everything it accumulated.

Persistent is the operative word. A sandbox keeps its filesystem between
commands, so a multi-step job that installs something and then uses it works.
That also means a sandbox left running accumulates state indefinitely.

## Assistant

- "Convert these files to CSV in a sandbox."
- "What did you run in there?"

Every command and its output is recorded here, which is the point: shell access
is the most consequential thing the assistant can hold, and the trade is that
none of it is invisible. Reading the history is how you audit it.

## Technical

Isolation is the container boundary. A sandbox has its own filesystem and
process space, and it does not have your database credentials or your master
key, so a command run inside one cannot read your sealed data, whatever it
does.

Command history is stored per sandbox with its output, so the record survives
the container. Destroying a sandbox removes the environment, not the log of
what happened in it.

Sandbox access is its own tool group, deliberately separate from everything
else. It's excluded from the team responder's grant entirely, and the same
reasoning applies to any agent you're not confident about: shell access widens
what a mistake can cost more than any other capability.

Containers left idle consume resources on the host, so treat them as workspaces
to be finished with rather than long-lived machines. Nothing on this screen
expires them for you.
