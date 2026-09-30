import { splitArnParts } from '@actsecurity/iam-utils'
import { sep } from 'path'
import { getStorageConfig, type StorageConfig, type TopLevelConfig } from '../config/config.js'
import { iamCollectVersion } from '../config/packageVersion.js'
import { type AwsIamStore, type StorageClientOptions } from './AwsIamStore.js'
import { FileSystemAdapter } from './file/FileSystemAdapter.js'
import { FileSystemAwsIamStore } from './file/FileSystemAwsIamStore.js'
import { InMemoryPathBasedPersistenceAdapter } from './InMemoryPathBasedPersistenceAdapter.js'
import { S3PathBasedPersistenceAdapter } from './s3/S3PathBasedPersistenceAdapter.js'
import { SqliteAwsIamStore } from './sqlite/SqliteAwsIamStore.js'

/**
 * Create a storage client based on the provided configurations and partition.
 *
 * @param configs - The top-level configurations that define the storage settings.
 * @param partition - The partition to use for the storage client.
 * @param deleteData - Whether to delete existing data in the storage.
 * @param options - Options controlling storage client behavior.
 * @returns The storage client instance to use
 */
export function createStorageClient(
  configs: TopLevelConfig[],
  partition: string,
  deleteData: boolean,
  options?: StorageClientOptions
): AwsIamStore
/**
 * Create a storage client based on the provided storage configuration and partition.
 *
 * @param storageConfig - The storage configuration object that defines the type and path of the storage.
 * @param partition - The partition to use for the storage client.
 * @param deleteData - Whether to delete existing data in the storage.
 * @param options - Options controlling storage client behavior.
 * @returns The storage client instance to use
 */
export function createStorageClient(
  storageConfig: StorageConfig,
  partition: string,
  deleteData: boolean,
  options?: StorageClientOptions
): AwsIamStore
export function createStorageClient(
  storageConfig: StorageConfig | TopLevelConfig[],
  partition: string,
  deleteData: boolean,
  options: StorageClientOptions = {}
): AwsIamStore {
  if (Array.isArray(storageConfig)) {
    const foundConfig = getStorageConfig(storageConfig)
    if (!foundConfig) {
      throw new Error('No storage configuration found. Cannot create storage client.')
    }
    storageConfig = foundConfig
  }

  if (storageConfig.type === 'file') {
    return new FileSystemAwsIamStore(
      storageConfig.path,
      partition,
      sep,
      new FileSystemAdapter(deleteData),
      options
    )
  } else if (storageConfig.type === 's3') {
    const persistenceAdapter = new S3PathBasedPersistenceAdapter(storageConfig, deleteData)
    return new FileSystemAwsIamStore(
      storageConfig.prefix || '',
      partition,
      '/',
      persistenceAdapter,
      options
    )
  } else if (storageConfig.type === 'sqlite') {
    const version = iamCollectVersion()
    return new SqliteAwsIamStore(storageConfig.path, partition, version, options)
  }

  throw new Error(
    `Unsupported storage type: ${(storageConfig as any).type}. Supported types are: file, s3 and sqlite.`
  )
}

/**
 * Create an in-memory storage client with the 'aws' partition.
 *
 * This is useful for testing.
 *
 * @param options - Options controlling storage client behavior.
 * @returns The in-memory storage client instance to use.
 */
export function createInMemoryStorageClient(options: StorageClientOptions = {}): AwsIamStore {
  return new FileSystemAwsIamStore(
    'mock',
    'aws',
    '/',
    new InMemoryPathBasedPersistenceAdapter(),
    options
  )
}

/**
 * Generate a resource prefix given a starting path, a resource ARN, and a separator.
 * The function uses splitArnParts to get the parts of the ARN and then joins each non-empty part
 * with the provided separator. The last segment (resourcePath) is URL encoded.
 *
 * @param startingPath - The starting path (e.g. a base folder)
 * @param resourceArn - The full resource ARN.
 * @param separator - The separator to use (e.g. '/' or '-').
 * @returns A string that represents the resource prefix.
 */
export function resourcePrefix(
  startingPath: string,
  resourceArn: string,
  separator: string
): string {
  const parts = splitArnParts(resourceArn)

  return joinPathParts(
    [
      startingPath,
      parts.service,
      parts.region,
      parts.accountId === 'aws' ? parts.accountId : undefined,
      parts.resourceType,
      parts.resourcePath ? encodeURIComponent(parts.resourcePath.trim()) : undefined
    ],
    separator
  )
}

/**
 * Generate a resource type prefix based on the provided starting path and resource type parts.
 *
 * @param startingPath - The starting path (e.g. a base folder)
 * @param parts - An object containing the components of the resource type
 * @param separator - the separator to use for joining the parts. This could be '/' or any other string.
 * @returns A string that represents the resource type prefix.
 */
export function resourceTypePrefix(
  startingPath: string,
  parts: {
    partition?: string
    account?: string
    service: string
    region?: string
    resourceType?: string
  },
  separator: string
): string {
  return joinPathParts(
    [
      startingPath,
      parts.partition,
      parts.service,
      parts.region,
      parts.account === 'aws' ? parts.account : undefined,
      parts.resourceType
    ],
    separator
  )
}

export function joinPathParts(parts: (string | undefined)[], separator: string): string {
  // Filter out undefined or empty strings
  const filteredParts = parts.filter((part) => part !== undefined && part.trim() !== '')
  // Join the remaining parts with a '/'
  return filteredParts.join(separator)
}
