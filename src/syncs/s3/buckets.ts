import {
  type Bucket,
  GetBucketAbacCommand,
  GetBucketEncryptionCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  type PublicAccessBlockConfiguration,
  S3Client,
  type ServerSideEncryptionConfiguration
} from '@aws-sdk/client-s3'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { type AwsIamStore } from '../../persistence/AwsIamStore.js'
import {
  runAndCatch404,
  runAndCatchAccessDeniedWithLog,
  withDnsRetry
} from '../../utils/client-tools.js'
import { convertTagsToRecord } from '../../utils/tags.js'
import { type Sync, syncData, type SyncOptions } from '../sync.js'
import { paginateResource } from '../typedSync.js'

interface SuccessfulJob {
  status: 'fulfilled'
  value: any
  properties: any
}

const gpBuckets = 'generalPurposeBuckets'

export const S3GeneralPurposeBucketSync: Sync = {
  awsService: 's3',
  name: gpBuckets,
  execute: async (
    accountId: string,
    region: string,
    credentials: AwsCredentialProviderWithMetaData,
    storage: AwsIamStore,
    endpoint: string | undefined,
    syncOptions: SyncOptions
  ): Promise<void> => {
    const s3Client = syncOptions.clientPool.client(S3Client, credentials, region, endpoint)

    const allBuckets = await withDnsRetry(async () => {
      return paginateResource(
        s3Client,
        ListBucketsCommand,
        'Buckets',
        {
          inputKey: 'ContinuationToken',
          outputKey: 'ContinuationToken'
        },
        { MaxBuckets: 1000, BucketRegion: region }
      )
    })

    const augmentedBuckets = await Promise.all(
      allBuckets.map(async (bucket) => {
        const arn = `arn:${credentials.partition}:s3:::${bucket.Name}`

        const [
          tagsJob,
          blockPublicAccessConfigJob,
          bucketPolicyJob,
          encryptionJob,
          abacEnabledJob
        ] = await Promise.all(
          syncOptions.workerPool.enqueueAll([
            {
              execute: () => {
                return withDnsRetry(async () => {
                  return getTagsForBucket(s3Client, bucket, arn)
                })
              },
              properties: {}
            },
            {
              execute: () => {
                return withDnsRetry(async () => {
                  return getBucketPublicAccessSettings(s3Client, bucket, arn)
                })
              },
              properties: {}
            },
            {
              execute: () => {
                return withDnsRetry(async () => {
                  return getBucketPolicy(s3Client, bucket, credentials.accountId, arn)
                })
              },
              properties: {}
            },
            {
              execute: () => {
                return withDnsRetry(async () => {
                  return getBucketEncryptionSettings(s3Client, bucket, arn)
                })
              },
              properties: {}
            },
            {
              execute: () => {
                return withDnsRetry(async () => {
                  return getBucketAbacEnabled(s3Client, bucket, arn)
                })
              },
              properties: {}
            }
          ])
        )

        for (const job of [
          tagsJob,
          blockPublicAccessConfigJob,
          bucketPolicyJob,
          encryptionJob,
          abacEnabledJob
        ]) {
          if (job.status === 'rejected') {
            throw job.reason
          }
        }

        const [tags, blockPublicAccessConfig, bucketPolicy, encryption, abacEnabled] = [
          (tagsJob as SuccessfulJob).value,
          (blockPublicAccessConfigJob as SuccessfulJob).value,
          (bucketPolicyJob as SuccessfulJob).value,
          (encryptionJob as SuccessfulJob).value,
          (abacEnabledJob as SuccessfulJob).value
        ]

        return {
          arn,
          tags: tags,
          bpa: blockPublicAccessConfig,
          policy: bucketPolicy,
          encryption: encryption?.Rules,
          metadata: {
            name: bucket.Name!,
            region: region,
            arn,
            abacEnabled
          }
        }
      })
    )

    await syncData(
      augmentedBuckets,
      storage,
      accountId,
      {
        service: 's3',
        account: accountId,
        metadata: {
          region
        }
      },
      syncOptions.writeOnly
    )
  }
}

