import React, { useState, useEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig } from '../utils/dbHelper';
import { Database, Server, CheckCircle2, AlertTriangle, Plus, Trash2, Save, Copy, Download, Upload, Lock, Key, TerminalSquare, Hash, FolderOpen, User, Link, Star, Eye, EyeOff, ShieldAlert, Search, X, ChevronDown, ChevronRight, RefreshCw, ShieldCheck, Network, ArrowLeft, ArrowRight, Check, Cloud, DatabaseBackup, LogIn, KeyRound } from 'lucide-react';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './DbIcons';
import { encryptConnectionExport, decryptConnectionExport, CONNECTION_FILE_EXT, CONNECTION_FILE_ACCEPT } from '../utils/cryptoHelper';
import { CONN_ENVS, envLabelKey, legacyEnvOfColor, normalizeEnv, type ConnEnv } from '../utils/connEnv';
import {
  buildDropStatements,
  addExistsHint,
  fileBaseName,
  plannedFromScan,
  type DumpScan,
} from '../utils/dumpPreview';
import { buildDump, dumpReaderFor, writeDump, type DumpSpec } from '../utils/dumpBuilder';
import { getLastExportDir, saveDumpToFolder, saveExportFileAtPath, pickOpenFile, pickSaveFilePath, pickSqliteDatabaseFile } from '../utils/fileSave';
import { fileBaseFromPath, fileStamp, safeFileBase } from '../utils/exportHelper';
import { startJob } from '../utils/jobs';
import { runOnJobConnection } from '../utils/jobConnection';
import { approveJobForServer, type JobApproval } from '../utils/safeMode';
import { connKey } from '../utils/connKey';
import { formatRestoreEta, makeRestoreReporter, restoreCancelledResult } from '../utils/restoreProgress';
import { ConfirmDialog } from './ConfirmDialog';
import { MasterPasswordModal } from './MasterPasswordModal';
import { refreshVaultStatus } from '../utils/vault';
import {
  SECRET_FIELDS,
  hasInlineSecrets,
  mergeSecrets,
  newProfileId,
  pickSecrets,
  publicConfig,
} from '../utils/secretFields';
import { TerminalPanel } from './TerminalPanel';

const PROFILES_KEY = 'tf_connection_profiles';
const SECRET_FIELD_LIST: string[] = [...SECRET_FIELDS];

const LoadingSpinner: React.FC<{ size?: number; style?: React.CSSProperties; className?: string }> = ({ size = 16, style, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`loading-spinner ${className || ''}`}
    style={style}
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      style={{ stroke: 'var(--win-border-strong)' }}
      strokeWidth="3"
      opacity="0.2"
    />
    <path
      d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);

// The show/hide password button lives inside the input itself.
const EyeBtn: React.FC<{ on: boolean; onClick: () => void }> = ({ on, onClick }) => {
  const { t } = useTranslation();
  return (
    <button type="button" className="cm-eye" onClick={onClick} title={on ? t('connection.hidePassword') : t('connection.showPassword')}>
      {on ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  );
};

// The file picker button (SSL certificate, private key…) — it shows only the file name, to stay compact.
const FilePick: React.FC<{ id: string; value: string; label: string; onPick: (path: string) => void }> = ({ id, value, label, onPick }) => {
  const handleClick = async () => {
    const file = await pickOpenFile({ title: label });
    if (file) {
      onPick(file);
      return;
    }
    if (file === null) {
      // Fallback for non-Tauri / web mode
      document.getElementById(id)?.click();
    }
  };

  return (
    <>
      <input
        type="file"
        id={id}
        className="cm-hidden-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick((file as any).path || file.name);
        }}
      />
      <button type="button" className={`cm-file-btn ${value ? 'has-file' : ''}`} onClick={handleClick} title={value || label}>
        <FolderOpen size={12} />
        <span>{value ? value.split(/[\\/]/).pop() : label}</span>
      </button>
    </>
  );
};

export interface SavedProfile {
  id: string;
  name: string;
  type: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  config: any;
  /** The colour label, purely decorative. The environment lives in `env` — see `utils/connEnv.ts`. */
  color?: string;
  /**
   * The environment. Absent from profiles saved before this field existed; filled in once at load
   * time, inferred from `color` the way it used to be read (see `migrateProfileEnvs`).
   */
  env?: ConnEnv;
  group?: string;
  isDefault?: boolean;
}

/**
 * Fills in `env` for the profiles that lack it, using exactly the meaning the colour used to carry.
 *
 * Returns `null` when nothing needs changing, so the caller does not rewrite localStorage for
 * nothing. Skip this step and every connection currently marked production loses that mark on the
 * upgrade, without a word.
 */
function migrateProfileEnvs(list: SavedProfile[]): SavedProfile[] | null {
  if (list.every((p) => p.env !== undefined)) return null;
  return list.map((p) => (p.env === undefined ? { ...p, env: legacyEnvOfColor(p.color) } : p));
}

interface ConnectionManagerProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  /**
   * Mounted inside the "Add connection" modal (from the title bar), rather than as the first screen.
   *
   * It hides the chrome that belongs to *managing* connections rather than to *opening another* one:
   * importing/exporting profile files, and Backup & Restore. The second matters most — it acts on the
   * connection that is **already open**, so putting it inside an "add connection" dialog invites the
   * user to back up a database other than the one they are looking at.
   */
  embedded?: boolean;
  /**
   * `'new'` turns the screen into a "create one connection" dialog: no saved-profile list (the quick
   * switcher already lists those), no profile auto-selected on mount, a type picker first, and
   * nothing written to the profile list until the connection succeeds — closing the dialog halfway
   * leaves no half-filled profile behind.
   */
  variant?: 'manage' | 'new';
  // `profile` is the profile chosen for the connection, when there is one. App keeps the id and name
  // so the connection popover can edit name and colour and write them straight back into
  // tf_connection_profiles.
  onConnect: (
    dbName: string,
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis',
    color?: string,
    config?: DbConnectionConfig,
    // `env` lives here rather than becoming a seventh positional parameter: it is a property of the
    // profile, exactly as `name` is, and a connection that came from no profile has no environment.
    profile?: { id: string; name: string; env?: ConnEnv },
    // Schema the backend actually landed in (Postgres `current_schema()`), null elsewhere.
    // Passed on rather than re-queried: it is part of the tab storage key, so App needs it
    // before it restores anything.
    schema?: string | null,
  ) => void;
}

