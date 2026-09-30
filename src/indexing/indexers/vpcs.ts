import { splitArnParts } from '@actsecurity/iam-utils'
import { type Indexer } from '../indexer.js'

interface VpcEndpointMetadata {
  vpc: string
  arn: string
  serviceName: string
}

interface VpcMetadata {
  arn: string
}

export interface VpcIndex {
  vpcs: Record<string, { arn: string; endpoints: { id: string; service: string }[] }>

  endpoints: Record<string, { arn: string; vpc: string }>
}

const indexName = 'vpcs'

export const VpcEndpointIndexer: Indexer<VpcIndex> = {
  awsService: 'ec2',
  name: 'vpcs',
  getCache: async (storage) => {
    const data = await storage.getIndex(indexName, {
      vpcs: {},
      endpoints: {}
    })
    return data as any
  },
  saveCache: async (storage, cache, lockId) => {
    return storage.saveIndex(indexName, cache, lockId)
  },
  updateCache: async (existingCache, accountId, regions, storage) => {
    const regionsSet = new Set(regions)
    const matchesRegion = (region: string | undefined) => {
      return region && (regionsSet.size == 0 || regionsSet.has(region))
    }

    const { vpcs, endpoints } = existingCache

    const currentVpcKeys = Object.keys(vpcs)
    const currentEndpointKeys = Object.keys(endpoints)

    // Remove all existing vpcs for the account in the specified regions
    for (const key of currentVpcKeys) {
      const arnParts = splitArnParts(vpcs[key].arn)
      if (arnParts.accountId == accountId && matchesRegion(arnParts.region)) {
        delete vpcs[key]
      }
    }

    for (const key of currentEndpointKeys) {
      const arnParts = splitArnParts(endpoints[key].arn)
      if (arnParts.accountId == accountId && matchesRegion(arnParts.region)) {
        delete endpoints[key]
      }
    }

    const currentEndpoints: VpcEndpointMetadata[] = []
    const currentVpcs: VpcMetadata[] = []

    if (regions.length == 0) {
      const gateways = await storage.findResourceMetadata<VpcEndpointMetadata>(accountId, {
        service: 'ec2',
        region: '*',
        resourceType: 'vpc-endpoint'
      })
      currentEndpoints.push(...gateways)

      const vpcs = await storage.findResourceMetadata<VpcMetadata>(accountId, {
        service: 'ec2',
        region: '*',
        resourceType: 'vpc'
      })
      currentVpcs.push(...vpcs)
    } else {
      for (const region of regions) {
        const gateways = await storage.findResourceMetadata<VpcEndpointMetadata>(accountId, {
          service: 'ec2',
          region: region,
          resourceType: 'vpc-endpoint'
        })
        currentEndpoints.push(...gateways)
        const vpcs = await storage.findResourceMetadata<VpcMetadata>(accountId, {
          service: 'ec2',
          region: '*',
          resourceType: 'vpc'
        })
        currentVpcs.push(...vpcs)
      }
    }

    for (const endpoint of currentEndpoints) {
      const vpcId = splitArnParts(endpoint.vpc).resourcePath!
      const endpointId = splitArnParts(endpoint.arn).resourcePath!
      endpoints[endpointId] = { arn: endpoint.arn, vpc: vpcId }

      if (!vpcs[vpcId]) {
        vpcs[vpcId] = { arn: endpoint.vpc, endpoints: [] }
      }
      const service = endpoint.serviceName.split('.').slice(3).join('.')
      vpcs[vpcId].endpoints.push({ id: endpointId, service })
    }
    for (const vpc of currentVpcs) {
      const vpcId = splitArnParts(vpc.arn).resourcePath!
      if (!vpcs[vpcId]) {
        vpcs[vpcId] = { arn: vpc.arn, endpoints: [] }
      }
    }

    // return {
    //   vpcs,
    //   endpoints
    // }
  }
}
