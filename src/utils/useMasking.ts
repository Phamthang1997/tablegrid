// The masking state an export dialog holds: on/off, and the rules — remembered per database (see
// `loadMaskRules` in masking.ts), so the rules set up once for a production database come back.
import { useCallback, useEffect, useState } from 'react';
import { dbHelper } from './dbHelper';
import { connKeyOfConn } from './safeMode';
import {
  activeRules,
  countActiveRules,
  loadMaskRules,
  newMaskKey,
  saveMaskRules,
  type MaskPlan,
  type MaskRules,
} from './masking';

/**
 * Where a connection's rules are stored: server (`connKey`, credentials excluded) + database +
 * schema. A conn_id is minted fresh on every connect, so it cannot be the key.
 */
async function scopeOf(connId: string): Promise<string> {
  const conn = (await dbHelper.listConnections()).find((c) => c.connId === connId);
  const server = connKeyOfConn(connId) || conn?.serverId || connId;
  return `${server}|${conn?.db ?? ''}|${conn?.schema ?? ''}`;
}

export function useMasking(connId: string) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<{ scope: string | null; rules: MaskRules }>({ scope: null, rules: {} });

  useEffect(() => {
    let cancelled = false;
    void scopeOf(connId).then((scope) => {
      if (!cancelled) setState({ scope, rules: loadMaskRules(scope) });
    });
    return () => {
      cancelled = true;
    };
  }, [connId]);

  const setRules = useCallback((rules: MaskRules) => {
    setState((prev) => {
      if (prev.scope) saveMaskRules(prev.scope, rules);
      return { ...prev, rules };
    });
  }, []);

  return { enabled, setEnabled, rules: state.rules, setRules };
}

/**
 * The plan an export job carries, or null when masking is off. A fresh key per call: one run of
 * an export is one mapping, and nothing about it outlives the run.
 *
 * Masking ON with no rule for the chosen tables is answered with `'empty'` rather than null — the
 * caller must refuse to start, because "on" with nothing to mask would export the real values
 * while the dialog says they are masked.
 */
export function maskPlanFor(enabled: boolean, rules: MaskRules, tables: string[]): MaskPlan | null | 'empty' {
  if (!enabled) return null;
  if (countActiveRules(rules, tables) === 0) return 'empty';
  return { key: newMaskKey(), rules: activeRules(rules, tables) };
}

/** The `mask` function `withMasking` takes, bound to the backend. */
export const maskThroughBackend = (key: string, columns: Record<string, { kind: string; options?: Record<string, unknown> }>, rows: any[]) =>
  dbHelper.maskRows(key, columns, rows);
