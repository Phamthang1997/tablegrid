// Running a background job on a connection of its own (docs/background-jobs-plan.md §4.2).
//
// Every job used to run on the connection the user had open, and three things leaked through that
// shared `conn_id`: the manual-transaction session (a restore's statements could land in the user's
// transaction, and the user's in the restore's), session-level state (`SET FOREIGN_KEY_CHECKS = 0`,
// `PRAGMA foreign_keys = OFF` on the very SQLite handle the user browsed with), and the cancel flag,
// keyed by `conn_id`. A private id per job removes all three at once, which is why this is ONE helper
// every job goes through rather than a rule each call site remembers.

import { dbHelper } from './dbHelper';
import { openJobDoor, type JobApproval } from './safeMode';

export interface JobConnection {
  /** The job's own id. Pass it to every command the job runs. */
  connId: string;
  /** The Postgres schema of the source connection, `null` elsewhere. */
  schema: string | null;
}

/**
 * Opens a connection for the job on the same server and database as `sourceConnId`, runs `run`
 * with it, and closes it again — in a `finally`, so a failed or cancelled job cleans up the same way.
 *
 * `approvals` are the Safe Mode answers collected when the job was submitted (`approveJob`); their
 * doors are opened on the job's id only, so the job's writes go through unasked and nothing else
 * does. A job that only reads passes none.
 *
 * `onOpen` hands the id out before `run` starts, for a job whose cancel has to name it
 * (`cancelRestore`, `cancelDataGeneration`): cancel can be pressed at any moment, including while
 * the connection is still opening.
 */
export async function withJobConnection<T>(
  sourceConnId: string,
  approvals: JobApproval[],
  run: (conn: JobConnection) => Promise<T>,
  onOpen?: (connId: string) => void,
): Promise<T> {
  const conn = await dbHelper.openJobConnection(sourceConnId);
  return runOnJobConnection(conn, approvals, run, onOpen);
}

/**
 * The same, for a connection the job already opened itself (`dbHelper.connectJob`, from a config).
 * Takes ownership: the connection is closed when `run` settles.
 */
export async function runOnJobConnection<T>(
  conn: JobConnection,
  approvals: JobApproval[],
  run: (conn: JobConnection) => Promise<T>,
  onOpen?: (connId: string) => void,
): Promise<T> {
  const closeDoors = approvals.map((a) => openJobDoor(a, conn.connId));
  try {
    onOpen?.(conn.connId);
    return await run(conn);
  } finally {
    for (const close of closeDoors) close();
    await dbHelper.closeJobConnection(conn.connId);
  }
}
