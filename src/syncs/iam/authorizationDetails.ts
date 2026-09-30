import {
  GetAccountAuthorizationDetailsCommand,
  type GetAccountAuthorizationDetailsResponse,
  type GroupDetail,
  IAMClient,
  ListPolicyTagsCommand,
  type ManagedPolicyDetail,
  type RoleDetail,
  type Tag,
  type UserDetail
} from '@aws-sdk/client-iam'

import { ConcurrentWorkerPool, type Job } from '@actsecurity/job'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { type AwsIamStore } from '../../persistence/AwsIamStore.js'
import { runAndCatch404 } from '../../utils/client-tools.js'
import { log } from '@actsecurity/log'
import { convertTagsToRecord } from '../../utils/tags.js'
import { type Sync, syncData, type SyncOptions } from '../sync.js'

export const AuthorizationDetailsSync: Sync = {
  awsService: 'iam',
  name: 'authorizationDetails',
  global: true,
  execute: async (
    accountId: string,
    region: string,
    credentials: AwsCredentialProviderWithMetaData,
    storage: AwsIamStore,
    endpoint: string | undefined,
    syncOptions: SyncOptions
  ): Promise<void> => {
    const client = syncOptions.clientPool.client(IAMClient, credentials, region, endpoint)
    const authDetails = await getAuthorizationDetails(
      client,
      syncOptions.workerPool,
      syncOptions.customConfig
    )
    const roles = authDetails.roles || []
    const roleData = roles.map((role) => {
      return {
        arn: role.Arn!,
        'managed-policies': role.AttachedManagedPolicies?.map((p) => p.PolicyArn),
        'trust-policy': role.AssumeRolePolicyDocument,
        'instance-profiles': role.InstanceProfileList?.map((i) => i.Arn),
        'inline-policies': role.RolePolicyList,
        tags: convertTagsToRecord(role.Tags),
        metadata: {
          arn: role.Arn,
          name: role.RoleName,
          id: role.RoleId,
          path: role.Path,
          created: role.CreateDate,
          permissionBoundary: role.PermissionsBoundary?.PermissionsBoundaryArn
        }
      }
    })

    await syncData(
      roleData,
      storage,
      accountId,
      {
        service: 'iam',
        resourceType: 'role',
        account: accountId
      },
      syncOptions.writeOnly
    )

    const groupArns: Record<string, string> = {}

    const groupData = authDetails.groups.map((group) => {
      groupArns[group.GroupName!] = group.Arn!
      return {
        arn: group.Arn!,
        'inline-policies': group.GroupPolicyList,
        'managed-policies': group.AttachedManagedPolicies?.map((p) => p.PolicyArn),

        metadata: {
          arn: group.Arn,
          path: group.Path,
          name: group.GroupName,
          id: group.GroupId,
          created: group.CreateDate
        }
      }
    })

    await syncData(
      groupData,
      storage,
      accountId,
      {
        service: 'iam',
        resourceType: 'group',
        account: accountId
      },
      syncOptions.writeOnly
    )

    const customerPolicyData = authDetails.policies.map((policy) => {
      return {
        arn: policy.Arn!,
        metadata: {
          arn: policy.Arn,
          name: policy.PolicyName,
          id: policy.PolicyId,
          description: policy.Description,
          defaultVersionId: policy.DefaultVersionId,
          path: policy.Path,
          permissionsBoundaryUsageCount: policy.PermissionsBoundaryUsageCount,
          isAttachable: policy.IsAttachable,
          createDate: policy.CreateDate,
          updateDate: policy.UpdateDate
        },
        'current-policy': policy.PolicyVersionList?.filter(
          (version) => version.IsDefaultVersion
        ).at(0)?.Document,
        policy: undefined,
        tags: convertTagsToRecord(policy.Tags)
      }
    })

    await syncData(
      customerPolicyData,
      storage,
      accountId,
      {
        service: 'iam',
        resourceType: 'policy',
        account: accountId
      },
      syncOptions.writeOnly
    )

    const awsManagedPolicyData = authDetails.awsManagedPolicies.map((policy) => {
      return {
        arn: policy.Arn!,
        metadata: {
          arn: policy.Arn,
          name: policy.PolicyName,
          id: policy.PolicyId,
          description: policy.Description,
          defaultVersionId: policy.DefaultVersionId,
          path: policy.Path,
          permissionsBoundaryUsageCount: policy.PermissionsBoundaryUsageCount,
          isAttachable: policy.IsAttachable,
          createDate: policy.CreateDate,
          updateDate: policy.UpdateDate
        },
        'current-policy': policy.PolicyVersionList?.filter(
          (version) => version.IsDefaultVersion
        ).at(0)?.Document,
        policy: undefined
      }
    })

    await syncData(
      awsManagedPolicyData,
      storage,
      accountId,
      {
        service: 'iam',
        resourceType: 'policy',
        account: 'aws'
      },
      syncOptions.writeOnly
    )

    const userData = authDetails.users.map((user) => {
      return {
        arn: user.Arn!,
        'managed-policies': user.AttachedManagedPolicies?.map((p) => p.PolicyArn),
        'inline-policies': user.UserPolicyList,
        groups: user.GroupList?.map((g) => groupArns[g]),
        tags: convertTagsToRecord(user.Tags),
        metadata: {
          arn: user.Arn,
          path: user.Path,
          permissionBoundary: user.PermissionsBoundary?.PermissionsBoundaryArn,
          id: user.UserId,
          name: user.UserName,
          created: user.CreateDate
        }
      }
    })

    syncData(
      userData,
      storage,
      accountId,
      {
        service: 'iam',
        resourceType: 'user',
        account: accountId
      },
      syncOptions.writeOnly
    )
  }
}

