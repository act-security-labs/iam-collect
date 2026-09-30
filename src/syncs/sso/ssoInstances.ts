import {
  DescribePermissionSetCommand,
  GetInlinePolicyForPermissionSetCommand,
  GetPermissionsBoundaryForPermissionSetCommand,
  type InstanceMetadata,
  ListAccountsForProvisionedPermissionSetCommand,
  ListCustomerManagedPolicyReferencesInPermissionSetCommand,
  ListInstancesCommand,
  ListManagedPoliciesInPermissionSetCommand,
  ListPermissionSetsCommand,
  ListTagsForResourceCommand,
  SSOAdminClient
} from '@aws-sdk/client-sso-admin'
import { runAndCatch404, runAndCatchAccessDenied, withDnsRetry } from '../../utils/client-tools.js'
import { log } from '@actsecurity/log'
import { convertTagsToRecord } from '../../utils/tags.js'
import { type DataRecord, type Sync, syncData } from '../sync.js'
import { createResourceSyncType, createTypedSyncOperation, paginateResource } from '../typedSync.js'

export const SsoDataSync: Sync = {
  awsService: 'sso',
  name: 'instances',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const client = syncOptions.clientPool.client(SSOAdminClient, credentials, region, endpoint)

    const instances = await withDnsRetry(async () => {
      return paginateResource(client, ListInstancesCommand, 'Instances', {
        inputKey: 'NextToken',
        outputKey: 'NextToken'
      })
    })

    const accountInstances = instances.filter(
      (instance) => instance.OwnerAccountId === accountId && instance.Status === 'ACTIVE'
    )

    log.trace('Found SSO instances', {
      accountId,
      region,
      instances: accountInstances.length
    })

    const resourceTypeParts = {
      service: 'sso',
      resourceType: 'instance',
      metadata: {
        region
      }
    }

    const data: DataRecord[] = []
    for (const instance of accountInstances) {
      const command = new ListTagsForResourceCommand({
        InstanceArn: instance.InstanceArn!,
        ResourceArn: instance.InstanceArn!
      })
      const results = await runAndCatchAccessDenied(async () => {
        return client.send(command)
      })
      const tags = convertTagsToRecord(results?.Tags)

      data.push({
        arn: instance.InstanceArn!,
        metadata: {
          name: instance.Name!,
          identityStoreId: instance.IdentityStoreId,
          ownerAccountId: instance.OwnerAccountId,
          status: instance.Status,
          region,
          arn: instance.InstanceArn!
        },
        tags
      })
    }

    await syncData(data, storage, accountId, resourceTypeParts, syncOptions.writeOnly)

    for (const instance of accountInstances) {
      const dataSyncs = createSsoInstanceResourceSyncs(instance, region)

      for (const dataSync of dataSyncs) {
        await dataSync.execute(accountId, region, credentials, storage, endpoint, syncOptions)
      }
    }
  }
}

function createSsoInstanceResourceSyncs(ssoInstance: InstanceMetadata, region: string) {
  return [
    createTypedSyncOperation(
      'sso',
      'permissionSets',
      createResourceSyncType({
        client: SSOAdminClient,
        command: ListPermissionSetsCommand,
        arguments: (awsId, region) => ({
          InstanceArn: ssoInstance.InstanceArn!
        }),
        key: 'PermissionSets',
        paginationConfig: {
          inputKey: 'NextToken',
          outputKey: 'NextToken'
        },
        resourceTypeParts: (accountId: string, region: string) => ({
          service: 'sso',
          resourceType: 'permissionset',
          account: accountId,
          metadata: {
            region
          }
        }),
        arn: (permissionSet) => permissionSet.name!,
        extraFields: {
          tags: async (client, permissionSet) => {
            const command = new ListTagsForResourceCommand({
              InstanceArn: ssoInstance.InstanceArn!,
              ResourceArn: permissionSet.name!
            })
            const results = await client.send(command)
            return results?.Tags
          },
          details: async (client, permissionSet) => {
            const command = new DescribePermissionSetCommand({
              InstanceArn: ssoInstance.InstanceArn!,
              PermissionSetArn: permissionSet.name!
            })
            const results = await client.send(command)
            return results?.PermissionSet
          },
          awsManagedPolicies: async (client, permissionSet) => {
            const command = new ListManagedPoliciesInPermissionSetCommand({
              InstanceArn: ssoInstance.InstanceArn!,
              PermissionSetArn: permissionSet.name!
            })
            const results = await client.send(command)
            return results.AttachedManagedPolicies
          },
          customerManagedPolicies: async (client, permissionSet, account, region, partition) => {
            const results = await paginateResource(
              client,
              ListCustomerManagedPolicyReferencesInPermissionSetCommand,
              'CustomerManagedPolicyReferences',
              {
                inputKey: 'NextToken',
                outputKey: 'NextToken'
              },
              {
                InstanceArn: ssoInstance.InstanceArn!,
                PermissionSetArn: permissionSet.name!
              }
            )
            return results?.map((policy) => ({
              ...policy,
              arn: `arn:${partition}:iam::${account}:policy/${policy.Name}`
            }))
          },
          inlinePolicy: async (client, permissionSet) => {
            const command = new GetInlinePolicyForPermissionSetCommand({
              InstanceArn: ssoInstance.InstanceArn!,
              PermissionSetArn: permissionSet.name!
            })
            const results = await runAndCatch404(async () => {
              const result = await client.send(command)
              if (result?.InlinePolicy) {
                return JSON.parse(result.InlinePolicy)
              }
              return undefined
            })
            return results
          },
          permissionBoundary: async (client, permissionSet) => {
            const command = new GetPermissionsBoundaryForPermissionSetCommand({
              InstanceArn: ssoInstance.InstanceArn!,
              PermissionSetArn: permissionSet.name!
            })
            const permissionBoundary = await (async () => {
              try {
                const result = await client.send(command)
                if (result?.PermissionsBoundary) {
                  return result.PermissionsBoundary
                }
                return undefined
              } catch (e: any) {
                if (e.name === 'ResourceNotFoundException') {
                  return undefined
                }
                throw e
              }
            })()

            return permissionBoundary
          },

          accounts: async (client, permissionSet) => {
            const results = await paginateResource(
              client,
              ListAccountsForProvisionedPermissionSetCommand,
              'AccountIds',
              {
                inputKey: 'NextToken',
                outputKey: 'NextToken'
              },
              {
                InstanceArn: ssoInstance.InstanceArn!,
                PermissionSetArn: permissionSet.name!
              }
            )
            return results
          }
        },
        tags: (permissionSet) => permissionSet.extraFields.tags,
        results: (permissionSet) => ({
          metadata: {
            name: permissionSet.extraFields.details?.Name,
            description: permissionSet.extraFields.details?.Description,
            region
          },
          awsManagedPolicies: permissionSet.extraFields.awsManagedPolicies,
          customerManagedPolicies: permissionSet.extraFields.customerManagedPolicies,
          inlinePolicy: permissionSet.extraFields.inlinePolicy,
          permissionBoundary: permissionSet.extraFields.permissionBoundary,
          accounts: permissionSet.extraFields.accounts
        })
      })
    )
  ]
}
