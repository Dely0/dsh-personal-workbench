/**
 * 打开/迁移工作台 SQLite 数据库。
 * 运行态数据库默认在 ~/.dsh/workbench/workbench.db。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

export interface WorkbenchDbConfig {
  /** 数据目录；缺省 ~/.dsh/workbench */
  dataDir?: string
  /** 数据库文件绝对路径；优先于 dataDir */
  dbPath?: string
}

export function defaultDbPath(): string {
  return join(homedir(), '.dsh', 'workbench', 'workbench.db')
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  return row === undefined ? 0 : Number(row.value)
}

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  const current = readVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new Error(`workbench db schema version ${current} is newer than supported ${SCHEMA_VERSION}`)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(migration.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export function openWorkbenchDb(config: WorkbenchDbConfig = {}): DatabaseSync {
  const dbPath = config.dbPath ?? join(config.dataDir ?? dirname(defaultDbPath()), 'workbench.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}
