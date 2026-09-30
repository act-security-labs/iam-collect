import {
  GetAccessPointPolicyCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  ListAccessPointsCommand,
  ListRegionalBucketsCommand,
  S3ControlClient
} from '@aws-sdk/client-s3-control'
import {
  ListOutpostsWithS3Command,
  type Outpost,
  S3OutpostsClient
} from '@aws-sdk/client-s3outposts'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { runAndCatch404 } from '../../utils/client-tools.js'
import { parseIfPresent } from '../../utils/json.js'
import { log } from '@actsecurity/log'
import { convertTagsToRecord } from '../../utils/tags.js'
import { type DataRecord, type Sync, syncData } from '../sync.js'
import { paginateResource } from '../typedSync.js'

export const S3OutpostsBucketsSync: Sync = {
  awsService: 's3outposts',
  name: 'buckets',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const outpostsClient = syncOptions.clientPool.client(
      S3OutpostsClient,
      credentials,
      region,
      endpoint
    )

    const outposts = await listS3Outposts(outpostsClient)

    const regionalBuckets: DataRecord[] = []
    for (const outpost of outposts) {
      const controlClient = controlClientForOutpost(credentials, region, outpost.OutpostId!)
      const buckets = await paginateResource(
        outpostsClient,
        ListRegionalBucketsCommand,
        'RegionalBucketList',
        {
          inputKey: 'NextToken',
          outputKey: 'NextToken'
        },
        {
          OutpostId: outpost.OutpostId
        }
      )

      for (const bucket of buckets) {
        regionalBuckets.push({
          arn: bucket.BucketArn!,
          metadata: {
            arn: bucket.BucketArn!,
            name: bucket.Bucket,
            outpostId: bucket.OutpostId,
            publicAccessBlockEnabled: bucket.PublicAccessBlockEnabled,
            bucket: 'true'
          },
          policy: await runAndCatch404(async () => {
            const result = await controlClient.send(
              new GetBucketPolicyCommand({
                Bucket: bucket.Bucket!
              })
            )
            return parseIfPresent(result.Policy)
          }),
          tags: await runAndCatch404(async () => {
            const tags = await controlClient.send(
              new GetBucketTaggingCommand({
                Bucket: bucket.Bucket!
              })
            )
            return convertTagsToRecord(tags.TagSet)
          })
        })
      }
    }

    await syncData(
      regionalBuckets,
      storage,
      accountId,
      {
        service: 's3outposts',
        resourceType: 'outpost',
        account: accountId,
        region: region,
        metadata: {
          bucket: 'true'
        }
      },
      syncOptions.writeOnly
    )
  }
}

export const S3OutpostsAccessPointsSync: Sync = {
  awsService: 's3outposts',
  name: 'accessPoints',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const outpostsClient = syncOptions.clientPool.client(
      S3OutpostsClient,
      credentials,
      region,
      endpoint
    )

    const outposts = await listS3Outposts(outpostsClient)

    const accessPoints: DataRecord[] = []
    for (const outpost of outposts) {
      const controlClient = controlClientForOutpost(credentials, region, outpost.OutpostId!)
      const points = await paginateResource(
        controlClient,
        ListAccessPointsCommand,
        'AccessPointList',
        {
          inputKey: 'NextToken',
          outputKey: 'NextToken'
        },
        {
          AccountId: accountId
        }
      )

      for (const point of points) {
        accessPoints.push({
          arn: point.AccessPointArn!,
          metadata: {
            arn: point.AccessPointArn!,
            name: point.Name,
            outpostId: outpost.OutpostId,
            networkOrigin: point.NetworkOrigin,
            vpc: point.VpcConfiguration?.VpcId,
            bucket: point.Bucket,
            bucketAccount: point.BucketAccountId,
            accesspoint: 'true'
          },
          policy: await runAndCatch404(async () => {
            const result = await controlClient.send(
              new GetAccessPointPolicyCommand({
                Name: point.Name!,
                AccountId: accountId
              })
            )
            return parseIfPresent(result.Policy)
          })
        })
      }
    }

    await syncData(
      accessPoints,
      storage,
      accountId,
      {
        service: 's3outposts',
        resourceType: 'outpost',
        account: accountId,
        region: region,
        metadata: {
          accesspoint: 'true'
        }
      },
      syncOptions.writeOnly
    )
  }
}

/**
 * List the Outposts in the account that have S3
 *
 * @param outpostsClient the S3OutpostsClient to use
 * @returns and array of Outpost objects
 */

async function listS3Outposts(outpostsClient: S3OutpostsClient): Promise<Outpost[]> {
  return paginateResource(outpostsClient, ListOutpostsWithS3Command, 'Outposts', {
    inputKey: 'NextToken',
    outputKey: 'NextToken'
  })
}

/**
 * Create a new S3ControlClient with the Outpost ID set in the headers
 *
 * @param credentials the credentials to use for the client
 * @param region the region to use for the client
 * @param outpostId the Outpost ID to set in the headers
 * @returns a new S3ControlClient with the Outpost ID set in the headers
 */
function controlClientForOutpost(
  credentials: AwsCredentialProviderWithMetaData,
  region: string | undefined,
  outpostId: string
): S3ControlClient {
  const controlClient = new S3ControlClient({ credentials: credentials.provider, region })
  controlClient.middlewareStack.add(
    (next, context) => (args) => {
      if (args.request) {
        log.trace('Adding outpost ID to request headers')
        ;(args.request as any).headers['x-amz-outpost-id'] = outpostId
      }
      return next(args)
    },
    {
      step: 'build'
    }
  )

  return controlClient
}
