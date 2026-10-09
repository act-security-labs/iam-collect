import { OrganizationsClient } from '@aws-sdk/client-organizations'
import { type RetryStrategyV2 } from '@aws-sdk/types'
import { DefaultRateLimiter } from '@smithy/util-retry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AwsClientPool } from './ClientPool.js'

describe('AwsClientPool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows 20 total attempts when using a custom rate limiter', async () => {
    // Skip pacing delays, but keep the real retry strategy and retry budget.
    vi.spyOn(DefaultRateLimiter.prototype, 'getSendToken').mockResolvedValue(undefined)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const pool = new AwsClientPool()
    try {
      const client = pool.client(
        OrganizationsClient,
        {
          accountId: '111111111111',
          partition: 'aws',
          cacheKey: 'test',
          provider: async () => ({ accessKeyId: 'test', secretAccessKey: 'test' })
        },
        'us-east-1',
        undefined
      )
      const strategy = (await client.config.retryStrategy()) as RetryStrategyV2
      let token = await strategy.acquireInitialRetryToken('test')

      // The initial attempt plus 19 retries must be allowed, not the SDK's
      // three-attempt fallback for a provider combined with limiter options.
      for (let retries = 1; retries < 20; retries++) {
        token = await strategy.refreshRetryTokenForRetry(token, { errorType: 'THROTTLING' })
        expect(token.getRetryCount()).toBe(retries)
      }
      await expect(
        strategy.refreshRetryTokenForRetry(token, { errorType: 'THROTTLING' })
      ).rejects.toThrow()
    } finally {
      pool.clear()
    }
  })
})
