import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  KMSClient,
  ListKeysCommand,
  ListResourceTagsCommand
} from '@aws-sdk/client-kms'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { KeySync } from './key.js'

const kmsMock = mockClient(KMSClient)
const accountId = '111111111111'
const region = 'us-east-1'
const awsManagedKeyId = 'aws-managed-key'
const customerManagedKeyId = 'customer-managed-key'
const keyArn = (keyId: string) => `arn:aws:kms:${region}:${accountId}:key/${keyId}`
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

describe('KeySync', () => {
  afterEach(() => {
    kmsMock.reset()
  })

  it('persists awsManaged only for AWS-managed keys', async () => {
    //Given AWS-managed and customer-managed keys
    const store = createInMemoryStorageClient()
    kmsMock.on(ListKeysCommand).resolves({
      Keys: [
        { KeyId: awsManagedKeyId, KeyArn: keyArn(awsManagedKeyId) },
        { KeyId: customerManagedKeyId, KeyArn: keyArn(customerManagedKeyId) }
      ]
    })
    kmsMock.on(DescribeKeyCommand).callsFake((input) => ({
      KeyMetadata: {
        KeyManager: input.KeyId === awsManagedKeyId ? 'AWS' : 'CUSTOMER'
      }
    }))
    kmsMock.on(GetKeyPolicyCommand).resolves({ Policy: JSON.stringify({ Version: '2012-10-17' }) })
    kmsMock.on(ListResourceTagsCommand).resolves({ Tags: [] })
    const clientPool = new AwsClientPool()

    //When the KMS key sync runs
    await KeySync.execute(accountId, region, credentials, store, undefined, {
      clientPool,
      workerPool,
      writeOnly: false
    })
    clientPool.clear()

    //Then only the AWS-managed key has the sparse metadata flag
    await expect(
      store.getResourceMetadata(accountId, keyArn(awsManagedKeyId), 'metadata')
    ).resolves.toEqual({
      arn: keyArn(awsManagedKeyId),
      id: awsManagedKeyId,
      awsManaged: true
    })
    await expect(
      store.getResourceMetadata(accountId, keyArn(customerManagedKeyId), 'metadata')
    ).resolves.toEqual({
      arn: keyArn(customerManagedKeyId),
      id: customerManagedKeyId
    })
    expect(
      kmsMock.commandCalls(DescribeKeyCommand).map((call) => call.args[0].input.KeyId)
    ).toEqual([awsManagedKeyId, customerManagedKeyId])
  })
})
