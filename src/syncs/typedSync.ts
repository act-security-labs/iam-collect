import { ConcurrentWorkerPool, type Job } from '@actsecurity/job'
import type { Client, Command } from '@smithy/smithy-client'
import { AwsClientPool } from '../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../aws/coreAuth.js'
import { type AwsIamStore, type ResourceTypeParts } from '../persistence/AwsIamStore.js'
import { type AwsService } from '../services.js'
import { runAndCatchAccessDeniedWithLog, withDnsRetry } from '../utils/client-tools.js'
import { log } from '@actsecurity/log'
import { convertTagsToRecord, type Tags } from '../utils/tags.js'
import { type DataRecord, type Sync, syncData, type SyncOptions } from './sync.js'

export type ClientConstructor = new (args: any) => Client<any, any, any, any>
type CommandConstructor = new (args: any) => Command<any, any, any, any, any>
type ShortCommandConstructor = new (args: any) => Command<any, any, any>

export type CommandConstructors = CommandConstructor | ShortCommandConstructor

export type ExtractOutputType<T> = T extends CommandConstructors
  ? InstanceType<T> extends Command<any, infer Output, any, any, any>
    ? Output
    : never
  : never
export type ExtractInputType<T> = T extends CommandConstructors
  ? InstanceType<T> extends Command<infer Input, any, any, any, any>
    ? Input
    : never
  : never

type Pagination<C extends CommandConstructors> =
  | {
      inputKey: Extract<keyof ExtractInputType<C>, string>
      outputKey: Extract<keyof ExtractOutputType<C>, string>
    }
  | '::no-pagination::'

type ClientInstanceOrConstructor = InstanceType<ClientConstructor>
/**
 * Paginates through all available resources for a given AWS API
 *
 * @param clientClass The AWS Client class to use
 * @param commandClass The command class to invoke for the resource
 * @param key The key of the resource in the command output to pull
 * @param paginationConfig The pagination configuration for the command, defines the keys to use for pagination, use `::no-pagination::` to indicate no pagination
 * @param params Optional parameters to pass to the command
 * @returns Returns an array of resources returned from the commandClass Response Type key
 */
export async function paginateResource<
  C extends CommandConstructors,
  K extends keyof ExtractOutputType<C>
>(
  clientClassOrInstance: ClientInstanceOrConstructor,
  commandClass: C,
  key: K,
  paginationConfig: Pagination<C>,
  params?: Partial<ExtractInputType<C>>
): Promise<NonNullable<ExtractOutputType<C>[K]>> {
  const client = clientClassOrInstance

  let nextToken: string | undefined = undefined

  const inputPaginationKey = paginationInputKey(paginationConfig)
  const outputPaginationKey = paginationOutputKey(paginationConfig)

  const resources: ExtractOutputType<C>[K] = []
  params = params || {}

  do {
    const args = { ...params } as any
    if (inputPaginationKey) {
      args[inputPaginationKey] = nextToken
    }

    const command = new commandClass(args)
    const results: any = await client.send(command)

    if (results[key]) {
      resources.push(...results[key])
    }

    if (outputPaginationKey) {
      nextToken = results[outputPaginationKey]
    }
  } while (nextToken)

  return resources
}

function paginationInputKey<C extends CommandConstructors>(
  paginationConfig: Pagination<C>
): string | undefined {
  if (paginationConfig === '::no-pagination::') {
    return undefined
  } else if (typeof paginationConfig === 'object') {
    return paginationConfig.inputKey
  } else {
    return undefined
  }
}

function paginationOutputKey<C extends CommandConstructors>(
  paginationConfig: Pagination<C>
): string | undefined {
  if (paginationConfig === '::no-pagination::') {
    return undefined
  } else if (typeof paginationConfig === 'object') {
    return paginationConfig.outputKey
  } else {
    return undefined
  }
}

type ArrayElementType<T> = T extends (infer E)[] ? E : never

type ResourceElementType<C extends CommandConstructors, K extends keyof ExtractOutputType<C>> =
  ArrayElementType<ExtractOutputType<C>[K]> extends string
    ? { name: string }
    : ArrayElementType<ExtractOutputType<C>[K]>

type PromiseType<T extends Promise<any>> = T extends Promise<infer U> ? U : never

// Define the type for the extraFields function
export type ExtraFieldsDefinition<
  C extends ClientConstructor,
  Cmd extends CommandConstructors,
  K extends keyof ExtractOutputType<Cmd>
> = Record<
  string,
  (
    client: InstanceType<C>,
    resource: ResourceElementType<Cmd, K>,
    accountId: string,
    region: string,
    partition: string
  ) => Promise<any>
>