/**
 * Get the tags for a bucket.
 *
 * @param client the S3 client to use
 * @param bucket the bucket to get the tags for
 * @returns the tags for the bucket, if any
 */
async function getTagsForBucket(
  client: S3Client,
  bucket: Bucket,
  arn: string
): Promise<Record<string, string> | undefined> {
  const tagCommand = new GetBucketTaggingCommand({ Bucket: bucket.Name! })
  const tags = await runAndCatchAccessDeniedWithLog(arn, 's3', gpBuckets, 'tags', async () => {
    return runAndCatch404<Record<string, string>>(async () => {
      const response = await client.send(tagCommand)
      return convertTagsToRecord(response.TagSet)
    })
  })

  return tags
}

/**
 * Get the bucket policy for a bucket.
 *
 * @param client the S3 client to use
 * @param bucket the bucket to get the policy for
 * @param accountId the account ID of the bucket owner
 * @returns the bucket policy for the bucket, if any
 */
async function getBucketPolicy(
  client: S3Client,
  bucket: Bucket,
  accountId: string,
  arn: string
): Promise<any | undefined> {
  const policyCommand = new GetBucketPolicyCommand({
    Bucket: bucket.Name!,
    ExpectedBucketOwner: accountId
  })
  const policy = await runAndCatchAccessDeniedWithLog(arn, 's3', gpBuckets, 'policy', async () => {
    return runAndCatch404<any>(async () => {
      const response = await client.send(policyCommand)
      return response.Policy ? JSON.parse(response.Policy) : undefined
    })
  })

  return policy
}

/**
 * Get the public access block configuration for a bucket.
 *
 * @param client The S3 client to use.
 * @param bucket the bucket to get the public access settings for
 * @returns the public access block configuration for the bucket, if any
 */
async function getBucketPublicAccessSettings(
  client: S3Client,
  bucket: Bucket,
  arn: string
): Promise<PublicAccessBlockConfiguration | undefined> {
  const command = new GetPublicAccessBlockCommand({ Bucket: bucket.Name! })
  const response = await runAndCatchAccessDeniedWithLog(
    arn,
    's3',
    gpBuckets,
    'blockPublicAccess',
    async () => {
      return runAndCatch404(async () => {
        return await client.send(command)
      })
    }
  )

  return response?.PublicAccessBlockConfiguration
}

/**
 * Get the bucket encryption settings for a bucket.
 *
 * @param client the S3 client to use
 * @param bucket the bucket to get the encryption settings for
 * @returns encryption settings for the bucket, if any
 */
async function getBucketEncryptionSettings(
  client: S3Client,
  bucket: Bucket,
  arn: string
): Promise<ServerSideEncryptionConfiguration | undefined> {
  const command = new GetBucketEncryptionCommand({ Bucket: bucket.Name! })
  const response = await runAndCatchAccessDeniedWithLog(
    arn,
    's3',
    gpBuckets,
    'encryption',
    async () => {
      return runAndCatch404(async () => {
        return await client.send(command)
      })
    }
  )

  return response?.ServerSideEncryptionConfiguration
}

/**
 * Check if ABAC is enabled for the bucket.
 *
 * @param client the S3 client to use
 * @param bucket the bucket to check
 * @param arn the ARN of the bucket
 * @returns true if ABAC is enabled, undefined otherwise
 */
async function getBucketAbacEnabled(
  client: S3Client,
  bucket: Bucket,
  arn: string
): Promise<true | undefined> {
  const command = new GetBucketAbacCommand({ Bucket: bucket.Name! })
  const response = await runAndCatchAccessDeniedWithLog(
    arn,
    's3',
    gpBuckets,
    'abacEnabled',
    async () => {
      return runAndCatch404(async () => {
        return await client.send(command)
      })
    }
  )

  return response?.AbacStatus?.Status === 'Enabled' ? true : undefined
}
