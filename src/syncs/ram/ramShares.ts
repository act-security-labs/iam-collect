import { ResourceOwner } from '@aws-sdk/client-api-gateway'
import { GetResourcePoliciesCommand, ListResourcesCommand, RAMClient } from '@aws-sdk/client-ram'
import { splitArnParts } from '@actsecurity/iam-utils'
import { parseIfPresent } from '../../utils/json.js'
import { type Sync } from '../sync.js'
import { paginateResource } from '../typedSync.js'

export const RamResourcesSync: Sync = {
  awsService: 'ram',
  name: 'resourcePolicies',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const ramClient = syncOptions.clientPool.client(RAMClient, credentials, region, endpoint)

    // List all the resources
    const resources = await paginateResource(
      ramClient,
      ListResourcesCommand,
      'resources',
      {
        inputKey: 'nextToken',
        outputKey: 'nextToken'
      },
      {
        resourceOwner: ResourceOwner.SELF
      }
    )

    // Group shares by resource ARN
    const resourceMap = new Map<string, Set<string>>()
    for (const resource of resources) {
      const arn = resource.arn!
      if (!resourceMap.has(arn)) {
        resourceMap.set(arn, new Set())
      }
      if (resource.resourceShareArn) {
        resourceMap.get(arn)!.add(resource.resourceShareArn)
      }
    }

    // Group ARNs by their region
    const regionMap = new Map<string, string[]>()
    for (const arn of resourceMap.keys()) {
      const parts = splitArnParts(arn)
      const arnRegion = parts.region || ''
      if (!regionMap.has(arnRegion)) {
        regionMap.set(arnRegion, [])
      }
      regionMap.get(arnRegion)!.push(arn)
    }

    // Sync and save per region
    for (const [arnRegion, regionArns] of regionMap) {
      if (!syncOptions.writeOnly) {
        await storage.syncRamResources(accountId, arnRegion, regionArns)
      }

      for (const arn of regionArns) {
        const policies = await paginateResource(
          ramClient,
          GetResourcePoliciesCommand,
          'policies',
          { inputKey: 'nextToken', outputKey: 'nextToken' },
          { resourceArns: [arn] }
        )

        const policy = parseIfPresent(policies.at(0))

        const shares = Array.from(resourceMap.get(arn)!)

        await storage.saveRamResource(accountId, arn, {
          arn,
          shares,
          policy
        })
      }
    }
  }
}
