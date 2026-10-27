import { AwsClientPool } from '../aws/ClientPool.js'
import { AwsConfigClientPool } from '../awsConfigClients/AwsConfigClientPool.js'
import { type DataSourceConfig, type DataSourceType } from '../config/config.js'

/**
 * Create the appropriate client pool based on data source configuration
 *
 * @param dataSourceConfig The data source configuration
 *
 * @returns A new pool owned by the caller, which must clear it after use
 */
export async function createClientPool(
  dataSourceConfig: DataSourceConfig | undefined
): Promise<AwsClientPool> {
  if (!dataSourceConfig) {
    return new AwsClientPool()
  }

  // Default to aws-sdk if no dataSource is specified
  const dataSourceType: DataSourceType = dataSourceConfig?.name ?? 'aws-sdk'

  if (dataSourceType === 'aws-config') {
    return new AwsConfigClientPool(dataSourceConfig.config || {})
  } else if (dataSourceType === 'aws-sdk') {
    return new AwsClientPool()
  }

  throw new Error(`Unsupported data source type: ${dataSourceType}`)
}
