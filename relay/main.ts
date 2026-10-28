/**
 * Starts the relay. Settings, all optional:
 *
 *   PI_LIVE_HTTP_PORT      port for hosts' WebSockets and /healthz (8080)
 *   PI_LIVE_SSH_PORT       port the SSH server listens on (2222)
 *   PI_LIVE_JOIN_HOST      host name in the join command guests run (localhost)
 *   PI_LIVE_JOIN_PORT      port in the join command; 22 leaves -p out (PI_LIVE_SSH_PORT)
 *   PI_LIVE_HOST_KEY_FILE  the SSH host key; created on first run if missing (host_key)
 *
 * Keep the host key across restarts (in Kubernetes, in a Secret): when it
 * changes, every guest's ssh warns that the relay's identity changed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ssh2 from "ssh2";
import { Relay } from "./relay.ts";

const log = (line: string): void => {
  console.log(`${new Date().toISOString()} ${line}`);
};

function port(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be a port number, not ${value}`);
  }
  return parsed;
}

function loadHostKey(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, "utf8");
  }
  const { private: key } = ssh2.utils.generateKeyPairSync("ed25519");
  try {
    writeFileSync(path, key, { mode: 0o600 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`there is no SSH host key at ${path} and the relay couldn't create one (${reason}). In Kubernetes, create the pi-live-host-key Secret first; see docs/deploy.md.`, { cause: err });
  }
  log(`created a new SSH host key in ${path}`);
  return key;
}

/** The fingerprint ssh shows guests on their first connection, so they can check it. */
function fingerprint(key: string): string {
  const parsed = ssh2.utils.parseKey(key);
  if (parsed instanceof Error) {
    throw new Error(`can't read the SSH host key: ${parsed.message}`);
  }
  return `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

async function main(): Promise<void> {
  const sshPort = port("PI_LIVE_SSH_PORT", 2222);
  const hostKey = loadHostKey(process.env["PI_LIVE_HOST_KEY_FILE"] ?? "host_key");
  const relay = new Relay({
    httpPort: port("PI_LIVE_HTTP_PORT", 8080),
    sshPort,
    hostKey,
    joinHost: process.env["PI_LIVE_JOIN_HOST"] ?? "localhost",
    joinPort: port("PI_LIVE_JOIN_PORT", sshPort),
    log
  });
  const ports = await relay.listen();
  log(`pi-live relay: hosts connect to ws://<this host>:${String(ports.http)}/host; guests join over ssh on port ${String(ports.ssh)}; host key ${fingerprint(hostKey)}`);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      log(`${signal}: closing`);
      relay.close().then(
        () => process.exit(0),
        () => process.exit(1)
      );
    });
  }
}

main().catch((err: unknown) => {
  log(`can't start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
