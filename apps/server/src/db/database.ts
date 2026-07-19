import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface AppDatabase {
  db: DrizzleDatabase;
  sqlite: Database;
  close(): void;
}

const initialSchema = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, original_prompt TEXT NOT NULL, working_directory TEXT NOT NULL,
    base_commit TEXT NOT NULL, latest_snapshot_hash TEXT,
    status TEXT NOT NULL, developer_provider TEXT NOT NULL DEFAULT 'codex', reviewer_provider TEXT NOT NULL DEFAULT 'claude',
    developer_session_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_project_id_index ON tasks(project_id);
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, provider TEXT NOT NULL,
    run_type TEXT NOT NULL, status TEXT NOT NULL, review_parse_status TEXT,
    external_session_id TEXT, process_id INTEGER, exit_code INTEGER, prompt TEXT NOT NULL,
    final_message TEXT, structured_output TEXT, error_message TEXT, started_at TEXT, finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_runs_task_id_index ON agent_runs(task_id);
  CREATE INDEX IF NOT EXISTS agent_runs_project_id_index ON agent_runs(project_id);
  CREATE UNIQUE INDEX IF NOT EXISTS active_agent_run_per_task_unique ON agent_runs(task_id)
    WHERE status IN ('queued', 'running');
  CREATE UNIQUE INDEX IF NOT EXISTS active_write_run_per_project_unique ON agent_runs(project_id)
    WHERE run_type IN ('developer_initial', 'developer_feedback', 'developer_followup') AND status IN ('queued', 'running');
  CREATE TABLE IF NOT EXISTS task_messages (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    target_role TEXT NOT NULL, source_review_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    text TEXT NOT NULL, delivery_mode TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT, error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS task_messages_task_id_index ON task_messages(task_id);
  CREATE INDEX IF NOT EXISTS task_messages_source_review_run_id_index ON task_messages(source_review_run_id);
  CREATE TABLE IF NOT EXISTS task_attachments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES task_messages(id) ON DELETE CASCADE,
    state TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    checksum TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, claimed_at TEXT,
    CHECK (
      (state = 'draft' AND task_id IS NULL AND message_id IS NULL AND claimed_at IS NULL)
      OR (state = 'claimed' AND task_id IS NOT NULL AND claimed_at IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS task_attachments_project_state_index ON task_attachments(project_id, state);
  CREATE INDEX IF NOT EXISTS task_attachments_task_id_index ON task_attachments(task_id);
  CREATE INDEX IF NOT EXISTS task_attachments_message_id_index ON task_attachments(message_id);
  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    provider_request_id TEXT NOT NULL, tool_name TEXT NOT NULL, action_summary TEXT NOT NULL,
    working_directory TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, reason TEXT,
    created_at TEXT NOT NULL, resolved_at TEXT,
    CHECK (
      (status = 'resolved' AND decision IN ('allow_once', 'deny') AND resolved_at IS NOT NULL)
      OR (status = 'pending' AND decision IS NULL AND resolved_at IS NULL)
      OR (status = 'expired' AND decision IS NULL AND resolved_at IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_run_provider_request_unique
    ON approval_requests(run_id, provider_request_id);
  CREATE INDEX IF NOT EXISTS approval_requests_task_status_index ON approval_requests(task_id, status);
  CREATE TABLE IF NOT EXISTS application_leases (
    slot INTEGER PRIMARY KEY CHECK (slot = 1), owner_instance_id TEXT NOT NULL,
    process_id INTEGER NOT NULL, lease_expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_leases (
    run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    owner_instance_id TEXT NOT NULL, lease_expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_leases_owner_instance_id_index ON run_leases(owner_instance_id);
  CREATE TABLE IF NOT EXISTS review_run_snapshots (
    run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    snapshot_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
    source TEXT NOT NULL, event_type TEXT NOT NULL, raw_json TEXT NOT NULL, normalized_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_events_task_sequence_unique ON agent_events(task_id, sequence);
  CREATE INDEX IF NOT EXISTS agent_events_run_id_index ON agent_events(run_id);
  CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, severity TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, suggestion TEXT NOT NULL, file TEXT,
    start_line INTEGER, end_line INTEGER, selected INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0,
    user_note TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS review_findings_task_id_index ON review_findings(task_id);
  CREATE TABLE IF NOT EXISTS feedback_deliveries (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_review_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    target_developer_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    selected_finding_ids TEXT NOT NULL, final_text TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feedback_deliveries_task_id_index ON feedback_deliveries(task_id);
  CREATE TABLE IF NOT EXISTS feedback_drafts (
    source_review_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    final_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feedback_drafts_task_id_index ON feedback_drafts(task_id);
  CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

function migrateTaskProviderColumns(sqlite: Database): void {
  const columns = new Set(
    (sqlite.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("developer_provider")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN developer_provider TEXT NOT NULL DEFAULT 'codex'");
  }
  if (!columns.has("reviewer_provider")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN reviewer_provider TEXT NOT NULL DEFAULT 'claude'");
  }
  sqlite.exec(`
    UPDATE tasks
    SET developer_provider = 'codex'
    WHERE developer_provider IS NULL OR developer_provider = '';
    UPDATE tasks
    SET reviewer_provider = 'claude'
    WHERE reviewer_provider IS NULL OR reviewer_provider = '';
  `);
}

function migrateActiveWriteRunIndex(sqlite: Database): void {
  sqlite.exec(`
    DROP INDEX IF EXISTS active_write_run_per_project_unique;
    CREATE UNIQUE INDEX active_write_run_per_project_unique ON agent_runs(project_id)
      WHERE run_type IN ('developer_initial', 'developer_feedback', 'developer_followup')
        AND status IN ('queued', 'running');
  `);
}

export function createDatabase(path = ":memory:"): AppDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(initialSchema);
  migrateTaskProviderColumns(sqlite);
  migrateActiveWriteRunIndex(sqlite);
  return { db: drizzle(sqlite, { schema }), sqlite, close: () => sqlite.close() };
}
