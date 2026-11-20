import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightSpecialChars,
  drawSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { defaultHighlightStyle, syntaxHighlighting, StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { RefreshCw, Save } from 'lucide-react'
import type { TextDocument } from '../../../../domain/filesystem/types'
import { rpc, errorText } from '../../app/api'
import { Loading, ErrorMessage, Modal } from '../../components/ui'
function language(path: string) {
  const ext = path.split('.').at(-1)?.toLowerCase()
  if (ext === 'json') return json()
  if (ext === 'yaml' || ext === 'yml') return yaml()
  if (ext === 'html' || ext === 'htm') return html()
  if (ext === 'css') return css()
  if (ext === 'xml') return xml()
  if (ext === 'sh' || path.endsWith('.bashrc')) return StreamLanguage.define(shell)
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext!))
    return javascript({ typescript: ext?.startsWith('ts'), jsx: ext?.endsWith('x') })
  return []
}
export function Editor({
  sessionId,
  path,
  onClose,
  onSaved,
  onDirtyChange,
  embedded = false,
  connected = true,
}: {
  sessionId: string
  path: string
  onClose: () => void
  onSaved: () => void
  onDirtyChange?: (dirty: boolean) => void
  embedded?: boolean
  connected?: boolean
}) {
  const [document, setDocument] = useState<TextDocument>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [saveAs, setSaveAs] = useState<string>()
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | undefined>(undefined)
  const saveRef = useRef<() => void>(() => {})
  const draft = useRef<string | undefined>(undefined)
  const loadedDocument = useRef<TextDocument | undefined>(undefined)
  const load = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setDocument(await rpc('files.read', { sessionId, path }))
      setDirty(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let cancelled = false
    void rpc('files.read', { sessionId, path }).then(
      (doc) => {
        if (!cancelled) setDocument(doc)
      },
      (error) => {
        if (!cancelled) setError(errorText(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, path])
  useEffect(() => {
    if (!document || !container.current) return
    if (loadedDocument.current !== document) {
      draft.current = document.content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
      loadedDocument.current = document
    }
    const content = draft.current ?? ''
    const instance = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          syntaxHighlighting(defaultHighlightStyle),
          highlightSelectionMatches(),
          language(path),
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                saveRef.current()
                return true
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged)
              setDirty(
                u.state.doc.toString() !==
                  document.content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n'),
              )
          }),
          EditorState.readOnly.of(readOnly),
          ...(wrap ? [EditorView.lineWrapping] : []),
        ],
      }),
    })
    view.current = instance
    return () => {
      draft.current = instance.state.doc.toString()
      instance.destroy()
      view.current = undefined
    }
  }, [document, path, wrap, readOnly])
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
  const save = async (target = path) => {
    if (!document || !view.current || busy || readOnly || !connected) return
    setBusy(true)
    setError(undefined)
    let content = view.current.state.doc.toString()
    if (document.lineEnding === 'CRLF') content = content.replaceAll('\n', '\r\n')
    if (document.bom) content = '\uFEFF' + content
    try {
      const next = await rpc('files.save', {
        sessionId,
        path: target,
        content,
        identity: target === path ? document.identity : null,
      })
      if (target === path) {
        setDocument(next)
        setDirty(false)
      }
      setSaveAs(undefined)
      onSaved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    saveRef.current = () => {
      void save()
    }
  })
  const close = () => {
    if (!dirty || window.confirm('Discard unsaved changes in this file?')) onClose()
  }
  const content = (
    <>
      {embedded && <div className="editor-path">{path}</div>}
      <div className="editor-toolbar">
        <button
          className="primary"
          disabled={!document || busy || readOnly || !dirty || !connected}
          onClick={() => void save()}
        >
          <Save size={15} />
          Save
        </button>
        <button
          disabled={!document || busy || readOnly || !connected}
          onClick={() => setSaveAs(path + '.copy')}
        >
          Save as…
        </button>
        <button
          disabled={busy || !connected}
          onClick={() => {
            if (!dirty || window.confirm('Reload and discard local changes?')) void load()
          }}
        >
          <RefreshCw size={15} />
          Reload
        </button>
        <label className="checkbox-label">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          Wrap
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Read only
        </label>
      </div>
      {error && <ErrorMessage error={error} />}{' '}
      {!document && !error && <Loading label="Reading UTF-8 file…" />}
      <div ref={container} className="editor-container" />
      <div className="editor-status">
        <span>
          UTF-8 {document?.bom ? 'with BOM' : ''} · {document?.lineEnding}
        </span>
        <span>Ctrl+S Save · Ctrl+F Find · Ctrl+H Replace</span>
        <span>
          {busy ? 'Working…' : dirty ? 'Unsaved changes' : document ? 'Server version loaded' : ''}
        </span>
      </div>
      {saveAs !== undefined && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save(saveAs)
          }}
          className="save-as"
        >
          <label>
            New absolute remote path
            <input required value={saveAs} onChange={(e) => setSaveAs(e.target.value)} />
          </label>
          <button type="button" onClick={() => setSaveAs(undefined)}>
            Cancel
          </button>
          <button disabled={busy || !connected} className="primary">
            Save copy
          </button>
        </form>
      )}
    </>
  )
  return embedded ? (
    <div className="desktop-editor">{content}</div>
  ) : (
    <Modal
      title={`${dirty ? '● ' : ''}${path.split('/').at(-1)}`}
      description={path}
      onClose={close}
      wide
    >
      {content}
    </Modal>
  )
}
