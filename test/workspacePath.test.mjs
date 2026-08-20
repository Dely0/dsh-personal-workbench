import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isWslStylePath,
  joinPath,
  normalizeWindowsPathToWsl,
} from '../lib/client/workspacePath.js'

test('workspacePath: converts Windows drive paths to WSL /mnt paths', () => {
  assert.equal(normalizeWindowsPathToWsl('D:\\Code'), '/mnt/d/Code')
  assert.equal(normalizeWindowsPathToWsl('D:/Code'), '/mnt/d/Code')
  assert.equal(normalizeWindowsPathToWsl('D:\\Code\\AI-Workspace'), '/mnt/d/Code/AI-Workspace')
  assert.equal(normalizeWindowsPathToWsl('d:\\Code'), '/mnt/d/Code')
  assert.equal(normalizeWindowsPathToWsl('C:\\Users\\Me\\Project'), '/mnt/c/Users/Me/Project')
})

test('workspacePath: keeps drive letter lowercased and preserves rest case', () => {
  assert.equal(normalizeWindowsPathToWsl('D:\\MyProject\\Sub'), '/mnt/d/MyProject/Sub')
  assert.equal(normalizeWindowsPathToWsl('d:\\myproject\\sub'), '/mnt/d/myproject/sub')
})

test('workspacePath: does not convert relative or already-WSL paths', () => {
  assert.equal(normalizeWindowsPathToWsl('Code'), 'Code')
  assert.equal(normalizeWindowsPathToWsl('./Code'), './Code')
  assert.equal(normalizeWindowsPathToWsl('../Code'), '../Code')
  assert.equal(normalizeWindowsPathToWsl('/mnt/d/Code'), '/mnt/d/Code')
  assert.equal(normalizeWindowsPathToWsl('/home/user/code'), '/home/user/code')
  assert.equal(normalizeWindowsPathToWsl(''), '')
})

test('workspacePath: handles bare drive and trailing separators', () => {
  assert.equal(normalizeWindowsPathToWsl('D:'), '/mnt/d')
  assert.equal(normalizeWindowsPathToWsl('D:\\'), '/mnt/d')
  assert.equal(normalizeWindowsPathToWsl('D:\\Code\\'), '/mnt/d/Code/')
})

test('workspacePath: joinPath uses forward slashes in WSL and handles mixed input', () => {
  assert.equal(joinPath('D:\\Code', 'Folder'), 'D:/Code/Folder')
  assert.equal(joinPath('/mnt/d/Code', 'Folder'), '/mnt/d/Code/Folder')
  assert.equal(joinPath('Code/', 'Folder'), 'Code/Folder')
  assert.equal(joinPath('Code', '/Folder/'), 'Code/Folder')
})

test('workspacePath: joinPath can use Windows backslash separator for native hosts', () => {
  assert.equal(joinPath('D:\\Code', 'Folder', '\\'), 'D:\\Code\\Folder')
  assert.equal(joinPath('D:/Code', 'Folder', '\\'), 'D:\\Code\\Folder')
  assert.equal(joinPath('Code/', 'Folder', '\\'), 'Code\\Folder')
})

test('workspacePath: isWslStylePath distinguishes POSIX/WSL paths from Windows drive paths', () => {
  assert.equal(isWslStylePath('/mnt/d/Code'), true)
  assert.equal(isWslStylePath('/home/user/code'), true)
  assert.equal(isWslStylePath('D:\\Code'), false)
  assert.equal(isWslStylePath('D:/Code'), false)
  assert.equal(isWslStylePath('Code'), false)
})
