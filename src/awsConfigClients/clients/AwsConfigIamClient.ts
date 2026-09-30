import {
  GetAccountAuthorizationDetailsCommand,
  GetOpenIDConnectProviderCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetSAMLProviderCommand,
  IAMClient,
  ListInstanceProfilesCommand,
  ListOpenIDConnectProvidersCommand,
  ListPolicyTagsCommand,
  ListSAMLProvidersCommand,
  type ManagedPolicyDetail
} from '@aws-sdk/client-iam'
import { splitArnParts } from '@actsecurity/iam-utils'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { AbstractClient } from '../../customClients/AbstractClient.js'
import { type AwsConfigClientContext, awsConfigCommand } from '../AwsConfigClientContext.js'
import {
  executeConfigQuery,
  parseConfigItem,
  resourceStatusWhereClause
} from '../awsConfigUtils.js'

/**
 * AWS Config-based IAM client implementation
 */
export class AwsConfigIamClient extends AbstractClient<AwsConfigClientContext> {
  static readonly clientName = IAMClient.name

  constructor(
    options: {
      credentials: AwsCredentialProviderWithMetaData
      region: string | undefined
    },
    customContext: AwsConfigClientContext
  ) {
    super(options, customContext)
  }

  /**
   * Register all IAM command implementations
   */
  protected registerCommands(): void {
    this.registerCommand(AwsConfigGetAccountAuthorizationDetailsCommand)
    this.registerCommand(AwsConfigGetOpenIDConnectProviderCommand)
    this.registerCommand(AwsConfigGetSAMLProviderCommand)
    this.registerCommand(AwsConfigListInstanceProfilesCommand)
    this.registerCommand(AwsConfigListOpenIDConnectProvidersCommand)
    this.registerCommand(AwsConfigListSAMLProvidersCommand)
    this.registerCommand(AwsConfigListPolicyTagsCommand)
  }
}

/**
 * Config-based implementation of IAM GetAccountAuthorizationDetailsCommand
 *
 * Aggregates IAM data from multiple Config resource types:
 * - AWS::IAM::Role for roles
 * - AWS::IAM::User for users
 * - AWS::IAM::Group for groups
 * - AWS::IAM::Policy for managed policies
 */
