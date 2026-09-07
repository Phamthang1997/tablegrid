import React from 'react';
import { Activity, Database } from 'lucide-react';
import { Modal } from './Modal';
import { LiveProcessListPanel, type LiveProcessListPanelProps } from './LiveProcessListPanel';

export interface LiveProcessListModalProps extends LiveProcessListPanelProps {
  onClose: () => void;
}

export const LiveProcessListModal: React.FC<LiveProcessListModalProps> = ({
  onClose,
  ...props
}) => {
  return (
    <Modal
      title={
        <div className="pm-header-title">
          <Activity size={16} className="pm-title-icon" />
          <span>Live Processlist &amp; Query Monitor</span>
          {props.databaseName && (
            <span className="pm-db-chip" title="Active Database">
              <Database size={11} />
              <span>{props.databaseName}</span>
            </span>
          )}
        </div>
      }
      onClose={onClose}
      width="1120px"
      height="760px"
      maxWidth="95vw"
      maxHeight="92vh"
      cardStyle={{
        background: 'var(--win-bg-popover, #ffffff)',
        color: 'var(--win-text-primary)',
        overflow: 'hidden',
      }}
    >
      <LiveProcessListPanel {...props} embedded={true} onClose={onClose} />
    </Modal>
  );
};
