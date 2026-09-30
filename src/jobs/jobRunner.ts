import { log } from '@actsecurity/log'
import { type Job, type JobContext, type JobResult } from './jobQueue.js'

/**
 * Job runner that allows running jobs as they are created.
 * This will wait for jobs to be added to it and run them up the
 * maximum concurrency.
 *
 * Results are available via `getResults()`.
 */

export class JobRunner<T = void, P = Record<string, unknown>> {
  private queue: Job<T, P>[] = []
  private results: JobResult<T, P>[] = []
  private activeJobs = 0
  private waitingResolvers: (() => void)[] = []
  private workers: Promise<void>[] = []
  private isAcceptingWork = true
  private workAvailablePromise: Promise<void> | null = null
  private resolveWorkAvailable: (() => void) | null = null

  /**
   * Create a new runner with the specified concurrency.
   *
   * @param concurrency - The maximum number of jobs to run concurrently.
   */
  constructor(private concurrency: number) {}

  private async worker(workerId: number): Promise<void> {
    while (this.isAcceptingWork || this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) {
        if (!this.isAcceptingWork) {
          // No longer accepting work and no jobs left, exit immediately
          return
        }
        // No work available, wait for new work to be added
        await this.waitForWorkAvailable()
        continue
      }

      this.activeJobs++
      const context: JobContext = { workerId }

      const startTime = Date.now()
      const interval = setInterval(() => {
        log.warn(
          `Long-running job detected.`,
          { minutes: Math.floor((Date.now() - startTime) / 60000) },
          { ...context, ...job.properties }
        )
      }, 60_000)

      try {
        const value = await job.execute({ ...context, properties: job.properties })
        this.results.push({ status: 'fulfilled', value, properties: job.properties })
      } catch (reason) {
        this.results.push({ status: 'rejected', reason, properties: job.properties })
      } finally {
        clearInterval(interval)
        this.activeJobs--
        this.checkIfIdle()
      }
    }
  }

  private waitForWorkAvailable(): Promise<void> {
    if (!this.workAvailablePromise) {
      this.workAvailablePromise = new Promise<void>((resolve) => {
        this.resolveWorkAvailable = resolve
      })
    }
    return this.workAvailablePromise
  }

  private ensureWorkers(): void {
    if (this.workers.length === 0 && this.isAcceptingWork) {
      for (let i = 0; i < this.concurrency; i++) {
        this.workers.push(this.worker(i + 1))
      }
    }
  }

  private notifyWorkersOfNewWork(): void {
    // Wake up waiting workers
    if (this.resolveWorkAvailable) {
      this.resolveWorkAvailable()
      this.workAvailablePromise = null
      this.resolveWorkAvailable = null
    }
  }

  private checkIfIdle(): void {
    if (this.activeJobs === 0 && this.queue.length === 0) {
      // Notify all waiting resolvers
      this.waitingResolvers.forEach((resolve) => resolve())
      this.waitingResolvers = []
    }
  }

  /**
   * Add a job to the queue
   */
  enqueue(job: Job<T, P>): void {
    if (!this.isAcceptingWork) {
      throw new Error('Cannot enqueue jobs after shutdown')
    }
    this.queue.push(job)
    this.ensureWorkers()
    this.notifyWorkersOfNewWork()
  }

  /**
   * Add multiple jobs to the queue
   */
  enqueueAll(jobs: Job<T, P>[]): void {
    jobs.forEach((job) => this.enqueue(job))
  }

  /**
   * Returns a promise that resolves when all queued work is complete
   */
  waitForIdle(): Promise<void> {
    // log.debug('waitForIdle called', this.activeJobs, this.queue.length)
    return new Promise((resolve) => {
      if (this.activeJobs === 0 && this.queue.length === 0) {
        resolve()
      } else {
        this.waitingResolvers.push(resolve)
      }
    })
  }

  /**
   * Get all results accumulated so far
   */
  getResults(): JobResult<T, P>[] {
    return this.results
  }

  /**
   * Shutdown the queue - no new jobs will be accepted, but existing jobs will complete.
   *
   * Returns when a promise that resolves when all jobs have been processed and
   * are available in `getResults()`.
   */
  async finishAllWork(): Promise<void> {
    this.isAcceptingWork = false
    // Wake up any sleeping workers so they can process remaining jobs or exit
    this.notifyWorkersOfNewWork()
    // Check if we're already idle and notify any waiting resolvers
    await Promise.all(this.workers)
    this.workers = []
  }

  /**
   * Get the current queue length
   */
  get queueLength(): number {
    return this.queue.length
  }

  /**
   * Get the number of currently active jobs
   */
  get activeJobCount(): number {
    return this.activeJobs
  }
}
