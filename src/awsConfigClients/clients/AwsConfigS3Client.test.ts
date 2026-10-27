import {
  ConfigServiceClient,
  SelectAggregateResourceConfigCommand
} from '@aws-sdk/client-config-service'
import { GetBucketAclCommand, ListBucketsCommand } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { AwsConfigS3Client } from './AwsConfigS3Client.js'

const configMock = mockClient(ConfigServiceClient)
const accountId = '111111111111'
const region = 'us-east-1'
const aggregatorName = 'test-aggregator'
const bucketName = 'test-bucket'
const credentials: AwsCredentialProviderWithMetaData = {
  accountId,
  partition: 'aws',
  cacheKey: 'test-credentials',
  provider: async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key'
  })
}

/**
 * Create an AWS Config S3 client with synthetic credentials and aggregator context.
 *
 * @returns the configured AWS Config S3 client
 */
function createClient(): AwsConfigS3Client {
  return new AwsConfigS3Client(
    { credentials, region },
    {
      configClient: new ConfigServiceClient({}),
      aggregatorName,
      configCredentials: credentials
    }
  )
}

/**
 * Create a synthetic AWS Config S3 bucket result.
 *
 * @param accessControlList the optional supplementary ACL payload
 * @returns a serialized Config query result
 */
function createBucketResult(accessControlList?: object): string {
  return JSON.stringify({
    arn: `arn:aws:s3:::${bucketName}`,
    resourceName: bucketName,
    configuration: JSON.stringify({ name: bucketName }),
    supplementaryConfiguration: JSON.stringify(
      accessControlList ? { AccessControlList: accessControlList } : {}
    ),
    tags: JSON.stringify({})
  })
}

describe('AwsConfigS3Client', () => {
  afterEach(() => {
    configMock.reset()
  })

  it('maps supplementary ACL data to the S3 SDK ACL response', async () => {
    //Given Config data containing canonical-user and URI group ACL grants
    configMock.on(SelectAggregateResourceConfigCommand).resolves({
      Results: [
        createBucketResult({
          owner: { id: 'owner-canonical-id', displayName: 'bucket-owner' },
          grantSet: [
            {
              grantee: { id: 'reader-canonical-id', type: 'CanonicalUser' },
              permission: 'READ'
            },
            {
              grantee: { uri: 'http://acs.amazonaws.com/groups/global/AllUsers' },
              permission: 'READ_ACP'
            }
          ]
        })
      ]
    })
    const client = createClient()

    //When buckets are listed then their ACL is requested
    await client.send(new ListBucketsCommand({ BucketRegion: region }))
    const acl = await client.send(new GetBucketAclCommand({ Bucket: bucketName }))

    //Then the Config shape is mapped to the SDK response shape
    expect(acl).toEqual({
      Owner: { ID: 'owner-canonical-id', DisplayName: 'bucket-owner' },
      Grants: [
        {
          Grantee: { ID: 'reader-canonical-id', Type: 'CanonicalUser' },
          Permission: 'READ'
        },
        {
          Grantee: {
            URI: 'http://acs.amazonaws.com/groups/global/AllUsers',
            Type: 'Group'
          },
          Permission: 'READ_ACP'
        }
      ]
    })
    expect(
      configMock.commandCalls(SelectAggregateResourceConfigCommand)[0]?.args[0].input.Expression
    ).toContain('supplementaryConfiguration.AccessControlList')
  })

  it('returns an empty ACL response when Config has no supplementary ACL data', async () => {
    //Given Config data without supplementary ACL data
    configMock.on(SelectAggregateResourceConfigCommand).resolves({
      Results: [createBucketResult()]
    })
    const client = createClient()

    //When buckets are listed then their ACL is requested
    await client.send(new ListBucketsCommand({ BucketRegion: region }))
    const acl = await client.send(new GetBucketAclCommand({ Bucket: bucketName }))

    //Then no ACL fields are synthesized
    expect(acl).toEqual({})
  })
})
