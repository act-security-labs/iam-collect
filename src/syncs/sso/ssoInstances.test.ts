import {
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ListGroupsCommand,
  ListUsersCommand
} from '@aws-sdk/client-identitystore'
import {
  ListInstancesCommand,
  ListPermissionSetsCommand,
  ListTagsForResourceCommand,
  SSOAdminClient
} from '@aws-sdk/client-sso-admin'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { SsoDataSync } from './ssoInstances.js'

const ssoMock = mockClient(SSOAdminClient)
const identityStoreMock = mockClient(IdentitystoreClient)
const accountId = '111111111111'
const region = 'us-east-1'
const identityStoreId = 'd-1234567890'
const instanceArn = 'arn:aws:sso:::instance/ssoins-1234567890abcdef'
const identityStoreArn = `arn:aws:identitystore::${accountId}:identitystore/${identityStoreId}`
const userOneId = '1234567890-11111111-1111-1111-1111-111111111111'
const userTwoId = '1234567890-22222222-2222-2222-2222-222222222222'
const groupOneId = '1234567890-33333333-3333-3333-3333-333333333333'
const groupTwoId = '1234567890-44444444-4444-4444-4444-444444444444'
const membershipOneId = '1234567890-55555555-5555-5555-5555-555555555555'
const membershipTwoId = '1234567890-66666666-6666-6666-6666-666666666666'

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

