import {
  GetIdentityPoliciesCommand,
  GetIdentityVerificationAttributesCommand,
  ListIdentitiesCommand,
  ListIdentityPoliciesCommand,
  SESClient
} from '@aws-sdk/client-ses'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { getRegionalSyncsForService } from '../syncMap.js'
import { SesIdentitiesSync } from './identities.js'

const sesMock = mockClient(SESClient)
const accountId = '111111111111'
const region = 'us-east-1'
const credentials: AwsCredentialProviderWithMetaData = {
  accountId,
  partition: 'aws',
  cacheKey: 'test-credentials',
  provider: async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key'
  })
}

const workerPool = {
  enqueueAll: (jobs: any[]) =>
    jobs.map(async (job) => {
      try {
        return {
          status: 'fulfilled',
          value: await job.execute({ workerId: 1, properties: job.properties }),
          properties: job.properties
        }
      } catch (reason) {
        return { status: 'rejected', reason, properties: job.properties }
      }
    })
} as any

describe('SesIdentitiesSync', () => {
  afterEach(() => {
    sesMock.reset()
  })

  it('collects verified identities and their named policies across identity pages', async () => {
    const store = createInMemoryStorageClient()
    const domain = 'example.com'
    const email = 'sender@example.com'
    const pendingIdentity = 'pending.example.com'
    const domainArn = `arn:aws:ses:${region}:${accountId}:identity/${domain}`
    const emailArn = `arn:aws:ses:${region}:${accountId}:identity/${email}`
    const pendingArn = `arn:aws:ses:${region}:${accountId}:identity/${pendingIdentity}`

    await store.saveResourceMetadata(accountId, pendingArn, 'metadata', {
      arn: pendingArn,
      name: pendingIdentity
    })

    sesMock.on(ListIdentitiesCommand).callsFake((input) => {
      if (input.NextToken === 'next-page') {
        return { Identities: [email] }
      }
      return {
        Identities: [domain, pendingIdentity],
        NextToken: 'next-page'
      }
    })
    sesMock.on(GetIdentityVerificationAttributesCommand).resolves({
      VerificationAttributes: {
        [domain]: { VerificationStatus: 'Success' },
        [email]: { VerificationStatus: 'Success' },
        [pendingIdentity]: { VerificationStatus: 'Pending' }
      }
    })
    sesMock.on(ListIdentityPoliciesCommand, { Identity: domain }).resolves({
      PolicyNames: ['delegate-a', 'delegate-b']
    })
    sesMock.on(ListIdentityPoliciesCommand, { Identity: email }).resolves({ PolicyNames: [] })
    sesMock.on(GetIdentityPoliciesCommand).resolves({
      Policies: {
        'delegate-a': JSON.stringify({ Statement: [{ Sid: 'delegate-a' }] }),
        'delegate-b': JSON.stringify({ Statement: [{ Sid: 'delegate-b' }] })
      }
    })

    const clientPool = new AwsClientPool()
    await SesIdentitiesSync.execute(accountId, region, credentials, store, undefined, {
      clientPool,
      workerPool,
      writeOnly: false
    })
    clientPool.clear()

    await expect(store.getResourceMetadata(accountId, domainArn, 'metadata')).resolves.toEqual({
      arn: domainArn,
      name: domain,
      identityType: 'Domain'
    })
    await expect(store.getResourceMetadata(accountId, domainArn, 'policies')).resolves.toEqual({
      'delegate-a': { Statement: [{ Sid: 'delegate-a' }] },
      'delegate-b': { Statement: [{ Sid: 'delegate-b' }] }
    })
    await expect(store.getResourceMetadata(accountId, emailArn, 'metadata')).resolves.toEqual({
      arn: emailArn,
      name: email,
      identityType: 'EmailAddress'
    })
    await expect(
      store.getResourceMetadata(accountId, emailArn, 'policies')
    ).resolves.toBeUndefined()
    await expect(store.listResourceMetadata(accountId, pendingArn)).resolves.toEqual([])

    expect(sesMock.commandCalls(ListIdentitiesCommand).map((call) => call.args[0].input)).toEqual([
      { NextToken: undefined },
      { NextToken: 'next-page' }
    ])
    expect(sesMock.commandCalls(GetIdentityVerificationAttributesCommand)[0].args[0].input).toEqual(
      {
        Identities: [domain, pendingIdentity, email]
      }
    )
    const listPolicyCalls = sesMock
      .commandCalls(ListIdentityPoliciesCommand)
      .map((call) => call.args[0].input)
    expect(listPolicyCalls).toHaveLength(2)
    expect(listPolicyCalls).toEqual(
      expect.arrayContaining([{ Identity: domain }, { Identity: email }])
    )
    expect(sesMock.commandCalls(GetIdentityPoliciesCommand)).toHaveLength(1)
    expect(sesMock.commandCalls(GetIdentityPoliciesCommand)[0].args[0].input).toEqual({
      Identity: domain,
      PolicyNames: ['delegate-a', 'delegate-b']
    })
  })

  it('is registered as a regional SES sync', () => {
    expect(getRegionalSyncsForService('ses')).toContain(SesIdentitiesSync)
  })
})
