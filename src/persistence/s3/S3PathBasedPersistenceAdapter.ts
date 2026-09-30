import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client
} from '@aws-sdk/client-s3'
import { splitArnParts } from '@actsecurity/iam-utils'
import { getCredentials } from '../../aws/auth.js'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { getNewInitialCredentials } from '../../aws/coreAuth.js'
import { type S3StorageConfig } from '../../config/config.js'
import { runAndCatch404 } from '../../utils/client-tools.js'
import { log } from '@actsecurity/log'
import { type PathBasedPersistenceAdapter } from '../PathBasedPersistenceAdapter.js'

export class S3PathBasedPersistenceAdapter implements PathBasedPersistenceAdapter {
  private storageAuthAccountId: string | undefined
  public constructor(
    private readonly storageConfig: S3StorageConfig,
    private readonly deleteData: boolean
  ) {}

  private async getClient() {
    /*
     * We have a bit of a bootstrap problem with S3 auth similar to how we set up
     * initial download. We don't necessarily know the accountId unless there is an
     * arn specified. Otherwise we just have to use the default credentials and see
     * what we get back.
     */
    if (!this.storageAuthAccountId) {
      const authConfig = this.storageConfig.auth

      // Try getting it from the auth config
      if (authConfig && authConfig.initialRole && 'arn' in authConfig.initialRole) {
        this.storageAuthAccountId = splitArnParts(authConfig.initialRole.arn).accountId
      }

      // If that doesn't work get it from the default credentials
      if (!this.storageAuthAccountId) {
        const initialCredentials = await getNewInitialCredentials(authConfig, {
          phase: 's3 persistence auth bootstrap'
        })
        this.storageAuthAccountId = initialCredentials.accountId
      }
    }

    const credentials = await getCredentials(this.storageAuthAccountId, this.storageConfig.auth)
    const client = AwsClientPool.defaultInstance.client(
      S3Client,
      credentials,
      this.storageConfig.region,
      this.storageConfig.endpoint
    )
    return client
  }

  async writeFile(filePath: string, data: string | Buffer): Promise<void> {
    const client = await this.getClient()
    await client.send(
      new PutObjectCommand({
        Bucket: this.storageConfig.bucket,
        Key: filePath,
        Body: data
      })
    )
  }

  async writeWithOptimisticLock(
    filePath: string,
    data: string | Buffer,
    lockId: string
  ): Promise<boolean> {
    const client = await this.getClient()
    try {
      const params: PutObjectCommandInput = {
        Bucket: this.storageConfig.bucket,
        Key: filePath,
        Body: data
      }

      // The API will throw an error if Etag is an empty string
      if (lockId && lockId.trim() !== '') {
        params['IfMatch'] = lockId
      }

      await client.send(new PutObjectCommand(params))
      return true
    } catch (error: any) {
      if (error.name === 'PreconditionFailed' || error.name === 'ConditionalRequestConflict') {
        log.debug(
          { filePath, lockId },
          'Optimistic locking failed. The object may have been modified by another process.'
        )
        // PreconditionFailed indicates that the ETag does not match the current version of the object
        // ConditionalRequestConflict indicates a conflicting operation occurred during the request
        // In either case, we can return false and let the caller handle the conflict
        return false
      }
      // If the error is not related to optimistic locking, it's someone else's problem
      throw error
    }
  }

  async readFile(filePath: string): Promise<string | undefined> {
    const response = await this.readFileWithHash(filePath)
    return response?.data
  }

  async readFileWithHash(filePath: string): Promise<{ data: string; hash: string } | undefined> {
    const client = await this.getClient()

    const response = await runAndCatch404(async () => {
      return client.send(
        new GetObjectCommand({
          Bucket: this.storageConfig.bucket,
          Key: filePath
        })
      )
    })

    if (!response) {
      return undefined
    }

    const data = await response.Body?.transformToString()!
    const hash = response.ETag!
    return {
      data,
      hash
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    if (!this.deleteData) {
      return
    }
    const client = await this.getClient()
    await client.send(
      new DeleteObjectCommand({
        Bucket: this.storageConfig.bucket,
        Key: filePath
      })
    )
  }

  async deleteDirectory(dirPath: string): Promise<void> {
    if (!this.deleteData) {
      return
    }
    const client = await this.getClient()
    if (!dirPath.endsWith('/')) {
      dirPath += '/'
    }

    // This code is a little less elegant than most, but given the possibility of
    // pagination combined with the need to batch delete, it's worth the tradeoff
    let ContinuationToken: string | undefined = undefined

    do {
      // 1) List objects in the directory
      const list: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: this.storageConfig.bucket,
          Prefix: dirPath,
          ContinuationToken
        })
      )

      const objects = list.Contents ?? []
      if (objects.length > 0) {
        // 2) Delete them in one batch
        const toDelete = objects.map((o) => ({ Key: o.Key! }))
        await client.send(
          new DeleteObjectsCommand({
            Bucket: this.storageConfig.bucket,
            Delete: { Objects: toDelete, Quiet: true }
          })
        )
      }

      // 3) If more remain, loop
      ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (ContinuationToken)
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    const client = await this.getClient()
    if (!dirPath.endsWith('/')) {
      dirPath += '/'
    }

    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: this.storageConfig.bucket,
        Prefix: dirPath,
        Delimiter: '/'
      })
    )

    if (!response.CommonPrefixes) {
      return []
    }

    return (
      response.CommonPrefixes.map((cp) => cp.Prefix!)
        .filter((key) => key !== dirPath)
        //Trim off the prefix of the directory being listed and the trailing slash
        .map((key) => key.slice(dirPath.length).slice(0, -1))
    )
  }

  async findWithPattern(baseDir: string, pathParts: string[], filename: string): Promise<string[]> {
    let baseDirs = [baseDir]
    for (const part of pathParts) {
      if (part == '*') {
        const subDirs = []
        for (const dir of baseDirs) {
          const entries = await this.listDirectory(dir)
          for (const entry of entries) {
            if (entry !== filename) {
              subDirs.push(dir + '/' + entry)
            }
          }
        }
        baseDirs = subDirs
      } else {
        baseDirs = baseDirs.map((dir) => dir + '/' + part)
      }
    }

    const results: string[] = []
    for (const dir of baseDirs) {
      const data = await this.readFile(dir + '/' + filename)
      if (data) {
        results.push(data)
      }
    }

    return results
  }
}
