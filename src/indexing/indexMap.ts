import { type AwsService, lowerCaseService } from '../services.js'
import { type Indexer } from './indexer.js'
import { AccountOrganizationIndexer } from './indexers/accountOrgs.js'
import { ApiGatewayIndexer } from './indexers/apigateways.js'
import { S3BucketIndexer } from './indexers/buckets.js'
import { CloudFrontOriginAccessIdentitiesIndexer } from './indexers/cloudFrontOriginAccessIdentities.js'
import { IamPrincipalsToTrustPoliciesIndexer } from './indexers/iamPrincipalsToTrustPolicies.js'
import { VpcEndpointIndexer } from './indexers/vpcs.js'

const allIndexers: Indexer<any>[] = [
  AccountOrganizationIndexer,
  ApiGatewayIndexer,
  CloudFrontOriginAccessIdentitiesIndexer,
  IamPrincipalsToTrustPoliciesIndexer,
  S3BucketIndexer,
  VpcEndpointIndexer
]

const indexMap = new Map<string, Indexer<any>[]>()

for (const indexer of allIndexers) {
  const service = lowerCaseService(indexer.awsService)
  if (!indexMap.has(service)) {
    indexMap.set(service, [])
  }
  indexMap.get(service)!.push(indexer)
}

/**
 * Get the indexers for a given AWS service.
 *
 * @param awsService the AWS service to get the indexers for
 * @returns An array of indexers that are for the specified service.
 */
export function getIndexersForService(awsService: AwsService): Indexer<any>[] {
  return indexMap.get(lowerCaseService(awsService)) ?? []
}