interface ManagedPolicyDetailWithExtraData extends ManagedPolicyDetail {
  Tags?: Tag[]
}

/**
 * Return the results of the Authorization Details call for this account.
 * Excludes users and AWS managed policies.
 *
 * @param credentials The credentials to use for the API call
 * @returns Returns the results of the Authorization Details call for this account
 */
export async function getAuthorizationDetails(
  client: IAMClient,
  concurrentWorkerPool: ConcurrentWorkerPool<any, any>,
  customConfig?: Record<string, any>
): Promise<{
  groups: GroupDetail[]
  roles: RoleDetail[]
  policies: ManagedPolicyDetailWithExtraData[]
  awsManagedPolicies: ManagedPolicyDetail[]
  users: UserDetail[]
}> {
  let isTruncated = false
  let getDetailsCommand: GetAccountAuthorizationDetailsCommand
  let response: GetAccountAuthorizationDetailsResponse
  let marker

  const groupDetails: GroupDetail[] = []
  const roleDetails: RoleDetail[] = []
  const policyDetails: ManagedPolicyDetail[] = []
  const awsManagedPolicies: ManagedPolicyDetail[] = []
  const userDetails: UserDetail[] = []

  do {
    getDetailsCommand = new GetAccountAuthorizationDetailsCommand({
      Marker: marker,
      Filter: ['Role', 'Group', 'LocalManagedPolicy', 'AWSManagedPolicy', 'User']
    })

    response = await client.send(getDetailsCommand)
    groupDetails.push(...(response.GroupDetailList?.map(parseGroupDocs) || []))
    roleDetails.push(...(response.RoleDetailList?.map(parseRoleDocs) || []))
    userDetails.push(...(response.UserDetailList?.map(parseUserDocs) || []))

    for (const policy of response.Policies || []) {
      const policyDetail = parsePolicyDocs(policy)
      if (policyDetail.Arn?.startsWith('arn:aws:iam::aws:policy/')) {
        awsManagedPolicies.push(policyDetail)
      } else {
        policyDetails.push(policyDetail)
      }
    }

    isTruncated = !!response.IsTruncated
    marker = response.Marker
  } while (isTruncated)

  let policiesWithTags: ManagedPolicyDetailWithExtraData[] = policyDetails
  if (customConfig?.includePolicyTags) {
    log.info('Including policy tags in authorization details sync')
    policiesWithTags = await getTagsForManagedPolicies(client, policyDetails, concurrentWorkerPool)
  }

  return {
    groups: groupDetails,
    roles: roleDetails,
    policies: policiesWithTags,
    awsManagedPolicies,
    users: userDetails
  }
}

