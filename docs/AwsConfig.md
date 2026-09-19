# AWS Config As A Data Source

It's possible to use AWS Config as a data source for IAM Collect. This can simplify the process of gathering policy information, provided the information you need is [available in AWS Config](#supported-resource-types).

## Requirements

To use AWS Config as a data source, you need to ensure the following:

1. AWS Config Recorders must be enabled in your AWS accounts and regions you want to collect data from.
2. The Config Recorders must be configured to record the [resource types](#supported-resource-types) you are interested in.
3. A Config Aggregator must be set up to query information from the Recorders.
4. The principal you use must have the [necessary permissions as defined below](#required-iam-permissions).

## Supported Resource Types

Please review the table below to see which resource types are supported to get policies from AWS Config. For a resource to be supported it must:

- Be tracked in Config
- _The associated policy must also be tracked by Config_
- You must be tracking the required resource type in your Config Recorders

Many resource types are tracked by AWS Config, but not all associated policies are tracked. If you see anything that you think can be added, please open an issue with an example of the AWS Config query that returns the policy information.

If your dataSource is AWS Config, iam-collect skips resource types that are not supported in the table below.

- ✅ Policy Available in Config
- ❌ Policy Not available in Config

| Service           | Resource Type                     | Policy Available | Config Resource Type(s)                                       |
| ----------------- | --------------------------------- | ---------------- | ------------------------------------------------------------- |
| iam               | Users                             | ✅               | AWS::IAM::User                                                |
| iam               | Groups                            | ✅               | AWS::IAM::Group                                               |
| iam               | Roles                             | ✅               | AWS::IAM::Role                                                |
| iam               | Customer and AWS Managed Policies | ✅               | AWS::IAM::Policy                                              |
| iam               | OIDC Providers                    | ✅               | AWS::IAM::OIDCProvider                                        |
| iam               | SAML Providers                    | ✅               | AWS::IAM::SAMLProvider                                        |
| iam               | Instance Profiles                 | ✅               | AWS::IAM::Role                                                |
| apigateway        | Rest APIs                         | ❌               |                                                               |
| backup            | Backup Vaults                     | ✅               | AWS::Backup::BackupVault                                      |
| dynamodb          | Streams                           | ❌               |                                                               |
| dynamodb          | Tables                            | ❌               |                                                               |
| ecr               | Repositories                      | ✅               | AWS::ECR::Repository                                          |
| ecr               | Registries                        | ✅               | AWS::ECR::RegistryPolicy                                      |
| ec2               | VPC Endpoints                     | ✅               | AWS::EC2::VPCEndpoint                                         |
| eks               | Clusters                          | ❌               |                                                               |
| eks               | Access Entries                    | ❌               |                                                               |
| elasticfilesystem | File Systems                      | ✅               | AWS::EFS::FileSystem                                          |
| es                | OpenSearch Domains                | ✅               | AWS::OpenSearch::Domain                                       |
| events            | Event Buses                       | ✅               | AWS::Events::EventBus                                         |
| glacier           | Vaults                            | ❌               |                                                               |
| glue              | Root Catalogs                     | ❌               |                                                               |
| iot               | Policies                          | ❌               |                                                               |
| kafka             | MSK Clusters                      | ✅               | AWS::MSK::Cluster, AWS::MSK::ClusterPolicy                    |
| kinesis           | Data Streams                      | ❌               |                                                               |
| kms               | Keys                              | ✅               | AWS::KMS::Key                                                 |
| lambda            | Functions                         | ✅               | AWS::Lambda::Function                                         |
| lambda            | Function Aliases                  | ❌               |                                                               |
| lambda            | Layer Versions                    | ❌               |                                                               |
| ram               | Shared Resources                  | ❌               |                                                               |
| s3                | Access Points                     | ✅               | AWS::S3::AccessPoint                                          |
| s3                | Buckets                           | ✅               | AWS::S3::Bucket                                               |
| s3                | Multi Region Access Points        | ❌               |                                                               |
| s3                | Account Public Access Block       | ✅               | AWS::S3::AccountPublicAccessBlock                             |
| s3-object-lambda  | Object Lambda Access Points       | ❌               |                                                               |
| s3express         | Directory Buckets                 | ✅               | AWS::S3Express::DirectoryBucket, AWS::S3Express::BucketPolicy |
| s3express         | Directory Bucket Access Points    | ❌               |                                                               |
| s3outposts        | Outpost Buckets                   | ❌               |                                                               |
| s3outposts        | Outpost Access Points             | ❌               |                                                               |
| s3tables          | Table Buckets                     | ❌               |                                                               |
| organizations     | Organizations                     | ❌               |                                                               |
| organizations     | Organizational Units              | ❌               |                                                               |
| organizations     | Accounts                          | ❌               |                                                               |
| organizations     | SCPs, RCPs                        | ❌               |                                                               |
| sns               | Topics                            | ✅               | AWS::SNS::Topic                                               |
| sqs               | Queues                            | ✅               | AWS::SQS::Queue                                               |
| secretsmanager    | Secrets                           | ❌               |                                                               |
| sso               | Instances                         | ❌               |                                                               |
| sso               | Permission Sets                   | ❌               |                                                               |

## Configuring iam-collect to use AWS Config

To use AWS Config as a data source, set the `dataSource` property of your iam-collect configuration file as shown below. Make sure to specify the name of the Config Aggregator to use.

```jsonc
  "dataSource": {
    // Use AWS Config as the data source
    "name": "aws-config",
    "config": {
      // Required: The name of the Config Aggregator to use
      "aggregatorName": "my-org-config-aggregator",

      // Optional: The region where the Config Aggregator is located if different from your environment
      // "region": "us-east-1",
    },
  },
```

You can also optionally specify an [Auth](./Authentication.md) block if you need to assume a role before connecting to AWS Config.

```jsonc
  "dataSource": {
    // Use AWS Config as the data source
    "name": "aws-config",
    "config": {
      // Required: The name of the Config Aggregator to use
      "aggregatorName": "my-org-config-aggregator",

      // Optional: The account ID where the Config Aggregator is located. If it differs from the current credentials, you must also specify a role in the `auth` section.
      "accountId": "111111111111",

      // Optional: Authentication configuration to connect to the other account.
      "auth": {
        // Specify a role to assume before connecting to AWS Config. If "accountId" is also specified, this role will be assumed in that account.
        "role": {
          "pathAndName": "AWSConfigReadOnlyAccess"
        }
      }
    },

  },
```

## Required IAM Permissions

To use AWS Config, a principal (user or role) needs permission to:

1. Query the AWS Config Aggregator
2. Query IAM for AWS Managed Policies (config stores information about _**customer** managed policies_ but not _**AWS** managed policies_)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowConfigAggregatorQuery",
      "Effect": "Allow",
      "Action": ["config:SelectAggregateResourceConfig"],
      "Resource": "${CONFIG_AGGREGATOR_ARN}"
    },
    {
      "Sid": "ReadManagedPolicies",
      "Effect": "Allow",
      "Action": ["iam:GetPolicy", "iam:GetPolicyVersion"],
      "Resource": "arn:aws:iam::aws:policy/*"
    }
  ]
}
```

## Concurrency

When using default SDKs, iam-collect makes requests to different AWS services in different regions so a high concurrency level safely improves performance. When using AWS Config as a data source, all requests go to the same service in the same region, which increases the likelihood of throttling. If you run into throttling errors, we recommend adjusting the concurrency level to 10 or less.

```bash
# Set concurrency level to 10 or less if you encounter throttling errors
iam-collect --concurrency 10
```

## Combining with Other Data Sources

You can combine AWS Config with the default data source to get additional policies you cannot get from AWS Config alone.

Do this by creating three config files:

1. Configure storage (e.g. S3 or local) and list of accounts to scan (e.g. `storage-config.json`)
2. Configure AWS Config as a data source (e.g. `config-data.json`)
3. Configure the default data source, but include only the additional services/resources you want to collect that are not supported with AWS Config (e.g. `default-data.json`).

### 1. Storage Config (e.g. `storage-config.json`) and a list of accounts to scan

```jsonc
{
  "storage": {
    "type": "file",
    "path": "./iam-data"
  },
  "accounts": {
    "included": ["111111111111", "222222222222", "333333333333"]
  }
}
```

### 2. AWS Config Data Source (e.g. `config-data.json`)

```jsonc
{
  "dataSource": {
    "name": "aws-config",
    "config": {
      "aggregatorName": "my-org-config-aggregator",
      "region": "us-east-1",
      "accountId": "111111111111",
      "auth": {
        "role": {
          "pathAndName": "AWSConfigReadOnlyAccess"
        }
      }
    }
  }
}
```

### 3. Default Data Source (e.g. `default-data.json`)

```jsonc
{
  "services": {
    // Include only the additional services you want to collect that are not supported in AWS Config.
    "included": ["organizations", "ram"]
  }
}
```

Then run iam-collect twice, once for each data source, using the same storage config file:

```bash
# Download data using AWS Config as the data to your storage location
iam-collect --config-files storage-config.json config-data.json
# Download additional data using the AWS SDKs to your storage location
iam-collect --config-files storage-config.json default-data.json
```
