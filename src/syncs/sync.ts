import { ConcurrentWorkerPool } from '@actsecurity/job'
import { AwsClientPool } from '../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../aws/coreAuth.js'
import { type AwsIamStore, type ResourceTypeParts } from '../persistence/AwsIamStore.js'
import { type AwsService } from '../services.js'

export interface SyncOptions {
  workerPool: ConcurrentWorkerPool<any, any>
  writeOnly: boolean
  customConfig?: Record<string, any>
  clientPool: AwsClientPool
}

export interface Sync {
  /**
   * What service the sync is for.
   */
  awsService: AwsService

  /**
   * The name of the sync. This should be a unique identifier for the sync.
   */
  name: string

  /**
   * Is the sync global. If so, it should only be one in one region per account.
   */
  global?: boolean

  /**
   * Execute the sync for a given account and region.
   */
  execute(
    accountId: string,
    region: string,
    credentials: AwsCredentialProviderWithMetaData,
    storage: AwsIamStore,
    endpoint: string | undefined,
    syncOptions: SyncOptions
  ): Promise<void>
}

export type DataRecord = Record<string, any> & { arn: string }

/**
 * Synchronize the data for a given set of resources.
 * This will:
 * 1. Delete any resources that meet the `resourceTypeParts` and are not in the `records` list.
 * 2. Save all resources that are in the `records`.
 *
 * @param records the records to synchronize, must include the ARN
 * @param storage the storage client to use for updating metadata
 * @param accountId the account ID to synchronize data for
 * @param resourceTypeParts the resource type parts to synchronize
 * @param writeOnly if true, will only write data and not delete any existing data
 */
export async function syncData(
  records: DataRecord[],
  storage: AwsIamStore,
  accountId: string,
  resourceTypeParts: ResourceTypeParts,
  writeOnly: boolean
) {
  if (!writeOnly) {
    const allArns = records.map((r) => r.arn)
    await storage.syncResourceList(accountId, resourceTypeParts, allArns)
  }

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (key === 'arn') {
        continue
      }
      await storage.saveResourceMetadata(accountId, record.arn, key, value)
    }
  }
}