// Use the return type of the extraFields function
type ExtraFieldsReturnType<
  C extends ClientConstructor,
  Cmd extends CommandConstructors,
  K extends keyof ExtractOutputType<Cmd>,
  T extends ExtraFieldsDefinition<any, Cmd, K>
> = {
  [K in keyof T]: PromiseType<ReturnType<T[K]>> | undefined
}

export type ExtendedResourceElementType<
  C extends ClientConstructor,
  Cmd extends CommandConstructors,
  K extends keyof ExtractOutputType<Cmd>,
  ExtraFieldsFunc extends ExtraFieldsDefinition<any, Cmd, K>
> = ResourceElementType<Cmd, K> & { extraFields: ExtraFieldsReturnType<C, Cmd, K, ExtraFieldsFunc> }

export type ResourceSyncType<
  C extends ClientConstructor,
  Cmd extends CommandConstructors,
  K extends keyof ExtractOutputType<Cmd>,
  ExtraFields extends ExtraFieldsDefinition<C, Cmd, K> = Record<string, () => Promise<any>>
> = {
  /**
   * The client to use
   */
  client: C

  /**
   * The command to execute
   */
  command: Cmd

  /**
   * The key of the resource in the command output to pull
   */
  key: K

  /**
   * The pagination token to get from the response and pass to the next call
   */
  paginationConfig: Pagination<Cmd>

  /**
   * The resource type parts used to sync with storage
   *
   * @param accountId the account ID of the resource
   * @param region the region of the resource
   * @returns the resource type parts
   */
  resourceTypeParts: (accountId: string, region: string) => ResourceTypeParts

  /**
   * Custom arguments to pass to the command, useful for filtering resources.
   *
   * @param awsId The AWS account ID being queried
   * @param region The region being queried
   * @returns a set of arguments to pass to the command
   */
  arguments?: (awsId: string, region: string) => Partial<ExtractInputType<Cmd>>

  /**
   * Indicates if the resource type is global.
   */
  globalResourceType?: boolean

  /**
   * The function to get the tags for a resource
   * @param resource The resource to get the tags for
   * @returns The tags for the resource, or undefined if there are no tags
   */
  tags: (resource: ExtendedResourceElementType<C, Cmd, K, ExtraFields>) => Tags | undefined

  /**
   * Create the ARN for a resource
   *
   * @param resource the resource to create the ARN for
   * @param region the region the resource is in
   * @param accountId the account the resource is in
   * @returns the ARN for the resource
   */
  arn: (
    resource: ResourceElementType<Cmd, K>,
    region: string,
    accountId: string,
    partition: string
  ) => string

  /**
   * The extra fields to get for a resource
   * @param client The client to use to get the extra fields
   * @param resource The resource to get the extra fields for
   * @returns an object of extra fields to get, where the key is the name of the field and the value is a function that returns the value of the field
   */
  extraFields?: ExtraFields

  /**
   * The results to persist for a resource, except for the ARN and tags, those are handled automatically.
   *
   * @param resource The resource to get the custom fields for, includes extraFields from the `extraFields` function
   */
  results: (resource: ExtendedResourceElementType<C, Cmd, K, ExtraFields>) => Record<string, any>
}

/**
 * Creates a resource sync type and returns it. This provides cleaner syntax than
 * making one directly and having to define the types twice.
 *
 * @param config Configuration for the resource sync type
 * @returns The ResourceSyncType instance passed in.
 */
export function createResourceSyncType<
  const C extends ClientConstructor,
  const Cmd extends CommandConstructors,
  const K extends keyof ExtractOutputType<Cmd>,
  const ExtraFieldsFunc extends ExtraFieldsDefinition<C, Cmd, K>
>(
  config: ResourceSyncType<C, Cmd, K, ExtraFieldsFunc>
): ResourceSyncType<C, Cmd, K, ExtraFieldsFunc> {
  return config
}

/**
 * Paginates a ResourceSyncType and returns the resources.
 *
 * @param resourceTypeSync The configuration to use.
 * @param credentials The credentials to use for AWS API calls.  Pass undefined to use the environment credentials.
 * @param region The region to get the resources for.
 * @returns Returns all the resources for the given type in the given region with extraFields populated.
 */
export async function paginateResourceConfig<
  C extends ClientConstructor,
  Cmd extends CommandConstructors,
  K extends keyof ExtractOutputType<Cmd>,
  ExtraFieldsFunc extends ExtraFieldsDefinition<C, Cmd, K>
