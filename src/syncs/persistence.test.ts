import { ConcurrentWorkerPool } from '@actsecurity/job'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { AwsClientPool } from '../aws/ClientPool.js'
import { createInMemoryStorageClient } from '../persistence/util.js'
import { AuthorizationDetailsSync } from './iam/authorizationDetails.js'
import { S3GeneralPurposeBucketSync } from './s3/buckets.js'

it.each([S3GeneralPurposeBucketSync, AuthorizationDetailsSync])(
  '$awsService $name waits for persistence and propagates write failures',
  async (sync) => {
    const accountId = '123456789012'
    const arn =
      sync === S3GeneralPurposeBucketSync
        ? 'arn:aws:s3:::example'
        : `arn:aws:iam::${accountId}:user/example`
    const clientPool = new AwsClientPool()
    const workerPool = new ConcurrentWorkerPool(2)
    const storage = createInMemoryStorageClient()
    vi.spyOn(clientPool, 'client').mockReturnValue({
      send: async (command: any) => {
        switch (command.constructor.name) {
          case 'ListBucketsCommand':
            return { Buckets: [{ Name: 'example' }] }
          case 'GetAccountAuthorizationDetailsCommand':
            return { UserDetailList: [{ Arn: arn, UserName: 'example', Path: '/' }] }
          default:
            return {}
        }
      }
    } as any)
    let fail = false
    const save = storage.saveResourceMetadata.bind(storage)
    vi.spyOn(storage, 'saveResourceMetadata').mockImplementation(async (...args) => {
      await delay(1)
      if (fail) throw new Error('test storage failure')
      await save(...args)
    })
    const run = () =>
      sync.execute(
        accountId,
        'us-west-2',
        {
          accountId,
          partition: 'aws',
          cacheKey: 'test',
          provider: async () => ({ accessKeyId: 'test', secretAccessKey: 'test' })
        },
        storage,
        undefined,
        { writeOnly: true, clientPool, workerPool }
      )
    try {
      await run()
      await expect(storage.getResourceMetadata(accountId, arn, 'metadata')).resolves.toMatchObject({
        name: 'example'
      })
      fail = true
      await expect(run()).rejects.toThrow('test storage failure')
    } finally {
      await workerPool.finishAllWork()
      clientPool.clear()
    }
  }
)
