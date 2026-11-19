import { MAX_TEXT_BYTES } from './attachments'

export type Workspace = FileSystemFileHandle | FileSystemDirectoryHandle
export interface EditPreview { path: string; before: string; after: string }
export type ReviewEdit = (preview: EditPreview, signal: AbortSignal) => Promise<boolean>

type PickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  showOpenFilePicker?: () => Promise<FileSystemFileHandle[]>
}

export const pickerWindow = () => window as PickerWindow

export const editorTool = {
  type: 'function',
  function: {
    name: 'str_replace_based_edit_tool',
    description: 'View, create, or edit UTF-8 text in the user-selected workspace. Paths are relative. View "." to list the root. Create requires an existing parent. Report only edits confirmed by tool results.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
        view_range: { type: 'array', items: { type: 'integer' }, description: 'Inclusive 1-based lines. End -1 means EOF.' },
        old_str: { type: 'string', description: 'Unique exact text to replace.' },
        new_str: { type: 'string' },
        file_text: { type: 'string', description: 'Initial contents for create.' },
        insert_line: { type: 'integer', description: 'Insert after this line, or 0 for the beginning.' },
        insert_text: { type: 'string' },
      },
      required: ['path', 'command'],
      additionalProperties: false,
    },
  },
}

function field(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error('Expected text in ' + key)
  return value
}

function pathParts(path: string): string[] {
  if (path === '.') return []
  const parts = path.split('/')
  if (parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))) {
    throw new Error('Use a relative path inside the selected workspace.')
  }
  return parts
}

async function readText(handle: FileSystemFileHandle) {
  const file = await handle.getFile()
  if (file.size > MAX_TEXT_BYTES) throw new Error('File exceeds the text editing limit of 128 KB.')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
  if (text.includes('\0')) throw new Error('Expected a UTF-8 text file.')
  return text
}

function viewLines(text: string, range: unknown) {
  const lines = text.split(/\r?\n/)
  const [start, end] = Array.isArray(range) ? range : [1, -1]
  if ((range !== undefined && (!Array.isArray(range) || range.length !== 2))
      || !Number.isInteger(start) || !Number.isInteger(end) || start < 1
      || start > lines.length || (end !== -1 && end < start)) throw new Error('Invalid view_range.')
  return lines.slice(start - 1, end === -1 ? undefined : end)
    .map((line, i) => (start + i) + '\t' + line).join('\n')
}

function editText(before: string, command: string, args: Record<string, unknown>) {
  if (command === 'create') return field(args, 'file_text')
  if (command === 'str_replace') {
    const old = field(args, 'old_str')
    const index = before.indexOf(old)
    if (!old || index < 0 || before.lastIndexOf(old) !== index) throw new Error('old_str must match exactly once.')
    return before.slice(0, index) + field(args, 'new_str') + before.slice(index + old.length)
  }
  const line = args.insert_line
  const newline = before.includes('\r\n') ? '\r\n' : '\n'
  const lines = before ? before.split(newline) : []
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0 || line > lines.length) {
    throw new Error('Invalid insert_line.')
  }
  lines.splice(line, 0, field(args, 'insert_text'))
  return lines.join(newline)
}

export class EditDeclined extends Error {}

export async function executeEditor(
  workspace: Workspace, args: Record<string, unknown>, review: ReviewEdit, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  const command = field(args, 'command')
  const path = field(args, 'path')
  if (!['view', 'create', 'str_replace', 'insert'].includes(command)) throw new Error('Unknown editor command.')
  const parts = pathParts(path)
  const name = parts.pop()
  let directory: FileSystemDirectoryHandle | undefined
  let file: FileSystemFileHandle | undefined
  if (workspace.kind === 'file') {
    if (path === '.' && command === 'view') return workspace.name
    if (path !== workspace.name) throw new Error('Only the selected file is accessible.')
    file = workspace
  } else {
    directory = workspace
    for (const part of parts) directory = await directory.getDirectoryHandle(part)
    if (name) {
      try {
        file = await directory.getFileHandle(name)
      } catch (error) {
        const kind = (error as DOMException).name
        if (kind === 'TypeMismatchError' && command === 'view') directory = await directory.getDirectoryHandle(name)
        else if (kind !== 'NotFoundError' || command !== 'create') throw error
      }
    }
  }
  if (command === 'view') {
    if (file) return viewLines(await readText(file), args.view_range)
    const entries: string[] = []
    for await (const entry of directory!.values()) {
      entries.push(entry.name + (entry.kind === 'directory' ? '/' : ''))
      if (entries.length === 1000) { entries.push('… (listing limit)'); break }
    }
    return entries.sort().join('\n') || '(empty folder)'
  }
  if (!name || (command === 'create' && file)) throw new Error('Select a new filename for create, or edit an existing file.')
  const original = file ? await readText(file) : ''
  const after = editText(original, command, args)
  if (new Blob([after]).size > MAX_TEXT_BYTES || after.includes('\0')) throw new Error('Expected at most 128 KB of text.')
  const before = command === 'str_replace' ? field(args, 'old_str') : original
  const proposed = command === 'str_replace' ? field(args, 'new_str') : after
  signal.throwIfAborted()
  if (!await review({ path, before, after: proposed }, signal)) throw new EditDeclined('Edit declined.')
  signal.throwIfAborted()
  if (!file) {
    // Recheck after review, which may have been open while another app created this path.
    try {
      await directory!.getFileHandle(name)
      throw new Error('The target now exists. Read it before editing.')
    } catch (error) {
      if ((error as DOMException).name !== 'NotFoundError') throw error
    }
    signal.throwIfAborted()
    file = await directory!.getFileHandle(name, { create: true })
  }
  const writer = await file.createWritable({ mode: 'exclusive' } as FileSystemCreateWritableOptions)
  try {
    if (await readText(file) !== original) throw new Error('File changed during review. Read it again.')
    signal.throwIfAborted()
    await writer.write(after)
    signal.throwIfAborted()
    await writer.close()
  } catch (error) {
    await writer.abort().catch(() => {})
    throw error
  }
  return 'Saved ' + path
}
