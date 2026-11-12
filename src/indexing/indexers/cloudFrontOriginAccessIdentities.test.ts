import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type AwsIamStore } from '../../persistence/AwsIamStore.js'
import { FileSystemAwsIamStore } from '../../persistence/file/FileSystemAwsIamStore.js'
import { InMemoryPathBasedPersistenceAdapter } from '../../persistence/InMemoryPathBasedPersistenceAdapter.js'
import { SqliteAwsIamStore } from '../../persistence/sqlite/SqliteAwsIamStore.js'
import { createStorageClient } from '../../persistence/util.js'
import { runIndexJobs } from '../runIndexers.js'
import { getIndexersForService } from '../indexMap.js'
import { CloudFrontOriginAccessIdentitiesIndexer } from './cloudFrontOriginAccessIdentities.js'

/** Create an isolated store and a cleanup function for an indexer test. */
function createStore(kind: 'file' | 'sqlite'): { store: AwsIamStore; cleanup: () => void } {
  if (kind === 'file') {
    return {
      store: new FileSystemAwsIamStore(
        'test',
        'aws',
        '/',
        new InMemoryPathBasedPersistenceAdapter()
      ),
      cleanup: () => {}
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'oai-index-'))
  const store = new SqliteAwsIamStore(join(directory, 'test.db'), 'aws', 'test')
  return {
    store,
    cleanup: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

/** Store a synthetic OAI in the same shape as CloudFront collection. */
async function saveOai(store: AwsIamStore, account: string, id: string): Promise<void> {
  const arn = `arn:aws:cloudfront::${account}:origin-access-identity/${id}`
  await store.saveResourceMetadata(account, arn, 'metadata', {
    arn,
    id,
    name: id,
    s3CanonicalUserId: `canonical-${id}`
  })
}

describe('CloudFrontOriginAccessIdentitiesIndexer', () => {
  it('is registered for CloudFront', () => {
    expect(getIndexersForService('cloudfront')).toContain(CloudFrontOriginAccessIdentitiesIndexer)
  })

  it.each(['file', 'sqlite'] as const)(
    'refreshes the global index using the %s store',
    async (kind) => {
      //Given two accounts, stale entries, and collected OAI metadata
      const { store, cleanup } = createStore(kind)
      try {
        await saveOai(store, '111111111111', 'EOne')
        await saveOai(store, '111111111111', 'ETwo')
        await saveOai(store, '222222222222', 'EOther')
        const index = await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)
        expect(index.data).toEqual({})
        index.data.EStale = '111111111111'
        index.data.EOther = '222222222222'

        //When an account is refreshed with a regional filter
        await CloudFrontOriginAccessIdentitiesIndexer.updateCache(
          index.data,
          '111111111111',
          ['eu-west-1'],
          store
        )
        expect(
          await CloudFrontOriginAccessIdentitiesIndexer.saveCache(store, index.data, index.lockId)
        ).toBe(true)

        //Then all global identities for that account replace its stale entries and other accounts remain
        expect((await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)).data).toEqual({
          EOne: '111111111111',
          ETwo: '111111111111',
          EOther: '222222222222'
        })

        //When that account no longer has any OAIs
        await store.deleteResourceMetadata(
          '111111111111',
          'arn:aws:cloudfront::111111111111:origin-access-identity/EOne',
          'metadata'
        )
        await store.deleteResourceMetadata(
          '111111111111',
          'arn:aws:cloudfront::111111111111:origin-access-identity/ETwo',
          'metadata'
        )
        const refreshed = await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)
        await CloudFrontOriginAccessIdentitiesIndexer.updateCache(
          refreshed.data,
          '111111111111',
          [],
          store
        )
        expect(refreshed.data).toEqual({ EOther: '222222222222' })
      } finally {
        cleanup()
      }
    }
  )

  it.each(['file', 'sqlite'] as const)(
    'detects stale optimistic locks using the %s store',
    async (kind) => {
      //Given two readers of the same initial index
      const { store, cleanup } = createStore(kind)
      try {
        const first = await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)
        const second = await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)
        first.data.EOne = '111111111111'
        second.data.ETwo = '222222222222'

        //When one reader saves before the other
        expect(
          await CloudFrontOriginAccessIdentitiesIndexer.saveCache(store, first.data, first.lockId)
        ).toBe(true)
        expect(
          await CloudFrontOriginAccessIdentitiesIndexer.saveCache(store, second.data, second.lockId)
        ).toBe(false)

        //Then the winning index is preserved
        expect((await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)).data).toEqual({
          EOne: '111111111111'
        })
      } finally {
        cleanup()
      }
    }
  )

  it('runs the registered indexer across multiple accounts through the job runner', async () => {
    //Given an on-disk collection containing global OAIs from two accounts
    const directory = mkdtempSync(join(tmpdir(), 'oai-index-runner-'))
    try {
      const config = { type: 'file' as const, path: directory }
      const store = createStorageClient(config, 'aws', false)
      await saveOai(store, '111111111111', 'EOne')
      await saveOai(store, '222222222222', 'ETwo')

      //When the registered index jobs run
      await runIndexJobs(
        [
          {
            indexer: CloudFrontOriginAccessIdentitiesIndexer,
            partition: 'aws',
            accountId: '111111111111',
            regions: ['us-east-1']
          },
          {
            indexer: CloudFrontOriginAccessIdentitiesIndexer,
            partition: 'aws',
            accountId: '222222222222',
            regions: ['eu-west-1']
          }
        ],
        config,
        1
      )

      //Then the persisted index contains both owners
      expect((await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)).data).toEqual({
        EOne: '111111111111',
        ETwo: '222222222222'
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retries an optimistic-lock conflict through the job runner', async () => {
    //Given a collected OAI and an indexer whose first save loses its lock
    const directory = mkdtempSync(join(tmpdir(), 'oai-index-retry-'))
    try {
      const config = { type: 'file' as const, path: directory }
      const store = createStorageClient(config, 'aws', false)
      await saveOai(store, '111111111111', 'EOne')
      let attempts = 0
      const retryingIndexer = {
        ...CloudFrontOriginAccessIdentitiesIndexer,
        saveCache: async (
          ...args: Parameters<typeof CloudFrontOriginAccessIdentitiesIndexer.saveCache>
        ) => {
          attempts++
          if (attempts === 1) {
            return false
          }
          return CloudFrontOriginAccessIdentitiesIndexer.saveCache(...args)
        }
      }

      //When the job runner retries after the conflict
      await runIndexJobs(
        [{ indexer: retryingIndexer, partition: 'aws', accountId: '111111111111', regions: [] }],
        config,
        1
      )

      //Then it rebuilds and saves the expected index
      expect(attempts).toBe(2)
      expect((await CloudFrontOriginAccessIdentitiesIndexer.getCache(store)).data).toEqual({
        EOne: '111111111111'
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects conflicting ownership without changing the cache', async () => {
    //Given a collected identity already attributed to another account
    const { store, cleanup } = createStore('file')
    try {
      await saveOai(store, '111111111111', 'ECollision')
      const cache = { EOld: '111111111111', ECollision: '222222222222' }

      //When indexing detects the collision
      await expect(
        CloudFrontOriginAccessIdentitiesIndexer.updateCache(cache, '111111111111', [], store)
      ).rejects.toThrow('multiple owning accounts')

      //Then the prior cache remains unchanged
      expect(cache).toEqual({ EOld: '111111111111', ECollision: '222222222222' })
    } finally {
      cleanup()
    }
  })

  it('does not change the cache when metadata is malformed or storage fails', async () => {
    //Given malformed OAI metadata and an existing index
    const { store, cleanup } = createStore('file')
    try {
      const cache = { EOld: '111111111111' }
      const arn = 'arn:aws:cloudfront::111111111111:origin-access-identity/EInvalid'
      await store.saveResourceMetadata('111111111111', arn, 'metadata', { arn, id: 'EWrong' })
      await expect(
        CloudFrontOriginAccessIdentitiesIndexer.updateCache(cache, '111111111111', [], store)
      ).rejects.toThrow('Invalid CloudFront')
      expect(cache).toEqual({ EOld: '111111111111' })

      //When storage itself fails the cache also remains untouched
      vi.spyOn(store, 'findResourceMetadata').mockRejectedValue(new Error('read failed'))
      await expect(
        CloudFrontOriginAccessIdentitiesIndexer.updateCache(cache, '111111111111', [], store)
      ).rejects.toThrow('read failed')
      expect(cache).toEqual({ EOld: '111111111111' })
    } finally {
      cleanup()
    }
  })
})
