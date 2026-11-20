import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { SessionManager } from '../src/application/connection/session-manager'
import { FileOperations } from '../src/application/filesystem/file-operations'
import { TransferManager } from '../src/application/transfers/transfer-manager'
import { TerminalManager } from '../src/application/terminal/terminal-manager'
import { sftpCall } from '../src/infrastructure/sftp/remote-fs'

export async function runExtraChecks(
  sessions: SessionManager,
  id: string,
  root: string,
  local: string,
  pass: (message: string) => void,
): Promise<void> {
  const fs = new FileOperations(sessions, async () => false).fs(id)
  const queues: TransferManager[] = []
  const queue = () => {
    const manager = new TransferManager(
      sessions,
      () => {},
      async () => {
        throw new Error('Unexpected conflict decision')
      },
    )
    queues.push(manager)
    return manager
  }
  const settle = async (manager: TransferManager) => {
    const deadline = Date.now() + 90000
    while (manager.list().some((j) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status))) {
      if (Date.now() > deadline) throw new Error('Extended transfer check timed out')
      await new Promise((r) => setTimeout(r, 100))
    }
    const jobs = manager.list()
    assert.equal(
      jobs.some((j) => j.status === 'FAILED'),
      false,
      'An extended transfer failed',
    )
    return jobs
  }
  try {
    const unusual = posix.join(root, "quotes ' ; $name 日本語.txt")
    await fs.save(unusual, 'literal filename\n', null)
    await fs.mkdir(posix.join(root, 'quoted-copy'))
    await new FileOperations(sessions, async () => false).copy(
      id,
      [unusual],
      posix.join(root, 'quoted-copy'),
    )
    assert.equal(
      (await fs.text(posix.join(root, 'quoted-copy', posix.basename(unusual)))).content,
      'literal filename\n',
    )
    pass('Unicode, quotes and shell punctuation remain literal filename data')

    const encoded = await fs.save(posix.join(root, 'bom-crlf.txt'), '\uFEFFone\r\ntwo\r\n', null)
    assert.equal(encoded.bom, true)
    assert.equal(encoded.lineEnding, 'CRLF')
    assert.equal(encoded.content, '\uFEFFone\r\ntwo\r\n')
    pass('UTF-8 BOM and CRLF text preservation')

    const stale = await fs.save(posix.join(root, 'same-attributes.txt'), 'AAAA', null)
    await fs.save(stale.path, 'BBBB', stale.identity)
    await sftpCall<void>((cb) =>
      fs.sftp.utimes(stale.path, stale.identity.mtime, stale.identity.mtime, (error) =>
        cb(error, undefined),
      ),
    )
    await assert.rejects(fs.save(stale.path, 'CCCC', stale.identity), /changed/)
    assert.equal((await fs.text(stale.path)).content, 'BBBB')
    pass('Content-hash conflict protection for same-size, same-timestamp edits')

    const denied = await fs.save(
      posix.join(root, 'permissions.txt'),
      'test permission boundary',
      null,
    )
    await fs.chmod(denied.path, 0o000)
    try {
      await assert.rejects(fs.text(denied.path))
    } finally {
      await fs.chmod(denied.path, 0o600)
    }
    pass('Permission-denied reads on a test file without privilege elevation')

    const conflicts = posix.join(root, 'conflicts')
    await fs.mkdir(conflicts)
    const sources = join(local, 'extra-sources')
    await mkdir(sources)
    const source = join(sources, 'choice.txt')
    await writeFile(source, 'new contents\n')
    const destination = posix.join(conflicts, 'choice.txt')
    await fs.save(destination, 'original contents\n', null)
    const skip = queue()
    await skip.upload(id, [source], conflicts, 'skip')
    assert.equal((await settle(skip))[0].status, 'CANCELLED')
    assert.equal((await fs.text(destination)).content, 'original contents\n')
    pass('Skip conflict leaves the existing test file unchanged')
    const both = queue()
    await both.upload(id, [source], conflicts, 'keep-both')
    await settle(both)
    assert.equal((await fs.text(destination)).content, 'original contents\n')
    assert.equal(
      (await fs.text(posix.join(conflicts, 'choice.txt.copy-1'))).content,
      'new contents\n',
    )
    pass('Keep-both conflict creates a distinct file without overwriting')
    const replace = queue()
    await replace.upload(id, [source], conflicts, 'replace')
    await settle(replace)
    assert.equal((await fs.text(destination)).content, 'new contents\n')
    pass('Confirmed replacement policy safely replaces only a test-created file')

    const cancelSource = join(sources, 'cancel-retry.bin')
    const payload = randomBytes(4 * 1024 * 1024)
    await writeFile(cancelSource, payload)
    const cancelTarget = posix.join(conflicts, 'cancel-retry.bin')
    const original = await fs.save(cancelTarget, 'preserve me', null)
    let cancelled = false
    const cancellation = new TransferManager(
      sessions,
      (event) => {
        if (
          event.type === 'transfer' &&
          event.job.status === 'TRANSFERRING' &&
          event.job.transferred >= 65536 &&
          !cancelled
        ) {
          cancelled = true
          cancellation.cancel(event.job.id)
        }
      },
      async () => {
        throw new Error('Unexpected conflict dialog')
      },
    )
    queues.push(cancellation)
    await cancellation.upload(id, [cancelSource], conflicts, 'replace')
    const cancelledJobs = await settle(cancellation)
    assert.equal(cancelled, true)
    assert.equal(cancelledJobs[0].status, 'CANCELLED')
    assert.equal((await fs.text(cancelTarget)).content, original.content)
    assert.equal(
      (await fs.list(conflicts)).entries.some((f) => f.name.endsWith('.part')),
      false,
    )
    pass('Mid-upload cancellation preserves the old target and removes partial data')
    cancellation.retry(cancelledJobs[0].id)
    const retried = await settle(cancellation)
    assert.equal(retried[0].status, 'COMPLETED')
    assert.equal(retried[0].retryCount, 1)
    const downloads = join(local, 'extra-downloads')
    await mkdir(downloads)
    const download = queue()
    await download.download(id, [cancelTarget], downloads, 'ask')
    await settle(download)
    const bytes = await readFile(join(downloads, 'cancel-retry.bin'))
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      createHash('sha256').update(payload).digest('hex'),
    )
    pass('Explicit retry restarts cleanly and downloaded 4 MiB contents match SHA-256')
    await assert.rejects(fs.text(cancelTarget), /editor|MiB/)
    pass('Large binary file is rejected by the text editor before loading')

    const invalid = posix.join(root, 'invalid:windows.txt')
    await fs.save(invalid, 'Windows name restriction test', null)
    const windows = queue()
    await assert.rejects(windows.download(id, [invalid], downloads, 'ask'), /Windows/)
    assert.equal(windows.list().length, 0)
    pass('Invalid Windows download names are rejected without silently renaming')

    for (let n = 0; n < 5; n++) {
      let output = ''
      const terminals = new TerminalManager(sessions, (event) => {
        if (event.type === 'terminal-data') {
          output = (output + event.data).slice(-8192)
          terminals.ack(event.id, event.bytes)
        }
      })
      const terminalId = await terminals.open(id, 80, 24, root)
      try {
        terminals.ack(terminalId, 0)
        terminals.input(terminalId, "printf 'VPS_CYCLE_%s\\n' OK\n")
        const deadline = Date.now() + 10000
        while (!output.includes('VPS_CYCLE_OK')) {
          if (Date.now() > deadline) throw new Error('Repeated terminal test timed out')
          await new Promise((r) => setTimeout(r, 100))
        }
        terminals.resize(terminalId, 100 + n, 30 + n)
      } finally {
        terminals.close(terminalId)
        terminals.ack(terminalId, 64)
      }
      await fs.list(root)
    }
    pass('Five repeated PTY open/input/resize/close cycles preserve the shared SFTP connection')
  } finally {
    for (const manager of queues) manager.cancelAll()
  }
}
