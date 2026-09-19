import {
  BatchGetProjectsCommand,
  CodeBuildClient,
  GetResourcePolicyCommand,
  ListProjectsCommand
} from '@aws-sdk/client-codebuild'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { getRegionalSyncsForService } from '../syncMap.js'
import { CodeBuildProjectsSync } from './projects.js'

const codeBuildMock = mockClient(CodeBuildClient)
const accountId = '111111111111'
const region = 'us-east-1'
const projectArn = (name: string) => `arn:aws:codebuild:${region}:${accountId}:project/${name}`
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

describe('CodeBuildProjectsSync', () => {
  afterEach(() => {
    codeBuildMock.reset()
  })

  it('is registered as a regional CodeBuild sync', () => {
    expect(getRegionalSyncsForService('codebuild')).toContain(CodeBuildProjectsSync)
  })

  it('paginates, batch-loads, and persists projects with optional resource policies', async () => {
    //Given 101 CodeBuild projects returned across multiple pages
    const store = createInMemoryStorageClient()
    const firstPageNames = Array.from({ length: 100 }, (_, i) => `project-${i}`)
    const projectWithoutPolicy = 'project-100'
    const staleProjectArn = projectArn('stale-project')
    await store.saveResourceMetadata(accountId, staleProjectArn, 'metadata', {
      arn: staleProjectArn,
      name: 'stale-project'
    })

    codeBuildMock.on(ListProjectsCommand).callsFake((input) => {
      if (input.nextToken === 'next-page') {
        return { projects: [projectWithoutPolicy] }
      }
      return { projects: firstPageNames, nextToken: 'next-page' }
    })
    codeBuildMock.on(BatchGetProjectsCommand).callsFake((input) => ({
      projects: input.names?.map((name) => ({
        name,
        arn: projectArn(name),
        description: `Build project ${name}`,
        serviceRole: `arn:aws:iam::${accountId}:role/codebuild-service-role`,
        resourceAccessRole: `arn:aws:iam::${accountId}:role/codebuild-resource-role`,
        encryptionKey: `arn:aws:kms:${region}:${accountId}:key/test-key`,
        projectVisibility: 'PUBLIC_READ',
        publicProjectAlias: `public-${name}`,
        tags: [{ key: 'environment', value: 'test' }]
      }))
    }))
    codeBuildMock.on(GetResourcePolicyCommand).callsFake((input) => {
      if (input.resourceArn === projectArn(projectWithoutPolicy)) {
        const error = new Error('No resource policy')
        error.name = 'ResourceNotFoundException'
        throw error
      }
      return {
        policy: JSON.stringify({ Statement: [{ Sid: input.resourceArn }] })
      }
    })

    const clientPool = new AwsClientPool()

    //When the CodeBuild project sync runs
    await CodeBuildProjectsSync.execute(accountId, region, credentials, store, undefined, {
      clientPool,
      workerPool,
      writeOnly: false
    })
    clientPool.clear()

    //Then identifying and IAM-relevant project data is persisted
    await expect(
      store.getResourceMetadata(accountId, projectArn('project-0'), 'metadata')
    ).resolves.toEqual({
      arn: projectArn('project-0'),
      name: 'project-0',
      description: 'Build project project-0',
      serviceRole: `arn:aws:iam::${accountId}:role/codebuild-service-role`,
      resourceAccessRole: `arn:aws:iam::${accountId}:role/codebuild-resource-role`,
      encryptionKey: `arn:aws:kms:${region}:${accountId}:key/test-key`,
      projectVisibility: 'PUBLIC_READ',
      publicProjectAlias: 'public-project-0'
    })
    await expect(
      store.getResourceMetadata(accountId, projectArn('project-0'), 'tags')
    ).resolves.toEqual({ environment: 'test' })
    await expect(
      store.getResourceMetadata(accountId, projectArn('project-0'), 'policy')
    ).resolves.toEqual({ Statement: [{ Sid: projectArn('project-0') }] })

    //And a missing policy is normal while projects that no longer exist are removed
    await expect(
      store.getResourceMetadata(accountId, projectArn(projectWithoutPolicy), 'policy')
    ).resolves.toBeUndefined()
    await expect(store.listResourceMetadata(accountId, staleProjectArn)).resolves.toEqual([])

    //And listing is paginated before project details are requested in API-sized batches
    expect(
      codeBuildMock.commandCalls(ListProjectsCommand).map((call) => call.args[0].input)
    ).toEqual([{ nextToken: undefined }, { nextToken: 'next-page' }])
    expect(
      codeBuildMock.commandCalls(BatchGetProjectsCommand).map((call) => call.args[0].input.names)
    ).toEqual([firstPageNames, [projectWithoutPolicy]])
    expect(codeBuildMock.commandCalls(GetResourcePolicyCommand)).toHaveLength(101)
  })
})