describe('SsoDataSync Identity Store directory', () => {
  afterEach(() => {
    ssoMock.reset()
    identityStoreMock.reset()
  })

  it('collects paginated users, groups, and group memberships with graph relationships', async () => {
    const store = createInMemoryStorageClient()
    const staleUserArn = 'arn:aws:identitystore:::user/stale-user'
    const otherStoreUserArn = 'arn:aws:identitystore:::user/other-store-user'
    await store.saveResourceMetadata(accountId, staleUserArn, 'metadata', {
      arn: staleUserArn,
      identityStoreId
    })
    await store.saveResourceMetadata(accountId, otherStoreUserArn, 'metadata', {
      arn: otherStoreUserArn,
      identityStoreId: 'd-0987654321'
    })

    setupSsoInstance({ IdentityStoreId: identityStoreId })
    identityStoreMock.on(ListUsersCommand).callsFake((input) => {
      if (input.NextToken === 'users-page-2') {
        return {
          Users: [
            {
              IdentityStoreId: identityStoreId,
              UserId: userTwoId,
              UserName: 'grace',
              DisplayName: 'Grace Hopper',
              UserStatus: 'ENABLED'
            }
          ]
        }
      }
      return {
        Users: [
          {
            IdentityStoreId: identityStoreId,
            UserId: userOneId,
            UserName: 'ada',
            DisplayName: 'Ada Lovelace',
            Name: { GivenName: 'Ada', FamilyName: 'Lovelace' },
            Emails: [{ Value: 'ada@example.com', Primary: true }],
            ExternalIds: [{ Issuer: 'https://idp.example.com', Id: 'ada-idp-id' }]
          }
        ],
        NextToken: 'users-page-2'
      }
    })
    identityStoreMock.on(ListGroupsCommand).callsFake((input) => {
      if (input.NextToken === 'groups-page-2') {
        return {
          Groups: [
            {
              IdentityStoreId: identityStoreId,
              GroupId: groupTwoId,
              DisplayName: 'Auditors'
            }
          ]
        }
      }
      return {
        Groups: [
          {
            IdentityStoreId: identityStoreId,
            GroupId: groupOneId,
            DisplayName: 'Administrators',
            Description: 'Identity Center administrators'
          }
        ],
        NextToken: 'groups-page-2'
      }
    })
    identityStoreMock.on(ListGroupMembershipsCommand).callsFake((input) => {
      if (input.GroupId === groupTwoId) {
        return { GroupMemberships: [] }
      }
      if (input.NextToken === 'memberships-page-2') {
        return {
          GroupMemberships: [
            {
              IdentityStoreId: identityStoreId,
              MembershipId: membershipTwoId,
              GroupId: groupOneId,
              MemberId: { UserId: userTwoId }
            }
          ]
        }
      }
      return {
        GroupMemberships: [
          {
            IdentityStoreId: identityStoreId,
            MembershipId: membershipOneId,
            MemberId: { UserId: userOneId }
          }
        ],
        NextToken: 'memberships-page-2'
      }
    })

    await executeSsoSync(store)

    const userOneArn = `arn:aws:identitystore:::user/${userOneId}`
    const userTwoArn = `arn:aws:identitystore:::user/${userTwoId}`
    const groupOneArn = `arn:aws:identitystore:::group/${groupOneId}`
    const membershipOneArn = `arn:aws:identitystore:::membership/${membershipOneId}`

    await expect(store.getResourceMetadata(accountId, userOneArn, 'metadata')).resolves.toEqual({
      arn: userOneArn,
      id: userOneId,
      identityStoreId,
      identityStoreArn,
      instanceArn,
      region,
      name: 'ada',
      userName: 'ada',
      displayName: 'Ada Lovelace',
      nameDetails: { GivenName: 'Ada', FamilyName: 'Lovelace' },
      emails: [{ Value: 'ada@example.com', Primary: true }],
      externalIds: [{ Issuer: 'https://idp.example.com', Id: 'ada-idp-id' }]
    })
    await expect(store.getResourceMetadata(accountId, userOneArn, 'groups')).resolves.toEqual([
      groupOneArn
    ])
    await expect(store.getResourceMetadata(accountId, userTwoArn, 'groups')).resolves.toEqual([
      groupOneArn
    ])
    await expect(store.getResourceMetadata(accountId, groupOneArn, 'members')).resolves.toEqual([
      userOneArn,
      userTwoArn
    ])
    await expect(
      store.getResourceMetadata(accountId, membershipOneArn, 'metadata')
    ).resolves.toEqual({
      arn: membershipOneArn,
      id: membershipOneId,
      identityStoreId,
      identityStoreArn,
      instanceArn,
      region,
      groupId: groupOneId,
      groupArn: groupOneArn,
      memberId: { UserId: userOneId },
      memberArn: userOneArn
    })

    await expect(store.listResourceMetadata(accountId, staleUserArn)).resolves.toEqual([])
    await expect(
      store.getResourceMetadata(accountId, otherStoreUserArn, 'metadata')
    ).resolves.toEqual({
      arn: otherStoreUserArn,
      identityStoreId: 'd-0987654321'
    })

    expect(
      identityStoreMock.commandCalls(ListUsersCommand).map((call) => call.args[0].input)
    ).toEqual([
      { IdentityStoreId: identityStoreId, NextToken: undefined },
      { IdentityStoreId: identityStoreId, NextToken: 'users-page-2' }
    ])
    expect(
      identityStoreMock.commandCalls(ListGroupsCommand).map((call) => call.args[0].input)
    ).toEqual([
      { IdentityStoreId: identityStoreId, NextToken: undefined },
      { IdentityStoreId: identityStoreId, NextToken: 'groups-page-2' }
    ])
    const membershipCalls = identityStoreMock
      .commandCalls(ListGroupMembershipsCommand)
      .map((call) => call.args[0].input)
    expect(membershipCalls.filter((input) => input.GroupId === groupOneId)).toEqual([
      { IdentityStoreId: identityStoreId, GroupId: groupOneId, NextToken: undefined },
      {
        IdentityStoreId: identityStoreId,
        GroupId: groupOneId,
        NextToken: 'memberships-page-2'
      }
    ])
    expect(membershipCalls.filter((input) => input.GroupId === groupTwoId)).toEqual([
      { IdentityStoreId: identityStoreId, GroupId: groupTwoId, NextToken: undefined }
    ])
  })

  it('skips directory collection when the instance has no Identity Store ID', async () => {
    const store = createInMemoryStorageClient()
    setupSsoInstance({})

    await executeSsoSync(store)

    expect(identityStoreMock.calls()).toHaveLength(0)
    await expect(store.getResourceMetadata(accountId, instanceArn, 'metadata')).resolves.toEqual({
      arn: instanceArn,
      name: 'test-instance',
      ownerAccountId: accountId,
      status: 'ACTIVE',
      region
    })
  })
})

function setupSsoInstance(extra: { IdentityStoreId?: string }): void {
  ssoMock.on(ListInstancesCommand).resolves({
    Instances: [
      {
        InstanceArn: instanceArn,
        Name: 'test-instance',
        OwnerAccountId: accountId,
        Status: 'ACTIVE',
        ...extra
      }
    ]
  })
  ssoMock.on(ListTagsForResourceCommand).resolves({ Tags: [] })
  ssoMock.on(ListPermissionSetsCommand).resolves({ PermissionSets: [] })
}

async function executeSsoSync(
  store: ReturnType<typeof createInMemoryStorageClient>
): Promise<void> {
  const clientPool = new AwsClientPool()
  try {
    await SsoDataSync.execute(accountId, region, credentials, store, undefined, {
      clientPool,
      workerPool,
      writeOnly: false
    })
  } finally {
    clientPool.clear()
  }
}
