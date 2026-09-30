import { ConcurrentWorkerPool } from '@actsecurity/job'
import { getCredentials } from '../aws/auth.js'
import { AwsClientPool } from '../aws/ClientPool.js'
import {
  type AwsCredentialProviderWithMetaData,
  getNewInitialCredentials
} from '../aws/coreAuth.js'
import {
  accountServiceRegionConfig,
  type AuthConfig,
  configuredRegionListForAccount,
  customConfigForSync,
  getAccountAuthConfig,
  getConfiguredAccounts,
  getConfiguredDataSource,
  getDefaultAuthConfig,
  getStorageConfig,
  regionsForService,
  servicesForAccount,
  syncEnabledForRegion,
  type TopLevelConfig
} from '../config/config.js'
import { createClientPool } from '../config/dataSource.js'
import { getPartitionDefaults } from '../config/partitionDefaults.js'
import { getIndexersForService } from '../indexing/indexMap.js'
import { type IndexJob, runIndexJobs } from '../indexing/runIndexers.js'
import { JobRunner } from '../jobs/jobRunner.js'
import { defaultConcurrency } from '../jobs/util.js'
import { createStorageClient } from '../persistence/util.js'
import { getEnabledRegions } from '../regions.js'
import { allServices } from '../services.js'
import { getGlobalSyncsForService, getRegionalSyncsForService } from '../syncs/syncMap.js'
import { log } from '@actsecurity/log'

/**
 * Download data from AWS services.
 *
 * @param configs the configurations to use for the download
 * @param accountIds the account IDs to download data for
 * @param regions the regions to download data from
 * @param services the services to download data from
 * @param concurrency the maximum number of concurrent downloads
 * @param skipIndex whether to skip indexing the downloaded data
 * @param writeOnly only write the data returned from AWS, do not delete any existing data
 */
