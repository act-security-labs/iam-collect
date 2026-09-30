const { downloadData } = require('@actsecurity/iam-collect')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const fs = require('fs')

const storageType = process.env.STORAGE_TYPE
const isSqliteStorage = process.env.STORAGE_TYPE === 'sqlite'
const sqlitePath = '/tmp/iam-collect-data.sqlite'

exports.handler = async (event, context) => {
  const { s3Prefix, accountId } = event

  console.log({
    message: 'lambda-invoked',
    function: 'scan-account-lambda',
    requestId: context.awsRequestId,
    accountId: accountId,
    s3Prefix: s3Prefix
  })

  try {
    // Extract arguments from the event
    if (!s3Prefix || !accountId) {
      throw new Error(
        'Missing required parameters: s3Prefix and accountId must be provided in the event'
      )
    }

    // Read environment variables
    const storageBucketName = process.env.STORAGE_BUCKET_NAME
    const storageBucketRegion = process.env.STORAGE_BUCKET_REGION
    const initialCollectRoleArn = process.env.INITIAL_COLLECT_ROLE_ARN
    let collectRolePathAndName = process.env.COLLECT_ROLE_PATH_AND_NAME

    console.log({
      message: 'configuration-loaded',
      function: 'scan-account-lambda',
      requestId: context.awsRequestId,
      accountId: accountId,
      config: {
        storageBucketName: storageBucketName,
        storageBucketRegion: storageBucketRegion,
        hasInitialRole: !!initialCollectRoleArn,
        collectRolePathAndName: collectRolePathAndName
      }
    })

    // Create the config object based on storage type
    const config = {
      storage: isSqliteStorage
        ? {
            type: 'sqlite',
            path: sqlitePath
          }
        : {
            type: 's3',
            bucket: storageBucketName,
            prefix: s3Prefix,
            region: storageBucketRegion
          },
      auth: {
        // This is set conditionally below if an initialCollectRoleArn is provided
        // initialRole: {
        //     arn: initialCollectRoleArn
        // },
        role: {
          pathAndName: collectRolePathAndName,
          sessionName: `iam-collect-${accountId}`
        }
      }
    }

    if (initialCollectRoleArn && initialCollectRoleArn.length > 0) {
      config.auth.initialRole = {
        arn: initialCollectRoleArn
      }
    }

    console.log({
      message: 'starting-data-download',
      function: 'scan-account-lambda',
      requestId: context.awsRequestId,
      accountId,
      s3Prefix,
      storageBucket: storageBucketName
    })

    await downloadData(
      [config], // Download configuration
      [accountId], // The account to scan
      [], // All regions
      [], // All services
      undefined, // Use default concurrency
      true, // Don't index
      true // Only write new data, don't delete stale data. We assume every run is a new full scan
    )

    console.log({
      message: 'account-scan-completed',
      function: 'scan-account-lambda',
      requestId: context.awsRequestId,
      accountId,
      s3Prefix
    })

    // If using SQLite storage, upload the file to S3 and clean up
    if (isSqliteStorage) {
      const s3Key = `${s3Prefix}accounts/${accountId}.sqlite`

      console.log({
        message: 'uploading-sqlite-to-s3',
        function: 'scan-account-lambda',
        requestId: context.awsRequestId,
        accountId,
        sqlitePath,
        s3Key
      })

      const s3Client = new S3Client({ region: storageBucketRegion })
      const fileBuffer = fs.readFileSync(sqlitePath)

      await s3Client.send(
        new PutObjectCommand({
          Bucket: storageBucketName,
          Key: s3Key,
          Body: fileBuffer,
          ContentType: 'application/x-sqlite3'
        })
      )

      console.log({
        message: 'sqlite-uploaded-to-s3',
        function: 'scan-account-lambda',
        requestId: context.awsRequestId,
        accountId,
        s3Bucket: storageBucketName,
        s3Key
      })

      // Clean up the local SQLite file
      fs.unlinkSync(sqlitePath)

      console.log({
        message: 'local-sqlite-file-deleted',
        function: 'scan-account-lambda',
        requestId: context.awsRequestId,
        sqlitePath
      })
    }

    const response = {
      status: 'SUCCESS',
      statusCode: 200,
      message: 'Account scanning completed successfully',
      accountId,
      s3Prefix,
      storageType,
      timestamp: new Date().toISOString(),
      requestId: context.awsRequestId
    }

    return response
  } catch (error) {
    console.error({
      message: 'account-scan-failed',
      function: 'scan-account-lambda',
      requestId: context.awsRequestId,
      accountId,
      error: {
        message: error.message,
        type: error.constructor.name,
        stack: error.stack
      }
    })

    // For Step Functions, you can either:
    // 1. Return an error object (current approach)
    // 2. Throw the error and let Step Functions handle it

    // Option 1: Return error object (allows Step Function to continue with error handling)
    const errorResponse = {
      status: 'FAILED',
      statusCode: 500,
      error: {
        message: error.message,
        type: error.constructor.name,
        timestamp: new Date().toISOString()
      },
      requestId: context.awsRequestId
    }

    return errorResponse

    // Option 2: Uncomment this to let Step Functions catch the exception
    // throw error;
  }
}
