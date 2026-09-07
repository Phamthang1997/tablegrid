import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { dbHelper } from '../utils/dbHelper';

/** One parked write, as `mcp/approval.rs` emits it. */
interface ApprovalRequest {
  id: string;
  tool: string;
  connectionId: string;
  database: string;
  dialect: string;
  sql: string;
  timeoutMs: number;
}

/**
 * The dialog defence layer 5 asks through — the MCP twin of `SafeModeGate`.
 *
 * **Same mechanism, different policy** (`docs/mcp-server-plan.md` §3.5). Safe Mode registers a
 * confirmer because it is already running on the UI thread when it needs to ask; an MCP request is
 * on an axum task in Rust, so it arrives as an event and is answered by a command. What the two
 * share is the shape of the question and the rule that one prompt means one action.
 *
 * There is no "don't ask again" here and there is no mode that turns it off. Safe Mode has three
 * levels because the user is the one typing; nothing about "stop asking me about my own statements"
 * extends to a statement an outside service wrote.
 */
export const McpApprovalGate: React.FC = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const [remaining, setRemaining] = useState(0);
  /** When the request on screen stops being answerable, in epoch ms. */
  const deadline = useRef(0);

  useEffect(() => {
    const subs = [
      listen<ApprovalRequest>('mcp-approval-request', (e) => {
        // Appended, not replaced: two clients can be parked at once and answering one must not
        // silently discard the other. Rust holds each in its own channel, so the order here is
        // presentation only.
        setQueue((q) => (q.some((r) => r.id === e.payload.id) ? q : [...q, e.payload]));
      }),
      // The request stopped being answerable without the user (today: it timed out). Dropping it is
      // the whole point — leaving buttons on screen for a refused request means an Approve that
      // appears to do nothing.
      listen<{ id: string }>('mcp-approval-resolved', (e) => {
        setQueue((q) => q.filter((r) => r.id !== e.payload.id));
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()).catch(() => { /* window is going away */ }));
    };
  }, []);

  const current = queue[0];

  // The countdown is honest about one thing only: how long is left before Rust refuses this by
  // itself. It never answers on the user's behalf — the backend owns that deadline, and a second
  // timer racing it would be two sources of truth for one decision.
  useEffect(() => {
    if (!current) return;
    deadline.current = Date.now() + current.timeoutMs;
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [current]);

  if (!current) return null;

  const answer = async (approved: boolean) => {
    setQueue((q) => q.filter((r) => r.id !== current.id));
    try {
      await dbHelper.mcpApprovalRespond(current.id, approved);
    } catch {
      // The request timed out between the click and the IPC. Nothing ran, the client already has its
      // refusal, and there is nothing useful to tell the user that the disappearing dialog has not.
    }
  };

  const danger = 'var(--win-danger, #ef4444)';

  return (
    <Modal
      title={t('mcp.approvalTitle')}
      icon={<AlertTriangle size={14} style={{ color: danger, flexShrink: 0 }} />}
      onClose={() => answer(false)}
      width="620px"
      maxWidth="92%"
      // Above SafeModeGate's 100000: this one is on a clock, and a dialog the user cannot see is a
      // dialog that times out.
      zIndex={100001}
    >
      <ModalBody>
        <div style={{ fontSize: '12.5px', color: 'var(--win-text-primary)', lineHeight: 1.6 }}>
          {t('mcp.approvalIntro')}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
          <span style={{ color: 'var(--win-text-secondary)' }}>{t('mcp.approvalTarget')}</span>
          <span className="mcp-conn-db">{current.database}</span>
          <span className="mcp-dialect-badge">{current.dialect}</span>
        </div>

        {/* The one thing the user cannot see from the SQL itself, and the reason §3.5 required this
            dialog to say it out loud: an MCP write runs on a pooled connection, so it is committed
            the moment it succeeds and the Rollback button on the title bar cannot reach it. */}
        <div
          style={{
            display: 'flex',
            gap: '10px',
            padding: '10px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            lineHeight: 1.55,
            color: 'var(--win-status-deleted-border)',
            background: 'var(--win-status-deleted)',
            border: '1px solid var(--win-status-deleted-border)',
          }}
        >
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>{t('mcp.approvalNoUndo')}</div>
        </div>

        <pre
          style={{
            margin: 0,
            maxHeight: '280px',
            overflow: 'auto',
            padding: '12px 14px',
            background: 'var(--win-bg-tab-bar)',
            border: '1px solid var(--win-border)',
            borderRadius: '6px',
            fontFamily: 'var(--win-font-mono, monospace)',
            fontSize: '11.5px',
            lineHeight: 1.55,
            color: 'var(--win-text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {current.sql}
        </pre>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '11px', color: 'var(--win-text-secondary)' }}>
          <span>{t('mcp.approvalCountdown', { n: remaining })}</span>
          {queue.length > 1 && <span>{t('mcp.approvalMore', { n: queue.length - 1 })}</span>}
        </div>
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={() => answer(false)}>
          {t('mcp.approvalDeny')}
        </button>
        {/* Danger styling, like `ConfirmDialog`'s destructive branch: this button is the last thing
            between an outside service and the user's data. */}
        <button
          className="btn btn-primary"
          onClick={() => answer(true)}
          style={{ background: danger, borderColor: danger }}
        >
          {t('mcp.approvalApprove')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
