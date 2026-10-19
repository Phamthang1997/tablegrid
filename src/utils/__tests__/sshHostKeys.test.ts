import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  knownHostsId,
  setHostKeyConfirmer,
  withHostKeyTrust,
  type HostKeyChallenge,
} from '../sshHostKeys';

type Result = { success: boolean; message?: string };

const challenge = (status: HostKeyChallenge['status']): HostKeyChallenge => ({
  host: 'db.example',
  port: 2222,
  status,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
});

afterEach(() => setHostKeyConfirmer(null));

describe('withHostKeyTrust', () => {
  it('asks once, then retries after the key is trusted', async () => {
    const attempt = vi
      .fn<() => Promise<Result>>()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });
    const confirm = vi.fn().mockResolvedValue(true);
    setHostKeyConfirmer(confirm);
    const read = vi.fn().mockResolvedValue(challenge('unknown'));

    const res = await withHostKeyTrust(read, 'db.example', 2222, attempt, (r) => !r.success);
    expect(res).toEqual({ success: true });
    expect(read).toHaveBeenCalledWith('db.example', 2222);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('returns the original failure when no key was refused', async () => {
    const attempt = vi.fn<() => Promise<Result>>().mockResolvedValue({ success: false, message: 'wrong password' });
    const confirm = vi.fn();
    setHostKeyConfirmer(confirm);
    const res = await withHostKeyTrust(async () => null, 'h', undefined, attempt, (r) => !r.success);
    expect(res.message).toBe('wrong password');
    expect(confirm).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error when the user declines', async () => {
    setHostKeyConfirmer(async () => false);
    const attempt = vi.fn().mockRejectedValue('untrusted');
    await expect(
      withHostKeyTrust(async () => challenge('changed'), 'h', 22, attempt)
    ).rejects.toBe('untrusted');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('shows a key changed in ~/.ssh/known_hosts but never retries it', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    setHostKeyConfirmer(confirm);
    const attempt = vi.fn().mockRejectedValue('changed');
    await expect(
      withHostKeyTrust(async () => challenge('changedOpenSsh'), 'h', 22, attempt)
    ).rejects.toBe('changed');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops after two rounds of refused keys', async () => {
    setHostKeyConfirmer(async () => true);
    const attempt = vi.fn().mockRejectedValue('untrusted');
    await expect(
      withHostKeyTrust(async () => challenge('unknown'), 'h', 22, attempt)
    ).rejects.toBe('untrusted');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does nothing extra without an SSH host', async () => {
    const read = vi.fn();
    setHostKeyConfirmer(async () => true);
    await expect(withHostKeyTrust(read, '  ', 22, async () => 1, () => true)).resolves.toBe(1);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('knownHostsId', () => {
  it('uses the known_hosts spelling', () => {
    expect(knownHostsId(' DB.Example ', 22)).toBe('db.example');
    expect(knownHostsId('10.0.0.5', 2222)).toBe('[10.0.0.5]:2222');
  });
});