const AwsConfigGetAccountAuthorizationDetailsCommand = awsConfigCommand({
  command: GetAccountAuthorizationDetailsCommand,
  execute: async (input, context) => {
    const nativeIamClient = AwsClientPool.defaultInstance.client(
      IAMClient,
      context.configCredentials,
      context.region,
      undefined
    )

    const awsManagedPoliciesToFetch = new Set<string>()

    // Query roles from Config
    const rolesQuery = `
      SELECT
        configuration.arn,
        configuration.roleName,
        configuration.path,
        configuration.roleId,
        configuration.createDate,
        configuration.assumeRolePolicyDocument,
        configuration.attachedManagedPolicies,
        configuration.instanceProfileList,
        configuration.rolePolicyList,
        configuration.permissionsBoundary,
        configuration.roleLastUsed,
        tags
      WHERE
        resourceType = 'AWS::IAM::Role'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    // Query users from Config
    const usersQuery = `
      SELECT
        configuration.arn,
        configuration.userName,
        configuration.path,
        configuration.userId,
        configuration.createDate,
        configuration.attachedManagedPolicies,
        configuration.groupList,
        configuration.userPolicyList,
        configuration.permissionsBoundary,
        tags
      WHERE
        resourceType = 'AWS::IAM::User'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    // Query groups from Config
    const groupsQuery = `
      SELECT
        configuration.arn,
        configuration.groupName,
        configuration.path,
        configuration.groupId,
        configuration.createDate,
        configuration.attachedManagedPolicies,
        configuration.groupPolicyList,
        tags
      WHERE
        resourceType = 'AWS::IAM::Group'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    // Query policies from Config
    const policiesQuery = `
      SELECT
        configuration.policyName,
        configuration.policyId,
        configuration.arn,
        configuration.path,
        configuration.createDate,
        configuration.updateDate,
        configuration.policyVersionList,
        configuration.attachmentCount,
        configuration.permissionsBoundaryUsageCount,
        configuration.isAttachable,
        configuration.description,
        tags
      WHERE
        resourceType = 'AWS::IAM::Policy'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    // Execute all queries
    const [rolesResults, usersResults, groupsResults, policiesResults] = await Promise.all([
      executeConfigQuery(rolesQuery, context),
      executeConfigQuery(usersQuery, context),
      executeConfigQuery(groupsQuery, context),
      executeConfigQuery(policiesQuery, context)
    ])

    // Transform Config data to IAM format and collect AWS managed policies
    const roles = rolesResults.map((resultString) => {
      const { configuration, tags } = parseConfigItem(resultString)

      // Collect AWS managed policies from this role
      const attachedPolicies = configuration.attachedManagedPolicies || []
      attachedPolicies.forEach((policy: any) => {
        if (policy.policyArn && isAwsManagedPolicy(policy.policyArn)) {
          awsManagedPoliciesToFetch.add(policy.policyArn)
        }
      })

      return {
        Arn: configuration.arn,
        RoleName: configuration.roleName,
        Path: configuration.path,
        RoleId: configuration.roleId,
        CreateDate: configuration.createDate ? new Date(configuration.createDate) : undefined,
        AssumeRolePolicyDocument: configuration.assumeRolePolicyDocument,
        AttachedManagedPolicies: configuration.attachedManagedPolicies?.map((ap: any) => ({
          PolicyName: ap.policyName,
          PolicyArn: ap.policyArn
        })),
        InstanceProfileList: configuration.instanceProfileList,
        RolePolicyList: configuration.rolePolicyList.map((rp: any) => ({
          PolicyName: rp.policyName,
          PolicyDocument: rp.policyDocument
        })),
        Tags: tags,
        PermissionsBoundary: configuration.permissionsBoundary,
        RoleLastUsed: configuration.roleLastUsed
      }
    })

    const users = usersResults.map((resultString) => {
      const { configuration, tags } = parseConfigItem(resultString)

      // Collect AWS managed policies from this user
      const attachedPolicies = configuration.attachedManagedPolicies || []
      attachedPolicies.forEach((policy: any) => {
        if (policy.policyArn && isAwsManagedPolicy(policy.policyArn)) {
          awsManagedPoliciesToFetch.add(policy.policyArn)
        }
      })

      return {
        Arn: configuration.arn,
        UserName: configuration.userName,
        Path: configuration.path,
        UserId: configuration.userId,
        CreateDate: configuration.createDate ? new Date(configuration.createDate) : undefined,
        AttachedManagedPolicies: configuration.attachedManagedPolicies.map((ap: any) => ({
          PolicyName: ap.policyName,
          PolicyArn: ap.policyArn
        })),
        GroupList: configuration.groupList,
        UserPolicyList: configuration.userPolicyList.map((up: any) => ({
          PolicyName: up.policyName,
          PolicyDocument: up.policyDocument
        })),
        Tags: tags as any,
        PermissionsBoundary: configuration.permissionsBoundary
      }
    })

    const groups = groupsResults.map((resultString) => {
      const { configuration, tags } = parseConfigItem(resultString)

      // Collect AWS managed policies from this group
      const attachedPolicies = configuration.attachedManagedPolicies || []
      attachedPolicies.forEach((policy: any) => {
        if (policy.policyArn && isAwsManagedPolicy(policy.policyArn)) {
          awsManagedPoliciesToFetch.add(policy.policyArn)
        }
      })

      return {
        Arn: configuration.arn,
        GroupName: configuration.groupName,
        Path: configuration.path,
        GroupId: configuration.groupId,
        CreateDate: configuration.createDate ? new Date(configuration.createDate) : undefined,
        AttachedManagedPolicies: putInArray(configuration.attachedManagedPolicies).map(
          (ap: any) => ({
            PolicyName: ap.policyName,
            PolicyArn: ap.policyArn
          })
        ),
        Tags: tags ? Object.entries(tags).map(([key, value]) => ({ Key: key, Value: value })) : [],
        GroupPolicyList: putInArray(configuration.groupPolicyList).map((gp: any) => ({
          PolicyName: gp.policyName,
          PolicyDocument: gp.policyDocument
        }))
      }
    })

    const policies = policiesResults.map((resultString) => {
      const { configuration, tags } = parseConfigItem(resultString)
      return {
        PolicyName: configuration.policyName,
        PolicyId: configuration.policyId,
        Arn: configuration.arn,
        Path: configuration.path,
        CreateDate: configuration.createDate ? new Date(configuration.createDate) : undefined,
        UpdateDate: configuration.updateDate ? new Date(configuration.updateDate) : undefined,
        PolicyVersionList: putInArray(configuration.policyVersionList).map((pv: any) => ({
          Document: pv.document,
          VersionId: pv.versionId,
          IsDefaultVersion: pv.isDefaultVersion
        })),
        AttachmentCount: configuration.attachmentCount,
        PermissionsBoundaryUsageCount: configuration.permissionsBoundaryUsageCount,
        IsAttachable: configuration.isAttachable,
        Description: configuration.description,
        Tags: tags as any
      }
    })

    // Fetch AWS managed policy details using native IAM client
    const awsManagedPolicies: ManagedPolicyDetail[] = []
    for (const policyArn of awsManagedPoliciesToFetch) {
      const policyDetails = await nativeIamClient.send(
        new GetPolicyCommand({ PolicyArn: policyArn })
      )
      const policyDocument = await nativeIamClient.send(
        new GetPolicyVersionCommand({
          PolicyArn: policyArn,
          VersionId: policyDetails.Policy?.DefaultVersionId
        })
      )

      if (policyDocument.PolicyVersion) {
        awsManagedPolicies.push({
          ...policyDetails.Policy,
          PolicyVersionList: [
            {
              Document: policyDocument.PolicyVersion.Document,
              VersionId: policyDocument.PolicyVersion.VersionId,
              IsDefaultVersion: policyDocument.PolicyVersion.IsDefaultVersion
            }
          ]
        })
      }
    }

    // Combine customer-managed policies from Config with AWS managed policies from native IAM
    const allPolicies = [...policies, ...awsManagedPolicies]

    return {
      UserDetailList: users,
      GroupDetailList: groups,
      RoleDetailList: roles,
      Policies: allPolicies,
      IsTruncated: false
    }
  }
})

