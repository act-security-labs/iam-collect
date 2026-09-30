import { splitArnParts } from '@actsecurity/iam-utils'
import { type Indexer } from '../indexer.js'

interface ApiGatewayMetadata {
  arn: string
}

const indexName = 'apigateways-to-accounts'

export const ApiGatewayIndexer: Indexer<Record<string, string>> = {
  awsService: 'apigateway',
  name: 'apigatewaysToAccounts',
  getCache: async (storage) => {
    const data = await storage.getIndex(indexName, {})
    return data
  },
  saveCache: async (storage, cache, lockId) => {
    return storage.saveIndex(indexName, cache, lockId)
  },
  updateCache: async (existingCache, accountId, regions, storage) => {
    const regionsSet = new Set(regions)
    const matchesRegion = (region: string | undefined) => {
      return region && (regionsSet.size == 0 || regionsSet.has(region))
    }
    const currentCacheKeys = Object.keys(existingCache)

    // Remove all existing gateways for the account in the specified regions
    for (const key of currentCacheKeys) {
      const arnParts = splitArnParts(key)
      if (existingCache[key] == accountId && matchesRegion(arnParts.region)) {
        delete existingCache[key]
      }
    }

    const currentGateways: ApiGatewayMetadata[] = []

    if (regions.length == 0) {
      const gateways = await storage.findResourceMetadata<ApiGatewayMetadata>(accountId, {
        service: 'apigateway',
        region: '*',
        resourceType: 'restapis'
      })
      currentGateways.push(...gateways)
    } else {
      for (const region of regions) {
        const gateways = await storage.findResourceMetadata<ApiGatewayMetadata>(accountId, {
          service: 'apigateway',
          region: region,
          resourceType: 'restapis'
        })
        currentGateways.push(...gateways)
      }
    }

    // Add the new gateways to the cache
    for (const gateway of currentGateways) {
      existingCache[gateway.arn] = accountId
    }
  }
}
