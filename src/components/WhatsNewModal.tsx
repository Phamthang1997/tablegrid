import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Sparkles,
  GitBranch,
  Wand2,
  Play,
  Copy,
  Cpu,
  Layers,
  FileText,
  Plus,
  Minus,
  Square,
  X,
} from 'lucide-react';
import { Modal, ModalBody } from './Modal';

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WHATS_NEW_STORAGE_KEY = 'tablegrid_whats_new_seen_v1';
export const WHATS_NEW_AUTO_SHOW_KEY = 'tablegrid_whats_new_auto_show';

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [activeSlide, setActiveSlide] = useState(0);
  const [showOnStartup, setShowOnStartup] = useState<boolean>(() => {
    const saved = localStorage.getItem(WHATS_NEW_AUTO_SHOW_KEY);
    return saved !== null ? saved === 'true' : true;
  });

  const totalSlides = 5;

  useEffect(() => {
    queueMicrotask(() => {
      if (isOpen) {
        setActiveSlide(0);
      }
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setActiveSlide((prev) => (prev > 0 ? prev - 1 : totalSlides - 1));
      } else if (e.key === 'ArrowRight') {
        setActiveSlide((prev) => (prev < totalSlides - 1 ? prev + 1 : 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, totalSlides]);

  if (!isOpen) return null;

  const handleClose = () => {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, 'true');
    localStorage.setItem(WHATS_NEW_AUTO_SHOW_KEY, showOnStartup ? 'true' : 'false');
    onClose();
  };

  const handleToggleStartup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.checked;
    setShowOnStartup(val);
    localStorage.setItem(WHATS_NEW_AUTO_SHOW_KEY, val ? 'true' : 'false');
  };

  const slidesData = [
    {
      id: 'ai-assistant',
      title: t('whatsNew.slide1Title', { defaultValue: 'Meet "Ask AI": Your new SQL assistant' }),
      description: t('whatsNew.slide1Desc', {
        defaultValue: 'Build and adjust queries faster with customizable AI actions. Analyze errors, explain complex queries, and suggest performance fixes in seconds.',
      }),
      renderPreview: () => (
        <div className="whats-new-window-container">
          <div className="whats-new-window-titlebar">
            <div className="whats-new-window-title">
              <Sparkles size={13} style={{ color: 'var(--win-accent)' }} />
              <span>SQL_Workspace - AI Assistant</span>
            </div>
            <div className="whats-new-window-controls">
              <Minus size={11} />
              <Square size={10} />
              <X size={11} />
            </div>
          </div>

          <div className="whats-new-menu-bar">
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <span>Tools</span>
            <span>Window</span>
            <span>Help</span>
          </div>

          <div className="whats-new-toolbar">
            <div className="whats-new-toolbar-left">
              <button className="whats-new-small-btn"><Copy size={10} /> Save</button>
              <button className="whats-new-small-btn"><Wand2 size={10} /> Query Builder</button>
              <button className="whats-new-small-btn whats-new-ask-ai-btn">
                <Sparkles size={10} /> Ask AI
              </button>
              <button className="whats-new-run-btn"><Play size={10} /> Run</button>
            </div>
          </div>

          <div className="whats-new-editor-grid">
            <div className="whats-new-editor-box">
              <div className="whats-new-editor-header">
                <span>Original SQL</span>
                <span style={{ fontSize: '9px', opacity: 0.7 }}>MySQL Dialect</span>
              </div>
              <div className="whats-new-code-body">
                <div className="whats-new-code-line"><span className="whats-new-line-num">1</span><span style={{ color: 'var(--win-accent)' }}>CREATE FUNCTION</span> get_cust_name(</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">2</span>  p_id <span style={{ color: 'var(--win-accent)' }}>INT</span>) <span style={{ color: 'var(--win-accent)' }}>RETURNS VARCHAR</span>(100)</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">3</span><span style={{ color: 'var(--win-accent)' }}>READS SQL DATA</span></div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">4</span><span style={{ color: 'var(--win-accent)' }}>BEGIN</span></div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">5</span>  <span style={{ color: 'var(--win-accent)' }}>DECLARE</span> full_name <span style={{ color: 'var(--win-accent)' }}>VARCHAR</span>(100);</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">6</span>  <span style={{ color: 'var(--win-accent)' }}>SELECT CONCAT</span>(first_name, <span style={{ color: 'var(--st-warn)' }}>' '</span>, last_name)</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">7</span>  <span style={{ color: 'var(--win-accent)' }}>INTO</span> full_name <span style={{ color: 'var(--win-accent)' }}>FROM</span> customer</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">8</span>  <span style={{ color: 'var(--win-accent)' }}>WHERE</span> customer_id = p_id;</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">9</span>  <span style={{ color: 'var(--win-accent)' }}>RETURN</span> full_name;</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">10</span><span style={{ color: 'var(--win-accent)' }}>END</span>;</div>
              </div>
            </div>

            <div className="whats-new-editor-box highlight">
              <div className="whats-new-editor-header ai">
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600 }}>
                  <Sparkles size={11} /> AI Suggested Text
                </span>
                <span className="whats-new-ai-badge">ChatGPT 4o</span>
              </div>
              <div className="whats-new-code-body">
                <div className="whats-new-code-line bg-blue"><span className="whats-new-line-num">1</span><span style={{ color: 'var(--win-accent)' }}>CREATE FUNCTION</span> get_cust_name(</div>
                <div className="whats-new-code-line bg-blue"><span className="whats-new-line-num">2</span>  p_id <span style={{ color: 'var(--win-accent)' }}>INT</span>) <span style={{ color: 'var(--win-accent)' }}>RETURNS VARCHAR</span>(100) <span style={{ color: 'var(--win-accent)' }}>AS $$</span></div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">3</span><span style={{ color: 'var(--win-accent)' }}>DECLARE</span> v_name <span style={{ color: 'var(--win-accent)' }}>VARCHAR</span>(100);</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">4</span><span style={{ color: 'var(--win-accent)' }}>BEGIN</span></div>
                <div className="whats-new-code-line bg-green"><span className="whats-new-line-num">5</span>  <span style={{ color: 'var(--win-accent)' }}>SELECT</span> first_name || <span style={{ color: 'var(--st-warn)' }}>' '</span> || last_name</div>
                <div className="whats-new-code-line bg-green"><span className="whats-new-line-num">6</span>  <span style={{ color: 'var(--win-accent)' }}>INTO</span> v_name <span style={{ color: 'var(--win-accent)' }}>FROM</span> customer <span style={{ color: 'var(--win-accent)' }}>WHERE</span> id = p_id;</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">7</span>  <span style={{ color: 'var(--win-accent)' }}>RETURN</span> v_name;</div>
                <div className="whats-new-code-line"><span className="whats-new-line-num">8</span><span style={{ color: 'var(--win-accent)' }}>END</span>;</div>
                <div className="whats-new-code-line bg-blue"><span className="whats-new-line-num">9</span><span style={{ color: 'var(--win-accent)' }}>$$ LANGUAGE</span> plpgsql;</div>
              </div>
              <div className="whats-new-editor-actions">
                <button className="whats-new-action-btn-outline">New Query</button>
                <button className="whats-new-action-btn-primary">Apply Suggestion</button>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'all-new-model',
      title: t('whatsNew.slide3TitleModel', { defaultValue: 'All-New Model Workspace' }),
      description: t('whatsNew.slide3DescModel', {
        defaultValue: 'Incorporate different types of databases to build multiple models within a unified workspace.',
      }),
      renderPreview: () => (
        <div className="whats-new-window-container">
          <div className="whats-new-window-titlebar">
            <div className="whats-new-window-title">
              <Layers size={13} style={{ color: 'var(--st-warn)' }} />
              <span>SQL_3schemas - Model Workspace</span>
            </div>
            <div className="whats-new-window-controls">
              <Minus size={11} />
              <Square size={10} />
              <X size={11} />
            </div>
          </div>

          <div className="whats-new-menu-bar">
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <span>Tools</span>
            <span>Window</span>
            <span>Help</span>
          </div>

          <div className="whats-new-toolbar">
            <div className="whats-new-toolbar-left">
              <button className="whats-new-small-btn"><Copy size={10} style={{ color: 'var(--win-accent)' }} /> Save</button>
              <button className="whats-new-small-btn"><Plus size={10} style={{ color: 'var(--st-ok)' }} /> New Model</button>
              <button className="whats-new-small-btn"><GitBranch size={10} style={{ color: 'var(--win-accent)' }} /> New Diagram</button>
              <button className="whats-new-small-btn"><FileText size={10} style={{ color: 'var(--st-warn)' }} /> New Data Dictionary</button>
            </div>
          </div>

          <div style={{ background: 'var(--win-bg-subtle, #f0f2f5)', padding: '4px 10px 0 10px', borderBottom: '1px solid var(--win-border)' }}>
            <div style={{ display: 'flex', gap: '4px', fontSize: '11px' }}>
              <span className="whats-new-tab-active" style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottom: 'none' }}>Workspace</span>
              <span className="whats-new-tab-inactive">Diagram_1</span>
              <span className="whats-new-tab-inactive">Model_2</span>
              <span className="whats-new-tab-inactive">Model_3</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: 'var(--win-bg-card)', borderBottom: '1px solid var(--win-border)', fontSize: '11px' }}>
            <span style={{ padding: '2px 8px', borderRadius: '4px', background: 'var(--win-accent)', color: '#fff', fontWeight: 600 }}>All</span>
            <span style={{ padding: '2px 8px', color: 'var(--win-text-secondary)' }}>Model</span>
            <span style={{ padding: '2px 8px', color: 'var(--win-text-secondary)' }}>Diagram</span>
            <span style={{ padding: '2px 8px', color: 'var(--win-text-secondary)' }}>Data Dictionary</span>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--win-bg-card)' }}>
            <table className="whats-new-table">
              <thead>
                <tr style={{ background: 'var(--win-bg-subtle, #f8f9fa)', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Connection Type</th>
                  <th>Server Version</th>
                  <th>Using</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--win-border)' }}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                    <Layers size={12} style={{ color: 'var(--st-ok)' }} /> Model_1
                  </td>
                  <td>Model</td>
                  <td>MySQL</td>
                  <td>v5.7 - v9+</td>
                  <td style={{ opacity: 0.7 }}>-</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-subtle)' }}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                    <Layers size={12} style={{ color: 'var(--st-ok)' }} /> Model_2
                  </td>
                  <td>Model</td>
                  <td>PostgreSQL</td>
                  <td>v12 - v18+</td>
                  <td style={{ opacity: 0.7 }}>-</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--win-border)' }}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                    <Layers size={12} style={{ color: 'var(--st-ok)' }} /> Model_3
                  </td>
                  <td>Model</td>
                  <td>SQLite</td>
                  <td>v3.46+</td>
                  <td style={{ opacity: 0.7 }}>-</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-subtle)' }}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                    <GitBranch size={12} style={{ color: 'var(--win-accent)' }} /> Diagram_1
                  </td>
                  <td>Diagram</td>
                  <td>Redis</td>
                  <td>v7.x+</td>
                  <td style={{ opacity: 0.8 }}>Model_2</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--win-border)' }}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                    <GitBranch size={12} style={{ color: 'var(--win-accent)' }} /> Diagram_2
                  </td>
                  <td>Diagram</td>
                  <td>SQL Server</td>
                  <td>2022</td>
                  <td style={{ opacity: 0.8 }}>Model_1</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ),
    },
    {
      id: 'visual-explain',
      title: t('whatsNew.slide2Title', { defaultValue: 'Visual EXPLAIN Plan Diagram' }),
      description: t('whatsNew.slide2Desc', {
        defaultValue: 'Analyze complex query execution plans with graphic tree nodes, cost distribution percentages, and bottleneck highlighting.',
      }),
      renderPreview: () => (
        <div className="whats-new-window-container">
          <div className="whats-new-window-titlebar">
            <div className="whats-new-window-title">
              <GitBranch size={13} style={{ color: '#8b5cf6' }} />
              <span>Query Execution Plan Analyzer</span>
            </div>
            <div className="whats-new-window-controls">
              <Minus size={11} />
              <Square size={10} />
              <X size={11} />
            </div>
          </div>

          <div className="whats-new-toolbar">
            <div className="whats-new-toolbar-left">
              <span style={{ fontWeight: 600, fontSize: '11px', color: '#8b5cf6', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <GitBranch size={12} /> EXPLAIN Graph (Cost Total: 142.50)
              </span>
            </div>
            <span style={{ fontSize: '9.5px', background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6', padding: '1px 6px', borderRadius: '4px' }}>
              PostgreSQL 18 Engine
            </span>
          </div>

          <div style={{ flex: 1, padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--win-bg-subtle, #f5f6f8)', gap: '10px' }}>
            <div className="whats-new-explain-node" style={{ border: '1.5px solid #8b5cf6' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '11px' }}>Nested Loop Left Join</span>
                <span style={{ fontSize: '9px', background: '#8b5cf6', color: '#fff', padding: '1px 5px', borderRadius: '4px' }}>Cost: 52%</span>
              </div>
              <span style={{ fontSize: '9.5px', opacity: 0.8 }}>Rows: 1,420 • Time: 0.84ms</span>
            </div>

            <div style={{ width: '2px', height: '12px', background: 'var(--win-border-strong, #8b5cf6)' }} />

            <div style={{ display: 'flex', gap: '16px' }}>
              <div className="whats-new-explain-node" style={{ border: '1.5px solid var(--win-accent)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '10.5px' }}>Index Scan (idx_orders_cust)</span>
                  <span style={{ fontSize: '9px', background: 'var(--win-accent)', color: '#fff', padding: '1px 5px', borderRadius: '4px' }}>12%</span>
                </div>
                <span style={{ fontSize: '9.5px', opacity: 0.8 }}>Index Cond: customer_id = 42</span>
              </div>

              <div className="whats-new-explain-node" style={{ border: '1.5px solid var(--st-danger)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '10.5px' }}>Seq Scan (payments)</span>
                  <span style={{ fontSize: '9px', background: 'var(--st-danger)', color: '#fff', padding: '1px 5px', borderRadius: '4px' }}>36% (Bottleneck)</span>
                </div>
                <span style={{ fontSize: '9.5px', color: 'var(--st-danger)' }}>Filter: (amount &gt; 500) • 45k rows</span>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'data-generator',
      title: t('whatsNew.slide3Title', { defaultValue: 'Smart Test Data Generator' }),
      description: t('whatsNew.slide3Desc', {
        defaultValue: 'Generate realistic dummy data in seconds with customizable generation rules, foreign key mapping, and high-performance batch insertion.',
      }),
      renderPreview: () => (
        <div className="whats-new-window-container">
          <div className="whats-new-window-titlebar">
            <div className="whats-new-window-title">
              <Wand2 size={13} style={{ color: 'var(--st-ok)' }} />
              <span>Data Generator Tool</span>
            </div>
            <div className="whats-new-window-controls">
              <Minus size={11} />
              <Square size={10} />
              <X size={11} />
            </div>
          </div>

          <div className="whats-new-toolbar">
            <span style={{ fontWeight: 600, fontSize: '11px', color: 'var(--st-ok)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Wand2 size={12} /> Target Table: public.users
            </span>
            <span style={{ fontSize: '9.5px', opacity: 0.7 }}>Target Rows: 50,000</span>
          </div>

          <div style={{ flex: 1, padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--win-bg-subtle, #f5f6f8)' }}>
            <div className="whats-new-data-row-item">
              <span style={{ fontWeight: 600, width: '120px' }}>user_id (PK)</span>
              <span style={{ fontSize: '9.5px', background: 'rgba(16, 185, 129, 0.15)', color: 'var(--st-ok)', padding: '1px 6px', borderRadius: '4px', fontWeight: 500 }}>Auto Increment</span>
              <span style={{ fontSize: '9.5px', opacity: 0.7 }}>Start: 10001, Step: 1</span>
            </div>
            <div className="whats-new-data-row-item">
              <span style={{ fontWeight: 600, width: '120px' }}>full_name</span>
              <span style={{ fontSize: '9.5px', background: 'var(--win-accent-subtle)', color: 'var(--win-accent)', padding: '1px 6px', borderRadius: '4px', fontWeight: 500 }}>Faker: Person.fullName</span>
              <span style={{ fontSize: '9.5px', opacity: 0.7 }}>Locale: vi_VN</span>
            </div>
            <div className="whats-new-data-row-item">
              <span style={{ fontWeight: 600, width: '120px' }}>email</span>
              <span style={{ fontSize: '9.5px', background: 'var(--win-accent-subtle)', color: 'var(--win-accent)', padding: '1px 6px', borderRadius: '4px', fontWeight: 500 }}>Faker: Internet.email</span>
              <span style={{ fontSize: '9.5px', opacity: 0.7 }}>Domain: @company.com</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', background: 'var(--win-bg-card)', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--win-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Cpu size={13} style={{ color: 'var(--st-ok)' }} />
                <span style={{ fontSize: '10.5px', fontWeight: 500 }}>Batch Speed: ~12,500 rows/sec</span>
              </div>
              <button className="whats-new-action-btn-primary">Start Generating Data</button>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'schema-compare',
      title: t('whatsNew.slide4Title', { defaultValue: 'Schema Comparison & Migration' }),
      description: t('whatsNew.slide4Desc', {
        defaultValue: 'Compare schemas between environments, review structural differences side by side, and export clean DDL migration scripts.',
      }),
      renderPreview: () => (
        <div className="whats-new-window-container">
          <div className="whats-new-window-titlebar">
            <div className="whats-new-window-title">
              <Layers size={13} style={{ color: 'var(--st-warn)' }} />
              <span>Schema Compare & Synchronization</span>
            </div>
            <div className="whats-new-window-controls">
              <Minus size={11} />
              <Square size={10} />
              <X size={11} />
            </div>
          </div>

          <div className="whats-new-toolbar">
            <span style={{ fontWeight: 600, fontSize: '11px', color: 'var(--st-warn)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Layers size={12} /> Staging_DB vs Production_DB
            </span>
            <span style={{ fontSize: '9.5px', color: 'var(--st-warn)', background: 'rgba(217, 119, 6, 0.15)', padding: '1px 6px', borderRadius: '4px' }}>
              3 Differences Found
            </span>
          </div>

          <div style={{ flex: 1, padding: '8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', background: 'var(--win-bg-subtle, #f5f6f8)' }}>
            <div className="whats-new-compare-col">
              <div className="whats-new-compare-header">Source Differences</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 5px', fontSize: '9.5px', background: 'rgba(34, 197, 94, 0.12)', borderLeft: '3px solid var(--st-ok)', borderRadius: '2px' }}>
                <span>+ TABLE: user_sessions</span>
                <span style={{ fontSize: '8.5px', background: 'var(--st-ok)', color: '#fff', padding: '1px 4px', borderRadius: '3px' }}>NEW</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 5px', fontSize: '9.5px', background: 'rgba(217, 119, 6, 0.12)', borderLeft: '3px solid var(--st-warn)', borderRadius: '2px' }}>
                <span>~ COLUMN: orders.status</span>
                <span style={{ fontSize: '8.5px', background: 'var(--st-warn)', color: '#fff', padding: '1px 4px', borderRadius: '3px' }}>MODIFIED</span>
              </div>
            </div>
            <div className="whats-new-compare-col">
              <div className="whats-new-compare-header">Generated Migration DDL</div>
              <div className="whats-new-code-body">
                <div style={{ color: 'var(--st-ok)' }}>-- Add new table user_sessions</div>
                <div>CREATE TABLE user_sessions (...);</div>
                <div style={{ color: 'var(--st-warn)', marginTop: '4px' }}>-- Modify status column</div>
                <div>ALTER TABLE orders ALTER COLUMN status TYPE VARCHAR(50);</div>
              </div>
            </div>
          </div>
        </div>
      ),
    },
  ];

  const currentSlide = slidesData[activeSlide];

  return (
    <Modal
      title={t('whatsNew.modalHeader', { defaultValue: "What's New in TableGrid 17" })}
      icon={<Sparkles size={16} style={{ color: 'var(--win-accent)' }} />}
      onClose={handleClose}
      width="780px"
      height="560px"
      maxWidth="94vw"
      maxHeight="92vh"
    >
      <ModalBody className="whats-new-modal-body">
        {/* Feature Preview Window Mockup */}
        <div className="whats-new-preview-wrapper">
          {currentSlide.renderPreview()}
        </div>

        {/* Single Horizontal Divider Line */}
        <div className="whats-new-divider" />

        {/* Feature Info & Control Cluster (Single Unified Group) */}
        <div className="whats-new-cluster">
          {/* Title & Description */}
          <div className="whats-new-info-section">
            <h2 className="whats-new-title">
              {currentSlide.title}
            </h2>
            <p className="whats-new-desc">
              {currentSlide.description}
            </p>
          </div>

          {/* Single Unified Bottom Row */}
          <div className="whats-new-bottom-row">
            {/* Left: Checkbox */}
            <label className="whats-new-startup-label">
              <input
                type="checkbox"
                checked={showOnStartup}
                onChange={handleToggleStartup}
                className="whats-new-checkbox"
              />
              {t('whatsNew.showOnStartup', { defaultValue: 'Show on startup' })}
            </label>

            {/* Center: Navigation Arrows & Dots Indicator */}
            <div className="whats-new-nav-controls">
              <button
                onClick={() => setActiveSlide((prev) => (prev > 0 ? prev - 1 : totalSlides - 1))}
                className="whats-new-nav-btn"
                title={t('whatsNew.prevSlide', { defaultValue: 'Previous slide' })}
              >
                <ChevronLeft size={15} />
              </button>

              {/* Dots Indicator */}
              <div className="whats-new-dots-container">
                {slidesData.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setActiveSlide(idx)}
                    className={`whats-new-dot-btn ${idx === activeSlide ? 'active' : ''}`}
                  />
                ))}
              </div>

              <button
                onClick={() => setActiveSlide((prev) => (prev < totalSlides - 1 ? prev + 1 : 0))}
                className="whats-new-nav-btn"
                title={t('whatsNew.nextSlide', { defaultValue: 'Next slide' })}
              >
                <ChevronRight size={15} />
              </button>
            </div>

            {/* Right: Close Button */}
            <div className="whats-new-close-wrapper">
              <button onClick={handleClose} className="whats-new-close-btn">
                {t('common.close', { defaultValue: 'Close' })}
              </button>
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
};
