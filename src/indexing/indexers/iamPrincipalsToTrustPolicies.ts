import { loadPolicy, type Policy } from '@actsecurity/iam-policy'
import { type Indexer } from '../indexer.js'

interface PrincipalsToTrustPoliciesIndex {
  [key: string]: Partial<Record<'principal' | 'notprincipal', Record<string, string[]>>>
}

const indexName = 'principals-to-trust-policies'

export const IamPrincipalsToTrustPoliciesIndexer: Indexer<PrincipalsToTrustPoliciesIndex> = {
  awsService: 'iam',
  name: 'principalsToTrustPolicies',
  getCache: async (storage) => {
    const data = await storage.getIndex(indexName, {})
    return data
  },
  saveCache: async (storage, cache, lockId) => {
    return storage.saveIndex(indexName, cache, lockId)
  },
  updateCache: async (existingCache, accountId, regions, storage) => {
    // Delete any existing record for the account
    existingCache[accountId] = {}

    // Get all the trust policies for the account
    const roles = await storage.findResourceMetadata<{ arn: string }>(accountId, {
      service: 'iam',
      resourceType: 'role',
      account: accountId
    })

    for (const role of roles) {
      const trustPolicy = await storage.getResourceMetadata<any, any>(
        accountId,
        role.arn,
        'trust-policy'
      )
      if (trustPolicy) {
        const parsedPolicy = loadPolicy(trustPolicy)
        updateCacheForPolicy(existingCache, accountId, role.arn, parsedPolicy)
      }
    }
  }
}

function updateCacheForPolicy(
  cache: PrincipalsToTrustPoliciesIndex,
  accountId: string,
  roleArn: string,
  policy: Policy
) {
  for (const statement of policy.statements()) {
    if (statement.isAllow()) {
      if (statement.isPrincipalStatement()) {
        for (const principal of statement.principals()) {
          updateCacheForPrincipal(cache, accountId, roleArn, 'principal', principal.value())
        }
      } else if (statement.isNotPrincipalStatement()) {
        for (const principal of statement.notPrincipals()) {
          updateCacheForPrincipal(cache, accountId, roleArn, 'notprincipal', principal.value())
        }
      }
    }
  }
}

function updateCacheForPrincipal(
  cache: PrincipalsToTrustPoliciesIndex,
  accountId: string,
  roleArn: string,
  type: 'principal' | 'notprincipal',
  principal: string
) {
  if (!cache[accountId][type]) {
    cache[accountId][type] = {}
  }

  if (!cache[accountId][type][principal]) {
    cache[accountId][type][principal] = []
  }

  cache[accountId][type][principal].push(roleArn)
}
