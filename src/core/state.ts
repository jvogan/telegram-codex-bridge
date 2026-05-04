import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import type {
  ActiveTaskRecord,
  ActiveCallRecord,
  ApprovalRecord,
  ApprovalStatus,
  BoundThread,
  BridgeMode,
  BridgeOwner,
  CallInboxItem,
  CallInboxStatus,
  GatewayBridgeConnectionState,
  RealtimeCallSurfaceRecord,
  RealtimeTunnelMode,
  Modality,
  PendingCallHandoffRecord,
  ProviderId,
  QueueStatus,
  QueuedTelegramTask,
  RecentCallSummary,
  RecentFailedTaskRecord,
  ShutdownHintRecord,
  StoredArtifact,
} from "./types.js";
import { ensureDir, ensurePrivateFile } from "./util/files.js";

const BRIDGE_SQLITE_BUSY_TIMEOUT_MS = 1_000;

interface QueueRow {
  id: string;
  update_id: number;
  chat_id: string;
  message_id: number;
  kind: string;
  text: string;
  payload_json: string;
  status: QueueStatus;
  placeholder_message_id: number | null;
  error_text: string | null;
  created_at: number;
  updated_at: number;
}

interface CallInboxRow {
  id: string;
  call_id: string;
  update_id: number;
  chat_id: string;
  message_id: number;
  kind: string;
  text: string;
  payload_json: string;
  status: CallInboxStatus;
  created_at: number;
  updated_at: number;
}

export interface RealtimeUsage {
  dayKey: string;
  callCount: number;
  totalCallMs: number;
  lastEndedAt: number | null;
}

export interface RealtimeUsageRecord {
  callId: string;
  durationMs: number;
  endedAt: number;
  recordedAt: number;
}

