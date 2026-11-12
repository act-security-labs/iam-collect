import { isCloudFrontIdentityArn, splitArnParts } from '@actsecurity/iam-utils'
import { type Indexer } from '../indexer.js'

/** Metadata collected for a CloudFront origin access identity. */
interface OriginAccessIdentityMetadata {
  arn: string
  id: string
}

const indexName = 'cloudfront-oai-to-accounts'

/** Map CloudFront origin access identity IDs to their owning accounts within a partition. */
export const CloudFrontOriginAccessIdentitiesIndexer: Indexer<Record<string, string>> = {
  awsService: 'cloudfront',
  name: 'originAccessIdentitiesToAccounts',
  getCache: async (storage) => storage.getIndex(indexName, {}),
  saveCache: async (storage, cache, lockId) => storage.saveIndex(indexName, cache, lockId),
  updateCache: async (existingCache, accountId, _regions, storage) => {
    // OAIs are global: regional filters cannot limit a complete account refresh.
    const identities = await storage.findResourceMetadata<OriginAccessIdentityMetadata>(accountId, {
      service: 'cloudfront',
      resourceType: 'origin-access-identity'
    })
    const ids = new Set<string>()
    for (const identity of identities) {
      if (typeof identity?.arn !== 'string' || !isCloudFrontIdentityArn(identity.arn)) {
        throw new Error(
          `Invalid CloudFront origin access identity metadata for account ${accountId}`
        )
      }
      const arn = splitArnParts(identity.arn)
      if (arn.accountId !== accountId || arn.resourcePath !== identity.id) {
        throw new Error(
          `Invalid CloudFront origin access identity metadata for account ${accountId}`
        )
      }
      if (Object.hasOwn(existingCache, identity.id) && existingCache[identity.id] !== accountId) {
        throw new Error(
          `CloudFront origin access identity ${identity.id} has multiple owning accounts: ${existingCache[identity.id]} and ${accountId}`
        )
      }
      ids.add(identity.id)
    }

    // Only mutate the cache after all reads and validation have succeeded.
    for (const [id, owner] of Object.entries(existingCache)) {
      if (owner === accountId) {
        delete existingCache[id]
      }
    }
    for (const id of ids) {
      existingCache[id] = accountId
    }
  }
}
