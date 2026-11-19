import { executeEditor, type Workspace } from './workspace-editor'

export interface WorkspaceSource { path: string; content: string }

function excerpt(content: string, tasks: boolean) {
  const limit = 2000
  if (content.length <= limit) return content
  const next = tasks ? /^\d+\t\s*[-*]\s+\[ \]/m.exec(content) : null
  if (!next || next.index < limit / 2) return content.slice(0, limit) + '\n…'
  return content.slice(0, 300) + '\n…\n' + content.slice(next.index, next.index + limit - 300) + '\n…'
}

/** Seed a scoped turn with actual disk reads. Never walk the entire project. */
export async function readWorkspaceContext(workspace: Workspace, question: string, signal: AbortSignal) {
  const taskQuestion = /\b(tasks?|todos?|backlog|checklist)\b|công việc|nhiệm vụ|việc tiếp theo/i.test(question)
  const sources: WorkspaceSource[] = []
  const read = async (path: string) => {
    const content = await executeEditor(workspace, { command: 'view', path }, async () => false, signal)
    signal.throwIfAborted()
    sources.push({ path, content: excerpt(content, taskQuestion) })
    return content
  }
  if (workspace.kind === 'file') {
    await read(workspace.name)
    return sources
  }
  const root = (await read('.')).split('\n')
  if (!taskQuestion) return sources

  const paths = root.filter(name => /^(tasks?|todo|backlog)\.(md|txt|json)$/i.test(name))
  if (root.includes('specs/')) {
    const specs = (await read('specs')).split('\n').filter(name => name.endsWith('/'))
    for (const dir of specs.slice(-6).reverse()) paths.push('specs/' + dir + 'tasks.md')
  }
  for (const path of paths.slice(0, 8)) {
    try {
      await read(path)
    } catch (err) {
      if ((err as Error).name !== 'NotFoundError') throw err
    }
  }
  return sources
}
