/**
 * dsh-personal-workbench DB schema（对应 docs/DSH个人工作台/01_数据模型.md）
 * 迁移只前向；所有“枚举”都走 dictionaries 表。
 */
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 15

export interface Migration {
  version: number
  name: string
  up(db: DatabaseSync): void
}

const V1_DDL = `
CREATE TABLE dictionaries (
  kind       TEXT NOT NULL,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  builtin    INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, code)
) STRICT;

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  parent_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  type_code         TEXT NOT NULL,
  status_code       TEXT NOT NULL,
  priority_code     TEXT NOT NULL,
  ai_policy_code    TEXT NOT NULL DEFAULT 'consult',
  due_at            TEXT,
  all_day           INTEGER NOT NULL DEFAULT 0,
  estimated_minutes INTEGER,
  source            TEXT NOT NULL DEFAULT 'manual',
  archived          INTEGER NOT NULL DEFAULT 0,
  extra             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  cancelled_at      TEXT
) STRICT;

CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_due ON tasks(due_at);
CREATE INDEX idx_tasks_status ON tasks(status_code);
CREATE INDEX idx_tasks_type ON tasks(type_code);
CREATE INDEX idx_tasks_priority ON tasks(priority_code);

CREATE TABLE task_reminders (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL,
  method_code    TEXT NOT NULL DEFAULT 'browser',
  enabled        INTEGER NOT NULL DEFAULT 1,
  fired_at       TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_reminders_task ON task_reminders(task_id);

CREATE TABLE task_drafts (
  id           TEXT PRIMARY KEY,
  kind_code    TEXT NOT NULL DEFAULT 'task',
  session_id   TEXT,
  payload_json TEXT NOT NULL,
  status_code  TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_drafts_session ON task_drafts(session_id);
CREATE INDEX idx_task_drafts_status ON task_drafts(status_code);

CREATE TABLE task_sessions (
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,
  role_code        TEXT NOT NULL,
  workspace        TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL,
  last_activity_at TEXT,
  PRIMARY KEY (task_id, session_id, role_code)
) STRICT;

CREATE INDEX idx_task_sessions_session ON task_sessions(session_id);

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_code  TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  actor       TEXT NOT NULL DEFAULT 'user',
  note        TEXT,
  at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_events_task ON task_events(task_id, at);

-- V2 预留表：复盘与产出物（先建表，UI 后续接）
CREATE TABLE task_reviews (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id   TEXT,
  summary_md   TEXT NOT NULL,
  lessons_json TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE task_artifacts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id    TEXT,
  kind_code     TEXT NOT NULL,
  title         TEXT NOT NULL,
  path          TEXT NOT NULL,
  category_code TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
) STRICT;
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(V1_DDL)
    },
  },
  {
    version: 2,
    name: 'task-workspace-path',
    up(db) {
      db.exec('ALTER TABLE tasks ADD COLUMN workspace_path TEXT')
    },
  },
  {
    version: 3,
    name: 'daily-plans',
    up(db) {
      db.exec(`
        CREATE TABLE daily_plans (
          id          TEXT PRIMARY KEY,
          plan_date   TEXT NOT NULL UNIQUE,
          summary     TEXT NOT NULL DEFAULT '',
          items_json  TEXT NOT NULL DEFAULT '[]',
          source_code TEXT NOT NULL DEFAULT 'ai',
          session_id  TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
  {
    version: 4,
    name: 'task-reports',
    up(db) {
      db.exec(`
        CREATE TABLE task_reports (
          id           TEXT PRIMARY KEY,
          period_code  TEXT NOT NULL,
          period_start TEXT NOT NULL,
          title        TEXT NOT NULL,
          summary_md   TEXT NOT NULL,
          stats_json   TEXT NOT NULL DEFAULT '{}',
          session_id   TEXT,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          UNIQUE (period_code, period_start)
        ) STRICT;
        CREATE INDEX idx_task_reports_period ON task_reports(period_code, period_start DESC);
      `)
    },
  },
  {
    version: 5,
    name: 'ai-session-registry',
    up(db) {
      db.exec(`
        CREATE TABLE ai_session_registry (
          scope_code       TEXT NOT NULL,
          anchor           TEXT NOT NULL,
          session_id       TEXT NOT NULL,
          workspace        TEXT,
          note             TEXT,
          created_at       TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          PRIMARY KEY (scope_code, anchor)
        ) STRICT;
        CREATE INDEX idx_ai_session_registry_session ON ai_session_registry(session_id);
      `)
    },
  },
  {
    version: 6,
    name: 'recurring-tasks',
    up(db) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN recurrence_code TEXT;
        ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE tasks ADD COLUMN recurrence_master_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
        ALTER TABLE tasks ADD COLUMN recurrence_last_generated TEXT;
        CREATE INDEX idx_tasks_recurrence_master ON tasks(recurrence_master_id);
        CREATE INDEX idx_tasks_recurrence_code ON tasks(recurrence_code);
      `)
    },
  },
  {
    version: 7,
    name: 'knowledge-base',
    up(db) {
      db.exec(`
        CREATE TABLE knowledge_entries (
          id               TEXT PRIMARY KEY,
          kind_code        TEXT NOT NULL DEFAULT 'note',
          title            TEXT NOT NULL,
          content_md       TEXT NOT NULL DEFAULT '',
          tags_json        TEXT NOT NULL DEFAULT '[]',
          source_task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_knowledge_kind ON knowledge_entries(kind_code, updated_at DESC);
        CREATE INDEX idx_knowledge_source ON knowledge_entries(source_task_id);
      `)
    },
  },
  {
    version: 8,
    name: 'ideas-and-clusters',
    up(db) {
      db.exec(`
        CREATE TABLE ideas (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          content_md       TEXT NOT NULL DEFAULT '',
          kind_code        TEXT NOT NULL DEFAULT 'spark',
          tags_json        TEXT NOT NULL DEFAULT '[]',
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_ideas_kind ON ideas(kind_code, updated_at DESC);

        CREATE TABLE idea_clusters (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          summary_md TEXT NOT NULL DEFAULT '',
          tags_json  TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE idea_links (
          cluster_id TEXT NOT NULL REFERENCES idea_clusters(id) ON DELETE CASCADE,
          idea_id    TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
          note       TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (cluster_id, idea_id)
        ) STRICT;
        CREATE INDEX idx_idea_links_idea ON idea_links(idea_id);
      `)
    },
  },
  {
    version: 9,
    name: 'knowledge-source-review',
    up(db) {
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN source_review_id TEXT')
    },
  },
  {
    version: 10,
    name: 'task-shared-memory',
    up(db) {
      db.exec(`
        CREATE TABLE task_memories (
          id               TEXT PRIMARY KEY,
          root_task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind             TEXT NOT NULL DEFAULT 'note',
          content          TEXT NOT NULL,
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_task_memories_root ON task_memories(root_task_id, updated_at DESC);
        CREATE INDEX idx_task_memories_task ON task_memories(task_id, updated_at DESC);
      `)
    },
  },
  {
    version: 11,
    name: 'knowledge-file-link',
    up(db) {
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN file_link TEXT')
    },
  },
  {
    version: 12,
    name: 'reminder-queue',
    up(db) {
      // 微信提醒的待发队列：host 侧调度器把"暂时发不出去"的提醒落库，重启不丢。
      // 不存 botId/targetId —— 目标在发送时解析，用户换投递目标后旧队列自动跟新目标。
      db.exec(`
        CREATE TABLE reminder_queue (
          id              TEXT PRIMARY KEY,
          reminder_id     TEXT,
          root_task_id    TEXT NOT NULL,
          task_id         TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          priority_code   TEXT NOT NULL,
          due_at          TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error      TEXT,
          created_at      TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_reminder_queue_next ON reminder_queue(next_attempt_at, created_at);
        CREATE INDEX idx_reminder_queue_root ON reminder_queue(root_task_id, created_at DESC);
      `)
    },
  },
  {
    version: 13,
    name: 'draft-defer-and-notify',
    up(db) {
      // 验收「暂存」：草稿仍是 pending（确认/驳回两条老路径不变），
      // 只用一个标记让"自动弹窗"那条查询跳过它 —— 用户可以先去跑回归测试，再手动唤回。
      db.exec('ALTER TABLE task_drafts ADD COLUMN deferred_at TEXT')
      db.exec('ALTER TABLE task_drafts ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0')
      // 草稿通知去重：非空表示该草稿已经进过通知队列，不再重复推送。
      db.exec('ALTER TABLE task_drafts ADD COLUMN notified_at TEXT')
    },
  },
  {
    version: 14,
    name: 'draft-notify-queue',
    up(db) {
      // 草稿通知的待发队列（静默时段/汇总/节流导致的延后投递）。
      // 与 reminder_queue 分开：那边是"任务到期提醒"，字段与幂等键都不同。
      db.exec(`
        CREATE TABLE draft_notify_queue (
          id              TEXT PRIMARY KEY,
          draft_id        TEXT NOT NULL UNIQUE,
          kind_code       TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          priority_code   TEXT NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error      TEXT,
          created_at      TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_draft_notify_next ON draft_notify_queue(next_attempt_at, created_at);
      `)
    },
  },
  {
    version: 15,
    name: 'reminder-status-semantics',
    up(db) {
      // 拆开原先由 fired_at 一肩挑的三种语义（历史事故：一条提醒永久停在「待处理」）：
      //   fired_at        —— 已送达/已入队（调度器与队列的幂等键，语义不变）
      //   skipped_at      —— 已判定"太旧"而放弃：终态，不再参与 /reminders/due
      //   acknowledged_at —— 用户点了「知道了」：终态，但可重置
      db.exec('ALTER TABLE task_reminders ADD COLUMN skipped_at TEXT')
      db.exec('ALTER TABLE task_reminders ADD COLUMN acknowledged_at TEXT')
    },
  },
]
