/**
 * 客户端共享常量：面板挂载点与宿主注入钩子的 data-attribute 名。
 * 单独成文件是因为样式（styles.ts）与组件（index.tsx）都要引用同一批名字。
 */

export const PANEL_NAME = 'personal-workbench'
export const ACTIVE_ATTR = 'data-dsh-personal-workbench-active'
export const PENDING_ATTR = 'data-dsh-personal-workbench-pending'
export const VIEW_ATTR = 'data-dsh-personal-workbench-view'
export const ENTRY_ATTR = 'data-dsh-personal-workbench-entry'
export const SIBLING_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
export const ACTIVATE_EVENT = 'dsh-panel-activate'
