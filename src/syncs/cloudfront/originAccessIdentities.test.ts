import {
  CloudFrontClient,
  ListCloudFrontOriginAccessIdentitiesCommand
} from '@aws-sdk/client-cloudfront'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { AwsConfigClientPool } from '../../awsConfigClients/AwsConfigClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { SqliteAwsIamStore } from '../../persistence/sqlite/SqliteAwsIamStore.js'
import { getGlobalSyncsForService } from '../syncMap.js'
import { CloudFrontOriginAccessIdentitiesSync } from './originAccessIdentities.js'

const cloudFrontMock = mockClient(CloudFrontClient)
const account = '111111111111'
const credentials: AwsCredentialProviderWithMetaData = {
  accountId: account,
  partition: 'aws',
  cacheKey: 'cloudfront-test',
  provider: async () => ({ accessKeyId: 'test', secretAccessKey: 'test' })
}
const type = { service: 'cloudfront', account, resourceType: 'origin-access-identity' }
const arn = (id: string) => `arn:aws:cloudfront::${account}:origin-access-identity/${id}`

/**
 * Run the identity sync with an in-memory store and isolated AWS client pool.
 *
 * @param store The store to update.
 * @param writeOnly Whether stale resources should be preserved.
 * @param partition The partition used to construct resource ARNs.
 */
async function runSync(
  store: ReturnType<typeof createInMemoryStorageClient>,
  writeOnly = false,
  partition = 'aws'
) {
  const clientPool = new AwsClientPool()
  try {
    await CloudFrontOriginAccessIdentitiesSync.execute(
      account,
      'us-east-1',
      { ...credentials, partition },
      store,
      undefined,
      { clientPool, workerPool: {} as any, writeOnly }
    )
  } finally {
    clientPool.clear()
  }
}

