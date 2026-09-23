import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';

/**
 * The copy button every EXPLAIN view shares. `getText` is called on click rather than passed as
 * a string, so a view never builds its text on every render just in case someone copies it.
 */
export const ExplainCopyButton: React.FC<{ getText: () => string; label: string }> = ({ getText, label }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  return (
    <button type="button" className="btn btn-secondary explain-copy-btn" onClick={onClick}>
      {copied ? <Check size={13} className="explain-copy-ok" /> : <Copy size={13} />}
      <span>{copied ? t('explain.copied') : label}</span>
    </button>
  );
};

/** The strip above a table view: the copy button on the right, anything else on the left. */
export const ExplainToolbar: React.FC<{ children?: React.ReactNode; copy: React.ReactNode }> = ({ children, copy }) => (
  <div className="explain-toolbar">
    <div className="explain-toolbar-left">{children}</div>
    {copy}
  </div>
);
