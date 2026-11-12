import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadData, index, type TopLevelConfig } from '../index.js'

afterEach(() => vi.unstubAllEnvs())

type Failure = 'download' | 'credentials' | 'setup' | 'storage' | undefined
const account = '111111111111'
const keyArn = `arn:aws:kms:us-west-2:${account}:key/example`

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-lifecycle-'))
  const sockets = new Set<Socket>()
  const state: { failure: Failure; beforeListKeys: () => Promise<void> } = {
    failure: undefined,
    beforeListKeys: async () => {}
  }
  let interrupted = false
  const server = http.createServer(async (request, response) => {
    response.once('close', () => {
      if (!response.writableFinished) interrupted = true
    })
    let body = ''
    for await (const chunk of request) body += chunk
    const action = new URLSearchParams(body).get('Action')
    if (state.failure === 'credentials' && action === 'GetCallerIdentity') {
      response.writeHead(403, { 'content-type': 'text/xml' })
      response.end(
        '<ErrorResponse><Error><Code>AccessDenied</Code><Message>test denial</Message></Error></ErrorResponse>'
      )
    } else if (action === 'GetCallerIdentity') {
      response.end(
        `<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${account}</Account><Arn>arn:aws:iam::${account}:root</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`
      )
    } else if (action === 'AssumeRole') {
      response.end(
        '<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>test</AccessKeyId><SecretAccessKey>test</SecretAccessKey><SessionToken>test</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>'
      )
    } else {
      response.setHeader('content-type', 'application/x-amz-json-1.1')
      switch (request.headers['x-amz-target']) {
        case 'TrentService.ListKeys':
          await state.beforeListKeys()
          if (state.failure === 'download') {
            response.writeHead(400)
            response.end(
              JSON.stringify({ __type: 'AccessDeniedException', message: 'test denial' })
            )
          } else {
            response.end(JSON.stringify({ Keys: [{ KeyId: 'example', KeyArn: keyArn }] }))
          }
          break
        case 'TrentService.DescribeKey':
          response.end(JSON.stringify({ KeyMetadata: { KeyManager: 'CUSTOMER' } }))
          break
        case 'TrentService.ListResourceTags':
          response.end(JSON.stringify({ Tags: [] }))
          break
        case 'TrentService.GetKeyPolicy':
          response.end(JSON.stringify({ Policy: '{"Version":"2012-10-17","Statement":[]}' }))
          break
        default:
          response.writeHead(400)
          response.end('Unexpected test request')
      }
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const endpoint = `http://127.0.0.1:${address.port}`
  for (const [name, value] of Object.entries({
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_SESSION_TOKEN: 'test',
    AWS_REGION: 'us-west-2',
    AWS_ENDPOINT_URL_STS: endpoint,
    AWS_ENDPOINT_URL_KMS: endpoint,
    AWS_SHARED_CREDENTIALS_FILE: path.join(directory, 'no-credentials'),
    AWS_CONFIG_FILE: path.join(directory, 'no-config')
  }))
    vi.stubEnv(name, value)

  return {
    directory,
    sockets,
    state,
    interrupted: () => interrupted,
    configs: (name: string): TopLevelConfig[] => [
      {
        storage: { type: 'sqlite', path: path.join(directory, `${name}.db`) },
        auth: { role: { pathAndName: 'test' } }
      }
    ],
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

// Check actual descriptors rather than calls to a mocked close(). Match the
// unique basename to cover macOS's /private/var alias and deleted open files.
function expectNoDatabaseHandles(directory: string) {
  const files =
    process.platform === 'darwin'
      ? execFileSync('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-Fn'], {
          encoding: 'utf8'
        }).split('\n')
      : fs.readdirSync('/proc/self/fd').flatMap((fd) => {
          try {
            return [fs.readlinkSync(`/proc/self/fd/${fd}`)]
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw error
          }
        })
  expect(files.filter((file) => file.includes(path.basename(directory)))).toEqual([])
}

function expectKey(dbPath: string) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db
      .prepare("SELECT data FROM resource_metadata WHERE arn = ? AND metadata_type = 'metadata'")
      .get(keyArn) as { data: string }
    expect(JSON.parse(row.data).id).toBe('example')
  } finally {
    db.close()
  }
}

it.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'releases sockets and SQLite files across repeated downloads and failures',
  async () => {
    const f = await fixture()
    try {
      f.state.beforeListKeys = () => delay(20)
      const failures: Failure[] = [undefined, 'download', 'credentials', 'setup', 'storage']
      for (let i = 0; i < 10; i++) {
        const configs = f.configs(String(i))
        const dbPath = configs[0].storage!.path!
        const accounts = [String(200000000000 + i)]
        f.state.failure = failures[i % failures.length]
        if (f.state.failure === 'setup') {
          // Fail while earlier jobs are still running, not before any work starts.
          accounts.push('999999999999')
          configs[0].accountConfigs = {
            '999999999999': { auth: { profile: 'nonexistent-test-profile' } }
          }
        } else if (f.state.failure === 'storage') {
          fs.writeFileSync(dbPath, 'not a SQLite database')
        }
        const download = downloadData(configs, accounts, ['us-west-2'], ['kms'], 2, true, true)
        if (f.state.failure) {
          const messages = {
            setup: /nonexistent-test-profile/,
            credentials: /test denial/,
            download: /Failed to download some data/,
            storage: /not a database/
          }
          await expect(download).rejects.toThrow(messages[f.state.failure])
        } else {
          await download
        }
        if (!f.state.failure || f.state.failure === 'setup') expectKey(dbPath)
        await vi.waitFor(() => expect(f.sockets.size).toBe(0))
        expectNoDatabaseHandles(f.directory)
        if (!f.state.failure) {
          await index(configs, 'aws', accounts, ['us-west-2'], ['s3'], 2)
          expectNoDatabaseHandles(f.directory)
        }
      }
      expect(f.interrupted()).toBe(false)
    } finally {
      await f.close()
    }
  },
  15000
)

it('does not interrupt another download using the same account and credentials', async () => {
  const f = await fixture()
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let calls = 0
  f.state.beforeListKeys = async () => {
    if (++calls === 1) {
      started()
      await held
    }
  }
  const firstConfigs = f.configs('first')
  const first = downloadData(firstConfigs, [account], ['us-west-2'], ['kms'], 2, true, true)
  // Attach the handler immediately, including when the second call fails.
  const firstResult = first.then(
    () => undefined,
    (error) => error
  )
  try {
    await entered
    await downloadData(f.configs('second'), [account], ['us-west-2'], ['kms'], 2, true, true)
    release()
    expect(await firstResult).toBeUndefined()
    expectKey(firstConfigs[0].storage!.path!)
    expectKey(f.configs('second')[0].storage!.path!)
    expect(f.interrupted()).toBe(false)
    await vi.waitFor(() => expect(f.sockets.size).toBe(0))
  } finally {
    release()
    await firstResult
    await f.close()
  }
})
