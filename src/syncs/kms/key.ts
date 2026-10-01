import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  KMSClient,
  ListKeysCommand,
  ListResourceTagsCommand
} from '@aws-sdk/client-kms'
import { runAndCatch404 } from '../../utils/client-tools.js'
import { createResourceSyncType, createTypedSyncOperation } from '../typedSync.js'

export const KeySync = createTypedSyncOperation(
  'kms',
  'keys',
  createResourceSyncType({
    client: KMSClient,
    command: ListKeysCommand,
    key: 'Keys',
    paginationConfig: {
      inputKey: 'Marker',
      outputKey: 'NextMarker'
    },
    resourceTypeParts: (accountId: string, region: string) => ({
      service: 'kms',
      resourceType: 'key',
      account: accountId,
      region: region
    }),
    extraFields: {
      keyManager: async (client, key) => {
        return runAndCatch404(async () => {
          const describeResult = await client.send(new DescribeKeyCommand({ KeyId: key.KeyId }))
          return describeResult.KeyMetadata?.KeyManager
        })
      },
      tags: async (client, key) => {
        return runAndCatch404(async () => {
          const tagResult = await client.send(new ListResourceTagsCommand({ KeyId: key.KeyId }))
          return tagResult.Tags
        })
      },
      policy: async (client, key) => {
        return runAndCatch404(async () => {
          const policyResult = await client.send(
            new GetKeyPolicyCommand({ KeyId: key.KeyId, PolicyName: 'default' })
          )
          if (policyResult.Policy) {
            return JSON.parse(policyResult.Policy)
          }
          return undefined
        })
      }
    },
    tags: (func) => func.extraFields.tags,
    arn: (func) => func.KeyArn!,
    results: (func) => ({
      metadata: {
        id: func.KeyId,
        ...(func.extraFields.keyManager === 'AWS' ? { awsManaged: true } : {})
      },
      policy: func.extraFields.policy
    })
  })
)
