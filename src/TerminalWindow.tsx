import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { TerminalPanel } from './components/TerminalPanel';
import { SshHostKeyGate } from './components/SshHostKeyGate';
import type { DbConnectionConfig } from './utils/dbHelper';

// Root for standalone OS window containing only the Terminal (opened via openTerminalWindow -> ?term=<json>).
export const TerminalWindow: React.FC<{ raw: string }> = ({ raw }) => {
  let config: DbConnectionConfig = { type: 'sqlite' };
  let profileName: string | undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    config = parsed.config || config;
    profileName = parsed.profileName;
  } catch {
    /* corrupt payload -> fallback to default local shell */
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#1c1c1e' }}>
      <TerminalPanel
      // Standalone terminal window has no SQL connection of its own; log commands will
      // report "not connected" rather than attaching to an unintended ambient connection.
      connId=""
        config={config}
        profileName={profileName}
        inOwnWindow
        onClose={() => { void getCurrentWindow().close(); }}
      />
      {/* This window has its own React root, so the SSH host key prompt must be mounted here too. */}
      <SshHostKeyGate />
    </div>
  );
};
