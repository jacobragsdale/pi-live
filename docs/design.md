# How pi-live works

pi-live puts a relay between a host's pi and the people watching it. The host's pi does all the work it always did, on the host's machine, and streams what its transcript shows to the relay. The relay draws that transcript for each guest over SSH, using pi's own components. A guest can only watch, and suggest prompts that the host chooses to send.

## Guests suggest; the host decides

A host's pi runs shell commands with the host's credentials: their Copilot login, `az` and agent-cli sessions, their files. It also spends the host's money. Letting a guest's text reach the agent directly would give every guest those powers, so pi-live doesn't. A suggestion waits above the host's editor until the host loads it into the editor and presses Enter. At that point it is the host's prompt: it goes through the budget guard, it is billed to the host, and the host can edit it first. Guests also can't press the host's keys: they can't answer dialogs, abort a run, or run `!` commands.

The same reasoning keeps the agent on the host's workstation rather than in the cluster. "Join my session" means the session the host already has open, in their repo, with their tools. Running sessions in pods would mean cloning repos into the cluster and putting Copilot credentials there, which is a different product.

## The relay holds a stream only while the host is connected

Pi 1.4.0 has no way for another process to attach to a running interactive session, so the host's pi has to send everything out itself. The extension dials out to the relay over a WebSocket, which also suits a corporate network: nothing needs to reach into WSL.

On connecting, and whenever the branch changes underneath it (a `/tree` jump, `/new`, `/resume`), pi sends the whole current branch. After that it appends entries as pi saves them, sends the assistant message being streamed up to ten times a second, and sends tool progress as it arrives. The relay keeps the latest picture of each stream in memory, so a guest who joins late is drawn from it without asking the host for anything. The picture goes when the host disconnects. The relay writes nothing to disk.

Keeping streams in one process's memory is what makes the relay a single replica. A second pod would need the hosts and guests of each stream to land on the same pod, and nothing routes SSH that way. A restart ends every stream; hosts start a new one, with a new link.

pi sends each streamed message as a whole snapshot rather than as text deltas. A snapshot costs more bytes, but it lets the secret masking see each string complete. A token split across two deltas would slip past a pattern that checks one delta at a time.

## Why SSH

Guests join with plain `ssh`, which every WSL distribution, Windows 10 and later, and macOS already have. They install nothing, run no downloaded code, and keep their own terminal.

The relay draws for them with the components pi uses for its own transcript: user messages, the model's markdown and thinking, tool calls with the built-in renderers for reads, edits and commands. Each guest gets their own full-screen pi-tui screen at their terminal's size, laid out the way pi lays out its own full-screen mode. pi's footer reads the host's live session, which the relay doesn't have, so the host's pi sends the facts it draws from (directory, branch, token use, context, model) and the relay draws them in pi's format. pi's interactive mode itself can't be reused that way. It assumes it owns the process's stdin, stdout and signal handlers, so the relay builds a smaller viewer from the same parts. The cost is that the relay depends on pi's internal UI. Its pi version is pinned, and has to be bumped and rebuilt alongside the hosts' pi. A host on a different version gets a warning when they go live.

The alternatives each failed one of the requirements:

- **Sharing the terminal** (tmate, upterm, sshx) gives every guest the host's keyboard, or read-only access with no way to suggest anything, and every guest is stuck at the host's terminal size.
- **A downloaded client** needs Node.js or a signed binary for every platform on the guest's machine, and corporate endpoint protection tends to block piping unsigned downloads into a shell.
- **A browser page** needs no install, but it isn't a terminal one-liner, and it would need a rework of pi's HTML export renderer, which pi ships as a single bundled script.

The viewer only needs a byte stream with a size, so a browser view through xterm.js on the same renderer stays open as a later addition. That is the fallback if a network can't carry SSH.

## Who can host and who can watch

Anyone who can reach the relay can start a stream, and anyone with a link can watch it, without the host admitting them. That keeps joining to one pasted line, at a cost the host should understand. A forwarded link is a live view of whatever the host's session shows, including file contents and command output. The protections are:

- The link is 120 random bits, and it dies when the stream ends.
- The footer's `● live · alice, bob` shows who is watching.
- Secrets are masked on the host's machine before they are sent. This uses pi-config's patterns for tokens, keys, passwords and connection strings, which can miss things.
- The system prompt, tool definitions and hidden extension messages are never sent, and images are replaced with a placeholder.

The relay validates everything a host sends before drawing it, because any host on the network could send it anything. A message missing the fields pi's components read is dropped, and a component that fails to draw shows a placeholder for that guest instead of breaking their screen.

## Our own protocol

The pi project publishes experimental `pi-server`, `pi-protocol` and `pi-client` packages for sessions with several clients attached. pi-live doesn't use them. They target sessions the server itself hosts, not a terminal session that is already running. They have no peer authentication, and they make no compatibility promises. pi-live's protocol is twelve JSON message types, listed with their meaning in `src/protocol.ts`. Each end checks every message it receives against the TypeBox schemas in that file, and a protocol version in the first message lets the relay refuse a host it doesn't understand.

For setting it up, see [Deploy the relay to AKS](deploy.md). For using it, see the [README](../README.md).
