import { type StorageConfig } from '../config/config.js'
import { type Job, type JobResult, runJobs } from '../jobs/jobQueue.js'
import { createStorageClient } from '../persistence/util.js'
import { log } from '@actsecurity/log'
import { type Indexer } from './indexer.js'

/**
 * An index job to run.
 */
export interface IndexJob {
  /**
   * The indexer to run.
   */
  indexer: Indexer<any>

  /**
   * The account ID to run the indexer for.
   */
  accountId: string

  /**
   * The regions to run the indexer for.
   */
  regions: string[]

  /**
   * The partition to run the indexer for.
   */
  partition: string
}

/**
 * Run index jobs in parallel with a specified concurrency.
 *
 * @param indexJobs the index jobs to run
 * @param storageConfig the storage configuration to use
 * @param concurrency the number of jobs to run in parallel
 */
export async function runIndexJobs(
  indexJobs: IndexJob[],
  storageConfig: StorageConfig,
  concurrency: number
): Promise<JobResult<void, Record<string, unknown>>[]> {
  const sortedJobs: Map<string, Map<string, IndexJob[]>> = new Map()
  for (const job of indexJobs) {
    const partition = job.partition
    const indexerName = job.indexer.name
    if (!sortedJobs.has(partition)) {
      sortedJobs.set(partition, new Map())
    }
    const partitionJobs = sortedJobs.get(partition)!
    if (!partitionJobs.has(indexerName)) {
      partitionJobs.set(indexerName, [])
    }
    partitionJobs.get(indexerName)!.push(job)
  }

  const jobs: Job[] = []
  for (const [partition, partitionJobs] of sortedJobs.entries()) {
    for (const [indexerName, indexerJobs] of partitionJobs.entries()) {
      if (indexerJobs.length === 0) {
        continue
      }
      jobs.push({
        properties: {
          partition,
          indexerName,
          numIndexers: indexerJobs.length
        },
        execute: async (context) => {
          log.debug('Running indexers', { workerId: context.workerId, ...context.properties })
          await runIndexers(partition, storageConfig, indexerJobs)
          log.trace('Finished indexers', { workerId: context.workerId, ...context.properties })
        }
      })
    }
  }

  log.debug('Starting indexing', { jobs: jobs.length, concurrency })
  const indexResults = await runJobs(jobs, concurrency)
  const failedIndexes = indexResults.filter((r) => r.status === 'rejected')
  if (failedIndexes.length > 0) {
    log.error('Some indexers failed', { failedJobs: failedIndexes.length })
    for (const failedJob of failedIndexes) {
      log.error('Indexer failed', failedJob.reason, failedJob.properties)
    }
    throw new Error(`Failed to index some data. See logs for details.`)
  }
  log.info('Finished indexing', { jobs: jobs.length })

  return indexResults
}

/**
 * Run a set of the same indexer jobs for a given partition.
 * All jobs must use the same indexer
 *
 * @param partition the partition to run the indexer for
 * @param storageConfig the storage configuration to use
 * @param indexerJobs the indexer jobs to run
 */
async function runIndexers(
  partition: string,
  storageConfig: StorageConfig,
  indexerJobs: IndexJob[]
): Promise<void> {
  let saved: boolean = false
  let saveAttempts: number = 0
  const indexer = indexerJobs[0].indexer
  const storage = createStorageClient(storageConfig, partition, false)

  while (!saved && saveAttempts < 3) {
    const cache = await indexer.getCache(storage)
    for (const job of indexerJobs) {
      await indexer.updateCache(cache.data, job.accountId, job.regions, storage)
    }
    saved = await indexer.saveCache(storage, cache.data, cache.lockId)
    saveAttempts++
  }
  if (!saved) {
    throw new Error(`Failed to save indexer ${indexer.name} after ${saveAttempts} attempts`)
  }
}
