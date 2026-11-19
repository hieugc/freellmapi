import { expect, it } from 'vitest'
import { lookupNextTask, nextTaskRequest } from './workspace-next-task'
import { readWorkspaceContext } from './workspace-context'

function file(name: string, content: string) {
  return { kind: 'file' as const, name, getFile: async () => new File([content], name) }
}

function directory(name: string, children: Array<ReturnType<typeof file> | FileSystemDirectoryHandle>) {
  const get = (key: string, kind: string) => {
    const item = children.find(entry => entry.name === key)
    if (!item) throw new DOMException('missing', 'NotFoundError')
    if (item.kind !== kind) throw new DOMException('wrong kind', 'TypeMismatchError')
    return item
  }
  return { name, kind: 'directory', async *values() { yield* children },
    getDirectoryHandle: async (key: string) => get(key, 'directory'),
    getFileHandle: async (key: string) => get(key, 'file'),
  } as unknown as FileSystemDirectoryHandle
}

const signal = new AbortController().signal
it('reads numbered task evidence, including the first unchecked item beyond the preview', async () => {
  const done = '- [x] T001 completed\n'.repeat(200)
  const specs = directory('specs', [directory('002-auth', [
    file('tasks.md', done + '- [ ] T209 Persist workspace permissions'),
  ]), directory('003-empty', [])])
  const root = directory('project', [specs, file('TODO.md', '- [ ] Release test'), file('private.txt', 'private value')])
  const sources = await readWorkspaceContext(root, 'task tiếp theo của folder đó là gì?', signal)
  expect(sources.map(source => source.path)).toEqual(['.', 'specs', 'TODO.md', 'specs/002-auth/tasks.md'])
  expect(sources.at(-1)?.content).toContain('201\t- [ ] T209')
  expect(JSON.stringify(sources)).not.toContain('private value')
  expect((await readWorkspaceContext(root, 'List files', signal)).map(s => s.path)).toEqual(['.'])
})

it('reads the selected file again for every turn', async () => {
  let current = 'first'
  const handle = { name: 'note.txt', kind: 'file', getFile: async () => new File([current], 'note.txt') } as FileSystemFileHandle
  expect(await readWorkspaceContext(handle, 'What does this say?', signal)).toEqual([{ path: 'note.txt', content: '1\tfirst' }])
  current = 'updated'
  expect((await readWorkspaceContext(handle, 'and now?', signal))[0].content).toBe('1\tupdated')
})

it('recognizes the reported lookup and leaves implementation or public documentation questions in chat', () => {
  const text = 'Đọc checklist Spec-Kit. Task đầu tiên chưa hoàn thành là gì? Cho tôi mã task, đường dẫn và số dòng.'
  expect(nextTaskRequest(text, 'en')).toEqual({ vi: true })
  expect(nextTaskRequest('task tiếp theo của folder đó là gì?', 'vi')).toEqual({ vi: true })
  expect(nextTaskRequest('/next-task docs/tasks/phase one.md', 'vi')).toEqual({ vi: true, path: 'docs/tasks/phase one.md' })
  expect(nextTaskRequest('Implement the next task', 'en')).toBeNull()
  expect(nextTaskRequest('Find the next task in the GitHub Spec Kit docs', 'en')).toBeNull()
  expect(nextTaskRequest(text + ' Rồi thực hiện nó.', 'vi')).toBeNull()
})

it('returns the exact first unchecked row per local file and skips examples and closed tasks', async () => {
  const data = ['# Phase', '```md', '- [ ] EXAMPLE', '```', '<!--', '- [ ] HIDDEN', '-->',
    '- [X] T001 old', '  - [ ] T002 first real task', '- [ ] T003 later'].join('\n')
  const root = directory('repo', [
    directory('docs', [directory('tasks', [file('phase.md', data)])]),
    directory('specs', [directory('001-app', [file('tasks.md', '- [ ] T004 Build')])]),
    directory('templates', [file('checklist.md', '- [ ] template example')]),
  ])
  const all = await lookupNextTask(root, { vi: true }, signal)
  expect(all).toContain('docs/tasks/phase.md:9')
  expect(all).toContain('T002 first real task')
  expect(all).toContain('specs/001-app/tasks.md:1')
  expect(all).not.toMatch(/EXAMPLE|HIDDEN|T003|template example/)
  const single = await lookupNextTask(root, { vi: true, path: 'docs/tasks/phase.md' }, signal)
  expect(single).not.toContain('T004')
  expect(await lookupNextTask(root, { vi: true, path: '../other.md' }, signal)).toContain('Lỗi đọc file')
})

it('reports an empty or completed checklist without inventing a task', async () => {
  expect(await lookupNextTask(directory('empty', []), { vi: true }, signal)).toContain('Chưa tìm thấy checklist')
  expect(await lookupNextTask(directory('done', [file('tasks.md', '- [x] T001')]), { vi: true }, signal))
    .toContain('Chưa tìm thấy checkbox mở')
})
