import { editorTool } from './workspace-editor'

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}

export async function workspaceCompletion(
  body: { messages: unknown[]; model?: string }, workspaceName: string, signal: AbortSignal,
  send: (payload: object) => Promise<Response>,
  execute: (input: Record<string, unknown>) => Promise<string>,
) {
  const messages = [
    { role: 'system', content: 'Selected workspace: ' + JSON.stringify(workspaceName)
      + '. Use the text editor for file requests. Only claim a change after a successful save.' },
    ...body.messages,
  ]
  for (let round = 0; round < 16; round++) {
    signal.throwIfAborted()
    const response = await send({ ...body, messages, tools: [editorTool], stream: false })
    if (!response.ok) return response
    const data = await response.clone().json()
    const choice = data.choices?.[0]
    if (!choice?.message) throw new Error('Invalid response to workspace request.')
    const calls: ToolCall[] = choice.message.tool_calls ?? []
    if (!calls.length && choice.finish_reason !== 'tool_calls') return response
    if (!Array.isArray(calls) || !calls.length || calls.length > 16 || choice.finish_reason !== 'tool_calls'
        || calls.some(c => !c?.id || c.function?.name !== editorTool.function.name
          || typeof c.function.arguments !== 'string')) throw new Error('Incomplete or unsupported file tool call.')
    if (round === 15) throw new Error('Workspace tool limit reached. Send a follow-up to continue.')
    messages.push(choice.message)
    for (const call of calls) {
      signal.throwIfAborted()
      let args
      try { args = JSON.parse(call.function.arguments) } catch { /* returned to the model below */ }
      const content = args && typeof args === 'object' && !Array.isArray(args)
        ? await execute(args)
        : 'Tool error: expected a JSON object.'
      messages.push({ role: 'tool', tool_call_id: call.id, content })
    }
  }
  throw new Error('Workspace tool limit reached.')
}
