import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { pickerWindow, type EditPreview, type ReviewEdit, type Workspace } from '@/lib/workspace-editor'

interface PendingEdit extends EditPreview { decide: (accepted: boolean) => void }

export function useWorkspaceEditor() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [pending, setPending] = useState<PendingEdit | null>(null)
  const review: ReviewEdit = (preview, signal) => new Promise(resolve => {
    signal.throwIfAborted()
    let settled = false
    const abort = () => decide(false)
    const decide = (accepted: boolean) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      setPending(null)
      resolve(accepted)
    }
    signal.addEventListener('abort', abort, { once: true })
    setPending({ ...preview, decide })
  })
  return { workspace, setWorkspace, pending, review }
}

export function WorkspaceControls({ workspace, onChange, disabled }: {
  workspace: Workspace | null; onChange: (handle: Workspace | null) => void; disabled: boolean
}) {
  const { t } = useI18n()
  const browser = pickerWindow()
  const pick = async (kind: 'file' | 'directory') => {
    try {
      const handle = kind === 'directory'
        ? await browser.showDirectoryPicker!({ mode: 'readwrite' })
        : (await browser.showOpenFilePicker!())[0]
      if (handle) onChange(handle)
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') toast.error(String(err))
    }
  }
  return <fieldset disabled={disabled} className="space-y-1.5">
    <legend className="text-xs font-medium">Claude Text Editor</legend>
    <div className="flex flex-wrap gap-1">
      <Button type="button" size="sm" variant="outline" disabled={!browser.showOpenFilePicker || disabled}
        onClick={() => void pick('file')}>{t('keys.importFiles')}</Button>
      <Button type="button" size="sm" variant="outline" disabled={!browser.showDirectoryPicker || disabled}
        onClick={() => void pick('directory')}>{t('backups.path')}</Button>
      {workspace && <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>{t('common.remove')}</Button>}
    </div>
    {workspace && <div className="break-all font-mono text-xs">{workspace.name}</div>}
    {!browser.showDirectoryPicker && <p className="text-xs text-muted-foreground">Chrome / Edge · HTTPS / localhost</p>}
  </fieldset>
}

export function EditReview({ pending, workspace }: { pending: PendingEdit | null; workspace: Workspace | null }) {
  const { t } = useI18n()
  async function apply() {
    if (!pending) return
    try {
      // A file picker initially grants read access. Request write access while
      // the Apply click still provides transient user activation.
      const handle = workspace as (Workspace & {
        requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>
      }) | null
      const permission = await handle?.requestPermission?.({ mode: 'readwrite' })
      pending.decide(permission === undefined || permission === 'granted')
    } catch (err) {
      toast.error(String(err))
      pending.decide(false)
    }
  }
  return <Dialog open={!!pending} onOpenChange={open => { if (!open) pending?.decide(false) }}>
    {pending && <DialogPopup maxWidth="max-w-3xl">
      <DialogTitle>{t('common.saveChanges')} · {pending.path}</DialogTitle>
      <div className="my-4 max-h-[55vh] overflow-auto rounded border font-mono text-xs">
        {pending.before && <pre className="whitespace-pre-wrap break-all bg-red-500/10 p-3">{'- ' + pending.before.split('\n').join('\n- ')}</pre>}
        <pre className="whitespace-pre-wrap break-all bg-green-500/10 p-3">{'+ ' + pending.after.split('\n').join('\n+ ')}</pre>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => pending.decide(false)}>{t('common.cancel')}</Button>
        <Button onClick={() => void apply()}>{t('common.apply')}</Button>
      </div>
    </DialogPopup>}
  </Dialog>
}