describe('CloudFrontOriginAccessIdentitiesSync', () => {
  afterEach(() => {
    cloudFrontMock.reset()
  })

  it('collects every nested page with account-qualified identities and canonical IDs', async () => {
    //Given two pages and an existing stale identity
    const store = createInMemoryStorageClient()
    await store.saveResourceMetadata(account, arn('STALE'), 'metadata', { id: 'STALE' })
    cloudFrontMock
      .on(ListCloudFrontOriginAccessIdentitiesCommand, { Marker: undefined })
      .resolves({
        CloudFrontOriginAccessIdentityList: {
          Marker: '',
          MaxItems: 1,
          IsTruncated: true,
          Quantity: 2,
          NextMarker: 'page2',
          Items: [{ Id: 'EONE', S3CanonicalUserId: 'canonical-one', Comment: 'first' }]
        }
      })
      .on(ListCloudFrontOriginAccessIdentitiesCommand, { Marker: 'page2' })
      .resolves({
        CloudFrontOriginAccessIdentityList: {
          Marker: 'page2',
          MaxItems: 1,
          IsTruncated: false,
          Quantity: 2,
          Items: [{ Id: 'ETWO', S3CanonicalUserId: 'canonical-two', Comment: 'second' }]
        }
      })

    //When the sync runs
    await runSync(store)

    //Then both identities are stored and the stale entry is removed
    expect((await store.listResources(account, type)).sort()).toEqual(['eone', 'etwo'])
    await expect(store.getResourceMetadata(account, arn('EONE'), 'metadata')).resolves.toEqual({
      arn: arn('EONE'),
      id: 'EONE',
      name: 'EONE',
      comment: 'first',
      s3CanonicalUserId: 'canonical-one'
    })
    await expect(
      store.getResourceMetadata(account, arn('ETWO'), 'metadata')
    ).resolves.toMatchObject({
      id: 'ETWO',
      s3CanonicalUserId: 'canonical-two'
    })
    expect(
      cloudFrontMock
        .commandCalls(ListCloudFrontOriginAccessIdentitiesCommand)
        .map((call) => call.args[0].input)
    ).toEqual([{ Marker: undefined }, { Marker: 'page2' }])
  })

  it.each([false, true])('handles an empty list with writeOnly=%s', async (writeOnly) => {
    //Given an existing identity and an empty successful response
    const store = createInMemoryStorageClient()
    await store.saveResourceMetadata(account, arn('STALE'), 'metadata', { id: 'STALE' })
    cloudFrontMock.on(ListCloudFrontOriginAccessIdentitiesCommand).resolves({
      CloudFrontOriginAccessIdentityList: {
        Marker: '',
        MaxItems: 100,
        IsTruncated: false,
        Quantity: 0
      }
    })

    //When synchronization is performed
    await runSync(store, writeOnly)

    //Then stale identities are removed only in normal synchronization mode
    expect(await store.listResources(account, type)).toEqual(writeOnly ? ['stale'] : [])
  })

  it('preserves existing data if a later page fails', async () => {
    //Given a valid first page and a denied second page
    const store = createInMemoryStorageClient()
    await store.saveResourceMetadata(account, arn('STALE'), 'metadata', { id: 'STALE' })
    cloudFrontMock
      .on(ListCloudFrontOriginAccessIdentitiesCommand, { Marker: undefined })
      .resolves({
        CloudFrontOriginAccessIdentityList: {
          Marker: '',
          MaxItems: 1,
          IsTruncated: true,
          Quantity: 1,
          NextMarker: 'page2',
          Items: [{ Id: 'EONE', S3CanonicalUserId: 'canonical-one', Comment: 'first' }]
        }
      })
      .on(ListCloudFrontOriginAccessIdentitiesCommand, { Marker: 'page2' })
      .rejects(new Error('AccessDenied'))

    //When collection fails before all pages have completed
    await expect(runSync(store)).rejects.toThrow('AccessDenied')

    //Then neither deletion nor partial writes are performed
    expect(await store.getResourceMetadata(account, arn('STALE'), 'metadata')).toEqual({
      id: 'STALE'
    })
    expect(await store.getResourceMetadata(account, arn('EONE'), 'metadata')).toBeUndefined()
  })

  it.each([
    { Marker: '', MaxItems: 1, IsTruncated: true, Quantity: 0 },
    { Marker: '', MaxItems: 1, IsTruncated: false, Quantity: 1 },
    { Marker: '', MaxItems: 1, IsTruncated: false, Quantity: 1, Items: [] },
    {
      Marker: '',
      MaxItems: 1,
      IsTruncated: false,
      Quantity: 1,
      Items: [{ Id: 'EONE', S3CanonicalUserId: '', Comment: '' }]
    }
  ])('rejects incomplete page data without clearing existing identities', async (page) => {
    //Given malformed pagination or identity data
    const store = createInMemoryStorageClient()
    await store.saveResourceMetadata(account, arn('STALE'), 'metadata', { id: 'STALE' })
    cloudFrontMock
      .on(ListCloudFrontOriginAccessIdentitiesCommand)
      .resolves({ CloudFrontOriginAccessIdentityList: page })

    //When collection is attempted
    await expect(runSync(store)).rejects.toThrow()

    //Then previously collected identities remain intact
    expect(await store.getResourceMetadata(account, arn('STALE'), 'metadata')).toEqual({
      id: 'STALE'
    })
  })

  it('stores and reconciles identities using the SQLite backend', async () => {
    //Given an existing SQLite identity and a newly collected identity
    const store = new SqliteAwsIamStore(':memory:', 'aws', 'test')
    await store.saveResourceMetadata(account, arn('STALE'), 'metadata', { id: 'STALE' })
    cloudFrontMock.on(ListCloudFrontOriginAccessIdentitiesCommand).resolves({
      CloudFrontOriginAccessIdentityList: {
        Marker: '',
        MaxItems: 1,
        IsTruncated: false,
        Quantity: 1,
        Items: [{ Id: 'EONE', S3CanonicalUserId: 'canonical-one', Comment: 'first' }]
      }
    })

    try {
      //When the sync is run with SQLite storage
      await runSync(store)

      //Then the stored metadata retains the original ARN and canonical ID and the stale identity is removed
      expect(await store.getResourceMetadata(account, arn('EONE'), 'metadata')).toMatchObject({
        arn: arn('EONE'),
        id: 'EONE',
        s3CanonicalUserId: 'canonical-one'
      })
      expect(await store.getResourceMetadata(account, arn('STALE'), 'metadata')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('preserves the credential partition when constructing resource ARNs', async () => {
    //Given an OAI from a non-default partition
    const store = createInMemoryStorageClient()
    cloudFrontMock.on(ListCloudFrontOriginAccessIdentitiesCommand).resolves({
      CloudFrontOriginAccessIdentityList: {
        Marker: '',
        MaxItems: 1,
        IsTruncated: false,
        Quantity: 1,
        Items: [{ Id: 'EONE', S3CanonicalUserId: 'canonical-one', Comment: 'first' }]
      }
    })

    //When the identity is collected in that partition
    await runSync(store, false, 'aws-us-gov')

    //Then its metadata contains the corresponding account-qualified ARN
    const govArn = `arn:aws-us-gov:cloudfront::${account}:origin-access-identity/EONE`
    await expect(store.getResourceMetadata(account, govArn, 'metadata')).resolves.toMatchObject({
      arn: govArn,
      s3CanonicalUserId: 'canonical-one'
    })
  })

  it('rejects a repeated pagination marker without replacing stored data', async () => {
    //Given two pages that repeat their continuation marker
    const store = createInMemoryStorageClient()
    await store.saveResourceMetadata(account, arn('STALE'), 'metadata', { id: 'STALE' })
    cloudFrontMock.on(ListCloudFrontOriginAccessIdentitiesCommand).resolves({
      CloudFrontOriginAccessIdentityList: {
        Marker: '',
        MaxItems: 1,
        IsTruncated: true,
        Quantity: 1,
        NextMarker: 'same',
        Items: [{ Id: 'EONE', S3CanonicalUserId: 'canonical-one', Comment: 'first' }]
      }
    })

    //When the sync detects that it cannot make progress
    await expect(runSync(store)).rejects.toThrow('pagination marker')

    //Then it preserves the existing data
    expect(await store.getResourceMetadata(account, arn('STALE'), 'metadata')).toEqual({
      id: 'STALE'
    })
  })

  it('skips OAI collection when AWS Config is the data source', () => {
    //Given a Config data source without OAI resource support
    const pool = new AwsConfigClientPool({ aggregatorName: 'test', region: 'us-east-1' })

    //When the download runner checks whether this sync is supported
    const supported = pool.isSyncSupported('cloudfront', 'originAccessIdentities', 'us-east-1')

    //Then it skips the API-only sync rather than using a missing Config client
    expect(supported).toBe(false)
  })

  it('registers the sync as a global CloudFront sync', () => {
    //Given the registered global syncs
    //When CloudFront syncs are requested
    const syncs = getGlobalSyncsForService('cloudfront')

    //Then the OAI sync is available exactly once
    expect(syncs.filter((sync) => sync.name === 'originAccessIdentities')).toEqual([
      CloudFrontOriginAccessIdentitiesSync
    ])
  })
})
