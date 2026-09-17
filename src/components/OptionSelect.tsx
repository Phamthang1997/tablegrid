import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/**
 * A `<select>` the app draws itself.
 *
 * The reason it exists is height: a native `<select>`'s popup is rendered by the OS, so no CSS can
 * cap it — MySQL's 40 character sets came back as a list taller than the window. This one is capped
 * to the space actually available and scrolls, and once the list is longer than `searchThreshold`
 * it grows a filter box, which is faster than scrolling anyway.
 *
 * **The popup is a portal into `<body>`, positioned from the trigger's rect**, and that is not
 * decoration: as an absolutely-positioned child it was clipped by `ModalBody`'s `overflow: auto`,
 * so inside a dialog the list was cut off a few rows down. Same trap — and the same fix — as
 * `SqlEditor`'s result-grid context menu. Being `position: fixed` it does not follow a scrolling
 * ancestor either, so the placement is recomputed on scroll and resize while it is open.
 *
 * Deliberately free of `t()`: the two visible strings are passed in already translated, the same
 * rule `jobs.ts` and `SafeModeRequest.detail` follow.
 */
export interface OptionSelectProps {
  value: string;
  options: string[];
  /** Label of the empty choice, shown when `value` is `''`. */
  emptyLabel: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Filter box appears once the list is longer than this. */
  searchThreshold?: number;
  searchPlaceholder?: string;
  /** Shown when the filter matches nothing. */
  noMatchLabel?: string;
}

/** Tallest the list may get, whatever the space allows. */
const POP_MAX_HEIGHT = 320;
/** Below this the popup opens upward instead — 4 rows is not a list worth reading. */
const POP_MIN_HEIGHT = 150;
const GAP = 4;
const MARGIN = 8;

interface PopPos {
  left: number;
  width: number;
  maxHeight: number;
  /** One of the two is set: `top` grows the list downward, `bottom` upward. */
  top?: number;
  bottom?: number;
}

function placePopup(rect: DOMRect): PopPos {
  const below = window.innerHeight - rect.bottom - GAP - MARGIN;
  const above = rect.top - GAP - MARGIN;
  const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - rect.width - MARGIN));
  const base = { left, width: Math.max(rect.width, 180) };

  if (below >= POP_MIN_HEIGHT || below >= above) {
    return { ...base, top: rect.bottom + GAP, maxHeight: Math.min(POP_MAX_HEIGHT, below) };
  }
  return {
    ...base,
    bottom: window.innerHeight - rect.top + GAP,
    maxHeight: Math.min(POP_MAX_HEIGHT, above),
  };
}

export const OptionSelect: React.FC<OptionSelectProps> = ({
  value,
  options,
  emptyLabel,
  onChange,
  disabled = false,
  searchThreshold = 12,
  searchPlaceholder,
  noMatchLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [pos, setPos] = useState<PopPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const withSearch = options.length > searchThreshold;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, filter]);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (el) setPos(placePopup(el.getBoundingClientRect()));
  }, []);

  // Before the first paint, so the popup never shows up in the wrong place for a frame.
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  // `capture` so a scroll inside ModalBody (which does not bubble) is seen too.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  const close = () => { setOpen(false); setFilter(''); };
  const pick = (next: string) => { onChange(next); close(); };

  return (
    <div className="os-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`form-input os-trigger ${value ? '' : 'placeholder'}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="cm-ellipsis">{value || emptyLabel}</span>
        <ChevronDown size={13} className="os-chev" />
      </button>

      {open && pos && createPortal(
        <>
          <div className="os-backdrop" onMouseDown={close} />
          <div
            className="os-pop"
            role="listbox"
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
            }}
          >
            {withSearch && (
              <input
                type="text"
                className="form-input os-search"
                autoFocus
                value={filter}
                placeholder={searchPlaceholder}
                onChange={(e) => setFilter(e.target.value)}
                // Enter takes the only sensible candidate — the first match — so a charset can be
                // chosen without leaving the keyboard. Esc is stopped here so it closes the popup
                // and not the dialog around it.
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); close(); }
                  if (e.key === 'Enter' && shown.length > 0) pick(shown[0]);
                }}
              />
            )}
            <div className="os-list">
              <button
                type="button"
                className={`os-opt ${value ? '' : 'on'}`}
                role="option"
                aria-selected={!value}
                onClick={() => pick('')}
              >
                <span>{emptyLabel}</span>
                {!value && <Check size={12} style={{ flexShrink: 0 }} />}
              </button>
              {shown.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={`os-opt ${o === value ? 'on' : ''}`}
                  role="option"
                  aria-selected={o === value}
                  onClick={() => pick(o)}
                >
                  <span className="cm-ellipsis">{o}</span>
                  {o === value && <Check size={12} style={{ flexShrink: 0 }} />}
                </button>
              ))}
              {shown.length === 0 && <div className="os-empty">{noMatchLabel}</div>}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
};

export default OptionSelect;
