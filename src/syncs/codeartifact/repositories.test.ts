import {
  CodeartifactClient,
  GetRepositoryPermissionsPolicyCommand,
  ListRepositoriesCommand,
  ListTagsForResourceCommand
} from '@aws-sdk/client-codeartifact'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { allServices } from '../../services.js'
import { getRegionalSyncsForService } from '../syncMap.js'
import { CodeArtifactRepositoriesSync } from './repositories.js'

const codeArtifactMock = mockClient(CodeartifactClient)
const accountId = '111111111111'
const domainOwner = '222222222222'
const region = 'us-east-1'
const firstRepositoryArn = `arn:aws:codeartifact:${region}:${domainOwner}:repository/first-domain/first-repository`
const secondRepositoryArn = `arn:aws:codeartifact:${region}:${accountId}:repository/second-domain/second-repository`
const credentials: AwsCredentialProviderWithMetaData = {
  accountId,
  partition: 'aws',
  cacheKey: 'test-credentials',
  provider: async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key'
  })
}

const workerPool = {
  enqueueAll: (jobs: any[]) =>
    jobs.map(async (job) => {
      try {
        return {
          status: 'fulfilled',
          value: await job.execute({ workerId: 1, properties: job.properties }),
          properties: job.properties
        }
      } catch (reason) {
        return { status: 'rejected', reason, properties: job.properties }
      }
    })
} as any

describe('CodeArtifactRepositoriesSync', () => {
  afterEach(() => {
    codeArtifactMock.reset()
  })

  it('is registered as a regional CodeArtifact sync', () => {
    expect(allServices).toContain('codeartifact')
    expect(getRegionalSyncsForService('codeartifact')).toEqual([CodeArtifactRepositoriesSync])
  })

  it('collects paginated repositories with metadata, tags, and permissions policies', async () => {
    const store = createInMemoryStorageClient()
    const staleRepositoryArn = `arn:aws:codeartifact:${region}:${accountId}:repository/stale-domain/stale-repository`
    await store.saveResourceMetadata(accountId, staleRepositoryArn, 'metadata', {
      arn: staleRepositoryArn,
      name: 'stale-repository'
    })
    await store.saveResourceMetadata(accountId, secondRepositoryArn, 'policy', {
      Statement: [{ Sid: 'stale-policy' }]
    })

    codeArtifactMock.on(ListRepositoriesCommand).callsFake((input) => {
      if (input.nextToken === 'next-page') {
        return {
          repositories: [
            {
              name: 'second-repository',
              administratorAccount: accountId,
              domainName: 'second-domain',
              domainOwner: accountId,
              arn: secondRepositoryArn
            }
          ]
        }
      }
      return {
        repositories: [
          {
            name: 'first-repository',
            administratorAccount: accountId,
            domainName: 'first-domain',
            domainOwner,
            arn: firstRepositoryArn,
            description: 'The first repository'
          }
        ],
        nextToken: 'next-page'
      }
    })
    codeArtifactMock
      .on(ListTagsForResourceCommand, { resourceArn: firstRepositoryArn })
      .resolves({ tags: [{ key: 'environment', value: 'test' }] })
    codeArtifactMock
      .on(ListTagsForResourceCommand, { resourceArn: secondRepositoryArn })
      .resolves({ tags: [] })
    codeArtifactMock
      .on(GetRepositoryPermissionsPolicyCommand, {
        domain: 'first-domain',
        domainOwner,
        repository: 'first-repository'
      })
      .resolves({
        policy: {
          document: JSON.stringify({ Statement: [{ Sid: 'repository-policy' }] })
        }
      })
    const missingPolicy = new Error('Repository permissions policy not found')
    missingPolicy.name = 'ResourceNotFoundException'
    codeArtifactMock
      .on(GetRepositoryPermissionsPolicyCommand, {
        domain: 'second-domain',
        domainOwner: accountId,
        repository: 'second-repository'
      })
      .rejects(missingPolicy)

    const clientPool = new AwsClientPool()
    await CodeArtifactRepositoriesSync.execute(accountId, region, credentials, store, undefined, {
      clientPool,
      workerPool,
      writeOnly: false
    })
    clientPool.clear()

    await expect(
      store.getResourceMetadata(accountId, firstRepositoryArn, 'metadata')
    ).resolves.toEqual({
      arn: firstRepositoryArn,
      name: 'first-repository',
      domainName: 'first-domain',
      domainOwner,
      administratorAccount: accountId,
      description: 'The first repository'
    })
    await expect(store.getResourceMetadata(accountId, firstRepositoryArn, 'tags')).resolves.toEqual(
      {
        environment: 'test'
      }
    )
    await expect(
      store.getResourceMetadata(accountId, firstRepositoryArn, 'policy')
    ).resolves.toEqual({
      Statement: [{ Sid: 'repository-policy' }]
    })
    await expect(
      store.getResourceMetadata(accountId, secondRepositoryArn, 'policy')
    ).resolves.toBeUndefined()
    await expect(store.listResourceMetadata(accountId, staleRepositoryArn)).resolves.toEqual([])

    expect(
      codeArtifactMock.commandCalls(ListRepositoriesCommand).map((call) => call.args[0].input)
    ).toEqual([{ nextToken: undefined }, { nextToken: 'next-page' }])
    expect(
      codeArtifactMock
        .commandCalls(GetRepositoryPermissionsPolicyCommand)
        .map((call) => call.args[0].input)
    ).toEqual(
      expect.arrayContaining([
        {
          domain: 'first-domain',
          domainOwner,
          repository: 'first-repository'
        },
        {
          domain: 'second-domain',
          domainOwner: accountId,
          repository: 'second-repository'
        }
      ])
    )
  })
})