// SSL levels in the order the <select> shows them. The explanation sits under
// the select instead of inside each <option> (a long option gets covered by the
// select arrow and the native popup overflows) — see sslModeDesc() below.
const SSL_MODES = ['DISABLED', 'PREFERRED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const;
// Redis has no STARTTLS-style negotiation — a port either speaks TLS or it does not — so
// PREFERRED would be a mode that cannot be implemented honestly. `redis_ssl_mode` in
// redis_db.rs maps it to VERIFY_IDENTITY if an old profile still carries it.
const REDIS_SSL_MODES = ['DISABLED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const;

// The real logo of each DB engine (see DbIcons.tsx), plus its brand colour for the tile background.
const TYPE_META: Record<string, { label: string; color: string; Icon: React.FC<{ size?: number }> }> = {
  sqlite: { label: 'SQLite', color: '#003B57', Icon: SqliteIcon },
  postgres: { label: 'PostgreSQL', color: '#336791', Icon: PostgresIcon },
  mysql: { label: 'MySQL', color: '#00758F', Icon: MySqlIcon },
  redis: { label: 'Redis', color: '#DC382D', Icon: RedisIcon },
};

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({ connId, embedded = false, variant = 'manage', onConnect }) => {
  const { t } = useTranslation();
  const isNew = variant === 'new';
  // New-connection dialog only: whether a successful Connect also adds the profile to the list.
  const [saveToList, setSaveToList] = useState(true);

  // A switch rather than t(`...${mode}`): a key built at runtime is not checked
  // against the key tree declared in i18next.d.ts.
  const sslModeDesc = (mode: string): string => {
    switch (mode) {
      case 'DISABLED': return t('connection.sslDescDisabled');
      case 'PREFERRED': return t('connection.sslDescPreferred');
      case 'REQUIRED': return t('connection.sslDescRequired');
      case 'VERIFY_CA': return t('connection.sslDescVerifyCa');
      case 'VERIFY_IDENTITY': return t('connection.sslDescVerifyIdentity');
      default: return '';
    }
  };

  // Labels for the status LED on each connection row in the sidebar.
  const ledTitle: Record<'busy' | 'ok' | 'fail', string> = {
    busy: t('connection.ledBusy'),
    ok: t('connection.ledOk'),
    fail: t('connection.ledFail'),
  };

  const [activeType, setActiveType] = useState<'sqlite' | 'postgres' | 'mysql' | 'redis' | 'backup_restore'>('sqlite');
  // Redis form state
  const [redisHost, setRedisHost] = useState('127.0.0.1');
  const [redisPort, setRedisPort] = useState(6379);
  const [redisUser, setRedisUser] = useState('');
  const [redisPassword, setRedisPassword] = useState('');
  const [redisDbIndex, setRedisDbIndex] = useState(0);
  const [showPw, setShowPw] = useState(false); // show/hide the connection form's password
  const [profileSearch, setProfileSearch] = useState(''); // filter profile at sidebar
  const [testStatus, setTestStatus] = useState<'untested' | 'ok' | 'fail'>('untested'); // the state of the Test connection button

  // The config form's tabs: SSL and SSH go to tabs of their own so the main form stays short.
  const [formTab, setFormTab] = useState<'general' | 'ssl' | 'ssh'>('general');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({}); // the groups currently collapsed in the sidebar
  const [showNewMenu, setShowNewMenu] = useState(false); // the DB-type menu shown when creating a new connection
  const [showGroupList, setShowGroupList] = useState(false); // the dropdown suggesting existing groups
  const [showDbList, setShowDbList] = useState(false); // the dropdown for picking one of the fetched databases
  const [uriCopied, setUriCopied] = useState(false); // the feedback shown after copying the connection string

  // Whether the host counts as "remote" (not local) -> used for the SSL warning.
  const isRemoteHost = (h?: string) => {
    const v = (h || '').trim().toLowerCase();
    return v !== '' && !['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(v);
  };
  const [sqlitePath, setSqlitePath] = useState('');

  // PG config
  const [pgHost, setPgHost] = useState('localhost');
  const [pgPort, setPgPort] = useState(5432);
  const [pgUser, setPgUser] = useState('postgres');
  const [pgPassword, setPgPassword] = useState('');
  const [pgDatabase, setPgDatabase] = useState('postgres');

  // MySQL config
  const [myHost, setMyHost] = useState('localhost');
  const [myPort, setMyPort] = useState(3306);
  const [myUser, setMyUser] = useState('root');
  const [myPassword, setMyPassword] = useState('');
  const [myDatabase, setMyDatabase] = useState('');
  const [sslEnabled, setSslEnabled] = useState(false);
  // PREFERRED: use TLS when the server supports it and fall back to unencrypted when it does not,
  // so it cannot break a connection to an internal server. The real default for a new connection is
  // in handleCreateNewProfile (config.sslMode); this initial value only covers the render before the
  // first profile is selected. Saved profiles are unaffected: both profile-loading paths still fall
  // back to DISABLED for older records without the field.
  const [sslMode, setSslMode] = useState('PREFERRED');
  const [sslKeyPath, setSslKeyPath] = useState('');
  const [sslCertPath, setSslCertPath] = useState('');
  const [sslCaPath, setSslCaPath] = useState('');

  // SSH config
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState('');
  const [sshAuthType, setSshAuthType] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshKeyContent, setSshKeyContent] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');

  // AWS IAM authentication (RDS/Aurora)
  const [authMethod, setAuthMethod] = useState<'password' | 'aws_iam'>('password');
  const [awsAuthType, setAwsAuthType] = useState<'access_key' | 'profile'>('access_key');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsSessionToken, setAwsSessionToken] = useState('');
  const [awsProfile, setAwsProfile] = useState('');
  const [awsRegion, setAwsRegion] = useState('');

  const [isConnecting, setIsConnecting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const isBusy = isConnecting || isTesting;
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSuccessConnecting, setIsSuccessConnecting] = useState(false);
  const [connectingDbName, setConnectingDbName] = useState('');

  // Self-dismissing messages: 4s for success, 8s for an error (longer, so the text can be read).
  // These durations must match the cmAlertLife / cmAlertLifeLong keyframes in the CSS.
  useEffect(() => {
    if (!successMsg) return;
    const timer = setTimeout(() => setSuccessMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [successMsg]);

  useEffect(() => {
    if (!errorMsg) return;
    const timer = setTimeout(() => setErrorMsg(null), 8000);
    return () => clearTimeout(timer);
  }, [errorMsg]);

  // Connection-less Backup/Restore States
  const [brAction, setBrAction] = useState<'backup' | 'restore'>('backup');
  const [brType, setBrType] = useState<'sqlite' | 'postgres' | 'mysql'>('sqlite');
  const [brSqlitePath, setBrSqlitePath] = useState('');
  const [brPgHost, setBrPgHost] = useState('localhost');
  const [brPgPort, setBrPgPort] = useState(5432);
  const [brPgUser, setBrPgUser] = useState('postgres');
  const [brPgPassword, setBrPgPassword] = useState('');
  const [brPgDatabase, setBrPgDatabase] = useState('postgres');
  const [brMyHost, setBrMyHost] = useState('localhost');
  const [brMyPort, setBrMyPort] = useState(3306);
  const [brMyUser, setBrMyUser] = useState('root');
  const [brMyPassword, setBrMyPassword] = useState('');
  const [brMyDatabase, setBrMyDatabase] = useState('');

  // The suggested file name is `bk_<database>_<timestamp>`, but typing stops the suggestions
  // (`brFilenameTouched`) — otherwise switching database would wipe the name they just chose.
  const [brFilename, setBrFilename] = useState('');
  const [brFilenameTouched, setBrFilenameTouched] = useState(false);
  // The timestamp is fixed ONCE when the screen opens: recomputing it per render makes the number in
  // the field jump around while the user is typing the host or database.
  const [brStamp, setBrStamp] = useState(() => fileStamp());
  const [brCompressGzip, setBrCompressGzip] = useState(false);
  const [brDropTable, setBrDropTable] = useState(true);
  const [brIncludeStructure, setBrIncludeStructure] = useState(true);
  const [brIncludeContent, setBrIncludeContent] = useState(true);
  // The dump to restore, as a PATH: Rust reads it itself (`scan_dump_file`, then `restore_backup`),
  // so the file never enters the webview. It used to be a `File` read with `readAsText` — which
  // froze the window on a large dump and did not gunzip a `.gz` at all.
  const [brDumpPath, setBrDumpPath] = useState<string | null>(null);
  const [brScan, setBrScan] = useState<DumpScan | null>(null);
  const [brScanPct, setBrScanPct] = useState<number | null>(null);
  // A newer pick supersedes a scan still running; its answer must not land on the newer file.
  const brScanSeq = useRef(0);
  // Drop same-named objects before running the dump (otherwise it fails with "already exists")
  const [brOverwrite, setBrOverwrite] = useState(false);
  // Skip a failing statement instead of rolling everything back — the same meaning as the checkbox in the Import dialog.
  const [brContinueOnError, setBrContinueOnError] = useState(false);
  // The confirmation summary plus the restore's real progress
  const [brConfirm, setBrConfirm] = useState(false);
  const [brParsedTables, setBrParsedTables] = useState<string[]>([]);
  const [brSelectedTables, setBrSelectedTables] = useState<string[]>([]);
  const [brParsing, setBrParsing] = useState(false);

  const [availableDatabases, setAvailableDatabases] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);

  // Re-entering Backup & Restore suggests the file name again with a fresh timestamp.
  useEffect(() => {
    if (activeType !== 'backup_restore') return;
    setBrFilenameTouched(false);
    setBrStamp(fileStamp());
  }, [activeType]);

  /**
   * `bk_<database>_<20260821_143512>`: sorts by time, and two backups in a row do not overwrite each
   * other. For SQLite it takes the file name without its extension rather than the whole path —
   * `safeFileBase` would turn `C:\data\demo.db` into `C__data_demo.db`.
   */
  const brDbLabel = brType === 'sqlite'
    ? fileBaseFromPath(brSqlitePath)
    : brType === 'postgres' ? brPgDatabase : brMyDatabase;
  const brSuggestedFilename = `bk_${safeFileBase(brDbLabel)}_${brStamp}`;
  const brEffectiveFilename = brFilenameTouched ? brFilename : brSuggestedFilename;

  // The SSL config currently selected in the form — it has to ride along with every secondary command
  // (listing databases, backup/restore), or the backend reads it as DISABLED and turns TLS off.
  const currentSslConfig = () => ({
    sslEnabled,
    sslMode,
    sslKeyPath,
    sslCertPath,
    sslCaPath,
  });

  // The Backup & Restore form has no SSL section of its own: it follows the selected profile, and
  // with no profile it stays at PREFERRED (use TLS when the server supports it).
  const brSslConfig = () => {
    const prof = profiles.find(p => p.id === selectedBrProfileId);
    const c: any = prof?.config || {};
    return {
      sslEnabled: c.sslEnabled ?? false,
      sslMode: c.sslMode || 'PREFERRED',
      sslKeyPath: c.sslKeyPath || '',
      sslCertPath: c.sslCertPath || '',
      sslCaPath: c.sslCaPath || '',
    };
  };

  const fetchDatabases = async (type: 'postgres' | 'mysql' | 'br_mysql' | 'br_postgres') => {
    setLoadingDbs(true);
    setErrorMsg(null);
    let config: DbConnectionConfig;

    if (type === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        ...currentSslConfig(),
      };
    } else if (type === 'mysql') {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        ...currentSslConfig(),
      };
    } else if (type === 'br_postgres') {
      config = {
        type: 'postgres',
        host: brPgHost,
        port: brPgPort,
        user: brPgUser,
        password: brPgPassword,
        database: brPgDatabase,
        ...brSslConfig(),
      };
    } else {
      config = {
        type: 'mysql',
        host: brMyHost,
        port: brMyPort,
        user: brMyUser,
        password: brMyPassword,
        database: brMyDatabase,
        ...brSslConfig(),
      };
    }

    try {
      const res = await dbHelper.getDatabasesList(config);
      if (res.success && res.databases) {
        setAvailableDatabases(res.databases);
      } else {
        setErrorMsg(res.error || t('connection.errLoadDatabases'));
      }
    } catch (e: any) {
      setErrorMsg(e.toString());
    } finally {
      setLoadingDbs(false);
    }
  };

  // fetchDatabases is recreated on every render (it reads a great deal of state). It CANNOT go
  // straight into the deps of the three debounced effects below: the effect would re-run after every
  // render, resetting the 500ms timer over and over so it practically never fires -> the automatic
  // database list simply stops working. The newest version is kept in a ref instead: a ref is stable,
  // so exhaustive-deps does not ask for it, and the effect still calls the latest one.
  const fetchDbRef = useRef(fetchDatabases);
  useEffect(() => { fetchDbRef.current = fetchDatabases; });

  // Auto-load databases for Postgres
  useEffect(() => {
    if (activeType !== 'postgres') return;
    if (!pgHost.trim() || !pgUser.trim()) return;

    const timer = setTimeout(() => {
      fetchDbRef.current('postgres');
    }, 500);

    return () => clearTimeout(timer);
  }, [pgHost, pgPort, pgUser, pgPassword, activeType]);

  // Auto-load databases for MySQL
  useEffect(() => {
    if (activeType !== 'mysql') return;
    if (!myHost.trim() || !myUser.trim()) return;

    const timer = setTimeout(() => {
      fetchDbRef.current('mysql');
    }, 500);

    return () => clearTimeout(timer);
  }, [myHost, myPort, myUser, myPassword, activeType]);

  // Auto-load databases for Backup & Restore
  useEffect(() => {
    if (activeType !== 'backup_restore') return;
    if (brType === 'sqlite') return;

    if (brType === 'postgres') {
      if (!brPgHost.trim() || !brPgUser.trim()) return;
      const timer = setTimeout(() => {
        fetchDbRef.current('br_postgres');
      }, 500);
      return () => clearTimeout(timer);
    } else {
      if (!brMyHost.trim() || !brMyUser.trim()) return;
      const timer = setTimeout(() => {
        fetchDbRef.current('br_mysql');
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [brType, brPgHost, brPgPort, brPgUser, brPgPassword, brMyHost, brMyPort, brMyUser, brMyPassword, activeType]);

  const pickBrDump = async () => {
    const path = await pickOpenFile({
      title: t('connection.brPickFile'),
      filters: [{ name: 'SQL dump', extensions: ['sql', 'gz', 'dump'] }],
    });
    if (!path) return;
    const seq = ++brScanSeq.current;
    setBrDumpPath(path);
    setBrScan(null);
    setBrParsedTables([]);
    setBrSelectedTables([]);
    setBrScanPct(0);
    setBrParsing(true);
    setErrorMsg(null);
    try {
      const scan = await dbHelper.scanDumpFile(path, (prog) => {
        if (seq === brScanSeq.current && prog.bytesTotal) {
          setBrScanPct(Math.floor((prog.bytesDone / prog.bytesTotal) * 100));
        }
      });
      if (seq !== brScanSeq.current || !scan) return;
      setBrScan(scan);
      // The same detector the Import dialog uses: it also recognises VIEWs (a dump writes them
      // with CREATE VIEW / DROP VIEW, not DROP TABLE) and rejects temp tables inside routines.
      setBrParsedTables(scan.tables);
      setBrSelectedTables(scan.tables);
    } catch (err: any) {
      if (seq !== brScanSeq.current) return;
      setBrDumpPath(null);
      setErrorMsg(t('importDialog.errReadFile', { message: err?.message || String(err) }));
    } finally {
      if (seq === brScanSeq.current) {
        setBrParsing(false);
        setBrScanPct(null);
      }
    }
  };

  // Connection Profiles States
  const [profiles, setProfiles] = useState<SavedProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(() => localStorage.getItem('tf_default_profile_id'));
  const [selectedBrProfileId, setSelectedBrProfileId] = useState<string | null>(null);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileColor, setProfileColor] = useState('');
  const [profileEnv, setProfileEnv] = useState<ConnEnv>('none');
  const [profileGroup, setProfileGroup] = useState('');
  const [secretError, setSecretError] = useState<string | null>(null); // an error while working with the OS secret store
  const [showMasterPassword, setShowMasterPassword] = useState(false);

  // The ONE place profiles are written: it always strips the secrets out of the config before
  // touching localStorage, and pushes them into the OS secret store at the same time. The in-memory
  // state keeps the stripped version too, so no path can accidentally serialize a password again.
  const persistProfiles = async (list: SavedProfile[]): Promise<SavedProfile[]> => {
    const stripped: SavedProfile[] = [];
    const pending: Array<Promise<void>> = [];

    for (const p of list) {
      const values = pickSecrets(p.config);
      stripped.push({ ...p, config: publicConfig(p.config) });
      if (Object.keys(values).length > 0) pending.push(dbHelper.setSecrets(p.id, values));
    }

    setProfiles(stripped);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(stripped));

    try {
      await Promise.all(pending);
      setSecretError(null);
    } catch (e: any) {
      // The config was still saved; only the secrets failed to reach the OS store -> say so plainly.
      void refreshVaultStatus();
      setSecretError(t('connection.errSaveSecrets', { message: e?.message || e }));
    }
    return stripped;
  };

  // Reads a profile's secrets back out of the OS store and merges them into the config for use.
  const configWithSecrets = async (profile: SavedProfile): Promise<any> => {
    try {
      const secrets = await dbHelper.getSecrets(profile.id, SECRET_FIELD_LIST);
      return mergeSecrets(profile.config, secrets);
    } catch (e: any) {
      // A master password that locked itself is one reason the store refuses. Ask the backend
      // rather than reading the message — see `utils/vault.ts` — and the lock screen comes back on
      // its own if that is what happened.
      void refreshVaultStatus();
      setSecretError(t('connection.errReadSecrets', { message: e?.message || e }));
      return profile.config;
    }
  };

  // Copies the secrets to another id, OS store -> OS store directly. Deliberately does NOT read them
  // out and attach them to the profile object: the profile is what goes into localStorage, and
  // routing secrets through it opens a path — however brief — from the secret store into something
  // that gets written to disk.
  const copySecretsBetweenProfiles = async (fromId: string, toId: string): Promise<void> => {
    try {
      const values = await dbHelper.getSecrets(fromId, SECRET_FIELD_LIST);
      if (Object.keys(values).length > 0) await dbHelper.setSecrets(toId, values);
      setSecretError(null);
    } catch (e: any) {
      setSecretError(t('connection.errCopySecrets', { message: e?.message || e }));
    }
  };

  const handleToggleDefaultProfile = (profileId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const nextId = defaultProfileId === profileId ? null : profileId;
    setDefaultProfileId(nextId);
    if (nextId) {
      localStorage.setItem('tf_default_profile_id', nextId);
    } else {
      localStorage.removeItem('tf_default_profile_id');
    }
  };

  const [showImportUrlModal, setShowImportUrlModal] = useState(false);
  const [importUrlInput, setImportUrlInput] = useState('');

  // Export & Import Connections States
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportScope, setExportScope] = useState<'all' | 'group' | 'single'>('all');
  const [exportGroupTarget, setExportGroupTarget] = useState<string>('');
  const [exportSingleProfile, setExportSingleProfile] = useState<SavedProfile | null>(null);
  const [exportIncludePasswords, setExportIncludePasswords] = useState(false);
  const [exportFilePassword, setExportFilePassword] = useState('');
  const [exporting, setExporting] = useState(false);

  const [showImportPasswordModal, setShowImportPasswordModal] = useState(false);
  const [pendingImportContent, setPendingImportContent] = useState<string | null>(null);
  const [importPasswordInput, setImportPasswordInput] = useState('');
  const [importing, setImporting] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    scope: 'all' | 'group' | 'single';
    groupName?: string;
    profile?: SavedProfile;
  } | null>(null);

  // The profile whose Terminal is open (null = none). With SSH -> an SSH terminal; without -> a local shell.
  const [terminalProfile, setTerminalProfile] = useState<SavedProfile | null>(null);

  // Two confirmations replacing window.confirm (which shows nothing in the Tauri webview).
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null);
  const [confirmPlainExport, setConfirmPlainExport] = useState(false);

  const openExportModal = (scope: 'all' | 'group' | 'single', groupName?: string, profile?: SavedProfile) => {
    setExportScope(scope);
    setExportGroupTarget(groupName || '');
    setExportSingleProfile(profile || null);
    setExportIncludePasswords(false);
    setExportFilePassword('');
    setShowExportModal(true);
    setContextMenu(null);
  };

  /**
   * `plainConfirmed` = the "passwords in the clear" warning has already been answered.
   *
   * The warning used to be a `window.confirm()` in the middle of this function, which shows
   * nothing inside the Tauri webview (the dialog plugin has no `confirm` command) — the
   * export then continued as if the user had agreed. It is now asked BEFORE any work, so
   * cancelling also means no secret is read out of the OS keychain.
   */
  const handlePerformExport = async (plainConfirmed = false) => {
    if (exportIncludePasswords && !exportFilePassword.trim() && !plainConfirmed) {
      setConfirmPlainExport(true);
      return;
    }
    setExporting(true);
    try {
      let targetProfiles: SavedProfile[] = [];
      if (exportScope === 'all') {
        targetProfiles = [...profiles];
      } else if (exportScope === 'group') {
        targetProfiles = profiles.filter(p => (p.group?.trim() || t('connection.defaultGroup')) === exportGroupTarget);
      } else if (exportScope === 'single' && exportSingleProfile) {
        targetProfiles = [exportSingleProfile];
      }

      if (targetProfiles.length === 0) {
        alert(t('connection.errNoProfilesToExport'));
        setExporting(false);
        return;
      }

      // Asking for the destination BEFORE reading any secret, for the same reason the plaintext
      // warning above is asked first: cancelling the dialog must not have touched the keychain.
      const baseName = exportScope === 'group' ? `TableGrid_${exportGroupTarget.replace(/[^a-zA-Z0-9]/g, '_')}_Connections` :
        exportScope === 'single' ? `TableGrid_${exportSingleProfile?.name.replace(/[^a-zA-Z0-9]/g, '_')}_Connection` :
          'TableGrid_All_Connections';
      const targetPath = await pickSaveFilePath(baseName, CONNECTION_FILE_EXT, t('connection.exportFileFilter'));
      if (!targetPath) {
        setExporting(false);
        return;
      }

      // The in-memory profiles no longer hold secrets -> exporting with passwords means reading them
      // back from the OS secret store. Without them, the stripped version is used as-is.
      const processedProfiles = await Promise.all(
        targetProfiles.map(async p => {
          const cloned = JSON.parse(JSON.stringify(p));
          cloned.config = exportIncludePasswords ? await configWithSecrets(p) : publicConfig(cloned.config);
          return cloned;
        })
      );

      const encryptedText = await encryptConnectionExport(processedProfiles, exportFilePassword);

      // `false` = the direct write was refused and it fell back to a WebView download, so the path
      // it returned is not where the file landed and must not be reported as if it were.
      const writtenAtPath = await saveExportFileAtPath(targetPath, encryptedText, 'application/json');

      setShowExportModal(false);
      setSuccessMsg(writtenAtPath
        ? `${t('connection.exportSuccess', { n: processedProfiles.length })} — ${targetPath}`
        : t('connection.exportSuccess', { n: processedProfiles.length }));
    } catch (e: any) {
      alert(t('connection.errExport', { message: e.message }));
    } finally {
      setExporting(false);
    }
  };

  const handleFileImportSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const content = evt.target?.result as string;
      if (!content) return;

      try {
        await processImportContent(content);
      } catch (err: any) {
        if (err.requiresPassword) {
          setPendingImportContent(content);
          setImportPasswordInput('');
          setShowImportPasswordModal(true);
        } else {
          alert(t('connection.errImport', { message: err.message }));
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const processImportContent = async (content: string, password?: string) => {
    setImporting(true);
    try {
      const importedData = await decryptConnectionExport(content, password);
      let newProfilesToImport: SavedProfile[] = [];

      if (Array.isArray(importedData)) {
        newProfilesToImport = importedData;
      } else if (importedData && typeof importedData === 'object') {
        if (Array.isArray(importedData.profiles)) {
          newProfilesToImport = importedData.profiles;
        } else if (importedData.id && importedData.type && importedData.config) {
          newProfilesToImport = [importedData as SavedProfile];
        }
      }

      if (newProfilesToImport.length === 0) {
        throw new Error(t('connection.errImportInvalid'));
      }

      // Merge into existing profiles without duplicate IDs
      const existingIds = new Set(profiles.map(p => p.id));
      const merged = [...profiles];
      let importedCount = 0;

      for (const item of newProfilesToImport) {
        if (!item.name || !item.type || !item.config) continue;
        let itemToSave = { ...item };
        if (existingIds.has(itemToSave.id)) {
          itemToSave.id = newProfileId();
        }
        merged.push(itemToSave);
        existingIds.add(itemToSave.id);
        importedCount++;
      }

      // An imported file may hold plaintext passwords -> persistProfiles pushes them into the OS
      // store and writes only the clean config to localStorage.
      await persistProfiles(merged);
      setShowImportPasswordModal(false);
      setPendingImportContent(null);
      setSuccessMsg(t('connection.importSuccess', { n: importedCount }));
    } catch (e: any) {
      if (e.requiresPassword) {
        throw e;
      }
      alert(t('connection.errImport', { message: e.message }));
    } finally {
      setImporting(false);
    }
  };

  const handlePasswordDecryptSubmit = async () => {
    if (!pendingImportContent) return;
    try {
      await processImportContent(pendingImportContent, importPasswordInput);
    } catch (err: any) {
      if (!err.requiresPassword) {
        alert(t('connection.errDecrypt', { message: err.message }));
      }
    }
  };

  const parseConnectionUrl = (urlStr: string) => {
    try {
      const cleanUrl = urlStr.trim();
      if (!cleanUrl) return null;

      if (cleanUrl.startsWith('sqlite://')) {
        const path = cleanUrl.replace('sqlite://', '');
        return {
          type: 'sqlite' as const,
          config: { type: 'sqlite', sqlitePath: path }
        };
      }

      let protocol: 'postgres' | 'mysql' = 'postgres';
      if (cleanUrl.startsWith('postgres://') || cleanUrl.startsWith('postgresql://')) {
        protocol = 'postgres';
      } else if (cleanUrl.startsWith('mysql://')) {
        protocol = 'mysql';
      } else {
        throw new Error(t('connection.errUrlProtocol'));
      }

      // Parse URL
      const urlToParse = cleanUrl.replace(/^(postgres|postgresql|mysql):\/\//, 'http://');
      const parsed = new URL(urlToParse);

      const host = parsed.hostname || 'localhost';
      const port = parsed.port ? parseInt(parsed.port) : (protocol === 'postgres' ? 5432 : 3306);
      const user = decodeURIComponent(parsed.username || (protocol === 'postgres' ? 'postgres' : 'root'));
      const password = decodeURIComponent(parsed.password || '');
      let database = parsed.pathname ? parsed.pathname.substring(1) : '';
      if (database.includes('?')) {
        database = database.split('?')[0];
      }
      database = decodeURIComponent(database);

      return {
        type: protocol,
        config: {
          type: protocol,
          host,
          port,
          user,
          password,
          database: database || (protocol === 'postgres' ? 'postgres' : '')
        }
      };
    } catch (e: any) {
      alert(t('connection.errUrlFormat', { message: e.message }));
      return null;
    }
  };

  const handleImportUrlSubmit = async () => {
    const res = parseConnectionUrl(importUrlInput);
    if (!res) return;

    const newProfile: SavedProfile = {
      id: newProfileId(),
      name: `Imported ${res.type.toUpperCase()} (${res.config.host || res.config.sqlitePath || 'DB'})`,
      type: res.type,
      config: res.config
    };

    setShowImportUrlModal(false);
    setImportUrlInput('');
    // New-connection dialog: only a draft — it is saved when Connect succeeds, like one typed by hand.
    // The password stays inline in the draft's config; persistProfiles strips it out on that save.
    if (isNew) {
      selectProfile(newProfile);
      return;
    }

    // A connection URL usually carries the password -> split it into the OS store as it is saved.
    await persistProfiles([...profiles, newProfile]);
    selectProfile(newProfile);
    setSuccessMsg(t('connection.importUrlSuccess'));
  };


  // Load saved connection configurations from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(PROFILES_KEY);
    const savedDefaultId = localStorage.getItem('tf_default_profile_id');
    if (saved) {
      try {
        const raw: SavedProfile[] = JSON.parse(saved);
        // Legacy migration #2: the environment used to be inferred from the colour. Fill `env` in
        // once and write it back, so that from here on a colour is only a colour.
        const migrated = migrateProfileEnvs(raw);
        const parsed = migrated ?? raw;
        // Legacy migration: profiles saved earlier still have passwords sitting in localStorage.
        // Push them into the OS secret store, then write the stripped version back over them.
        if (migrated || parsed.some(p => hasInlineSecrets(p.config))) {
          persistProfiles(parsed);
        } else {
          setProfiles(parsed);
        }
        // The new-connection dialog starts empty: pre-filling it with the default profile is what
        // made "New connection…" open onto the connection that was already open.
        if (parsed.length > 0 && !isNew) {
          const defaultProf = parsed.find(p => p.id === savedDefaultId) || parsed[0];
          selectProfile(defaultProf);
        }
      } catch { }
    } else {
      setProfiles([]);
      localStorage.setItem(PROFILES_KEY, JSON.stringify([]));
    }
    // Mount-only bootstrap. persistProfiles/selectProfile now close over `t`,
    // whose identity changes on every language switch, so listing them here
    // would reload the profiles and wipe a half-filled form on each switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fills the form from a profile. Secrets no longer live in profile.config and have to be read from
  // the OS store -> this function is async; the non-sensitive fields appear at once and the password
  // boxes fill in right after.
  const selectProfile = async (profile: SavedProfile) => {
    setActiveProfileId(profile.id);
    setActiveType(profile.type);
    setTestStatus('untested');
    setFormTab('general');
    setErrorMsg(null);
    setSuccessMsg(null);
    setProfileNameInput(profile.name);
    setProfileColor(profile.color || '');
    // `normalizeEnv` rather than `profile.env ?? 'none'`: a profile can come from another build's
    // export file, and an unfamiliar string reaching here leaves the select matching no option at all.
    setProfileEnv(normalizeEnv(profile.env));
    setProfileGroup(profile.group || '');

    const config = await configWithSecrets(profile);
    if (profile.type === 'sqlite') {
      setSqlitePath(config.sqlitePath || '');
    } else if (profile.type === 'redis') {
      setRedisHost(config.host || '127.0.0.1');
      setRedisPort(config.port || 6379);
      setRedisUser(config.user || '');
      setRedisPassword(config.password || '');
      setRedisDbIndex(config.dbIndex ?? 0);
      setSslEnabled(config.sslEnabled || false);
      // Profiles saved before the SSL tab existed have only the switch, and that switch meant
      // rediss:// with full certificate verification -> VERIFY_IDENTITY, not the weakest mode.
      setSslMode(config.sslMode || (config.sslEnabled ? 'VERIFY_IDENTITY' : 'DISABLED'));
      setSslKeyPath(config.sslKeyPath || '');
      setSslCertPath(config.sslCertPath || '');
      setSslCaPath(config.sslCaPath || '');
      setSshEnabled(config.sshEnabled || false);
      setSshHost(config.sshHost || '');
      setSshPort(config.sshPort || 22);
      setSshUser(config.sshUser || '');
      setSshAuthType(config.sshAuthType || 'password');
      setSshPassword(config.sshPassword || '');
      setSshKeyPath(config.sshKeyPath || '');
      setSshKeyContent(config.sshKeyContent || '');
      setSshPassphrase(config.sshPassphrase || '');
    } else if (profile.type === 'postgres') {
      setPgHost(config.host || 'localhost');
      setPgPort(config.port || 5432);
      setPgUser(config.user || 'postgres');
      setPgPassword(config.password || '');
      setPgDatabase(config.database || 'postgres');
      setSslEnabled(config.sslEnabled || false);
      setSslMode(config.sslMode || (config.sslEnabled ? 'PREFERRED' : 'DISABLED'));
      setSslKeyPath(config.sslKeyPath || '');
      setSslCertPath(config.sslCertPath || '');
      setSslCaPath(config.sslCaPath || '');
      setSshEnabled(config.sshEnabled || false);
      setSshHost(config.sshHost || '');
      setSshPort(config.sshPort || 22);
      setSshUser(config.sshUser || '');
      setSshAuthType(config.sshAuthType || 'password');
      setSshPassword(config.sshPassword || '');
      setSshKeyPath(config.sshKeyPath || '');
      setSshKeyContent(config.sshKeyContent || '');
      setSshPassphrase(config.sshPassphrase || '');
      setAuthMethod(config.authMethod || 'password');
      setAwsAuthType(config.awsAuthType || 'access_key');
      setAwsAccessKeyId(config.awsAccessKeyId || '');
      setAwsSecretAccessKey(config.awsSecretAccessKey || '');
      setAwsSessionToken(config.awsSessionToken || '');
      setAwsProfile(config.awsProfile || '');
      setAwsRegion(config.awsRegion || '');
    } else if (profile.type === 'mysql') {
      setMyHost(config.host || 'localhost');
      setMyPort(config.port || 3306);
      setMyUser(config.user || 'root');
      setMyPassword(config.password || '');
      setMyDatabase(config.database || '');
      setSslEnabled(config.sslEnabled || false);
      setSslMode(config.sslMode || (config.sslEnabled ? 'PREFERRED' : 'DISABLED'));
      setSslKeyPath(config.sslKeyPath || '');
      setSslCertPath(config.sslCertPath || '');
      setSslCaPath(config.sslCaPath || '');
      setSshEnabled(config.sshEnabled || false);
      setSshHost(config.sshHost || '');
      setSshPort(config.sshPort || 22);
      setSshUser(config.sshUser || '');
      setSshAuthType(config.sshAuthType || 'password');
      setSshPassword(config.sshPassword || '');
      setSshKeyPath(config.sshKeyPath || '');
      setSshKeyContent(config.sshKeyContent || '');
      setSshPassphrase(config.sshPassphrase || '');
      setAuthMethod(config.authMethod || 'password');
      setAwsAuthType(config.awsAuthType || 'access_key');
      setAwsAccessKeyId(config.awsAccessKeyId || '');
      setAwsSecretAccessKey(config.awsSecretAccessKey || '');
      setAwsSessionToken(config.awsSessionToken || '');
      setAwsProfile(config.awsProfile || '');
      setAwsRegion(config.awsRegion || '');
    }
  };

  // Three places need exactly the same Redis payload (saving a profile, connecting, testing). Each
  // used to build its own, and the save-profile branch was missing it entirely — a saved Redis
  // profile came out with an empty config.
  const buildRedisConfig = (): DbConnectionConfig => ({
    type: 'redis',
    host: redisHost,
    port: redisPort,
    user: redisUser,
    password: redisPassword,
    dbIndex: redisDbIndex,
    sslEnabled,
    sslMode,
    sslKeyPath,
    sslCertPath,
    sslCaPath,
    sshEnabled,
    sshHost,
    sshPort,
    sshUser,
    sshAuthType,
    sshPassword,
    sshKeyPath,
    sshKeyContent,
    sshPassphrase,
  });

  // Upsert: the new-connection dialog's draft is not in `profiles` yet, and its first save appends it.
  // `silent` skips the "saved" banner, for the save that rides along with a successful Connect.
  const handleSaveProfile = async (silent = false): Promise<SavedProfile | null> => {
    if (!activeProfileId) return null;
    const targetName = profileNameInput.trim() || t('connection.defaultProfileName');

    let config: any = {};
    if (activeType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath };
    } else if (activeType === 'redis') {
      config = buildRedisConfig();
    } else if (activeType === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    } else if (activeType === 'mysql') {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    }

    const fields = { name: targetName, type: activeType as any, config, color: profileColor, env: profileEnv, group: profileGroup };
    const existing = profiles.find(p => p.id === activeProfileId);
    const saved: SavedProfile = { ...(existing || {}), id: activeProfileId, ...fields };
    const updatedProfiles = existing
      ? profiles.map(p => (p.id === activeProfileId ? saved : p))
      : [...profiles, saved];

    // The config comes from the form and so holds the password; persistProfiles splits it into the OS store before writing.
    const stripped = await persistProfiles(updatedProfiles);
    if (!silent) setSuccessMsg(t('connection.saveSuccess'));
    return stripped.find(p => p.id === activeProfileId) || null;
  };

  // A fresh profile for `type` with that engine's usual defaults. Not saved by itself.
  const blankProfile = (type: 'sqlite' | 'postgres' | 'mysql' | 'redis'): SavedProfile => {
    // sslMode has to be in the config itself, not only in the state's initial value: selectProfile
    // reads it back from the config, and without the field it falls back to DISABLED and
    // overwrites whatever the form is showing.
    return {
      id: newProfileId(),
      name: t('connection.newProfileName', { type: type.toUpperCase() }),
      type,
      config: type === 'sqlite'
        ? { type, sqlitePath: 'new_database.db' }
        : type === 'postgres'
          ? { type, host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', sslMode: 'PREFERRED' }
          : type === 'redis'
            ? { type, host: '127.0.0.1', port: 6379, user: '', password: '', dbIndex: 0 }
            : { type, host: 'localhost', port: 3306, user: 'root', database: '', sslMode: 'PREFERRED' }
    };
  };

  const handleCreateNewProfile = async (type: 'sqlite' | 'postgres' | 'mysql' | 'redis') => {
    const newProfile = blankProfile(type);
    // The new-connection dialog keeps it as a draft until Connect succeeds.
    if (!isNew) await persistProfiles([...profiles, newProfile]);
    selectProfile(newProfile);
  };

  // New-connection dialog: back from the form to the type picker.
  const handleBackToTypes = () => {
    setActiveProfileId(null);
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleDeleteProfile = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteProfileId(id);
  };

  const doDeleteProfile = async (id: string) => {
    const newProfiles = profiles.filter(p => p.id !== id);
    await persistProfiles(newProfiles);
    // Clear the secrets in the OS store as well; do not leave orphaned entries behind.
    try {
      await dbHelper.deleteSecrets(id, SECRET_FIELD_LIST);
    } catch (err: any) {
      setSecretError(t('connection.errDeleteSecrets', { message: err?.message || err }));
    }

    if (activeProfileId === id) {
      if (newProfiles.length > 0) {
        selectProfile(newProfiles[0]);
      } else {
        setActiveProfileId(null);
      }
    }
  };

  const handleDuplicateProfile = async (profile: SavedProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    // The copy has to carry the secrets too, but they are duplicated inside the OS store itself (see
    // copySecretsBetweenProfiles) rather than riding along in `duplicated.config`.
    const duplicated: SavedProfile = {
      ...profile,
      id: newProfileId(),
      name: `${profile.name} (Copy)`,
      config: publicConfig(profile.config)
    };
    await persistProfiles([...profiles, duplicated]);
    // Must finish before selectProfile: that function reads the secrets by the new id to fill the form.
    await copySecretsBetweenProfiles(profile.id, duplicated.id);
    selectProfile(duplicated);
  };

  const handleConnect = async (_isDemo = false) => {
    setIsConnecting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    let config: DbConnectionConfig;

    if (activeType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath };
    } else if (activeType === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
      // The 'tf_pg_config' / 'tf_ssh_config' caches were removed here: nothing read them back, and
      // 'tf_ssh_config' in particular wrote sshKeyContent (the private key) and sshPassphrase into
      // localStorage in plaintext. Connection config now lives only in the profile (in localStorage,
      // with secrets stripped) and the secrets themselves in the OS secret store
      // (dbHelper.setSecrets).
    } else if (activeType === 'redis') {
      config = buildRedisConfig();
    } else {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
      // See the note in the postgres branch: the 'tf_my_config' / 'tf_ssh_config' caches were removed.
    }

    // 'tf_last_type' was dropped too: it was written but never read anywhere.

    const res = await dbHelper.connect(config);

    setIsConnecting(false);
    if (res.success) {
      setSuccessMsg(res.message);
      setIsSuccessConnecting(true);
      setConnectingDbName(res.database || (config.type === 'sqlite' ? config.sqlitePath : config.database) || 'Database');
      let activeProfile = profiles.find(p => p.id === activeProfileId);
      // New-connection dialog: the draft is saved only now that it is known to work.
      if (!activeProfile && isNew && saveToList) activeProfile = (await handleSaveProfile(true)) || undefined;
      // The environment comes from the FORM'S STATE, not from the saved profile.
      //
      // `config` just above is built from the form as well: host, port, user, SSL and the rest all go
      // straight into this connection even though the user never pressed Save. Reading `env` from the
      // saved copy instead would leave the select showing "Production" while the connection opened on
      // the old value — the worst possible gap for a safety flag, because what is displayed and what
      // is in force are no longer the same thing. Saving stays a separate act: it decides whether next
      // time remembers, not what this time does.
      const env = profileEnv;
      setTimeout(() => {
        onConnect(
          res.database || 'Database',
          config.type,
          activeProfile?.color,
          config,
          // A hand-built connection (never saved as a profile) still has to receive the environment
          // just selected: having nowhere to remember it does not mean this session may ignore it.
          activeProfile || env !== 'none'
            ? { id: activeProfile?.id ?? '', name: activeProfile?.name ?? '', env }
            : undefined,
          res.schema,
        );
      }, 480);
    } else {
      setErrorMsg(res.message);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    // Redis: tested with redis_connect itself (a PING) through dbHelper.connect.
    if (activeType === 'redis') {
      const res = await dbHelper.connect(buildRedisConfig());
      setIsTesting(false);
      setTestStatus(res.success ? 'ok' : 'fail');
      if (res.success) setSuccessMsg(t('connection.redisTestOk'));
      else setErrorMsg(res.message);
      // Disconnect the test connection so no session is left holding on.
      await dbHelper.redisDisconnect();
      return;
    }

    let config: DbConnectionConfig;
    if (activeType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath };
    } else if (activeType === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    } else {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    }

    const res = await dbHelper.connect(config);
    setIsTesting(false);
    setTestStatus(res.success ? 'ok' : 'fail');
    if (res.success) {
      setSuccessMsg(t('connection.testOk'));
      await dbHelper.disconnect();
    } else {
      setErrorMsg(res.message);
    }
  };

  // Pressing "Start restore" shows the summary first (target database, table count, statement count,
  // estimate) and only then runs; the backup branch runs immediately.
  const handleBrClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (brAction === 'restore') {
      setBrConfirm(true);
      return;
    }
    handleBrSubmit();
  };

  /**
   * Runs Backup / Restore as a **background job**: this function only snapshots everything currently
   * on the form and queues the job, while progress and result live in `JobsTray`. It used to hold the
   * whole screen — and a sakila restore takes tens of minutes. See docs/background-jobs-plan.md.
   *
   * Every value taken from the form is **copied into a local variable before the job is queued**: the
   * job may run later (from the queue), and by then the user may have typed a different server into
   * this very form.
   */
  const handleBrSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBrConfirm(false);
    setErrorMsg(null);
    setSuccessMsg(null);

    let config: DbConnectionConfig;
    if (brType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath: brSqlitePath };
    } else if (brType === 'postgres') {
      config = {
        type: 'postgres',
        host: brPgHost,
        port: brPgPort,
        user: brPgUser,
        password: brPgPassword,
        database: brPgDatabase,
        ...brSslConfig(),
      };
    } else {
      config = {
        type: 'mysql',
        host: brMyHost,
        port: brMyPort,
        user: brMyUser,
        password: brMyPassword,
        database: brMyDatabase,
        ...brSslConfig(),
      };
    }

    const isBackup = brAction === 'backup';
    if (!isBackup && (!brDumpPath || !brScan)) {
      setErrorMsg(t('connection.errNoBackupFile'));
      return;
    }

    // The form's snapshot — see the doc comment above.
    const targetType = brType;
    const dbLabel = brDbLabel || (targetType === 'sqlite' ? brSqlitePath : '');
    const fileName = (brEffectiveFilename.trim().replace(/\.(sql|sql\.gz|gz)$/i, '') || brSuggestedFilename)
      + (brCompressGzip ? '.sql.gz' : '.sql');
    const gzip = brCompressGzip;
    const sqlOptions = {
      dropTable: brDropTable,
      includeStructure: brIncludeStructure,
      includeContent: brIncludeContent,
    };
    const dumpPath = brDumpPath ?? '';
    const dumpScan = brScan;
    const overwrite = brOverwrite;
    const dropStatements = brOverwrite ? [...brDropStatements] : [];
    const selectedTables = [...brSelectedTables];
    const continueOnError = brContinueOnError;

    // Safe Mode asks now, by server — nothing is connected yet, and the job may wait in the queue.
    // A backup only reads, so it is never asked about.
    let approvals: JobApproval[] = [];
    if (!isBackup) {
      try {
        approvals = [
          await approveJobForServer('restore_backup', connKey(config), t('jobs.approveRestore', { n: dbLabel })),
        ];
      } catch {
        return;
      }
    }
    // Set once the job's connection is open; `onCancel` has to name it.
    let restoreConnId = '';

    startJob({
      kind: isBackup ? 'dump' : 'restore',
      title: t(isBackup ? 'jobs.titleBackup' : 'jobs.titleRestore', { n: dbLabel }),
      db: dbLabel,
      conn: connKey(config),
      write: !isBackup,
      lockKey: `br|${connKey(config)}|${dbLabel}`,
      onCancel: () => {
        if (restoreConnId) void dbHelper.cancelRestore(restoreConnId);
      },
      run: async (ctx) => {
        // This job opens a CONNECTION OF ITS OWN and closes it again ("no existing connection
        // required"). `connectJob`, not `connect`: it leaves the app's active connection alone — this
        // used to switch the ambient id to the job's connection and put it back afterwards, and any
        // command the user issued in between went to the job's database — and the backend registers
        // it as a job connection, so it never appears in the rail.
        const connRes = await dbHelper.connectJob(config);
        if (!connRes.success || !connRes.connId) {
          throw new Error(t('connection.errConnectFailed', { message: connRes.message }));
        }
        // Every command carries the id just minted — not the workspace's `connId` prop: with nothing
        // connected the prop is an empty string and `getTables` returns an empty array, i.e. it claims
        // "this database has no tables"; with a connection open it points at a DIFFERENT database.
        const jobConn = { connId: connRes.connId, schema: connRes.schema ?? null };
        return runOnJobConnection(jobConn, approvals, async ({ connId: jobConnId }) => {
          if (isBackup) {
            // The dump is built by the very code the "Export Database" dialog uses (buildDump): this
            // used to call the Rust `export_multi_tables`, which treated views as tables (emitting
            // DROP TABLE and INSERT INTO for a view), wrote one INSERT per row, and had no routines
            // or triggers at all.
            const list = await dbHelper.getTables(jobConnId);
            const tables = list.map(item => item.name);
            if (tables.length === 0) {
              throw new Error(t('connection.errNoTablesToBackup'));
            }
            const [dbObjs, triggers] = await Promise.all([
              dbHelper.getDatabaseObjects(jobConnId),
              dbHelper.getAllTriggers(jobConnId),
            ]);
            ctx.throwIfCancelled();

            const dumpSpec: DumpSpec = {
              dbType: config.type,
              tables,
              views: list.filter(item => item.type === 'view').map(item => item.name),
              routines: [
                ...dbObjs.functions.map((name) => ({ name, kind: 'function' as const })),
                ...dbObjs.procedures.map((name) => ({ name, kind: 'procedure' as const })),
              ],
              triggers: triggers.map((tr) => tr.name),
              events: dbObjs.events,
              sqlOptions,
              // The schema `connect` just reported as current — the same one getTables() above read
              // from. There is no schema picker on this screen, so this is always the first schema in
              // search_path.
              schema: connRes.schema,
              onProgress: (p) => {
                // Throwing here is what stops the dump between two pages.
                ctx.throwIfCancelled();
                ctx.report(p);
              },
            };
            const reader = dumpReaderFor(dbHelper, jobConnId);
            // Streamed into the file as it is built — see saveDumpToFolder.
            const saved = await saveDumpToFolder(
              getLastExportDir() || null,
              fileName,
              gzip,
              (emit) => writeDump(dumpSpec, reader, emit),
              () => buildDump(dumpSpec, reader),
            );
            return {
              message: `${t('connection.backupSuccess')} — ${saved.path || fileName}`,
              path: saved.path,
              dir: saved.dir,
              viaDownload: saved.savedTo === 'download',
            };
          }

          // Overwrite: prepend DROP ... IF EXISTS, and let those names through the backend's
          // per-table filter (it only runs statements mentioning a name from the list it was given).
          const objs = overwrite && dumpScan ? dumpScan.objects : null;
          const tablesToRun = objs
            ? [...new Set([...selectedTables, ...objs.views, ...objs.triggers, ...objs.procedures, ...objs.functions])]
            : selectedTables;

          const toProgress = makeRestoreReporter(t);
          ctx.report({ label: t('connection.restorePreparing') });
          const resData = await dbHelper.restoreBackup(
            { path: dumpPath, mysqlScript: dumpScan?.mysqlScript },
            tablesToRun,
            (msg) => ctx.report(toProgress(msg)),
            continueOnError,
            jobConnId,
            false,
            dropStatements,
          );
          if (resData.cancelled) return restoreCancelledResult(t, resData);
          if (!resData.success) {
            throw new Error(addExistsHint(resData.error || t('connection.errRestore'), overwrite));
          }

          // `resData.activeDatabase` (the database a `USE` inside the dump switched to) is NO LONGER
          // written back into the form fields: the job runs in the background, so by the time it
          // finishes the user may be typing config for another server into this very form — writing
          // there would erase what they just typed. The database name is already in the job's result
          // message.
          // With statements skipped, a plain "success" will not do — the database is not complete.
          return resData.failedCount
            ? { message: t('app.importDbPartial', { n: resData.statementsCount || 0, failed: resData.failedCount }) }
            : { message: t('connection.restoreSuccess', { n: resData.statementsCount || 0 }) };
        }, (id) => { restoreConnId = id; });
      },
    });

    setSuccessMsg(t('jobs.startedInBackground'));
  };

  const _pq = profileSearch.trim().toLowerCase();
  const filteredProfiles = profiles.filter((p) => {
    if (!_pq) return true;
    const cfg: any = p.config || {};
    return [p.name, p.group, p.type, cfg.host, cfg.database, cfg.sqlitePath]
      .some((f) => (f || '').toString().toLowerCase().includes(_pq));
  });
  const groupedProfiles = filteredProfiles.reduce((acc, p) => {
    const groupName = p.group?.trim() || t('connection.defaultGroup');
    if (!acc[groupName]) acc[groupName] = [];
    acc[groupName].push(p);
    return acc;
  }, {} as Record<string, SavedProfile[]>);
  const groupNames = Object.keys(groupedProfiles);
  // The groups that already exist — for the "Group" combobox (pick an existing one or type a new one).
  const existingGroups = Array.from(
    new Set(profiles.map(p => (p.group || '').trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const isBrMode = (activeType as any) === 'backup_restore';
  const isServerDb = activeType === 'postgres' || activeType === 'mysql';
  const isRedis = activeType === 'redis';
  // Which engines get the SSL and SSH Tunnel tabs. SQLite is a local file, so there is nothing to encrypt or forward.
  const hasNetTabs = isServerDb || isRedis;
  const tlsOn = sslMode !== 'DISABLED';
  // sslMode and sslEnabled always travel together: the backend reads sslEnabled=true as "TLS on" even
  // when the mode is DISABLED (so that old switch-only profiles still work), which means letting the
  // two drift apart turns encryption on against the form's intent.
  const applySslMode = (mode: string) => {
    setSslMode(mode);
    setSslEnabled(mode !== 'DISABLED');
  };
  const activeMeta = TYPE_META[activeType] || TYPE_META.sqlite;
  const hasProfile = !!activeProfileId && !isBrMode;

  // A summarised connection string (no password) — shown in the header for a quick check.
  const connectionUri = (() => {
    if (activeType === 'sqlite') return `sqlite://${sqlitePath}`;
    if (activeType === 'redis') return `${tlsOn ? 'rediss' : 'redis'}://${redisUser ? redisUser + '@' : ''}${redisHost}:${redisPort}/${redisDbIndex}`;
    if (activeType === 'postgres') return `postgres://${pgUser}@${pgHost}:${pgPort}/${pgDatabase}`;
    return `mysql://${myUser}@${myHost}:${myPort}/${myDatabase || ''}`;
  })();

  const handleCopyUri = async () => {
    try {
      await navigator.clipboard.writeText(connectionUri);
      setUriCopied(true);
      setTimeout(() => setUriCopied(false), 1600);
    } catch { /* the clipboard is blocked - ignored */ }
  };

  const toggleGroup = (name: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [name]: !prev[name] }));

  const NEW_TYPES: { val: 'sqlite' | 'postgres' | 'mysql' | 'redis'; label: string }[] = [
    { val: 'sqlite', label: 'SQLite' },
    { val: 'postgres', label: 'PostgreSQL' },
    { val: 'mysql', label: 'MySQL' },
    { val: 'redis', label: 'Redis' },
  ];

  // ——— The "Database" field: free text plus a reload button and a dropdown of the list ———
  // The buttons sit inside the field rather than leaving a "Load list" button on its own row above.
  const renderDatabaseField = (
    value: string,
    setValue: (v: string) => void,
    fetchTarget: 'postgres' | 'mysql' | 'br_postgres' | 'br_mysql',
    placeholder: string,
  ) => {
    const q = value.trim().toLowerCase();
    // While typing it filters by what has been typed; once the text matches a database exactly it
    // shows the whole list again, so another one can still be chosen.
    const exact = availableDatabases.some(d => d.toLowerCase() === q);
    const opts = (!q || exact) ? availableDatabases : availableDatabases.filter(d => d.toLowerCase().includes(q));
    return (
      <div className="form-group">
        <label>{t('connection.databaseLabel')}</label>
        <div className="input-icon-wrapper cm-combo two-btn">
          <input
            type="text"
            className="form-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setShowDbList(false); }}
            placeholder={placeholder}
          />
          <Database size={14} className="input-icon" />
          <button
            type="button"
            className="cm-combo-btn second"
            title={t('connection.reloadDbList')}
            onClick={() => fetchDatabases(fetchTarget)}
            disabled={loadingDbs}
          >
            {loadingDbs ? <LoadingSpinner size={12} /> : <RefreshCw size={13} />}
          </button>
          <button
            type="button"
            className={`cm-combo-btn ${showDbList ? 'on' : ''}`}
            title={t('connection.pickFromList')}
            onClick={() => {
              setShowDbList((v) => !v);
              if (!availableDatabases.length && !loadingDbs) fetchDatabases(fetchTarget);
            }}
          >
            <ChevronDown size={13} />
          </button>
          {showDbList && (
            <>
              <div className="cm-pop-backdrop" onClick={() => setShowDbList(false)} />
              <div className="cm-combo-pop">
                {opts.length === 0 ? (
                  <div className="cm-combo-empty">
                    {loadingDbs
                      ? t('connection.dbListLoading')
                      : availableDatabases.length ? t('connection.dbListNoMatch') : t('connection.dbListNotLoaded')}
                  </div>
                ) : opts.map(d => (
                  <button
                    key={d}
                    type="button"
                    className={`cm-combo-opt ${d === value.trim() ? 'on' : ''}`}
                    onClick={() => { setValue(d); setShowDbList(false); }}
                  >
                    <span className="cm-ellipsis">{d}</span>
                    {d === value.trim() && <Check size={12} style={{ flexShrink: 0 }} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  // ——— The "Basics" block: name, group, identifying colour ———
  const renderBasicSection = () => (
    <div className="cm-section">
      <div className="cm-section-title">{t('connection.basicSection')}</div>
      <div className="cm-fields">
        <div className="cm-grid basic">
          <div className="form-group">
            <label>{t('connection.profileName')}</label>
            <input
              type="text"
              className="form-input"
              value={profileNameInput}
              onChange={(e) => setProfileNameInput(e.target.value)}
              placeholder={t('connection.profileNamePlaceholder')}
            />
          </div>
          <div className="form-group">
            <label>{t('connection.group')}</label>
            {/* A hand-built combobox instead of <datalist>: the native one adds an arrow of its own
                and its popup cannot follow the app's theme. */}
            <div className="cm-combo">
              <input
                type="text"
                className="form-input"
                value={profileGroup}
                onChange={(e) => setProfileGroup(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setShowGroupList(false); }}
                placeholder={existingGroups.length ? t('connection.groupPlaceholderPick') : t('connection.groupPlaceholderNew')}
              />
              {existingGroups.length > 0 && (
                <button
                  type="button"
                  className={`cm-combo-btn ${showGroupList ? 'on' : ''}`}
                  title={t('connection.pickExistingGroup')}
                  onClick={() => setShowGroupList((v) => !v)}
                >
                  <ChevronDown size={13} />
                </button>
              )}
              {showGroupList && (
                <>
                  <div className="cm-pop-backdrop" onClick={() => setShowGroupList(false)} />
                  <div className="cm-combo-pop">
                    {existingGroups.map(g => (
                      <button
                        key={g}
                        type="button"
                        className={`cm-combo-opt ${g === profileGroup.trim() ? 'on' : ''}`}
                        onClick={() => { setProfileGroup(g); setShowGroupList(false); }}
                      >
                        <span className="cm-ellipsis">{g}</span>
                        {g === profileGroup.trim() && <Check size={12} style={{ flexShrink: 0 }} />}
                      </button>
                    ))}
                    {profileGroup.trim() && (
                      <>
                        <div className="cm-pop-sep" />
                        <button type="button" className="cm-combo-opt" onClick={() => { setProfileGroup(''); setShowGroupList(false); }}>
                          <X size={12} style={{ flexShrink: 0 }} />
                          <span>{t('connection.clearGroup')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          {/* environment */}
          <div className="form-group">
            <label>{t('connEnv.label')}</label>
            <select
              className="form-input"
              value={profileEnv}
              onChange={(e) => setProfileEnv(normalizeEnv(e.target.value))}
            >
              {CONN_ENVS.map((env) => (
                <option key={env} value={env}>{t(envLabelKey(env))}</option>
              ))}
            </select>
          </div>
        </div>
        {profileEnv === 'production' && <small className="cm-hint">{t('connEnv.hint')}</small>}
      </div>
    </div>
  );

  // ——— The warning for a remote connection with encryption off ———
  const renderSslWarning = () => {
    if (activeType === 'redis') {
      if (tlsOn || !isRemoteHost(redisHost)) return null;
      return (
        <div className="cm-warn">
          <ShieldAlert size={15} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            <Trans i18nKey="connection.warnRedisTls" components={{ strong: <b /> }} />
          </span>
          <button type="button" className="cm-warn-btn" onClick={() => applySslMode('VERIFY_IDENTITY')}>{t('connection.enableTls')}</button>
        </div>
      );
    }
    if (!isServerDb) return null;
    const host = activeType === 'postgres' ? pgHost : myHost;
    if (sslMode !== 'DISABLED' || !isRemoteHost(host)) return null;
    return (
      <div className="cm-warn">
        <ShieldAlert size={15} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          <Trans i18nKey="connection.warnSslDisabled" components={{ strong: <b /> }} />
        </span>
        <button type="button" className="cm-warn-btn" onClick={() => { setSslMode('REQUIRED'); setFormTab('ssl'); }}>{t('connection.enableSsl')}</button>
      </div>
    );
  };

  const handlePickSqlitePath = async () => {
    const file = await pickSqliteDatabaseFile(sqlitePath);
    if (file) {
      setSqlitePath(file);
      const filename = file.split(/[\\/]/).pop();
      if (filename && (!profileNameInput || profileNameInput.toLowerCase().includes('sqlite') || profileNameInput.trim() === '')) {
        setProfileNameInput(filename.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  // ——— The "General" tab, per DB engine ———
  const renderGeneralTab = () => (
    <>
      {renderBasicSection()}

      {activeType === 'sqlite' && (
        <div className="cm-section">
          <div className="cm-section-title">{t('connection.sqliteSection')}</div>
          <div className="cm-section-desc">{t('connection.sqliteDesc')}</div>
          <div className="cm-fields">
            <div className="form-group">
              <label>{t('connection.sqlitePathLabel')}</label>
              <div className="cm-file-row">
                <div className="input-icon-wrapper">
                  <input
                    type="text"
                    className="form-input"
                    value={sqlitePath}
                    onChange={(e) => setSqlitePath(e.target.value)}
                    placeholder={t('connection.sqlitePathPlaceholder')}
                  />
                  <FolderOpen size={14} className="input-icon" />
                </div>
                <button
                  type="button"
                  className="cm-file-btn"
                  onClick={handlePickSqlitePath}
                  title={t('connection.pickFile')}
                >
                  <FolderOpen size={12} />
                  <span>{t('connection.pickFile')}</span>
                </button>
              </div>
              <span className="cm-hint">{t('connection.sqliteHint')}</span>
            </div>
          </div>
        </div>
      )}

      {activeType === 'redis' && (
        <div className="cm-section">
          <div className="cm-section-title">{t('connection.redisSection')}</div>
          <div className="cm-section-desc">{t('connection.redisDesc')}</div>
          <div className="cm-fields">
            <div className="cm-grid host">
              <div className="form-group">
                <label>{t('connection.host')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={redisHost} onChange={(e) => setRedisHost(e.target.value)} placeholder="127.0.0.1" />
                  <Server size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>{t('connection.port')}</label>
                <div className="input-icon-wrapper">
                  <input type="number" className="form-input" value={redisPort} onChange={(e) => setRedisPort(parseInt(e.target.value) || 6379)} />
                  <Hash size={14} className="input-icon" />
                </div>
              </div>
            </div>
            <div className="cm-grid two">
              <div className="form-group">
                <label>{t('connection.redisUserLabel')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={redisUser} onChange={(e) => setRedisUser(e.target.value)} placeholder="default" />
                  <User size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>{t('connection.password')}</label>
                <div className="input-icon-wrapper">
                  <input
                    type={showPw ? 'text' : 'password'}
                    className="form-input"
                    value={redisPassword}
                    onChange={(e) => setRedisPassword(e.target.value)}
                    placeholder="••••••••"
                    style={{ paddingRight: '32px' }}
                  />
                  <Key size={14} className="input-icon" />
                  <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                </div>
              </div>
            </div>
            <div className="cm-grid two">
              <div className="form-group">
                <label>{t('connection.redisDbIndex')}</label>
                <input
                  type="number"
                  min={0}
                  max={15}
                  className="form-input"
                  value={redisDbIndex}
                  onChange={(e) => setRedisDbIndex(Math.max(0, Math.min(15, parseInt(e.target.value) || 0)))}
                />
              </div>
            </div>
            {/* A one-tap switch for the common case; the verification level, the CA and mTLS live in
                the SSL tab. Switching it on here means VERIFY_IDENTITY, exactly what the switch did
                before the SSL tab existed. */}
            <div className="cm-switch-row">
              <button type="button" className={`cm-switch ${tlsOn ? 'on' : ''}`} onClick={() => applySslMode(tlsOn ? 'DISABLED' : 'VERIFY_IDENTITY')} aria-label={t('connection.enableTls')} />
              <div style={{ flex: 1 }}>
                <div className="cm-switch-label">{t('connection.tlsSwitchLabel')}</div>
                <div className="cm-hint">{t('connection.tlsSwitchHint')}</div>
                {tlsOn && (
                  <div className="cm-hint">
                    <Trans
                      i18nKey="connection.tlsSwitchModeHint"
                      values={{ mode: sslMode }}
                      components={{ strong: <b /> }}
                    />
                  </div>
                )}
              </div>
            </div>
            {renderSslWarning()}
          </div>
        </div>
      )}

      {isServerDb && (() => {
        const host = activeType === 'postgres' ? pgHost : myHost;
        const setHost = activeType === 'postgres' ? setPgHost : setMyHost;
        const port = activeType === 'postgres' ? pgPort : myPort;
        const setPort = activeType === 'postgres' ? setPgPort : setMyPort;
        const defPort = activeType === 'postgres' ? 5432 : 3306;
        const user = activeType === 'postgres' ? pgUser : myUser;
        const setUser = activeType === 'postgres' ? setPgUser : setMyUser;
        const password = activeType === 'postgres' ? pgPassword : myPassword;
        const setPassword = activeType === 'postgres' ? setPgPassword : setMyPassword;
        const database = activeType === 'postgres' ? pgDatabase : myDatabase;
        const setDatabase = activeType === 'postgres' ? setPgDatabase : setMyDatabase;

        return (
          <>
            <div className="cm-section">
              <div className="cm-section-title">{t('connection.serverSection')}</div>
              <div className="cm-section-desc">{t('connection.serverDesc', { db: activeMeta.label })}</div>
              <div className="cm-fields">
                <div className="cm-grid host">
                  <div className="form-group">
                    <label>{t('connection.host')}</label>
                    <div className="input-icon-wrapper">
                      <input
                        type="text"
                        className="form-input"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="localhost"
                      />
                      <Server size={14} className="input-icon" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>{t('connection.port')}</label>
                    <div className="input-icon-wrapper">
                      <input
                        type="number"
                        className="form-input"
                        value={port}
                        onChange={(e) => setPort(parseInt(e.target.value) || defPort)}
                      />
                      <Hash size={14} className="input-icon" />
                    </div>
                  </div>
                </div>
                {renderDatabaseField(
                  database,
                  setDatabase,
                  activeType === 'postgres' ? 'postgres' : 'mysql',
                  activeType === 'postgres' ? 'postgres' : t('connection.databaseOptional'),
                )}
                {renderSslWarning()}
              </div>
            </div>

            <div className="cm-section">
              <div className="cm-label-row">
                <div>
                  <div className="cm-section-title">{t('connection.authSection')}</div>
                  <div className="cm-section-desc">{t('connection.authDesc')}</div>
                </div>
                <div className="cm-seg">
                  <button type="button" className={authMethod === 'password' ? 'on' : ''} onClick={() => setAuthMethod('password')}>{t('connection.authPassword')}</button>
                  <button type="button" className={authMethod === 'aws_iam' ? 'on' : ''} onClick={() => setAuthMethod('aws_iam')}>{t('connection.authAwsIam')}</button>
                </div>
              </div>
              <div className="cm-fields">
                <div className="cm-grid two">
                  <div className="form-group">
                    <label>{authMethod === 'aws_iam' ? t('connection.usernameIam') : t('connection.username')}</label>
                    <div className="input-icon-wrapper">
                      <input
                        type="text"
                        className="form-input"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        placeholder={activeType === 'postgres' ? 'postgres' : 'root'}
                      />
                      <User size={14} className="input-icon" />
                    </div>
                  </div>
                  {authMethod === 'password' && (
                    <div className="form-group">
                      <label>{t('connection.password')}</label>
                      <div className="input-icon-wrapper">
                        <input
                          type={showPw ? 'text' : 'password'}
                          className="form-input"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          style={{ paddingRight: '32px' }}
                        />
                        <Key size={14} className="input-icon" />
                        <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                      </div>
                    </div>
                  )}
                </div>

                {authMethod === 'aws_iam' && (
                  <div className="cm-subcard">
                    <div className="cm-subcard-head">
                      <Cloud size={13} />
                      <span>{t('connection.awsHeading')}</span>
                    </div>
                    <div className="cm-hint" style={{ marginBottom: '12px' }}>
                      <Trans i18nKey="connection.awsHint" components={{ strong: <b /> }} />
                    </div>
                    <div className="cm-seg" style={{ marginBottom: '12px' }}>
                      <button type="button" className={awsAuthType === 'access_key' ? 'on' : ''} onClick={() => setAwsAuthType('access_key')}>{t('connection.awsAccessKeySeg')}</button>
                      <button type="button" className={awsAuthType === 'profile' ? 'on' : ''} onClick={() => setAwsAuthType('profile')}>{t('connection.awsProfileSeg')}</button>
                    </div>
                    <div className="cm-fields" style={{ marginTop: 0 }}>
                      {awsAuthType === 'access_key' ? (
                        <>
                          <div className="form-group">
                            <label>{t('connection.awsAccessKeyId')}</label>
                            <input type="text" className="form-input" value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." autoComplete="off" />
                          </div>
                          <div className="cm-grid two">
                            <div className="form-group">
                              <label>{t('connection.awsSecretKey')}</label>
                              <div className="input-icon-wrapper">
                                <input type={showPw ? 'text' : 'password'} className="form-input" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} autoComplete="off" style={{ paddingRight: '32px', paddingLeft: '10px' }} />
                                <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                              </div>
                            </div>
                            <div className="form-group">
                              <label>{t('connection.awsSessionToken')}</label>
                              <div className="input-icon-wrapper">
                                <input type={showPw ? 'text' : 'password'} className="form-input" value={awsSessionToken} onChange={(e) => setAwsSessionToken(e.target.value)} autoComplete="off" style={{ paddingRight: '32px', paddingLeft: '10px' }} />
                                <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="form-group">
                          <label>{t('connection.awsProfileName')}</label>
                          <input type="text" className="form-input" value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} placeholder="default" autoComplete="off" />
                        </div>
                      )}
                      <div className="form-group">
                        <label>{t('connection.awsRegion')}</label>
                        <input type="text" className="form-input" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder={t('connection.awsRegionPlaceholder')} autoComplete="off" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        );
      })()}
    </>
  );

  // ——— Tab "SSL" (Postgres / MySQL / Redis) ———
  const renderSslTab = () => {
    const prefix = isRedis ? 'redis' : activeType === 'postgres' ? 'pg' : 'my';
    const sslOn = tlsOn;
    // Only the two VERIFY_* modes really check the server certificate -> a CA cert is then required
    // (unless the CA is in the system store). Under REQUIRED these three fields serve mTLS only.
    const needVerify = sslMode === 'VERIFY_CA' || sslMode === 'VERIFY_IDENTITY';
    return (
      <div className="cm-section">
        <div className="cm-section-title">{t('connection.sslSection')}</div>
        <div className="cm-section-desc">
          <Trans i18nKey="connection.sslDesc" components={{ strong: <b /> }} />
        </div>
        <div className="cm-fields">
          <div className="form-group">
            <label>{t('connection.sslModeLabel')}</label>
            <select className="form-input" value={sslMode} onChange={(e) => (isRedis ? applySslMode(e.target.value) : setSslMode(e.target.value))} style={{ maxWidth: '240px' }}>
              {(isRedis ? REDIS_SSL_MODES : SSL_MODES).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="cm-hint">{sslModeDesc(sslMode)}</span>
          </div>

          {/* A tunnel makes the client connect to 127.0.0.1, so the server's certificate is checked
              against that address and VERIFY_IDENTITY is bound to fail. VERIFY_CA still verifies the
              certificate chain and only skips the hostname. */}
          {isRedis && sshEnabled && sslMode === 'VERIFY_IDENTITY' && (
            <div className="cm-warn">
              <ShieldAlert size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>
                <Trans i18nKey="connection.warnRedisTlsOverSsh" components={{ strong: <b /> }} />
              </span>
              <button type="button" className="cm-warn-btn" onClick={() => applySslMode('VERIFY_CA')}>{t('connection.useVerifyCa')}</button>
            </div>
          )}

          {renderSslWarning()}

          {sslOn && (
            <div className="cm-subcard">
              <div className="cm-label-row" style={{ marginBottom: '12px' }}>
                <div className="cm-subcard-head" style={{ margin: 0 }}>
                  <ShieldCheck size={13} />
                  <span>{needVerify ? t('connection.certs') : t('connection.certsOptional')}</span>
                </div>
                <button
                  type="button"
                  className="cm-mini-btn"
                  onClick={() => { setSslKeyPath(''); setSslCertPath(''); setSslCaPath(''); }}
                  disabled={!sslKeyPath && !sslCertPath && !sslCaPath}
                >
                  <X size={10} /> <span>{t('connection.clearAll')}</span>
                </button>
              </div>
              <div className="cm-grid three">
                <div className="form-group">
                  <label>{t('connection.clientKey')}</label>
                  <FilePick id={`${prefix}-ssl-key-picker`} value={sslKeyPath} label={t('connection.pickKey')} onPick={setSslKeyPath} />
                </div>
                <div className="form-group">
                  <label>{t('connection.clientCert')}</label>
                  <FilePick id={`${prefix}-ssl-cert-picker`} value={sslCertPath} label={t('connection.pickCert')} onPick={setSslCertPath} />
                </div>
                <div className="form-group">
                  <label>{t('connection.caCert')}{needVerify ? ' *' : ''}</label>
                  <FilePick id={`${prefix}-ssl-ca-picker`} value={sslCaPath} label={t('connection.pickCa')} onPick={setSslCaPath} />
                </div>
              </div>
              <div className="cm-hint" style={{ marginTop: '10px' }}>
                <Trans i18nKey="connection.certHintBase" components={{ strong: <b /> }} />{' '}
                {needVerify ? (
                  <Trans i18nKey="connection.certHintVerify" components={{ strong: <b /> }} />
                ) : isRedis ? (
                  <Trans i18nKey="connection.certHintRedis" components={{ strong: <b /> }} />
                ) : activeType === 'postgres' ? (
                  <Trans i18nKey="connection.certHintPostgres" components={{ strong: <b /> }} />
                ) : (
                  <Trans i18nKey="connection.certHintMysql" components={{ strong: <b /> }} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ——— Tab "SSH Tunnel" ———
  const renderSshTab = () => (
    <div className="cm-section">
      <div className="cm-section-title">{t('connection.sshSection')}</div>
      <div className="cm-section-desc">{t('connection.sshDesc')}</div>
      <div className="cm-fields">
        <div className="cm-switch-row">
          <button type="button" className={`cm-switch ${sshEnabled ? 'on' : ''}`} onClick={() => setSshEnabled(!sshEnabled)} aria-label={t('connection.sshEnableAria')} />
          <div style={{ flex: 1 }}>
            <div className="cm-switch-label">{t('connection.sshSwitchLabel')}</div>
            <div className="cm-hint">{t('connection.sshSwitchHint')}</div>
          </div>
        </div>

        {sshEnabled && (
          <>
            <div className="cm-grid host">
              <div className="form-group">
                <label>{t('connection.sshHost')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="bastion.example.com" />
                  <Network size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>{t('connection.sshPort')}</label>
                <div className="input-icon-wrapper">
                  <input type="number" className="form-input" value={sshPort} onChange={(e) => setSshPort(parseInt(e.target.value) || 22)} />
                  <Hash size={14} className="input-icon" />
                </div>
              </div>
            </div>
            {/* The auth method is picked with a segmented control on the heading row (like the
                "Authentication" block on the General tab), so user + password/passphrase always share
                one two-column row and no field is left stranded on half a row. */}
            <div className="cm-label-row">
              <span className="cm-subhead">{t('connection.sshAuthHeading')}</span>
              <div className="cm-seg">
                <button type="button" className={sshAuthType === 'password' ? 'on' : ''} onClick={() => setSshAuthType('password')}>{t('connection.authPassword')}</button>
                <button type="button" className={sshAuthType === 'key' ? 'on' : ''} onClick={() => setSshAuthType('key')}>{t('connection.sshAuthKey')}</button>
              </div>
            </div>

            <div className="cm-grid two">
              <div className="form-group">
                <label>{t('connection.sshUser')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="ubuntu" />
                  <User size={14} className="input-icon" />
                </div>
              </div>
              {sshAuthType === 'password' ? (
                <div className="form-group">
                  <label>{t('connection.sshPassword')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type={showPw ? 'text' : 'password'}
                      className="form-input"
                      value={sshPassword}
                      onChange={(e) => setSshPassword(e.target.value)}
                      placeholder="••••••••"
                      style={{ paddingRight: '32px' }}
                    />
                    <Key size={14} className="input-icon" />
                    <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                  </div>
                </div>
              ) : (
                <div className="form-group">
                  <label>{t('connection.sshPassphrase')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type={showPw ? 'text' : 'password'}
                      className="form-input"
                      value={sshPassphrase}
                      onChange={(e) => setSshPassphrase(e.target.value)}
                      placeholder="••••••••"
                      style={{ paddingRight: '32px' }}
                    />
                    <Key size={14} className="input-icon" />
                    <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                  </div>
                </div>
              )}
            </div>

            {sshAuthType === 'key' && (
              <div className="cm-subcard">
                <div className="cm-subcard-head">
                  <Key size={13} />
                  <span>{t('connection.sshAuthKey')}</span>
                </div>
                <div className="cm-fields" style={{ marginTop: 0 }}>
                  <div className="form-group">
                    <label>{t('connection.sshKeyPath')}</label>
                    <div className="cm-file-row">
                      <input
                        type="text"
                        className="form-input"
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder="C:\Users\me\.ssh\id_rsa"
                      />
                      <FilePick id="ssh-key-file-picker" value="" label={t('connection.pickFile')} onPick={setSshKeyPath} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>{t('connection.sshKeyContent')}</label>
                    <textarea
                      className="form-input cm-key-area"
                      value={sshKeyContent}
                      onChange={(e) => setSshKeyContent(e.target.value)}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );


  // Does not depend on `brOverwrite`: toggling the overwrite checkbox is no reason to rescan the file.
  const brDropStatements = React.useMemo(
    () => (brScan ? buildDropStatements(brScan.objects, brType) : []),
    [brScan, brType]
  );

  // How many statements a restore will run (the same per-table filter the backend uses), for the time estimate.
  const brPlannedStatements = React.useMemo(
    () => (brScan
      ? plannedFromScan(brScan.plan, brParsedTables, brSelectedTables, brOverwrite ? brDropStatements.length : 0)
      : 0),
    [brScan, brDropStatements, brOverwrite, brParsedTables, brSelectedTables]
  );

  const brTargetDb = brType === 'postgres' ? brPgDatabase : brType === 'mysql' ? brMyDatabase : brSqlitePath;

  // ——— Backup & Restore mode (no existing connection required) ———
  const renderBackupRestore = () => (
    <>
      {/* The pre-restore summary: which database, how many tables/statements, and how long it may take */}
      <ConfirmDialog
        open={brConfirm}
        tone={brOverwrite ? 'danger' : 'info'}
        title={t('connection.brConfirmTitle')}
        message={
          <>
            <div>
              {brType === 'sqlite' ? (
                <Trans
                  i18nKey="connection.brRestoreInto"
                  values={{ db: brTargetDb || t('connection.brTargetDefault') }}
                  components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
                />
              ) : (
                <Trans
                  i18nKey="connection.brRestoreIntoHost"
                  values={{
                    db: brTargetDb || t('connection.brTargetDefault'),
                    host: brType === 'mysql' ? brMyHost : brPgHost,
                  }}
                  components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
                />
              )}
              {!brTargetDb && brType !== 'sqlite' && (
                <>{' '}<Trans i18nKey="connection.brUseHint" components={{ code: <code style={{ fontFamily: 'monospace' }} /> }} /></>
              )}
            </div>
            <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowTables')}</span>
              <b>{brParsedTables.length === 0
                ? t('connection.brAllFile')
                : t('connection.brTablesCount', { selected: brSelectedTables.length, total: brParsedTables.length })}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowStatements')}</span>
              <b>{brPlannedStatements.toLocaleString()}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowFile')}</span>
              <b>{brDumpPath && brScan ? `${fileBaseName(brDumpPath)} (${(brScan.fileBytes / 1024 / 1024).toFixed(2)} MB)` : ''}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowEta')}</span>
              <b>~{formatRestoreEta(t, brPlannedStatements / 800)}</b>
            </div>
          </>
        }
        note={brOverwrite ? t('connection.brNoteOverwrite') : t('connection.brNoteEstimate')}
        confirmLabel={t('connection.brStartRestore')}
        cancelLabel={t('connection.back')}
        onConfirm={() => handleBrSubmit()}
        onCancel={() => setBrConfirm(false)}
      />

      <div className="cm-section">
        <div className="cm-label-row">
          <div>
            <div className="cm-section-title">{brAction === 'backup' ? t('connection.brBackupTitle') : t('connection.brRestoreTitle')}</div>
            <div className="cm-section-desc">
              {brAction === 'backup' ? t('connection.brBackupDesc') : t('connection.brRestoreDesc')}
            </div>
          </div>
          <div className="cm-seg">
            <button type="button" className={brAction === 'backup' ? 'on' : ''} onClick={() => setBrAction('backup')}>{t('connection.brSegBackup')}</button>
            <button type="button" className={brAction === 'restore' ? 'on' : ''} onClick={() => setBrAction('restore')}>{t('connection.brSegRestore')}</button>
          </div>
        </div>

        <div className="cm-fields">
          <div className="cm-grid two">
            <div className="form-group">
              <label>{t('connection.brFromProfile')}</label>
              <select
                className="form-input"
                value={selectedBrProfileId || ''}
                onChange={async (e) => {
                  const profId = e.target.value;
                  setSelectedBrProfileId(profId);
                  const selectedProf = profiles.find(p => p.id === profId);
                  if (selectedProf) {
                    setBrType(selectedProf.type === 'redis' ? 'sqlite' : selectedProf.type);
                    // The password lives in the OS store -> it has to be read back before the backup form can be filled.
                    const c = await configWithSecrets(selectedProf);
                    if (selectedProf.type === 'sqlite') {
                      setBrSqlitePath(c.sqlitePath || '');
                    } else if (selectedProf.type === 'postgres') {
                      setBrPgHost(c.host || 'localhost');
                      setBrPgPort(c.port || 5432);
                      setBrPgUser(c.user || 'postgres');
                      setBrPgPassword(c.password || '');
                      setBrPgDatabase(c.database || 'postgres');
                    } else if (selectedProf.type === 'mysql') {
                      setBrMyHost(c.host || 'localhost');
                      setBrMyPort(c.port || 3306);
                      setBrMyUser(c.user || 'root');
                      setBrMyPassword(c.password || '');
                      setBrMyDatabase(c.database || '');
                    }
                  }
                }}
              >
                <option value="">{t('connection.brManual')}</option>
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type.toUpperCase()})</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>{t('connection.brDbType')}</label>
              <select className="form-input" value={brType} onChange={(e) => setBrType(e.target.value as any)}>
                <option value="sqlite">SQLite</option>
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </div>
          </div>

          {brType === 'sqlite' ? (
            <div className="form-group">
              <label>{t('connection.brSqlitePath')}</label>
              <div className="cm-file-row">
                <div className="input-icon-wrapper">
                  <input
                    type="text"
                    className="form-input"
                    value={brSqlitePath}
                    onChange={(e) => setBrSqlitePath(e.target.value)}
                    placeholder={t('connection.sqlitePathPlaceholder')}
                  />
                  <FolderOpen size={14} className="input-icon" />
                </div>
                <button
                  type="button"
                  className="cm-file-btn"
                  onClick={async () => {
                    const picked = await pickSqliteDatabaseFile(brSqlitePath);
                    if (picked) setBrSqlitePath(picked);
                  }}
                  title={t('connection.pickFile')}
                >
                  <FolderOpen size={12} />
                  <span>{t('connection.pickFile')}</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="cm-grid host">
                <div className="form-group">
                  <label>{t('connection.host')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type="text"
                      className="form-input"
                      value={brType === 'postgres' ? brPgHost : brMyHost}
                      onChange={(e) => brType === 'postgres' ? setBrPgHost(e.target.value) : setBrMyHost(e.target.value)}
                    />
                    <Server size={14} className="input-icon" />
                  </div>
                </div>
                <div className="form-group">
                  <label>{t('connection.port')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type="number"
                      className="form-input"
                      value={brType === 'postgres' ? brPgPort : brMyPort}
                      onChange={(e) => brType === 'postgres' ? setBrPgPort(parseInt(e.target.value) || 5432) : setBrMyPort(parseInt(e.target.value) || 3306)}
                    />
                    <Hash size={14} className="input-icon" />
                  </div>
                </div>
              </div>
              <div className="cm-grid two">
                <div className="form-group">
                  <label>{t('connection.username')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type="text"
                      className="form-input"
                      value={brType === 'postgres' ? brPgUser : brMyUser}
                      onChange={(e) => brType === 'postgres' ? setBrPgUser(e.target.value) : setBrMyUser(e.target.value)}
                    />
                    <User size={14} className="input-icon" />
                  </div>
                </div>
                <div className="form-group">
                  <label>{t('connection.password')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type={showPw ? 'text' : 'password'}
                      className="form-input"
                      value={brType === 'postgres' ? brPgPassword : brMyPassword}
                      onChange={(e) => brType === 'postgres' ? setBrPgPassword(e.target.value) : setBrMyPassword(e.target.value)}
                      style={{ paddingRight: '32px' }}
                    />
                    <Key size={14} className="input-icon" />
                    <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                  </div>
                </div>
              </div>
              {renderDatabaseField(
                brType === 'postgres' ? brPgDatabase : brMyDatabase,
                brType === 'postgres' ? setBrPgDatabase : setBrMyDatabase,
                brType === 'postgres' ? 'br_postgres' : 'br_mysql',
                brType === 'postgres' ? 'postgres' : t('connection.databaseOptional'),
              )}
            </>
          )}
        </div>
      </div>

      <div className="cm-section">
        {brAction === 'backup' ? (
          <>
            <div className="cm-section-title">{t('connection.brExportOptions')}</div>
            <div className="cm-fields">
              <div className="form-group" style={{ maxWidth: '340px' }}>
                <label>{t('connection.brFilename')}</label>
                <input
                  type="text"
                  className="form-input"
                  value={brEffectiveFilename}
                  onChange={(e) => { setBrFilenameTouched(true); setBrFilename(e.target.value); }}
                />
                <div className="cm-hint">{brEffectiveFilename}{brCompressGzip ? '.sql.gz' : '.sql'}</div>
              </div>
              <div className="cm-check-grid">
                <label className="cm-check"><input type="checkbox" checked={brDropTable} onChange={(e) => setBrDropTable(e.target.checked)} /><span>DROP TABLE IF EXISTS</span></label>
                <label className="cm-check"><input type="checkbox" checked={brIncludeStructure} onChange={(e) => setBrIncludeStructure(e.target.checked)} /><span>{t('connection.brIncludeStructure')}</span></label>
                <label className="cm-check"><input type="checkbox" checked={brIncludeContent} onChange={(e) => setBrIncludeContent(e.target.checked)} /><span>{t('connection.brIncludeContent')}</span></label>
                <label className="cm-check"><input type="checkbox" checked={brCompressGzip} onChange={(e) => setBrCompressGzip(e.target.checked)} /><span>{t('connection.brGzip')}</span></label>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="cm-section-title">{t('connection.brFileSection')}</div>
            <div className="cm-fields">
              <button type="button" className="cm-dropzone" onClick={pickBrDump}>
                <Upload size={18} />
                <div>
                  <div className="cm-dropzone-title">{brDumpPath ? fileBaseName(brDumpPath) : t('connection.brPickFile')}</div>
                  <div className="cm-hint">{brScan ? t('connection.brFileSize', { size: (brScan.fileBytes / 1024 / 1024).toFixed(2) }) : t('connection.brPickHint')}</div>
                </div>
              </button>

              {brParsing && (
                <div className="cm-hint" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <LoadingSpinner size={11} /> {t('connection.brParsingTables')}
                  {brScanPct !== null && brScanPct > 0 && <span>{brScanPct}%</span>}
                </div>
              )}

              {brParsedTables.length > 0 && (
                <div className="cm-subcard">
                  <div className="cm-label-row" style={{ marginBottom: '10px' }}>
                    <div className="cm-subcard-head" style={{ margin: 0 }}>
                      <Database size={13} />
                      <span>{t('connection.brTablesToRestore', { selected: brSelectedTables.length, total: brParsedTables.length })}</span>
                    </div>
                    <button
                      type="button"
                      className="cm-mini-btn"
                      onClick={() => setBrSelectedTables(brSelectedTables.length === brParsedTables.length ? [] : [...brParsedTables])}
                    >
                      {brSelectedTables.length === brParsedTables.length ? t('connection.brDeselectAll') : t('connection.brSelectAll')}
                    </button>
                  </div>
                  <div className="cm-table-picker">
                    {brParsedTables.map(tableName => {
                      const isChecked = brSelectedTables.includes(tableName);
                      return (
                        <label key={tableName} className="cm-check">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => setBrSelectedTables(isChecked ? brSelectedTables.filter(x => x !== tableName) : [...brSelectedTables, tableName])}
                          />
                          <span>{tableName}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Replaying a dump onto a database that already has same-named tables makes MySQL
                  report 1050 "Table already exists" and abandon the whole restore. This option drops
                  them first. */}
              {brScan && (
                <label className="cm-check" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={brOverwrite}
                    onChange={(e) => setBrOverwrite(e.target.checked)}
                  />
                  <span>
                    {t('connection.brOverwriteLabel')}
                    <span className="cm-hint" style={{ display: 'block' }}>
                      {t('connection.brOverwriteHint')}
                    </span>
                  </span>
                </label>
              )}

              {/* The same option as in the Import dialog — they share a translation key so the two
                  places cannot describe one behaviour in two different ways. */}
              {brScan && (
                <label className="cm-check" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={brContinueOnError}
                    onChange={(e) => setBrContinueOnError(e.target.checked)}
                  />
                  <span>
                    {t('importDialog.continueOnErrorLabel')}
                    <span className="cm-hint" style={{ display: 'block' }}>
                      {t('importDialog.continueOnErrorHint')}
                    </span>
                  </span>
                </label>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className={`connection-manager-container ${isSuccessConnecting ? 'connecting-zoom-out' : ''}`} style={{ position: 'relative' }}>
      {isSuccessConnecting && (
        <div className="connection-success-overlay">
          <div className="connection-success-card">
            <div className="connection-success-icon-wrap">
              <Database size={32} className="connection-success-icon" />
              <CheckCircle2 size={16} className="connection-success-badge" />
            </div>
            <div className="connection-success-title">{t('connection.successTitle')}</div>
            <div className="connection-success-subtitle">
              <Trans
                i18nKey="connection.successSubtitle"
                values={{ name: connectingDbName }}
                components={{ strong: <strong /> }}
              />
            </div>
            <div className="connection-success-loader">
              <LoadingSpinner size={16} />
              <span>{t('connection.successLoading')}</span>
            </div>
          </div>
        </div>
      )}

      <div className="connection-card">
        <div className={`cm-shell ${isNew ? 'cm-newconn' : ''}`}>
          {/* ————— Sidebar: the list of saved connections ————— */}
          {!isNew && (
          <aside className="cm-side">
            <div className="cm-side-head">
              <span className="cm-side-title">{t('connection.sideTitle', { n: profiles.length })}</span>
              {/* Importing/exporting profile files: managing the whole set, not opening another connection. */}
              {!embedded && (
                <>
                  <button className="cm-icon-btn" title={t('connection.importFromFile')} onClick={() => document.getElementById('cm-import-file')?.click()}>
                    <Upload size={13} />
                  </button>
                  <input id="cm-import-file" type="file" accept={CONNECTION_FILE_ACCEPT} onChange={handleFileImportSelect} className="cm-hidden-file" />
                  <button className="cm-icon-btn" title={t('connection.exportAll')} onClick={() => openExportModal('all')}>
                    <Download size={13} />
                  </button>
                  {/* The master password sits with these two because all three are about the whole
                      SET of saved connections rather than about the one being edited. */}
                  <button className="cm-icon-btn" title={t('vault.title')} onClick={() => setShowMasterPassword(true)}>
                    <KeyRound size={13} />
                  </button>
                </>
              )}
            </div>

            <div className="cm-new-wrap">
              <button className="cm-new-btn" onClick={() => setShowNewMenu((v) => !v)}>
                <Plus size={14} /> {t('connection.newConnection')}
                <ChevronDown size={13} style={{ opacity: 0.6, marginLeft: 'auto' }} />
              </button>
              {showNewMenu && (
                <>
                  <div className="cm-pop-backdrop" onClick={() => setShowNewMenu(false)} />
                  <div className="cm-pop">
                    {NEW_TYPES.map(nt => {
                      const m = TYPE_META[nt.val];
                      return (
                        <button
                          key={nt.val}
                          className="cm-pop-item"
                          onClick={() => { setShowNewMenu(false); handleCreateNewProfile(nt.val); }}
                        >
                          <span className={`cm-badge sm ${nt.val}`}><m.Icon size={13} /></span>
                          <span>{nt.label}</span>
                        </button>
                      );
                    })}
                    <div className="cm-pop-sep" />
                    <button className="cm-pop-item" onClick={() => { setShowNewMenu(false); setShowImportUrlModal(true); }}>
                      <span className="cm-badge sm ghost"><Link size={12} /></span>
                      <span>{t('connection.fromUrl')}</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="cm-search">
              <Search size={14} className="cm-search-icon" />
              <input
                type="text"
                value={profileSearch}
                onChange={(e) => setProfileSearch(e.target.value)}
                placeholder={t('connection.searchPlaceholder')}
              />
              {profileSearch && (
                <button className="cm-icon-btn sm" onClick={() => setProfileSearch('')} title={t('connection.clearSearch')}>
                  <X size={12} />
                </button>
              )}
            </div>

            <div
              className="cm-list"
              onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, scope: 'all' }); }}
            >
              {groupNames.length === 0 && (
                <div className="cm-empty">
                  {profiles.length === 0
                    ? <Trans i18nKey="connection.emptyNoProfiles" components={{ strong: <b /> }} />
                    : t('connection.emptyNoMatch', { q: profileSearch })}
                </div>
              )}

              {groupNames.map(groupName => {
                const collapsed = !!collapsedGroups[groupName] && !_pq;
                return (
                  <div key={groupName} className="cm-group">
                    <button
                      className="cm-group-head"
                      onClick={() => toggleGroup(groupName)}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, scope: 'group', groupName }); }}
                    >
                      {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      <span>{groupName}</span>
                      <span className="cm-group-count">{groupedProfiles[groupName].length}</span>
                    </button>

                    {!collapsed && groupedProfiles[groupName].map(p => {
                      const m = TYPE_META[p.type] || TYPE_META.sqlite;
                      const isActive = activeProfileId === p.id && !isBrMode;
                      const sqliteFile = p.config?.sqlitePath ? (p.config.sqlitePath.split(/[/\\]/).pop() || p.config.sqlitePath) : '';
                      const sub = p.config?.host
                        ? `${p.config.host}${p.config.database ? ' / ' + p.config.database : ''}`
                        : sqliteFile;
                      const fullSubInfo = p.config?.sqlitePath || sub;
                      // The status light: only the row being acted on has one, and only 'busy'
                      // blinks. This screen exists only while no connection is open, so "open" is not
                      // an available state — what shows instead is connecting/testing and the test's
                      // result.
                      const led: 'busy' | 'ok' | 'fail' | null = !isActive
                        ? null
                        : isBusy ? 'busy'
                          : testStatus === 'ok' ? 'ok'
                            : testStatus === 'fail' ? 'fail'
                              : null;
                      return (
                        <div
                          key={p.id}
                          className={`cm-item ${isActive ? 'active' : ''}`}
                          onClick={() => selectProfile(p)}
                          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, scope: 'single', groupName, profile: p }); }}
                        >
                          <span
                            className={`cm-badge ${p.type}`}
                            style={p.color ? { background: p.color } : undefined}
                          >
                            <m.Icon size={16} />
                          </span>
                          <div className="cm-item-body">
                            <div className="cm-item-name">
                              <span className="cm-ellipsis">{p.name}</span>
                              {/* The status light: only 'busy' blinks. */}
                              {led && <span className={`cm-item-led ${led}`} title={ledTitle[led]} />}
                              {defaultProfileId === p.id && <Star size={10} className="cm-default-star" aria-label={t('connection.defaultConnectionAria')} />}
                            </div>
                            <div className="cm-item-sub" title={fullSubInfo}>{m.label}{sub ? ` · ${sub}` : ''}</div>
                          </div>
                          <div className="cm-item-actions">
                            <button
                              className="cm-icon-btn sm"
                              onClick={(e) => handleToggleDefaultProfile(p.id, e)}
                              title={defaultProfileId === p.id ? t('connection.unsetDefault') : t('connection.setDefault')}
                            >
                              <Star size={12} className={defaultProfileId === p.id ? 'cm-star-active' : ''} />
                            </button>
                            <button className="cm-icon-btn sm" onClick={(e) => handleDuplicateProfile(p, e)} title={t('connection.duplicateProfile')}>
                              <Copy size={12} />
                            </button>
                            <button className="cm-icon-btn sm danger" onClick={(e) => handleDeleteProfile(p.id, e)} title={t('connection.deleteProfile')}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* Backup & Restore acts on the connection that is ALREADY OPEN, so inside an "add
                connection" dialog it is both off-topic and easy to misread as backing up the one
                about to be opened. In the workspace it has its own place on the title bar. */}
            {!embedded && (
              <div className="cm-side-foot">
                <button
                  className={`cm-ghost-row ${isBrMode ? 'active' : ''}`}
                  onClick={() => setActiveType('backup_restore' as any)}
                >
                  <DatabaseBackup size={15} />
                  <span>{t('connection.backupRestore')}</span>
                </button>
              </div>
            )}
          </aside>
          )}

          {/* ————— The main pane ————— */}
          <main className="cm-main">
            {isNew ? (
              hasProfile && (
                <>
                  {/* One compact row instead of the avatar header: the dialog's own title already
                      says what this is, so the row only has to say which engine and offer a way back. */}
                  <header className="cm-newconn-head">
                    <button className="cm-icon-btn" title={t('connection.backToTypes')} onClick={handleBackToTypes}>
                      <ArrowLeft size={15} />
                    </button>
                    <span className={`cm-badge sm ${activeType}`}><activeMeta.Icon size={13} /></span>
                    <span className="cm-newconn-type">{activeMeta.label}</span>
                    <button className="cm-uri" onClick={handleCopyUri} title={t('connection.copyUri')}>
                      <span>{connectionUri}</span>
                      {uriCopied ? <Check size={12} style={{ flexShrink: 0, color: 'var(--st-ok)' }} /> : <Copy size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                    </button>
                  </header>
                  {hasNetTabs && (
                    <nav className="cm-tabs">
                      <button className={`cm-tab ${formTab === 'general' ? 'active' : ''}`} onClick={() => setFormTab('general')}>
                        <Server size={13} /> {t('connection.tabGeneral')}
                        {authMethod === 'aws_iam' && isServerDb && <span className="cm-tab-dot" title={t('connection.tabDotAws')} />}
                      </button>
                      <button className={`cm-tab ${formTab === 'ssl' ? 'active' : ''}`} onClick={() => setFormTab('ssl')}>
                        <ShieldCheck size={13} /> SSL
                        {tlsOn && <span className="cm-tab-dot" title={t('connection.tabDotSsl', { mode: sslMode })} />}
                      </button>
                      <button className={`cm-tab ${formTab === 'ssh' ? 'active' : ''}`} onClick={() => setFormTab('ssh')}>
                        <Network size={13} /> SSH Tunnel
                        {sshEnabled && <span className="cm-tab-dot" title={t('connection.tabDotSsh')} />}
                      </button>
                    </nav>
                  )}
                </>
              )
            ) : isBrMode ? (
              <header className="cm-main-head">
                <button className="cm-icon-btn lg" title={t('connection.backToList')} onClick={() => setActiveType(((profiles.find(p => p.id === activeProfileId)?.type) || 'sqlite') as any)}>
                  <ArrowLeft size={16} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cm-head-name">{t('connection.backupRestore')}</div>
                  <div className="cm-head-meta">{t('connection.brHeadMeta')}</div>
                </div>
              </header>
            ) : hasProfile ? (
              <>
                <header className="cm-main-head">
                  <div className="cm-head-info">
                    <div
                      className={`cm-avatar ${activeType}`}
                      style={profiles.find(p => p.id === activeProfileId)?.color ? { background: profiles.find(p => p.id === activeProfileId)?.color } : undefined}
                    >
                      <activeMeta.Icon size={22} />
                    </div>
                    <div className="cm-head-text">
                      <div className="cm-head-name">
                        <span className="cm-ellipsis">{profileNameInput || t('connection.defaultProfileName')}</span>
                      </div>
                      <div className="cm-head-meta">
                        <span>{activeMeta.label}</span>
                        {profileGroup && <span className="cm-chip">{profileGroup}</span>}
                        <span className={`cm-pill ${testStatus === 'ok' ? 'ok' : testStatus === 'fail' ? 'fail' : 'idle'}`}>
                          <i />
                          {testStatus === 'ok' ? t('connection.pillTested') : testStatus === 'fail' ? t('connection.pillFailed') : t('connection.pillUntested')}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button className="cm-uri" onClick={handleCopyUri} title={t('connection.copyUri')}>
                    <span>{connectionUri}</span>
                    {uriCopied ? <Check size={12} style={{ flexShrink: 0, color: 'var(--st-ok)' }} /> : <Copy size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                  </button>
                </header>

                {hasNetTabs && (
                  <nav className="cm-tabs">
                    <button className={`cm-tab ${formTab === 'general' ? 'active' : ''}`} onClick={() => setFormTab('general')}>
                      <Server size={13} /> {t('connection.tabGeneral')}
                      {authMethod === 'aws_iam' && isServerDb && <span className="cm-tab-dot" title={t('connection.tabDotAws')} />}
                    </button>
                    <button className={`cm-tab ${formTab === 'ssl' ? 'active' : ''}`} onClick={() => setFormTab('ssl')}>
                      <ShieldCheck size={13} /> SSL
                      {tlsOn && <span className="cm-tab-dot" title={t('connection.tabDotSsl', { mode: sslMode })} />}
                    </button>
                    <button className={`cm-tab ${formTab === 'ssh' ? 'active' : ''}`} onClick={() => setFormTab('ssh')}>
                      <Network size={13} /> SSH Tunnel
                      {sshEnabled && <span className="cm-tab-dot" title={t('connection.tabDotSsh')} />}
                    </button>
                  </nav>
                )}
              </>
            ) : null}

            <div className="cm-pane">
              <div className="cm-pane-inner">
                {errorMsg && (
                  <div className="cm-alert err">
                    <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{errorMsg}</span>
                    {/* A server that requires SSL while this is DISABLED -> offer the fix right here,
                        because the driver's own error is fairly opaque to a newcomer. */}
                    {isServerDb && sslMode === 'DISABLED' && /ssl|no encryption|secure transport/i.test(errorMsg) && (
                      <button
                        className="cm-alert-btn"
                        onClick={() => { setSslMode('REQUIRED'); setFormTab('ssl'); setErrorMsg(null); }}
                      >
                        {t('connection.enableSsl')}
                      </button>
                    )}
                    <button className="cm-icon-btn sm" onClick={() => setErrorMsg(null)} title={t('common.close')}><X size={12} /></button>
                  </div>
                )}
                {successMsg && (
                  <div className="cm-alert ok">
                    <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{successMsg}</span>
                    <button className="cm-icon-btn sm" onClick={() => setSuccessMsg(null)} title={t('common.close')}><X size={12} /></button>
                  </div>
                )}
                {/* When the OS secret store fails, the config still saves but the password does not —
                    say so plainly rather than letting the user believe it all went in. */}
                {secretError && (
                  <div className="cm-alert err">
                    <ShieldAlert size={15} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{secretError}</span>
                    <button className="cm-icon-btn sm" onClick={() => setSecretError(null)} title={t('common.close')}><X size={12} /></button>
                  </div>
                )}

                {isNew && !hasProfile
                  ? (
                    <div className="cm-type-pick">
                      <div className="cm-blank-title">{t('connection.pickTypeTitle')}</div>
                      <div className="cm-type-grid">
                        {NEW_TYPES.map(nt => {
                          const m = TYPE_META[nt.val];
                          return (
                            <button key={nt.val} className="cm-type-tile" onClick={() => handleCreateNewProfile(nt.val)}>
                              <span className={`cm-badge ${nt.val}`}><m.Icon size={20} /></span>
                              <span>{nt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {/* Pasted in place rather than behind a second modal: here the URL is just another
                          way to fill the form, so it goes straight to it. */}
                      <div className="cm-type-or"><span>{t('connection.orPasteUrl')}</span></div>
                      <div className="cm-type-url">
                        <Link size={14} className="cm-type-url-icon" />
                        <input
                          type="text"
                          value={importUrlInput}
                          onChange={(e) => setImportUrlInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && importUrlInput.trim()) handleImportUrlSubmit(); }}
                          placeholder={t('connection.urlPlaceholder')}
                          spellCheck={false}
                        />
                        <button
                          className="cm-btn primary"
                          onClick={handleImportUrlSubmit}
                          disabled={!importUrlInput.trim()}
                          title={t('connection.urlContinue')}
                        >
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    </div>
                  )
                  : isBrMode
                  ? renderBackupRestore()
                  : !hasProfile
                    ? (
                      <div className="cm-blank">
                        <Database size={34} style={{ opacity: 0.35 }} />
                        <div className="cm-blank-title">{t('connection.blankTitle')}</div>
                        <div className="cm-hint">{t('connection.blankHint')}</div>
                      </div>
                    )
                    : formTab === 'ssl' && hasNetTabs
                      ? renderSslTab()
                      : formTab === 'ssh' && hasNetTabs
                        ? renderSshTab()
                        : renderGeneralTab()}
              </div>
            </div>

            <footer className="cm-foot">
              {isNew ? (
                hasProfile && (
                  <>
                    <label className="cm-check">
                      <input type="checkbox" checked={saveToList} onChange={(e) => setSaveToList(e.target.checked)} />
                      <span>{t('connection.saveToList')}</span>
                    </label>
                    <span className="cm-foot-msg" />
                    <button className="cm-btn" onClick={handleTestConnection} disabled={isBusy}>
                      {isTesting ? <LoadingSpinner size={13} /> : <CheckCircle2 size={13} />} {t('connection.test')}
                    </button>
                    <button className="cm-btn primary" onClick={() => handleConnect(false)} disabled={isBusy}>
                      {isConnecting
                        ? <><LoadingSpinner size={13} /> {t('connection.connecting')}</>
                        : <><LogIn size={14} /> {t('connection.connect')}</>}
                    </button>
                  </>
                )
              ) : isBrMode ? (
                <>
                  {/* No progress bar here any more: backup and restore run in the background and
                      their progress lives in the JobsTray on the title bar. See
                      docs/background-jobs-plan.md. */}
                  <span className="cm-foot-msg cm-hint">
                    {brAction === 'restore' && brScan && brParsedTables.length > 0
                      ? t('connection.brFootSelected', { selected: brSelectedTables.length, total: brParsedTables.length })
                      : ''}
                  </span>
                  <button
                    className="cm-btn primary"
                    onClick={handleBrClick}
                    disabled={brAction === 'restore' && (!brScan || brParsing || (brParsedTables.length > 0 && brSelectedTables.length === 0))}
                  >
                    {brAction === 'backup'
                      ? <><Download size={14} /> {t('connection.brStartBackup')}</>
                      : <><Upload size={14} /> {t('connection.brStartRestore')}</>}
                  </button>
                </>
              ) : hasProfile ? (
                <>
                  <button className="cm-btn" onClick={() => handleSaveProfile()}>
                    <Save size={13} /> {t('connection.saveChanges')}
                  </button>
                  <span className="cm-foot-msg" />
                  <button className="cm-btn" onClick={handleTestConnection} disabled={isBusy}>
                    {isTesting ? <LoadingSpinner size={13} /> : <CheckCircle2 size={13} />} {t('connection.test')}
                  </button>
                  <button className="cm-btn primary" onClick={() => handleConnect(false)} disabled={isBusy}>
                    {isConnecting
                      ? <><LoadingSpinner size={13} /> {t('connection.connecting')}</>
                      : <><LogIn size={14} /> {t('connection.connect')}</>}
                  </button>
                </>
              ) : null}
            </footer>
          </main>
        </div>
      </div>

      {/* ————— Modal: import from a connection URL ————— */}
      {showImportUrlModal && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-head">
              <Link size={14} style={{ color: 'var(--win-accent)' }} />
              <h3>{t('connection.importUrlTitle')}</h3>
              <button className="cm-icon-btn" onClick={() => { setShowImportUrlModal(false); setImportUrlInput(''); }} title={t('common.close')}><X size={14} /></button>
            </div>
            <div className="form-group">
              <label>{t('connection.connectionUrl')}</label>
              <input
                type="text"
                className="form-input"
                value={importUrlInput}
                onChange={(e) => setImportUrlInput(e.target.value)}
                placeholder="postgresql://user:password@host:5432/database"
                onKeyDown={(e) => { if (e.key === 'Enter' && importUrlInput.trim()) handleImportUrlSubmit(); }}
                autoFocus
              />
              <span className="cm-hint">{t('connection.importUrlHint')}</span>
            </div>
            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => { setShowImportUrlModal(false); setImportUrlInput(''); }}>{t('common.cancel')}</button>
              <button className="cm-btn primary" onClick={handleImportUrlSubmit} disabled={!importUrlInput.trim()}>{t('connection.importAction')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ————— Context menu for a connection / group ————— */}
      {contextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setContextMenu(null)} />
          <div className="cm-ctx" style={{ top: contextMenu.y, left: contextMenu.x }}>
            {contextMenu.scope === 'single' && contextMenu.profile && (
              <>
                <button className="context-menu-item" onClick={() => { handleToggleDefaultProfile(contextMenu.profile!.id); setContextMenu(null); }}>
                  <Star size={13} style={{ fill: defaultProfileId === contextMenu.profile.id ? 'var(--st-warn)' : 'none', color: 'var(--st-warn)', flexShrink: 0 }} />
                  <span>{defaultProfileId === contextMenu.profile.id ? t('connection.unsetDefault') : t('connection.setDefault')}</span>
                </button>
                <button className="context-menu-item" onClick={() => { handleDuplicateProfile(contextMenu.profile!, { stopPropagation: () => { } } as any); setContextMenu(null); }}>
                  <Copy size={13} style={{ flexShrink: 0 }} />
                  <span>{t('connection.duplicateProfile')}</span>
                </button>
                <button className="context-menu-item" onClick={async () => { const p = contextMenu.profile!; setContextMenu(null); /* an SSH terminal needs the password/private key -> read them from the OS store */ setTerminalProfile({ ...p, config: await configWithSecrets(p) }); }}>
                  <TerminalSquare size={13} style={{ flexShrink: 0 }} />
                  <span>
                    {contextMenu.profile.config?.sshEnabled && contextMenu.profile.config?.sshHost
                      ? t('connection.ctxOpenSshTerminal')
                      : t('connection.ctxOpenLocalTerminal')}
                  </span>
                </button>
                <div className="cm-pop-sep" />
                <button className="context-menu-item" onClick={() => openExportModal('single', undefined, contextMenu.profile)}>
                  <Download size={13} style={{ flexShrink: 0 }} />
                  <span>{t('connection.ctxExportThis')}</span>
                </button>
              </>
            )}
            {(contextMenu.scope === 'group' || contextMenu.scope === 'single') && contextMenu.groupName && (
              <button className="context-menu-item" onClick={() => openExportModal('group', contextMenu.groupName)}>
                <Download size={13} style={{ flexShrink: 0 }} />
                <span>{t('connection.ctxExportGroup', { name: contextMenu.groupName })}</span>
              </button>
            )}
            <button className="context-menu-item" onClick={() => openExportModal('all')}>
              <Download size={13} style={{ flexShrink: 0 }} />
              <span>{t('connection.exportAll')}</span>
            </button>
          </div>
        </>
      )}

      {/* The Terminal overlay (SSH when the profile has SSH, otherwise a local shell) */}
      {terminalProfile && (
        <TerminalPanel
          connId={connId}
          config={terminalProfile.config as DbConnectionConfig}
          profileName={terminalProfile.name}
          floating
          onClose={() => setTerminalProfile(null)}
        />
      )}

      {showMasterPassword && (
        <MasterPasswordModal onClose={() => setShowMasterPassword(false)} />
      )}

      {/* ————— Modal: connection export options ————— */}
      {showExportModal && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-head">
              <Download size={14} style={{ color: 'var(--win-accent)' }} />
              <h3>
                {exportScope === 'group' ? t('connection.exportModalGroup', { name: exportGroupTarget }) :
                  exportScope === 'single' ? t('connection.exportModalSingle', { name: exportSingleProfile?.name }) :
                    t('connection.exportAll')}
              </h3>
              <button className="cm-icon-btn" onClick={() => setShowExportModal(false)} title={t('common.close')} disabled={exporting}><X size={14} /></button>
            </div>

            <div className="cm-subcard">
              <label className="cm-check">
                <input type="checkbox" checked={exportIncludePasswords} onChange={(e) => setExportIncludePasswords(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>{t('connection.exportIncludePasswords')}</span>
              </label>
              <div className={`cm-hint ${exportIncludePasswords ? 'warn' : ''}`} style={{ marginLeft: '24px', marginTop: '4px' }}>
                {exportIncludePasswords
                  ? t('connection.exportWarnIncluded')
                  : t('connection.exportWarnExcluded')}
              </div>
              <div className="form-group" style={{ marginTop: '14px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Lock size={11} /> {t('connection.exportFilePassword')}
                </label>
                <input
                  type="password"
                  className="form-input"
                  value={exportFilePassword}
                  onChange={(e) => setExportFilePassword(e.target.value)}
                  placeholder={t('connection.exportFilePasswordPlaceholder')}
                />
              </div>
            </div>

            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => setShowExportModal(false)} disabled={exporting}>{t('common.cancel')}</button>
              {/* Wrapped in an arrow: passed directly, the MouseEvent lands in
                  `plainConfirmed` (truthy) and the plain-password warning is skipped. */}
              <button className="cm-btn primary" onClick={() => handlePerformExport()} disabled={exporting}>
                {exporting ? <LoadingSpinner size={12} /> : <Download size={13} />} {t('connection.exportAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ————— Modal: enter the password to decrypt the file ————— */}
      {showImportPasswordModal && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal sm" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-head">
              <Lock size={14} style={{ color: 'var(--st-warn)' }} />
              <h3>{t('connection.importPwTitle')}</h3>
            </div>
            <p className="cm-hint" style={{ margin: 0 }}>
              {t('connection.importPwDesc')}
            </p>
            <div className="form-group">
              <label>{t('connection.importPwLabel')}</label>
              <input
                type="password"
                className="form-input"
                value={importPasswordInput}
                onChange={(e) => setImportPasswordInput(e.target.value)}
                placeholder={t('connection.importPwPlaceholder')}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePasswordDecryptSubmit(); }}
                autoFocus
              />
            </div>
            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => { setShowImportPasswordModal(false); setPendingImportContent(null); }} disabled={importing}>{t('common.cancel')}</button>
              <button className="cm-btn primary" onClick={handlePasswordDecryptSubmit} disabled={importing || !importPasswordInput.trim()}>
                {importing ? <LoadingSpinner size={12} /> : <Key size={13} />} {t('connection.importPwSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete profile. zIndex above the export/import modals (.cm-modal sets its own). */}
      <ConfirmDialog
        open={!!deleteProfileId}
        danger
        zIndex={1000000}
        title={t('connection.confirmDeleteProfileTitle')}
        message={t('connection.confirmDeleteProfile')}
        onConfirm={() => { const id = deleteProfileId; setDeleteProfileId(null); if (id) doDeleteProfile(id); }}
        onCancel={() => setDeleteProfileId(null)}
      />

      {/* Warning about exporting passwords in the clear — asked before reading the keychain. */}
      <ConfirmDialog
        open={confirmPlainExport}
        danger
        zIndex={1000000}
        title={t('connection.confirmExportPlainTitle')}
        message={t('connection.confirmExportPlainPasswords')}
        onConfirm={() => { setConfirmPlainExport(false); handlePerformExport(true); }}
        onCancel={() => setConfirmPlainExport(false)}
      />
    </div>
  );
};
