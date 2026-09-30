import {
  fromIni,
  fromNodeProviderChain,
  fromTemporaryCredentials
} from '@aws-sdk/credential-providers'
import {
  type AwsCredentialIdentity,
  type IdentityProvider,
  type RuntimeConfigIdentityProvider
} from '@aws-sdk/types'
import { type AuthConfig } from '../config/config.js'
import { log } from '@actsecurity/log'
import { randomCharacters, shortHash } from '../utils/strings.js'
import { getTokenInfo } from './tokens.js'

/**
 * Credentials with additional metadata, including the AWS account ID and partition.
 */
export interface AwsCredentialIdentityWithMetaData extends AwsCredentialIdentity {
  /**
   * The AWS partition (e.g., 'aws', 'aws-cn', 'aws-us-gov').
   */
  partition: string

  /**
   * The AWS account ID associated with these credentials.
   */
  accountId: string
}

type AwsCredentialProviders =
  IdentityProvider<AwsCredentialIdentity> | RuntimeConfigIdentityProvider<AwsCredentialIdentity>

export type AwsCredentialProviderWithMetaData = {
  provider: AwsCredentialProviders

  /**
   * The AWS partition (e.g., 'aws', 'aws-cn', 'aws-us-gov').
   */
  partition: string

  /**
   * The AWS account ID associated with these credentials.
   */
  accountId: string

  /**
   * A unique cache key for these credentials.
   */
  cacheKey: string
}

/**
 * What time is it now?
 *
 * This exists to make unit tests of caching behavior easier.
 *
 * @returns the current timestamp in milliseconds since the Unix epoch
 */
export function now(): number {
  return Date.now()
}

/**
 * Get brand new credentials for the given account ID and auth configuration.
 *
 * DO NOT USE THIS DIRECTLY. Use `getCredentials` in `auth.ts` instead
 *
 * @param accountId the AWS account ID for which to get credentials
 * @param authConfig the authentication configuration to use for the account
 * @returns new credentials based on the provided account ID and auth configuration
 */
export async function getNewCredentials(
  accountId: string,
  authConfig: AuthConfig | undefined
): Promise<AwsCredentialProviderWithMetaData> {
  const cacheKey = await shortHash(JSON.stringify({ accountId, authConfig }))
  const baseCredentials = await getNewInitialCredentials(authConfig, {
    accountId
  })

  let credentials = baseCredentials
  if (authConfig?.role) {
    const roleArn = buildRoleArn(baseCredentials.partition, accountId, authConfig.role.pathAndName)
    log.trace(
      { accountId, roleArn, sourceAccount: baseCredentials.accountId },
      'Assuming role for account with credentials'
    )
    const roleProvider = fromTemporaryCredentials({
      masterCredentials: baseCredentials.provider,
      params: {
        RoleArn: roleArn,
        ExternalId: authConfig.role.externalId,
        RoleSessionName: authConfig.role.sessionName || `iam-collect-${randomCharacters()}`
      }
    })

    credentials = {
      cacheKey,
      provider: roleProvider,
      accountId: accountId,
      partition: baseCredentials.partition
    }
  } else if (baseCredentials.accountId != accountId) {
    // If the account ID from the credentials doesn't match the expected account ID and no role is specified
    // throw an error to indicate that the credentials do not match the expected account
    log.error('Auth config, account mismatch', {
      desiredAccountId: accountId,
      currentAccountId: baseCredentials.accountId
    })
    throw new Error(
      `The credentials provided do not match the expected account ID ${accountId}. Found ${baseCredentials.accountId}. Please check your auth configuration.`
    )
  }

  return credentials
}

/**
 * This gets a new set of initial credentials for an auth configuration. These are the initial
 * credentials that are the default credentials are used to then assume a role if one is specified.
 * There are very few cases where this should be used directly, and in most cases you should use
 * getNewCredentials instead.
 *
 * @param authConfig the authentication configuration to use
 * @param logInfo any additional information to log while getting the credentials
 * @returns new credentials based on the provided auth configuration
 */
export async function getNewInitialCredentials(
  authConfig: AuthConfig | undefined,
  logInfo: Record<string, unknown> = {}
): Promise<AwsCredentialProviderWithMetaData> {
  let provider: AwsCredentialProviders
  let credentials: AwsCredentialIdentity
  const cacheKey = await shortHash(JSON.stringify({ authConfig }))
  if (authConfig?.profile) {
    log.trace({ ...logInfo, profile: authConfig.profile }, 'Using profile for credentials')
    provider = fromIni({ profile: authConfig.profile })
    credentials = await provider()
  } else {
    log.trace(logInfo, 'Using default SDK credential chain')
    provider = fromNodeProviderChain()
    credentials = await provider()
  }

  let tokenInfo = await getTokenInfo(credentials)
  log.trace('initial credentials', tokenInfo)

  if (authConfig?.initialRole) {
    let roleArn: string
    if ('arn' in authConfig?.initialRole) {
      roleArn = authConfig.initialRole.arn
    } else {
      roleArn = buildRoleArn(
        tokenInfo.partition,
        tokenInfo.accountId,
        authConfig.initialRole.pathAndName
      )
    }

    log.trace(
      { roleArn, sourceAccount: tokenInfo.accountId, ...logInfo },
      'Assuming initial role for account with credentials'
    )
    const roleProvider = fromTemporaryCredentials({
      masterCredentials: credentials,
      params: {
        RoleArn: roleArn,
        ExternalId: authConfig.initialRole.externalId,
        RoleSessionName: authConfig.initialRole.sessionName || `iam-collect-${randomCharacters()}`
      }
    })

    provider = roleProvider
    credentials = await roleProvider()
    tokenInfo = await getTokenInfo(credentials)
  }

  return {
    cacheKey,
    provider,
    accountId: tokenInfo.accountId,
    partition: tokenInfo.partition
  }
}

/**
 * Get the ARN for an IAM role.
 *
 * @param partition The partition the role is in (e.g. "aws", "aws-us-gov", "aws-cn").
 * @param accountId The ID of the account the role is in.
 * @param rolePathAndName The path and name of the role.
 * @returns The ARN of the role.
 */
export function buildRoleArn(
  partition: string,
  accountId: string,
  rolePathAndName: string
): string {
  if (!rolePathAndName.startsWith('/')) {
    rolePathAndName = `/${rolePathAndName}`
  }
  return `arn:${partition}:iam::${accountId}:role${rolePathAndName}`
}
