import { expect, it, vi } from 'vitest'
import { workspaceCompletion } from './workspace-chat'
import { editorTool, executeEditor } from './workspace-editor'

const signal = new AbortController().signal
const allow = async () => true

function disk(initial: string) {
  let content = initial
  const handle = {
    name: 'note.txt', kind: 'file',
    getFile: async () => new File([content], 'note.txt'),
    createWritable: async () => {
      let next = ''
      return { write: async (s: string) => { next = s }, close: async () => { content = next }, abort: async () => {} }
    },
  } as unknown as FileSystemFileHandle
  return { handle, read: () => content, change: (text: string) => { content = text } }
}

it('calls the editor through the completion loop and returns the save result to the model', async () => {
  const file = disk('alpha beta')
  const request = { command: 'str_replace', path: 'note.txt', old_str: 'alpha', new_str: '$& gamma' }
  const send = vi.fn()
    .mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'edit1', type: 'function',
        function: { name: editorTool.function.name, arguments: JSON.stringify(request) } }],
    } }] }))
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }] }))
  const review = vi.fn(allow)
  const result = await workspaceCompletion({ model: 'auto', messages: [] }, file.handle.name, signal, send,
    args => executeEditor(file.handle, args, review, signal))
  expect(file.read()).toBe('$& gamma beta')
  expect(review).toHaveBeenCalledWith({ path: 'note.txt', before: 'alpha', after: '$& gamma' }, signal)
  expect(send.mock.calls[1][0].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'edit1', content: 'Saved note.txt' })
  expect((await result.json()).choices[0].message.content).toBe('Done')
})

it.each(['../note.txt', '/note.txt', 'C:\\note.txt', 'other.txt'])('rejects access outside the selected file: %s', async path => {
  await expect(executeEditor(disk('x').handle, { command: 'view', path }, allow, signal)).rejects.toThrow()
})

it('keeps a concurrent edit and writes nothing after a declined review', async () => {
  const file = disk('a')
  const args = { command: 'insert', path: file.handle.name, insert_line: 1, insert_text: 'b' }
  await expect(executeEditor(file.handle, args, async () => false, signal)).rejects.toThrow('declined')
  expect(file.read()).toBe('a')
  await expect(executeEditor(file.handle, args, async () => {
    file.change('edited elsewhere')
    return true
  }, signal)).rejects.toThrow('changed')
  expect(file.read()).toBe('edited elsewhere')
})

it('preserves CRLF and views only the requested lines', async () => {
  const file = disk('one\r\nthree\r\n')
  await executeEditor(file.handle, { command: 'insert', path: file.handle.name, insert_line: 1, insert_text: 'two' }, allow, signal)
  expect(file.read()).toBe('one\r\ntwo\r\nthree\r\n')
  expect(await executeEditor(file.handle, { command: 'view', path: file.handle.name, view_range: [2, 3] }, allow, signal))
    .toBe('2\ttwo\n3\tthree')
})

it('rejects duplicate matches, existing create targets and truncated tool calls', async () => {
  const file = disk('x x')
  const review = vi.fn(allow)
  await expect(executeEditor(file.handle, { command: 'str_replace', path: file.handle.name, old_str: 'x', new_str: 'z' }, review, signal))
    .rejects.toThrow('exactly once')
  await expect(executeEditor(file.handle, { command: 'create', path: file.handle.name, file_text: 'z' }, review, signal))
    .rejects.toThrow()
  const execute = vi.fn()
  await expect(workspaceCompletion({ messages: [] }, 'tmp', signal, async () => Response.json({
    choices: [{ finish_reason: 'length', message: { tool_calls: [{}] } }],
  }), execute)).rejects.toThrow('Incomplete')
  expect(execute).not.toHaveBeenCalled()
  expect(review).not.toHaveBeenCalled()
})

it('creates a file in an existing subfolder only after review and protects a new competing file', async () => {
  const created = disk('')
  let exists = false
  const child = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      expect(name).toBe('note.txt')
      if (options?.create) exists = true
      if (!exists) throw new DOMException('Missing', 'NotFoundError')
      return created.handle
    },
  }
  const root = { kind: 'directory', getDirectoryHandle: async (name: string) => {
    expect(name).toBe('docs')
    return child
  } } as unknown as FileSystemDirectoryHandle
  const args = { command: 'create', path: 'docs/note.txt', file_text: 'new' }
  await expect(executeEditor(root, args, async () => false, signal)).rejects.toThrow('declined')
  expect(exists).toBe(false)
  await executeEditor(root, args, allow, signal)
  expect(created.read()).toBe('new')
  exists = false
  await expect(executeEditor(root, args, async () => {
    exists = true
    created.change('other writer')
    return true
  }, signal)).rejects.toThrow('now exists')
  expect(created.read()).toBe('other writer')
})
