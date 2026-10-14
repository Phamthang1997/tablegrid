import React, { useState, useEffect, useMemo } from 'react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import { Play, Save, Copy, CheckCircle, AlertTriangle, Code } from 'lucide-react';
import { type RoutineParam, parseRoutineParameters, getDefaultValueForType } from '../utils/routineParamParser';

export type { RoutineParam };

interface RoutineEditorModalProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  name: string;
  kind: 'procedure' | 'function';
  initialSql: string;
  onClose?: () => void;
  onSaved?: () => void;
  embedded?: boolean;
}

export const RoutineEditorModal: React.FC<RoutineEditorModalProps> = ({
  connId,
  name,
  kind,
  initialSql,
  onClose,
  onSaved,
  embedded = false,
}) => {
  const [sql, setSql] = useState<string>(initialSql);
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Parsed Parameters
  const parsedParams = useMemo(() => parseRoutineParameters(sql), [sql]);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [rawFallbackParams, setRawFallbackParams] = useState<string>('');

  const [testResults, setTestResults] = useState<{ query: string; columns: string[]; data: any[] }[] | null>(null);
  const [testing, setTesting] = useState<boolean>(false);

  // Initialize paramValues when parsedParams change
  useEffect(() => {
    queueMicrotask(() => {
      setParamValues(prev => {
        const initial: Record<string, string> = {};
        parsedParams.forEach(p => {
          if (p.mode === 'IN' || p.mode === 'INOUT') {
            initial[p.name] = prev[p.name] !== undefined ? prev[p.name] : getDefaultValueForType(p.type);
          }
        });
        return initial;
      });
    });
  }, [parsedParams]);

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const res = await dbHelper.saveRoutineDefinition(connId, sql);
    setSaving(false);
    if (res.success) {
      setSuccessMsg(res.error || 'Đã lưu Routine thành công');
      onSaved?.();
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi lưu Routine');
    }
  };

  const handleTestExecute = async () => {
    setTesting(true);
    setTestResults(null);
    setErrorMsg(null);

    let combinedSql = '';

    if (parsedParams.length > 0) {
      // Structured execution
      const callArgs: string[] = [];
      const outSelectVars: string[] = [];

      parsedParams.forEach(p => {
        if (p.mode === 'IN' || p.mode === 'INOUT') {
          const rawVal = (paramValues[p.name] ?? '').trim();
          const pTypeUpper = p.type.toUpperCase();
          const isNumeric = /^(INT|TINYINT|SMALLINT|MEDIUMINT|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|INTEGER|BIT)$/i.test(pTypeUpper.split('(')[0].trim());

          let formattedVal = rawVal;
          if (rawVal === 'NULL' || rawVal === '') {
            formattedVal = 'NULL';
          } else if (!isNumeric) {
            if (!/^['"].*['"]$/.test(rawVal)) {
              formattedVal = `'${rawVal.replace(/'/g, "''")}'`;
            }
          }
          callArgs.push(formattedVal);
        } else {
          // OUT or INOUT parameter: assign session variable @var_name
          const varName = `@${p.name}`;
          callArgs.push(varName);
          outSelectVars.push(`${varName} AS \`${p.name}\``);
        }
      });

      if (kind === 'procedure') {
        combinedSql = `CALL ${name}(${callArgs.join(', ')});`;
        if (outSelectVars.length > 0) {
          combinedSql += `\nSELECT ${outSelectVars.join(', ')};`;
        }
      } else {
        combinedSql = `SELECT ${name}(${callArgs.join(', ')});`;
      }
    } else {
      // Parameterless or raw fallback execution
      const raw = rawFallbackParams.trim();
      combinedSql = kind === 'procedure'
        ? `CALL ${name}(${raw});`
        : `SELECT ${name}(${raw});`;
    }

    const res = await dbHelper.executeQueryMulti(connId, combinedSql);
    setTesting(false);
    if (res.success && res.results && res.results.length > 0) {
      setTestResults(res.results);
    } else {
      setErrorMsg(res.error || 'Lỗi khi thực thi lệnh chạy thử');
    }
  };

  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, minHeight: 0 }}>
      {errorMsg && (
        <div className="rt-banner-error">
          <AlertTriangle size={14} />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="rt-banner-success">
          <CheckCircle size={14} />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="rt-code-block">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Mã nguồn DDL (CREATE OR REPLACE):</label>
        </div>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          spellCheck={false}
          className="rt-code-textarea"
        />
      </div>

      {/* The test-run panel, with automatic parameter detection */}
      <div className="rt-test-panel">
        <div className="rt-test-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Play size={14} style={{ color: 'var(--win-accent)' }} />
            <span>Chạy thử nghiệm (Execute Test)</span>
          </div>
          {parsedParams.length > 0 && (
            <span style={{ fontSize: '11px', color: 'var(--st-ok)', fontWeight: 500 }}>
              ✓ Đã tự động nhận diện {parsedParams.length} tham số ({parsedParams.filter(p => p.mode === 'OUT').length} OUT)
            </span>
          )}
        </div>

        {parsedParams.length > 0 ? (
          <div className="rt-param-grid">
            {parsedParams.map(p => (
              <div key={p.name} className="rt-param-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <code className="rt-param-name">
                    {p.name}
                  </code>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <span className={`rt-param-badge-mode ${p.mode.toLowerCase()}`}>{p.mode}</span>
                    <span className="rt-param-badge-type">{p.type}</span>
                  </div>
                </div>
                {p.mode === 'OUT' ? (
                  <div className="rt-param-out-hint">
                    @{p.name} (Tự động hứng OUT)
                  </div>
                ) : (
                  <input
                    type="text"
                    value={paramValues[p.name] ?? ''}
                    onChange={(e) => setParamValues({ ...paramValues, [p.name]: e.target.value })}
                    placeholder={`Giá trị cho ${p.name}`}
                    className="rt-param-input"
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Tham số truyền vào (vd: 'arg1', 100)"
              value={rawFallbackParams}
              onChange={(e) => setRawFallbackParams(e.target.value)}
              style={{
                flex: 1,
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid var(--win-border)',
                background: 'var(--win-bg-input)',
                color: 'var(--win-text-primary)',
                outline: 'none',
              }}
            />
          </div>
        )}

        {/* Render Multi-query Output Grids */}
        {testResults && testResults.length > 0 && (
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Kết quả thực thi ({testResults.length} tập dữ liệu / biến đầu ra):</span>
            {testResults.map((res, index) => (
              <div key={index} className="rt-result-card">
                <div className="rt-result-header">
                  <Code size={12} />
                  <span>{res.query}</span>
                </div>
                {res.data && res.data.length > 0 ? (
                  <div style={{ maxHeight: '220px', overflow: 'auto' }}>
                    <table className="structure-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr>
                          {res.columns.map(col => (
                            <th key={col} style={{ padding: '6px 10px', background: 'var(--win-bg-window)', borderBottom: '1px solid var(--win-border)', textAlign: 'left', color: 'var(--win-text-secondary)' }}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {res.data.map((row, rIdx) => (
                          <tr key={rIdx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                            {res.columns.map(col => (
                              <td key={col} style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{String(row[col] ?? '')}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ padding: '10px', fontSize: '11px', color: 'var(--win-text-disabled)' }}>Không trả về dòng dữ liệu nào.</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const actions = (
    <div className="rt-embedded-actions">
      <div className="rt-actions-left">
        <button
          className="btn btn-secondary"
          onClick={() => { navigator.clipboard.writeText(sql).catch(() => {}); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Copy size={13} />
          <span>Sao chép DDL</span>
        </button>
      </div>

      <div className="rt-actions-right">
        <button
          className="btn btn-secondary"
          onClick={handleTestExecute}
          disabled={testing}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Play size={13} style={{ color: 'var(--win-accent)' }} />
          <span>{testing ? 'Đang thực thi...' : 'Chạy thử nghiệm'}</span>
        </button>
        {!embedded && onClose && <button className="btn btn-secondary" onClick={onClose}>Hủy</button>}
        <button
          className="btn btn-primary rt-btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          <Save size={13} />
          <span>{saving ? 'Đang lưu...' : 'Biên dịch & Lưu'}</span>
        </button>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="rt-embedded-pane">
        <div className="rt-embedded-header">
          <h2 className="rt-embedded-title">
            {kind === 'procedure' ? 'Thủ tục (Procedure)' : 'Hàm (Function)'} —{' '}
            <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{name}</span>
          </h2>
        </div>
        <div className="rt-embedded-body">
          {content}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <Modal
      title={
        <>
          {kind === 'procedure' ? 'Thủ tục (Procedure)' : 'Hàm (Function)'} —{' '}
          <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{name}</span>
        </>
      }
      onClose={onClose}
      width="820px"
      maxWidth="94%"
      maxHeight="90vh"
      zIndex={999999}
    >
      <ModalBody style={{ gap: '14px', padding: '16px' }}>
        {content}
      </ModalBody>
      <ModalFooter>
        {actions}
      </ModalFooter>
    </Modal>
  );
};
