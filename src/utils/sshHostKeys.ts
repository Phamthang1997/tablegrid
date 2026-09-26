/**
 * The question "do you trust this SSH server's key?", asked from `dbHelper` and answered by
 * `SshHostKeyGate`. Same shape as Safe Mode's confirmer: this module has no React, so the gate
 * registers itself, and every connect path that can open an SSH session gets the prompt without
 * knowing a dialog exists.
 *
 * Why the question comes AFTER a failed connect rather than during it: see `ssh/known_hosts.rs`.
 * The handshake cannot wait for a person, so the key is refused, parked in Rust, read back here by
 * host and port, and the connect is retried once it is trusted.
 */

export type HostKeyStatus = 'unknown' | 'changed' | 'changedOpenSsh';

export interface HostKeyChallenge {
  host: string;
  port: number;
  status: HostKeyStatus;
  algorithm: string;
  fingerprint: string;
}

/** Reads a refused key back; injected so this module imports no `@tauri-apps/api`. */
export type ChallengeReader = (host: string, port: number) => Promise<HostKeyChallenge | null>;

/**
 * Resolves `true` only once the key is TRUSTED AND SAVED. The gate saves it itself, so a failed
 * write is shown in the dialog next to the fingerprint rather than surfacing as a connect error.
 */
type Confirmer = (challenge: HostKeyChallenge) => Promise<boolean>;

let confirmer: Confirmer | null = null;

export function setHostKeyConfirmer(fn: Confirmer | null): void {
  confirmer = fn;
}

/** The `known_hosts` spelling of a host, which is also what `ssh-keygen -R` takes. */
export function knownHostsId(host: string, port: number): string {
  const h = host.trim().toLowerCase();
  return port === 22 ? h : `[${h}]:${port}`;
}

/**
 * Runs `attempt`, and when it fails with a host key the backend refused, asks the user and runs it
 * again. `failed` says whether a RESOLVED result is a failure (`connect` answers `{ success: false }`
 * rather than throwing). A thrown error is always a failure.
 *
 * Retried at most twice: a server whose key changes between two attempts is not one to keep
 * reconnecting to, and the second refusal is shown like any other error.
 */
export async function withHostKeyTrust<T>(
  readChallenge: ChallengeReader,
  host: string | undefined,
  port: number | undefined,
  attempt: () => Promise<T>,
  failed: (result: T) => boolean = () => false,
): Promise<T> {
  const sshHost = host?.trim();
  const sshPort = port || 22;
  // Recursive rather than a loop: each round waits on the previous one by nature (connect, ask,
  // connect again), which is not the "sequential for no reason" `no-await-in-loop` looks for.
  const run = async (round: number): Promise<T> => {
    let result: T | undefined;
    let error: unknown;
    let threw = false;
    try {
      result = await attempt();
      if (!failed(result)) return result;
    } catch (e) {
      threw = true;
      error = e;
    }
    const giveUp = (): T => {
      if (threw) throw error;
      return result as T;
    };
    const ask = confirmer;
    if (!sshHost || round >= 2 || !ask) return giveUp();
    let challenge: HostKeyChallenge | null = null;
    try {
      challenge = await readChallenge(sshHost, sshPort);
    } catch {
      /* no answer means no key was refused: fall through to the original failure */
    }
    if (!challenge) return giveUp();
    // A changed key recorded in `~/.ssh/known_hosts` is still shown — the dialog explains the
    // `ssh-keygen -R` the user has to run — but it can never be trusted from here.
    if (challenge.status === 'changedOpenSsh') {
      await ask(challenge);
      return giveUp();
    }
    return (await ask(challenge)) ? run(round + 1) : giveUp();
  };
  return run(0);
}
