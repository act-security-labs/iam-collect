import { LambdaClient } from '@aws-sdk/client-lambda'
import { SESClient } from '@aws-sdk/client-ses'
import { type RetryStrategyV2 } from '@aws-sdk/types'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { Client } from '@smithy/smithy-client'
import {
  AdaptiveRetryStrategy,
  DefaultRateLimiter,
  type DefaultRateLimiterOptions
} from '@smithy/util-retry'
import { type AwsService } from '../services.js'
import { type AwsCredentialProviderWithMetaData } from './coreAuth.js'

export type ClientConstructor<T> = new (args: any) => T
export type AnyClient = Client<any, any, any, any>

const retrySettings: Record<string, DefaultRateLimiterOptions> = {
  [LambdaClient.name]: {
    beta: 0.4, // cut harder on throttle (default 0.7)
    minFillRate: 0.2, // lower baseline QPS (default 0.5)
    scaleConstant: 0.1, // slower cubic ramp (default 0.4)
    smooth: 0.5 // dampen measured rate (default 0.8)
  },
  [SESClient.name]: {
    beta: 0.4, // SES identity APIs are limited to one request per second
    minFillRate: 0.2,
    scaleConstant: 0.1,
    smooth: 0.5
  }
}

export class AwsClientPool {
  public static defaultInstance = new AwsClientPool()

  private clientCache = new Map<string, AnyClient>()
  private defaultRetryStrategy: RetryStrategyV2
  constructor() {
    this.defaultRetryStrategy = this.makeRetryStrategy({
      beta: 0.5, // cut harder on throttle (default 0.7)
      minFillRate: 0.25, // lower baseline QPS (default 0.5)
      scaleConstant: 0.2, // slower cubic ramp (default 0.4)
      smooth: 0.6 // dampen measured rate (default 0.8)
    })
  }

  /**
   * Returns a client of the specified type with the specified credentials and region.
   * Will create a new client if one does not already exist in the cache.
   *
   * @param ClientType The client constructor to create an instance of.
   * @param credentials The credentials to use for the client.
   * @param region The region to use for the client.
   * @returns A client of the specified type with the specified credentials and region.
   */
  public client<T extends AnyClient>(
    ClientType: ClientConstructor<T>,
    credentials: AwsCredentialProviderWithMetaData,
    region: string | undefined,
    endpoint: string | undefined
  ): T {
    const cacheKey = this.getCacheKey(ClientType, credentials, region, endpoint)

    if (!this.clientCache.has(cacheKey)) {
      const client = new ClientType({
        credentials: credentials.provider,
        region,
        maxAttempts: 10,
        requestHandler: new NodeHttpHandler({
          connectionTimeout: 5_000,
          socketTimeout: 15_000
        }),
        retryStrategy: this.retryStrategyForClient(ClientType)
      })
      this.clientCache.set(cacheKey, client)
    }

    return this.clientCache.get(cacheKey) as T
  }

  private getCacheKey<T extends AnyClient>(
    ClientType: ClientConstructor<T>,
    credentials: AwsCredentialProviderWithMetaData,
    region: string | undefined,
    endpoint: string | undefined
  ): string {
    return `${ClientType.name}:${credentials.accountId}:${credentials.cacheKey}:${region}:${endpoint}`
  }

  /**
   * Destroys all clients in the pool and empties the cache.
   *
   * NOT THREAD SAFE, this should only be called when all other operations are complete.
   */
  public clear(): void {
    this.clientCache.forEach((client) => {
      if (typeof client.destroy === 'function') {
        client.destroy()
      }
    })
    this.clientCache.clear()
  }

  /**
   * Do any async initialization required for the client pool. Should be called
   * before the first use of the pool.
   */
  public async init(): Promise<void> {}

  /**
   * Whether this client pool requires valid AWS credentials for each instance.
   */
  public requiresAwsCredentials(): boolean {
    return true
  }

  /**
   * Determine if a given sync is supported by this client pool for the given service and region.
   *
   * @param service the AWS service
   * @param syncName the name of the sync operation
   * @param region the AWS region
   * @returns true if the sync is supported, false otherwise
   */
  public isSyncSupported(service: AwsService, syncName: string, region: string): boolean {
    return true
  }

  private retryStrategyForClient(client: ClientConstructor<any>): RetryStrategyV2 {
    const settings = retrySettings[client.name]
    if (settings) {
      return this.makeRetryStrategy(settings)
    }
    return this.defaultRetryStrategy
  }

  private makeRetryStrategy(rateLimiterOptions: DefaultRateLimiterOptions): RetryStrategyV2 {
    return new AdaptiveRetryStrategy(async () => 20, {
      rateLimiter: new DefaultRateLimiter(rateLimiterOptions)
    })
  }
}
