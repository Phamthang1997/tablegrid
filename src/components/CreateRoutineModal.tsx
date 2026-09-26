import React, { useState } from 'react';
import { nextRowId, type WithRowId } from '../utils/rowIds';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import { Plus, Trash2, Save, AlertTriangle, CheckCircle } from 'lucide-react';

interface CreateRoutineModalProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  onClose: () => void;
  onCreated: () => void;
}

interface RoutineParamDraft {
  mode: 'IN' | 'OUT' | 'INOUT';
  name: string;
  type: string;
}

export const CreateRoutineModal: React.FC<CreateRoutineModalProps> = ({
  connId,
  dbType,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState<string>('new_procedure');
  const [kind, setKind] = useState<'procedure' | 'function'>('procedure');
  const [returnType, setReturnType] = useState<string>('INT');
  // `rowId` is the row's React key (see `utils/rowIds.ts`); only the DDL below reads the rest.
  const [params, setParams] = useState<WithRowId<RoutineParamDraft>[]>(() => [
    { rowId: nextRowId(), mode: 'IN', name: 'p_id', type: 'INT' },
  ]);
  const [bodySql, setBodySql] = useState<string>('SELECT * FROM my_table;');

  const [saving, setSaving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Generate full DDL script based on form state
  const generatedDdl = React.useMemo(() => {
    const routineName = name.trim() || 'new_routine';
    const paramString = params.map(p => {
      const pName = dbType === 'mysql' ? `\`${p.name.trim()}\`` : `"${p.name.trim()}"`;
      return dbType === 'mysql' ? `${p.mode} ${pName} ${p.type}` : `${pName} ${p.type}`;
    }).join(', ');

    if (dbType === 'mysql') {
      if (kind === 'procedure') {
        return `CREATE PROCEDURE \`${routineName}\`(${paramString})\nREADS SQL DATA\nBEGIN\n  ${bodySql.trim()}\nEND`;
      } else {
        return `CREATE FUNCTION \`${routineName}\`(${paramString}) RETURNS ${returnType}\nDETERMINISTIC\nREADS SQL DATA\nBEGIN\n  RETURN 0;\nEND`;
      }
    } else {
      if (kind === 'procedure') {
        return `CREATE OR REPLACE PROCEDURE "${routineName}"(${paramString})\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  ${bodySql.trim()}\nEND;\n$$;`;
      } else {
        return `CREATE OR REPLACE FUNCTION "${routineName}"(${paramString})\nRETURNS ${returnType}\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN 0;\nEND;\n$$;`;
      }
    }
  }, [name, kind, returnType, params, bodySql, dbType]);

  const handleAddParam = () => {
    setParams([...params, { rowId: nextRowId(), mode: 'IN', name: `p_arg${params.length + 1}`, type: 'VARCHAR(255)' }]);
  };

  const handleRemoveParam = (index: number) => {
    setParams(params.filter((_, i) => i !== index));
  };

  const handleCreate = async () => {
    setSaving(true);
    setErrorMsg(null);

    const res = await dbHelper.saveRoutineDefinition(connId, generatedDdl);
    setSaving(false);
    if (res.success) {
      setSuccessMsg('Đã tạo ' + (kind === 'procedure' ? 'Thủ tục' : 'Hàm') + ' thành công');
      onCreated();
      setTimeout(() => {
        onClose();
      }, 1000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi tạo Stored Routine');
    }
  };

  return (
    <Modal
      title={`Tạo mới ${kind === 'procedure' ? 'Thủ tục (Procedure)' : 'Hàm (Function)'}`}
      onClose={onClose}
      width="760px"
      maxWidth="94%"
      maxHeight="88vh"
      zIndex={999999}
    >
      <ModalBody style={{ gap: '14px', padding: '16px' }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Tên Routine:</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="vd: get_user_stats"
              style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Loại Routine:</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as any)}
              style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
            >
              <option value="procedure">Procedure (Thủ tục)</option>
              <option value="function">Function (Hàm)</option>
            </select>
          </div>

          {kind === 'function' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Kiểu trả về (Returns):</label>
              <input
                type="text"
                value={returnType}
                onChange={(e) => setReturnType(e.target.value)}
                placeholder="vd: INT, VARCHAR(255)"
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>
          )}
        </div>

        {/* Dynamic Parameter Builder */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--win-border)', paddingTop: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Khai báo Tham số ({params.length}):</span>
            <button
              className="btn btn-secondary"
              onClick={handleAddParam}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '4px 8px' }}
            >
              <Plus size={12} />
              <span>Thêm tham số</span>
            </button>
          </div>

          <div style={{ border: '1px solid var(--win-border)', borderRadius: '6px', overflow: 'hidden' }}>
            <table className="structure-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
              <thead>
                <tr>
                  <th style={{ width: '90px' }}>Chiều</th>
                  <th>Tên tham số</th>
                  <th>Kiểu dữ liệu</th>
                  <th style={{ width: '50px', textAlign: 'center' }}>Xóa</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p, index) => (
                  <tr key={p.rowId}>
                    <td style={{ padding: '4px 8px' }}>
                      <select
                        value={p.mode}
                        onChange={(e) => {
                          const next = [...params];
                          next[index].mode = e.target.value as any;
                          setParams(next);
                        }}
                        style={{ padding: '2px 4px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', width: '100%' }}
                      >
                        <option value="IN">IN</option>
                        <option value="OUT">OUT</option>
                        <option value="INOUT">INOUT</option>
                      </select>
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <input
                        type="text"
                        value={p.name}
                        onChange={(e) => {
                          const next = [...params];
                          next[index].name = e.target.value;
                          setParams(next);
                        }}
                        style={{ padding: '3px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', width: '100%', fontFamily: 'var(--win-font-mono)' }}
                      />
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <input
                        type="text"
                        value={p.type}
                        onChange={(e) => {
                          const next = [...params];
                          next[index].type = e.target.value;
                          setParams(next);
                        }}
                        style={{ padding: '3px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', width: '100%', fontFamily: 'var(--win-font-mono)' }}
                      />
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                      <button className="cm-icon-btn sm danger" onClick={() => handleRemoveParam(index)}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Body SQL Input */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Thân câu lệnh SQL (Body logic):</label>
          <textarea
            rows={3}
            value={bodySql}
            onChange={(e) => setBodySql(e.target.value)}
            placeholder="vd: SELECT * FROM users;"
            style={{ width: '100%', fontFamily: 'var(--win-font-mono)', fontSize: '11.5px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
          />
        </div>

        {/* Code DDL Preview & Editing */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Mã DDL tự động khởi tạo:</span>
          <textarea
            value={generatedDdl}
            readOnly
            rows={5}
            style={{
              width: '100%',
              fontFamily: 'var(--win-font-mono)',
              fontSize: '11.5px',
              padding: '8px 10px',
              borderRadius: '6px',
              border: '1px solid var(--win-border)',
              background: 'var(--win-bg-card)',
              color: 'var(--win-text-primary)',
              lineHeight: '1.4',
            }}
          />
        </div>
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={onClose}>Hủy</button>
        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={saving}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}
        >
          <Save size={13} />
          <span>{saving ? 'Đang tạo...' : 'Tạo Stored Routine'}</span>
        </button>
      </ModalFooter>
    </Modal>
  );
};
