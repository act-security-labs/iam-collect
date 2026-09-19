import {
  BatchGetProjectsCommand,
  CodeBuildClient,
  GetResourcePolicyCommand,
  ListProjectsCommand,
  type Project
} from '@aws-sdk/client-codebuild'
import { type Job } from '@cloud-copilot/job'
import { log } from '@cloud-copilot/log'
import {
  runAndCatchAccessDeniedWithLog,
  runAndCatchError,
  withDnsRetry
} from '../../utils/client-tools.js'
import { parseIfPresent } from '../../utils/json.js'
import { convertTagsToRecord } from '../../utils/tags.js'
import { type DataRecord, type Sync, syncData } from '../sync.js'
import { paginateResource } from '../typedSync.js'

const BATCH_GET_PROJECTS_LIMIT = 100

/**
 * Sync AWS CodeBuild projects and their resource policies.
 */
export const CodeBuildProjectsSync: Sync = {
  awsService: 'codebuild',
  name: 'projects',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const codeBuildClient = syncOptions.clientPool.client(
      CodeBuildClient,
      credentials,
      region,
      endpoint
    )
    const projectNames = await withDnsRetry(() =>
      paginateResource(codeBuildClient, ListProjectsCommand, 'projects', {
        inputKey: 'nextToken',
        outputKey: 'nextToken'
      })
    )

    const projects: Project[] = []
    for (let i = 0; i < projectNames.length; i += BATCH_GET_PROJECTS_LIMIT) {
      const response = await withDnsRetry(() =>
        codeBuildClient.send(
          new BatchGetProjectsCommand({
            names: projectNames.slice(i, i + BATCH_GET_PROJECTS_LIMIT)
          })
        )
      )
      projects.push(...(response.projects ?? []))
    }

    const projectJobs: Job<DataRecord, { project: Project }>[] = projects.map((project) => ({
      properties: { project },
      execute: async () => collectProjectRecord(codeBuildClient, project)
    }))
    const projectResults = await Promise.all(syncOptions.workerPool.enqueueAll(projectJobs))
    const records: DataRecord[] = []

    for (const result of projectResults) {
      if (result.status === 'rejected') {
        const project = result.properties.project as Project
        log.error('Failed to collect CodeBuild project', result.reason, {
          projectArn: project.arn
        })
        throw new Error(`Failed to collect CodeBuild project ${project.arn}`)
      }
      records.push(result.value)
    }

    await syncData(
      records,
      storage,
      accountId,
      {
        service: 'codebuild',
        resourceType: 'project',
        account: credentials.accountId,
        region
      },
      syncOptions.writeOnly
    )
  }
}

async function collectProjectRecord(
  codeBuildClient: CodeBuildClient,
  project: Project
): Promise<DataRecord> {
  const projectArn = project.arn!
  const policy = await withDnsRetry(() =>
    runAndCatchAccessDeniedWithLog(projectArn, 'codebuild', 'projects', 'policy', () =>
      runAndCatchError('ResourceNotFoundException', async () => {
        const response = await codeBuildClient.send(
          new GetResourcePolicyCommand({ resourceArn: projectArn })
        )
        return parseIfPresent(response.policy)
      })
    )
  )

  return {
    arn: projectArn,
    metadata: {
      arn: projectArn,
      name: project.name,
      description: project.description,
      serviceRole: project.serviceRole,
      resourceAccessRole: project.resourceAccessRole,
      encryptionKey: project.encryptionKey,
      projectVisibility: project.projectVisibility,
      publicProjectAlias: project.publicProjectAlias
    },
    tags: convertTagsToRecord(project.tags),
    policy
  }
}
