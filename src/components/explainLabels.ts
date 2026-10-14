import type { ExplainFlag } from '../utils/explainHelper';

// Shared by the diagram and the comparison view, so a flag reads the same in both.
// A switch, not a template — i18next keys are type-checked and must stay literal.
export function flagLabelKey(flag: ExplainFlag) {
  switch (flag) {
    case 'fullTableScan': return 'explain.flagFullTableScan' as const;
    case 'noIndexUsed': return 'explain.flagNoIndexUsed' as const;
    case 'coveringIndex': return 'explain.flagCoveringIndex' as const;
    case 'indexCondition': return 'explain.flagIndexCondition' as const;
    case 'joinBuffer': return 'explain.flagJoinBuffer' as const;
    case 'temporaryTable': return 'explain.flagTemporaryTable' as const;
    case 'filesort': return 'explain.flagFilesort' as const;
    case 'neverExecuted': return 'explain.flagNeverExecuted' as const;
    case 'rowsMisestimated': return 'explain.flagRowsMisestimated' as const;
    case 'subqueriesHidden': return 'explain.flagSubqueriesHidden' as const;
    case 'cartesianJoin': return 'explain.flagCartesianJoin' as const;
  }
}