export async function downloadData(
  configs: TopLevelConfig[],
  accountIds: string[],
  regions: string[],
  services: string[],
  concurrency: number | undefined,
  skipIndex: boolean,
  writeOnly: boolean
): Promise<void> {
  if (concurrency === undefined || concurrency <= 0) {
    concurrency = defaultConcurrency()
  }
  const deleteData = !writeOnly

  const defaultAuthConfig = getDefaultAuthConfig(configs)
  const defaultCredentials = await getNewInitialCredentials(defaultAuthConfig, {
    phase: 'initial default credentials'
  })

  if (accountIds.length === 0) {
    /*
      If no accounts were passed in:
      1. Check the config for any configured accounts
      2. If no configured accounts, use the default credentials to get the current account
     */
    const configuredAccounts = getConfiguredAccounts(configs)
    if (configuredAccounts.length > 0) {
      accountIds = configuredAccounts
    } else {
      accountIds = [defaultCredentials.accountId]
    }
  }

  // Create the client pool and initialize it
  const dataSourceConfig = getConfiguredDataSource(configs)
  const clientPool = await createClientPool(dataSourceConfig)
  await clientPool.init()

  const defaultPartition = defaultCredentials.partition

  const storageConfig = getStorageConfig(configs)
  if (!storageConfig) {
    throw new Error('No storage configuration found. Cannot download data.')
  }

  const storage = createStorageClient(storageConfig, defaultPartition, deleteData)

  const indexJobs: IndexJob[] = []

  log.debug('Starting download runner', { concurrency })
  const downloadRunner = new JobRunner(concurrency)
  const workerPool = new ConcurrentWorkerPool(concurrency, log)

  for (const accountId of accountIds) {
    log.info('Queuing downloads for account', { accountId })
    const authForAccount = getAccountAuthConfig(accountId, configs)
    const credentials = await getCredentialsForSync(
      clientPool,
      defaultPartition,
      accountId,
      authForAccount
    )
    const accountPartition = credentials.partition
    if (accountPartition !== defaultPartition) {
      //TODO: Consider updating the storage client to handle multiple partitions
      log.error(
        `Account ${accountId} is in partition ${accountPartition}, but the default account is in partition ${defaultPartition}. This is not supported.`
      )
      throw new Error('Cannot download data for multiple partitions in one run.')
    }
    const partitionConfig = getPartitionDefaults(accountPartition)
    const accountConfigs = [partitionConfig, ...configs]
    const accountRegions = await getAccountRegions(
      regions,
      accountId,
      configs,
      credentials,
      clientPool
    )

    if (services.length === 0) {
      services = allServices as unknown as string[]
    }
    const syncOptions = {
      workerPool,
      writeOnly,
      clientPool
    }

    const enabledServices = servicesForAccount(accountId, accountConfigs, services)
    for (const service of enabledServices) {
      log.info('Queuing downloads', { service, accountId })
      const serviceRegions = regionsForService(service, accountId, accountConfigs, accountRegions)

      //Global syncs for the service
      const globalSyncs = getGlobalSyncsForService(service)
      const globalRegion = serviceRegions.at(0)!
      const globalConfig = accountServiceRegionConfig(
        service,
        accountId,
        globalRegion,
        accountConfigs
      )

      for (const globalSync of globalSyncs) {
        const customConfig = customConfigForSync(
          service,
          globalSync.name,
          accountId,
          globalRegion,
          accountConfigs
        )

        if (!clientPool.isSyncSupported(service, globalSync.name, globalRegion)) {
          log.info(
            {
              skippedSync: true,
              service,
              accountId,
              sync: globalSync.name,
              clientPool: clientPool.constructor.name
            },
            'Skipping global sync, not supported by data source'
          )
          continue
        }
        downloadRunner.enqueue({
          properties: { service, accountId, sync: globalSync.name },
          execute: async (context) => {
            const logDetails = {
              workerId: context.workerId,
              ...context.properties
            }
            const globalCredentials = await getCredentialsForSync(
              clientPool,
              defaultPartition,
              accountId,
              globalConfig.auth
            )
            log.debug(logDetails, 'Executing global sync')
            await globalSync.execute(
              accountId,
              globalRegion,
              globalCredentials,
              storage,
              globalConfig.endpoint,
              { ...syncOptions, customConfig }
            )
            log.trace(logDetails, 'Finished global sync')
          }
        })
      }

      const regionalSyncs = getRegionalSyncsForService(service)
      //Regional syncs for the service
      for (const region of serviceRegions) {
        if (regionalSyncs.length === 0) {
          continue
        }
        log.debug({ service, accountId, region }, 'Queuing regional syncs')
        const asrConfig = accountServiceRegionConfig(service, accountId, region, accountConfigs)

        for (const sync of regionalSyncs) {
          const includeSync = syncEnabledForRegion(
            accountId,
            service,
            sync.name,
            accountConfigs,
            region
          )
          if (!includeSync) {
            log.debug({ service, accountId, region, syncName: sync.name }, 'Skipping regional sync')
            continue
          }
          if (!clientPool.isSyncSupported(service, sync.name, region)) {
            log.info(
              {
                skippedSync: true,
                service,
                accountId,
                sync: sync.name,
                region,
                clientPool: clientPool.constructor.name
              },
              'Skipping regional sync, not supported by data source'
            )
            continue
          }
          const customConfig = customConfigForSync(
            service,
            sync.name,
            accountId,
            region,
            accountConfigs
          )
          downloadRunner.enqueue({
            properties: { service, accountId, region, sync: sync.name },
            execute: async (context) => {
              const logDetails = {
                workerId: context.workerId,
                ...context.properties
              }
              log.debug(logDetails, 'Executing regional sync')
              const regionalCredentials = await getCredentialsForSync(
                clientPool,
                accountPartition,
                accountId,
                asrConfig.auth
              )

              await sync.execute(
                accountId,
                region,
                regionalCredentials,
                storage,
                asrConfig.endpoint,
                { ...syncOptions, customConfig }
              )
              log.trace(logDetails, 'Finished regional sync')
            }
          })
        }
      }

      const indexers = getIndexersForService(service)
      for (const indexer of indexers) {
        indexJobs.push({
          indexer,
          partition: accountPartition,
          accountId,
          regions: serviceRegions
        })
      }
    }
  }

  log.info('Waiting for downloads to complete')
  await downloadRunner.finishAllWork()
  log.info('Finished downloads', { jobs: downloadRunner.getResults().length })
  const failedJobs = downloadRunner.getResults().filter((r) => r.status === 'rejected')
  if (failedJobs.length > 0) {
    log.error('Some downloads failed', { failedJobs: failedJobs.length })
    for (const failedJob of failedJobs) {
      log.error('Download failed', failedJob.reason, failedJob.properties)
    }
    throw new Error(`Failed to download some data. See logs for details.`)
  }

  if (skipIndex) {
    log.info('Skipping indexing')
    return
  }

  await runIndexJobs(indexJobs, storageConfig, concurrency)
}

/**
 * Get the regions to use for an account
 *
 * @param allRegions the list of all available regions
 * @param accountId the ID of the account
 * @param configs the iam-collect configs
 * @param accountCredentials the credentials for the account
 * @returns a list of regions to use for the account
 */
async function getAccountRegions(
  allRegions: string[],
  accountId: string,
  configs: TopLevelConfig[],
  accountCredentials: AwsCredentialProviderWithMetaData,
  clientPool: AwsClientPool
): Promise<string[]> {
  if (allRegions.length > 0) {
    return allRegions
  }

  const configuredRegions = configuredRegionListForAccount(configs, accountId)
  if (configuredRegions) {
    log.debug('Using configured regions', { regions: configuredRegions, accountId })
    return configuredRegions
  } else {
    log.debug('No configured regions found, discovering regions for account', {
      accountId
    })
    return getEnabledRegions(accountCredentials, clientPool)
  }
}

async function getCredentialsForSync(
  clientPool: AwsClientPool,
  currentPartition: string,
  accountId: string,
  authConfig: AuthConfig | undefined
): Promise<AwsCredentialProviderWithMetaData> {
  if (clientPool.requiresAwsCredentials()) {
    return getCredentials(accountId, authConfig)
  }

  return {
    accountId: accountId,
    partition: currentPartition,
    cacheKey: 'no-credentials',
    provider: async () => {
      throw new Error('No credentials required for this data source')
    }
  }
}
