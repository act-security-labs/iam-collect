import { type AuthConfig } from '../config/config.js'
import { log } from '@actsecurity/log'
import { type AwsCredentialProviderWithMetaData, getNewCredentials, now } from './coreAuth.js'

/**
 * We cache credentials with a timeout
 */
const credentialsCache: Map<
  string,
  {
    expiration: number
    credentials: AwsCredentialProviderWithMetaData
  }
> = new Map()

// Currently using a static timeout
const CREDENTIAL_CACHE_TIMEOUT = 300 * 1000

/**
 * We cache requests for credentials to avoid multiple requests for the same accountId and authConfig.
 */
const credentialRequestCache: Record<string, Promise<AwsCredentialProviderWithMetaData>> = {}

/**
 * Generate a cache key for the given account ID and auth configuration.
 *
 * @param accountId the AWS account ID
 * @param authConfig the authentication configuration, if any
 * @returns a unique cache key for the credentials
 */
function credentialsCacheKey(accountId: string, authConfig: AuthConfig | undefined): string {
  return authConfig ? `${accountId}:${JSON.stringify(authConfig)}` : accountId
}

/**
 * Get cached credentials for the given cache key, if they exist and are not expired.
 *
 * @param cacheKey the cache key to get credentials for
 * @returns the cached credentials if they exist and are not expired, otherwise undefined
 */
function getCachedCredentials(cacheKey: string): AwsCredentialProviderWithMetaData | undefined {
  const cached = credentialsCache.get(cacheKey)
  if (cached && cached.expiration > Date.now()) {
    return cached.credentials
  }
  credentialsCache.delete(cacheKey)
  return undefined
}

/**
 * Cache a set of credentials
 *
 * @param cacheKey the cache key to use for the credentials
 * @param credentials the credentials to cache
 */
function setCachedCredentials(
  cacheKey: string,
  credentials: AwsCredentialProviderWithMetaData
): void {
  const expiration = now() + CREDENTIAL_CACHE_TIMEOUT
  credentialsCache.set(cacheKey, { expiration, credentials })
}

/**
 * Get credentials for the given account ID and auth configuration.
 *
 * @param accountId the AWS account ID for which to get credentials
 * @param authConfig the authentication configuration to use for the account
 * @returns new or cached credentials based on the provided account ID and auth configuration
 */
export async function getCredentials(
  accountId: string,
  authConfig: AuthConfig | undefined
): Promise<AwsCredentialProviderWithMetaData> {
  const cacheKey = credentialsCacheKey(accountId, authConfig)
  const cachedCredentials = getCachedCredentials(cacheKey)
  if (cachedCredentials) {
    log.trace({ accountId }, 'Using cached credentials')
    return cachedCredentials
  }

  if (credentialRequestCache[cacheKey] !== undefined) {
    return credentialRequestCache[cacheKey]
  }

  //Create a new promise and store it in case another request comes in while this one is being processed.
  return (credentialRequestCache[cacheKey] = (async () => {
    try {
      log.trace({ accountId }, 'Creating new credentials')
      const newCredentials = await getNewCredentials(accountId, authConfig)
      setCachedCredentials(cacheKey, newCredentials)
      return newCredentials
    } finally {
      delete credentialRequestCache[cacheKey] // Clean up the queue regardless of success or failure.
    }
  })())
}
