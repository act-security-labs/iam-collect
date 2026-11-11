import {
  CloudFrontClient,
  ListCloudFrontOriginAccessIdentitiesCommand,
  type CloudFrontOriginAccessIdentitySummary
} from '@aws-sdk/client-cloudfront'
import { withDnsRetry } from '../../utils/client-tools.js'
import { type Sync, syncData } from '../sync.js'

/** Collect account-owned CloudFront origin access identities and their S3 canonical user IDs. */
export const CloudFrontOriginAccessIdentitiesSync: Sync = {
  awsService: 'cloudfront',
  name: 'originAccessIdentities',
  global: true,
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const client = syncOptions.clientPool.client(CloudFrontClient, credentials, region, endpoint)
    const identities = await listOriginAccessIdentities(client)
    const records = identities.map((identity) => {
      const arn = `arn:${credentials.partition}:cloudfront::${accountId}:origin-access-identity/${identity.Id}`
      return {
        arn,
        metadata: {
          arn,
          id: identity.Id,
          name: identity.Id,
          comment: identity.Comment,
          s3CanonicalUserId: identity.S3CanonicalUserId
        }
      }
    })

    await syncData(
      records,
      storage,
      accountId,
      { service: 'cloudfront', account: accountId, resourceType: 'origin-access-identity' },
      syncOptions.writeOnly
    )
  }
}

/**
 * Fetch every page before returning so a partial collection never replaces stored identities.
 *
 * @param client The CloudFront client scoped to the owning account.
 * @returns The complete list, including canonical IDs used to resolve S3 policy principals.
 * @throws If any page fails or contains incomplete pagination or identity data.
 */
async function listOriginAccessIdentities(
  client: CloudFrontClient
): Promise<CloudFrontOriginAccessIdentitySummary[]> {
  const identities: CloudFrontOriginAccessIdentitySummary[] = []
  const markers = new Set<string>()
  let marker: string | undefined
  do {
    const response = await withDnsRetry(() =>
      client.send(new ListCloudFrontOriginAccessIdentitiesCommand({ Marker: marker }))
    )
    const page = response.CloudFrontOriginAccessIdentityList
    if (!page || typeof page.IsTruncated !== 'boolean' || typeof page.Quantity !== 'number') {
      throw new Error('Invalid CloudFront origin access identity list response')
    }
    const items = page.Items ?? []
    if (
      page.Quantity < items.length ||
      (page.Quantity > 0 && items.length === 0) ||
      items.some((item) => !item.Id || !item.S3CanonicalUserId)
    ) {
      throw new Error('Incomplete CloudFront origin access identity list response')
    }
    identities.push(...items)
    if (!page.IsTruncated) {
      break
    }
    if (!page.NextMarker || markers.has(page.NextMarker)) {
      throw new Error('Invalid CloudFront origin access identity pagination marker')
    }
    markers.add(page.NextMarker)
    marker = page.NextMarker
  } while (true)
  return identities
}
