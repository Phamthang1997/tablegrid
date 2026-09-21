import React from 'react';
import { findMatchRange } from '../utils/gridSearch';

/**
 * A cell's text with every quick-search hit wrapped in `<mark class="grid-search-mark">`.
 *
 * Shared by both row grids, which is why it is a component and not a helper returning a string:
 * the text is data and must never be handed to `dangerouslySetInnerHTML`.
 *
 * Recursive rather than a `.map()` over segments, and deliberately so: nesting the remainder means
 * there is no array and therefore no key to invent — a list of text fragments has nothing to be
 * keyed by except its position, which is the very pattern `react/no-array-index-key` flags.
 */
export const SearchHighlight: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const hit = findMatchRange(text, query);
  if (!hit) return <>{text}</>;
  return (
    <>
      {text.slice(0, hit.start)}
      <mark className="grid-search-mark">{text.slice(hit.start, hit.end)}</mark>
      <SearchHighlight text={text.slice(hit.end)} query={query} />
    </>
  );
};