function dayKeyFor(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class BridgeState {
  readonly db: DatabaseSync;
  private readonly storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = storageRoot;
    ensureDir(storageRoot);
    const dbPath = join(storageRoot, "bridge.sqlite");
    this.db = new DatabaseSync(dbPath);
    ensurePrivateFile(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = ${BRIDGE_SQLITE_BUSY_TIMEOUT_MS};
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_queue (
        id TEXT PRIMARY KEY,
        update_id INTEGER NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        placeholder_message_id INTEGER,
        error_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        prompt_message_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        modality TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS call_inbox (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        update_id INTEGER NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_delivery_state (
        artifact_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        last_error_text TEXT,
        updated_at INTEGER NOT NULL,
        quarantined_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS processed_telegram_updates (
        update_id INTEGER PRIMARY KEY,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        error_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS call_handoff_appends (
        call_id TEXT PRIMARY KEY,
        prompt_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        acknowledgement TEXT,
        error_text TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pending_user_input_diagnostics (
        local_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        prompt_message_id INTEGER NOT NULL,
        questions_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    ensurePrivateFile(dbPath);
    ensurePrivateFile(`${dbPath}-wal`);
    ensurePrivateFile(`${dbPath}-shm`);
  }

  recoverInterruptedWork(): ActiveTaskRecord | null {
    const now = Date.now();
    this.db.prepare("UPDATE pending_approvals SET status = 'expired' WHERE status = 'pending'").run();
    const processingRows = this.db
      .prepare("SELECT id FROM message_queue WHERE status = 'processing'")
      .all() as Array<{ id: string }>;
    const processingIds = new Set(processingRows.map(row => row.id));
    const activeTask = this.getActiveTask();

    if (!activeTask || !processingIds.has(activeTask.queueId)) {
      this.db.prepare("UPDATE message_queue SET status = 'pending', updated_at = ? WHERE status = 'processing'").run(now);
      if (activeTask) {
        this.setActiveTask(null);
      }
      return null;
    }

    this.db
      .prepare(`
        UPDATE message_queue
        SET status = 'pending', updated_at = ?
        WHERE status = 'processing' AND id != ?
      `)
      .run(now, activeTask.queueId);
    return activeTask;
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (!row) {
      return fallback;
    }
    return JSON.parse(row.value_json) as T;
  }

  setSetting<T>(key: string, value: T): void {
    this.db
      .prepare(`
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `)
      .run(key, JSON.stringify(value));
  }

  enqueueTask(task: QueuedTelegramTask): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO message_queue (
          id, update_id, chat_id, message_id, kind, text, payload_json, status, placeholder_message_id, error_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
      `)
      .run(task.id, task.updateId, task.chatId, task.messageId, task.kind, task.text, JSON.stringify(task), now, now);
  }

  nextPendingTask(): QueuedTelegramTask | null {
    const row = this.db
      .prepare(`
        SELECT * FROM message_queue
        WHERE status = 'pending'
        ORDER BY update_id ASC
        LIMIT 1
      `)
      .get() as QueueRow | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.payload_json) as QueuedTelegramTask;
  }

  getTask(id: string): QueuedTelegramTask | null {
    const row = this.db
      .prepare("SELECT payload_json FROM message_queue WHERE id = ?")
      .get(id) as { payload_json: string } | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.payload_json) as QueuedTelegramTask;
  }

  replaceTask(task: QueuedTelegramTask): void {
    this.db
      .prepare(`
        UPDATE message_queue
        SET text = ?, payload_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(task.text, JSON.stringify(task), Date.now(), task.id);
  }

  updateQueueStatus(id: string, status: QueueStatus, options?: { placeholderMessageId?: number | null; errorText?: string | null }): void {
    const previous = this.db
      .prepare("SELECT placeholder_message_id, error_text FROM message_queue WHERE id = ?")
      .get(id) as { placeholder_message_id: number | null; error_text: string | null } | undefined;
    this.db
      .prepare(`
        UPDATE message_queue
        SET status = ?, placeholder_message_id = ?, error_text = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        options?.placeholderMessageId ?? previous?.placeholder_message_id ?? null,
        options?.errorText ?? previous?.error_text ?? null,
        Date.now(),
        id,
      );
  }

  getQueueState(id: string): { status: QueueStatus; placeholderMessageId: number | null; errorText: string | null } | null {
    const row = this.db
      .prepare("SELECT status, placeholder_message_id, error_text FROM message_queue WHERE id = ?")
      .get(id) as {
        status: QueueStatus;
        placeholder_message_id: number | null;
        error_text: string | null;
      } | undefined;
    if (!row) {
      return null;
    }
    return {
      status: row.status,
      placeholderMessageId: row.placeholder_message_id,
      errorText: row.error_text,
    };
  }

  getQueuedTaskCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM message_queue WHERE status = 'pending'").get() as { count: number };
    return row.count;
  }

  listPendingTasks(limit = 20): QueuedTelegramTask[] {
    const rows = this.db
      .prepare(`
        SELECT payload_json
        FROM message_queue
        WHERE status = 'pending'
        ORDER BY update_id ASC
        LIMIT ?
      `)
      .all(limit) as Array<{ payload_json: string }>;
    return rows.map(row => JSON.parse(row.payload_json) as QueuedTelegramTask);
  }

  listRecentFailedTasks(limit = 20): QueuedTelegramTask[] {
    const rows = this.db
      .prepare(`
        SELECT payload_json
        FROM message_queue
        WHERE status = 'failed'
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{ payload_json: string }>;
    return rows.map(row => JSON.parse(row.payload_json) as QueuedTelegramTask);
  }

  listRecentFailedTaskRecords(limit = 20): RecentFailedTaskRecord[] {
    const rows = this.db
      .prepare(`
        SELECT payload_json, error_text, updated_at
        FROM message_queue
        WHERE status = 'failed'
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
        payload_json: string;
        error_text: string | null;
        updated_at: number;
      }>;
    return rows.map(row => ({
      task: JSON.parse(row.payload_json) as QueuedTelegramTask,
      errorText: row.error_text,
      updatedAt: row.updated_at,
    }));
  }

  getMostRecentFailedTask(): RecentFailedTaskRecord | null {
    return this.listRecentFailedTaskRecords(1)[0] ?? null;
  }

  getMostRecentFailedTaskSince(since: number | null | undefined): RecentFailedTaskRecord | null {
    if (typeof since !== "number" || !Number.isFinite(since) || since <= 0) {
      return this.getMostRecentFailedTask();
    }
    const row = this.db
      .prepare(`
        SELECT payload_json, error_text, updated_at
        FROM message_queue
        WHERE status = 'failed' AND updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(since) as {
        payload_json: string;
        error_text: string | null;
        updated_at: number;
      } | undefined;
    return row
      ? {
        task: JSON.parse(row.payload_json) as QueuedTelegramTask,
        errorText: row.error_text,
        updatedAt: row.updated_at,
      }
      : null;
  }

  getPendingApprovalCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM pending_approvals WHERE status = 'pending'").get() as { count: number };
    return row.count;
  }

  recordPendingUserInputDiagnostic(record: {
    localId: string;
    requestId: string;
    chatId: string;
    promptMessageId: number;
    questionsJson: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO pending_user_input_diagnostics (
          local_id, request_id, chat_id, prompt_message_id, questions_json, status, error_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
        ON CONFLICT(local_id) DO UPDATE SET
          request_id = excluded.request_id,
          chat_id = excluded.chat_id,
          prompt_message_id = excluded.prompt_message_id,
          questions_json = excluded.questions_json,
          status = 'pending',
          error_text = NULL,
          updated_at = excluded.updated_at
      `)
      .run(
        record.localId,
        record.requestId,
        record.chatId,
        record.promptMessageId,
        record.questionsJson,
        record.createdAt,
        record.createdAt,
      );
  }

  resolvePendingUserInputDiagnostic(localId: string): void {
    this.db
      .prepare(`
        UPDATE pending_user_input_diagnostics
        SET status = 'resolved', error_text = NULL, updated_at = ?
        WHERE local_id = ?
      `)
      .run(Date.now(), localId);
  }

  failPendingUserInputDiagnostic(localId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(`
        UPDATE pending_user_input_diagnostics
        SET status = 'failed', error_text = ?, updated_at = ?
        WHERE local_id = ?
      `)
      .run(message, Date.now(), localId);
  }

  recoverPendingUserInputDiagnostics(reason: string): number {
    const result = this.db
      .prepare(`
        UPDATE pending_user_input_diagnostics
        SET status = 'recovered_failed', error_text = ?, updated_at = ?
        WHERE status = 'pending'
      `)
      .run(reason, Date.now());
    return Number(result.changes ?? 0);
  }

  getPendingUserInputDiagnosticCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM pending_user_input_diagnostics WHERE status = 'pending'")
      .get() as { count: number };
    return row.count;
  }

  listUserInputDiagnostics(limit = 5): Array<{
    localId: string;
    requestId: string;
    chatId: string;
    promptMessageId: number;
    status: string;
    errorText: string | null;
    updatedAt: number;
  }> {
    const rows = this.db
      .prepare(`
        SELECT local_id, request_id, chat_id, prompt_message_id, status, error_text, updated_at
        FROM pending_user_input_diagnostics
        WHERE status IN ('pending', 'failed', 'recovered_failed')
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{
        local_id: string;
        request_id: string;
        chat_id: string;
        prompt_message_id: number;
        status: string;
        error_text: string | null;
        updated_at: number;
      }>;
    return rows.map(row => ({
      localId: row.local_id,
      requestId: row.request_id,
      chatId: row.chat_id,
      promptMessageId: row.prompt_message_id,
      status: row.status,
      errorText: row.error_text,
      updatedAt: row.updated_at,
    }));
  }

  insertApproval(record: ApprovalRecord): void {
    this.db
      .prepare(`
        INSERT INTO pending_approvals (id, request_id, method, payload_json, prompt_message_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(record.localId, record.requestId, record.method, record.payloadJson, record.promptMessageId, record.status, record.createdAt);
  }

  resolveApproval(localId: string, status: ApprovalStatus): ApprovalRecord | null {
    const row = this.db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(localId) as {
      id: string;
      request_id: string;
      method: string;
      payload_json: string;
      prompt_message_id: number;
      status: ApprovalStatus;
      created_at: number;
    } | undefined;
    if (!row) {
      return null;
    }
    this.db.prepare("UPDATE pending_approvals SET status = ? WHERE id = ?").run(status, localId);
    return {
      localId: row.id,
      requestId: row.request_id,
      method: row.method,
      payloadJson: row.payload_json,
      promptMessageId: row.prompt_message_id,
      status,
      createdAt: row.created_at,
    };
  }

  getPendingApprovals(): ApprovalRecord[] {
    const rows = this.db.prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC").all() as Array<{
      id: string;
      request_id: string;
      method: string;
      payload_json: string;
      prompt_message_id: number;
      status: ApprovalStatus;
      created_at: number;
    }>;
    return rows.map(row => ({
      localId: row.id,
      requestId: row.request_id,
      method: row.method,
      payloadJson: row.payload_json,
      promptMessageId: row.prompt_message_id,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  saveArtifact(artifact: StoredArtifact): void {
    this.db
      .prepare(`
        INSERT INTO artifacts (
          id, modality, provider_id, source, path, mime_type, file_name, metadata_json, created_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.id,
        artifact.modality,
        artifact.providerId,
        artifact.source,
        artifact.path,
        artifact.mimeType,
        artifact.fileName,
        JSON.stringify(artifact.metadata),
        artifact.createdAt,
        artifact.deliveredAt,
      );
  }

  markArtifactDelivered(id: string): void {
    this.db.prepare("UPDATE artifacts SET delivered_at = ? WHERE id = ?").run(Date.now(), id);
    this.db.prepare("DELETE FROM artifact_delivery_state WHERE artifact_id = ?").run(id);
  }

  recordArtifactDeliveryFailure(id: string, error: unknown, options?: { quarantine?: boolean }): void {
    const now = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(`
        INSERT INTO artifact_delivery_state (
          artifact_id, attempts, last_error_text, updated_at, quarantined_at
        ) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          attempts = attempts + 1,
          last_error_text = excluded.last_error_text,
          updated_at = excluded.updated_at,
          quarantined_at = COALESCE(excluded.quarantined_at, artifact_delivery_state.quarantined_at)
      `)
      .run(id, message, now, options?.quarantine ? now : null);
  }

  getArtifactDeliveryState(id: string): {
    artifactId: string;
    attempts: number;
    lastErrorText: string | null;
    updatedAt: number;
    quarantinedAt: number | null;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM artifact_delivery_state WHERE artifact_id = ?")
      .get(id) as {
        artifact_id: string;
        attempts: number;
        last_error_text: string | null;
        updated_at: number;
        quarantined_at: number | null;
      } | undefined;
    return row
      ? {
        artifactId: row.artifact_id,
        attempts: row.attempts,
        lastErrorText: row.last_error_text,
        updatedAt: row.updated_at,
        quarantinedAt: row.quarantined_at,
      }
      : null;
  }

  claimProcessedTelegramUpdate(updateId: number, category: string): boolean {
    const now = Date.now();
    try {
      this.db
        .prepare(`
          INSERT INTO processed_telegram_updates (
            update_id, category, status, error_text, created_at, updated_at
          ) VALUES (?, ?, 'processing', NULL, ?, ?)
        `)
        .run(updateId, category, now, now);
      return true;
    } catch {
      return false;
    }
  }

  completeProcessedTelegramUpdate(updateId: number): void {
    this.db
      .prepare(`
        UPDATE processed_telegram_updates
        SET status = 'completed', error_text = NULL, updated_at = ?
        WHERE update_id = ?
      `)
      .run(Date.now(), updateId);
  }

  failProcessedTelegramUpdate(updateId: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(`
        UPDATE processed_telegram_updates
        SET status = 'failed', error_text = ?, updated_at = ?
        WHERE update_id = ?
      `)
      .run(message, Date.now(), updateId);
  }

  getProcessedTelegramUpdate(updateId: number): {
    updateId: number;
    category: string;
    status: string;
    errorText: string | null;
    createdAt: number;
    updatedAt: number;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM processed_telegram_updates WHERE update_id = ?")
      .get(updateId) as {
        update_id: number;
        category: string;
        status: string;
        error_text: string | null;
        created_at: number;
        updated_at: number;
      } | undefined;
    return row
      ? {
        updateId: row.update_id,
        category: row.category,
        status: row.status,
        errorText: row.error_text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
      : null;
  }

  beginCallHandoffAppend(callId: string, promptHash: string): {
    status: "started" | "already_in_progress" | "already_appended" | "failed_previous";
    acknowledgement: string | null;
    errorText: string | null;
  } {
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT status, acknowledgement, error_text, updated_at FROM call_handoff_appends WHERE call_id = ?")
      .get(callId) as {
        status: string;
        acknowledgement: string | null;
        error_text: string | null;
        updated_at: number;
      } | undefined;
    if (existing?.status === "appended") {
      return { status: "already_appended", acknowledgement: existing.acknowledgement, errorText: null };
    }
    if (existing?.status === "in_progress" && now - existing.updated_at < 5 * 60_000) {
      return { status: "already_in_progress", acknowledgement: null, errorText: existing.error_text };
    }
    this.db
      .prepare(`
        INSERT INTO call_handoff_appends (
          call_id, prompt_hash, status, acknowledgement, error_text, started_at, updated_at, completed_at
        ) VALUES (?, ?, 'in_progress', NULL, NULL, ?, ?, NULL)
        ON CONFLICT(call_id) DO UPDATE SET
          prompt_hash = excluded.prompt_hash,
          status = 'in_progress',
          acknowledgement = NULL,
          error_text = NULL,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          completed_at = NULL
      `)
      .run(callId, promptHash, now, now);
    return { status: existing ? "failed_previous" : "started", acknowledgement: null, errorText: existing?.error_text ?? null };
  }

  completeCallHandoffAppend(callId: string, acknowledgement: string): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE call_handoff_appends
        SET status = 'appended', acknowledgement = ?, error_text = NULL, updated_at = ?, completed_at = ?
        WHERE call_id = ?
      `)
      .run(acknowledgement, now, now, callId);
  }

  failCallHandoffAppend(callId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(`
        UPDATE call_handoff_appends
        SET status = 'failed', error_text = ?, updated_at = ?
        WHERE call_id = ?
      `)
      .run(message, Date.now(), callId);
  }

  getCallHandoffAppend(callId: string): {
    callId: string;
    promptHash: string;
    status: string;
    acknowledgement: string | null;
    errorText: string | null;
    startedAt: number;
    updatedAt: number;
    completedAt: number | null;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM call_handoff_appends WHERE call_id = ?")
      .get(callId) as {
        call_id: string;
        prompt_hash: string;
        status: string;
        acknowledgement: string | null;
        error_text: string | null;
        started_at: number;
        updated_at: number;
        completed_at: number | null;
      } | undefined;
    return row
      ? {
        callId: row.call_id,
        promptHash: row.prompt_hash,
        status: row.status,
        acknowledgement: row.acknowledgement,
        errorText: row.error_text,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
      }
      : null;
  }

  findUndeliveredArtifactByOriginalPath(options: {
    modality: StoredArtifact["modality"];
    sourcePath: string;
    source?: StoredArtifact["source"];
  }): StoredArtifact | null {
    const rows = this.db
      .prepare(`
        SELECT artifacts.*
        FROM artifacts
        LEFT JOIN artifact_delivery_state ON artifact_delivery_state.artifact_id = artifacts.id
        WHERE modality = ?
          AND delivered_at IS NULL
          AND (? IS NULL OR source = ?)
          AND artifact_delivery_state.quarantined_at IS NULL
        ORDER BY created_at DESC
      `)
      .all(options.modality, options.source ?? null, options.source ?? null) as Array<{
        id: string;
        modality: StoredArtifact["modality"];
        provider_id: StoredArtifact["providerId"];
        source: StoredArtifact["source"];
        path: string;
        mime_type: string;
        file_name: string;
        metadata_json: string;
        created_at: number;
        delivered_at: number | null;
      }>;
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      if (metadata.originalPath !== options.sourcePath) {
        continue;
      }
      if (!existsSync(row.path)) {
        this.deleteArtifacts([row.id]);
        continue;
      }
      return {
        id: row.id,
        modality: row.modality,
        providerId: row.provider_id,
        source: row.source,
        path: row.path,
        mimeType: row.mime_type,
        fileName: row.file_name,
        metadata,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
      };
    }
    return null;
  }

  deleteArtifacts(ids: string[]): void {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return;
    }
    const statement = this.db.prepare("DELETE FROM artifacts WHERE id = ?");
    const deliveryStateStatement = this.db.prepare("DELETE FROM artifact_delivery_state WHERE artifact_id = ?");
    for (const id of uniqueIds) {
      statement.run(id);
      deliveryStateStatement.run(id);
    }
  }

  pruneMissingArtifactRecords(): number {
    const rows = this.db
      .prepare("SELECT id, path FROM artifacts")
      .all() as Array<{ id: string; path: string }>;
    const missingIds = rows
      .filter(row => !existsSync(row.path))
      .map(row => row.id);
    this.deleteArtifacts(missingIds);
    return missingIds.length;
  }

  listArtifactsForCleanup(options?: {
    olderThan?: number;
    deliveredOnly?: boolean;
  }): StoredArtifact[] {
    const olderThan = options?.olderThan ?? 0;
    const deliveredOnly = options?.deliveredOnly ?? false;
    const rows = this.db
      .prepare(`
        SELECT * FROM artifacts
        WHERE created_at <= ?
          AND (? = 0 OR delivered_at IS NOT NULL)
        ORDER BY created_at ASC
      `)
      .all(olderThan, deliveredOnly ? 1 : 0) as Array<{
        id: string;
        modality: StoredArtifact["modality"];
        provider_id: StoredArtifact["providerId"];
        source: StoredArtifact["source"];
        path: string;
        mime_type: string;
        file_name: string;
        metadata_json: string;
        created_at: number;
        delivered_at: number | null;
      }>;
    return rows.map(row => ({
      id: row.id,
      modality: row.modality,
      providerId: row.provider_id,
      source: row.source,
      path: row.path,
      mimeType: row.mime_type,
      fileName: row.file_name,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    }));
  }

  listRecentUndeliveredArtifacts(modality: StoredArtifact["modality"], createdAfter: number): StoredArtifact[] {
    const rows = this.db
      .prepare(`
        SELECT artifacts.* FROM artifacts
        LEFT JOIN artifact_delivery_state ON artifact_delivery_state.artifact_id = artifacts.id
        WHERE modality = ?
          AND delivered_at IS NULL
          AND created_at >= ?
          AND artifact_delivery_state.quarantined_at IS NULL
        ORDER BY created_at ASC
      `)
      .all(modality, createdAfter) as Array<{
        id: string;
        modality: StoredArtifact["modality"];
        provider_id: StoredArtifact["providerId"];
        source: StoredArtifact["source"];
        path: string;
        mime_type: string;
        file_name: string;
        metadata_json: string;
        created_at: number;
        delivered_at: number | null;
      }>;
    const artifacts = rows.map(row => ({
      id: row.id,
      modality: row.modality,
      providerId: row.provider_id,
      source: row.source,
      path: row.path,
      mimeType: row.mime_type,
      fileName: row.file_name,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    }));
    const missingIds = artifacts.filter(artifact => !existsSync(artifact.path)).map(artifact => artifact.id);
    if (missingIds.length > 0) {
      this.deleteArtifacts(missingIds);
    }
    return artifacts.filter(artifact => existsSync(artifact.path));
  }

  setProviderOverride(modality: Modality, providerId: ProviderId): void {
    this.setSetting(`provider_override:${modality}`, providerId);
  }

  getProviderOverride(modality: Modality): ProviderId | null {
    return this.getSetting<ProviderId | null>(`provider_override:${modality}`, null);
  }

  setMode(mode: BridgeMode): void {
    this.setSetting("bridge:mode", mode);
  }

  getMode(fallback: BridgeMode): BridgeMode {
    return this.getSetting<BridgeMode>("bridge:mode", fallback);
  }

  setOwner(owner: BridgeOwner): void {
    this.setSetting("bridge:owner", owner);
  }

  getOwner(fallback: BridgeOwner = "none"): BridgeOwner {
    return this.getSetting<BridgeOwner>("bridge:owner", fallback);
  }

  setSleeping(value: boolean): void {
    this.setSetting("bridge:sleeping", value);
  }

  isSleeping(): boolean {
    return this.getSetting<boolean>("bridge:sleeping", false);
  }

  setBoundThread(thread: BoundThread | null): void {
    this.setSetting("bridge:bound_thread", thread);
    this.setSetting("bridge:bound_thread_id", thread?.threadId ?? null);
    this.setSetting("bridge:bound_cwd", thread?.cwd ?? null);
    this.setSetting("bridge:bound_rollout_path", thread?.rolloutPath ?? null);
    this.setSetting("bridge:bound_source", thread?.source ?? null);
  }

  getBoundThread(): BoundThread | null {
    return this.getSetting<BoundThread | null>("bridge:bound_thread", null);
  }

  setActiveTask(task: ActiveTaskRecord | null): void {
    this.setSetting("bridge:active_task", task);
  }

  getActiveTask(): ActiveTaskRecord | null {
    return this.getSetting<ActiveTaskRecord | null>("bridge:active_task", null);
  }

  markActiveTaskSubmitted(details: { turnId?: string | null; threadId?: string | null }): void {
    const activeTask = this.getActiveTask();
    if (!activeTask) {
      return;
    }
    this.setActiveTask({
      ...activeTask,
      stage: "submitted",
      turnId: details.turnId ?? activeTask.turnId,
      threadId: details.threadId ?? activeTask.threadId,
    });
  }

  markActiveTaskStage(stage: ActiveTaskRecord["stage"]): void {
    const activeTask = this.getActiveTask();
    if (!activeTask) {
      return;
    }
    this.setActiveTask({
      ...activeTask,
      stage,
    });
  }

  setActiveCall(call: ActiveCallRecord | null): void {
    this.setSetting("bridge:active_call", call);
  }

  getActiveCall(): ActiveCallRecord | null {
    return this.getSetting<ActiveCallRecord | null>("bridge:active_call", null);
  }

  setRecentCallSummary(summary: RecentCallSummary | null): void {
    this.setSetting("bridge:recent_call_summary", summary);
  }

  getRecentCallSummary(): RecentCallSummary | null {
    return this.getSetting<RecentCallSummary | null>("bridge:recent_call_summary", null);
  }

  updateRecentCallSummary(
    callId: string,
    updates: Partial<Omit<RecentCallSummary, "callId">>,
  ): RecentCallSummary | null {
    const current = this.getRecentCallSummary();
    if (!current || current.callId !== callId) {
      return null;
    }
    const next: RecentCallSummary = {
      ...current,
      ...updates,
    };
    this.setRecentCallSummary(next);
    return next;
  }

  setGatewayBridgeConnection(state: GatewayBridgeConnectionState): void {
    this.setSetting("bridge:gateway_bridge_connection", state);
  }

  getGatewayBridgeConnection(): GatewayBridgeConnectionState | null {
    return this.getSetting<GatewayBridgeConnectionState | null>("bridge:gateway_bridge_connection", null);
  }

  getCallSurface(defaultTunnelMode: RealtimeTunnelMode = "managed-quick-cloudflared"): RealtimeCallSurfaceRecord {
    const defaults = {
      armed: false,
      armedAt: null,
      armedBy: null,
      expiresAt: null,
      lastActivityAt: null,
      lastPublicProbeAt: null,
      lastPublicProbeReady: null,
      lastPublicProbeDetail: null,
      lastPublicUrl: null,
      lastHealthUrl: null,
      lastLaunchUrl: null,
      lastDisarmReason: null,
      launchTokenId: null,
      launchTokenBridgeId: null,
      launchTokenTelegramUserId: null,
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: null,
      tunnelMode: defaultTunnelMode,
      tunnelPid: null,
      tunnelUrl: null,
      tunnelStartedAt: null,
      recentEvents: [],
    } satisfies RealtimeCallSurfaceRecord;
    const saved = this.getSetting<Partial<RealtimeCallSurfaceRecord> | null>("bridge:call_surface", null);
    return {
      ...defaults,
      ...(saved ?? {}),
    };
  }

  setCallSurface(surface: RealtimeCallSurfaceRecord): void {
    this.setSetting("bridge:call_surface", surface);
  }

  updateCallSurface(
    updates: Partial<RealtimeCallSurfaceRecord>,
    defaultTunnelMode: RealtimeTunnelMode = "managed-quick-cloudflared",
  ): RealtimeCallSurfaceRecord {
    const next = {
      ...this.getCallSurface(defaultTunnelMode),
      ...updates,
    } satisfies RealtimeCallSurfaceRecord;
    this.setCallSurface(next);
    return next;
  }

  setShutdownHint(hint: ShutdownHintRecord | null): void {
    this.setSetting("bridge:shutdown_hint", hint);
  }

  getShutdownHint(): ShutdownHintRecord | null {
    return this.getSetting<ShutdownHintRecord | null>("bridge:shutdown_hint", null);
  }

  consumeShutdownHint(maxAgeMs = 60_000): ShutdownHintRecord | null {
    const hint = this.getShutdownHint();
    if (!hint) {
      return null;
    }
    this.setShutdownHint(null);
    if (Date.now() - hint.requestedAt > maxAgeMs) {
      return null;
    }
    return hint;
  }

  listPendingCallHandoffs(): PendingCallHandoffRecord[] {
    return this.getSetting<PendingCallHandoffRecord[]>("bridge:pending_call_handoffs", []);
  }

  getPendingCallHandoff(callId: string): PendingCallHandoffRecord | null {
    return this.listPendingCallHandoffs().find(record => record.callId === callId) ?? null;
  }

  getPendingCallHandoffCount(): number {
    return this.listPendingCallHandoffs().length;
  }

  upsertPendingCallHandoff(record: PendingCallHandoffRecord): void {
    const records = this.listPendingCallHandoffs();
    const next = records.filter(entry => entry.callId !== record.callId);
    next.push(record);
    next.sort((left, right) => left.createdAt - right.createdAt);
    this.setSetting("bridge:pending_call_handoffs", next);
  }

  updatePendingCallHandoff(callId: string, updates: Partial<Omit<PendingCallHandoffRecord, "callId" | "artifact" | "chatId" | "createdAt">>): PendingCallHandoffRecord | null {
    const records = this.listPendingCallHandoffs();
    const index = records.findIndex(record => record.callId === callId);
    if (index < 0) {
      return null;
    }
    const current = records[index]!;
    const nextRecord: PendingCallHandoffRecord = {
      ...current,
      ...updates,
      updatedAt: updates.updatedAt ?? Date.now(),
    };
    records[index] = nextRecord;
    this.setSetting("bridge:pending_call_handoffs", records);
    return nextRecord;
  }

  resolvePendingCallHandoff(callId: string): void {
    const next = this.listPendingCallHandoffs().filter(record => record.callId !== callId);
    this.setSetting("bridge:pending_call_handoffs", next);
  }

  getRealtimeUsage(timestamp = Date.now()): RealtimeUsage {
    const dayKey = dayKeyFor(timestamp);
    return this.getSetting<RealtimeUsage>(`realtime:usage:${dayKey}`, {
      dayKey,
      callCount: 0,
      totalCallMs: 0,
      lastEndedAt: null,
    });
  }

  recordRealtimeCallUsage(durationMs: number, endedAt = Date.now()): RealtimeUsage {
    const usage = this.getRealtimeUsage(endedAt);
    const next: RealtimeUsage = {
      dayKey: usage.dayKey,
      callCount: usage.callCount + 1,
      totalCallMs: usage.totalCallMs + Math.max(0, Math.trunc(durationMs)),
      lastEndedAt: endedAt,
    };
    this.setSetting(`realtime:usage:${usage.dayKey}`, next);
    return next;
  }

  getRealtimeUsageRecord(callId: string): RealtimeUsageRecord | null {
    return this.getSetting<RealtimeUsageRecord | null>(`realtime:usage_recorded:${callId}`, null);
  }

  recordRealtimeCallUsageOnce(callId: string, durationMs: number, endedAt = Date.now()): { recorded: boolean; usage: RealtimeUsage } {
    const existing = this.getRealtimeUsageRecord(callId);
    if (existing) {
      return {
        recorded: false,
        usage: this.getRealtimeUsage(existing.endedAt),
      };
    }
    const usage = this.recordRealtimeCallUsage(durationMs, endedAt);
    this.setSetting(`realtime:usage_recorded:${callId}`, {
      callId,
      durationMs: Math.max(0, Math.trunc(durationMs)),
      endedAt,
      recordedAt: Date.now(),
    } satisfies RealtimeUsageRecord);
    return { recorded: true, usage };
  }

  enqueueCallInboxItem(item: CallInboxItem): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO call_inbox (
          id, call_id, update_id, chat_id, message_id, kind, text, payload_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.callId,
        item.updateId,
        item.chatId,
        item.messageId,
        item.kind,
        item.text,
        JSON.stringify(item),
        item.status,
        now,
        now,
      );
  }

  updateCallInboxItem(item: CallInboxItem): void {
    this.db
      .prepare(`
        UPDATE call_inbox
        SET text = ?, payload_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(item.text, JSON.stringify(item), item.status, Date.now(), item.id);
  }

  listCallInboxItems(callId: string): CallInboxItem[] {
    const rows = this.db
      .prepare(`
        SELECT payload_json
        FROM call_inbox
        WHERE call_id = ?
        ORDER BY update_id ASC
      `)
      .all(callId) as Array<{ payload_json: string }>;
    return rows.map(row => JSON.parse(row.payload_json) as CallInboxItem);
  }

  getCallInboxCount(callId?: string): number {
    const row = callId
      ? this.db.prepare("SELECT COUNT(*) AS count FROM call_inbox WHERE call_id = ?").get(callId) as { count: number }
      : this.db.prepare("SELECT COUNT(*) AS count FROM call_inbox").get() as { count: number };
    return row.count;
  }

  clearCallInbox(callId: string): void {
    this.db.prepare("DELETE FROM call_inbox WHERE call_id = ?").run(callId);
  }

  deleteCallInboxItem(id: string): void {
    this.db.prepare("DELETE FROM call_inbox WHERE id = ?").run(id);
  }

  getRetentionProtectedPaths(): string[] {
    const rows = this.db
      .prepare(`
        SELECT payload_json
        FROM message_queue
        WHERE status IN ('pending', 'processing', 'failed')
      `)
      .all() as Array<{ payload_json: string }>;
    const taskIds = new Set<string>();
    const paths = new Set<string>();

    for (const row of rows) {
      const task = JSON.parse(row.payload_json) as QueuedTelegramTask;
      taskIds.add(task.id);
      for (const value of [
        task.stagedImagePath,
        task.videoPath,
        task.mediaPreviewPath,
        task.originalMediaPath,
        task.normalizedMediaPath,
        task.documentPath,
        task.transcriptArtifactPath,
      ]) {
        if (value) {
          paths.add(value);
        }
      }
      if (task.kind === "image") {
        paths.add(join(this.storageRoot, "inbound", `${task.id}.jpg`));
      }
      if (task.kind === "voice") {
        paths.add(join(this.storageRoot, "inbound", `${task.id}.ogg`));
        paths.add(join(this.storageRoot, "normalized", `${task.id}.wav`));
      }
      if (task.kind === "audio") {
        paths.add(join(this.storageRoot, "normalized", `${task.id}.wav`));
        const extension = task.mediaFileName?.split(".").pop()
          ?? (task.mediaMimeType?.split("/").pop() || "bin");
        paths.add(join(this.storageRoot, "inbound", `${task.id}.${extension}`));
      }
      if (task.kind === "document") {
        const extension = task.documentFileName?.split(".").pop()
          ?? (task.documentMimeType?.split("/").pop() || "bin");
        paths.add(join(this.storageRoot, "inbound", `${task.id}.${extension}`));
      }
      if (task.kind === "video") {
        const extension = task.videoFileName?.split(".").pop()
          ?? (task.videoMimeType?.split("/").pop() || "mp4");
        paths.add(join(this.storageRoot, "inbound", `${task.id}.${extension}`));
        paths.add(join(this.storageRoot, "inbound", `${task.id}.jpg`));
        paths.add(join(this.storageRoot, "normalized", `${task.id}.wav`));
      }
    }

    const artifactRows = this.db
      .prepare("SELECT path, metadata_json FROM artifacts")
      .all() as Array<{ path: string; metadata_json: string }>;
    for (const row of artifactRows) {
      try {
        const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
        if (typeof metadata.taskId === "string" && taskIds.has(metadata.taskId)) {
          paths.add(row.path);
        }
      } catch {
        continue;
      }
    }

    for (const handoff of this.listPendingCallHandoffs()) {
      paths.add(handoff.artifact.transcriptPath);
      for (const attachment of handoff.artifact.attachments) {
        if (attachment.path) {
          paths.add(attachment.path);
        }
        if (attachment.transcriptPath) {
          paths.add(attachment.transcriptPath);
        }
      }
    }

    const activeCall = this.getActiveCall();
    if (activeCall) {
      for (const value of [
        activeCall.eventPath,
        activeCall.transcriptPath,
        activeCall.statePath,
        activeCall.handoffJsonPath,
        activeCall.handoffMarkdownPath,
        join(this.storageRoot, "calls", activeCall.callId, "gateway-events.ndjson"),
      ]) {
        if (value) {
          paths.add(value);
        }
      }
      for (const item of this.listCallInboxItems(activeCall.callId)) {
      for (const value of [
          item.stagedImagePath,
          item.documentPath,
          item.mediaPath,
          item.videoPath,
          item.mediaPreviewPath,
          item.transcriptPath,
        ]) {
          if (value) {
            paths.add(value);
          }
        }
      }
    }

    return [...paths];
  }
}
