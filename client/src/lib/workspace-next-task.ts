import { executeEditor, type Workspace } from './workspace-editor'

export interface NextTaskRequest { path?: string; vi: boolean }

// Limit the shortcut to simple lookups. Compound instructions ("implement the
// next task") and general questions about Spec Kit still use normal chat.
export function nextTaskRequest(text: string, locale: string): NextTaskRequest | null {
  const command = /^\/next-task(?:\s+([^\n]+))?$/i.exec(text.trim())
  if (command) return { path: command[1]?.trim(), vi: locale.startsWith('vi') }
  const q = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd')
  const request = q.replace(/^\s*(?:doc|read) (?:the )?(?:file )?checklist(?: spec[- ]?kit)?[.,:!?\s]+/, '')
    .replace(/[.!?]\s*(?:cho toi|kem|include|give me) (?:ma task|the task id|task id)(?:[\s,/]*(?:va|and)?\s*(?:duong dan|so dong|path|line number|line))*[.!?]?\s*$/, '')
    .trim().replace(/[?!.]+$/, '').trim()
  if (/^(?:(?:cho toi biet|tim) )?(?:task|cong viec|nhiem vu) (?:dau tien chua (?:hoan thanh|xong)|tiep theo)(?: (?:cua|trong) (?:folder|thu muc|project|repo|checklist)(?: nay| do| spec[- ]?kit)?)?(?: la gi)?$/.test(request)) return { vi: true }
  if (/^(?:(?:what is|what's|show me|find) (?:the )?)?(?:first (?:unchecked|incomplete|unfinished|open)|next(?: unchecked| unfinished)?) task(?: in (?:this|the) (?:folder|workspace|project|checklist))?$/.test(request)) return { vi: false }
  return null
}

async function taskPaths(root: FileSystemDirectoryHandle, signal: AbortSignal) {
  const paths: string[] = []
  async function scan(dir: FileSystemDirectoryHandle, prefix: string, depth: number) {
    for await (const entry of dir.values()) {
      signal.throwIfAborted()
      if (entry.name.startsWith('.')) continue
      const path = prefix + entry.name
      if (entry.kind === 'file') {
        const namedList = /^(tasks?|checklist|todo|backlog)\.(md|txt)$/i.test(entry.name)
        const inTaskDir = /^(?:docs\/tasks\/|specs\/[^/]+\/checklists\/)/.test(path)
          || (depth === 0 && /^(tasks|checklists)$/i.test(root.name))
        const taskDoc = inTaskDir && /\.md$/i.test(entry.name)
        if (namedList || taskDoc) paths.push(path)
      } else if (depth < 3 && /^(?:docs|docs\/tasks|specs|specs\/[^/]+|specs\/[^/]+\/checklists)$/.test(path)) {
        await scan(entry, path + '/', depth + 1)
      }
    }
  }
  await scan(root, '', 0)
  return paths.sort()
}

// Ignore illustrative checkboxes inside fenced examples and HTML comments.
function firstOpenTask(numbered: string) {
  let fence = ''
  let comment = false
  for (const row of numbered.split('\n')) {
    const split = row.indexOf('\t')
    const line = row.slice(split + 1)
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
      continue
    }
    if (comment) {
      if (line.includes('-->')) comment = false
      continue
    }
    if (marker) { fence = marker[1]; continue }
    const visible = line.replace(/<!--[\s\S]*?-->/g, '')
    const start = visible.indexOf('<!--')
    if (start >= 0) comment = true
    const match = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+?)\s*$/.exec(start < 0 ? visible : visible.slice(0, start))
    if (match) return { line: row.slice(0, split), task: match[1] }
  }
}

function literal(text: string) {
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(1 + runs.reduce((n, run) => Math.max(n, run.length), 0))
  return fence + ' ' + text + ' ' + fence
}

export async function lookupNextTask(workspace: Workspace, request: NextTaskRequest, signal: AbortSignal) {
  const vi = request.vi
  const paths = request.path ? [request.path] : workspace.kind === 'file' ? [workspace.name] : await taskPaths(workspace, signal)
  if (!paths.length) return vi
    ? 'Chưa tìm thấy checklist trong các thư mục đã dò. Dùng /next-task kèm đường dẫn file trong project.'
    : 'No checklist found in the scanned folders. Use /next-task followed by a project-relative file path.'
  const rows: string[] = []
  const scanned: string[] = []
  const failed: string[] = []
  for (const path of paths.slice(0, 100)) {
    signal.throwIfAborted()
    try {
      const content = await executeEditor(workspace, { command: 'view', path }, async () => false, signal)
      signal.throwIfAborted()
      if (!/^1\t/.test(content)) throw new Error(vi ? 'Hãy chọn một file.' : 'Select a file.')
      const hit = firstOpenTask(content)
      scanned.push(path)
      if (hit) rows.push('- ' + literal(path + ':' + hit.line) + ' — ' + literal(hit.task))
    } catch (err) {
      signal.throwIfAborted()
      failed.push(literal(path) + ' — ' + literal(err instanceof Error ? err.message : String(err)))
    }
  }
  const answer = rows.length ? [
    vi ? 'Mục chưa đánh dấu đầu tiên trong từng file:' : 'First unchecked item in each file:',
    rows.join('\n'),
  ] : [vi ? 'Chưa tìm thấy checkbox mở trong các file đã đọc.' : 'No unchecked item found in the files read.']
  if (paths.length > 100) answer.push(vi ? 'Đã giới hạn ở 100 file. Dùng /next-task kèm đường dẫn để chọn file.' : 'Limited to 100 files. Use /next-task with a path to choose a file.')
  if (failed.length) answer.push((vi ? 'Lỗi đọc file' : 'File read errors') + '\n\n' + failed.join('\n'))
  if (scanned.length) answer.push(scanned.map(p => '📖 ' + literal(p)).join('  \n'))
  return answer.join('\n\n')
}
