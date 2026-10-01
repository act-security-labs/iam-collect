import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  KMSClient,
  ListKeysCommand,
  ListResourceTagsCommand
} from '@aws-sdk/client-kms'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { AbstractClient } from '../../customClients/AbstractClient.js'
import { ResourceNotFoundException } from '../../customClients/ResourceNotFoundException.js'
import { type AwsConfigClientContext, awsConfigCommand } from '../AwsConfigClientContext.js'
import {
  executeConfigQuery,
  parseConfigItem,
  resourceStatusWhereClause
} from '../awsConfigUtils.js'

/**
 * KMS client implementation using AWS Config as data source
 */
export class AwsConfigKmsClient extends AbstractClient<AwsConfigClientContext> {
  static readonly clientName = KMSClient.name

  constructor(
    options: {
      credentials: AwsCredentialProviderWithMetaData
      region: string | undefined
    },
    customContext: AwsConfigClientContext
  ) {
    super(options, customContext)
  }

  /**
   * Register all KMS command implementations
   */
  protected registerCommands(): void {
    this.registerCommand(AwsConfigListKeysCommand)
    this.registerCommand(AwsConfigDescribeKeyCommand)
    this.registerCommand(AwsConfigGetKeyPolicyCommand)
    this.registerCommand(AwsConfigListResourceTagsCommand)
  }
}

/**
 * Config-based implementation of KMS ListKeysCommand
 */
const AwsConfigListKeysCommand = awsConfigCommand({
  command: ListKeysCommand,
  execute: async (input, context) => {
    const query = `
      SELECT
        arn,
        resourceId,
        configuration.keyManager,
        supplementaryConfiguration.Policy,
        tags
      WHERE
        resourceType = 'AWS::KMS::Key'
        AND awsRegion = '${context.region}'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    const results = await executeConfigQuery(query, context)

    const keys = results.map((resultString) => {
      const { configItem, configuration, supplementaryConfiguration, tags } =
        parseConfigItem(resultString)

      // Cache data that will be needed by other commands
      // Use KeyId as cache key for both GetKeyPolicyCommand and ListResourceTagsCommand
      context.putCache(configItem.resourceId, 'keyManager', configuration?.keyManager)
      context.putCache(
        configItem.resourceId,
        'supplementaryConfiguration',
        supplementaryConfiguration
      )
      context.putCache(configItem.resourceId, 'tags', tags)

      return {
        KeyId: configItem.resourceId,
        KeyArn: configItem.arn
      }
    })

    return {
      Keys: keys
    }
  }
})

/**
 * Config-based implementation of KMS DescribeKeyCommand
 */
const AwsConfigDescribeKeyCommand = awsConfigCommand({
  command: DescribeKeyCommand,
  execute: async (input, context) => {
    const { KeyId } = input

    if (!KeyId) {
      throw new ResourceNotFoundException('KeyId is required')
    }

    const keyManager = context.getCache(KeyId, 'keyManager')

    return {
      KeyMetadata: keyManager ? { KeyId, KeyManager: keyManager } : undefined
    }
  }
})

/**
 * Config-based implementation of KMS GetKeyPolicyCommand
 */
const AwsConfigGetKeyPolicyCommand = awsConfigCommand({
  command: GetKeyPolicyCommand,
  execute: async (input, context) => {
    const { KeyId, PolicyName = 'default' } = input

    if (!KeyId) {
      throw new ResourceNotFoundException('KeyId is required')
    }

    const supplementaryConfiguration = context.getCache(KeyId, 'supplementaryConfiguration')
    const keyPolicy = supplementaryConfiguration?.Policy

    if (!keyPolicy) {
      throw new ResourceNotFoundException(
        `Key policy '${PolicyName}' not found for KeyId: ${KeyId}`
      )
    }

    return {
      Policy: keyPolicy
    }
  }
})

/**
 * Config-based implementation of KMS ListResourceTagsCommand
 */
const AwsConfigListResourceTagsCommand = awsConfigCommand({
  command: ListResourceTagsCommand,
  execute: async (input, context) => {
    const { KeyId } = input

    if (!KeyId) {
      return {
        Tags: []
      }
    }

    const tags = context.getCache(KeyId, 'tags')

    if (!tags) {
      return {
        Tags: []
      }
    }

    return {
      Tags: tags as any
    }
  }
})
