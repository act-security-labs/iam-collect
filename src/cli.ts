#!/usr/bin/env node

import {
  booleanArgument,
  enumArgument,
  numberArgument,
  parseCliArguments,
  stringArgument,
  stringArrayArgument
} from '@actsecurity/cli'
import { conductLogAnalysis } from './analysis/analyze.js'
import { loadConfigFiles } from './config/configFile.js'
import { createDefaultConfiguration } from './config/createConfigFile.js'
import { defaultConfigExists } from './config/defaultConfig.js'
import { iamCollectVersion } from './config/packageVersion.js'
import { downloadData } from './download/download.js'
import { index } from './index/index.js'
import { mergeSqliteDatabases } from './mergeSqlite/mergeSqlite.js'
import { type AwsService } from './services.js'
import { type LogLevel, LogLevels, setLogger, StandardLogger } from '@actsecurity/log'

/**
 * For some reason the AWS SDK v3 looks for AWS_REGION and not AWS_DEFAULT_REGION
 * even though other SDKs and the CLI use AWS_DEFAULT_REGION. To make things easier
 * for users, if AWS_DEFAULT_REGION is set and AWS_REGION is not, copy it over.
 */
if (process.env.AWS_DEFAULT_REGION && !process.env.AWS_REGION) {
  process.env.AWS_REGION = process.env.AWS_DEFAULT_REGION
}

const main = async () => {
  const cli = await parseCliArguments(
    'iam-collect',
    {
      init: {
        description: 'Initialize the iam-collect configuration file',
        arguments: {
          sqlite: booleanArgument({
            character: 's',
            description: 'Initialize configuration file with SQLite storage'
          })
        }
      },
      download: {
        description: 'Download IAM data and update indexes',
        arguments: {
          configFiles: stringArrayArgument({
            description: 'The configuration files to use',
            defaultValue: []
          }),
          accounts: stringArrayArgument({
            description: 'The account IDs to download from',
            defaultValue: []
          }),
          regions: stringArrayArgument({
            description: 'The regions to download from',
            defaultValue: []
          }),
          services: stringArrayArgument({
            description: 'The services to download',
            defaultValue: []
          }),
          concurrency: numberArgument({
            description:
              'The maximum number of concurrent downloads to allow. Defaults based on your system CPUs'
          }),
          noIndex: booleanArgument({
            description: 'Skip refreshing the indexes after downloading',
            character: 'n'
          }),
          writeOnly: booleanArgument({
            description:
              'Only write data for discovered resources and ignore any existing data. May improve performance if you know you have no existing data',
            character: 'w'
          })
        }
      },
      index: {
        description: 'Refresh the IAM data indexes',
        arguments: {
          configFiles: stringArrayArgument({
            description: 'The configuration files to use',
            defaultValue: []
          }),
          partition: stringArgument({
            description: 'The partition to refresh index data for. Defaults to aws',
            defaultValue: 'aws'
          }),
          accounts: stringArrayArgument({
            description: 'The account IDs to refresh index data for',
            defaultValue: []
          }),
          regions: stringArrayArgument({
            description: 'The regions to refresh index data for',
            defaultValue: []
          }),
          services: stringArrayArgument({
            description: 'The services to refresh index data for',
            defaultValue: []
          }),
          concurrency: numberArgument({
            description:
              'The maximum number of concurrent indexers to run. Defaults based on your system CPUs'
          })
        }
      },
      'merge-databases': {
        description: 'Merge multiple iam-collect SQLite databases into one',
        arguments: {
          targetDatabase: stringArgument({
            description:
              'The target database to merge into. If it does not exist, it will be created. If it does exist, new data will be added to existing data'
          }),
          sourceDatabases: stringArrayArgument({
            description: 'The source databases to merge from'
          })
        }
      },
      'analyze-logs': {
        description: 'Analyze iam-collect trace logs and summarize job execution times',
        arguments: {
          logFile: stringArgument({
            description: 'The path to the log file to analyze'
          })
        }
      }
    },
    {
      log: enumArgument({
        description: 'The log level to use',
        validValues: [...LogLevels] // Convert readonly to mutable array
      })
    },
    {
      envPrefix: 'IAM_COLLECT',
      showHelpIfNoArgs: true,
      requireSubcommand: true,
      expectOperands: false,
      version: {
        currentVersion: iamCollectVersion,
        checkForUpdates: '@actsecurity/iam-collect'
      }
    }
  )

  setLogger(
    new StandardLogger({
      logLevel: (cli.args.log as LogLevel) ?? undefined
    })
  )

  if (cli.subcommand === 'init') {
    if (defaultConfigExists()) {
      console.error('Configuration file already exists')
      process.exit(1)
    }
    console.log('Initializing...')
    await createDefaultConfiguration({
      type: cli.args.sqlite ? 'sqlite' : 'file'
    })
  } else if (cli.subcommand === 'download') {
    const defaultConfig = './iam-collect.jsonc'
    const configFiles = cli.args.configFiles.length > 0 ? cli.args.configFiles : [defaultConfig]
    const configs = loadConfigFiles(configFiles)
    await downloadData(
      configs,
      cli.args.accounts,
      cli.args.regions,
      cli.args.services,
      cli.args.concurrency,
      cli.args.noIndex,
      cli.args.writeOnly
    )
  } else if (cli.subcommand === 'index') {
    const defaultConfig = './iam-collect.jsonc'
    const configFiles = cli.args.configFiles.length > 0 ? cli.args.configFiles : [defaultConfig]
    const configs = loadConfigFiles(configFiles)
    await index(
      configs,
      cli.args.partition || 'aws',
      cli.args.accounts,
      cli.args.regions,
      cli.args.services as AwsService[],
      cli.args.concurrency
    )
  } else if (cli.subcommand === 'merge-databases') {
    if (!cli.args.targetDatabase) {
      console.error('You must specify a target database using --target-database')
      process.exit(1)
    }
    if (!cli.args.sourceDatabases) {
      console.error('You must specify at least one source database using --source-databases')
      process.exit(1)
    }
    await mergeSqliteDatabases(cli.args.targetDatabase, cli.args.sourceDatabases)
  } else if (cli.subcommand === 'analyze-logs') {
    if (!cli.args.logFile) {
      console.error('You must specify a log file to analyze using --log-file')
      process.exit(1)
    }
    const allComplete = await conductLogAnalysis(cli.args.logFile)
    if (!allComplete) {
      process.exit(1)
    }
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .then(() => {})
  .finally(() => {})
