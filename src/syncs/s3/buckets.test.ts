import {
  GetBucketAbacCommand,
  GetBucketAclCommand,
  GetBucketEncryptionCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { S3GeneralPurposeBucketSync } from './buckets.js'

const s3Mock = mockClient(S3Client)
const accountId = '111111111111'
const region = 'us-east-1'
const bucketName = 'test-bucket'
const bucketArn = `arn:aws:s3:::${bucketName}`
const credentials: AwsCredentialProviderWithMetaData = {
  accountId,
  partition: 'aws',
  cacheKey: 'test-credentials',
  provider: async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key'
  })
}

const workerPool = {
  enqueueAll: (jobs: any[]) =>
    jobs.map(async (job) => {
      try {
        return {
          status: 'fulfilled',
          value: await job.execute({ workerId: 1, properties: job.properties }),
          properties: job.properties
        }
      } catch (reason) {
        return { status: 'rejected', reason, properties: job.properties }
      }
    })
} as any

/**
 * Configure successful responses for the S3 bucket calls other than GetBucketAcl.
 */
function configureBucketResponses(): void {
  s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: bucketName }] })
  s3Mock.on(GetBucketTaggingCommand).resolves({ TagSet: [] })
  s3Mock.on(GetPublicAccessBlockCommand).resolves({})
  s3Mock.on(GetBucketPolicyCommand).resolves({})
  s3Mock.on(GetBucketEncryptionCommand).resolves({})
  s3Mock.on(GetBucketAbacCommand).resolves({})
}

/**
 * Run the general-purpose bucket sync against an in-memory store.
 *
 * @returns the store populated by the sync
 */
async function runBucketSync() {
  const store = createInMemoryStorageClient()
  const clientPool = new AwsClientPool()

  await S3GeneralPurposeBucketSync.execute(accountId, region, credentials, store, undefined, {
    clientPool,
    workerPool,
    writeOnly: false
  })
  clientPool.clear()

  return store
}

describe('S3GeneralPurposeBucketSync', () => {
  afterEach(() => {
    s3Mock.reset()
  })

  it('persists bucket ACL owner and grants', async () => {
    //Given a bucket with a canonical-user ACL grant
    configureBucketResponses()
    s3Mock.on(GetBucketAclCommand).resolves({
      Owner: { ID: 'owner-canonical-id', DisplayName: 'bucket-owner' },
      Grants: [
        {
          Grantee: { ID: 'grantee-canonical-id', Type: 'CanonicalUser' },
          Permission: 'READ'
        }
      ]
    })

    //When the bucket sync runs
    const store = await runBucketSync()

    //Then it persists the SDK-shaped ACL response
    await expect(store.getResourceMetadata(accountId, bucketArn, 'acl')).resolves.toEqual({
      Owner: { ID: 'owner-canonical-id', DisplayName: 'bucket-owner' },
      Grants: [
        {
          Grantee: { ID: 'grantee-canonical-id', Type: 'CanonicalUser' },
          Permission: 'READ'
        }
      ]
    })
    expect(s3Mock.commandCalls(GetBucketAclCommand)[0]?.args[0].input).toEqual({
      Bucket: bucketName,
      ExpectedBucketOwner: accountId
    })
  })

  it('continues without ACL metadata when ACL collection is denied', async () => {
    //Given a bucket whose ACL cannot be read
    configureBucketResponses()
    const error = new Error('ACL access denied')
    error.name = 'AccessDenied'
    s3Mock.on(GetBucketAclCommand).rejects(error)

    //When the bucket sync runs
    const store = await runBucketSync()

    //Then the optional ACL is omitted without failing the bucket collection
    await expect(store.getResourceMetadata(accountId, bucketArn, 'acl')).resolves.toBeUndefined()
    await expect(
      store.getResourceMetadata(accountId, bucketArn, 'metadata')
    ).resolves.toMatchObject({
      arn: bucketArn,
      name: bucketName,
      region
    })
  })
})
