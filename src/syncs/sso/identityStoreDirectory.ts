import {
  type Group,
  type GroupMembership,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ListGroupsCommand,
  ListUsersCommand,
  type User
} from '@aws-sdk/client-identitystore'
import { type Job } from '@actsecurity/job'
import { log } from '@actsecurity/log'
import { withDnsRetry } from '../../utils/client-tools.js'
import { type DataRecord, type Sync, syncData, type SyncOptions } from '../sync.js'
import { paginateResource } from '../typedSync.js'

const paginationConfig = {
  inputKey: 'NextToken',
  outputKey: 'NextToken'
} as const

type IdentityStoreResourceType = 'group' | 'membership' | 'user'

/**
 * Creates an instance-scoped sync for the Identity Store directory associated with an
 * IAM Identity Center instance.
 */
export function createIdentityStoreDirectorySync(
  identityStoreId: string,
  instanceArn: string
): Sync {
  return {
    awsService: 'sso',
    name: 'identityStoreDirectory',
    execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
      const client = syncOptions.clientPool.client(
        IdentitystoreClient,
        credentials,
        region,
        endpoint
      )
      const identityStoreArn = `arn:${credentials.partition}:identitystore::${accountId}:identitystore/${identityStoreId}`

      const users = await withDnsRetry(() =>
        paginateResource(client, ListUsersCommand, 'Users', paginationConfig, {
          IdentityStoreId: identityStoreId
        })
      )
      const groups = await withDnsRetry(() =>
        paginateResource(client, ListGroupsCommand, 'Groups', paginationConfig, {
          IdentityStoreId: identityStoreId
        })
      )
      const memberships = await collectGroupMemberships(
        client,
        groups,
        identityStoreId,
        syncOptions.workerPool
      )

      const groupArns = new Map<string, string>()
      for (const group of groups) {
        if (group.GroupId) {
          groupArns.set(
            group.GroupId,
            identityStoreResourceArn(credentials.partition, 'group', group.GroupId)
          )
        }
      }

      const userArns = new Map<string, string>()
      for (const user of users) {
        if (user.UserId) {
          userArns.set(
            user.UserId,
            identityStoreResourceArn(credentials.partition, 'user', user.UserId)
          )
        }
      }

      const groupsByUser = new Map<string, string[]>()
      const membersByGroup = new Map<string, string[]>()
      for (const membership of memberships) {
        const userId = membership.MemberId?.UserId
        const groupId = membership.GroupId
        const userArn = userId
          ? identityStoreResourceArn(credentials.partition, 'user', userId)
          : undefined
        const groupArn = groupId
          ? identityStoreResourceArn(credentials.partition, 'group', groupId)
          : undefined
        if (userId && groupArn) {
          groupsByUser.set(userId, [...(groupsByUser.get(userId) ?? []), groupArn])
        }
        if (groupId && userArn) {
          membersByGroup.set(groupId, [...(membersByGroup.get(groupId) ?? []), userArn])
        }
      }

      const userRecords: DataRecord[] = users.flatMap((user) => {
        if (!user.UserId) {
          return []
        }
        const arn = userArns.get(user.UserId)!
        return [
          {
            arn,
            metadata: userMetadata(
              user,
              arn,
              identityStoreId,
              identityStoreArn,
              instanceArn,
              region
            ),
            groups: groupsByUser.get(user.UserId)
          }
        ]
      })

      const groupRecords: DataRecord[] = groups.flatMap((group) => {
        if (!group.GroupId) {
          return []
        }
        const arn = groupArns.get(group.GroupId)!
        return [
          {
            arn,
            metadata: groupMetadata(
              group,
              arn,
              identityStoreId,
              identityStoreArn,
              instanceArn,
              region
            ),
            members: membersByGroup.get(group.GroupId)
          }
        ]
      })

      const membershipRecords: DataRecord[] = memberships.flatMap((membership) => {
        if (!membership.MembershipId) {
          return []
        }
        const arn = identityStoreResourceArn(
          credentials.partition,
          'membership',
          membership.MembershipId
        )
        const userId = membership.MemberId?.UserId
        return [
          {
            arn,
            metadata: {
              arn,
              id: membership.MembershipId,
              identityStoreId,
              identityStoreArn,
              instanceArn,
              region,
              groupId: membership.GroupId,
              groupArn: membership.GroupId
                ? identityStoreResourceArn(credentials.partition, 'group', membership.GroupId)
                : undefined,
              memberId: membership.MemberId,
              memberArn: userId
                ? identityStoreResourceArn(credentials.partition, 'user', userId)
                : undefined,
              createdAt: membership.CreatedAt,
              createdBy: membership.CreatedBy,
              updatedAt: membership.UpdatedAt,
              updatedBy: membership.UpdatedBy
            }
          }
        ]
      })

      const resourceMetadata = { identityStoreId }
      await syncData(
        userRecords,
        storage,
        accountId,
        { service: 'identitystore', resourceType: 'user', metadata: resourceMetadata },
        syncOptions.writeOnly
      )
      await syncData(
        groupRecords,
        storage,
        accountId,
        { service: 'identitystore', resourceType: 'group', metadata: resourceMetadata },
        syncOptions.writeOnly
      )
      await syncData(
        membershipRecords,
        storage,
        accountId,
        { service: 'identitystore', resourceType: 'membership', metadata: resourceMetadata },
        syncOptions.writeOnly
      )
    }
  }
}

