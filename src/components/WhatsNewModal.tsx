import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  DatabaseBackup,
  FileClock,
  FileCode,
  FileSpreadsheet,
  KeyRound,
  Lock,
  Minus,
  Share2,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { Modal, ModalBody } from './Modal';

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The release these slides describe. The dialog shows itself once per release — it compares what
 * was last seen with this — so bump it whenever the slides change, or returning users never see
 * them. (The old key, `tablegrid_whats_new_seen_v1`, was a plain flag: once set, no later release
 * could show anything.)
 */
export const WHATS_NEW_RELEASE = '2026-09';
export const WHATS_NEW_STORAGE_KEY = 'tablegrid_whats_new_seen';
export const WHATS_NEW_AUTO_SHOW_KEY = 'tablegrid_whats_new_auto_show';

/** A mock window around a slide's preview. */
const PreviewWindow: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({
  icon,
  title,
  children,
}) => (
  <div className="whats-new-window-container">
    <div className="whats-new-window-titlebar">
      <div className="whats-new-window-title">
        {icon}
        <span>{title}</span>
      </div>
      <div className="whats-new-window-controls">
        <Minus size={11} />
        <Square size={10} />
        <X size={11} />
      </div>
    </div>
    <div className="wn-body">{children}</div>
  </div>
);

