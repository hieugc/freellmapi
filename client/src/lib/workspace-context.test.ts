import { expect, it } from 'vitest'
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
