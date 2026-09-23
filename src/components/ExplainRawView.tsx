import React from 'react';
import { useTranslation } from 'react-i18next';
import { ExplainCopyButton, ExplainToolbar } from './ExplainCopyButton';

interface ExplainRawViewProps {
  rawText: string;
}

export const ExplainRawView: React.FC<ExplainRawViewProps> = ({ rawText }) => {
  const { t } = useTranslation();

  return (
    <div className="explain-view">
      <ExplainToolbar copy={<ExplainCopyButton getText={() => rawText} label={t('explain.copyRaw')} />} />
      {/* Selectable, so a single line of the plan can be copied as well as the whole of it. */}
      <pre className="explain-raw explain-selectable">{rawText}</pre>
    </div>
  );
};