/**
 * Config-based implementation of IAM ListInstanceProfilesCommand
 *
 * Note: AWS Config doesn't track InstanceProfile as a separate resource type.
 * Instance profiles are extracted from Role configuration data.
 */
const AwsConfigListInstanceProfilesCommand = awsConfigCommand({
  command: ListInstanceProfilesCommand,
  execute: async (input, context) => {
    // Get roles from Config and extract instance profiles
    const query = `
      SELECT
        configuration.instanceProfileList
      WHERE
        resourceType = 'AWS::IAM::Role'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    const results = await executeConfigQuery(query, context)

    // Extract unique instance profiles from all roles
    const instanceProfilesMap = new Map()

    results.forEach((resultString) => {
      const { configuration } = parseConfigItem(resultString)
      const instanceProfiles = configuration.instanceProfileList || []
      instanceProfiles.forEach((profile: any) => {
        if (profile.arn && !instanceProfilesMap.has(profile.arn)) {
          instanceProfilesMap.set(profile.arn, {
            Path: profile.path,
            InstanceProfileName: profile.instanceProfileName,
            InstanceProfileId: profile.instanceProfileId,
            Arn: profile.arn,
            CreateDate: profile.createDate ? new Date(profile.createDate) : undefined,
            Roles: profile.roles?.map((r: any) => ({ Arn: r.arn })) || [],
            Tags: [] // Tags not available in role's instance profile data
          })
        }
      })
    })

    return {
      InstanceProfiles: Array.from(instanceProfilesMap.values()),
      IsTruncated: false // TODO: Handle pagination properly
    }
  }
})

/**
 * Config-based implementation of IAM ListOpenIDConnectProvidersCommand
 */
const AwsConfigListOpenIDConnectProvidersCommand = awsConfigCommand({
  command: ListOpenIDConnectProvidersCommand,
  execute: async (input, context) => {
    const query = `
      SELECT
        configuration.Arn,
        configuration.Url,
        configuration.ClientIdList,
        configuration.ThumbprintList,
        tags
      WHERE
        resourceType = 'AWS::IAM::OIDCProvider'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    const results = await executeConfigQuery(query, context)

    const providers = results.map((resultString) => {
      const { configuration, tags } = parseConfigItem(resultString)
      context.putCache(configuration.Arn, 'configuration', { configuration, tags })
      return {
        Arn: configuration.Arn
      }
    })

    return {
      OpenIDConnectProviderList: providers
    }
  }
})

