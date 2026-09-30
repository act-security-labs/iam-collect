const { index, mergeSqliteDatabases } = require('@actsecurity/iam-collect')
const fs = require('fs')
const fsPromises = require('fs').promises
const {
  GetObjectCommand,
  DeleteObjectsCommand,
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand
} = require('@aws-sdk/client-s3')

const isSqliteStorage = process.env.STORAGE_TYPE === 'sqlite'
const targetSqlitePath = '/tmp/iam-collect-data.sqlite'

exports.handler = async (event, context) => {
  const { s3Prefix } = event

  console.log({
    message: 'invoked',
    function: 'index-data-lambda',
    requestId: context.awsRequestId,
    s3Prefix: s3Prefix
  })

  try {
    // Extract arguments from the event
    if (!s3Prefix) {
      throw new Error('Missing required parameter: bucketPrefix must be provided in the event')
    }
    const accountsPrefix = s3Prefix + 'accounts/'

    // Read environment variables
    const storageBucketName = process.env.STORAGE_BUCKET_NAME
    const storageBucketRegion = process.env.STORAGE_BUCKET_REGION
    const partition = process.env.CURRENT_PARTITION || 'aws' // Default to 'aws' if not set
    const s3Client = new S3Client({ region: storageBucketRegion })

    console.log({
      message: 'configuration-loaded',
      function: 'index-data-lambda',
      requestId: context.awsRequestId,
      config: {
        storageBucketName: storageBucketName,
        storageBucketRegion: storageBucketRegion,
        partition: partition,
        s3Prefix: s3Prefix
      }
    })

    let s3FilesToDelete = []
    if (isSqliteStorage) {
      s3FilesToDelete = await consolidateIamDataSqliteFiles(
        s3Client,
        storageBucketName,
        accountsPrefix
      )
    }

    const config = {
      storage: isSqliteStorage
        ? {
            type: 'sqlite',
            path: targetSqlitePath
          }
        : {
            type: 's3',
            bucket: storageBucketName,
            prefix: s3Prefix,
            region: storageBucketRegion
          }
    }

    console.log({
      message: 'start-indexing',
      function: 'index-data-lambda',
      requestId: context.awsRequestId,
      s3Prefix: s3Prefix,
      partition: partition,
      concurrency: 50
    })

    await index(
      [config], // The config to use
      partition, // The aws partition
      [], // All accounts
      [], // All regions
      [], // All services
      50 // Set a high concurrency
    )

    console.log({
      message: 'index-completed',
      function: 'index-data-lambda',
      requestId: context.awsRequestId,
      s3Prefix: s3Prefix,
      storageBucket: storageBucketName,
      partition: partition
    })

    if (isSqliteStorage) {
      await uploadIamDataSqliteToS3(s3Client, storageBucketName, s3Prefix)
      await deleteS3Objects(s3Client, storageBucketName, accountsPrefix, s3FilesToDelete)
    }

    const response = {
      status: 'SUCCESS',
      statusCode: 200,
      message: 'Data indexing completed successfully',
      bucketPrefix: s3Prefix,
      storageBucket: storageBucketName,
      partition: partition,
      timestamp: new Date().toISOString(),
      requestId: context.awsRequestId
    }

    return response
  } catch (error) {
    console.error({
      message: 'indexing-failed',
      function: 'index-data-lambda',
      requestId: context.awsRequestId,
      s3Prefix: s3Prefix,
      error: {
        message: error.message,
        type: error.constructor.name,
        stack: error.stack
      }
    })

    const errorResponse = {
      status: 'FAILED',
      statusCode: 500,
      error: {
        message: error.message,
        type: error.constructor.name,
        timestamp: new Date().toISOString(),
        bucketPrefix: s3Prefix
      },
      requestId: context.awsRequestId
    }

    return errorResponse
  }
}

/**
 * Consolidate individual account SQLite files from S3 into a single iam-data.sqlite file
 * Downloads files in batches based on available disk space, merges them, and cleans up
 * @param {S3Client} s3Client - AWS S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} s3Prefix - S3 prefix where account SQLite files are stored
 * @returns {Promise<string[]>} Array of processed file keys
 */
async function consolidateIamDataSqliteFiles(s3Client, bucket, s3Prefix) {
  const totalStorage = getAvailableTmpSpace()

  const allFiles = await listS3Files(s3Client, bucket, s3Prefix)
  const fileBatcher = new S3FileBatcher(allFiles)

  do {
    const iamDataSize = getIamDataSqliteSize()
    const batchSize = calculateBatchSize(totalStorage, iamDataSize)
    const batchKeys = fileBatcher.getNextBatch(batchSize)
    const downloadedFiles = await downloadS3Files(s3Client, bucket, s3Prefix, batchKeys)
    await reduceSqliteFiles(downloadedFiles)
    await deleteFiles(downloadedFiles)
  } while (fileBatcher.hasMoreFiles())

  return allFiles.map((f) => f.key)
}

/**
 * Merge downloaded SQLite files into the main iam-data.sqlite database
 * @param {string[]} newFiles - Array of file paths to merge
 * @returns {Promise<void>}
 */
async function reduceSqliteFiles(newFiles) {
  return mergeSqliteDatabases(targetSqlitePath, newFiles)
}

/**
 * Get available space in the /tmp directory
 * @returns {number} Available space in bytes
 */
