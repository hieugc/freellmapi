// @vitest-environment jsdom
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import PlaygroundPage from './PlaygroundPage'

it('selects a folder and saves a reviewed tool call to disk from the Playground composer', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  window.matchMedia ??= vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} })
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  const temp = await mkdtemp(join(tmpdir(), 'playground-editor-'))
  const path = join(temp, 'note.txt')
  await writeFile(path, 'before')
  const folder = {
    kind: 'directory', name: 'project',
    getFileHandle: async (name: string) => {
      expect(name).toBe('note.txt')
      return {
        kind: 'file', name,
        getFile: async () => {
          const bytes = await readFile(path)
          return { size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }
        },
        createWritable: async () => {
          let contents = ''
          return { write: (value: string) => { contents = value }, close: () => writeFile(path, contents) }
        },
      }
    },
  }
  vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(folder))
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!
  let turns = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/api/conversations')) return Response.json({ id: 42, title: 'Edit' })
    expect(url).toBe('/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.stream).toBe(false)
    if (++turns === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function', function: {
        name: body.tools[0].function.name,
        arguments: JSON.stringify({ command: 'str_replace', path: 'note.txt', old_str: 'before', new_str: 'after' }),
      } }],
    } }] })
    expect(body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'one', content: 'Saved note.txt' })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Finished.' } }] })
  }))
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en"><PlaygroundPage /></I18nProvider>
    </QueryClientProvider>))
    await act(async () => button('Folder').click())
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="liquid-composer"] textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Edit note.txt')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await vi.waitFor(() => expect(button('Apply')).toBeTruthy())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('+ after')
    expect(await readFile(path, 'utf8')).toBe('before')
    await act(async () => button('Apply').click())
    await act(async () => { await vi.waitFor(() => expect(turns).toBe(2)) })
    expect(container.textContent).toContain('✓ note.txt')
    expect(await readFile(path, 'utf8')).toBe('after')
  } finally {
    act(() => root.unmount())
    container.remove()
    queryClient.clear()
    vi.unstubAllGlobals()
    localStorage.clear()
    await rm(temp, { recursive: true, force: true })
  }
})