>(
  resourceTypeSync: ResourceSyncType<C, Cmd, K, ExtraFieldsFunc>,
  credentials: AwsCredentialProviderWithMetaData,
  region: string,
  endpoint: string | undefined,
  workerPool: ConcurrentWorkerPool<any, any>,
  awsService: AwsService,
  resourceType: string,
  clientPool: AwsClientPool
): Promise<ExtendedResourceElementType<C, Cmd, K, ExtraFieldsFunc>[]> {
  const accountId = credentials.accountId
  const partition = credentials.partition
  const client = clientPool.client(resourceTypeSync.client, credentials, region, endpoint)

  let resources = await withDnsRetry(() => {
    return paginateResource(
      client,
      resourceTypeSync.command,
      resourceTypeSync.key,
      resourceTypeSync.paginationConfig,
      resourceTypeSync.arguments ? resourceTypeSync.arguments(accountId, region) : undefined
    )
  })

  //If the resource is a string, convert it to an object with the name field set
  if (resources.length > 0 && typeof resources[0] === 'string') {
    resources = resources.map((resource: string) => ({ name: resource }))
  }

  if (resourceTypeSync.extraFields) {
    await Promise.all(
      resources.map(async (resource: any) => {
        const resourceArn = resourceTypeSync.arn(resource, region, accountId, partition)
        const fields = resourceTypeSync.extraFields || {}
        const extraFields =
          Object.entries<
            (
              client: C,
              resource: ResourceElementType<Cmd, K>,
              accountId: string,
              region: string,
              partition: string
            ) => Promise<{}>
          >(fields)
        //Get the extra field values
        const extraFieldPromises = workerPool.enqueueAll(
          extraFields.map(([key, callback]) => ({
            properties: { field: key, arn: resourceArn },
            execute: async (context): Promise<[string, any]> => {
              const value = await withDnsRetry(() => {
                return runAndCatchAccessDeniedWithLog(
                  resourceArn,
                  awsService,
                  resourceType,
                  key,
                  async () => {
                    return callback(
                      client as any,
                      resource,
                      credentials.accountId,
                      region,
                      partition
                    )
                  }
                )
              })
              return [key, value] as [string, any]
            }
          })) as Job<[string, any], Record<string, unknown>>[]
        )

        const extraFieldValues = await Promise.all(extraFieldPromises)
        resource.extraFields = {}
        let anyFailure = false
        for (const result of extraFieldValues) {
          if (result.status === 'rejected') {
            log.error(
              result.reason,
              {
                field: result.properties.field,
                arn: result.properties.arn,
                awsService,
                resourceType
              },
              'Failed to get extra field value'
            )
            anyFailure = true
          } else {
            const value = result.value as [string, any]
            resource.extraFields[value[0]] = value[1]
          }
        }
        if (anyFailure) {
          throw new Error('Failed to get some extra field values')
        }
      })
    )
  }

  return resources
}

/**
 * Create a typed sync operation for a given AWS service and resource type.
 *
 * Because of obscure typescript issues, the order of the keys in `resourceTypeSync` is important.
 * This order is known to work:
 * client, command, key, paginationConfig, arn, extraFields, tags, resourceTypeParts, results
 *
 * @param awsService the AWS service to sync
 * @param name the name of the sync operation
 * @param resourceTypeSync the resource type sync configuration
 * @returns The sync operation
 */
export function createTypedSyncOperation<
  C extends ClientConstructor,
  Cmd extends CommandConstructors,
  K extends keyof ExtractOutputType<Cmd>,
  ExtraFieldsFunc extends ExtraFieldsDefinition<C, Cmd, K>
>(
  awsService: AwsService,
  name: string,
  resourceTypeSync: ResourceSyncType<C, Cmd, K, ExtraFieldsFunc>
): Sync {
  return {
    awsService,
    name,
    global: resourceTypeSync.globalResourceType ?? false,
    execute: async (
      accountId: string,
      region: string,
      credentials: AwsCredentialProviderWithMetaData,
      storage: AwsIamStore,
      endpoint: string | undefined,
      syncOptions: SyncOptions
    ) => {
      const awsId = credentials.accountId
      const clientPool = syncOptions.clientPool

      log.trace('getting resources', { region: region, accountId, service: awsService, name })
      const resources = await paginateResourceConfig(
        resourceTypeSync,
        credentials,
        region,
        endpoint,
        syncOptions.workerPool,
        awsService,
        name,
        clientPool
      )
      log.trace('received resources', { region: region, accountId, service: awsService, name })

      const records: DataRecord[] = resources.map((resource) => {
        const result = resourceTypeSync.results(resource)
        result.arn = resourceTypeSync.arn(resource, region, awsId, credentials.partition)
        if (result.metadata) {
          result.metadata.arn = result.arn
        }
        result.tags = convertTagsToRecord(resourceTypeSync.tags(resource))
        return result as DataRecord
      })

      await syncData(
        records,
        storage,
        accountId,
        resourceTypeSync.resourceTypeParts(awsId, region),
        syncOptions.writeOnly
      )
    }
  }
}