function getAvailableTmpSpace() {
  const stats = fs.statSync('/tmp')
  const availableBytes = stats.bavail * stats.bsize

  console.log({
    message: 'tmp-space-check',
    availableBytes: availableBytes,
    availableMB: Math.floor(availableBytes / (1024 * 1024)),
    availableGB: (availableBytes / (1024 * 1024 * 1024)).toFixed(2)
  })

  return availableBytes
}

/**
 * Get the size of /tmp/iam-data.sqlite
 *
 * @returns the number of bytes used by the final iam-data.sqlite file, or 0 if it doesn't exist
 */
function getIamDataSqliteSize() {
  if (!fs.existsSync(targetSqlitePath)) {
    return 0
  }

  return fs.statSync(targetSqlitePath).size
}

/**
 * Calculate the maximum batch size for downloading SQLite files
 * Uses 90% of total storage, subtracts current iam-data.sqlite size, divides by 2 for safety
 * @param {number} totalEphemeralStorageBytes - Total available ephemeral storage in bytes
 * @param {number} iamDataSqliteSizeBytes - Current size of iam-data.sqlite in bytes
 * @returns {number} Maximum batch size in bytes
 */
function calculateBatchSize(totalEphemeralStorageBytes, iamDataSqliteSizeBytes) {
  const availableSpace = totalEphemeralStorageBytes * 0.9 - iamDataSqliteSizeBytes
  return availableSpace / 2
}

/**
 * List all files at a given S3 prefix
 * @param {S3Client} s3Client - AWS S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} prefix - S3 prefix to list files from
 * @returns {Promise<Array<{key: string, size: number}>>} Array of objects with key (relative to prefix) and size
 */
async function listS3Files(s3Client, bucket, prefix) {
  const files = []
  let continuationToken = undefined

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      })
    )

    if (response.Contents) {
      response.Contents.forEach((obj) => {
        files.push({
          // Make key the key after the prefix
          key: obj.Key.slice(prefix.length),
          size: obj.Size
        })
      })
    }

    continuationToken = response.NextContinuationToken
  } while (continuationToken)

  return files
}

/**
 * Helper class to batch S3 files by size
 */
class S3FileBatcher {
  /**
   * Create a new file batcher
   * @param {Array<{key: string, size: number}>} files - Array of files with key and size
   */
  constructor(files) {
    this.files = files
    this.currentIndex = 0
  }

  /**
   * Get the next batch of file keys that fit within the max size
   * @param {number} maxBatchSizeBytes - Maximum batch size in bytes
   * @returns {string[]} Array of file keys that fit in the batch
   */
  getNextBatch(maxBatchSizeBytes) {
    let batch = []
    let batchSize = 0

    while (this.currentIndex < this.files.length) {
      const file = this.files[this.currentIndex]

      if (batchSize + file.size > maxBatchSizeBytes) {
        break
      }

      batch.push(file.key)
      batchSize += file.size
      this.currentIndex++
    }

    return batch
  }

  /**
   * Check if there are more files to process
   * @returns {boolean} True if more files remain
   */
  hasMoreFiles() {
    return this.currentIndex < this.files.length
  }
}

/**
 * Download files from S3 to /tmp directory
 * @param {S3Client} s3Client - AWS S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} s3Prefix - S3 prefix where files are stored
 * @param {string[]} keys - Array of file keys to download (relative to prefix)
 * @returns {Promise<string[]>} Array of local file paths where files were downloaded
 */
async function downloadS3Files(s3Client, bucket, s3Prefix, keys) {
  const downloadedFiles = []
  for (const key of keys) {
    const filePath = `/tmp/${key}`
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `${s3Prefix}${key}`
      })
    )

    const buffer = await response.Body.transformToByteArray()
    await fsPromises.writeFile(filePath, buffer)
    downloadedFiles.push(filePath)
  }
  return downloadedFiles
}

/**
 * Delete local files from the filesystem
 * @param {string[]} filePaths - Array of absolute file paths to delete
 * @returns {Promise<void>}
 */
async function deleteFiles(filePaths) {
  for (const filePath of filePaths) {
    await fsPromises.unlink(filePath)
  }
}

/**
 * Delete files from S3 in batches (S3 DeleteObjects limit is 1000 keys per request)
 * @param {S3Client} s3Client - AWS S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} s3Prefix - S3 prefix where files are stored
 * @param {string[]} keys - Array of file keys to delete (relative to prefix)
 * @returns {Promise<void>}
 */
const DELETE_BATCH_SIZE = 1000
async function deleteS3Objects(s3Client, bucket, s3Prefix, keys) {
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE)
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((key) => ({ Key: `${s3Prefix}${key}` }))
        }
      })
    )
  }

  console.log({
    message: 'deleted-s3-files-complete',
    totalKeys: keys.length
  })
}

/**
 * Upload the consolidated iam-data.sqlite file to S3
 * @param {S3Client} s3Client - AWS S3 client instance
 * @param {string} bucket - S3 bucket name
 * @param {string} s3Prefix - S3 prefix where the file should be stored
 * @returns {Promise<void>}
 */
async function uploadIamDataSqliteToS3(s3Client, bucket, s3Prefix) {
  const fileBuffer = await fsPromises.readFile(targetSqlitePath)

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${s3Prefix}iam-data.sqlite`,
      Body: fileBuffer,
      ContentType: 'application/x-sqlite3'
    })
  )

  console.log({
    message: 'uploaded-iam-data-sqlite-to-s3',
    bucket: bucket,
    key: `${s3Prefix}iam-data.sqlite`
  })
}
