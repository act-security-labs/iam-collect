import {
  GetBucketAclCommand,
  type GetBucketAclOutput,
  type Grantee,
  GetBucketEncryptionCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  ListDirectoryBucketsCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { AbstractClient } from '../../customClients/AbstractClient.js'
import { ResourceNotFoundException } from '../../customClients/ResourceNotFoundException.js'
import { stringifyIfPresent } from '../../utils/json.js'
import { type AwsConfigClientContext, awsConfigCommand } from '../AwsConfigClientContext.js'
import {
  executeConfigQuery,
  parseConfigItem,
  resourceStatusWhereClause
} from '../awsConfigUtils.js'

/**
 * AWS Config-based S3 client implementation
 */
export class AwsConfigS3Client extends AbstractClient<AwsConfigClientContext> {
  static readonly clientName = S3Client.name

  constructor(
    options: {
      credentials: AwsCredentialProviderWithMetaData
      region: string | undefined
    },
    customContext: AwsConfigClientContext
  ) {
    super(options, customContext)
  }

  protected registerCommands(): void {
    this.registerCommand(AwsConfigGetBucketAclCommand)
    this.registerCommand(AwsConfigGetBucketPolicyCommand)
    this.registerCommand(AwsConfigGetBucketEncryptionCommand)
    this.registerCommand(AwsConfigGetBucketTaggingCommand)
    this.registerCommand(AwsConfigGetPublicAccessBlockCommand)
    this.registerCommand(AwsConfigListBucketsCommand)
    this.registerCommand(AwsConfigListDirectoryBucketsCommand)
  }
}

/**
 * Config-based implementation of S3 ListBucketsCommand
 * Returns bucket listing from AWS Config inventory data
 */
const AwsConfigListBucketsCommand = awsConfigCommand({
  command: ListBucketsCommand,
  execute: async (input, context) => {
    // Query Config for S3 buckets
    const query = `
      SELECT
        arn,
        resourceName,
        configuration.name,
        configuration.creationDate,
        supplementaryConfiguration.AccessControlList,
        supplementaryConfiguration.BucketPolicy,
        supplementaryConfiguration.ServerSideEncryptionConfiguration,
        supplementaryConfiguration.PublicAccessBlockConfiguration,
        tags
      WHERE
        resourceType = 'AWS::S3::Bucket'
        AND awsRegion = '${input.BucketRegion}'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    const configResults = await executeConfigQuery(query, context)

    const buckets = configResults.map((resultString) => {
      const { configItem, configuration, supplementaryConfiguration, tags } =
        parseConfigItem(resultString)

      context.putCache(
        configItem.resourceName,
        'acl',
        supplementaryConfiguration?.AccessControlList
      )
      context.putCache(
        configItem.resourceName,
        'policy',
        supplementaryConfiguration?.BucketPolicy?.policyText
      )
      context.putCache(
        configItem.resourceName,
        'encryption',
        supplementaryConfiguration?.ServerSideEncryptionConfiguration
      )
      context.putCache(configItem.resourceName, 'tags', tags)
      context.putCache(
        configItem.resourceName,
        'publicAccessBlock',
        supplementaryConfiguration?.PublicAccessBlockConfiguration
      )

      return {
        Name: configuration?.name || configItem.resourceName,
        CreationDate: configuration?.creationDate ? new Date(configuration.creationDate) : undefined
      }
    })

    return {
      Buckets: buckets
    }
  }
})

/**
 * Config-based implementation of S3 ListDirectoryBucketsCommand
 * Uses AWS::S3Express::DirectoryBucket resource type
 */
const AwsConfigListDirectoryBucketsCommand = awsConfigCommand({
  command: ListDirectoryBucketsCommand,
  execute: async (input, context) => {
    const query = `
      SELECT
        arn,
        resourceId,
        resourceName,
        configuration.BucketEncryption,
        tags
      WHERE
        resourceType = 'AWS::S3Express::DirectoryBucket'
        AND awsRegion = '${context.region}'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    const results = await executeConfigQuery(query, context)

    const buckets =
      results?.map((resultString) => {
        const { configItem, configuration } = parseConfigItem(resultString)
        context.putCache(configItem.resourceName, 'policy', configuration?.PolicyDocument)
        context.putCache(configItem.resourceName, 'encryption', configuration?.BucketEncryption)

        return {
          Name: configItem.resourceName
        }
      }) || []

    return {
      Buckets: buckets
    }
  }
})

/**
 * Config-based implementation of S3 GetBucketAclCommand.
 *
 * @returns ACL owner and grants mapped from AWS Config supplementary data.
 */
const AwsConfigGetBucketAclCommand = awsConfigCommand({
  command: GetBucketAclCommand,
  execute: async (input, context) => {
    const { Bucket } = input
    if (!Bucket) {
      throw new Error('Bucket parameter is required')
    }

    return mapConfigAclToSdkOutput(context.getCache(Bucket, 'acl'))
  }
})

/**
 * Map an AWS Config access control list to the S3 GetBucketAcl output shape.
 *
 * @param acl the lower-camel AWS Config access control list
 * @returns the SDK-compatible bucket ACL output
 */
function mapConfigAclToSdkOutput(acl: any): GetBucketAclOutput {
  if (!acl) {
    return {}
  }

  return {
    Owner: acl.owner
      ? {
          ID: acl.owner.id,
          DisplayName: acl.owner.displayName
        }
      : undefined,
    Grants: acl.grantSet?.map((grant: any) => ({
      Grantee: mapConfigGranteeToSdk(grant.grantee),
      Permission: grant.permission
    }))
  }
}

/**
 * Map an AWS Config ACL grantee to the S3 SDK grantee shape.
 *
 * @param grantee the lower-camel AWS Config ACL grantee
 * @returns the SDK-compatible ACL grantee
 */
function mapConfigGranteeToSdk(grantee: any): Grantee | undefined {
  if (!grantee) {
    return undefined
  }

  return {
    ID: grantee.id,
    DisplayName: grantee.displayName,
    EmailAddress: grantee.emailAddress,
    URI: grantee.uri,
    Type:
      grantee.type ??
      (grantee.uri ? 'Group' : grantee.emailAddress ? 'AmazonCustomerByEmail' : 'CanonicalUser')
  }
}

/**
 * Config-based implementation of S3 GetBucketPolicyCommand
 * Returns bucket policy from AWS Config supplementary data
 */
const AwsConfigGetBucketPolicyCommand = awsConfigCommand({
  command: GetBucketPolicyCommand,
  execute: async (input, context) => {
    const { Bucket } = input
    if (!Bucket) {
      throw new Error('Bucket parameter is required')
    }

    if (isDirectoryBucket(Bucket)) {
      const query = `
        SELECT
          resourceName,
          configuration.PolicyDocument
        WHERE
          resourceType = 'AWS::S3Express::BucketPolicy'
          AND resourceName = '${Bucket}'
          AND accountId = '${context.accountId}'
          AND awsRegion = '${context.region}'
          AND ${resourceStatusWhereClause}
      `

      const configResults = await executeConfigQuery(query, context)

      if (configResults.length === 0) {
        throw new ResourceNotFoundException(`Bucket '${Bucket}' not found`)
      }

      const { configuration } = parseConfigItem(configResults[0])

      return {
        Policy: JSON.stringify(configuration?.PolicyDocument)
      }
    }

    const cachedPolicy = context.getCache(Bucket, 'policy')
    return {
      Policy: stringifyIfPresent(cachedPolicy)
    }
  }
})

/**
 * Config-based implementation of S3 GetBucketEncryptionCommand
 * Returns bucket encryption configuration from AWS Config supplementary data
 */
const AwsConfigGetBucketEncryptionCommand = awsConfigCommand({
  command: GetBucketEncryptionCommand,
  execute: async (input, context) => {
    const { Bucket } = input

    if (!Bucket) {
      throw new Error('Bucket parameter is required')
    }

    if (isDirectoryBucket(Bucket)) {
      const encryptionConfig = context.getCache(Bucket, 'encryption')

      const seeConfig = encryptionConfig?.ServerSideEncryptionConfiguration?.at(0)
      if (!seeConfig) {
        // Return an empty result to indicate no encryption configuration is set
        return {}
      }

      return {
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: seeConfig.ServerSideEncryptionByDefault?.SSEAlgorithm,
                KMSMasterKeyID: seeConfig.ServerSideEncryptionByDefault?.KMSMasterKeyID
              },
              BucketKeyEnabled: seeConfig.BucketKeyEnabled
            }
          ]
        }
      }
    }

    const serverSideEncryption = context.getCache(Bucket, 'encryption')

    if (!serverSideEncryption) {
      // Return undefined to indicate no encryption configuration is set
      return undefined
    }

    // Convert Config encryption format to S3 ServerSideEncryptionConfiguration format
    const rules =
      serverSideEncryption.rules?.map((rule: any) => ({
        ApplyServerSideEncryptionByDefault: {
          SSEAlgorithm: rule.applyServerSideEncryptionByDefault?.sseAlgorithm,
          KMSMasterKeyID: rule.applyServerSideEncryptionByDefault?.kmsMasterKeyID
        },
        BucketKeyEnabled: rule.bucketKeyEnabled
      })) || []

    return {
      ServerSideEncryptionConfiguration: {
        Rules: rules
      }
    }
  }
})

