import { getStorageConfig, type TopLevelConfig } from '../config/config.js'
import { type Indexer } from '../indexing/indexer.js'
import { getIndexersForService } from '../indexing/indexMap.js'
import { type IndexJob, runIndexJobs } from '../indexing/runIndexers.js'
import { defaultConcurrency } from '../jobs/util.js'
import { createStorageClient } from '../persistence/util.js'
import { allServices, type AwsService } from '../services.js'

export async function index(
  configs: TopLevelConfig[],
  partition: string,
  accountIds: string[],
  regions: string[],
  services: AwsService[],
  concurrency: number | undefined
): Promise<void> {
  const storageConfig = getStorageConfig(configs)
  if (!storageConfig) {
    throw new Error('No storage configuration found. Cannot index data.')
  }
  const storage = createStorageClient(storageConfig, partition, false)

  try {
    if (accountIds.length === 0) {
      accountIds = await storage.listAccountIds()
    }

    if (services.length === 0) {
      services = allServices as unknown as AwsService[]
    }

    if (!concurrency || concurrency <= 0) {
      concurrency = defaultConcurrency()
    }

    const indexers = services.reduce((allIndexers, service) => {
      allIndexers.push(...getIndexersForService(service))
      return allIndexers
    }, [] as Indexer<any>[])

    const jobs: IndexJob[] = []
    for (const accountId of accountIds) {
      for (const indexer of indexers) {
        jobs.push({
          indexer,
          accountId,
          regions: regions,
          partition
        })
      }
    }

    await runIndexJobs(jobs, storageConfig, concurrency)
  } finally {
    await storage.close?.()
  }
}
