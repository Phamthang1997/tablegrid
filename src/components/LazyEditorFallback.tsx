import React from 'react';

/**
 * Placeholder shown while a lazily-imported Monaco editor chunk is being fetched.
 *
 * Deliberately wordless: the wait is one chunk fetch off local disk (~200ms once, then the
 * module is cached and every later mount resolves synchronously), and a label would mean a
 * translation key for something almost nobody reads. It fills the panel so the surrounding
 * flex layout does not collapse and then snap back when the editor arrives.
 */
/**
 * The same job for a lazily-loaded **dialog** (`RowDocumentModal`).
 *
 * `LazyEditorFallback` carries `flex: 1` and a background of its own, which is right for a panel —
 * but a dialog renders through a portal and the fallback does not, so using that one would insert a
 * block into the middle of the grid's layout and then remove it when the chunk arrives. This one is
 * `position: fixed`, so it pushes nothing aside while still signalling that the click registered.
 */
export const LazyModalFallback: React.FC = () => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      zIndex: 10000,
    }}
  >
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" className="loading-spinner">
      <circle cx="12" cy="12" r="10" style={{ stroke: 'var(--win-border-strong)' }} strokeWidth="3" opacity="0.2" />
      <path
        d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
        style={{ stroke: 'var(--win-accent)' }}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  </div>
);

export const LazyEditorFallback: React.FC = () => (
  <div
    style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--win-bg-window)',
    }}
  >
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" className="loading-spinner">
      <circle cx="12" cy="12" r="10" style={{ stroke: 'var(--win-border-strong)' }} strokeWidth="3" opacity="0.2" />
      <path
        d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
        style={{ stroke: 'var(--win-accent)' }}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  </div>
);
