import {
  GetTopicAttributesCommand,
  ListTagsForResourceCommand,
  ListTopicsCommand,
  SNSClient
} from '@aws-sdk/client-sns'
import { log } from '@actsecurity/log'
import { type Sync } from '../sync.js'
import { createResourceSyncType, createTypedSyncOperation } from '../typedSync.js'

export const SnsTopicsSync: Sync = createTypedSyncOperation(
  'sns',
  'topics',
  createResourceSyncType({
    client: SNSClient,
    command: ListTopicsCommand,
    paginationConfig: {
      inputKey: 'NextToken',
      outputKey: 'NextToken'
    },
    key: 'Topics',
    arn: (topic) => topic.TopicArn!,
    resourceTypeParts: (account, region) => ({
      service: 'sns',
      account,
      region
    }),
    extraFields: {
      tags: async (client, topic) => {
        const tagResult = await client.send(
          new ListTagsForResourceCommand({
            ResourceArn: topic.TopicArn!
          })
        )
        return tagResult.Tags
      },
      attributes: async (client, topic) => {
        const attributes = await client.send(
          new GetTopicAttributesCommand({
            TopicArn: topic.TopicArn!
          })
        )
        return attributes.Attributes
      }
    },
    tags: (topic) => topic.extraFields.tags,
    results: (topic) => ({
      metadata: {
        name: topic.TopicArn!.split(':').pop()!,
        displayName: topic.extraFields.attributes?.DisplayName,
        keyId: topic.extraFields.attributes?.KmsMasterKeyId,
        owner: topic.extraFields.attributes?.Owner
      },
      policy: topicPolicy(topic.TopicArn!, topic.extraFields.attributes)
    })
  })
)

/**
 * Parse the SNS topic policy from attributes.
 *
 * @param attributes the attributes of the SNS topic
 * @returns the parsed policy or undefined if parsing fails or the policy is not present
 */
function topicPolicy(
  topicArn: string,
  attributes: Record<string, string> | undefined
): any | undefined {
  if (attributes?.['Policy']) {
    try {
      return JSON.parse(attributes['Policy'])
    } catch (e) {
      log.error('Failed to parse SNS topic policy', e, { topicArn })
      return undefined
    }
  }
  return undefined
}