/**
 * Config-based implementation of S3 GetBucketTaggingCommand
 * Returns bucket tags from AWS Config tags data
 */
const AwsConfigGetBucketTaggingCommand = awsConfigCommand({
  command: GetBucketTaggingCommand,
  execute: async (input, context) => {
    const { Bucket } = input
    if (!Bucket) {
      throw new Error('Bucket parameter is required')
    }

    const tags = context.getCache(Bucket, 'tags')
    return {
      TagSet: tags
    }
  }
})

/**
 * Config-based implementation of S3 GetPublicAccessBlockCommand
 * Returns public access block configuration from AWS Config supplementary data
 */
const AwsConfigGetPublicAccessBlockCommand = awsConfigCommand({
  command: GetPublicAccessBlockCommand,
  execute: async (input, context) => {
    const { Bucket } = input
    if (!Bucket) {
      throw new Error('Bucket parameter is required')
    }

    const publicAccessBlock = context.getCache(Bucket, 'publicAccessBlock')

    if (!publicAccessBlock) {
      // Return undefined to indicate no public access block configuration is set
      return undefined
    }

    return {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: publicAccessBlock.blockPublicAcls,
        BlockPublicPolicy: publicAccessBlock.blockPublicPolicy,
        IgnorePublicAcls: publicAccessBlock.ignorePublicAcls,
        RestrictPublicBuckets: publicAccessBlock.restrictPublicBuckets
      }
    }
  }
})

function isDirectoryBucket(bucketName: string): boolean {
  return bucketName.endsWith('-x-s3')
}