/** A progress bar at `pct` percent. */
const Bar: React.FC<{ pct: number }> = ({ pct }) => (
  <div className="wn-bar">
    <span style={{ width: `${pct}%` }} />
  </div>
);

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [activeSlide, setActiveSlide] = useState(0);
  const [showOnStartup, setShowOnStartup] = useState<boolean>(() => {
    const saved = localStorage.getItem(WHATS_NEW_AUTO_SHOW_KEY);
    return saved !== null ? saved === 'true' : true;
  });

  const slidesData = [
    {
      id: 'jobs',
      title: t('whatsNew.jobsTitle'),
      description: t('whatsNew.jobsDesc'),
      renderPreview: () => (
        <PreviewWindow icon={<Bell size={13} className="wn-accent" />} title={t('whatsNew.jobsPreviewTitle')}>
          <div className="wn-row">
            <DatabaseBackup size={13} className="wn-accent" />
            <span className="wn-grow">{t('whatsNew.jobsRowRestore')}</span>
            <span className="wn-muted">64%</span>
          </div>
          <Bar pct={64} />
          <div className="wn-row">
            <FileSpreadsheet size={13} className="wn-accent" />
            <span className="wn-grow">{t('whatsNew.jobsRowImport')}</span>
            <span className="wn-muted">12,480 / 40,000</span>
          </div>
          <Bar pct={31} />
          <div className="wn-row">
            <Check size={13} className="wn-ok" />
            <span className="wn-grow">{t('whatsNew.jobsRowExport')}</span>
            <span className="wn-muted">{t('whatsNew.jobsDone')}</span>
          </div>
          <div className="wn-row wn-note">
            <Bell size={12} />
            <span>{t('whatsNew.jobsNotify')}</span>
          </div>
        </PreviewWindow>
      ),
    },
    {
      id: 'restore',
      title: t('whatsNew.restoreTitle'),
      description: t('whatsNew.restoreDesc'),
      renderPreview: () => (
        <PreviewWindow icon={<DatabaseBackup size={13} className="wn-accent" />} title={t('whatsNew.restorePreviewTitle')}>
          <div className="wn-card">
            <div className="wn-row">
              <FileCode size={14} className="wn-accent" />
              <span className="wn-grow wn-mono">demo-20250901.dump</span>
              <span className="wn-tag">133 MB</span>
            </div>
            <div className="wn-muted wn-small">{t('whatsNew.restoreVia')}</div>
          </div>
          <div className="wn-checks">
            {['bookings', 'flights', 'tickets', 'boarding_passes', 'airports', 'seats'].map((name) => (
              <label key={name} className="wn-check">
                <Check size={11} className="wn-ok" /> <span className="wn-mono">{name}</span>
              </label>
            ))}
          </div>
          <div className="wn-row">
            <span className="wn-grow">{t('whatsNew.restoreProgress')}</span>
            <span className="wn-muted">42%</span>
          </div>
          <Bar pct={42} />
        </PreviewWindow>
      ),
    },
    {
      id: 'import',
      title: t('whatsNew.importTitle'),
      description: t('whatsNew.importDesc'),
      renderPreview: () => (
        <PreviewWindow icon={<FileSpreadsheet size={13} className="wn-accent" />} title={t('whatsNew.importPreviewTitle')}>
          <div className="wn-grid wn-grid-head">
            <span>{t('whatsNew.importColTable')}</span>
            <span>{t('whatsNew.importColFile')}</span>
            <span>{t('whatsNew.importColSample')}</span>
          </div>
          {[
            ['customer_id · int', 'ID', '1042'],
            ['email · varchar(50)', 'E-mail', 'an@example.com'],
            ['created_at · date', 'Signup date', '2026-09-05'],
          ].map(([col, src, sample]) => (
            <div key={col} className="wn-grid">
              <span className="wn-mono">{col}</span>
              <span className="wn-mapped">
                <ArrowRight size={10} /> {src}
              </span>
              <span className="wn-muted wn-mono">{sample}</span>
            </div>
          ))}
          <div className="wn-row wn-warn-row">
            <AlertTriangle size={12} />
            <span>{t('whatsNew.importIssue')}</span>
          </div>
        </PreviewWindow>
      ),
    },
    {
      id: 'copy',
      title: t('whatsNew.copyTitle'),
      description: t('whatsNew.copyDesc'),
      renderPreview: () => (
        <PreviewWindow icon={<Copy size={13} className="wn-accent" />} title={t('whatsNew.copyPreviewTitle')}>
          <div className="wn-copy">
            <div className="wn-card wn-center">
              <div className="wn-muted wn-small">{t('whatsNew.copySource')}</div>
              <div className="wn-mono">sakila</div>
              <div className="wn-tag">MySQL · 23 {t('whatsNew.copyTables')}</div>
            </div>
            <ArrowRight size={18} className="wn-accent" />
            <div className="wn-card wn-center">
              <div className="wn-muted wn-small">{t('whatsNew.copyTarget')}</div>
              <div className="wn-mono">sakila_backup</div>
              <div className="wn-tag">MySQL</div>
            </div>
          </div>
          <Bar pct={78} />
        </PreviewWindow>
      ),
    },
    {
      id: 'vault',
      title: t('whatsNew.vaultTitle'),
      description: t('whatsNew.vaultDesc'),
      renderPreview: () => (
        <PreviewWindow icon={<Lock size={13} className="wn-accent" />} title={t('whatsNew.vaultPreviewTitle')}>
          <div className="wn-lock">
            <KeyRound size={28} className="wn-accent" />
            <div className="wn-lock-field">••••••••••••</div>
            <div className="wn-lock-btn">{t('whatsNew.vaultUnlock')}</div>
            <div className="wn-muted wn-small">{t('whatsNew.vaultNote')}</div>
          </div>
        </PreviewWindow>
      ),
    },
    {
      id: 'mermaid',
      title: t('whatsNew.mermaidTitle'),
      description: t('whatsNew.mermaidDesc'),
      renderPreview: () => (
        <PreviewWindow icon={<Share2 size={13} className="wn-accent" />} title="sakila_schema.md">
          <div className="whats-new-code-body">
            {[
              '```mermaid',
              'erDiagram',
              '    customer {',
              '        int customer_id PK',
              '        int store_id FK',
              '        varchar(50) email "may be empty"',
              '    }',
              '    store ||..o{ customer : "fk_customer_store"',
              '    customer ||..o{ payment : "fk_payment_customer"',
              '```',
            ].map((line, i) => (
              <div key={line} className="whats-new-code-line">
                <span className="whats-new-line-num">{i + 1}</span>
                <span className={line.includes('||') ? 'wn-accent' : undefined}>{line}</span>
              </div>
            ))}
          </div>
        </PreviewWindow>
      ),
    },
    {
      id: 'history',
      title: t('whatsNew.historyTitle'),
      description: t('whatsNew.historyDesc'),
      renderPreview: () => (
        <PreviewWindow icon={<FileClock size={13} className="wn-accent" />} title={t('whatsNew.historyPreviewTitle')}>
          {[
            [t('whatsNew.historyRun'), '14:32'],
            [t('whatsNew.historyBeforePaste'), '14:10'],
            [t('whatsNew.historyClosed'), '11:58'],
          ].map(([what, when]) => (
            <div key={what} className="wn-row">
              <FileClock size={12} className="wn-muted" />
              <span className="wn-grow">{what}</span>
              <span className="wn-muted wn-mono">{when}</span>
            </div>
          ))}
          <div className="whats-new-code-body">
            <div className="whats-new-code-line wn-del">- SELECT * FROM orders</div>
            <div className="whats-new-code-line wn-add">+ SELECT id, total FROM orders WHERE paid</div>
          </div>
        </PreviewWindow>
      ),
    },
  ];
  const totalSlides = slidesData.length;

  useEffect(() => {
    queueMicrotask(() => {
      if (isOpen) {
        setActiveSlide(0);
      }
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setActiveSlide((prev) => (prev > 0 ? prev - 1 : totalSlides - 1));
      } else if (e.key === 'ArrowRight') {
        setActiveSlide((prev) => (prev < totalSlides - 1 ? prev + 1 : 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, totalSlides]);

  if (!isOpen) return null;

  const handleClose = () => {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, WHATS_NEW_RELEASE);
    localStorage.setItem(WHATS_NEW_AUTO_SHOW_KEY, showOnStartup ? 'true' : 'false');
    onClose();
  };

  const handleToggleStartup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.checked;
    setShowOnStartup(val);
    localStorage.setItem(WHATS_NEW_AUTO_SHOW_KEY, val ? 'true' : 'false');
  };

  const currentSlide = slidesData[activeSlide];

  return (
    <Modal
      title={t('whatsNew.modalHeader')}
      icon={<Sparkles size={16} style={{ color: 'var(--win-accent)' }} />}
      onClose={handleClose}
      width="780px"
      height="560px"
      maxWidth="94vw"
      maxHeight="92vh"
    >
      <ModalBody className="whats-new-modal-body">
        {/* Feature Preview Window Mockup */}
        <div className="whats-new-preview-wrapper">
          {currentSlide.renderPreview()}
        </div>

        {/* Single Horizontal Divider Line */}
        <div className="whats-new-divider" />

        {/* Feature Info & Control Cluster (Single Unified Group) */}
        <div className="whats-new-cluster">
          {/* Title & Description */}
          <div className="whats-new-info-section">
            <h2 className="whats-new-title">
              {currentSlide.title}
            </h2>
            <p className="whats-new-desc">
              {currentSlide.description}
            </p>
          </div>

          {/* Single Unified Bottom Row */}
          <div className="whats-new-bottom-row">
            {/* Left: Checkbox */}
            <label className="whats-new-startup-label">
              <input
                type="checkbox"
                checked={showOnStartup}
                onChange={handleToggleStartup}
                className="whats-new-checkbox"
              />
              {t('whatsNew.showOnStartup')}
            </label>

            {/* Center: Navigation Arrows & Dots Indicator */}
            <div className="whats-new-nav-controls">
              <button
                onClick={() => setActiveSlide((prev) => (prev > 0 ? prev - 1 : totalSlides - 1))}
                className="whats-new-nav-btn"
                title={t('whatsNew.prevSlide')}
              >
                <ChevronLeft size={15} />
              </button>

              {/* Dots Indicator */}
              <div className="whats-new-dots-container">
                {slidesData.map((slide, idx) => (
                  <button
                    key={slide.id}
                    onClick={() => setActiveSlide(idx)}
                    className={`whats-new-dot-btn ${idx === activeSlide ? 'active' : ''}`}
                  />
                ))}
              </div>

              <button
                onClick={() => setActiveSlide((prev) => (prev < totalSlides - 1 ? prev + 1 : 0))}
                className="whats-new-nav-btn"
                title={t('whatsNew.nextSlide')}
              >
                <ChevronRight size={15} />
              </button>
            </div>

            {/* Right: Close Button */}
            <div className="whats-new-close-wrapper">
              <button onClick={handleClose} className="whats-new-close-btn">
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
};
