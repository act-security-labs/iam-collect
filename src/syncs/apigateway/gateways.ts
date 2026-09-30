import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway'
import { log } from '@actsecurity/log'
import { type Sync } from '../sync.js'
import { createResourceSyncType, createTypedSyncOperation } from '../typedSync.js'

export const RestApisSync: Sync = createTypedSyncOperation(
  'apigateway',
  'gateways',
  createResourceSyncType({
    client: APIGatewayClient,
    command: GetRestApisCommand,
    key: 'items',
    paginationConfig: {
      inputKey: 'position',
      outputKey: 'position'
    },
    arn: (api, region, account, partition) => restApiArn(api.id!, region, partition),
    tags: (api) => api.tags,
    resourceTypeParts: (account, region) => ({
      account,
      service: 'apigateway',
      region,
      resourceType: 'restapis'
    }),
    results: (api) => ({
      metadata: {
        id: api.id,
        name: api.name
      },
      policy: parseApiGatewayPolicy(api.id!, api.policy)
    })
  })
)

/**
 * Get the ARN for an API Gateway REST API.
 *
 * @param apiId the ID of the API Gateway REST API
 * @param region the AWS region of the API Gateway
 * @param partition the AWS partition (aws, aws-cn, aws-us-gov)
 * @returns the ARN of the API Gateway REST API
 */
function restApiArn(apiId: string, region: string, partition: string): string {
  return `arn:${partition}:apigateway:${region}::/restapis/${apiId}`
}

/**
 * Parse the API Gateway policy string into a JSON object.
 * For some reason API Gateway policies can have \\\ at the start of every string
 * and any forward slash is escaped with a double backslash (\\/)
 *
 * @param apiId the ID of the API Gateway
 * @param policy the policy string to parse
 * @returns the parsed policy object or undefined if the policy is not provided
 */
export function parseApiGatewayPolicy(
  apiId: string,
  policy: string | undefined
): Record<string, any> | undefined {
  if (!policy) {
    return undefined
  }
  policy = policy.replace(/\\"/g, '"').replace(/\\\//g, '/')

  try {
    return JSON.parse(policy)
  } catch (error) {
    log.error('Failed to parse API Gateway policy', { apiId }, error)
    throw new Error(`Unable to parse policy for API Gateway ${apiId}`)
  }
}
