import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { clampMenu, type MenuRect } from '../utils/menuPosition';

/**
 * The right-click menu shared by `DataGrid` and `SqlEditor`'s result grid.
 *
 * Both grids had grown one flat list of ~20 entries, most of them copy formats, so the handful
 * that get used every day (edit, copy the value, open the FK) were buried in the middle and a
 * long menu flipped above the pointer on half the rows. The formats now sit behind submenus.
 *
 * Always rendered through a portal into `document.body`, for the reason `SqlEditor` gives at its
 * old call site: an `overflow` ancestor clips a `position: fixed` menu as soon as anything in
 * between establishes a containing block. The size is MEASURED rather than guessed — the result
 * grid used to hard-code 610/520/320px per shape, which drifted every time an entry was added.
 */

const CloseCtx = createContext<() => void>(() => {});

export const GridContextMenu: React.FC<{
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ x, y, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuRect | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(clampMenu(x, y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [x, y]);

  // Esc closes. Capture phase, so a grid's own window-level Escape handling (dropping the row
  // selection) does not also fire for the keystroke that was meant for the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  return ReactDOM.createPortal(
    <CloseCtx.Provider value={onClose}>
      <div
        ref={ref}
        role="menu"
        className="grid-context-menu"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        style={{ top: pos ? pos.top : y, left: pos ? pos.left : x, visibility: pos ? 'visible' : 'hidden' }}
      >
        {children}
      </div>
    </CloseCtx.Provider>,
    document.body,
  );
};

export const MenuHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="context-menu-heading">{children}</div>
);

export const MenuSeparator: React.FC = () => <div className="context-menu-separator" role="separator" />;

/**
 * One entry. Closes the menu BEFORE running `onSelect`, so a handler that opens a dialog does not
 * render it under a menu that is still on screen for one frame.
 */
export const MenuItem: React.FC<{
  icon?: React.ReactNode;
  label: React.ReactNode;
  /** A shortcut that really does the same thing — never a hint for a binding that does not exist. */
  hint?: string;
  danger?: boolean;
  title?: string;
  onSelect: () => void;
}> = ({ icon, label, hint, danger, title, onSelect }) => {
  const close = useContext(CloseCtx);
  return (
    <button
      role="menuitem"
      className={`context-menu-item${danger ? ' is-danger' : ''}`}
      title={title}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      <span>{icon}</span>
      {label}
      {hint && <kbd className="context-menu-hint">{hint}</kbd>}
    </button>
  );
};

/**
 * A flyout. Opens on hover (and on click, for a trackpad tap), and flips to the left / shifts up
 * when it would leave the window — measured on open, like the root menu.
 *
 * The flyout is a DOM child of the wrapper, so moving the pointer from the trigger onto it never
 * leaves the wrapper and the `mouseleave` that closes it does not fire on the way.
 */
export const MenuSub: React.FC<{
  icon?: React.ReactNode;
  label: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, label, children }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ flip: boolean; top: number } | null>(null);
  // Closing clears the placement in the same update, so the next open measures from scratch.
  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (!next) setPlace(null);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current?.getBoundingClientRect();
    const pop = popRef.current?.getBoundingClientRect();
    if (!wrap || !pop) return;
    const margin = 8;
    const flip = wrap.right + pop.width + margin > window.innerWidth;
    // -5 lines the first entry up with the trigger (the flyout's own 4px padding + border).
    let top = -5;
    const overflow = wrap.top + top + pop.height + margin - window.innerHeight;
    if (overflow > 0) top -= overflow;
    if (wrap.top + top < margin) top = margin - wrap.top;
    setPlace({ flip, top });
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className="context-menu-sub"
      onMouseEnter={() => setOpenState(true)}
      onMouseLeave={() => setOpenState(false)}
    >
      <button
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`context-menu-item${open ? ' is-open' : ''}`}
        onClick={() => setOpenState(!open)}
      >
        <span>{icon}</span>
        {label}
        <span className="context-menu-hint context-menu-chevron">›</span>
      </button>
      {open && (
        <div
          ref={popRef}
          role="menu"
          className="grid-context-menu grid-context-submenu"
          style={{
            top: place ? place.top : -5,
            ...(place?.flip ? { right: '100%' } : { left: '100%' }),
            visibility: place ? 'visible' : 'hidden',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
