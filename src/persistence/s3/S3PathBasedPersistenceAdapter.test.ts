import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3StorageConfig } from '../../config/config.js'
import { S3PathBasedPersistenceAdapter } from './S3PathBasedPersistenceAdapter.js'

// Mock the auth modules
vi.mock('../../aws/auth.js', () => ({
  getCredentials: vi.fn().mockResolvedValue({
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    sessionToken: 'test-session-token'
  })
}))

vi.mock('../../aws/coreAuth.js', () => ({
  getNewInitialCredentials: vi.fn().mockResolvedValue({
    accountId: '123456789012',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key'
  })
}))

vi.mock('../../aws/ClientPool.js', () => ({
  AwsClientPool: {
    defaultInstance: {
      client: vi.fn().mockImplementation((ClientClass) => new ClientClass({}))
    }
  }
}))

vi.mock('@actsecurity/log', () => ({
  log: {
    debug: vi.fn()
  }
}))

const s3Mock = mockClient(S3Client)

describe('S3PathBasedPersistenceAdapter', () => {
  let adapter: S3PathBasedPersistenceAdapter
  let config: S3StorageConfig

  beforeEach(() => {
    s3Mock.reset()
    config = {
      type: 's3',
      bucket: 'test-bucket',
      region: 'us-east-1'
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create adapter with S3 config and deleteData flag', () => {
      //Given an S3 config and deleteData flag
      const deleteData = true

      //When creating an S3PathBasedPersistenceAdapter
      const adapter = new S3PathBasedPersistenceAdapter(config, deleteData)

      //Then the adapter should be created successfully
      expect(adapter).toBeInstanceOf(S3PathBasedPersistenceAdapter)
    })
  })

  describe('writeFile', () => {
    beforeEach(() => {
      adapter = new S3PathBasedPersistenceAdapter(config, true)
    })

    it('should write string data to S3 object', async () => {
      //Given S3 client mock and file data
      s3Mock.on(PutObjectCommand).resolves({})
      const filePath = 'path/to/file.txt'
      const content = 'Hello, S3!'

      //When writing the file
      await adapter.writeFile(filePath, content)

      //Then PutObjectCommand should be called with correct parameters
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: filePath,
        Body: content
      })
    })

    it('should write Buffer data to S3 object', async () => {
      //Given S3 client mock and Buffer data
      s3Mock.on(PutObjectCommand).resolves({})
      const filePath = 'path/to/file.bin'
      const buffer = Buffer.from('Binary data')

      //When writing the buffer
      await adapter.writeFile(filePath, buffer)

      //Then PutObjectCommand should be called with correct parameters
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: filePath,
        Body: buffer
      })
    })
  })

  describe('writeWithOptimisticLock', () => {
    beforeEach(() => {
      adapter = new S3PathBasedPersistenceAdapter(config, true)
    })

    it('should write file with ETag condition when lockId is provided', async () => {
      //Given S3 client mock that succeeds and a lockId
      s3Mock.on(PutObjectCommand).resolves({})
      const filePath = 'path/to/file.txt'
      const content = 'Updated content'
      const lockId = 'test-etag-123'

      //When writing with optimistic lock
      const result = await adapter.writeWithOptimisticLock(filePath, content, lockId)

      //Then it should succeed and use IfMatch condition
      expect(result).toBe(true)
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: filePath,
        Body: content,
        IfMatch: lockId
      })
    })

    it('should write file without ETag condition when lockId is empty', async () => {
      //Given S3 client mock that succeeds and empty lockId
      s3Mock.on(PutObjectCommand).resolves({})
      const filePath = 'path/to/file.txt'
      const content = 'New content'
      const lockId = ''

      //When writing with empty lockId
      const result = await adapter.writeWithOptimisticLock(filePath, content, lockId)

      //Then it should succeed without IfMatch condition
      expect(result).toBe(true)
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: filePath,
        Body: content
      })
    })

    it('should return false when PreconditionFailed error occurs', async () => {
      //Given S3 client mock that throws PreconditionFailed error
      const error = new Error('Precondition failed')
      error.name = 'PreconditionFailed'
      s3Mock.on(PutObjectCommand).rejects(error)

      const filePath = 'path/to/file.txt'
      const content = 'Updated content'
      const lockId = 'outdated-etag'

      //When writing with outdated lockId
      const result = await adapter.writeWithOptimisticLock(filePath, content, lockId)

      //Then it should return false
      expect(result).toBe(false)
    })

    it('should return false when ConditionalRequestConflict error occurs', async () => {
      //Given S3 client mock that throws ConditionalRequestConflict error
      const error = new Error('Conditional request conflict')
      error.name = 'ConditionalRequestConflict'
      s3Mock.on(PutObjectCommand).rejects(error)

      const filePath = 'path/to/file.txt'
      const content = 'Updated content'
      const lockId = 'conflicting-etag'

      //When writing with conflicting lockId
      const result = await adapter.writeWithOptimisticLock(filePath, content, lockId)

      //Then it should return false
      expect(result).toBe(false)
    })

    it('should throw error for non-optimistic-lock related errors', async () => {
      //Given S3 client mock that throws a different error
      const error = new Error('Access denied')
      error.name = 'AccessDenied'
      s3Mock.on(PutObjectCommand).rejects(error)

      const filePath = 'path/to/file.txt'
      const content = 'Updated content'
      const lockId = 'test-etag'

      //When writing with access denied error
      //Then it should throw the error
      await expect(adapter.writeWithOptimisticLock(filePath, content, lockId)).rejects.toThrow(
        'Access denied'
      )
    })
  })

  describe('readFile', () => {
    beforeEach(() => {
      adapter = new S3PathBasedPersistenceAdapter(config, true)
    })

    it('should read existing file content', async () => {
      //Given S3 client mock that returns file content
      const content = 'File content from S3'
      const mockBody = {
        transformToString: vi.fn().mockResolvedValue(content)
      }
      s3Mock.on(GetObjectCommand).resolves({
        Body: mockBody as any,
        ETag: 'test-etag'
      })

      const filePath = 'path/to/file.txt'

      //When reading the file
      const result = await adapter.readFile(filePath)

      //Then it should return the file content
      expect(result).toBe(content)
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: filePath
      })
    })

    it('should return undefined for non-existent file', async () => {
      //Given S3 client mock that returns 404 error
      const error = new Error('NoSuchKey')
      error.name = 'NoSuchKey'
      ;(error as any)['$metadata'] = { httpStatusCode: 404 }
      s3Mock.on(GetObjectCommand).rejects(error)

      const filePath = 'path/to/nonexistent.txt'

      //When reading the non-existent file
      const result = await adapter.readFile(filePath)

      //Then it should return undefined
      expect(result).toBeUndefined()
    })
  })

  describe('readFileWithHash', () => {
    beforeEach(() => {
      adapter = new S3PathBasedPersistenceAdapter(config, true)
    })

    it('should read file content with ETag hash', async () => {
      //Given S3 client mock that returns file content and ETag
      const content = 'File content with hash'
      const etag = '"abc123def456"'
      const mockBody = {
        transformToString: vi.fn().mockResolvedValue(content)
      }
      s3Mock.on(GetObjectCommand).resolves({
        Body: mockBody as any,
        ETag: etag
      })

      const filePath = 'path/to/file.txt'

      //When reading the file with hash
      const result = await adapter.readFileWithHash(filePath)

      //Then it should return content and hash
      expect(result).toEqual({
        data: content,
        hash: etag
      })
    })

    it('should return undefined for non-existent file', async () => {
      //Given S3 client mock that returns 404 error
      const error = new Error('NoSuchKey')
      error.name = 'NoSuchKey'
      ;(error as any)['$metadata'] = { httpStatusCode: 404 }
      s3Mock.on(GetObjectCommand).rejects(error)

      const filePath = 'path/to/nonexistent.txt'

      //When reading the non-existent file with hash
      const result = await adapter.readFileWithHash(filePath)

      //Then it should return undefined
      expect(result).toBeUndefined()
    })
  })

  describe('deleteFile', () => {
    it('should delete file when deleteData is true', async () => {
      //Given an adapter with deleteData enabled
      adapter = new S3PathBasedPersistenceAdapter(config, true)
      s3Mock.on(DeleteObjectCommand).resolves({})

      const filePath = 'path/to/file.txt'

      //When deleting the file
      await adapter.deleteFile(filePath)

      //Then DeleteObjectCommand should be called
      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: filePath
      })
    })

    it('should not delete file when deleteData is false', async () => {
      //Given an adapter with deleteData disabled
      adapter = new S3PathBasedPersistenceAdapter(config, false)

      const filePath = 'path/to/file.txt'

      //When attempting to delete the file
      await adapter.deleteFile(filePath)

      //Then DeleteObjectCommand should not be called
      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0)
    })
  })

  describe('deleteDirectory', () => {
    it('should delete all objects in directory when deleteData is true', async () => {
      //Given an adapter with deleteData enabled and S3 objects in directory
      adapter = new S3PathBasedPersistenceAdapter(config, true)

      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'dir/file1.txt' }, { Key: 'dir/file2.txt' }],
        IsTruncated: false
      })
      s3Mock.on(DeleteObjectsCommand).resolves({})

      const dirPath = 'dir'

      //When deleting the directory
      await adapter.deleteDirectory(dirPath)

      //Then it should list and delete objects
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1)
      expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Prefix: 'dir/',
        ContinuationToken: undefined
      })

      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Delete: {
          Objects: [{ Key: 'dir/file1.txt' }, { Key: 'dir/file2.txt' }],
          Quiet: true
        }
      })
    })

    it('should handle pagination when deleting large directories', async () => {
      //Given an adapter with deleteData enabled and paginated S3 response
      adapter = new S3PathBasedPersistenceAdapter(config, true)

      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: 'dir/file1.txt' }],
          IsTruncated: true,
          NextContinuationToken: 'token123'
        })
        .resolvesOnce({
          Contents: [{ Key: 'dir/file2.txt' }],
          IsTruncated: false
        })
      s3Mock.on(DeleteObjectsCommand).resolves({})

      const dirPath = 'dir'

      //When deleting the directory
      await adapter.deleteDirectory(dirPath)

      //Then it should handle pagination correctly
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(2)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(2)
    })

    it('should not delete directory when deleteData is false', async () => {
      //Given an adapter with deleteData disabled
      adapter = new S3PathBasedPersistenceAdapter(config, false)

      const dirPath = 'dir'

      //When attempting to delete the directory
      await adapter.deleteDirectory(dirPath)

      //Then no S3 commands should be called
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0)
    })

    it('should handle empty directory gracefully', async () => {
      //Given an adapter with deleteData enabled and empty directory
      adapter = new S3PathBasedPersistenceAdapter(config, true)

      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [],
        IsTruncated: false
      })

      const dirPath = 'empty-dir'

      //When deleting the empty directory
      await adapter.deleteDirectory(dirPath)

      //Then it should list but not attempt to delete
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0)
    })
  })

  describe('listDirectory', () => {
    beforeEach(() => {
      adapter = new S3PathBasedPersistenceAdapter(config, true)
    })

    it('should list subdirectories in S3 prefix', async () => {
      //Given S3 client mock that returns common prefixes
      s3Mock.on(ListObjectsV2Command).resolves({
        CommonPrefixes: [
          { Prefix: 'dir/subdir1/' },
          { Prefix: 'dir/subdir2/' },
          { Prefix: 'dir/subdir3/' }
        ]
      })

      const dirPath = 'dir'

      //When listing the directory
      const result = await adapter.listDirectory(dirPath)

      //Then it should return subdirectory names
      expect(result).toEqual(['subdir1', 'subdir2', 'subdir3'])
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1)
      expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Prefix: 'dir/',
        Delimiter: '/'
      })
    })

    it('should return empty array when no subdirectories exist', async () => {
      //Given S3 client mock that returns no common prefixes
      s3Mock.on(ListObjectsV2Command).resolves({})

      const dirPath = 'empty-dir'

      //When listing the empty directory
      const result = await adapter.listDirectory(dirPath)

      //Then it should return empty array
      expect(result).toEqual([])
    })

    it('should handle directory path without trailing slash', async () => {
      //Given a directory path without trailing slash
      s3Mock.on(ListObjectsV2Command).resolves({
        CommonPrefixes: [{ Prefix: 'mydir/sub/' }]
      })

      const dirPath = 'mydir'

      //When listing the directory
      const result = await adapter.listDirectory(dirPath)

      //Then it should add trailing slash to prefix
      expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe('mydir/')
      expect(result).toEqual(['sub'])
    })
  })

  describe('findWithPattern', () => {
    beforeEach(() => {
      adapter = new S3PathBasedPersistenceAdapter(config, true)
    })

    it('should find files matching specific path pattern', async () => {
      //Given S3 setup with target file content
      const content = '{"test": "data"}'
      const mockBody = {
        transformToString: vi.fn().mockResolvedValue(content)
      }
      s3Mock.on(GetObjectCommand).resolves({
        Body: mockBody as any,
        ETag: 'test-etag'
      })

      const baseDir = 'base'
      const pathParts = ['level1', 'level2']
      const filename = 'target.json'

      //When finding with specific path pattern
      const result = await adapter.findWithPattern(baseDir, pathParts, filename)

      //Then it should return the file content
      expect(result).toEqual([content])
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: 'base/level1/level2/target.json'
      })
    })

    it('should find files matching wildcard pattern', async () => {
      //Given S3 setup with multiple directories and files
      s3Mock.on(ListObjectsV2Command).resolves({
        CommonPrefixes: [{ Prefix: 'base/dir1/' }, { Prefix: 'base/dir2/' }]
      })

      const content1 = '{"config": 1}'
      const content2 = '{"config": 2}'
      const mockBody1 = { transformToString: vi.fn().mockResolvedValue(content1) }
      const mockBody2 = { transformToString: vi.fn().mockResolvedValue(content2) }

      s3Mock
        .on(GetObjectCommand)
        .resolvesOnce({ Body: mockBody1 as any, ETag: 'etag1' })
        .resolvesOnce({ Body: mockBody2 as any, ETag: 'etag2' })

      const baseDir = 'base'
      const pathParts = ['*']
      const filename = 'config.json'

      //When finding with wildcard pattern
      const result = await adapter.findWithPattern(baseDir, pathParts, filename)

      //Then it should return all matching file contents
      expect(result).toHaveLength(2)
      expect(result).toContain(content1)
      expect(result).toContain(content2)
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1)
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(2)
    })

    it('should exclude target filename from directory listings', async () => {
      //Given S3 setup where target filename appears as directory name
      s3Mock.on(ListObjectsV2Command).resolves({
        CommonPrefixes: [
          { Prefix: 'base/data.json/' }, // Directory with same name as target file
          { Prefix: 'base/valid-dir/' }
        ]
      })

      const validContent = '{"valid": true}'
      const mockBody = { transformToString: vi.fn().mockResolvedValue(validContent) }

      s3Mock.on(GetObjectCommand).resolvesOnce({ Body: mockBody as any, ETag: 'etag' })

      const baseDir = 'base'
      const pathParts = ['*']
      const filename = 'data.json'

      //When finding with wildcard that should exclude filename directory
      const result = await adapter.findWithPattern(baseDir, pathParts, filename)

      //Then it should only check valid-dir, not the filename directory
      expect(result).toEqual([validContent])
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input.Key).toBe(
        'base/valid-dir/data.json'
      )
    })

    it('should return empty array when no files match pattern', async () => {
      //Given S3 setup with no matching files
      s3Mock.on(ListObjectsV2Command).resolves({
        CommonPrefixes: [{ Prefix: 'base/dir1/' }]
      })

      const error = new Error('NoSuchKey')
      error.name = 'NoSuchKey'
      ;(error as any)['$metadata'] = { httpStatusCode: 404 }
      s3Mock.on(GetObjectCommand).rejects(error)

      const baseDir = 'base'
      const pathParts = ['*']
      const filename = 'missing.json'

      //When finding with pattern that has no matches
      const result = await adapter.findWithPattern(baseDir, pathParts, filename)

      //Then it should return empty array
      expect(result).toEqual([])
    })

    it('should handle complex nested wildcard patterns', async () => {
      //Given S3 setup with complex directory structure
      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          CommonPrefixes: [{ Prefix: 'accounts/acc1/' }, { Prefix: 'accounts/acc2/' }]
        })
        .resolvesOnce({
          CommonPrefixes: [{ Prefix: 'accounts/acc1/regions/us-east-1/' }]
        })
        .resolvesOnce({
          CommonPrefixes: [{ Prefix: 'accounts/acc2/regions/us-west-2/' }]
        })

      const data1 = '{"account": "acc1", "region": "us-east-1"}'
      const data2 = '{"account": "acc2", "region": "us-west-2"}'
      const mockBody1 = { transformToString: vi.fn().mockResolvedValue(data1) }
      const mockBody2 = { transformToString: vi.fn().mockResolvedValue(data2) }

      s3Mock
        .on(GetObjectCommand)
        .resolvesOnce({ Body: mockBody1 as any, ETag: 'etag1' })
        .resolvesOnce({ Body: mockBody2 as any, ETag: 'etag2' })

      const baseDir = 'accounts'
      const pathParts = ['*', 'regions', '*']
      const filename = 'data.json'

      //When finding with multiple wildcards
      const result = await adapter.findWithPattern(baseDir, pathParts, filename)

      //Then it should return all matching files
      expect(result).toHaveLength(2)
      expect(result).toContain(data1)
      expect(result).toContain(data2)
    })
  })

  describe('auth integration', () => {
    it('should handle auth config with ARN-based initial role', async () => {
      //Given a config with ARN-based auth
      const configWithAuth: S3StorageConfig = {
        type: 's3',
        bucket: 'test-bucket',
        region: 'us-east-1',
        auth: {
          initialRole: {
            arn: 'arn:aws:iam::123456789012:role/TestRole'
          }
        }
      }
      adapter = new S3PathBasedPersistenceAdapter(configWithAuth, true)
      s3Mock.on(PutObjectCommand).resolves({})

      //When performing an operation that requires auth
      await adapter.writeFile('test.txt', 'content')

      //Then it should successfully authenticate and perform the operation
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1)
    })

    it('should handle auth config with path-based initial role', async () => {
      //Given a config with path-based auth
      const configWithAuth: S3StorageConfig = {
        type: 's3',
        bucket: 'test-bucket',
        region: 'us-east-1',
        auth: {
          initialRole: {
            pathAndName: '/test/TestRole'
          }
        }
      }
      adapter = new S3PathBasedPersistenceAdapter(configWithAuth, true)
      s3Mock.on(GetObjectCommand).resolves({
        Body: { transformToString: vi.fn().mockResolvedValue('content') } as any,
        ETag: 'etag'
      })

      //When performing an operation that requires auth
      const result = await adapter.readFile('test.txt')

      //Then it should successfully authenticate and perform the operation
      expect(result).toBe('content')
    })
  })
})
