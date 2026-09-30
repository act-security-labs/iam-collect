import { type AwsService } from '../services.js'
import { log } from '@actsecurity/log'

/**
 *
 * @param operation The operation to run.
 * @returns If successful, returns the result of operation. If operation returns a 404, returns undefined.
 * @throws If operation returns a non 404 error, rethrows that error.
 */
export async function runAndCatch404<T>(
  operation: () => Promise<T | undefined>
): Promise<T | undefined> {
  try {
    const result = await operation()
    return result
  } catch (e: any) {
    if (e['$metadata']?.httpStatusCode == 404) {
      return undefined
    }
    throw e
  }
}

/**
 *
 * @param operation The operation to run.
 * @returns If successful, returns the result of operation. If operation returns a 404, returns undefined.
 * @throws If operation returns a non 400 error, rethrows that error.
 */
export async function runAndCatchAccessDenied<T>(
  operation: () => Promise<T | undefined>,
  onError?: (error: any) => Promise<T | undefined>
): Promise<T | undefined> {
  try {
    const result = await operation()
    return result
  } catch (e: any) {
    const errorName = e.name

    if (
      errorName == 'AccessDeniedException' ||
      errorName == 'AccessDenied' ||
      errorName == 'AuthorizationErrorException'
    ) {
      if (onError) {
        return onError(e)
      }
      return undefined
    }
    throw e
  }
}

export async function runAndCatchAccessDeniedWithLog<T>(
  arn: string,
  awsService: AwsService,
  resourceType: string,
  field: string,
  operation: () => Promise<T | undefined>
): Promise<T | undefined> {
  return runAndCatchAccessDenied(operation, async (error: any) => {
    log.warn(`Access denied for ${field} in ${arn}`, error, {
      accessDenied: true,
      arn,
      field,
      resourceType,
      awsService
    })
    return undefined
  })
}

/**
 * Run an operation and catch a specific error by name. Return undefined if the error matches, otherwise rethrow the error.
 *
 * @param errorName the name of the error to catch
 * @param operation the operation to run
 * @returns If successful, returns the result of operation. If operation throws an error with the specified name, returns undefined.
 * @throws If operation throws an error with a different name, rethrows that error.
 */

export async function runAndCatchError<T>(
  errorName: string,
  operation: () => Promise<T | undefined>,
  onError?: (error: any) => Promise<T | undefined>
): Promise<T | undefined> {
  try {
    const result = await operation()
    return result
  } catch (e: any) {
    if (e.name == errorName) {
      if (onError) {
        return onError(e)
      }
      return undefined
    }
    throw e
  }
}

const DNS_RETRY_DELAY = 1_500

/**
 * Retry a function that may fail due to DNS resolution issues.
 *
 * @param fn the function to retry
 * @param tries the number of times to retry the function
 * @returns the result of the function if successful, otherwise throws the last error encountered
 */
export async function withDnsRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e: any) {
      const m = e?.message || ''
      if (m.startsWith('getaddrinfo')) {
        await new Promise((r) => setTimeout(r, DNS_RETRY_DELAY + Math.random() * DNS_RETRY_DELAY))
        last = e
        continue
      }
      throw e
    }
  }
  throw last
}
