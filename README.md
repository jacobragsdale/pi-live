# pi-live

Stream a [pi](https://pi.dev) session to colleagues. You run `/live` in pi and send them the one line it prints. They paste it into any terminal, watch your session as it happens, and can suggest prompts. Nothing a guest types reaches the agent unless you put it in your editor and send it yourself.

```
your pi ──wss──▶ relay (AKS) ◀──ssh── guests
```

Your pi stays on your machine and dials out to a relay. Guests connect to the relay over SSH, which draws your session for each of them with pi's own components at their terminal's size. Guests need nothing installed but `ssh`. For how the pieces fit and why, see [How pi-live works](docs/design.md).

## Install

You need pi 1.4.0, Node.js 22.19 or later, and a relay. To deploy one, see [Deploy the relay to AKS](docs/deploy.md); to try pi-live first, [run a relay on your machine](#run-a-relay-on-your-machine).

```bash
git clone https://github.com/jacobragsdale/pi-live ~/dev/pi-live
cd ~/dev/pi-live && npm ci
pi install ~/dev/pi-live
```

Tell pi where the relay is, in `~/.pi/agent/live.json`:

```json
{ "url": "wss://pi-live.example.corp/host" }
```

Then restart pi, or run `/reload`. `PI_LIVE_URL` overrides the file for one shell. To load pi-live for a single session without installing it, run `pi -e ~/dev/pi-live/extensions/live/index.ts`.

## Stream a session

1. Run `/live` in any pi session. Pi prints the join command and copies it to your clipboard:

   ```
   Live. Send this to whoever should watch (copied):
     ssh h3kq7x2mvb5rf4tnw6ydacpe@pi-live-ssh.example.corp
   Run /live again to end the stream.
   ```

2. Send the line to whoever should watch. The footer shows who has joined, for example `● live · alice, bob`.
3. Work as usual. Guests see your prompts, the model's replies and thinking as they stream, tool calls with their output, and compaction summaries.
4. When a guest suggests a prompt, it waits above your editor (`alice: try the migration tests`):
   - `alt+s` puts the first waiting suggestion in your editor, at the cursor if you have a draft. Edit it if you like, and press Enter to send it.
   - `alt+x` dismisses it.

   Either way, the guest sees what you did with it.

5. Run `/live` again to end the stream. Guests are disconnected and the link stops working. Quitting pi ends the stream too.

The stream follows you through `/new`, `/resume`, `/fork` and `/tree`: guests switch to whatever session you are in. A guest who joins late sees the whole current branch.

Anyone with the link can watch. Secrets that look like tokens, keys and passwords are masked before anything leaves your machine, but the masking can miss things. Don't go live in a session that shows secrets. See [What leaves your machine](#what-leaves-your-machine).

## Join a stream

Paste the line you were sent:

```bash
ssh h3kq7x2mvb5rf4tnw6ydacpe@pi-live-ssh.example.corp
```

The first time, ssh asks whether to trust the relay's host key. Type `yes`. The key's fingerprint is in the relay's log, and should match what ssh shows. Then type your name and press Enter.

| Key                                    | Does                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Enter                                  | Sends what you typed to the host as a suggestion. Three can wait at once. |
| `ctrl+o`                               | Expands or collapses tool output.                                         |
| `ctrl+c`, or `ctrl+d` on an empty line | Leaves the stream.                                                        |

Scroll back with your terminal's own scrollback.

## Run a relay on your machine

To try pi-live without a cluster, run the relay locally and point pi at it:

```bash
cd ~/dev/pi-live && npm run relay
```

The relay listens on port 8080 for pi and port 2222 for ssh, and creates `host_key` in the current directory on its first run. In another terminal:

```bash
PI_LIVE_URL=ws://localhost:8080/host pi
```

Run `/live`, then join from a third terminal with the command pi prints, for example `ssh -p 2222 h3kq7x2mvb5rf4tnw6ydacpe@localhost`.

## Commands

| Command         | Does                                                               |
| --------------- | ------------------------------------------------------------------ |
| `/live`         | Starts a stream, or ends the one that is running.                  |
| `/live link`    | Shows the join command again, and copies it.                       |
| `/live use`     | Same as `alt+s`: puts the first waiting suggestion in your editor. |
| `/live dismiss` | Same as `alt+x`: dismisses the first waiting suggestion.           |

`/live` needs pi's interactive UI or an RPC client. It doesn't work in `pi -p`.

## Settings

The extension, on your machine:

| Setting                          | Default             | Meaning                                               |
| -------------------------------- | ------------------- | ----------------------------------------------------- |
| `url` in `~/.pi/agent/live.json` | none                | The relay's WebSocket address, ending in `/host`.     |
| `PI_LIVE_URL`                    | `url` from the file | Overrides `url`.                                      |
| `PI_LIVE_NAME`                   | your login name     | The name guests see, at most 64 characters.           |
| `PI_LIVE=0`                      | on                  | Turns the extension off: no `/live` and no shortcuts. |

The relay, all optional:

| Variable                | Default            | Meaning                                                                                          |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `PI_LIVE_HTTP_PORT`     | `8080`             | Port for hosts' WebSockets (`/host`) and the health check (`/healthz`).                          |
| `PI_LIVE_SSH_PORT`      | `2222`             | Port the SSH server listens on.                                                                  |
| `PI_LIVE_JOIN_HOST`     | `localhost`        | Host name in the join command.                                                                   |
| `PI_LIVE_JOIN_PORT`     | `PI_LIVE_SSH_PORT` | Port in the join command. `22` leaves `-p` out.                                                  |
| `PI_LIVE_HOST_KEY_FILE` | `host_key`         | The SSH host key. Created if missing; the container image expects it at `/etc/pi-live/host_key`. |

Limits: 50 streams per relay, 20 guests per stream, 3 waiting suggestions per guest, 4,000 characters per suggestion, and 32 MiB per message from pi to the relay.

## What leaves your machine

Pi sends the relay what your terminal shows of the conversation:

- your prompts, including `!` commands and their output
- the model's replies and thinking
- tool calls and their results, such as file contents and command output
- compaction and branch summaries, and custom messages extensions display
- your working directory, model and thinking level

It never sends the system prompt, tool definitions, or custom messages extensions hide from the transcript. Images are replaced with `[image not shared]`. Every string passes through the secret masking pi-config uses for `/submit-prompt` before it is sent.

The relay keeps a stream in memory only while you are connected, writes nothing to disk, and logs only names and counts.

## Develop

`npm run check` runs the typecheck, ESLint, Prettier and the tests. The tests start real relays on free ports, connect guests over SSH, and drive pi 1.4.0 in RPC mode with a scripted provider and a throwaway agent directory, so they never touch `~/.pi/agent`.

The relay draws with the pi version pinned in `package.json`. When you upgrade pi, bump `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai` and `pi-agent-core` together, run the tests, and rebuild the relay image. If the versions differ, `/live` warns that guests may see small differences.
