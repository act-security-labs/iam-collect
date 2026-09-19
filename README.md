# iam-collect

[![NPM Version](https://img.shields.io/npm/v/@actsecurity/iam-collect.svg?logo=nodedotjs)](https://www.npmjs.com/package/@actsecurity/iam-collect) [![License: AGPL v3](https://img.shields.io/github/license/act-security-labs/iam-collect)](LICENSE.txt) [![GuardDog](https://github.com/act-security-labs/iam-collect/actions/workflows/guarddog.yml/badge.svg)](https://github.com/act-security-labs/iam-collect/actions/workflows/guarddog.yml) [![Known Vulnerabilities](https://snyk.io/test/github/act-security-labs/iam-collect/badge.svg?targetFile=package.json&style=flat-square)](https://snyk.io/test/github/act-security-labs/iam-collect?targetFile=package.json)

Get every possible policy in any set of AWS accounts. This is built to run out of the box in simple use cases, and also work in terribly oppressive environments with a little more configuration. If you want to analyze IAM data at scale this is what you've been looking for.

## Table of Contents

1. [Tenets](#iam-collect-tenets)
2. [Introduction](#introduction)
3. [Getting Started](#getting-started)
4. [Using Your Data](#using-your-data)
5. [Configuration](docs/Configuration.md)
6. [Authentication](docs/Authentication.md)
7. [Storage](docs/Storage.md)
8. [Filtering](docs/Filtering.md)
9. [Indexing](docs/Indexing.md)
10. [CLI](docs/CLI.md)
11. [History](docs/History.md)
12. [Supported Services and Data](#supported-services-and-data)
13. [Using AWS Config as a Data Source](docs/AwsConfig.md)
14. [Deploying iam-collect at Scale with Terraform](infrastructure_as_code/terraform/README.md)

## iam-collect Tenets

1. _Centralized_ Store [all your data](#supported-services-and-data) across all partitions, organizations, accounts, and regions in one place. This is a single source of truth for all your IAM data.
2. _Easy_ A few commands and you can get started and everything should just work. If resources no longer exist, data is cleaned up automatically.
3. _Configurable_ Store your data on [disk or in S3](docs/Storage.md). You can configure exactly what [accounts, regions, and services](docs/Filtering.md) you want to collect data for; and [customize auth](docs/Authentication.md) for each.

## Introduction

### What is iam-collect?

iam-collect is a command-line tool that aggregates every IAM-related resource and policy across any number of AWS accounts, regions, and partitions into a single, consistent dataset. It requires minimal setup for simple use cases and allows flexible configuration to operate in even the most restrictive (compliance oriented) environments to give you a single source of truth for your IAM data.

### Why use it?

- **Centralized store:** Consolidate IAM data from multiple partitions, organizations, and accounts into one structured store.
- **Get everything:** Collect all the polices from all the resources in all your accounts. Terraform will show you what was intended, iam-collect will show you what is actually there.
- **Audit and compliance:** Generate comprehensive snapshots of your IAM landscape to support security reviews, audits, and forensics. The structured approach to storage makes it easy to build automation and tooling around the data.

### How it works at a glance

Every time you run `iam-collect download` it will:

1. **Scan:** Connect to AWS account(s) using your configured credentials or roles and retrieve IAM resources (users, roles, policies, etc.) from each target account.
2. **Store:** Persist the data to your chosen storage (local filesystem or S3), organizing it by partition, account, service, and resource.
3. **Index:** Build search-friendly JSON indexes that map resources to accounts and other relationships for fast lookups.

Then you use the data to analyze your IAM landscape, build reports, or integrate with other tools.

## Getting Started

By default, iam-collect will use the credentials configured in your environment using the [default credential chain](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-credential-providers/#fromnodeproviderchain). If you have the permissions in the SID `CollectIAMData` in the [example policy](src/aws/collect-policy.json) everything will work for the current account you have credentials for.

You don't need the AWS CLI, but a good way to make sure your credentials are configured is to ensure you can run `aws sts get-caller-identity` and a command that requires a region be set such as `aws ec2 describe-instances`.

```bash
npm install -g @actsecurity/iam-collect
# Create a default configuration file
iam-collect init
# Download iam data from the current account to `./iam-data`
iam-collect download
```

### Install

You need Node.js >= 20.

```bash
npm install -g @actsecurity/iam-collect
```

### Initialize

```bash
iam-collect init
```

This will create a file called `iam-collect.jsonc` in the current directory with a simple default configuration and many comments on how to customize the configuration.

### Download

```bash
iam-collect download
```

This will download the IAM data from the current account to the `./iam-data` directory. You can change the output directory by modifying the `storage.path` property in the configuration. See the [storage docs](docs/Storage.md) for more details.

### Enjoy

```bash
ls -R ./iam-data
```

This will show you your data that was downloaded. See the [storage docs](docs/Storage.md#storage-layout-explained) for more details on the layout of the data.

## Additional Docs

- [Configuration](docs/Configuration.md) - Set the configuration files to use.
- [Authentication](docs/Authentication.md) - Configure authentication for different accounts, services, and regions.
- [Storage](docs/Storage.md) - Configure where your data is stored.
- [Filtering](docs/Filtering.md) - Configure what accounts, services, and regions are downloaded.
- [Indexing](docs/Indexing.md) - Disable or manually run indexing.
- [CLI](docs/CLI.md) - Details on the CLI commands and options.
- [History](docs/History.md) - How to track history of changes.

## Using Your Data

### iam-lens

To explore effective access in your environment check out [iam-lens](https://github.com/act-security-labs/iam-lens). iam-lens reads your iam-collect data to answer questions like: "Who can access this resource?", "Who can assume this role?", and "Does this principal have access to this bucket?"

### Leveraging Your AI

Use [AgentInstructions.md](docs/AgentInstructions.md) to help your AI understand the data and how to interrogate it.

```bash
curl -O https://raw.githubusercontent.com/act-security-labs/iam-collect/main/docs/AgentInstructions.md
```

Then you can start asking questions like "Using AgentInstructions.md as context...":

- Do I have any roles that have "\*" in the trust policy?
- Which users have the "AdministratorAccess" managed policy attached?
- What RAM shares are sharing resources outside of my organization?
- Are there any S3 buckets without block public access enabled?

You can also ask your AI to generate scripts to predictably and scalably answer these same questions for you.

## Additional Data Sources

By default, iam-collect collects data directly from AWS service APIs.

If you prefer, you can configure iam-collect to pull data from AWS Config instead. See the [AWS Config data source documentation](docs/AwsConfig.md) for details.

## Supported Services and Data

| Service           | Resource Type                     | Data Downloaded                                                                                                                     |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| iam               | Users                             | name, path, id, groups, tags, inline policies, managed policies, permission boundary                                                |
| iam               | Groups                            | name, path, id, inline policies, managed policies                                                                                   |
| iam               | Roles                             | name, path, id, trust policy, inline policies, managed policies, instance profiles, tags (excluded by default), permission boundary |
| iam               | Customer and AWS Managed Policies | name, path, id, default version, default version doc, tags                                                                          |
| iam               | OIDC Providers                    | audiences, thumbprints, url, tags                                                                                                   |
| iam               | SAML Providers                    | metadata document, uuid, private keys, valid until, tags                                                                            |
| iam               | Instance Profiles                 | name, roles, id, path, tags                                                                                                         |
| apigateway        | Rest APIs                         | id, name, policy, tags                                                                                                              |
| backup            | Backup Vaults                     | name, key, tags, policy                                                                                                             |
| codebuild         | Projects                          | name, description, service role, resource access role, encryption key, visibility, public project alias, tags, policy               |
| dynamodb          | Streams                           | name, region, resource policy                                                                                                       |
| dynamodb          | Tables                            | name, region, tags, resource policy                                                                                                 |
| ecr               | Repositories                      | name, region, tags, resource policy, key id                                                                                         |
| ecr               | Registries                        | policy                                                                                                                              |
| ec2               | VPC Endpoints                     | id, name, type, vpc, policy                                                                                                         |
| eks               | Clusters                          | name, authentication mode, tags                                                                                                     |
| eks               | Access Entries                    | cluster, principal, username, type, kubernetes groups, associated access policies, tags                                             |
| elasticfilesystem | File Systems                      | name, id, key, encryption, tags, policy                                                                                             |
| es                | OpenSearch Domains                | name, policy, tags, KMS key id                                                                                                      |
| events            | Event Buses                       | name, key id, policy, tags                                                                                                          |
| glacier           | Vaults                            | name, region, tags, policy                                                                                                          |
| glue              | Root Catalogs                     | policy                                                                                                                              |
| kafka             | MSK Clusters                      | name, policy, kms key, tags                                                                                                         |
| kinesis           | Data Streams                      | name, encryption type, key id, policy, tags                                                                                         |
| kms               | Keys                              | id, policy, tags                                                                                                                    |
| lambda            | Functions                         | name, role, tags, policy                                                                                                            |
| lambda            | Function Aliases                  | name, role, alias, version, policy                                                                                                  |
| lambda            | Layer Versions                    | name, version, policy                                                                                                               |
| ram               | Shared Resources                  | resource shares, resource policy                                                                                                    |
| s3                | Access Points                     | name, bucket, bucket account, policy, block public access configuration, network origin, vpc, alias, endpoints                      |
| s3                | Buckets                           | name, region, tags, policy, block public access configuration, default encryption                                                   |
| s3                | Multi Region Access Points        | name, alias, regions, policy, block public access configuration                                                                     |
| s3-object-lambda  | Object Lambda Access Points       | name, alias, policy, block public access configuration                                                                              |
| s3express         | Directory Buckets                 | name, encryption settings, policy                                                                                                   |
| s3express         | Directory Bucket Access Points    | name, bucket, bucket account, policy, block public access configuration, network origin, vpc, alias, endpoints                      |
| s3outposts        | Outpost Buckets                   | name, region, tags, policy                                                                                                          |
| s3outposts        | Outpost Access Points             | name, bucket, bucket account, policy, network origin, vpc                                                                           |
| s3tables          | Table Buckets                     | name, region, bucket policy, encryption                                                                                             |
| organizations     | Organizations                     | id, root account id, enabled policy types, org structure, delegated administrators                                                  |
| organizations     | Organizational Units              | id, parent ou, enabled SCPs, enabled RCPs, tags                                                                                     |
| organizations     | Accounts                          | id, parent ou, enabled SCPs, enabled RCPs, tags                                                                                     |
| organizations     | SCPs, RCPs, S3 Policies           | id, name, description, tags, policy                                                                                                 |
| sns               | Topics                            | name, tags, kms key id, policy                                                                                                      |
| sqs               | Queues                            | name, tags, kms key id, policy                                                                                                      |
| secretsmanager    | Secrets                           | name, tags, kms key id, policy                                                                                                      |
| sso               | Instances                         | id, name, owner account id, status, tags                                                                                            |
| sso               | Permission Sets                   | name, description, AWS managed policies, customer managed policies, inline policy, permission boundary, accounts, tags              |

If you don't see the data you are looking for, please check the [open resource issues](https://github.com/act-security-labs/iam-collect/issues?q=is%3Aissue%20state%3Aopen%20label%3Aresource) and comment on the issue or create a new one.
