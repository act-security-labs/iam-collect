import {
  ConfigServiceClient,
  SelectAggregateResourceConfigCommand
} from '@aws-sdk/client-config-service'
import { DescribeKeyCommand, ListKeysCommand } from '@aws-sdk/client-kms'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { AwsConfigKmsClient } from './AwsConfigKmsClient.js'

const configMock = mockClient(ConfigServiceClient)
const accountId = '111111111111'
const region = 'us-east-1'
const aggregatorName = 'test-aggregator'
const credentials: AwsCredentialProviderWithMetaData = {
  accountId,
  partition: 'aws',
  cacheKey: 'test-credentials',
  provider: async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key'
  })
}

function createClient(): AwsConfigKmsClient {
  return new AwsConfigKmsClient(
    { credentials, region },
    {
      configClient: new ConfigServiceClient({}),
      aggregatorName,
      configCredentials: credentials
    }
  )
}

describe('AwsConfigKmsClient', () => {
  afterEach(() => {
    configMock.reset()
  })

  it('provides an AWS key manager from Config', async () => {
    //Given a Config KMS key with an AWS key manager
    const keyId = 'aws-managed-key'
    configMock.on(SelectAggregateResourceConfigCommand).resolves({
      Results: [
        JSON.stringify({
          arn: `arn:aws:kms:${region}:${accountId}:key/${keyId}`,
          resourceId: keyId,
          configuration: JSON.stringify({ keyManager: 'AWS' }),
          supplementaryConfiguration: JSON.stringify({}),
          tags: JSON.stringify({})
        })
      ]
    })
    const client = createClient()

    //When the key is listed then described
    await client.send(new ListKeysCommand({}))
    const result = await client.send(new DescribeKeyCommand({ KeyId: keyId }))

    //Then the key manager is returned from the cached Config configuration
    expect(result).toEqual({ KeyMetadata: { KeyId: keyId, KeyManager: 'AWS' } })
    expect(
      configMock.commandCalls(SelectAggregateResourceConfigCommand)[0]?.args[0].input.Expression
    ).toContain('configuration.keyManager')
  })

  it('omits key manager metadata when Config does not provide it', async () => {
    //Given a Config KMS key without a key manager
    const keyId = 'unknown-managed-key'
    configMock.on(SelectAggregateResourceConfigCommand).resolves({
      Results: [
        JSON.stringify({
          arn: `arn:aws:kms:${region}:${accountId}:key/${keyId}`,
          resourceId: keyId,
          configuration: JSON.stringify({}),
          supplementaryConfiguration: JSON.stringify({}),
          tags: JSON.stringify({})
        })
      ]
    })
    const client = createClient()

    //When the key is listed then described
    await client.send(new ListKeysCommand({}))
    const result = await client.send(new DescribeKeyCommand({ KeyId: keyId }))

    //Then no key manager is synthesized
    expect(result).toEqual({ KeyMetadata: undefined })
  })
})
