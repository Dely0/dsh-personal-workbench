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

/**
 * 数据库 schema 比当前插件版本新——典型成因是插件被包管理器回退
 * （`dsh plugin add` 是 pnpm 转发器，会按 pnpm-lock.yaml 对齐整个 profile）。
 *
 * 单独成类型是为了让宿主侧能按类型判别并**降级**，而不是把整个 DSH 拖死：
 * 数据库比插件新属于运维常态（版本回退、多机共用 DSH_HOME），
 * 不该等于"宿主拒绝启动"。
 */
export class SchemaTooNewError extends Error {
  readonly dbVersion: number
  readonly supportedVersion: number

  constructor(dbVersion: number, supportedVersion: number) {
    super(`workbench db schema version ${dbVersion} is newer than supported ${supportedVersion}`)
    this.name = 'SchemaTooNewError'
    this.dbVersion = dbVersion
    this.supportedVersion = supportedVersion
  }
}

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  const current = readVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new SchemaTooNewError(current, SCHEMA_VERSION)
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
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  } catch (error) {
    // 迁移失败必须先把连接关掉：否则句柄泄漏，Windows 上文件被占用，
    // 用户连"删库重来"或备份都做不了（降级路径同样会走到这里）。
    try { db.close() } catch { /* 关不掉也不能掩盖原始错误 */ }
    throw error
  }
  return db
}