/**
 * Config-based implementation of IAM GetOpenIDConnectProviderCommand
 */
const AwsConfigGetOpenIDConnectProviderCommand = awsConfigCommand({
  command: GetOpenIDConnectProviderCommand,
  execute: async (input, context) => {
    const { configuration, tags } = context.getCache(
      input.OpenIDConnectProviderArn!,
      'configuration'
    )

    return {
      Url: configuration.Url,
      ClientIDList: configuration.ClientIdList,
      ThumbprintList: configuration.ThumbprintList,
      Tags: tags
    }
  }
})

/**
 * Config-based implementation of IAM ListSAMLProvidersCommand
 */
const AwsConfigListSAMLProvidersCommand = awsConfigCommand({
  command: ListSAMLProvidersCommand,
  execute: async (input, context) => {
    const query = `
      SELECT
        arn,
        configuration.SamlMetadataDocument,
        tags
      WHERE
        resourceType = 'AWS::IAM::SAMLProvider'
        AND accountId = '${context.accountId}'
        AND ${resourceStatusWhereClause}
    `

    const results = await executeConfigQuery(query, context)

    const providers = results.map((resultString) => {
      const { configItem, configuration, tags } = parseConfigItem(resultString)
      context.putCache(configItem.arn, 'configuration', { configuration, tags })

      return {
        Arn: configItem.arn
      }
    })

    return {
      SAMLProviderList: providers
    }
  }
})

/**
 * Config-based implementation of IAM GetSAMLProviderCommand
 */
const AwsConfigGetSAMLProviderCommand = awsConfigCommand({
  command: GetSAMLProviderCommand,
  execute: async (input, context) => {
    const { configuration, tags } = context.getCache(input.SAMLProviderArn!, 'configuration')

    return {
      SAMLMetadataDocument: configuration.SamlMetadataDocument,
      Tags: tags
    }
  }
})

/**
 * Config-based implementation of IAM ListPolicyTagsCommand
 */
const AwsConfigListPolicyTagsCommand = awsConfigCommand({
  command: ListPolicyTagsCommand,
  execute: async (input, context) => {
    const policyName = input.PolicyArn!.split('/').pop()!

    const query = `
      SELECT
        tags
      WHERE
        resourceType = 'AWS::IAM::Policy'
        AND accountId = '${context.accountId}'
        AND resourceName = '${policyName}'
        AND ${resourceStatusWhereClause}
    `

    const results = await executeConfigQuery(query, context)

    if (results.length === 0) {
      throw new Error('Policy not found')
    }

    const { tags } = parseConfigItem(results[0])

    return {
      Tags: tags,
      IsTruncated: false
    }
  }
})

/**
 * Given an AWS IAM policy ARN, determine if it is an AWS-managed policy
 *
 * @param policyArn the ARN of the IAM policy
 * @returns true if the policy is AWS-managed, false otherwise
 */
function isAwsManagedPolicy(policyArn: string): boolean {
  return splitArnParts(policyArn).accountId === 'aws'
}

function putInArray(item: any): any[] {
  if (item === undefined || item === null) {
    return []
  }
  return Array.isArray(item) ? item : [item]
}