async function collectGroupMemberships(
  client: IdentitystoreClient,
  groups: Group[],
  identityStoreId: string,
  workerPool: SyncOptions['workerPool']
): Promise<GroupMembership[]> {
  const jobs: Job<GroupMembership[], { groupId: string }>[] = groups.flatMap((group) => {
    if (!group.GroupId) {
      return []
    }
    return [
      {
        properties: { groupId: group.GroupId },
        execute: async () => {
          const memberships = await withDnsRetry(() =>
            paginateResource(
              client,
              ListGroupMembershipsCommand,
              'GroupMemberships',
              paginationConfig,
              { IdentityStoreId: identityStoreId, GroupId: group.GroupId }
            )
          )
          return memberships.map((membership) => ({
            ...membership,
            GroupId: membership.GroupId ?? group.GroupId
          }))
        }
      }
    ]
  })

  const results = await Promise.all(workerPool.enqueueAll(jobs))
  const memberships: GroupMembership[] = []
  for (const result of results) {
    if (result.status === 'rejected') {
      log.error('Failed to collect Identity Store group memberships', result.reason, {
        identityStoreId,
        groupId: result.properties.groupId
      })
      throw new Error(
        `Failed to collect memberships for Identity Store group ${result.properties.groupId}`
      )
    }
    memberships.push(...result.value)
  }
  return memberships
}

function identityStoreResourceArn(
  partition: string,
  resourceType: IdentityStoreResourceType,
  resourceId: string
): string {
  return `arn:${partition}:identitystore:::${resourceType}/${resourceId}`
}

function userMetadata(
  user: User,
  arn: string,
  identityStoreId: string,
  identityStoreArn: string,
  instanceArn: string,
  region: string
) {
  return {
    arn,
    id: user.UserId,
    identityStoreId,
    identityStoreArn,
    instanceArn,
    region,
    name: user.UserName,
    userName: user.UserName,
    displayName: user.DisplayName,
    nameDetails: user.Name,
    addresses: user.Addresses,
    birthdate: user.Birthdate,
    emails: user.Emails,
    externalIds: user.ExternalIds,
    locale: user.Locale,
    nickName: user.NickName,
    phoneNumbers: user.PhoneNumbers,
    photos: user.Photos,
    preferredLanguage: user.PreferredLanguage,
    profileUrl: user.ProfileUrl,
    roles: user.Roles,
    timezone: user.Timezone,
    title: user.Title,
    userStatus: user.UserStatus,
    userType: user.UserType,
    website: user.Website,
    createdAt: user.CreatedAt,
    createdBy: user.CreatedBy,
    updatedAt: user.UpdatedAt,
    updatedBy: user.UpdatedBy
  }
}

function groupMetadata(
  group: Group,
  arn: string,
  identityStoreId: string,
  identityStoreArn: string,
  instanceArn: string,
  region: string
) {
  return {
    arn,
    id: group.GroupId,
    identityStoreId,
    identityStoreArn,
    instanceArn,
    region,
    name: group.DisplayName,
    displayName: group.DisplayName,
    description: group.Description,
    externalIds: group.ExternalIds,
    createdAt: group.CreatedAt,
    createdBy: group.CreatedBy,
    updatedAt: group.UpdatedAt,
    updatedBy: group.UpdatedBy
  }
}
