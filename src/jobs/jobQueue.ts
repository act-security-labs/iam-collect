import { log } from '@actsecurity/log'

/**
 * Represents the outcome of a job:
 * - `fulfilled` with a `value` if it succeeded
 * - `rejected` with a `reason` if it threw.
 */
export type JobResult<T, P> =
  | { status: 'fulfilled'; value: T; properties: P }
  | { status: 'rejected'; reason: any; properties: P }

export interface JobContext {
  workerId: number
}

/**
 * Represents a job that can be executed
 */
export interface Job<T = void, P = Record<string, unknown>> {
  /**
   * Execute the job with the given context.
   *
   * @param context - The context for the job execution, see @link JobContext
   * @returns A promise that is resolved by the job's worker
   */
  execute: (props: JobContext & { properties: P }) => Promise<T>

  /**
   * Properties associated with the job, useful for logging or tracking.
   */
  properties: P
}

/**
 * Runs the given jobs with up to `concurrency` tasks in flight at once.
 * Resolves with an array of results in the same order as the jobs.
 */
export async function runJobs<T = void, P = Record<string, unknown>>(
  jobs: Job<T, P>[],
  concurrency: number
): Promise<JobResult<T, P>[]> {
  const results: JobResult<T, P>[] = []
  let nextIndex = 0

  // Each worker pulls the next available job, runs it, stores the result, then loops.
  async function worker(workerId: number) {
    while (true) {
      const i = nextIndex++
      if (i >= jobs.length) return

      const context: JobContext = {
        workerId
      }

      const startTime = Date.now()
      const interval = setInterval(() => {
        log.warn(
          `Long-running job detected.`,
          { minutes: Math.floor((Date.now() - startTime) / 60000) },
          { ...context, ...jobs[i].properties }
        )
      }, 60_000)
      try {
        const value = await jobs[i].execute({ ...context, properties: jobs[i].properties })
        results[i] = { status: 'fulfilled', value, properties: jobs[i].properties }
      } catch (reason) {
        results[i] = { status: 'rejected', reason, properties: jobs[i].properties }
      } finally {
        clearInterval(interval)
      }
    }
  }

  // Create a pool of workers maxed at `concurrency` up to the number of jobs.
  const workers = Array(Math.min(concurrency, jobs.length))
    .fill(null)
    .map((_, idx) => worker(idx + 1))

  // Wait for all workers to finish
  await Promise.all(workers)

  return results
}