/**
 * Download the tags for the managed policies.
 *
 * @param client the IAM client to use for the API call
 * @param policies the policies to get the tags for
 * @returns the policies with the tags added
 */
async function getTagsForManagedPolicies(
  client: IAMClient,
  policies: ManagedPolicyDetail[],
  concurrentWorkerPool: ConcurrentWorkerPool<any, any>
): Promise<ManagedPolicyDetailWithExtraData[]> {
  const policiesWithTags: ManagedPolicyDetailWithExtraData[] = []
  const execute = async (context: any) => {
    const { policy } = context.properties
    const command = new ListPolicyTagsCommand({ PolicyArn: policy.Arn! })
    const tags = await runAndCatch404(async () => {
      const result = await client.send(command)
      return result.Tags
    })
    return {
      ...policy,
      Tags: tags
    }
  }
  const jobs: Job<ManagedPolicyDetailWithExtraData, Record<string, unknown>>[] = policies.map(
    (policy) => ({
      properties: {
        policy
      },
      execute
    })
  )
  const jobResults = await Promise.all(concurrentWorkerPool.enqueueAll(jobs))
  for (const jobResult of jobResults) {
    if (jobResult.status === 'fulfilled') {
      policiesWithTags.push(jobResult.value)
    } else {
      // Log the error but continue processing other policies
      const policyArn = (jobResult.properties.policy as ManagedPolicyDetail).Arn
      log.error('Failed to get tags for policy', jobResult.reason, {
        policyArn
      })
      throw new Error(`Failed to get tags for policy ${policyArn}. See logs for details.`)
    }
  }
  return policiesWithTags
}

/**
 * Decodes and parses the policy documents in the group.
 *
 * @param group The GroupDetail object to parse the policy documents for
 * @returns Returns the GroupDetail object with the policy documents decoded and parsed
 */
function parseGroupDocs(group: GroupDetail) {
  if (group.GroupPolicyList) {
    group.GroupPolicyList.forEach((policy) => {
      if (policy.PolicyDocument) {
        policy.PolicyDocument = JSON.parse(decodeURIComponent(policy.PolicyDocument))
      }
    })
  }

  return group
}

/**
 * Decodes and parses the policy documents in the role.
 *
 * @param role the RoleDetail object to parse the policy documents for
 * @returns Returns the RoleDetail object with the policy documents decoded and parsed
 */
function parseRoleDocs(role: RoleDetail) {
  if (role.AssumeRolePolicyDocument) {
    role.AssumeRolePolicyDocument = JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument))
  }

  if (role.RolePolicyList) {
    role.RolePolicyList.forEach((policy) => {
      if (policy.PolicyDocument) {
        policy.PolicyDocument = JSON.parse(decodeURIComponent(policy.PolicyDocument))
      }
    })
  }

  return role
}

/**
 * Decodes and parses the policy documents in the managed policy.
 *
 * @param policy The ManagedPolicyDetail object to parse the policy documents for
 * @returns Returns the ManagedPolicyDetail object with the policy documents decoded and parsed
 */
function parsePolicyDocs(policy: ManagedPolicyDetail) {
  if (policy.PolicyVersionList) {
    policy.PolicyVersionList.forEach((version) => {
      if (version.Document) {
        version.Document = JSON.parse(decodeURIComponent(version.Document))
      }
    })
  }

  return policy
}

/**
 * Decodes and parses the policy documents attached directly to a user.
 *
 * @param user The userDetail object to parse the policy documents for
 * @returns Returns the UserDetail object with the policy documents decoded and parsed
 */
function parseUserDocs(user: UserDetail) {
  if (user.UserPolicyList) {
    user.UserPolicyList.forEach((policy) => {
      if (policy.PolicyDocument) {
        policy.PolicyDocument = JSON.parse(decodeURIComponent(policy.PolicyDocument))
      }
    })
  }

  return user
}
