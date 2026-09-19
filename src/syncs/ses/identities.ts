import {
  GetIdentityPoliciesCommand,
  GetIdentityVerificationAttributesCommand,
  ListIdentitiesCommand,
  ListIdentityPoliciesCommand,
  SESClient
} from '@aws-sdk/client-ses'
import { type Job } from '@cloud-copilot/job'
import { log } from '@cloud-copilot/log'
import { runAndCatchAccessDeniedWithLog, withDnsRetry } from '../../utils/client-tools.js'
import { parseIfPresent } from '../../utils/json.js'
import { type DataRecord, type Sync, syncData } from '../sync.js'
import { paginateResource } from '../typedSync.js'

const VERIFICATION_BATCH_SIZE = 100

/**
 * Sync verified SES identities and their named sending authorization policies.
 */
export const SesIdentitiesSync: Sync = {
  awsService: 'ses',
  name: 'identities',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const sesClient = syncOptions.clientPool.client(SESClient, credentials, region, endpoint)
    const identities = await withDnsRetry(() =>
      paginateResource(sesClient, ListIdentitiesCommand, 'Identities', {
        inputKey: 'NextToken',
        outputKey: 'NextToken'
      })
    )
    const verifiedIdentities = await getVerifiedIdentities(sesClient, identities)

    const jobs: Job<DataRecord, { identity: string }>[] = verifiedIdentities.map((identity) => ({
      properties: { identity },
      execute: async () =>
        collectIdentity(sesClient, identity, accountId, region, credentials.partition)
    }))
    const results = await Promise.all(syncOptions.workerPool.enqueueAll(jobs))
    const records: DataRecord[] = []

    for (const result of results) {
      if (result.status === 'rejected') {
        const identity = result.properties.identity as string
        log.error('Failed to collect SES identity policies', result.reason, { identity, region })
        throw new Error(`Failed to collect policies for SES identity ${identity}`)
      }
      records.push(result.value)
    }

    await syncData(
      records,
      storage,
      accountId,
      {
        service: 'ses',
        resourceType: 'identity',
        account: accountId,
        region
      },
      syncOptions.writeOnly
    )
  }
}

async function getVerifiedIdentities(
  sesClient: SESClient,
  identities: string[]
): Promise<string[]> {
  const verifiedIdentities: string[] = []

  for (let index = 0; index < identities.length; index += VERIFICATION_BATCH_SIZE) {
    const batch = identities.slice(index, index + VERIFICATION_BATCH_SIZE)
    const response = await withDnsRetry(() =>
      sesClient.send(new GetIdentityVerificationAttributesCommand({ Identities: batch }))
    )

    for (const identity of batch) {
      if (response.VerificationAttributes?.[identity]?.VerificationStatus === 'Success') {
        verifiedIdentities.push(identity)
      }
    }
  }

  return verifiedIdentities
}

async function collectIdentity(
  sesClient: SESClient,
  identity: string,
  accountId: string,
  region: string,
  partition: string
): Promise<DataRecord> {
  const arn = identityArn(partition, region, accountId, identity)
  const policies = await runAndCatchAccessDeniedWithLog(
    arn,
    'ses',
    'identity',
    'policies',
    async () => {
      const listResponse = await withDnsRetry(() =>
        sesClient.send(new ListIdentityPoliciesCommand({ Identity: identity }))
      )
      const policyNames = listResponse.PolicyNames || []
      if (policyNames.length === 0) {
        return undefined
      }

      const response = await withDnsRetry(() =>
        sesClient.send(
          new GetIdentityPoliciesCommand({ Identity: identity, PolicyNames: policyNames })
        )
      )
      return Object.fromEntries(
        Object.entries(response.Policies || {}).map(([name, document]) => [
          name,
          parseIfPresent(document)
        ])
      )
    }
  )

  return {
    arn,
    metadata: {
      arn,
      name: identity,
      identityType: identity.includes('@') ? 'EmailAddress' : 'Domain'
    },
    policies
  }
}

function identityArn(
  partition: string,
  region: string,
  accountId: string,
  identity: string
): string {
  return `arn:${partition}:ses:${region}:${accountId}:identity/${identity}`
}
